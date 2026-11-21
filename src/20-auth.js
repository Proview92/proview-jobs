/* Sign-in pages (the shared Proview sign-in look). */
const BRAND = '<div class="pvs-brand"><span class="pvlogo"></span><span class="pvword">PROVIEW <i>JOBS</i></span></div>';
function authPage(body) {
  $('#login-root').innerHTML = '<div class="login pvs-root"><div class="pvs-auth solo"><div class="pvs-form"><form class="pvs-card" id="auth-form" novalidate>' + BRAND + body + '</form></div></div></div>';
  $('#app').hidden = true;
  const f = $('#login-root input'); if (f) f.focus();
}
function field(label, name, type, extra) {
  return '<label class="af">' + label + '<input name="' + name + '" type="' + type + '" ' + (extra || '') + '></label>';
}
function authScreen(kind, o) {
  o = o || {};
  S.auth = kind;
  const msg = o.err ? '<div class="notice bad">' + esc(o.err) + '</div>' : (o.note ? '<div class="notice">' + esc(o.note) + '</div>' : '');
  const email = esc(o.email || '');
  if (kind === 'in') return authPage('<h1>Sign in</h1><p class="muted">Jobs for the Proview Tech team.</p>' + msg +
    field('Email', 'email', 'email', 'autocomplete="username" required value="' + email + '"') +
    field('Password', 'password', 'password', 'autocomplete="current-password" required') +
    '<button class="go" type="submit">Sign in</button>' +
    '<div class="alinks"><button type="button" data-a="auth" data-k="up">First time? Create your account</button><button type="button" data-a="auth" data-k="forgot">Forgot password?</button></div>');
  if (kind === 'up') return authPage('<h1>Create your account</h1><p class="muted">Use the email your manager added for you. The first person to sign up becomes the manager.</p>' + msg +
    field('Your name', 'name', 'text', 'autocomplete="name" required') +
    field('Email', 'email', 'email', 'autocomplete="username" required value="' + email + '"') +
    field('Choose a password', 'password', 'password', 'autocomplete="new-password" minlength="8" required') +
    '<button class="go" type="submit">Create account</button>' +
    '<div class="alinks"><button type="button" data-a="auth" data-k="in">I already have an account</button></div>');
  if (kind === 'forgot') return authPage('<h1>Reset your password</h1><p class="muted">We will email you a link to choose a new one.</p>' + msg +
    field('Email', 'email', 'email', 'autocomplete="username" required value="' + email + '"') +
    '<button class="go" type="submit">Send the link</button>' +
    '<div class="alinks"><button type="button" data-a="auth" data-k="in">Back to sign in</button></div>');
  if (kind === 'newpass') return authPage('<h1>Choose a new password</h1>' + msg +
    field('New password', 'password', 'password', 'autocomplete="new-password" minlength="8" required') +
    '<button class="go" type="submit">Save password</button>');
  if (kind === 'sent') return authPage('<h1>Check your email</h1><p class="muted">We sent a link to <b>' + email + '</b>. Open it to finish, then come back here and sign in.</p>' +
    '<div class="alinks"><button type="button" data-a="auth" data-k="in">Back to sign in</button></div>');
  if (kind === 'nolist') return authPage('<h1>You are not on the team list yet</h1><p class="muted">Ask a manager to add <b>' + email + '</b> under Team in Proview Jobs, then try again.</p>' +
    '<button class="go" type="button" data-a="retry">Try again</button>' +
    '<div class="alinks"><button type="button" data-a="signout">Use a different email</button></div>');
  return authPage('<h1>Cannot open Proview Jobs</h1><div class="notice bad">' + esc(o.err || 'Something went wrong.') + '</div><button class="go" type="button" data-a="reload">Try again</button>');
}

async function authSubmit(form) {
  const v = Object.fromEntries(new FormData(form).entries());
  const email = String(v.email || '').trim().toLowerCase();
  const btn = $('.go', form);
  const back = location.origin + location.pathname;
  busy(btn, true);
  try {
    if (S.auth === 'in') {
      if (!email || !v.password) return authScreen('in', { email, err: 'Enter your email and password.' });
      const { error } = await S.sb.auth.signInWithPassword({ email, password: v.password });
      if (error) {
        if (/not confirmed/i.test(error.message)) return authScreen('in', { email, err: 'Open the link we emailed you first, then sign in.' });
        return authScreen('in', { email, err: /invalid/i.test(error.message) ? 'That email or password is not right.' : problem(error) });
      }
      await enter();
    } else if (S.auth === 'up') {
      const name = String(v.name || '').trim();
      if (!name || !email) return authScreen('up', { email, err: 'Enter your name and email.' });
      if (String(v.password || '').length < 8) return authScreen('up', { email, err: 'Use a password of at least 8 characters.' });
      const { data, error } = await S.sb.auth.signUp({ email, password: v.password, options: { emailRedirectTo: back, data: { name } } });
      if (error) return authScreen('up', { email, err: problem(error) });
      if (data.user && data.user.identities && data.user.identities.length === 0) return authScreen('in', { email, note: 'That email already has an account. Sign in instead.' });
      if (data.session) await enter(); else authScreen('sent', { email });
    } else if (S.auth === 'forgot') {
      if (!email) return authScreen('forgot', { err: 'Enter your email.' });
      const { error } = await S.sb.auth.resetPasswordForEmail(email, { redirectTo: back });
      if (error) return authScreen('forgot', { email, err: problem(error) });
      authScreen('sent', { email });
    } else if (S.auth === 'newpass') {
      if (String(v.password || '').length < 8) return authScreen('newpass', { err: 'Use a password of at least 8 characters.' });
      const { error } = await S.sb.auth.updateUser({ password: v.password });
      if (error) return authScreen('newpass', { err: problem(error) });
      toast('Password saved');
      await enter();
    }
  } catch (e) {
    authScreen(S.auth, { email, err: problem(e) });
  } finally { busy(btn, false); }
}

/* After sign-in: find this person on the team list and open the app. */
async function enter() {
  let tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { /* optional */ }
  let me;
  try { me = await q(S.sb.rpc('pj_claim', { p_timezone: tz })); }
  catch (e) { return authScreen('fail', { err: problem(e) }); }
  if (!me || !me.id) {
    let email = '';
    try { email = (await S.sb.auth.getUser()).data.user.email; } catch (_) { /* shown blank */ }
    return authScreen('nolist', { email });
  }
  S.me = me;
  try {
    await Promise.all([loadJobs(), loadPeople(), loadSettings()]);
  } catch (e) { return authScreen('fail', { err: problem(e) }); }
  $('#login-root').innerHTML = '';
  $('#app').hidden = false;
  S.ready = true;
  S.tab = 'jobs'; S.filter = 'open';
  render();
  live();
  pushInit();
  if (/[?&]job=/.test(location.search)) { openFromLink(location.href); try { history.replaceState(null, '', location.pathname); } catch (_) { /* cosmetic */ } }
}
async function signOut() {
  S.ready = false; S.me = null; S.job = null;
  $('#pnl-root').innerHTML = ''; closeModal();
  if (S.chan) { try { S.sb.removeChannel(S.chan); } catch (_) { /* gone already */ } S.chan = null; }
  await pushForget();
  try { await S.sb.auth.signOut(); } catch (_) { /* signed out locally anyway */ }
  authScreen('in');
}
