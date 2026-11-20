/* Clicks, live updates and start-up. */
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-a]'); if (!el) return;
  const a = el.dataset.a;
  if (a === 'mdl-bg') { if (ev.target === el) closeModal(); return; }
  if (a === 'photo-rm') { ev.preventDefault(); ev.stopPropagation(); const id = el.dataset.id; return confirmBox('Remove this photo?', 'It will be removed from the job.', 'Remove', () => removePhoto(id), true); }
  if (a === 'auth') return authScreen(el.dataset.k);
  if (a === 'retry') return enter();
  if (a === 'reload') return location.reload();
  if (a === 'signout') return signOut();
  if (a === 'tab') { S.tab = el.dataset.k; closeJob(); return render(); }
  if (a === 'filter') { S.filter = el.dataset.k; return renderJobs(); }
  if (a === 'open') return openJob(el.dataset.id);
  if (a === 'back') return closeJob();
  if (a === 'mdl-close') return closeModal();
  if (a === 'confirm-yes') { const fn = S.confirm; closeModal(); return fn && fn(); }
  if (a === 'progress') return jobProgress(el.dataset.k, $('#notes') ? $('#notes').value : null);
  if (a === 'finish') return finishJob();
  if (a === 'finish-yes') { const n = $('#fin-notes').value; closeModal(); return jobProgress('done', n); }
  if (a === 'notes-save') return jobProgress(S.job.status, $('#notes').value);
  if (a === 'copy') return copyText($('#' + el.dataset.t).textContent);
  if (!isMgr()) return;
  if (a === 'job-new') return jobForm();
  if (a === 'job-edit') return jobForm(S.job);
  if (a === 'quick') return quickForm();
  if (a === 'row-add') return addRow(el.dataset.k);
  if (a === 'row-rm') return el.closest('.rw').remove();
  if (a === 'job-del') { const j = S.job; return confirmBox('Delete ' + jref(j) + '?', 'The job, its tasks, parts and photos will be removed for good.', 'Delete job', async () => {
    try {
      const paths = j.pj_job_photos.map((p) => p.path);
      await q(S.sb.from('pj_jobs').delete().eq('id', j.id));
      if (paths.length) await S.sb.storage.from('job-photos').remove(paths);
      closeJob(); toast('Job deleted'); await refresh();
    } catch (e) { toast(problem(e), true); }
  }, true); }
  if (a === 'number-new') return numberForm();
  if (a === 'number') return numberForm(S.numbers.find((n) => n.phone === el.dataset.id));
  if (a === 'number-del') { const ph = el.dataset.id; return confirmBox('Remove +' + ph + '?', 'It will no longer be able to create jobs or be sent them.', 'Remove', async () => {
    try { await q(S.sb.from('pj_wa_numbers').delete().eq('phone', ph)); toast('Removed'); await loadNumbers(); if (S.tab === 'whatsapp') renderWhatsApp(); }
    catch (e) { toast(problem(e), true); }
  }, true); }
  if (a === 'person-new') return personForm();
  if (a === 'person') return personForm(person(el.dataset.id));
  if (a === 'person-del') { const p = person(el.dataset.id); return confirmBox('Remove ' + p.name + '?', 'They will no longer be able to sign in. Jobs assigned to them become unassigned.', 'Remove', async () => {
    try { await q(S.sb.from('pj_people').delete().eq('id', p.id)); toast(p.name + ' removed'); await Promise.all([loadPeople(), loadJobs()]); render(); }
    catch (e) { toast(problem(e), true); }
  }, true); }
});
document.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.id === 'auth-form') return authSubmit(f);
  if (!isMgr()) return;
  if (f.id === 'job-form') return saveJob(f);
  if (f.id === 'quick-form') return saveQuick(f);
  if (f.id === 'person-form') return savePerson(f);
  if (f.id === 'number-form') return saveNumber(f);
});
document.addEventListener('change', (ev) => {
  const el = ev.target;
  if (el.dataset && el.dataset.c) return toggleCheck(el);
  if (el.id === 'photo-in') { const files = [...el.files]; el.value = ''; return addPhotos(files); }
  if (!isMgr()) return;
  if (el.id === 'assign') { const jid = S.job.id, to = el.value; return managerSet({ assigned_to: to || null }, to ? 'Assigned to ' + personName(to) : 'Unassigned').then(() => { if (to) sendNotices(jid, true); }); }
  if (el.id === 'status') return managerSet({ status: el.value }, 'Status: ' + STATUS[el.value]);
  if (el.id === 'tz') return q(S.sb.from('pj_settings').update({ timezone: el.value }).eq('id', true)).then(() => { S.settings.timezone = el.value; toast('Time zone saved'); }).catch((e) => toast(problem(e), true));
});
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'search') { S.q = ev.target.value; renderJobs(); }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { if ($('#mdl-root').innerHTML) closeModal(); else if (S.job) closeJob(); return; }
  // Enter in a task or part line starts the next line instead of saving the form
  if (ev.key === 'Enter' && ev.target.closest && ev.target.closest('.rows')) {
    ev.preventDefault();
    addRow(ev.target.closest('#task-rows') ? 'task' : 'part');
  }
});

/* Live updates: a job created on WhatsApp, or assigned to you, appears without reloading. */
function live() {
  if (S.chan || !S.sb.channel) return;
  let timer = null;
  const changed = (payload) => {
    const known = new Set(S.jobs.map((j) => j.id));
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!S.ready) return;
      try {
        await loadJobs();
        if (S.tab === 'jobs') renderJobs();
        if (payload && payload.table === 'pj_jobs' && payload.new && payload.new.id && !known.has(payload.new.id) && S.jobs.some((j) => j.id === payload.new.id)) {
          toast(isMgr() ? 'New job: ' + payload.new.title : 'New job for you: ' + payload.new.title);
        }
        const typing = document.activeElement && document.activeElement.id === 'notes';
        if (S.job && !typing && !$('#mdl-root').innerHTML) await openJob(S.job.id, true);
      } catch (_) { /* the next change will try again */ }
    }, 500);
  };
  let ch = S.sb.channel('pj-live');
  for (const table of ['pj_jobs', 'pj_job_tasks', 'pj_job_parts', 'pj_job_photos']) ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, changed);
  S.chan = ch.subscribe();
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.ready) changed(null); });
}

function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
}
(async function boot() {
  try {
    S.cfg = await (await fetch('cloud.json', { cache: 'no-store' })).json();
    if (window.__PJ_SB__) S.sb = window.__PJ_SB__;           // stand-in used by the tests
    else {
      if (!window.supabase) await loadScript(SDK);
      S.sb = window.supabase.createClient(S.cfg.url, S.cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
    }
  } catch (e) { return authScreen('fail', { err: 'Cannot reach the sign-in service. Check the internet.' }); }
  let recovering = /type=recovery/.test(location.hash);
  S.sb.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') { recovering = true; setTimeout(() => authScreen('newpass'), 0); }
    if (event === 'SIGNED_OUT' && S.ready) setTimeout(signOut, 0);
  });
  try {
    const { data } = await S.sb.auth.getSession();
    if (recovering) return authScreen('newpass');
    if (data && data.session) await enter(); else authScreen('in');
  } catch (e) { authScreen('in'); }
})();
