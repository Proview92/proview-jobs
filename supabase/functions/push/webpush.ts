// Web Push, written against the standard Web Crypto API only (no libraries, no Deno APIs),
// so the same file runs in the Supabase function and in the Node tests.
// Message encryption: RFC 8291 (aes128gcm). Sender identity: VAPID, RFC 8292.

const enc = new TextEncoder();
type Bytes = Uint8Array;

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s: string): Bytes {
  const t = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function cat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The server's own key pair. publicKey is what phones subscribe with; privateJwk never leaves the server. */
export interface Vapid { publicKey: string; privateJwk: JsonWebKey }
export async function newVapid(): Promise<Vapid> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  return { publicKey: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
}

async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, len: number): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

/** Encrypt a message so that only the subscribed phone can read it. Returns the request body. */
export async function encrypt(p256dh: string, auth: string, payload: Uint8Array): Promise<Bytes> {
  const uaPub = unb64u(p256dh), authSecret = unb64u(auth);
  if (uaPub.length !== 65 || authSecret.length !== 16) throw new Error("bad subscription keys");
  if (payload.length > 3000) throw new Error("message too long");
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, secret, cat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(payload, new Uint8Array([2]))));
  const head = new Uint8Array(21);          // salt (16) + record size (4) + key length (1)
  head.set(salt);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPub.length;
  return cat(head, asPub, sealed);
}

/** The Authorization header that proves to Apple or Google which server is sending. */
export async function vapidHeader(v: Vapid, endpoint: string, subject: string, now = Date.now()): Promise<string> {
  const key = await crypto.subtle.importKey("jwk", v.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + claims));
  return "vapid t=" + head + "." + claims + "." + b64u(sig) + ", k=" + v.publicKey;
}

// Only the push services of Apple, Google, Mozilla and Microsoft are ever contacted.
const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
export function isPushEndpoint(endpoint: string): boolean {
  try { const u = new URL(endpoint); return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname); }
  catch (_) { return false; }
}

export interface Sub { endpoint: string; p256dh: string; auth: string }
export interface Sent { ok: boolean; gone: boolean; status: number }
/** Send one notification. gone = the phone has unsubscribed, so the subscription should be forgotten. */
export async function sendPush(f: typeof fetch, v: Vapid, sub: Sub, message: unknown, subject: string): Promise<Sent> {
  if (!isPushEndpoint(sub.endpoint)) return { ok: false, gone: true, status: 0 };
  try {
    const body = await encrypt(sub.p256dh, sub.auth, enc.encode(JSON.stringify(message)));
    const r = await f(sub.endpoint, {
      method: "POST",
      headers: { Authorization: await vapidHeader(v, sub.endpoint, subject), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "86400", Urgency: "high" },
      body,
    });
    const ok = r.status >= 200 && r.status < 300;
    if (!ok) console.error("push refused", r.status, new URL(sub.endpoint).hostname, (await r.text().catch(() => "")).slice(0, 200));
    return { ok, gone: r.status === 404 || r.status === 410, status: r.status };
  } catch (e) {
    console.error("push failed", String(e).slice(0, 200));
    return { ok: false, gone: /bad subscription keys/.test(String(e)), status: 0 };
  }
}
