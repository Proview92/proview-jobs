// Run: node tests/push.test.mjs   (no network: Supabase and the phone push services are stand-ins)
import assert from "node:assert/strict";
import { b64u, unb64u, encrypt, newVapid, vapidHeader, isPushEndpoint, sendPush } from "../supabase/functions/push/webpush.ts";
import { handle, plan, badgeFor } from "../supabase/functions/push/handler.ts";
const enc = new TextEncoder(), dec = new TextDecoder();
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of a) { o.set(p, at); at += p.length; } return o; };
const hkdf = async (salt, ikm, info, len) => new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]), len * 8));
let n = 0;

// a phone: its own key pair and secret, and the decryption a real phone performs (RFC 8291, receiving side)
async function phone() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)), auth = crypto.getRandomValues(new Uint8Array(16));
  return { p256dh: b64u(pub), auth: b64u(auth), async open(body) {
    const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20];
    const asPub = body.slice(21, 21 + idlen), sealed = body.slice(21 + idlen);
    assert.equal(rs, 4096); assert.equal(idlen, 65);
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await crypto.subtle.importKey("raw", asPub, { name: "ECDH", namedCurve: "P-256" }, false, []) }, kp.privateKey, 256));
    const ikm = await hkdf(auth, secret, cat(enc.encode("WebPush: info\0"), pub, asPub), 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16), nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), sealed));
    assert.equal(plain[plain.length - 1], 2, "last-record marker");
    return dec.decode(plain.slice(0, -1));
  } };
}

// the message a phone receives is exactly what was sent, and differs every time on the wire
{ const p = await phone(); const msg = JSON.stringify({ title: "New job for you · J-0007", body: "Fix till — Karama ✓", badge: 3 });
  const a = await encrypt(p.p256dh, p.auth, enc.encode(msg)), b = await encrypt(p.p256dh, p.auth, enc.encode(msg));
  assert.equal(await p.open(a), msg); assert.equal(await p.open(b), msg); assert.notEqual(b64u(a), b64u(b));
  const other = await phone(); await assert.rejects(other.open(a));           // another phone cannot read it
  await assert.rejects(encrypt("AAAA", p.auth, enc.encode("x")), /bad subscription keys/);
  await assert.rejects(encrypt(p.p256dh, p.auth, new Uint8Array(4000)), /too long/);
  assert.deepEqual([...unb64u(b64u(new Uint8Array([0, 255, 254, 3])))], [0, 255, 254, 3]); n++; }

// the sender's signature checks out against the public key phones subscribed with
{ const v = await newVapid(); assert.equal(unb64u(v.publicKey).length, 65);
  const h = await vapidHeader(v, "https://web.push.apple.com/QABC", "https://tasks.proviewcrm.co.uk", 1_800_000_000_000);
  const m = h.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/); assert.ok(m); assert.equal(m[4], v.publicKey);
  assert.deepEqual(JSON.parse(dec.decode(unb64u(m[1]))), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(dec.decode(unb64u(m[2]))), { aud: "https://web.push.apple.com", exp: 1_800_000_000 + 43200, sub: "https://tasks.proviewcrm.co.uk" });
  const pub = await crypto.subtle.importKey("raw", unb64u(v.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  assert.equal(unb64u(m[3]).length, 64);
  assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, unb64u(m[3]), enc.encode(m[1] + "." + m[2]))); n++; }

// only real push services are ever contacted
{ for (const u of ["https://web.push.apple.com/Qx", "https://fcm.googleapis.com/fcm/send/x", "https://updates.push.services.mozilla.com/wpush/v2/x", "https://wns2-par02p.notify.windows.com/w/?token=x"]) assert.ok(isPushEndpoint(u), u);
  for (const u of ["http://web.push.apple.com/x", "https://evil.example.com/x", "https://push.apple.com.evil.com/x", "https://tvakgaafkkfealhmebpm.supabase.co/rest/v1/pj_people", "nonsense"]) assert.ok(!isPushEndpoint(u), u);
  let called = 0; const r = await sendPush(async () => { called++; return new Response(""); }, await newVapid(), { endpoint: "https://evil.example.com/x", p256dh: "x", auth: "y" }, {}, "https://x"); assert.equal(called, 0); assert.equal(r.gone, true); n++; }

// who is told what
{ const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", M2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", S2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const people = [{ id: M1, name: "Sunny", role: "manager" }, { id: M2, name: "Dana", role: "manager" }, { id: S1, name: "Ravi", role: "staff" }, { id: S2, name: "Omar", role: "staff" }];
  const job = { id: "j", ref: 7, title: "Fix till", priority: "urgent", assigned_to: S1, customer_name: "Ahmed" };
  let p = plan("created", job, people, M1);            // made in the app by Sunny, for Ravi
  assert.deepEqual([...p.keys()].sort(), [M2, S1].sort()); assert.equal(p.get(S1).title, "New job for you · J-0007"); assert.match(p.get(S1).body, /Fix till · Urgent · Ahmed/); assert.match(p.get(M2).body, /Assigned to Ravi/);
  p = plan("created", { ...job, assigned_to: null }, people, null); // from WhatsApp, nobody yet
  assert.deepEqual([...p.keys()].sort(), [M1, M2].sort()); assert.match(p.get(M1).body, /Not assigned yet/);
  p = plan("assigned", job, people, M1); assert.deepEqual([...p.keys()], [S1]);
  p = plan("assigned", job, people, S1); assert.equal(p.size, 0);                // taking it yourself is not news to you
  p = plan("assigned", { ...job, assigned_to: M2 }, people, M1); assert.deepEqual([...p.keys()], [M2]);
  p = plan("done", job, people, S1); assert.deepEqual([...p.keys()].sort(), [M1, M2].sort()); assert.equal(p.get(M1).title, "J-0007 completed"); assert.match(p.get(M1).body, /by Ravi/);
  p = plan("done", job, people, M1); assert.deepEqual([...p.keys()], [M2]);
  assert.equal(plan("deleted", job, people, null).size, 0);
  const open = [{ assigned_to: S1 }, { assigned_to: S1 }, { assigned_to: null }, { assigned_to: S2 }];
  assert.equal(badgeFor(people[0], open), 4); assert.equal(badgeFor(people[2], open), 2); assert.equal(badgeFor({ id: "zz", role: "staff" }, open), 0); n++; }

// the function end to end
{ const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", S1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", JOB = "22222222-2222-4222-8222-222222222222";
  const env = { SUPABASE_URL: "https://x.supabase.co", SERVICE_KEY: "svc" };
  const ravi = await phone(), old = await phone();
  function world({ vapid = null } = {}) {
    const calls = [], pushes = []; let stored = vapid, keyCalls = 0;
    const f = async (url, init = {}) => {
      url = String(url); const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body; calls.push({ url, body, method: init.method || "GET", headers: init.headers || {} });
      const j = (o, status = 200) => new Response(JSON.stringify(o), { status });
      if (url.endsWith("/rpc/pj_push_config")) return j({ hook: "s3cret-hook", vapid: stored });
      if (url.endsWith("/rpc/pj_push_keys")) { keyCalls++; stored = stored || body.p; return j(stored); }
      if (url.includes("/rest/v1/pj_jobs?id=eq.")) return j([{ id: JOB, ref: 7, title: "Fix till", status: "open", priority: "normal", assigned_to: S1, customer_name: "" }]);
      if (url.includes("/rest/v1/pj_jobs?status=in.")) return j([{ assigned_to: S1 }, { assigned_to: S1 }, { assigned_to: null }]);
      if (url.includes("/rest/v1/pj_people?active")) return j([{ id: M1, name: "Sunny", role: "manager" }, { id: S1, name: "Ravi", role: "staff" }]);
      if (url.includes("/rest/v1/pj_people?select=id,name,role&user_id")) return j([{ id: S1, name: "Ravi", role: "staff" }]);
      if (url.includes("/rest/v1/pj_push_subs?person_id=in.")) { assert.ok(url.includes(S1)); return j([{ id: "sub-1", person_id: S1, endpoint: "https://web.push.apple.com/QRavi", p256dh: ravi.p256dh, auth: ravi.auth }, { id: "sub-2", person_id: S1, endpoint: "https://fcm.googleapis.com/fcm/send/old", p256dh: old.p256dh, auth: old.auth }]); }
      if (url.includes("/rest/v1/pj_push_subs?id=eq.")) return new Response(null, { status: 204 });
      if (url.includes("/auth/v1/user")) return init.headers.Authorization === "Bearer good" ? j({ id: "11111111-1111-4111-8111-111111111111" }) : j({}, 401);
      if (url.startsWith("https://web.push.apple.com/")) { pushes.push({ url, body: new Uint8Array(init.body), headers: init.headers }); return new Response(null, { status: 201 }); }
      if (url.startsWith("https://fcm.googleapis.com/")) return new Response("gone", { status: 410 });
      throw new Error("unexpected " + url);
    };
    return { f, calls, pushes, get stored() { return stored; }, get keyCalls() { return keyCalls; } };
  }
  const post = (w, body, headers = {}) => handle(new Request("https://fn/push", { method: "POST", body: JSON.stringify(body), headers }), env, w.f);
  // first use makes the keys and keeps them; the public half is what phones are given
  let w = world(); let r = await handle(new Request("https://fn/push"), env, w.f); let d = await r.json();
  assert.equal(r.status, 200); assert.equal(w.keyCalls, 1); assert.equal(d.key, w.stored.publicKey); assert.ok(!JSON.stringify(d).includes('"d"'), "the private key is never sent out");
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  const keys = w.stored; w = world({ vapid: keys }); await handle(new Request("https://fn/push"), env, w.f); assert.equal(w.keyCalls, 0);
  // a job is assigned: Ravi's iPhone gets it, readable only by that phone, with the icon number
  r = await post(w, { job_id: JOB, event: "assigned", actor: M1 }, { "x-pj-hook": "s3cret-hook" }); d = await r.json();
  assert.deepEqual(d, { ok: true, sent: 1 }); assert.equal(w.pushes.length, 1);
  const got = JSON.parse(await ravi.open(w.pushes[0].body));
  assert.deepEqual(got, { title: "New job for you · J-0007", body: "Fix till", tag: "job-" + JOB, url: "./?job=" + JOB, badge: 2 });
  assert.equal(w.pushes[0].headers["Content-Encoding"], "aes128gcm"); assert.match(w.pushes[0].headers.Authorization, /^vapid t=.+, k=/); assert.ok(!JSON.stringify(w.pushes[0].headers).includes("svc"), "the service key never goes to Apple");
  // the phone that unsubscribed is forgotten
  assert.ok(w.calls.some((c) => c.method === "DELETE" && c.url.endsWith("pj_push_subs?id=eq.sub-2"))); assert.ok(!w.calls.some((c) => c.method === "DELETE" && c.url.endsWith("sub-1")));
  // a wrong or missing hook secret sends nothing
  for (const h of [{ "x-pj-hook": "wrong" }, { "x-pj-hook": "" }, {}]) { w = world({ vapid: keys }); r = await post(w, { job_id: JOB, event: "assigned" }, h); assert.ok(r.status === 401 || r.status === 400, JSON.stringify(h)); assert.equal(w.pushes.length, 0); }
  w = world({ vapid: keys }); r = await post(w, { job_id: "x; drop", event: "assigned" }, { "x-pj-hook": "s3cret-hook" }); assert.equal(r.status, 400);
  w = world({ vapid: keys }); r = await post(w, { job_id: JOB, event: "exploded" }, { "x-pj-hook": "s3cret-hook" }); assert.equal(r.status, 400);
  // a signed-in person can test their own phone; nobody else can
  w = world({ vapid: keys }); r = await post(w, { test: true }, { authorization: "Bearer good" }); assert.deepEqual(await r.json(), { ok: true, sent: 1 }); assert.match(JSON.parse(await ravi.open(w.pushes[0].body)).body, /working/);
  w = world({ vapid: keys }); r = await post(w, { test: true }, { authorization: "Bearer bad" }); assert.equal(r.status, 401); assert.equal(w.pushes.length, 0);
  w = world({ vapid: keys }); r = await post(w, { test: true }); assert.equal(r.status, 401);
  r = await handle(new Request("https://fn/push", { method: "DELETE" }), env, w.f); assert.equal(r.status, 405); n++; }

console.log("push:", n, "groups passed");
