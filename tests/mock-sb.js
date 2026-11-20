// A stand-in for the Supabase client so the screens can be exercised with no network.
(function () {
  const role = new URLSearchParams(location.search).get('as') || 'manager';
  const id = (n) => '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
  const now = () => new Date().toISOString();
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
  const db = {
    pj_people: [
      { id: id(1), user_id: 'u1', email: 'boss@proview.test', name: 'Sunny', role: 'manager', phone: '971500000001', active: true },
      { id: id(2), user_id: 'u2', email: 'ravi@proview.test', name: 'Ravi Kumar', role: 'staff', phone: null, active: true },
      { id: id(3), user_id: null, email: 'sara@proview.test', name: 'Sara Ali', role: 'staff', phone: null, active: true },
    ],
    pj_settings: [{ id: true, timezone: 'Asia/Dubai', business_name: 'Proview Tech' }],
    pj_jobs: [
      { id: id(101), ref: 1, title: 'Install 4 cameras at Al Noor Cafe', description: 'Bring the tall ladder', customer_name: 'Ahmed', customer_phone: '+971 50 123 4567', address: 'Shop 3, Al Wasl Road', due_date: day(1), priority: 'urgent', status: 'open', assigned_to: id(2), created_by: id(1), source: 'whatsapp', completion_notes: '', created_at: now(), updated_at: now() },
      { id: id(102), ref: 2, title: 'Replace receipt printer', description: '', customer_name: 'Bella Cafe', customer_phone: '', address: '', due_date: day(-2), priority: 'normal', status: 'in_progress', assigned_to: id(2), created_by: id(1), source: 'app', completion_notes: '', created_at: now(), updated_at: now() },
      { id: id(103), ref: 3, title: 'Quote for new till system', description: '', customer_name: '', customer_phone: '', address: '', due_date: null, priority: 'low', status: 'open', assigned_to: null, created_by: id(1), source: 'app', completion_notes: '', created_at: now(), updated_at: now() },
      { id: id(104), ref: 4, title: 'Router swap', description: '', customer_name: 'Mrs Khan', customer_phone: '', address: '', due_date: day(-5), priority: 'normal', status: 'done', assigned_to: id(3), created_by: id(1), source: 'app', completion_notes: 'Swapped, tested', completed_at: now(), created_at: now(), updated_at: now() },
    ],
    pj_job_tasks: [
      { id: id(201), job_id: id(101), title: 'Mount cameras', done: true, sort: 1 }, { id: id(202), job_id: id(101), title: 'Run cable', done: false, sort: 2 }, { id: id(203), job_id: id(101), title: 'Set up recorder', done: false, sort: 3 },
    ],
    pj_job_parts: [{ id: id(301), job_id: id(101), name: 'Dome camera', qty: 4, used: false, sort: 1 }, { id: id(302), job_id: id(101), name: 'Recorder', qty: 1, used: false, sort: 2 }],
    pj_job_photos: [],
    pj_wa_numbers: [{ phone: '447377472402', label: 'WhatsApp Business', can_create: true, notify: true, created_at: '1' }, { phone: '442089355495', label: 'Office line', can_create: true, notify: true, created_at: '2' }],
    pj_wa_log: [{ id: id(401), wa_id: 'w1', from_phone: '971500000001', body: 'Job: Install 4 cameras at Al Noor Cafe\nDue: tomorrow', source: 'whatsapp', result: 'Created J-0001', created_at: now() }],
  };
  let seq = 500, session = new URLSearchParams(location.search).get('out') ? null : {};
  const me = () => db.pj_people.find((p) => p.role === role && p.user_id);
  const visible = (t) => {
    if (role === 'manager') return db[t];
    if (t === 'pj_jobs') return db.pj_jobs.filter((j) => j.assigned_to === me().id);
    if (t === 'pj_people') return db.pj_people.filter((p) => p.id === me().id);
    if (t === 'pj_wa_log' || t === 'pj_wa_numbers') return [];
    if (t === 'pj_settings') return db[t];
    const mine = new Set(visible('pj_jobs').map((j) => j.id));
    return db[t].filter((r) => mine.has(r.job_id));
  };
  function from(t) {
    const st = { op: 'select', sel: '*', eq: [], single: false, row: null };
    const b = {
      select(s) { st.sel = s || '*'; return b; }, order() { return b; }, limit() { return b; },
      eq(k, v) { st.eq.push([k, v]); return b; }, maybeSingle() { st.single = true; return b; },
      insert(r) { st.op = 'insert'; st.row = r; return b; }, update(r) { st.op = 'update'; st.row = r; return b; }, delete() { st.op = 'delete'; return b; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    function run() {
      const match = (r) => st.eq.every(([k, v]) => r[k] === v);
      if (st.op === 'insert') { if (role !== 'manager' && t !== 'pj_job_photos') return { data: null, error: { message: 'row-level security' } }; db[t].push({ id: id(++seq), created_at: now(), active: true, ...st.row }); return { data: null, error: null }; }
      if (st.op === 'update') { if (role !== 'manager') return { data: null, error: { message: 'row-level security' } }; db[t].filter(match).forEach((r) => Object.assign(r, st.row)); return { data: null, error: null }; }
      if (st.op === 'delete') { db[t] = db[t].filter((r) => !match(r)); if (t === 'pj_jobs') for (const c of ['pj_job_tasks', 'pj_job_parts', 'pj_job_photos']) db[c] = db[c].filter((r) => db.pj_jobs.some((j) => j.id === r.job_id)); return { data: null, error: null }; }
      let rows = visible(t).filter(match).map((r) => ({ ...r }));
      if (t === 'pj_jobs') for (const c of ['pj_job_tasks', 'pj_job_parts', 'pj_job_photos']) if (st.sel.includes(c)) rows.forEach((j) => { j[c] = db[c].filter((x) => x.job_id === j.id).map((x) => ({ ...x })); });
      return { data: st.single ? rows[0] || null : rows, error: null };
    }
    return b;
  }
  const rpcs = {
    pj_claim: () => ({ ...me() }),
    pj_job_save: ({ p }) => {
      let j = p.id && db.pj_jobs.find((x) => x.id === p.id);
      const f = { title: p.title.trim(), description: p.description || '', customer_name: p.customer_name || '', customer_phone: p.customer_phone || '', address: p.address || '', due_date: p.due_date || null, priority: p.priority || 'normal', assigned_to: p.assigned_to || null };
      if (j) Object.assign(j, f); else { j = { id: id(++seq), ref: db.pj_jobs.length + 1, status: 'open', created_by: me().id, source: 'app', completion_notes: '', created_at: now(), updated_at: now(), ...f }; db.pj_jobs.push(j); }
      const keep = (t, list, map) => { const ids = new Set(list.filter((x) => x.id).map((x) => x.id)); db[t] = db[t].filter((r) => r.job_id !== j.id || ids.has(r.id)); list.forEach((x, i) => { const r = x.id && db[t].find((y) => y.id === x.id); if (r) Object.assign(r, map(x), { sort: i + 1 }); else db[t].push({ id: id(++seq), job_id: j.id, sort: i + 1, ...map(x) }); }); };
      keep('pj_job_tasks', p.tasks, (x) => ({ title: x.title, ...(x.id ? {} : { done: false }) }));
      keep('pj_job_parts', p.parts, (x) => ({ name: x.name, qty: x.qty, ...(x.id ? {} : { used: false }) }));
      return j.id;
    },
    pj_job_progress: ({ p_job, p_status, p_notes }) => { const j = visible('pj_jobs').find((x) => x.id === p_job); if (!j) throw { message: 'This job is not assigned to you' }; j.status = p_status; if (p_notes != null) j.completion_notes = p_notes; j.completed_at = p_status === 'done' ? now() : null; return null; },
    pj_task_done: ({ p_task, p_done }) => { db.pj_job_tasks.find((x) => x.id === p_task).done = p_done; return null; },
    pj_part_used: ({ p_part, p_used }) => { db.pj_job_parts.find((x) => x.id === p_part).used = p_used; return null; },
  };
  window.__PJ_DB__ = db;
  window.__PJ_SB__ = {
    auth: {
      getSession: async () => ({ data: { session } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signInWithPassword: async ({ password }) => { if (password !== 'right-password') return { error: { message: 'Invalid login credentials' } }; session = {}; return { data: {}, error: null }; },
      signUp: async () => ({ data: { user: { identities: [{}] }, session: null }, error: null }), signOut: async () => { session = null; return {}; },
      getUser: async () => ({ data: { user: { email: me().email } } }), resetPasswordForEmail: async () => ({ error: null }), updateUser: async () => ({ error: null }),
    },
    from,
    rpc: (name, args) => ({ then(res, rej) { let out; try { out = { data: rpcs[name](args || {}), error: null }; } catch (e) { out = { data: null, error: e }; } return Promise.resolve(out).then(res, rej); } }),
    storage: { from: () => ({ createSignedUrls: async (paths) => ({ data: paths.map(() => ({ signedUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2240%22 height=%2240%22%3E%3Crect width=%2240%22 height=%2240%22 fill=%22%2388a%22/%3E%3C/svg%3E' })) }), upload: async () => ({ error: null }), remove: async () => ({}) }) },
    functions: { invoke: async (_n, { body, headers }) => { if (headers['x-pj-notify']) { (window.__PJ_NOTIFY__ = window.__PJ_NOTIFY__ || []).push(body); return { data: { ok: true, sent: 0, connected: false }, error: null }; } const title = body.text.split('\n')[0]; const j = { id: id(++seq), ref: db.pj_jobs.length + 1, title, description: '', customer_name: '', customer_phone: '', address: '', due_date: null, priority: 'normal', status: 'open', assigned_to: null, created_by: me().id, source: 'app', completion_notes: '', created_at: now(), updated_at: now() }; db.pj_jobs.push(j); return { data: { ok: true, ref: j.ref }, error: null }; } },
    channel: () => { const c = { on: () => c, subscribe: () => c }; return c; }, removeChannel() {},
  };
})();
