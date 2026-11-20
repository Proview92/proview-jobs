// Run: node tests/handler.test.mjs   (no network: Supabase and WhatsApp are stand-ins)
import assert from "node:assert/strict";
import { handle, sign, replyFor, jobNotice, updateText, savePhoto } from "../supabase/functions/whatsapp-webhook/handler.ts";

const env = { SUPABASE_URL: "https://x.supabase.co", SERVICE_KEY: "svc", WA_VERIFY_TOKEN: "letmein", WA_APP_SECRET: "shh", WA_ACCESS_TOKEN: "tok" };
const JOB = "22222222-2222-2222-2222-222222222222";
const PERSON = "33333333-3333-3333-3333-333333333333";
function world({ manager = true, userOk = true, pending = false, buttonsFail = false, any = false, target = null, mime = "image/jpeg", mediaUrl = "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1" } = {}) {
  const calls = [];
  const f = async (url, init = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url: String(url), body, headers: init.headers || {} });
    const j = (o, status = 200) => new Response(JSON.stringify(o), { status });
    if (String(url).includes("/rest/v1/pj_settings")) return j([{ timezone: "Asia/Dubai", wa_any_message: any }]);
    if (String(url).includes("/rpc/pj_wa_ingest")) {
      const p = body.p;
      if (!p.manager_id && !p.trusted && p.from_phone !== "971500000001") return j({ ok: false, reason: "not_manager" });
      if (!p.title) return j({ ok: false, reason: "no_title" });
      return j({ ok: true, job_id: JOB, ref: 12, title: p.title, assignee: p.assign ? "Ravi Kumar" : null, assign_unmatched: false, due_date: p.due_date, priority: p.priority, tasks: p.tasks.length, parts: p.parts.length });
    }
    if (String(url).includes("/rpc/pj_wa_action")) {
      const p = body.p, base = { ok: true, job_id: JOB, ref: 12, title: "Install cameras", assignee: null, due_date: null, priority: "normal", tasks: 0, parts: 0 };
      if (p.from_phone !== "971500000001") return j({ ok: false, reason: "not_allowed" });
      if (p.action === "pending") return j(pending ? { ok: true, job_id: JOB } : { ok: false, reason: "none" });
      if (p.action === "people") return j({ ...base, people: [{ id: PERSON, name: "Ravi Kumar With A Very Long Name", role: "staff" }, { id: "44444444-4444-4444-4444-444444444444", name: "Sunny", role: "manager" }] });
      if (p.action === "assign") return j({ ...base, action: "assign", assignee: p.person_id ? "Ravi Kumar" : null });
      if (p.action === "priority") return j({ ...base, action: "priority", priority: p.priority });
      if (p.action === "details_start") return j({ ...base, action: "details_start" });
      if (p.action === "details_apply") return j({ ...base, action: "details_apply", due_date: p.due_date, tasks: p.tasks.length, parts: p.parts.length, assign_unmatched: false });
    }
    if (String(url).includes("/rpc/pj_wa_photo_target")) return j(body.p_phone !== "971500000001" ? { ok: false, reason: "not_allowed" } : pending ? { ok: true, job_id: JOB, ref: 12, pending: true } : target ? { ok: true, job_id: JOB, ref: 12, pending: false } : { ok: false, reason: "none" });
    if (String(url).includes("graph.facebook.com") && String(url).endsWith("/MEDIA1")) return j({ url: mediaUrl, mime_type: mime });
    if (String(url).startsWith(mediaUrl)) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    if (String(url).includes("/storage/v1/object/job-photos/")) return j({ Key: "ok" });
    if (String(url).includes("/rest/v1/pj_job_photos")) return new Response(null, { status: 201 });
    if (String(url).includes("graph.facebook.com") && buttonsFail && body.interactive?.type === "button") return j({ error: { message: "nope" } }, 400);
    if (String(url).includes("/auth/v1/user")) return userOk ? j({ id: "11111111-1111-1111-1111-111111111111" }) : j({}, 401);
    if (String(url).includes("/rest/v1/pj_people")) return j(manager ? [{ id: "mgr-1" }] : []);
    if (String(url).includes("/rest/v1/pj_jobs")) return j([{ ref: 12, title: "Install cameras", customer_name: "Ahmed", customer_phone: "050 1", address: "Shop 3", due_date: "2026-11-21", priority: "urgent", assignee: { name: "Ravi Kumar", phone: "971500000003" } }]);
    if (String(url).includes("/rest/v1/pj_wa_numbers")) return j([{ phone: "971500000001" }, { phone: "971500000002" }]);
    if (String(url).includes("graph.facebook.com")) return j({});
    throw new Error("unexpected " + url);
  };
  return { f, calls };
}
const waBody = (text, from = "971500000001", field = "messages") => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "971400000000", phone_number_id: "PNID" },
  [field === "messages" ? "messages" : "message_echoes"]: [{ from, to: "971511111111", id: "wamid.1", timestamp: "1", type: "text", text: { body: text } }] } }] }] });
const post = async (body, f, headers = {}) => handle(new Request("https://fn/whatsapp-webhook", { method: "POST", body, headers: { "x-hub-signature-256": await sign("shh", body), ...headers } }), env, f);
let n = 0;

// Meta's one-off address check
{ let r = await handle(new Request("https://fn/?hub.mode=subscribe&hub.verify_token=letmein&hub.challenge=4242"), env);
  assert.equal(r.status, 200); assert.equal(await r.text(), "4242");
  r = await handle(new Request("https://fn/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=4242"), env);
  assert.equal(r.status, 403); n++; }

// a wrong or missing signature is refused and nothing is saved
{ const w = world(); const body = waBody("Job: fix till");
  let r = await handle(new Request("https://fn/", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=00" } }), env, w.f);
  assert.equal(r.status, 401);
  r = await handle(new Request("https://fn/", { method: "POST", body }), env, w.f);
  assert.equal(r.status, 401);
  r = await handle(new Request("https://fn/", { method: "POST", body, headers: { "x-hub-signature-256": await sign("shh", body) } }), { ...env, WA_APP_SECRET: undefined }, w.f);
  assert.equal(r.status, 503);
  assert.equal(w.calls.length, 0); n++; }

// a manager's job message is saved and answered
{ const w = world();
  const r = await post(waBody("Job: Install cameras\nDue: tomorrow\nAssign: ravi\nTasks: a, b\nParts: 2x cam"), w.f);
  assert.equal(r.status, 200);
  const ing = w.calls.find((c) => c.url.includes("pj_wa_ingest")).body.p;
  assert.equal(ing.title, "Install cameras"); assert.equal(ing.from_phone, "971500000001"); assert.equal(ing.wa_id, "wamid.1");
  assert.match(ing.due_date, /^\d{4}-\d\d-\d\d$/); assert.deepEqual(ing.tasks, ["a", "b"]); assert.equal(ing.trusted, undefined);
  const sent = w.calls.find((c) => c.url.includes("graph.facebook.com"));
  assert.ok(sent.url.endsWith("/PNID/messages")); assert.equal(sent.body.to, "971500000001");
  assert.equal(sent.body.type, "interactive"); assert.equal(sent.body.interactive.type, "button");
  assert.match(sent.body.interactive.body.text, /Job J-0012 created[\s\S]*Assigned to Ravi Kumar[\s\S]*2 tasks, 1 part/);
  assert.deepEqual(sent.body.interactive.action.buttons.map((b) => [b.reply.id, b.reply.title]), [["as:" + JOB, "Assign staff"], ["pr:" + JOB, "Set priority"], ["dt:" + JOB, "Add details"]]);
  assert.ok(sent.body.interactive.action.buttons.every((b) => b.reply.title.length <= 20));
  // then the notices: the other listed number and the assignee, but not the sender a second time
  const out = w.calls.filter((c) => c.url.includes("graph.facebook.com")).slice(1).map((c) => [c.body.to, c.body.text.body.split("\n")[0]]);
  // if WhatsApp refuses buttons, the plain confirmation still goes out
  { const w2 = world({ buttonsFail: true }); await post(waBody("Job: Install cameras"), w2.f);
    const g = w2.calls.filter((c) => c.url.includes("graph.facebook.com") && c.body.to === "971500000001"); assert.deepEqual(g.map((c) => c.body.type), ["interactive", "text"]); assert.match(g[1].body.text.body, /Job J-0012 created/); }
  assert.deepEqual(out, [["971500000002", "\ud83c\udd95 New job J-0012"], ["971500000003", "\ud83d\udccb New job for you: J-0012"]]); n++; }

// ordinary chat is never stored or answered
{ const w = world(); const r = await post(waBody("Thanks, see you tomorrow"), w.f);
  assert.equal(r.status, 200); assert.ok(!w.calls.some((c) => c.url.includes("pj_wa_ingest") || c.url.includes("graph.facebook.com"))); n++; }

// "every message is a job": no prefix needed from an approved number
{ const ing = (w) => w.calls.filter((c) => c.url.includes("pj_wa_ingest")).map((c) => c.body.p);
  const sent = (w) => w.calls.filter((c) => c.url.includes("graph.facebook.com")).map((c) => c.body);
  let w = world({ any: true }); await post(waBody("Fix the till at Bella's\nCustomer: Bella 050 111 2222\nDue: tomorrow"), w.f);
  assert.equal(ing(w).length, 1); assert.equal(ing(w)[0].title, "Fix the till at Bella's"); assert.equal(ing(w)[0].customer_name, "Bella"); assert.equal(ing(w)[0].wa_id, "wamid.1");
  assert.equal(sent(w)[0].interactive.type, "button"); assert.match(sent(w)[0].interactive.body.text, /Job J-0012 created/);
  // switched off: nothing happens
  w = world({ any: false }); await post(waBody("Fix the till at Bella's"), w.f); assert.equal(ing(w).length, 0); assert.equal(sent(w).length, 0);
  // small talk is not a job
  for (const t of ["ok", "Thanks!", "thank you", "\u{1F44D}", "hi", "yes", "Got it."]) { w = world({ any: true }); await post(waBody(t), w.f); assert.equal(ing(w).length, 0, t); }
  // a number that is not approved is not read further and nothing is stored or sent
  w = world({ any: true }); await post(waBody("Free cameras please", "971599999999"), w.f);
  assert.equal(ing(w).length, 0); assert.equal(sent(w).length, 0); assert.ok(!w.calls.some((c) => c.url.includes("pj_settings")));
  // one long forwarded paragraph: short headline, full text kept
  const long = "Hi can someone come out to the shop on Al Wasl Road because the card machine keeps dropping the connection every afternoon and customers are walking out";
  w = world({ any: true }); await post(waBody(long), w.f);
  assert.ok(ing(w)[0].title.length <= 91 && ing(w)[0].title.endsWith("\u2026")); assert.equal(ing(w)[0].description, long);
  // a forwarded video with a caption makes a job from the caption and says the file was not saved
  const video = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PNID" }, messages: [{ from: "971500000001", id: "wamid.v", type: "video", video: { id: "V1", caption: "Walkthrough of gate 2" } }] } }] }] });
  w = world({ any: true }); await post(video, w.f);
  assert.equal(ing(w)[0].title, "Walkthrough of gate 2"); assert.match(ing(w)[0].description, /a video came with this message on WhatsApp and is not saved here/);
  // the Job prefix still works and is still stripped
  w = world({ any: true }); await post(waBody("Job: Install cameras"), w.f); assert.equal(ing(w)[0].title, "Install cameras"); n++; }

// someone who is not a manager gets no job and no reply
{ const w = world(); await post(waBody("Job: free cameras please", "971599999999"), w.f);
  assert.ok(w.calls.some((c) => c.url.includes("pj_wa_ingest")));
  assert.ok(!w.calls.some((c) => c.url.includes("graph.facebook.com"))); n++; }

// typed in the Business app itself (echo): saved, but never answered into the customer's chat
{ const w = world(); await post(waBody("#job Call back Mrs Khan", "971400000000", "smb_message_echoes"), w.f);
  const ing = w.calls.find((c) => c.url.includes("pj_wa_ingest")).body.p;
  assert.equal(ing.trusted, true); assert.equal(ing.title, "Call back Mrs Khan");
  const tos = w.calls.filter((c) => c.url.includes("graph.facebook.com")).map((c) => c.body.to);
  assert.deepEqual(tos, ["971500000001", "971500000002", "971500000003"]); assert.ok(!tos.includes("971511111111") && !tos.includes("971400000000")); n++; }

// quick add from the app
{ let w = world();
  let r = await handle(new Request("https://fn/", { method: "POST", body: JSON.stringify({ text: "Fix till at Bella's\nDue: fri" }), headers: { authorization: "Bearer userjwt", "x-pj-quick": "1" } }), env, w.f);
  assert.equal(r.status, 200); const out = await r.json(); assert.equal(out.ok, true);
  const ing = w.calls.find((c) => c.url.includes("pj_wa_ingest")).body.p;
  assert.equal(ing.manager_id, "mgr-1"); assert.equal(ing.source, "quick"); assert.equal(ing.title, "Fix till at Bella's");
  w = world({ manager: false });
  r = await handle(new Request("https://fn/", { method: "POST", body: JSON.stringify({ text: "x" }), headers: { authorization: "Bearer userjwt", "x-pj-quick": "1" } }), env, w.f);
  assert.equal(r.status, 403);
  w = world({ userOk: false });
  r = await handle(new Request("https://fn/", { method: "POST", body: JSON.stringify({ text: "x" }), headers: { authorization: "Bearer bad", "x-pj-quick": "1" } }), env, w.f);
  assert.equal(r.status, 401);
  r = await handle(new Request("https://fn/", { method: "POST", body: JSON.stringify({ text: "x" }), headers: { "x-pj-quick": "1" } }), env, w.f);
  assert.equal(r.status, 401); n++; }

// the app asks for notices after a manager assigns on screen; a template is used when one is configured
{ let w = world();
  let r = await handle(new Request("https://fn/", { method: "POST", body: JSON.stringify({ job_id: JOB, only_assignee: true }), headers: { authorization: "Bearer userjwt", "x-pj-notify": "1" } }), { ...env, WA_PHONE_NUMBER_ID: "PNID", WA_TEMPLATE: "new_job" }, w.f);
  assert.deepEqual(await r.json(), { ok: true, sent: 1, connected: true });
  const g = w.calls.filter((c) => c.url.includes("graph.facebook.com")); assert.equal(g.length, 1); assert.equal(g[0].body.to, "971500000003"); assert.equal(g[0].body.type, "template");
  assert.deepEqual(g[0].body.template.components[0].parameters.map((x) => x.text), ["for you J-0012", "Install cameras", "Customer: Ahmed 050 1 | Address: Shop 3 | Due Sat 21 Nov \u00b7 Urgent priority"]);
  w = world(); r = await handle(new Request("https://fn/", { method: "POST", body: JSON.stringify({ job_id: JOB }), headers: { authorization: "Bearer userjwt", "x-pj-notify": "1" } }), env, w.f);
  assert.deepEqual(await r.json(), { ok: true, sent: 0, connected: false }, "nothing is sent until a number is connected");
  w = world({ manager: false }); r = await handle(new Request("https://fn/", { method: "POST", body: JSON.stringify({ job_id: JOB }), headers: { authorization: "Bearer userjwt", "x-pj-notify": "1" } }), { ...env, WA_PHONE_NUMBER_ID: "PNID" }, w.f);
  assert.equal(r.status, 403); assert.ok(!w.calls.some((c) => c.url.includes("graph.facebook.com")));
  assert.match(jobNotice({ ref: 3, title: "T", priority: "normal" }, false).text, /New job J-0003\n\*T\*\nNot assigned yet$/); n++; }

// buttons and pick-lists under the reply
{ const tap = (id, kind = "button_reply", from = "971500000001") => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PNID" },
    messages: [{ from, id: "wamid.t", type: "interactive", interactive: { type: kind, [kind]: { id, title: "x" } } }] } }] }] });
  const sentTo = (w) => w.calls.filter((c) => c.url.includes("graph.facebook.com")).map((c) => c.body);
  const act = (w) => w.calls.filter((c) => c.url.includes("pj_wa_action")).map((c) => c.body.p);
  // Assign staff -> a list of the team
  let w = world(); await post(tap("as:" + JOB), w.f); let g = sentTo(w);
  assert.equal(g.length, 1); assert.equal(g[0].interactive.type, "list"); assert.equal(g[0].interactive.action.button, "Choose staff");
  const rows = g[0].interactive.action.sections[0].rows;
  assert.deepEqual(rows.map((r) => r.id), ["a:" + JOB + ":" + PERSON, "a:" + JOB + ":44444444-4444-4444-4444-444444444444", "a:" + JOB + ":none"]);
  assert.ok(rows.every((r) => r.title.length <= 24 && r.id.length <= 200)); assert.equal(rows[0].title, "Ravi Kumar With A Very \u2026");
  // picking a person assigns, confirms with the buttons again, and tells the assignee
  w = world(); await post(tap("a:" + JOB + ":" + PERSON, "list_reply"), w.f); g = sentTo(w);
  assert.deepEqual(act(w)[0], { from_phone: "971500000001", action: "assign", job_id: JOB, person_id: PERSON });
  assert.equal(g[0].interactive.type, "button"); assert.match(g[0].interactive.body.text, /J-0012 updated[\s\S]*Assigned to Ravi Kumar/);
  assert.equal(g[1].to, "971500000003"); assert.match(g[1].text.body, /New job for you: J-0012/);
  // "Nobody yet" unassigns and tells nobody
  w = world(); await post(tap("a:" + JOB + ":none", "list_reply"), w.f); g = sentTo(w);
  assert.equal(act(w)[0].person_id, ""); assert.equal(g.length, 1); assert.match(g[0].interactive.body.text, /Not assigned yet/);
  // priority
  w = world(); await post(tap("pr:" + JOB), w.f); g = sentTo(w);
  assert.deepEqual(g[0].interactive.action.sections[0].rows.map((r) => r.id), ["urgent", "high", "normal", "low"].map((k) => "p:" + JOB + ":" + k));
  w = world(); await post(tap("p:" + JOB + ":urgent", "list_reply"), w.f); g = sentTo(w);
  assert.equal(act(w)[0].priority, "urgent"); assert.match(g[0].interactive.body.text, /J-0012 updated[\s\S]*Urgent/);
  // Add details -> instructions, then the next ordinary message is applied to the job
  w = world(); await post(tap("dt:" + JOB), w.f); g = sentTo(w);
  assert.equal(act(w)[0].action, "details_start"); assert.match(g[0].text.body, /extra details for J-0012[\s\S]*Customer:/);
  w = world({ pending: true }); await post(waBody("Gate code 4411\nDue: tomorrow\nTasks: swap drawer, test\nParts: 2x till roll"), w.f); g = sentTo(w);
  const ap = act(w)[1]; assert.equal(ap.action, "details_apply"); assert.equal(ap.title, "Gate code 4411"); assert.deepEqual(ap.tasks, ["swap drawer", "test"]); assert.equal(ap.priority_set, false); assert.match(ap.due_date, /^\d{4}-\d\d-\d\d$/);
  assert.match(g[0].interactive.body.text, /J-0012 updated[\s\S]*2 tasks, 1 part/);
  // ordinary chat with nothing pending is looked up by number only and never sent anywhere
  w = world(); await post(waBody("See you at 5"), w.f);
  assert.deepEqual(act(w), [{ from_phone: "971500000001", action: "pending" }]); assert.equal(sentTo(w).length, 0);
  // taps from a number that is not allowed, or with a made-up id, do nothing
  w = world(); await post(tap("a:" + JOB + ":" + PERSON, "list_reply", "971599999999"), w.f); assert.equal(sentTo(w).length, 0);
  w = world(); await post(tap("a:not-a-job:" + PERSON, "list_reply"), w.f); assert.equal(w.calls.length, 0);
  w = world(); await post(tap("a:" + JOB + ":'; drop table", "list_reply"), w.f); assert.equal(w.calls.length, 0);
  assert.match(updateText({ ref: 3, title: "T", assignee: null, priority: "normal", assign_unmatched: true, assign_asked: "bob" }), /J-0003 updated\n\*T\*\nNot assigned yet\n.*could not match "bob"/); n++; }

// photos sent or forwarded on WhatsApp are filed on the job
{ const pic = (caption, from = "971500000001") => JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: { metadata: { phone_number_id: "PNID" },
    messages: [{ from, id: "wamid.p", type: "image", image: { id: "MEDIA1", ...(caption ? { caption } : {}) } }] } }] }] });
  const ing = (w) => w.calls.filter((c) => c.url.includes("pj_wa_ingest")).map((c) => c.body.p);
  const stored = (w) => w.calls.filter((c) => c.url.includes("/storage/v1/object/job-photos/")).map((c) => c.url.split("/job-photos/")[1]);
  const rec = (w) => w.calls.filter((c) => c.url.includes("/rest/v1/pj_job_photos")).map((c) => c.body);
  const sent = (w) => w.calls.filter((c) => c.url.includes("graph.facebook.com") && c.url.endsWith("/messages")).map((c) => c.body);
  // photo with a caption: new job from the caption, photo filed under it
  let w = world({ any: true }); await post(pic("Broken camera at gate 2"), w.f);
  assert.equal(ing(w)[0].title, "Broken camera at gate 2"); assert.equal(ing(w)[0].description, "");
  assert.equal(stored(w).length, 1); assert.match(stored(w)[0], new RegExp("^" + JOB + "/[0-9a-f-]{36}\\.jpg$")); assert.deepEqual(rec(w), [{ job_id: JOB, path: stored(w)[0] }]);
  assert.match(sent(w)[0].interactive.body.text, /Job J-0012 created[\s\S]*Photo attached/);
  // the token only goes to Meta: the photo download carried it, the storage upload did not
  const dl = w.calls.find((c) => c.url.startsWith("https://lookaside.fbsbx.com")); assert.equal(dl.headers.Authorization, "Bearer tok");
  const up = w.calls.find((c) => c.url.includes("/storage/v1/")); assert.equal(up.headers.Authorization, "Bearer svc"); assert.equal(up.headers["Content-Type"], "image/jpeg");
  // photo with no caption right after a job: added to that job
  w = world({ any: true, target: true }); await post(pic(""), w.f);
  assert.equal(ing(w).length, 0); assert.equal(stored(w).length, 1); assert.match(sent(w)[0].text.body, /Photo added to J-0012/);
  // photo while adding details: goes on that job, caption becomes details
  w = world({ pending: true }); await post(pic("Due: tomorrow"), w.f);
  assert.equal(ing(w).length, 0); assert.equal(stored(w).length, 1); assert.match(sent(w)[0].interactive.body.text, /J-0012 updated[\s\S]*Photo attached/);
  // photo on its own with nothing recent: a job to hang it on (only when every message is a job)
  w = world({ any: true }); await post(pic(""), w.f);
  assert.equal(ing(w)[0].title, "Photo sent on WhatsApp"); assert.equal(stored(w).length, 1); assert.match(sent(w)[0].interactive.body.text, /Photo attached\nTap Add details/);
  w = world({ any: false }); await post(pic(""), w.f); assert.equal(ing(w).length, 0); assert.equal(stored(w).length, 0); assert.equal(sent(w).length, 0);
  // with the switch off, a caption must start with Job
  w = world({ any: false }); await post(pic("Broken camera"), w.f); assert.equal(ing(w).length, 0);
  w = world({ any: false }); await post(pic("Job: Broken camera"), w.f); assert.equal(ing(w)[0].title, "Broken camera"); assert.equal(stored(w).length, 1);
  // a number that is not approved: the photo is never fetched
  w = world({ any: true }); await post(pic("Free stuff", "971599999999"), w.f);
  assert.ok(!w.calls.some((c) => c.url.includes("graph.facebook.com") || c.url.includes("/storage/") || c.url.includes("pj_wa_ingest")));
  // a file that is not a photo, or a download address that is not Meta's, is refused and the reply says so
  w = world({ any: true, mime: "application/pdf" }); await post(pic("Spec sheet"), w.f); assert.equal(stored(w).length, 0); assert.match(sent(w)[0].interactive.body.text, /could not be saved/);
  w = world({ any: true, mediaUrl: "https://evil.example.com/x" }); await post(pic("Camera"), w.f); assert.equal(stored(w).length, 0); assert.ok(!w.calls.some((c) => c.url.startsWith("https://evil.example.com")));
  assert.equal(await savePhoto(env, w.f, "../etc", JOB), false); assert.equal(await savePhoto(env, w.f, "MEDIA1", "not-a-job"), false); n++; }

assert.equal(replyFor({ ok: false, reason: "duplicate" }), null);
assert.match(replyFor({ ok: true, ref: 3, title: "T", assignee: null, assign_unmatched: true, assign_asked: "bob" }), /Not assigned yet[\s\S]*could not match "bob"/);
console.log("handler:", n, "groups passed");
{ const { selfTest } = await import("../supabase/functions/whatsapp-webhook/handler.ts");
  assert.equal(selfTest(), "selftest ok 12");
  const r = await handle(new Request("https://fn/?selftest=1"), env); assert.equal(await r.text(), "selftest ok 12"); console.log("selftest ok"); }
