// Phone notifications for Proview Jobs. Kept free of Deno APIs so it can be tested with plain Node.
//   GET                      -> the public key a phone needs to subscribe
//   POST + x-pj-hook         -> the database says a job was created, assigned or completed
//   POST + a signed-in login -> { test: true } sends a test notification to that person's own phones
import { newVapid, sendPush, type Sub, type Vapid } from "./webpush.ts";

export interface Env {
  SUPABASE_URL: string;
  SERVICE_KEY: string;
  SITE_URL?: string; // who is sending, as told to Apple and Google
}
type Fetch = typeof fetch;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const jref = (ref: unknown) => "J-" + String(ref).padStart(4, "0");
const cut = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

function svc(env: Env): Record<string, string> {
  return { apikey: env.SERVICE_KEY, Authorization: "Bearer " + env.SERVICE_KEY, "Content-Type": "application/json" };
}
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function rows(env: Env, f: Fetch, path: string): Promise<any[]> {
  try { const r = await f(env.SUPABASE_URL + "/rest/v1/" + path, { headers: svc(env) }); const d = r.ok ? await r.json() : []; return Array.isArray(d) ? d : []; }
  catch (_) { return []; }
}
async function rpc(env: Env, f: Fetch, name: string, body: Record<string, unknown>): Promise<any> {
  const r = await f(env.SUPABASE_URL + "/rest/v1/rpc/" + name, { method: "POST", headers: svc(env), body: JSON.stringify(body) });
  if (!r.ok) throw new Error(name + " " + r.status);
  return r.json().catch(() => null);
}

/** The hook secret and the server's keys live in the database. The keys are made here the first time they are needed. */
interface Config { hook: string; vapid: Vapid }
async function config(env: Env, f: Fetch): Promise<Config> {
  const c = await rpc(env, f, "pj_push_config", {});
  let vapid: Vapid | null = c?.vapid && c.vapid.publicKey && c.vapid.privateJwk ? c.vapid : null;
  if (!vapid) vapid = await rpc(env, f, "pj_push_keys", { p: await newVapid() }); // if two calls race, the database keeps the first
  if (!vapid?.publicKey) throw new Error("no push keys");
  return { hook: String(c?.hook || ""), vapid };
}

export interface Note { title: string; body: string }
/** Who is told what. Returns person id -> notification. */
export function plan(event: string, job: any, people: any[], actor: string | null): Map<string, Note> {
  const out = new Map<string, Note>();
  const ref = jref(job.ref), title = cut(job.title, 110);
  const name = (id: string | null) => (people.find((p) => p.id === id)?.name || "");
  const managers = people.filter((p) => p.role === "manager" && p.id !== actor);
  const forYou = () => {
    if (!job.assigned_to || job.assigned_to === actor || !people.some((p) => p.id === job.assigned_to)) return;
    const bits = [title];
    if (job.priority === "urgent" || job.priority === "high") bits.push(job.priority === "urgent" ? "Urgent" : "High priority");
    if (job.customer_name) bits.push(cut(job.customer_name, 40));
    out.set(job.assigned_to, { title: "New job for you · " + ref, body: bits.join(" · ") });
  };
  if (event === "created") {
    for (const m of managers) out.set(m.id, { title: "New job " + ref, body: title + " · " + (job.assigned_to ? "Assigned to " + (name(job.assigned_to) || "someone") : "Not assigned yet") });
    forYou();
  } else if (event === "assigned") {
    forYou();
  } else if (event === "done") {
    const by = name(actor) || name(job.assigned_to);
    for (const m of managers) out.set(m.id, { title: ref + " completed", body: title + (by ? " · by " + by : "") });
  }
  return out;
}
/** The number on the app icon: unfinished jobs. Managers see all of them, staff their own. */
export function badgeFor(person: any, open: any[]): number {
  return person.role === "manager" ? open.length : open.filter((j) => j.assigned_to === person.id).length;
}

async function deliver(env: Env, f: Fetch, vapid: Vapid, notes: Map<string, Note>, people: any[], extra: Record<string, unknown>): Promise<number> {
  const ids = [...notes.keys()].filter((id) => UUID.test(id));
  if (!ids.length) return 0;
  const subs = await rows(env, f, "pj_push_subs?person_id=in.(" + ids.join(",") + ")&select=id,person_id,endpoint,p256dh,auth");
  if (!subs.length) return 0;
  const open = await rows(env, f, "pj_jobs?status=in.(open,in_progress)&select=assigned_to&limit=5000");
  const subject = env.SITE_URL || "https://tasks.proviewcrm.co.uk";
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    const n = notes.get(s.person_id), who = people.find((p) => p.id === s.person_id);
    if (!n || !who) return;
    const r = await sendPush(f, vapid, s as Sub, { ...n, ...extra, badge: badgeFor(who, open) }, subject);
    if (r.ok) sent++;
    else if (r.gone) await f(env.SUPABASE_URL + "/rest/v1/pj_push_subs?id=eq." + s.id, { method: "DELETE", headers: svc(env) }).catch(() => {});
  }));
  return sent;
}

async function onEvent(env: Env, f: Fetch, vapid: Vapid, body: any): Promise<Response> {
  const jobId = String(body?.job_id || ""), event = String(body?.event || "");
  const actor = UUID.test(String(body?.actor || "")) ? String(body.actor) : null;
  if (!UUID.test(jobId) || !["created", "assigned", "done"].includes(event)) return json({ ok: false, error: "bad event" }, 400);
  const job = (await rows(env, f, "pj_jobs?id=eq." + jobId + "&select=id,ref,title,status,priority,assigned_to,customer_name"))[0];
  if (!job) return json({ ok: true, sent: 0 });
  const people = await rows(env, f, "pj_people?active=is.true&select=id,name,role");
  const sent = await deliver(env, f, vapid, plan(event, job, people, actor), people, { tag: "job-" + job.id, url: "./?job=" + job.id });
  return json({ ok: true, sent });
}

async function onTest(req: Request, env: Env, f: Fetch, vapid: Vapid): Promise<Response> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "Sign in first" }, 401);
  const u = await f(env.SUPABASE_URL + "/auth/v1/user", { headers: { apikey: env.SERVICE_KEY, Authorization: "Bearer " + jwt } });
  const user = u.ok ? await u.json().catch(() => null) : null;
  if (!user?.id || !UUID.test(user.id)) return json({ ok: false, error: "Sign in first" }, 401);
  const me = (await rows(env, f, "pj_people?select=id,name,role&user_id=eq." + user.id + "&active=is.true"))[0];
  if (!me) return json({ ok: false, error: "Not on the team" }, 403);
  const sent = await deliver(env, f, vapid, new Map([[me.id, { title: "Proview Jobs", body: "Notifications are working on this phone." }]]), [me], { tag: "test", url: "./" });
  return json({ ok: true, sent });
}

export async function handle(req: Request, env: Env, f: Fetch = fetch): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "GET" && req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  let cfg: Config;
  try { cfg = await config(env, f); }
  catch (e) { console.error("push config", String(e).slice(0, 200)); return json({ ok: false, error: "Notifications are not set up yet" }, 503); }
  if (req.method === "GET") return json({ ok: true, key: cfg.vapid.publicKey });
  const body = await req.json().catch(() => ({}));
  const hook = req.headers.get("x-pj-hook");
  if (hook !== null) {
    if (!cfg.hook || !sameText(hook, cfg.hook)) return json({ ok: false, error: "Not allowed" }, 401);
    return onEvent(env, f, cfg.vapid, body);
  }
  if (body?.test) return onTest(req, env, f, cfg.vapid);
  return json({ ok: false, error: "Nothing to do" }, 400);
}
