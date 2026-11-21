/* Notifications on this phone, and the number on the home-screen icon. */
const PUSH = { reg: null, sub: null, busy: false };
const pushCan = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isInstalled = () => (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
const pushUrl = () => S.cfg.url + '/functions/v1/push';

function b64uBytes(s) {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
async function pushInit() {
  if (!('serviceWorker' in navigator) || window.__PJ_SB__) return;
  try {
    PUSH.reg = await navigator.serviceWorker.register('sw.js');
    if (PUSH.reg.pushManager) PUSH.sub = await PUSH.reg.pushManager.getSubscription();
    if (PUSH.sub && Notification.permission === 'granted') pushSave(PUSH.sub).catch(() => {}); // keep it tied to whoever is signed in
    navigator.serviceWorker.addEventListener('message', (ev) => { if (ev.data && ev.data.pjOpen) openFromLink(ev.data.pjOpen); });
  } catch (_) { /* notifications simply stay off */ }
  if (S.tab === 'me') renderMe(); else if (S.tab === 'jobs' && !S.job) renderJobs();
}
function pushSave(sub) {
  const j = sub.toJSON();
  return q(S.sb.rpc('pj_push_save', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_ua: navigator.userAgent }));
}
async function pushOn() {
  if (PUSH.busy) return; PUSH.busy = true;
  try {
    if (!pushCan() || !PUSH.reg) throw new Error(isIOS() && !isInstalled() ? 'Add Proview Jobs to your Home Screen first, then open it from there.' : 'This browser cannot show notifications.');
    // must be asked for straight from the tap, or the iPhone refuses
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Notifications are blocked for this app. Allow them in the phone\'s Settings, then try again.');
    const k = await (await fetch(pushUrl(), { cache: 'no-store' })).json();
    if (!k || !k.key) throw new Error('Notifications are not set up yet. Try again in a minute.');
    PUSH.sub = await PUSH.reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(k.key) });
    await pushSave(PUSH.sub);
    toast('Notifications are on');
    pushTest(true);
  } catch (e) { toast(problem(e), true); }
  PUSH.busy = false;
  if (S.tab === 'me') renderMe(); else renderJobs();
}
async function pushOff() {
  try {
    if (PUSH.sub) { const ep = PUSH.sub.endpoint; await PUSH.sub.unsubscribe(); PUSH.sub = null; await q(S.sb.rpc('pj_push_remove', { p_endpoint: ep })); }
    toast('Notifications are off on this phone');
  } catch (e) { toast(problem(e), true); }
  if (S.tab === 'me') renderMe();
}
async function pushTest(quiet) {
  try {
    const { data: s } = await S.sb.auth.getSession();
    const r = await (await fetch(pushUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.session.access_token }, body: JSON.stringify({ test: true }) })).json();
    if (!quiet) toast(r && r.sent ? 'Test sent. It should appear in a moment.' : 'No test could be sent. Turn notifications off and on again.', !(r && r.sent));
  } catch (e) { if (!quiet) toast(problem(e), true); }
}
/* Signing out on a shared phone must stop the last person's notifications arriving on it. */
async function pushForget() {
  try { if (PUSH.sub) { const ep = PUSH.sub.endpoint; await PUSH.sub.unsubscribe(); PUSH.sub = null; await S.sb.rpc('pj_push_remove', { p_endpoint: ep }); } } catch (_) { /* best effort */ }
  try { if (navigator.clearAppBadge) await navigator.clearAppBadge(); } catch (_) { /* no badge to clear */ }
}

const pushState = () => !pushCan() ? (isIOS() && !isInstalled() ? 'install' : 'none') : Notification.permission === 'denied' ? 'blocked' : (PUSH.sub && Notification.permission === 'granted') ? 'on' : 'off';
function pushCard() {
  const st = pushState();
  const body = st === 'on' ? '<p class="mut">This phone is told when a job is ' + (isMgr() ? 'created or completed' : 'assigned to you') + '. The number on the app icon is your jobs not yet completed.</p><div class="foot" style="justify-content:flex-start"><button class="btn" data-a="push-test">Send a test</button><button class="btn" data-a="push-off">Turn off</button></div>'
    : st === 'off' ? '<p class="mut">Get a notification on this phone when a job is ' + (isMgr() ? 'created or completed' : 'assigned to you') + '.</p><button class="btn pri wide" data-a="push-on">Turn on notifications</button>'
    : st === 'blocked' ? '<p class="mut">Notifications are blocked for this app. Open the phone\'s Settings, find Proview Jobs under Notifications, and allow them.</p>'
    : st === 'install' ? '<p class="mut">On an iPhone, notifications work once the app is on your Home Screen: tap Share, then "Add to Home Screen", open Proview Jobs from the new icon, and come back to this page.</p>'
    : '<p class="mut">This browser cannot show notifications.</p>';
  return '<div class="card"><h2>Notifications</h2>' + body + '</div>';
}
/* A one-line nudge on the jobs page until notifications are on (or dismissed on this phone). */
function pushNudge() {
  let hidden = false;
  try { hidden = localStorage.getItem('pj-push-nudge') === 'x'; } catch (_) { /* show it */ }
  if (hidden || pushState() !== 'off') return '';
  return '<div class="card nudge"><span>Get notified about ' + (isMgr() ? 'new and completed jobs' : 'new jobs') + ' on this phone.</span><button class="btn pri" data-a="push-on">Turn on</button><button class="btn" data-a="push-later" aria-label="Not now">Not now</button></div>';
}
function pushLater() { try { localStorage.setItem('pj-push-nudge', 'x'); } catch (_) { /* fine */ } renderJobs(); }

/* The number on the home-screen icon: jobs not yet completed (all of them for a manager, your own for staff). */
function setBadge() {
  if (!navigator.setAppBadge || !S.me) return;
  const n = S.jobs.filter((j) => (j.status === 'open' || j.status === 'in_progress') && (isMgr() || j.assigned_to === S.me.id)).length;
  (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
/* Tapping a notification opens that job. */
function openFromLink(href) {
  try {
    const id = new URL(href, location.href).searchParams.get('job');
    if (id && /^[0-9a-f-]{36}$/i.test(id) && S.ready) { S.tab = 'jobs'; render(); openJob(id); }
  } catch (_) { /* just the app */ }
}
