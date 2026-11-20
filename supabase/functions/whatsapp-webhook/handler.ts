// The request handler, kept free of Deno APIs so it can be tested with plain Node.
import { FORMAT_HELP, isJobMessage, parseJob } from "./parse.ts";

export interface Env {
  SUPABASE_URL: string;
  SERVICE_KEY: string;
  WA_VERIFY_TOKEN?: string;   // any phrase you choose; typed into Meta when adding the webhook
  WA_APP_SECRET?: string;     // Meta app secret: proves a message really came from WhatsApp
  WA_ACCESS_TOKEN?: string;   // optional: lets the app reply "Job created" on WhatsApp
  WA_GRAPH_VERSION?: string;
  WA_PHONE_NUMBER_ID?: string; // the business number's id in Meta: needed to send job notices from the app
  WA_TEMPLATE?: string;        // optional approved template "New job {{1}}: {{2}}. {{3}}" for people who have not messaged in the last 24 hours
  WA_TEMPLATE_LANG?: string;
}
type Fetch = typeof fetch;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-pj-quick, x-pj-notify",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const text = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/plain" } });

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
export async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return "sha256=" + hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}

function svc(env: Env): Record<string, string> {
  return { apikey: env.SERVICE_KEY, Authorization: "Bearer " + env.SERVICE_KEY, "Content-Type": "application/json" };
}
async function todayIn(env: Env, f: Fetch): Promise<string> {
  let tz = "Europe/London";
  try {
    const r = await f(env.SUPABASE_URL + "/rest/v1/pj_settings?select=timezone&limit=1", { headers: svc(env) });
    const rows = await r.json();
    if (Array.isArray(rows) && rows[0]?.timezone) tz = rows[0].timezone;
  } catch (_) { /* keep the default */ }
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  catch (_) { return new Date().toISOString().slice(0, 10); }
}
async function ingest(env: Env, f: Fetch, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await f(env.SUPABASE_URL + "/rest/v1/rpc/pj_wa_ingest", { method: "POST", headers: svc(env), body: JSON.stringify({ p }) });
  const out = await r.json().catch(() => null);
  if (!r.ok) return { ok: false, reason: "error", error: out?.message || ("HTTP " + r.status) };
  return out || { ok: false, reason: "error" };
}

function niceDate(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}
export function replyFor(res: Record<string, unknown>): string | null {
  if (res.ok) {
    const ref = "J-" + String(res.ref).padStart(4, "0");
    const bits = [res.assignee ? "Assigned to " + res.assignee : "Not assigned yet"];
    if (res.due_date) bits.push("Due " + niceDate(String(res.due_date)));
    if (res.priority && res.priority !== "normal") bits.push(String(res.priority)[0].toUpperCase() + String(res.priority).slice(1));
    const counts = [];
    if (Number(res.tasks)) counts.push(res.tasks + (Number(res.tasks) === 1 ? " task" : " tasks"));
    if (Number(res.parts)) counts.push(res.parts + (Number(res.parts) === 1 ? " part" : " parts"));
    let out = "✅ Job " + ref + " created\n*" + res.title + "*\n" + bits.join(" · ");
    if (counts.length) out += "\n" + counts.join(", ");
    if (res.assign_unmatched) out += '\n⚠️ I could not match "' + res.assign_asked + '" to one person on the team, so open the app to assign it.';
    return out;
  }
  if (res.reason === "no_title") return "I could not find a job title in that message.\n\n" + FORMAT_HELP;
  if (res.reason === "error") return "⚠️ That job could not be saved. Please add it in the app.";
  return null; // duplicates and people who are not managers get no reply
}
async function post(env: Env, f: Fetch, phoneNumberId: string, payload: Record<string, unknown>): Promise<boolean> {
  const id = phoneNumberId || env.WA_PHONE_NUMBER_ID || "";
  if (!env.WA_ACCESS_TOKEN || !id) return false;
  const v = env.WA_GRAPH_VERSION || "v24.0";
  try {
    const r = await f("https://graph.facebook.com/" + v + "/" + id + "/messages", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.WA_ACCESS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
    });
    // say why in the function logs (never the token) so a silent failure can be traced
    if (!r.ok) console.error("whatsapp send failed", r.status, (await r.text().catch(() => "")).slice(0, 300));
    return r.ok;
  } catch (e) { console.error("whatsapp send failed", String(e).slice(0, 200)); return false; } // a failed send must not make WhatsApp resend the message
}
async function sendText(env: Env, f: Fetch, phoneNumberId: string, to: string, body: string): Promise<boolean> {
  return post(env, f, phoneNumberId, { to, type: "text", text: { body } });
}

/* ---------- follow-ups: buttons and pick-lists under the reply ---------- */
async function action(env: Env, f: Fetch, p: Record<string, unknown>): Promise<Record<string, any>> {
  try {
    const r = await f(env.SUPABASE_URL + "/rest/v1/rpc/pj_wa_action", { method: "POST", headers: svc(env), body: JSON.stringify({ p }) });
    const out = await r.json().catch(() => null);
    return r.ok && out ? out : { ok: false, reason: "error" };
  } catch (_) { return { ok: false, reason: "error" }; }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const cut = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "\u2026" : t; };
const jref = (ref: unknown) => "J-" + String(ref).padStart(4, "0");
export function updateText(res: Record<string, any>): string {
  const bits = [res.assignee ? "Assigned to " + res.assignee : "Not assigned yet"];
  if (res.due_date) bits.push("Due " + niceDate(String(res.due_date)));
  if (res.priority && res.priority !== "normal") bits.push(String(res.priority)[0].toUpperCase() + String(res.priority).slice(1));
  const counts = [];
  if (Number(res.tasks)) counts.push(res.tasks + (Number(res.tasks) === 1 ? " task" : " tasks"));
  if (Number(res.parts)) counts.push(res.parts + (Number(res.parts) === 1 ? " part" : " parts"));
  let out = "\u270f\ufe0f " + jref(res.ref) + " updated\n*" + res.title + "*\n" + bits.join(" \u00b7 ");
  if (counts.length) out += "\n" + counts.join(", ");
  if (res.assign_unmatched) out += '\n\u26a0\ufe0f I could not match "' + res.assign_asked + '" to one person on the team.';
  return out;
}
export const DETAILS_HELP = (ref: unknown) =>
  "Send the extra details for " + jref(ref) + " in your next message (within 30 minutes). Use any of these lines, or just write notes:\n\n" +
  "Customer: Ahmed 050 123 4567\nAddress: Shop 3, Al Wasl Road\nDue: tomorrow\nTasks: mount cameras, run cable\nParts: 4x dome camera";
/** The confirmation with three buttons under it. Falls back to plain text if WhatsApp refuses the buttons. */
async function sendMenu(env: Env, f: Fetch, numberId: string, to: string, body: string, jobId: string): Promise<boolean> {
  const ok = await post(env, f, numberId, { to, type: "interactive", interactive: { type: "button", body: { text: body.slice(0, 1000) }, action: { buttons: [
    { type: "reply", reply: { id: "as:" + jobId, title: "Assign staff" } },
    { type: "reply", reply: { id: "pr:" + jobId, title: "Set priority" } },
    { type: "reply", reply: { id: "dt:" + jobId, title: "Add details" } },
  ] } } });
  return ok || sendText(env, f, numberId, to, body);
}
async function sendList(env: Env, f: Fetch, numberId: string, to: string, body: string, button: string, rows: { id: string; title: string; description?: string }[]): Promise<boolean> {
  return post(env, f, numberId, { to, type: "interactive", interactive: { type: "list", body: { text: body.slice(0, 1000) }, action: { button, sections: [{ title: button, rows: rows.slice(0, 10) }] } } });
}
/** Someone tapped a button or picked from a list. The ids carry what was tapped and for which job. */
async function onInteractive(env: Env, f: Fetch, numberId: string, from: string, m: any): Promise<void> {
  const id = String(m?.interactive?.button_reply?.id || m?.interactive?.list_reply?.id || "");
  const [kind, jobId, val] = id.split(":");
  if (!UUID.test(jobId || "")) return;
  if (kind === "as") {
    const r = await action(env, f, { from_phone: from, action: "people", job_id: jobId });
    if (!r.ok) return;
    const rows = (r.people || []).map((x: any) => ({ id: "a:" + jobId + ":" + x.id, title: cut(x.name, 24), description: x.role === "manager" ? "Manager" : "Staff" }));
    rows.push({ id: "a:" + jobId + ":none", title: "Nobody yet", description: "Leave it unassigned" });
    await sendList(env, f, numberId, from, "Who should do " + jref(r.ref) + "?\n*" + r.title + "*", "Choose staff", rows);
  } else if (kind === "pr") {
    const r = await action(env, f, { from_phone: from, action: "people", job_id: jobId });
    if (!r.ok) return;
    await sendList(env, f, numberId, from, "How urgent is " + jref(r.ref) + "?\n*" + r.title + "*", "Choose priority",
      [["urgent", "Urgent", "Drop everything"], ["high", "High", "Do it soon"], ["normal", "Normal", "The usual queue"], ["low", "Low", "When there is time"]]
        .map(([k, t, dsc]) => ({ id: "p:" + jobId + ":" + k, title: t, description: dsc })));
  } else if (kind === "dt") {
    const r = await action(env, f, { from_phone: from, action: "details_start", job_id: jobId });
    if (r.ok) await sendText(env, f, numberId, from, DETAILS_HELP(r.ref));
  } else if (kind === "a") {
    const none = val === "none";
    if (!none && !UUID.test(val || "")) return;
    const r = await action(env, f, { from_phone: from, action: "assign", job_id: jobId, person_id: none ? "" : val });
    if (r.ok) {
      await sendMenu(env, f, numberId, from, updateText(r), jobId);
      if (!none) await notify(env, f, jobId, { onlyAssignee: true, exclude: [from], numberId });
    } else if (r.reason === "no_person") await sendText(env, f, numberId, from, "That person is no longer on the team. Tap Assign staff again for the current list.");
  } else if (kind === "p") {
    const r = await action(env, f, { from_phone: from, action: "priority", job_id: jobId, priority: val });
    if (r.ok) await sendMenu(env, f, numberId, from, updateText(r), jobId);
  }
}
// Replies that are plainly not a job, so "ok" or "thanks" to the jobs line does not create one.
const SMALL_TALK = /^(ok(ay)?|k|thanks?( you)?|thank you|thx|ty|cheers|yes|no|yep|nope|hi|hello|hey|done|great|cool|noted|will do|got it|perfect|[\u{1F44D}\u{1F64F}\u{1F44C}\u{2705}\u{2764}\u{FE0F}\s]+)[.!\s]*$/iu;
/** A message that does not start with "Job". */
async function onLooseText(env: Env, f: Fetch, numberId: string, from: string, waId: string, body: string): Promise<void> {
  const pend = await action(env, f, { from_phone: from, action: "pending" });
  if (pend.ok) { // this number tapped Add details in the last 30 minutes: the message is those details
    const extra = parseJob(body, await todayIn(env, f), false)!;
    const r = await action(env, f, { ...extra, from_phone: from, action: "details_apply", wa_id: waId, body });
    if (!r.ok) return;
    await sendMenu(env, f, numberId, from, updateText(r), String(r.job_id));
    if (extra.assign && !r.assign_unmatched) await notify(env, f, String(r.job_id), { onlyAssignee: true, exclude: [from], numberId });
    return;
  }
  if (pend.reason !== "none") return; // not an approved number: not read any further, not stored
  // "Every message is a job" (a setting): typed or forwarded text from an approved number becomes a job.
  const t = body.trim();
  if (t.length < 3 || SMALL_TALK.test(t)) return;
  if (!(await rows(env, f, "pj_settings?select=wa_any_message&limit=1"))[0]?.wa_any_message) return;
  const job = parseJob(body, await todayIn(env, f), false)!;
  if (!job.title) return;
  if (job.title.length > 90) { // one long paragraph: keep it whole in the details and shorten the headline
    job.description = (job.title + (job.description ? "\n" + job.description : "")).slice(0, 4000);
    job.title = cut(job.title.slice(0, 90).replace(/\s+\S*$/, ""), 90) + "\u2026";
  }
  const res = await ingest(env, f, { ...job, wa_id: waId, from_phone: from, body, source: "whatsapp" });
  const reply = replyFor(res);
  if (reply && res.ok) await sendMenu(env, f, numberId, from, reply, String(res.job_id));
  else if (reply) await sendText(env, f, numberId, from, reply);
  if (res.ok) await notify(env, f, String(res.job_id), { exclude: [from], numberId });
}

/* ---------- photos sent or forwarded on WhatsApp ---------- */
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
/** Fetch the photo from WhatsApp and file it under the job, exactly like a photo added in the app. */
export async function savePhoto(env: Env, f: Fetch, mediaId: string, jobId: string): Promise<boolean> {
  if (!env.WA_ACCESS_TOKEN || !/^[\w.-]{1,120}$/.test(mediaId) || !UUID.test(jobId)) return false;
  try {
    const auth = { Authorization: "Bearer " + env.WA_ACCESS_TOKEN };
    const meta = await f("https://graph.facebook.com/" + (env.WA_GRAPH_VERSION || "v24.0") + "/" + mediaId, { headers: auth });
    if (!meta.ok) { console.error("whatsapp photo lookup failed", meta.status, (await meta.text().catch(() => "")).slice(0, 200)); return false; }
    const info = await meta.json();
    const mime = String(info?.mime_type || "").split(";")[0].trim();
    const ext = PHOTO_TYPES[mime];
    // the download address must be Meta's own before the token is sent to it
    if (!ext || !info?.url || !/(^|\.)(fbsbx\.com|facebook\.com|fbcdn\.net|whatsapp\.net)$/.test(new URL(String(info.url)).hostname)) return false;
    const bin = await f(String(info.url), { headers: auth });
    if (!bin.ok) { console.error("whatsapp photo download failed", bin.status); return false; }
    const buf = await bin.arrayBuffer();
    if (!buf.byteLength || buf.byteLength > 8 * 1024 * 1024) return false;
    const path = jobId + "/" + crypto.randomUUID() + "." + ext;
    const up = await f(env.SUPABASE_URL + "/storage/v1/object/job-photos/" + path, {
      method: "POST", headers: { apikey: env.SERVICE_KEY, Authorization: "Bearer " + env.SERVICE_KEY, "Content-Type": mime }, body: buf });
    if (!up.ok) { console.error("photo store failed", up.status, (await up.text().catch(() => "")).slice(0, 200)); return false; }
    const ins = await f(env.SUPABASE_URL + "/rest/v1/pj_job_photos", { method: "POST", headers: { ...svc(env), Prefer: "return=minimal" }, body: JSON.stringify({ job_id: jobId, path }) });
    if (!ins.ok) console.error("photo record failed", ins.status, (await ins.text().catch(() => "")).slice(0, 200));
    return ins.ok;
  } catch (e) { console.error("photo save failed", String(e).slice(0, 200)); return false; }
}
async function onPhoto(env: Env, f: Fetch, numberId: string, from: string, m: any): Promise<void> {
  const caption = String(m?.image?.caption || "").trim();
  const mediaId = String(m?.image?.id || "");
  let target: Record<string, any> = { ok: false, reason: "error" };
  try {
    const r = await f(env.SUPABASE_URL + "/rest/v1/rpc/pj_wa_photo_target", { method: "POST", headers: svc(env), body: JSON.stringify({ p_phone: from }) });
    if (r.ok) target = (await r.json()) || target;
  } catch (_) { /* treated as not allowed */ }
  if (!target.ok && target.reason !== "none") return; // not an approved number: nothing fetched, nothing stored
  const any = !!(await rows(env, f, "pj_settings?select=wa_any_message&limit=1"))[0]?.wa_any_message;
  const good = "\n\ud83d\udcce Photo attached", bad = "\n\u26a0\ufe0f The photo could not be saved. Add it in the app.";

  // 1) adding details to a job: the caption is details, the photo goes on that job
  if (target.ok && target.pending) {
    let summary = "";
    if (caption) {
      const extra = parseJob(caption, await todayIn(env, f), false)!;
      const r = await action(env, f, { ...extra, from_phone: from, action: "details_apply", wa_id: String(m.id || ""), body: caption });
      if (r.ok) summary = updateText(r);
    }
    const saved = await savePhoto(env, f, mediaId, String(target.job_id));
    if (summary) await sendMenu(env, f, numberId, from, summary + (saved ? good : bad), String(target.job_id));
    else await sendText(env, f, numberId, from, saved ? "\ud83d\udcce Photo added to " + jref(target.ref) : "\u26a0\ufe0f The photo for " + jref(target.ref) + " could not be saved. Add it in the app.");
    return;
  }
  // 2) a caption that is a job (or any caption, when every message is a job): new job with the photo on it
  if (caption && (isJobMessage(caption) || (any && caption.length >= 3 && !SMALL_TALK.test(caption)))) {
    const job = parseJob(caption, await todayIn(env, f), false)!;
    if (job.title) {
      const res = await ingest(env, f, { ...job, wa_id: m.id, from_phone: from, body: caption, source: "whatsapp" });
      const reply = replyFor(res);
      if (res.ok) {
        const saved = await savePhoto(env, f, mediaId, String(res.job_id));
        await sendMenu(env, f, numberId, from, reply + (saved ? good : bad), String(res.job_id));
        await notify(env, f, String(res.job_id), { exclude: [from], numberId });
      } else if (reply) await sendText(env, f, numberId, from, reply);
      return;
    }
  }
  // 3) no caption: it belongs with the job this number sent a moment ago
  if (target.ok) {
    const saved = await savePhoto(env, f, mediaId, String(target.job_id));
    await sendText(env, f, numberId, from, saved ? "\ud83d\udcce Photo added to " + jref(target.ref) : "\u26a0\ufe0f The photo for " + jref(target.ref) + " could not be saved. Add it in the app.");
    return;
  }
  // 4) a photo on its own, when every message is a job: start a job to hang it on
  if (any) {
    const res = await ingest(env, f, { title: "Photo sent on WhatsApp", description: "", tasks: [], parts: [], wa_id: m.id, from_phone: from, body: "(photo)", source: "whatsapp" });
    if (!res.ok) return;
    const saved = await savePhoto(env, f, mediaId, String(res.job_id));
    await sendMenu(env, f, numberId, from, replyFor(res) + (saved ? good : bad) + "\nTap Add details to say what it is.", String(res.job_id));
    await notify(env, f, String(res.job_id), { exclude: [from], numberId });
  }
}

/* ---------- job notices: "receive jobs on WhatsApp" ---------- */
export interface Notice { text: string; params: string[] }
const oneLine = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
export function jobNotice(j: any, forAssignee: boolean): Notice {
  const ref = "J-" + String(j.ref).padStart(4, "0");
  const lines: string[] = [];
  if (j.customer_name || j.customer_phone) lines.push("Customer: " + [j.customer_name, j.customer_phone].filter(Boolean).join(" "));
  if (j.address) lines.push("Address: " + j.address);
  const when: string[] = [];
  if (j.due_date) when.push("Due " + niceDate(String(j.due_date)));
  if (j.priority && j.priority !== "normal") when.push(String(j.priority)[0].toUpperCase() + String(j.priority).slice(1) + " priority");
  if (when.length) lines.push(when.join(" \u00b7 "));
  if (!forAssignee) lines.push(j.assignee?.name ? "Assigned to " + j.assignee.name : "Not assigned yet");
  const head = forAssignee ? "\ud83d\udccb New job for you: " + ref : "\ud83c\udd95 New job " + ref;
  return {
    text: head + "\n*" + j.title + "*" + (lines.length ? "\n" + lines.join("\n") : ""),
    params: [(forAssignee ? "for you " : "") + ref, oneLine(j.title, 200), oneLine(lines.join(" | ") || "Open Proview Jobs for details", 500)],
  };
}
async function sendNotice(env: Env, f: Fetch, phoneNumberId: string, to: string, n: Notice): Promise<boolean> {
  // Outside the 24 hours after someone last wrote in, WhatsApp only delivers an approved template.
  if (env.WA_TEMPLATE) {
    return post(env, f, phoneNumberId, { to, type: "template", template: { name: env.WA_TEMPLATE, language: { code: env.WA_TEMPLATE_LANG || "en" },
      components: [{ type: "body", parameters: n.params.map((t) => ({ type: "text", text: t })) }] } });
  }
  return sendText(env, f, phoneNumberId, to, n.text);
}
async function rows(env: Env, f: Fetch, path: string): Promise<any[]> {
  try { const r = await f(env.SUPABASE_URL + "/rest/v1/" + path, { headers: svc(env) }); const d = r.ok ? await r.json() : []; return Array.isArray(d) ? d : []; }
  catch (_) { return []; }
}
/** Tell the assignee, and every listed number that asked for new jobs, about a job. Returns how many were sent. */
export async function notify(env: Env, f: Fetch, jobId: string, o: { exclude?: string[]; onlyAssignee?: boolean; numberId?: string } = {}): Promise<number> {
  if (!env.WA_ACCESS_TOKEN || !(o.numberId || env.WA_PHONE_NUMBER_ID) || !/^[0-9a-f-]{36}$/i.test(jobId)) return 0;
  const job = (await rows(env, f, "pj_jobs?id=eq." + jobId + "&select=ref,title,customer_name,customer_phone,address,due_date,priority,assignee:pj_people!pj_jobs_assigned_to_fkey(name,phone)"))[0];
  if (!job) return 0;
  const skip = new Set(o.exclude || []);
  const to = new Map<string, Notice>();
  if (!o.onlyAssignee) for (const n of await rows(env, f, "pj_wa_numbers?notify=is.true&select=phone")) if (n.phone) to.set(n.phone, jobNotice(job, false));
  if (job.assignee?.phone) to.set(job.assignee.phone, jobNotice(job, true));
  let sent = 0;
  for (const [phone, n] of to) if (!skip.has(phone) && await sendNotice(env, f, o.numberId || "", phone, n)) sent++;
  return sent;
}

async function onWebhook(req: Request, env: Env, f: Fetch): Promise<Response> {
  const raw = await req.text();
  if (!env.WA_APP_SECRET) return text("WhatsApp is not set up yet", 503);
  const got = req.headers.get("x-hub-signature-256") || "";
  if (!sameText(got, await sign(env.WA_APP_SECRET, raw))) return text("Bad signature", 401);

  let payload: any;
  try { payload = JSON.parse(raw); } catch (_) { return text("ok"); }
  let today = "";
  try {
    for (const entry of payload?.entry || []) {
      for (const change of entry?.changes || []) {
        const value = change?.value || {};
        const numberId = String(value?.metadata?.phone_number_id || "");
        // 1) A manager messages the business number.
        if (change.field === "messages") {
          for (const m of value.messages || []) {
            const from = String(m.from || "").replace(/\D/g, "");
            if (m?.type === "interactive") { await onInteractive(env, f, numberId, from, m); continue; }
            if (m?.type === "image") { await onPhoto(env, f, numberId, from, m); continue; }
            // text, or the caption of a forwarded video or document (those files are not saved; photos are)
            let body = m?.type === "text" ? String(m?.text?.body || "") : String(m?.[m?.type]?.caption || "");
            if (body && m?.type !== "text") body += "\nNote: a " + m.type + " came with this message on WhatsApp and is not saved here.";
            if (!body) continue;
            if (!isJobMessage(body)) { await onLooseText(env, f, numberId, from, String(m.id || ""), body); continue; }
            today = today || await todayIn(env, f);
            const job = parseJob(body, today)!;
            const res = await ingest(env, f, { ...job, wa_id: m.id, from_phone: from, body, source: "whatsapp" });
            const reply = replyFor(res);
            if (reply && res.ok) await sendMenu(env, f, numberId, from, reply, String(res.job_id));
            else if (reply) await sendText(env, f, numberId, from, reply);
            if (res.ok) await notify(env, f, String(res.job_id), { exclude: [from], numberId });
          }
        }
        // 2) The business itself types "Job ..." in the WhatsApp Business app (same number on app and API).
        if (change.field === "smb_message_echoes") {
          for (const m of value.message_echoes || []) {
            const body = m?.type === "text" ? String(m?.text?.body || "") : "";
            if (!isJobMessage(body)) continue;
            today = today || await todayIn(env, f);
            const job = parseJob(body, today)!;
            const from = String(m.from || "").replace(/\D/g, "");
            const res = await ingest(env, f, { ...job, wa_id: m.id, from_phone: from, body, source: "whatsapp", trusted: true });
            // no reply here: it would go to whoever the chat is with
            if (res.ok) await notify(env, f, String(res.job_id), { exclude: [from, String(m.to || "").replace(/\D/g, "")], numberId });
          }
        }
      }
    }
  } catch (e) {
    console.error("whatsapp-webhook", e);
  }
  return text("ok");
}

// Calls from the app itself carry the signed-in person's login; only managers may use them.
async function managerId(req: Request, env: Env, f: Fetch): Promise<string | Response> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "Sign in first" }, 401);
  const u = await f(env.SUPABASE_URL + "/auth/v1/user", { headers: { apikey: env.SERVICE_KEY, Authorization: "Bearer " + jwt } });
  const user = u.ok ? await u.json().catch(() => null) : null;
  if (!user?.id || !/^[0-9a-f-]{36}$/i.test(user.id)) return json({ ok: false, error: "Sign in first" }, 401);
  const p = await rows(env, f, "pj_people?select=id&user_id=eq." + user.id + "&role=eq.manager&active=is.true");
  if (!p[0]?.id) return json({ ok: false, error: "Managers only" }, 403);
  return String(p[0].id);
}

// "Quick add" in the app: a signed-in manager pastes the same kind of text.
async function onQuick(req: Request, env: Env, f: Fetch): Promise<Response> {
  const mgr = await managerId(req, env, f);
  if (typeof mgr !== "string") return mgr;
  const body = await req.json().catch(() => ({}));
  const msg = String(body?.text || "").slice(0, 4000);
  const job = parseJob(msg, await todayIn(env, f), false);
  if (!job || !job.title) return json({ ok: false, error: "Add a first line that says what the job is" }, 400);
  if (body?.preview) return json({ ok: true, preview: job });
  const res = await ingest(env, f, { ...job, manager_id: mgr, body: msg, source: "quick" });
  if (res.ok) res.notified = await notify(env, f, String(res.job_id));
  return json(res, res.ok ? 200 : 400);
}

// The app asks for job notices after a manager creates or reassigns a job on screen.
async function onNotify(req: Request, env: Env, f: Fetch): Promise<Response> {
  const mgr = await managerId(req, env, f);
  if (typeof mgr !== "string") return mgr;
  const body = await req.json().catch(() => ({}));
  const sent = await notify(env, f, String(body?.job_id || ""), { onlyAssignee: !!body?.only_assignee });
  return json({ ok: true, sent, connected: !!(env.WA_ACCESS_TOKEN && env.WA_PHONE_NUMBER_ID) });
}

// A built-in check that the message reader works as deployed. Touches no data.
export function selfTest(): string {
  const fails: string[] = [];
  const eq = (name: string, a: unknown, b: unknown) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(name + "=" + JSON.stringify(a)); };
  const T = "2026-11-20";
  const j = parseJob("*Job:* Install 4 cameras\nCustomer: Ahmed 050 123 4567\nAddress: Shop 3, Al Wasl Road\nDue: tomorrow 3pm\nPriority: urgent\nAssign: Ravi\nTasks: mount, run cable\nParts: 4x dome camera, recorder x2\nBring ladder", T)!;
  eq("title", j.title, "Install 4 cameras");
  eq("customer", [j.customer_name, j.customer_phone], ["Ahmed", "050 123 4567"]);
  eq("address", j.address, "Shop 3, Al Wasl Road");
  eq("due", j.due_date, "2026-11-21");
  eq("priority", j.priority, "urgent");
  eq("assign", j.assign, "Ravi");
  eq("tasks", j.tasks, ["mount", "run cable"]);
  eq("parts", j.parts, [{ qty: 4, name: "dome camera" }, { qty: 2, name: "recorder" }]);
  eq("notes", j.description, "Time: 3pm\nBring ladder");
  const k = parseJob("#job\nReplace printer\nTasks:\n- remove old\n2) fit new\nDue: 25/11", T)!;
  eq("list", [k.title, k.tasks, k.due_date], ["Replace printer", ["remove old", "fit new"], "2026-11-25"]);
  eq("chat", [isJobMessage("Good job today"), isJobMessage("jobs tomorrow?"), isJobMessage("New job - x")], [false, false, true]);
  eq("friday", parseJob("job x\ndue: fri", T)!.due_date, "2026-11-27");
  return fails.length ? "selftest FAILED " + fails.join("; ") : "selftest ok 12";
}

export async function handle(req: Request, env: Env, f: Fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method === "GET") {
    // Meta checks the address once when you add it.
    const q = new URL(req.url).searchParams;
    if (q.get("hub.mode") === "subscribe" && env.WA_VERIFY_TOKEN && sameText(q.get("hub.verify_token") || "", env.WA_VERIFY_TOKEN)) {
      return text(q.get("hub.challenge") || "");
    }
    if (q.has("selftest")) return text(selfTest());
    return text("Proview Jobs WhatsApp webhook", q.has("hub.mode") ? 403 : 200);
  }
  if (req.method !== "POST") return text("Method not allowed", 405);
  if (req.headers.get("x-pj-quick")) return onQuick(req, env, f);
  if (req.headers.get("x-pj-notify")) return onNotify(req, env, f);
  return onWebhook(req, env, f);
}
