/* Manager pages: the job form, quick add, the team and WhatsApp. */
const EXAMPLE = 'Job: Install 4 cameras at Al Noor Cafe\nCustomer: Ahmed 050 123 4567\nAddress: Shop 3, Al Wasl Road\nDue: tomorrow\nPriority: urgent\nAssign: Ravi\nTasks: mount cameras, run cable, set up recorder\nParts: 4x dome camera, 1 recorder';

function taskRow(t) { return '<div class="rw" data-id="' + esc(t.id || '') + '"><input class="in" data-k="title" value="' + esc(t.title || '') + '" placeholder="Task" aria-label="Task"><button type="button" class="x" data-a="row-rm" aria-label="Remove task">×</button></div>'; }
function partRow(p) { return '<div class="rw" data-id="' + esc(p.id || '') + '"><input class="in qty" data-k="qty" type="number" inputmode="decimal" min="0" step="any" value="' + esc(p.qty == null ? 1 : +p.qty) + '" aria-label="Quantity"><input class="in" data-k="name" value="' + esc(p.name || '') + '" placeholder="Part" aria-label="Part"><button type="button" class="x" data-a="row-rm" aria-label="Remove part">×</button></div>'; }

function jobForm(j) {
  j = j || {};
  const opt = (v, l, cur) => '<option value="' + v + '"' + (v === cur ? ' selected' : '') + '>' + l + '</option>';
  modal('<form id="job-form" novalidate data-id="' + esc(j.id || '') + '"><h2>' + (j.id ? 'Edit ' + jref(j) : 'New job') + '</h2><div id="form-err"></div>' +
    '<label class="fld">What is the job?<input name="title" required maxlength="200" value="' + esc(j.title || '') + '"' + (j.id ? '' : ' autofocus') + '></label>' +
    '<div class="two"><label class="fld">Assign to<select name="assigned_to"><option value="">Unassigned</option>' +
    S.people.filter((p) => p.active || p.id === j.assigned_to).map((p) => opt(p.id, esc(p.name) + (p.role === 'manager' ? ' (manager)' : ''), j.assigned_to)).join('') + '</select></label>' +
    '<label class="fld">Priority<select name="priority">' + Object.keys(PRIORITY).map((k) => opt(k, PRIORITY[k], j.priority || 'normal')).join('') + '</select></label></div>' +
    '<div class="two"><label class="fld">Due date<input name="due_date" type="date" value="' + esc(j.due_date || '') + '"></label>' +
    '<label class="fld">Customer name<input name="customer_name" value="' + esc(j.customer_name || '') + '" autocomplete="off"></label></div>' +
    '<div class="two"><label class="fld">Customer phone<input name="customer_phone" type="tel" value="' + esc(j.customer_phone || '') + '" autocomplete="off"></label>' +
    '<label class="fld">Address<input name="address" value="' + esc(j.address || '') + '" autocomplete="off"></label></div>' +
    '<label class="fld">Details<textarea name="description">' + esc(j.description || '') + '</textarea></label>' +
    '<div class="sect">Tasks to complete</div><div class="rows" id="task-rows">' + (j.pj_job_tasks || []).map(taskRow).join('') + '</div><button type="button" class="btn sm" data-a="row-add" data-k="task">Add a task</button>' +
    '<div class="sect">Parts required</div><div class="rows" id="part-rows">' + (j.pj_job_parts || []).map(partRow).join('') + '</div><button type="button" class="btn sm" data-a="row-add" data-k="part">Add a part</button>' +
    '<div class="foot"><button type="button" class="btn" data-a="mdl-close">Cancel</button><button class="btn pri" type="submit">' + (j.id ? 'Save changes' : 'Create job') + '</button></div></form>');
}
function addRow(kind, focus) {
  const box = $(kind === 'task' ? '#task-rows' : '#part-rows');
  box.insertAdjacentHTML('beforeend', kind === 'task' ? taskRow({}) : partRow({}));
  if (focus !== false) $('.rw:last-child [data-k="' + (kind === 'task' ? 'title' : 'name') + '"]', box).focus();
}
async function saveJob(form) {
  const v = Object.fromEntries(new FormData(form).entries());
  const err = (m) => { $('#form-err').innerHTML = '<div class="err">' + esc(m) + '</div>'; $('.mdl-box').scrollTop = 0; };
  if (!String(v.title || '').trim()) return err('Say what the job is.');
  const p = {
    id: form.dataset.id || null, title: v.title, description: v.description, customer_name: v.customer_name.trim(), customer_phone: v.customer_phone.trim(),
    address: v.address.trim(), due_date: v.due_date || null, priority: v.priority, assigned_to: v.assigned_to || null,
    tasks: $$('#task-rows .rw').map((r) => ({ id: r.dataset.id || null, title: $('[data-k="title"]', r).value.trim() })).filter((t) => t.title),
    parts: $$('#part-rows .rw').map((r) => ({ id: r.dataset.id || null, name: $('[data-k="name"]', r).value.trim(), qty: +$('[data-k="qty"]', r).value > 0 ? +$('[data-k="qty"]', r).value : 1 })).filter((t) => t.name),
  };
  const btn = $('[type=submit]', form); busy(btn, true);
  try {
    const before = p.id && S.job && S.job.id === p.id ? S.job.assigned_to : null;
    const id = await q(S.sb.rpc('pj_job_save', { p }));
    if (!p.id) sendNotices(id, false);
    else if (p.assigned_to && p.assigned_to !== before) sendNotices(id, true);
    closeModal();
    toast(p.id ? 'Job saved' : 'Job created');
    await loadJobs(); if (S.tab === 'jobs') renderJobs();
    if (S.job && S.job.id === id) await openJob(id, true);
  } catch (e) { err(problem(e)); } finally { busy(btn, false); }
}

function quickForm() {
  modal('<form id="quick-form" novalidate><h2>Quick add</h2><p class="mut">Type or paste a job the same way you would on WhatsApp. Only the first line is needed.</p><div id="form-err"></div>' +
    '<label class="fld"><textarea name="text" rows="9" autofocus aria-label="Job text" placeholder="' + esc(EXAMPLE.replace(/^Job: /, '')) + '"></textarea></label>' +
    '<div class="foot"><button type="button" class="btn" data-a="mdl-close">Cancel</button><button class="btn pri" type="submit">Create job</button></div></form>');
}
async function saveQuick(form) {
  const text = $('textarea', form).value.trim();
  const err = (m) => { $('#form-err').innerHTML = '<div class="err">' + esc(m) + '</div>'; };
  if (!text) return err('Type the job first.');
  const btn = $('[type=submit]', form); busy(btn, true);
  try {
    const { data, error } = await S.sb.functions.invoke('whatsapp-webhook', { body: { text }, headers: { 'x-pj-quick': '1' } });
    let out = data;
    if (error) { try { out = await error.context.json(); } catch (_) { out = null; } if (!out) throw error; }
    if (!out || !out.ok) return err((out && out.error) || 'That could not be turned into a job.');
    closeModal();
    toast('Job J-' + String(out.ref).padStart(4, '0') + ' created' + (out.assign_unmatched ? ', not assigned: no single match for "' + out.assign_asked + '"' : ''));
    await loadJobs(); if (S.tab === 'jobs') renderJobs();
  } catch (e) { err(problem(e)); } finally { busy(btn, false); }
}

/* ---------- team ---------- */
function renderTeam() {
  const row = (p) => '<button class="person" data-a="person" data-id="' + p.id + '"><span class="avatar">' + initial(p.name) + '</span>' +
    '<span class="nm"><b>' + esc(p.name) + (p.id === S.me.id ? ' (you)' : '') + '</b><small>' + esc(p.email) + (p.phone ? ' · +' + esc(p.phone) : '') + '</small></span>' +
    '<span class="pill ' + (p.role === 'manager' ? 'in_progress' : 'open') + '">' + (p.role === 'manager' ? 'Manager' : 'Staff') + '</span>' +
    (!p.active ? '<span class="pill cancelled">Off</span>' : !p.user_id ? '<span class="pill high">Not signed up</span>' : '') + '</button>';
  $('#main').innerHTML = '<div class="lh"><h2>People<small class="mut">' + S.people.length + '</small></h2><button class="lnk" data-a="person-new">' + ic('plus') + 'Add person</button></div>' +
    '<div class="note">Add each person with their email. They then open this app, choose "First time? Create your account" and use that same email. Staff see only the jobs assigned to them.</div>' +
    '<div class="list">' + S.people.map(row).join('') + '</div>';
}
function personForm(p) {
  p = p || {};
  const me = p.id === S.me.id;
  modal('<form id="person-form" novalidate data-id="' + esc(p.id || '') + '"><h2>' + (p.id ? 'Edit ' + esc(p.name) : 'Add person') + '</h2><div id="form-err"></div>' +
    '<label class="fld">Name<input name="name" required value="' + esc(p.name || '') + '"' + (p.id ? '' : ' autofocus') + '></label>' +
    '<label class="fld">Email (their sign-in)<input name="email" type="email" required value="' + esc(p.email || '') + '"' + (p.user_id ? ' readonly' : '') + ' autocomplete="off"></label>' +
    '<div class="two"><label class="fld">Role<select name="role"' + (me ? ' disabled' : '') + '><option value="staff"' + (p.role !== 'manager' ? ' selected' : '') + '>Staff: sees own jobs</option><option value="manager"' + (p.role === 'manager' ? ' selected' : '') + '>Manager: creates and assigns</option></select></label>' +
    '<label class="fld">WhatsApp number, with country code<input name="phone" type="tel" inputmode="tel" placeholder="971501234567" value="' + esc(p.phone || '') + '" autocomplete="off"></label></div>' +
    '<p class="mut">The WhatsApp number is how the app knows a job message came from a manager.</p>' +
    (p.id && !me ? '<label class="ck"><input type="checkbox" name="active"' + (p.active ? ' checked' : '') + '><span>Can sign in and be given jobs</span></label>' : '') +
    '<div class="foot">' + (p.id && !me ? '<button type="button" class="btn bad sp" data-a="person-del" data-id="' + p.id + '">Remove</button>' : '') +
    '<button type="button" class="btn" data-a="mdl-close">Cancel</button><button class="btn pri" type="submit">' + (p.id ? 'Save' : 'Add') + '</button></div></form>');
}
async function savePerson(form) {
  const v = Object.fromEntries(new FormData(form).entries());
  const id = form.dataset.id || null, me = id === S.me.id;
  const err = (m) => { $('#form-err').innerHTML = '<div class="err">' + esc(m) + '</div>'; };
  const name = String(v.name || '').trim(), email = String(v.email || '').trim().toLowerCase(), phone = digits(v.phone);
  if (!name) return err('Enter their name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return err('Enter a valid email.');
  if (phone && (phone.length < 7 || phone.length > 15)) return err('Enter the WhatsApp number in full with the country code, for example 971501234567.');
  if (phone && phone.startsWith('0')) return err('Start the WhatsApp number with the country code, not 0. For example 971501234567 or 447700900123.');
  const row = { name, email, phone: phone || null };
  if (!me) { row.role = v.role === 'manager' ? 'manager' : 'staff'; if (id) row.active = !!v.active; }
  const btn = $('[type=submit]', form); busy(btn, true);
  try {
    if (id) await q(S.sb.from('pj_people').update(row).eq('id', id));
    else await q(S.sb.from('pj_people').insert(row));
    closeModal(); toast(id ? 'Saved' : name + ' added');
    await loadPeople(); if (me) S.me = person(S.me.id) || S.me;
    render();
  } catch (e) { err(/duplicate|unique/i.test(problem(e)) ? 'Someone with that email is already on the team.' : problem(e)); } finally { busy(btn, false); }
}

/* ---------- WhatsApp ---------- */
function renderWhatsApp() {
  const hook = S.cfg.url + '/functions/v1/whatsapp-webhook';
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch (_) { zones = []; }
  if (!zones.includes(S.settings.timezone)) zones.unshift(S.settings.timezone);
  $('#main').innerHTML = '' +
    '<div class="card"><h2>How to write a job</h2><p>Send a message to the business WhatsApp number that starts with the word <b>Job</b>. Only the first line is needed; add any of the other lines you want. Ordinary chat is ignored.</p>' +
    '<pre class="code" id="example">' + esc(EXAMPLE) + '</pre><button class="btn sm" data-a="copy" data-t="example">Copy example</button></div>' +
    '<div class="card"><h2>Numbers <small class="mut">who can create jobs, and who is sent them</small></h2><div id="wa-numbers">' + waNumbers() + '</div>' +
    '<button class="btn sm" data-a="number-new">' + ic('plus') + 'Add a number</button>' +
    '<p class="mut" style="margin-top:10px">Managers can also create jobs from the WhatsApp number on their profile. Whoever a job is assigned to is sent it on the number on their profile.</p></div>' +
    '<div class="card"><h2>Dates</h2><label class="fld">"Today" and "tomorrow" in messages use this time zone<select id="tz">' + zones.map((z) => '<option' + (z === S.settings.timezone ? ' selected' : '') + '>' + esc(z) + '</option>').join('') + '</select></label></div>' +
    '<div class="card"><h2>Connection</h2><p>In your Meta app, under WhatsApp, Configuration, set this as the Callback URL, enter your verify phrase, and subscribe to <b>messages</b>.</p>' +
    '<div class="copy"><code id="hook">' + esc(hook) + '</code><button class="btn sm" data-a="copy" data-t="hook">Copy</button></div></div>' +
    '<div class="card"><h2>Recent job messages</h2><div id="wa-log">' + waLog() + '</div></div>';
  loadWa().then(() => { const el = $('#wa-log'); if (el) el.innerHTML = waLog(); }).catch(() => {});
  loadNumbers().then(() => { const el = $('#wa-numbers'); if (el) el.innerHTML = waNumbers(); }).catch(() => {});
}
function waLog() {
  if (!S.wa.length) return '<p class="mut">Nothing yet. Job messages show here with what happened to them.</p>';
  return S.wa.map((w) => '<div class="log"><div class="h"><b>' + esc(w.result || 'Received') + '</b><span>' + niceTime(w.created_at) + '</span><span>' + (w.source === 'quick' ? 'Quick add' : w.from_phone ? '+' + esc(w.from_phone) : '') + '</span></div><div class="pre mut">' + esc(String(w.body || '').slice(0, 300)) + '</div></div>').join('');
}
function waNumbers() {
  if (!S.numbers.length) return '<p class="mut">No numbers yet.</p>';
  return S.numbers.map((n) => '<button class="person" data-a="number" data-id="' + esc(n.phone) + '" style="margin-bottom:8px"><span class="avatar' + (n.can_create || n.notify ? '' : ' none') + '">' + ic('chat') + '</span>' +
    '<span class="nm"><b>+' + esc(n.phone) + '</b><small>' + esc(n.label || 'No name') + '</small></span>' +
    (n.can_create ? '<span class="pill in_progress">Creates</span>' : '') + (n.notify ? '<span class="pill done">Receives</span>' : '') + (!n.can_create && !n.notify ? '<span class="pill cancelled">Off</span>' : '') + '</button>').join('');
}
function numberForm(n) {
  const isNew = !n; n = n || { can_create: true, notify: true };
  modal('<form id="number-form" novalidate data-id="' + esc(n.phone || '') + '"><h2>' + (isNew ? 'Add a number' : '+' + esc(n.phone)) + '</h2><div id="form-err"></div>' +
    (isNew ? '<label class="fld">WhatsApp number, with country code<input name="phone" type="tel" inputmode="tel" placeholder="447700900123" autofocus autocomplete="off"></label>' : '') +
    '<label class="fld">Name for this number<input name="label" value="' + esc(n.label || '') + '" placeholder="Office line" autocomplete="off"></label>' +
    '<label class="ck"><input type="checkbox" name="can_create"' + (n.can_create ? ' checked' : '') + '><span>Can create jobs by sending a message that starts with Job</span></label>' +
    '<label class="ck"><input type="checkbox" name="notify"' + (n.notify ? ' checked' : '') + '><span>Is sent every new job on WhatsApp</span></label>' +
    '<div class="foot">' + (isNew ? '' : '<button type="button" class="btn bad sp" data-a="number-del" data-id="' + esc(n.phone) + '">Remove</button>') +
    '<button type="button" class="btn" data-a="mdl-close">Cancel</button><button class="btn pri" type="submit">' + (isNew ? 'Add' : 'Save') + '</button></div></form>');
}
async function saveNumber(form) {
  const v = Object.fromEntries(new FormData(form).entries());
  const id = form.dataset.id || null;
  const err = (m) => { $('#form-err').innerHTML = '<div class="err">' + esc(m) + '</div>'; };
  const row = { label: String(v.label || '').trim(), can_create: !!v.can_create, notify: !!v.notify };
  if (!id) {
    const phone = digits(v.phone);
    if (phone.length < 7 || phone.length > 15) return err('Enter the number in full with the country code, for example 447700900123.');
    if (phone.startsWith('0')) return err('Start with the country code, not 0. For a UK number, replace the first 0 with 44.');
    row.phone = phone;
  }
  const btn = $('[type=submit]', form); busy(btn, true);
  try {
    if (id) await q(S.sb.from('pj_wa_numbers').update(row).eq('phone', id));
    else await q(S.sb.from('pj_wa_numbers').insert(row));
    closeModal(); toast('Saved'); await loadNumbers(); if (S.tab === 'whatsapp') renderWhatsApp();
  } catch (e) { err(/duplicate|unique/i.test(problem(e)) ? 'That number is already on the list.' : problem(e)); } finally { busy(btn, false); }
}
