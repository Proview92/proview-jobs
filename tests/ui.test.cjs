// Run: python3 -m http.server 8765 &  then  NODE_PATH=$(npm root -g) node tests/ui.test.cjs
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const mock = fs.readFileSync(path.join(__dirname, 'mock-sb.js'), 'utf8');
const shots = path.join(__dirname, 'shots'); fs.mkdirSync(shots, { recursive: true });
const base = 'http://localhost:8765/index.html';
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.addInitScript(mock);
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  const errors = [];
  const open = async (qs) => { const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED/.test(m.text())) errors.push(m.text()); }); await p.goto(base + qs); return p; };
  const toastGone = async (p) => p.waitForFunction(() => !document.querySelector('#toast div'), null, { timeout: 8000 });

  // ---- sign-in page
  let p = await open('?out=1');
  await p.waitForSelector('#auth-form');
  await p.screenshot({ path: shots + '/1-signin.png' });
  await p.fill('[name=email]', 'boss@proview.test'); await p.fill('[name=password]', 'wrong'); await p.click('.go');
  await p.waitForSelector('.notice.bad'); assert.match(await p.textContent('.notice.bad'), /not right/);
  await p.fill('[name=password]', 'right-password'); await p.click('.go');
  await p.waitForSelector('.job');
  await p.close();

  // ---- manager
  p = await open('');
  await p.waitForSelector('.job');
  assert.equal(await p.locator('.job').count(), 3, 'open filter shows the three open jobs');
  assert.match(await p.textContent('.stats'), /3Open.*1Unassigned.*1Overdue.*1Done/);
  assert.match(await p.textContent('#main'), /Overdue1[\s\S]*Tomorrow1[\s\S]*No date1/, 'open jobs are grouped by due date');
  await p.screenshot({ path: shots + '/2-manager-jobs.png' });
  // new job with tasks and parts
  await p.click('[data-a=job-new]');
  await p.fill('[name=title]', 'Fit card reader at Zest'); await p.selectOption('[name=assigned_to]', { label: 'Sara Ali' });
  await p.selectOption('[name=priority]', 'high'); await p.fill('[name=customer_name]', 'Zest Deli');
  await p.click('[data-a=row-add][data-k=task]'); await p.keyboard.type('Unbox reader'); await p.keyboard.press('Enter'); await p.keyboard.type('Pair with till');
  await p.click('[data-a=row-add][data-k=part]'); await p.keyboard.type('Card reader');
  await p.locator('#part-rows .qty').fill('2');
  await p.locator('.mdl-box').evaluate((el) => (el.scrollTop = 0));
  await p.screenshot({ path: shots + '/3-new-job.png' });
  await p.click('#job-form [type=submit]');
  await p.waitForFunction(() => !document.querySelector('#mdl-root').innerHTML);
  assert.equal(await p.locator('.job').count(), 4);
  let db = await p.evaluate(() => window.__PJ_DB__);
  const nj = db.pj_jobs.find((j) => j.title === 'Fit card reader at Zest');
  assert.equal(nj.priority, 'high'); assert.deepEqual(db.pj_job_tasks.filter((t) => t.job_id === nj.id).map((t) => t.title), ['Unbox reader', 'Pair with till']);
  assert.deepEqual(db.pj_job_parts.filter((t) => t.job_id === nj.id).map((t) => [t.name, t.qty]), [['Card reader', 2]]);
  // empty title is refused
  await p.click('[data-a=job-new]'); await p.click('#job-form [type=submit]'); await p.waitForSelector('#form-err .err'); await p.click('[data-a=mdl-close]');
  // open a job, reassign, edit keeps ticked tasks
  await p.click('.job:has-text("Install 4 cameras")');
  await p.waitForSelector('.pnl h1');
  await toastGone(p);
  await p.screenshot({ path: shots + '/4-job-page.png', fullPage: false });
  await p.selectOption('#assign', { label: 'Sara Ali' }); await p.waitForFunction(() => /Assigned to Sara/.test(document.querySelector('#toast').textContent));
  await p.click('[data-a=job-edit]'); assert.equal(await p.locator('#task-rows .rw').count(), 3);
  await p.locator('#task-rows .rw').nth(2).locator('[data-a=row-rm]').click(); await p.click('#job-form [type=submit]');
  await p.waitForFunction(() => !document.querySelector('#mdl-root').innerHTML);
  db = await p.evaluate(() => window.__PJ_DB__);
  const t101 = db.pj_job_tasks.filter((t) => t.job_id.endsWith('101'));
  assert.deepEqual(t101.map((t) => [t.title, t.done]), [['Mount cameras', true], ['Run cable', false]]);
  await p.click('[data-a=back]');
  // search, filters
  await p.click('.stat[data-k=unassigned]'); assert.equal(await p.locator('.job').count(), 1);
  await p.click('.lnk[data-k=all]'); await p.fill('#search', 'khan'); assert.equal(await p.locator('.job').count(), 1);
  await p.fill('#search', ''); await p.click('.stat[data-k=open]');
  // quick add
  await p.click('[data-a=quick]'); await p.fill('#quick-form textarea', 'Fix till at Bella\nDue: fri'); await p.click('#quick-form [type=submit]');
  await p.waitForFunction(() => /J-0006 created/.test(document.querySelector('#toast').textContent));
  // team
  await p.click('[data-a=tab][data-k=team]'); assert.equal(await p.locator('.person').count(), 3);
  await p.click('[data-a=person-new]'); await p.fill('[name=name]', 'Omar'); await p.fill('#person-form [name=email]', 'Omar@Proview.test'); await p.fill('[name=phone]', '0501234567');
  await p.click('#person-form [type=submit]'); await p.waitForSelector('#form-err .err'); assert.match(await p.textContent('#form-err'), /country code/);
  await p.fill('[name=phone]', '+971 50 123 4567'); await p.click('#person-form [type=submit]');
  await p.waitForFunction(() => document.querySelectorAll('.person').length === 4);
  db = await p.evaluate(() => window.__PJ_DB__); const omar = db.pj_people.find((x) => x.name === 'Omar');
  assert.equal(omar.email, 'omar@proview.test'); assert.equal(omar.phone, '971501234567'); assert.equal(omar.role, 'staff');
  await toastGone(p); await p.screenshot({ path: shots + '/5-team.png' });
  // whatsapp
  await p.click('[data-a=tab][data-k=whatsapp]'); await p.waitForSelector('#hook');
  assert.match(await p.textContent('#hook'), /^https:\/\/[a-z0-9]+\.supabase\.co\/functions\/v1\/whatsapp-webhook$/);
  await p.waitForFunction(() => /Created J-0001/.test(document.querySelector('#wa-log').textContent));
  await p.waitForFunction(() => document.querySelectorAll('#wa-numbers .person').length === 2);
  await p.click('[data-a=number-new]'); await p.fill('#number-form [name=phone]', '07793503059'); await p.click('#number-form [type=submit]'); await p.waitForSelector('#form-err .err'); assert.match(await p.textContent('#form-err'), /replace the first 0 with 44/);
  await p.fill('#number-form [name=phone]', '+44 7793 503059'); await p.fill('#number-form [name=label]', 'Mobile'); await p.uncheck('#number-form [name=can_create]'); await p.click('#number-form [type=submit]');
  await p.waitForFunction(() => document.querySelectorAll('#wa-numbers .person').length === 3);
  db = await p.evaluate(() => window.__PJ_DB__); assert.deepEqual(db.pj_wa_numbers[2], { ...db.pj_wa_numbers[2], phone: '447793503059', label: 'Mobile', can_create: false, notify: true });
  const asked = await p.evaluate(() => window.__PJ_NOTIFY__ || []); assert.equal(asked.filter((x) => !x.only_assignee).length, 1, 'a new job asks for notices once'); assert.equal(asked.filter((x) => x.only_assignee).length, 1, 'a reassignment tells only the new assignee');
  await toastGone(p);
  await p.screenshot({ path: shots + '/6-whatsapp.png', fullPage: true });
  await p.close();

  // ---- staff: only their own jobs, no manager controls
  p = await open('?as=staff');
  await p.waitForSelector('.job');
  assert.equal(await p.locator('.job').count(), 2);
  assert.equal(await p.locator('[data-a=job-new], [data-a=quick], [data-a=tab][data-k=team], [data-a=tab][data-k=whatsapp]').count(), 0);
  assert.equal(await p.locator('.nav button').count(), 2);
  await p.screenshot({ path: shots + '/7-staff-jobs.png' });
  await p.click('.job:has-text("Install 4 cameras")'); await p.waitForSelector('.pnl h1');
  assert.equal(await p.locator('#assign, #status, [data-a=job-edit], [data-a=job-del]').count(), 0);
  await p.click('[data-a=progress][data-k=in_progress]'); await p.waitForSelector('.pnl .pill.in_progress');
  await p.locator('[data-c=task]').nth(1).check(); await p.waitForFunction(() => /2 of 3 done/.test(document.querySelector('.pnl').textContent));
  await p.locator('[data-c=part]').nth(0).check();
  await p.click('[data-a=finish]'); await p.waitForSelector('#fin-notes'); assert.match(await p.textContent('.mdl-box'), /1 task is not ticked/);
  await p.fill('#fin-notes', 'All four cameras live. Recorder password on the box.');
  await toastGone(p); await p.screenshot({ path: shots + '/8-staff-finish.png' });
  await p.click('[data-a=finish-yes]'); await p.waitForSelector('.pnl .pill.done');
  db = await p.evaluate(() => window.__PJ_DB__); const j1 = db.pj_jobs.find((j) => j.ref === 1);
  assert.equal(j1.status, 'done'); assert.match(j1.completion_notes, /All four cameras/);
  await p.click('[data-a=back]'); assert.equal(await p.locator('.job').count(), 1, 'done job leaves the to-do list');
  await p.click('.nav [data-k=me]'); await p.waitForSelector('.me'); assert.match(await p.textContent('.me'), /Ravi Kumar.*ravi@proview.test.*Staff/); assert.equal(await p.locator('[data-a=signout]').count(), 1);
  await p.screenshot({ path: shots + '/10-account.png' });
  await p.close();

  // ---- desktop width
  const wide = await browser.newContext({ viewport: { width: 1280, height: 800 } }); await wide.addInitScript(mock); await wide.route(/fonts\./, (r) => r.abort());
  p = await wide.newPage(); await p.goto(base); await p.waitForSelector('.job'); await p.screenshot({ path: shots + '/9-desktop.png' });
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth); assert.equal(overflow, false);
  await browser.close();
  assert.deepEqual(errors, [], 'no page errors');
  console.log('ui: all checks passed');
})().catch((e) => { console.error('UI TEST FAILED:', e.message); process.exit(1); });
