'use strict';
/* Proview Jobs: helpers, state and data. */
const SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  sb: null, cfg: null, me: null, settings: null,
  people: [], jobs: [], wa: [], numbers: [],
  tab: 'jobs', filter: 'open', q: '',
  job: null,          // the job that is open, with its tasks, parts and photos
  ready: false,
};
const isMgr = () => !!S.me && S.me.role === 'manager';

const STATUS = { open: 'To do', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
const PRIORITY = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };
const PRANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function toast(msg, bad) {
  const d = document.createElement('div');
  d.textContent = msg;
  if (bad) d.className = 'bad';
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), bad ? 6000 : 3200);
}
function problem(e) {
  const m = (e && (e.message || e.error_description || e.error)) || String(e || 'Something went wrong');
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'No connection. Check the internet and try again.';
  return m;
}
function jref(j) { return 'J-' + String(j.ref).padStart(4, '0'); }
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function niceDate(iso) {
  if (!iso) return '';
  const t = todayISO();
  if (iso === t) return 'Today';
  const d = new Date(iso + 'T12:00:00');
  const diff = Math.round((d - new Date(t + 'T12:00:00')) / 86400000);
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const o = { weekday: 'short', day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
  return d.toLocaleDateString('en-GB', o);
}
function niceTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function isLate(j) { return !!j.due_date && j.due_date < todayISO() && (j.status === 'open' || j.status === 'in_progress'); }
function person(id) { return S.people.find((p) => p.id === id) || null; }
function personName(id) { const p = person(id); return p ? p.name : ''; }
function digits(s) { let d = String(s || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); return d; }
function mapsLink(a) { return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(a); }
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('Copied'); }
  catch (_) { toast('Could not copy. Press and hold the text to copy it.', true); }
}

/* ---------- data ---------- */
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
async function loadJobs() {
  S.jobs = await q(S.sb.from('pj_jobs').select('*, pj_job_tasks(id,done), pj_job_parts(id,used)').order('created_at', { ascending: false }).limit(1000)) || [];
  if (typeof setBadge === 'function') setBadge();
}
async function loadPeople() {
  S.people = await q(S.sb.from('pj_people').select('*').order('name')) || [];
}
async function loadSettings() {
  const rows = await q(S.sb.from('pj_settings').select('*').limit(1));
  S.settings = (rows && rows[0]) || { timezone: 'Europe/London', business_name: 'Proview Tech' };
}
async function loadWa() {
  S.wa = await q(S.sb.from('pj_wa_log').select('*').order('created_at', { ascending: false }).limit(30)) || [];
}
async function loadNumbers() {
  S.numbers = await q(S.sb.from('pj_wa_numbers').select('*').order('created_at')) || [];
}
/* Ask the server to send WhatsApp job notices. Quietly does nothing until a number is connected. */
function sendNotices(jobId, onlyAssignee) {
  if (!S.sb.functions) return;
  S.sb.functions.invoke('whatsapp-webhook', { body: { job_id: jobId, only_assignee: !!onlyAssignee }, headers: { 'x-pj-notify': '1' } })
    .then(({ data }) => { if (data && data.sent) toast('Sent on WhatsApp to ' + data.sent + (data.sent === 1 ? ' number' : ' numbers')); })
    .catch(() => {});
}
async function loadJob(id) {
  const j = await q(S.sb.from('pj_jobs').select('*, pj_job_tasks(*), pj_job_parts(*), pj_job_photos(*)').eq('id', id).maybeSingle());
  if (!j) return null;
  j.pj_job_tasks = (j.pj_job_tasks || []).sort((a, b) => a.sort - b.sort);
  j.pj_job_parts = (j.pj_job_parts || []).sort((a, b) => a.sort - b.sort);
  j.pj_job_photos = (j.pj_job_photos || []).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  if (j.pj_job_photos.length) {
    try {
      const { data } = await S.sb.storage.from('job-photos').createSignedUrls(j.pj_job_photos.map((p) => p.path), 3600);
      (data || []).forEach((s, i) => { if (s && s.signedUrl) j.pj_job_photos[i].url = s.signedUrl; });
    } catch (_) { /* photos simply show as blanks */ }
  }
  return j;
}

/* Shrink a phone photo before sending it: 1600px on the long side is plenty to read a label. */
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    if (blob) return blob;
  } catch (_) { /* fall through to the original file */ }
  return file;
}
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

/* ---------- dialogs ---------- */
function modal(html) { $('#mdl-root').innerHTML = '<div class="mdl" data-a="mdl-bg"><div class="mdl-box" role="dialog" aria-modal="true">' + html + '</div></div>'; const f = $('#mdl-root [autofocus]'); if (f) f.focus(); }
function closeModal() { $('#mdl-root').innerHTML = ''; S.confirm = null; }
function confirmBox(title, text, yes, fn, bad) {
  S.confirm = fn;
  modal('<h2>' + esc(title) + '</h2><p>' + esc(text) + '</p><div class="foot"><button class="btn" data-a="mdl-close">Cancel</button><button class="btn ' + (bad ? 'bad' : 'pri') + '" data-a="confirm-yes">' + esc(yes) + '</button></div>');
}
function busy(btn, on) { if (btn) btn.disabled = !!on; }
