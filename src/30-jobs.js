/* The frame, the job list and the job page. */
const IC = {
  jobs: '<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4.5V3h6v1.5M9 10h6M9 14h6M9 18h3"/>',
  team: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 5.200a3.2 3.2 0 0 1 0 5.800M17.5 14.300c2.1.8 3.5 2.9 3.5 5.7"/>',
  chat: '<path d="M4 19.500l1.3-4A7.5 7.5 0 1 1 8.5 18.700z"/><path d="M9 10.500h6M9 13.500h3.5"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c0-3.9 3.1-7 7-7s7 3.1 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.500l4 4"/>',
  phone: '<path d="M6.5 3.500h3l1.5 4-2 1.500a11 11 0 0 0 5 5l1.5-2 4 1.500v3a2 2 0 0 1-2 2C10.5 18.5 5.5 13.5 4.5 5.500a2 2 0 0 1 2-2z"/>',
  pin: '<path d="M12 21s7-6.2 7-11.500a7 7 0 1 0-14 0C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  cal: '<rect x="4" y="5.5" width="16" height="15" rx="2.5"/><path d="M4 10h16M8.5 3.500v4M15.5 3.500v4"/>',
  bolt: '<path d="M13 3L5 13.500h6L10 21l8-10.500h-6z"/>',
  check: '<path d="M5 12.500l4.5 4.500L19 7.5"/>',
  play: '<path d="M8 5.500v13l10-6.500z"/>',
};
function ic(n) { return '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">' + IC[n] + '</svg>'; }
function initial(name) { return esc((name || '?').trim().charAt(0).toUpperCase()); }
function greeting() { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

function render() {
  if (!S.ready) return;
  const mgr = isMgr();
  if (!mgr && S.tab !== 'me') S.tab = 'jobs';
  const titles = { jobs: mgr ? 'Jobs' : 'My jobs', team: 'Team', whatsapp: 'WhatsApp', me: 'Account' };
  $('#top').innerHTML = '<span class="pvlogo"></span><div class="tt"><small>' + greeting() + ', ' + esc(S.me.name.split(' ')[0]) + '</small><h1>' + titles[S.tab] + '</h1></div>' +
    '<button class="avatar" data-a="tab" data-k="me" aria-label="Account">' + initial(S.me.name) + '</button>';
  const tab = (k, l, i) => '<button data-a="tab" data-k="' + k + '" class="' + (S.tab === k ? 'on' : '') + '"' + (S.tab === k ? ' aria-current="page"' : '') + '>' + ic(i) + '<span>' + l + '</span></button>';
  $('#tabs').innerHTML = mgr
    ? tab('jobs', 'Jobs', 'jobs') + tab('team', 'Team', 'team') + '<button class="fab" data-a="job-new" aria-label="New job">' + ic('plus') + '</button>' + tab('whatsapp', 'WhatsApp', 'chat') + tab('me', 'Account', 'user')
    : tab('jobs', 'My jobs', 'jobs') + tab('me', 'Account', 'user');
  if (S.tab === 'team' && mgr) renderTeam();
  else if (S.tab === 'whatsapp' && mgr) renderWhatsApp();
  else if (S.tab === 'me') renderMe();
  else renderJobs();
}
function renderMe() {
  $('#main').innerHTML = '<div class="card me"><span class="avatar big">' + initial(S.me.name) + '</span><b>' + esc(S.me.name) + '</b><span class="mut">' + esc(S.me.email) + '</span><br><span class="pill ' + (isMgr() ? 'in_progress' : 'open') + '" style="margin-top:10px">' + (isMgr() ? 'Manager' : 'Staff') + '</span></div>' +
    '<div class="card"><h2>Put it on your home screen</h2><p class="mut">Open your browser menu and choose "Add to Home screen" (Android) or Share, then "Add to Home Screen" (iPhone). Proview Jobs then opens like any other app.</p></div>' +
    '<button class="btn bad wide" data-a="signout">Sign out</button>' +
    '<p style="text-align:center;margin-top:16px"><a href="privacy.html" target="_blank" rel="noopener" class="mut">Privacy policy</a></p>';
}

const isOpen = (j) => j.status === 'open' || j.status === 'in_progress';
const FILTERS = {
  open: isOpen,
  unassigned: (j) => !j.assigned_to && isOpen(j),
  late: (j) => isLate(j),
  done: (j) => j.status === 'done',
  all: () => true,
};
const FLABEL = { open: 'Open jobs', unassigned: 'Unassigned', late: 'Overdue', done: 'Done', all: 'All jobs' };
function sortJobs(a, b) {
  const ao = isOpen(a), bo = isOpen(b);
  if (ao !== bo) return ao ? -1 : 1;
  if (!ao) return (b.completed_at || b.updated_at || '').localeCompare(a.completed_at || a.updated_at || '');
  const ad = a.due_date || '9999', bd = b.due_date || '9999';
  if (ad !== bd) return ad < bd ? -1 : 1;
  if (PRANK[a.priority] !== PRANK[b.priority]) return PRANK[a.priority] - PRANK[b.priority];
  return (b.created_at || '').localeCompare(a.created_at || '');
}
function bucket(j) {
  if (!j.due_date) return 'No date';
  const t = todayISO();
  if (j.due_date < t) return 'Overdue';
  if (j.due_date === t) return 'Today';
  const diff = Math.round((new Date(j.due_date + 'T12:00:00') - new Date(t + 'T12:00:00')) / 86400000);
  return diff === 1 ? 'Tomorrow' : diff <= 7 ? 'This week' : 'Later';
}
function jobCard(j) {
  const tasks = j.pj_job_tasks || [], done = tasks.filter((t) => t.done).length;
  const who = j.assigned_to ? (j.assigned_to === S.me.id ? 'You' : personName(j.assigned_to) || 'Someone') : '';
  const sub = [j.customer_name, j.address].filter(Boolean).join(' · ');
  return '<button class="job p-' + j.priority + ' s-' + j.status + '" data-a="open" data-id="' + j.id + '">' +
    '<span class="r1"><span class="ref">' + jref(j) + '</span>' +
    (j.priority !== 'normal' ? '<span class="pill ' + j.priority + '">' + PRIORITY[j.priority] + '</span>' : '') +
    '<span class="pill ' + j.status + '">' + STATUS[j.status] + '</span>' +
    (isMgr() && j.source === 'whatsapp' ? '<span class="pill wa">WhatsApp</span>' : '') + '</span>' +
    '<span class="t">' + esc(j.title) + '</span>' +
    (sub ? '<span class="m">' + esc(sub) + '</span>' : '') +
    '<span class="f">' +
    (isMgr() ? (who ? '<span><span class="avatar sm">' + initial(who) + '</span><b>' + esc(who) + '</b></span>' : (isOpen(j) ? '<span><span class="avatar sm none">?</span><b class="late" style="color:var(--warn)!important">Unassigned</b></span>' : '')) : '') +
    (j.due_date ? '<span class="' + (isLate(j) ? 'late' : '') + '">' + ic('cal') + '<b' + (isLate(j) ? ' class="late"' : '') + '>' + niceDate(j.due_date) + '</b></span>' : '') +
    (tasks.length ? '<span>' + ic('check') + '<b>' + done + '/' + tasks.length + '</b><span class="bar"><i style="width:' + Math.round(done / tasks.length * 100) + '%"></i></span></span>' : '') +
    '</span></button>';
}
function renderJobs() {
  const mgr = isMgr();
  const count = (k) => S.jobs.filter(FILTERS[k]).length;
  const tiles = mgr ? [['open', 'Open'], ['unassigned', 'Unassigned'], ['late', 'Overdue'], ['done', 'Done']] : [['open', 'To do'], ['late', 'Overdue'], ['done', 'Done']];
  if (S.filter !== 'all' && !tiles.some((c) => c[0] === S.filter)) S.filter = 'open';
  const term = S.q.trim().toLowerCase();
  let list = S.jobs.filter(FILTERS[S.filter]);
  if (term) list = list.filter((j) => [jref(j), j.title, j.customer_name, j.customer_phone, j.address, j.description, personName(j.assigned_to)].join(' ').toLowerCase().includes(term));
  list.sort(sortJobs);
  const empty = term ? ['Nothing matches', 'Try a different search.']
    : S.filter === 'open' ? (mgr ? ['No open jobs', 'Tap + to create one, or send a WhatsApp message that starts with Job.'] : ['Nothing to do right now', 'Jobs your manager assigns to you appear here.'])
    : ['Nothing here', ''];
  let body = '';
  if (!list.length) body = '<div class="empty">' + ic('jobs') + '<b>' + empty[0] + '</b>' + empty[1] + '</div>';
  else if (S.filter === 'done' || S.filter === 'all') body = '<div class="list">' + list.map(jobCard).join('') + '</div>';
  else {
    // grouped by when they are due, the way a to-do app shows a day
    const order = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'No date'];
    const groups = {};
    for (const j of list) (groups[bucket(j)] = groups[bucket(j)] || []).push(j);
    body = order.filter((g) => groups[g]).map((g) => '<div class="grp' + (g === 'Overdue' ? ' late' : '') + '">' + g + '<i>' + groups[g].length + '</i></div><div class="list">' + groups[g].map(jobCard).join('') + '</div>').join('');
  }
  const hadFocus = document.activeElement && document.activeElement.id === 'search';
  $('#main').innerHTML =
    '<div class="stats n' + tiles.length + '">' + tiles.map(([k, l]) => { const n = count(k); return '<button class="stat k-' + k + (S.filter === k ? ' on' : '') + (n ? '' : ' zero') + '" data-a="filter" data-k="' + k + '"' + (S.filter === k ? ' aria-pressed="true"' : '') + '><b>' + n + '</b><span>' + l + '</span></button>'; }).join('') + '</div>' +
    '<div class="lh"><h2>' + (mgr ? FLABEL[S.filter] : S.filter === 'open' ? 'To do' : FLABEL[S.filter]) + '<small class="mut">' + list.length + '</small></h2>' +
    (mgr ? '<button class="lnk" data-a="quick">' + ic('bolt') + 'Quick add</button>' : '') +
    '<button class="lnk" data-a="filter" data-k="' + (S.filter === 'all' ? 'open' : 'all') + '">' + (S.filter === 'all' ? 'Open only' : 'All') + '</button></div>' +
    (S.jobs.length > 3 || term ? '<input class="search" id="search" type="search" placeholder="Search jobs" value="' + esc(S.q) + '" aria-label="Search jobs">' : '') + body;
  if (hadFocus) { const s = $('#search'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
}

/* ---------- one job ---------- */
async function openJob(id, quiet) {
  try {
    const j = await loadJob(id);
    if (!j) { if (!quiet) toast('That job is no longer available', true); closeJob(); return; }
    const fresh = !S.job || S.job.id !== id;
    S.job = j;
    renderJob(fresh);
  } catch (e) { if (!quiet) toast(problem(e), true); }
}
function closeJob() { S.job = null; $('#pnl-root').innerHTML = ''; }
function renderJob(fresh) {
  const j = S.job; if (!j) return;
  const mgr = isMgr(), mine = j.assigned_to === S.me.id;
  const canWork = (mine || mgr) && j.status !== 'cancelled';
  const tasks = j.pj_job_tasks, parts = j.pj_job_parts, photos = j.pj_job_photos;
  const done = tasks.filter((t) => t.done).length;
  const keepNotes = $('#notes') && document.activeElement === $('#notes') ? $('#notes').value : null;
  const scroll = $('#pnl-root .pnl') ? $('#pnl-root .pnl').scrollTop : 0;
  const tel = (j.customer_phone.trim().startsWith('+') ? '+' : '') + digits(j.customer_phone);
  let acts = '';
  if (canWork) {
    if (j.status === 'open') acts += '<button class="btn pri" data-a="progress" data-k="in_progress">' + ic('play') + 'Start job</button>';
    if (j.status === 'open' || j.status === 'in_progress') acts += '<button class="btn ok" data-a="finish">' + ic('check') + 'Mark as done</button>';
    if (j.status === 'done') acts += '<button class="btn" data-a="progress" data-k="in_progress">Reopen job</button>';
  }
  const assignSel = mgr ? '<select class="in" id="assign" aria-label="Assigned to"><option value="">Unassigned</option>' +
    S.people.filter((p) => p.active || p.id === j.assigned_to).map((p) => '<option value="' + p.id + '"' + (p.id === j.assigned_to ? ' selected' : '') + '>' + esc(p.name) + (p.role === 'manager' ? ' (manager)' : '') + '</option>').join('') + '</select>' : '';
  const by = personName(j.created_by);
  $('#pnl-root').innerHTML = '<div class="pnl"' + (fresh ? '' : ' style="animation:none"') + '><div class="pnl-in">' +
    '<div class="pnl-hd"><button class="ibtn" data-a="back" aria-label="Back">' + ic('back') + '</button><span class="ref">' + jref(j) + '</span>' +
    (mgr ? '<button class="ibtn" data-a="job-edit" aria-label="Edit job">' + ic('edit') + '</button>' : '') + '</div>' +
    '<div class="r1"><span class="pill ' + j.status + '">' + STATUS[j.status] + '</span> ' +
    (j.priority !== 'normal' ? '<span class="pill ' + j.priority + '">' + PRIORITY[j.priority] + ' priority</span> ' : '') +
    (isLate(j) ? '<span class="pill urgent">Overdue</span>' : '') + '</div>' +
    '<h1>' + esc(j.title) + '</h1>' +
    (j.customer_phone || j.address ? '<div class="quick">' +
      (j.customer_phone ? '<a href="tel:' + esc(tel) + '">' + ic('phone') + 'Call</a>' : '') +
      (j.address ? '<a href="' + mapsLink(j.address) + '" target="_blank" rel="noopener">' + ic('pin') + 'Directions</a>' : '') + '</div>' : '') +
    '<div class="card"><dl class="kv">' +
    (mgr ? '<dt>Assigned to</dt><dd>' + assignSel + '</dd>' : '') +
    (j.customer_name || j.customer_phone ? '<dt>Customer</dt><dd>' + esc(j.customer_name) + (j.customer_phone ? (j.customer_name ? '<br>' : '') + '<span class="mut">' + esc(j.customer_phone) + '</span>' : '') + '</dd>' : '') +
    (j.address ? '<dt>Address</dt><dd>' + esc(j.address) + '</dd>' : '') +
    (j.due_date ? '<dt>Due</dt><dd class="' + (isLate(j) ? 'late' : '') + '">' + niceDate(j.due_date) + '</dd>' : '') +
    (j.description ? '<dt>Details</dt><dd class="pre">' + esc(j.description) + '</dd>' : '') +
    (mgr ? '<dt>Created</dt><dd>' + niceTime(j.created_at) + (by ? ' by ' + esc(by) : '') + (j.source === 'whatsapp' ? ' on WhatsApp' : '') + '</dd>' : '') +
    (j.completed_at ? '<dt>Finished</dt><dd>' + niceTime(j.completed_at) + '</dd>' : '') +
    (mgr ? '<dt>Status</dt><dd><select class="in" id="status" aria-label="Status">' + Object.keys(STATUS).map((k) => '<option value="' + k + '"' + (k === j.status ? ' selected' : '') + '>' + STATUS[k] + '</option>').join('') + '</select></dd>' : '') +
    '</dl></div>' +
    (tasks.length ? '<div class="card"><h2>Tasks <small class="mut">' + done + ' of ' + tasks.length + ' done</small></h2><div class="prog"><i style="width:' + Math.round(done / tasks.length * 100) + '%"></i></div>' +
      tasks.map((t) => '<label class="ck"><input type="checkbox" data-c="task" data-id="' + t.id + '"' + (t.done ? ' checked' : '') + (canWork ? '' : ' disabled') + '><span>' + esc(t.title) + '</span></label>').join('') + '</div>' : '') +
    (parts.length ? '<div class="card"><h2>Parts needed <small class="mut">tick when fitted or used</small></h2>' +
      parts.map((p) => '<label class="ck"><input type="checkbox" data-c="part" data-id="' + p.id + '"' + (p.used ? ' checked' : '') + (canWork ? '' : ' disabled') + '><span>' + esc(p.name) + '</span><b class="q">× ' + (+p.qty) + '</b></label>').join('') + '</div>' : '') +
    '<div class="card"><h2>Completion notes</h2>' +
    (canWork ? '<label class="fld"><textarea id="notes" placeholder="What was done, anything to follow up" aria-label="Completion notes">' + esc(keepNotes != null ? keepNotes : j.completion_notes) + '</textarea></label><button class="btn sm" data-a="notes-save">Save notes</button>'
      : '<p class="pre">' + (esc(j.completion_notes) || '<span class="mut">None yet</span>') + '</p>') + '</div>' +
    '<div class="card"><h2>Photos <small class="mut">' + (photos.length || '') + '</small></h2>' +
    (photos.length ? '<div class="photos">' + photos.map((p) => '<a href="' + esc(p.url || '#') + '" target="_blank" rel="noopener">' + (p.url ? '<img src="' + esc(p.url) + '" alt="Job photo" loading="lazy">' : '') +
      (mgr || p.uploaded_by === S.me.id ? '<button class="rm" data-a="photo-rm" data-id="' + p.id + '" aria-label="Remove photo">×</button>' : '') + '</a>').join('') + '</div>' : '') +
    (canWork ? '<label class="btn sm">Add photos<input type="file" id="photo-in" accept="image/*" multiple hidden></label>' : (photos.length ? '' : '<p class="mut">None yet</p>')) + '</div>' +
    (mgr ? '<div class="acts"><button class="btn bad" data-a="job-del">Delete job</button></div>' : '') +
    '</div>' + (acts ? '<div class="pnl-bar">' + acts + '</div>' : '') + '</div>';
  $('#pnl-root .pnl').scrollTop = scroll;
}

async function jobProgress(status, notes) {
  const j = S.job; if (!j) return;
  try {
    await q(S.sb.rpc('pj_job_progress', { p_job: j.id, p_status: status, p_notes: notes == null ? null : notes }));
    toast(status === 'done' ? 'Job marked as done' : status === 'in_progress' ? 'Job started' : 'Saved');
    await refresh(j.id);
  } catch (e) { toast(problem(e), true); }
}
function finishJob() {
  const j = S.job; if (!j) return;
  const left = j.pj_job_tasks.filter((t) => !t.done).length;
  const notes = $('#notes') ? $('#notes').value : j.completion_notes;
  modal('<h2>Mark ' + jref(j) + ' as done?</h2>' +
    (left ? '<div class="err">' + left + (left === 1 ? ' task is' : ' tasks are') + ' not ticked yet.</div>' : '') +
    '<label class="fld">Completion notes<textarea id="fin-notes" autofocus placeholder="What was done, anything to follow up">' + esc(notes) + '</textarea></label>' +
    '<div class="foot"><button class="btn" data-a="mdl-close">Not yet</button><button class="btn ok" data-a="finish-yes">Mark as done</button></div>');
}
async function toggleCheck(el) {
  const j = S.job; if (!j) return;
  const isTask = el.dataset.c === 'task';
  try {
    if (isTask) await q(S.sb.rpc('pj_task_done', { p_task: el.dataset.id, p_done: el.checked }));
    else await q(S.sb.rpc('pj_part_used', { p_part: el.dataset.id, p_used: el.checked }));
    const row = (isTask ? j.pj_job_tasks : j.pj_job_parts).find((x) => x.id === el.dataset.id);
    if (row) row[isTask ? 'done' : 'used'] = el.checked;
    renderJob();
    loadJobs().then(() => { if (S.tab === 'jobs') renderJobs(); }).catch(() => {});
  } catch (e) { el.checked = !el.checked; toast(problem(e), true); }
}
async function addPhotos(files) {
  const j = S.job; if (!j || !files.length) return;
  toast('Uploading ' + files.length + (files.length === 1 ? ' photo' : ' photos'));
  let okCount = 0;
  for (const file of files) {
    try {
      const blob = await shrink(file);
      const type = blob.type || 'image/jpeg';
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      const path = j.id + '/' + uuid() + '.' + ext;
      const up = await S.sb.storage.from('job-photos').upload(path, blob, { contentType: type, upsert: false });
      if (up.error) throw up.error;
      await q(S.sb.from('pj_job_photos').insert({ job_id: j.id, path, uploaded_by: S.me.id }));
      okCount++;
    } catch (e) { toast('A photo could not be added: ' + problem(e), true); }
  }
  if (okCount) { toast(okCount + (okCount === 1 ? ' photo added' : ' photos added')); await openJob(j.id, true); }
}
async function removePhoto(id) {
  const j = S.job; if (!j) return;
  const p = j.pj_job_photos.find((x) => x.id === id); if (!p) return;
  try {
    await q(S.sb.from('pj_job_photos').delete().eq('id', id));
    if (isMgr()) await S.sb.storage.from('job-photos').remove([p.path]);
    await openJob(j.id, true);
  } catch (e) { toast(problem(e), true); }
}
async function managerSet(patch, msg) {
  const j = S.job; if (!j) return;
  try {
    await q(S.sb.from('pj_jobs').update(patch).eq('id', j.id));
    toast(msg);
    await refresh(j.id);
  } catch (e) { toast(problem(e), true); await openJob(j.id, true); }
}
async function refresh(openId) {
  await loadJobs();
  if (S.tab === 'jobs') renderJobs();
  if (openId && S.job && S.job.id === openId) await openJob(openId, true);
}
