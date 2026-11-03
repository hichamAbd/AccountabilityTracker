// End-to-end test of setup, logging, sync, second device, conflicts and password change.
const { chromium } = require('playwright');
const { FakeGitHub } = require('./fakegh');
const URL = 'http://localhost:8765/';
const PW = 'quiet river lamp';
const gh = new FakeGitHub();
let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

async function device(browser, name) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
  await ctx.route('https://api.github.com/**', r => (ctx.__offline ? r.abort('internetdisconnected') : gh.handle(r)));
  await ctx.route('https://raw.githubusercontent.com/**', r => r.fulfill({ status: 404, body: '' }));
  const page = await ctx.newPage();
  page.on('pageerror', e => { console.log(`[${name}] PAGE ERROR`, e.message); failures++; });
  page.on('console', m => { if (m.type() === 'error') console.log(`[${name}] console.error`, m.text()); });
  return { ctx, page };
}
const synced = page => page.waitForFunction(() => window.tally.status.state === 'ok' && window.tally.pending.length === 0, null, { timeout: 15000 });
const count = (page, name) => page.evaluate(n => {
  const v = window.tally.view; const h = v.habits.find(x => x.name === n); return h ? (v.byHabit.get(h.id) || []).length : -1;
}, name);

(async () => {
  const browser = await chromium.launch();

  // ---------- device A: first run ----------
  const A = await device(browser, 'A');
  await A.page.goto(URL);
  await A.page.waitForSelector('#setupForm');
  check(true, 'first visit shows setup');
  await A.page.fill('[name=token]', 'bad-token');
  await A.page.fill('[name=pw]', PW);
  await A.page.fill('[name=pw2]', PW);
  await A.page.click('#setupForm [type=submit]');
  await A.page.waitForFunction(() => document.querySelector('#setupForm .form-error').textContent.length > 0);
  check(/rejected/.test(await A.page.textContent('#setupForm .form-error')), 'bad token gives a clear error');
  await A.page.fill('[name=token]', 'good-token');
  await A.page.click('#setupForm [type=submit]');
  await A.page.waitForSelector('#app:not([hidden]) .welcome', { timeout: 20000 });
  check(gh.refs.has('data'), 'data branch created');
  const vault = JSON.parse(gh.fileAt('data', 'vault.json'));
  check(vault.kdf && vault.token && !gh.fileAt('data', 'vault.json').includes('good-token'), 'vault stores token encrypted only');

  // add habits from suggestions
  for (const n of ['Smoking', 'Water', 'Exercise']) await A.page.click(`[data-act=suggest]:has-text("${n}")`);
  await A.page.waitForSelector('.tile[data-h]');
  check((await A.page.$$('.tile')).length === 3, 'three habit tiles shown');

  // log: 3 smoking, 2 water, then undo one water
  const plus = n => A.page.click(`.tile:has(.tile-name:text-is("${n}")) .btn-plus`);
  await plus('Smoking'); await plus('Smoking'); await plus('Smoking');
  await plus('Water'); await plus('Water');
  await A.page.click('#toast button');
  check(await count(A.page, 'Smoking') === 3 && await count(A.page, 'Water') === 1, 'taps and undo counted locally');
  check((await A.page.textContent('.tile:has(.tile-name:text-is("Smoking")) .num')).trim() === '3', 'tile shows today count 3');
  await synced(A.page);
  const files = gh.filesAt('data');
  const evFile = files.find(f => f.startsWith('events/'));
  check(!!evFile, `events file committed (${evFile})`);
  const raw = gh.fileAt('data', evFile) + gh.fileAt('data', 'config.json');
  check(!/Smoking|Water/.test(raw), 'habit names are not readable in the repo');
  const commitsAfterTaps = gh.commitCount('data');
  check(commitsAfterTaps <= 4, `quick taps batched into few commits (${commitsAfterTaps} commits total)`);

  // minus removes one from today
  await A.page.click('.tile:has(.tile-name:text-is("Smoking")) .btn-minus');
  check(await count(A.page, 'Smoking') === 2, 'minus removes one');
  await synced(A.page);

  // ---------- device B: new browser ----------
  const B = await device(browser, 'B');
  await B.page.goto(URL);
  await B.page.waitForSelector('#unlockForm');
  check(true, 'second device asks for password');
  await B.page.fill('#unlockForm [name=pw]', 'wrong password');
  await B.page.click('#unlockForm [type=submit]');
  await B.page.waitForFunction(() => /Wrong/.test(document.querySelector('#unlockForm .form-error').textContent));
  check(true, 'wrong password rejected');
  await B.page.fill('#unlockForm [name=pw]', PW);
  await B.page.click('#unlockForm [type=submit]');
  await B.page.waitForSelector('.tile[data-h]', { timeout: 20000 });
  check(await count(B.page, 'Smoking') === 2 && await count(B.page, 'Water') === 1, 'second device sees the same data');

  // ---------- concurrent writes from both devices ----------
  gh.writeDelay = 150;
  await Promise.all([
    A.page.click('.tile:has(.tile-name:text-is("Exercise")) .btn-plus'),
    B.page.click('.tile:has(.tile-name:text-is("Exercise")) .btn-plus'),
  ]);
  await Promise.all([synced(A.page), synced(B.page)]);
  await A.page.evaluate(() => window.tally.sync());
  await B.page.evaluate(() => window.tally.sync());
  check(await count(A.page, 'Exercise') === 2 && await count(B.page, 'Exercise') === 2, 'simultaneous logs from two devices both kept');
  gh.writeDelay = 0;

  // ---------- offline ----------
  A.ctx.__offline = true;
  await A.page.click('.tile:has(.tile-name:text-is("Water")) .btn-plus');
  await A.page.waitForFunction(() => ['offline', 'error'].includes(window.tally.status.state), null, { timeout: 10000 });
  check(/waiting|offline/i.test(await A.page.textContent('#syncPill')), `offline state shown (“${(await A.page.textContent('#syncPill')).trim()}”)`);
  await A.page.reload();
  await A.page.waitForSelector('.tile[data-h]');
  check(await count(A.page, 'Water') === 2, 'offline entry survives a reload');
  A.ctx.__offline = false;
  await A.page.evaluate(() => window.tally.sync());
  await synced(A.page);
  await B.page.evaluate(() => window.tally.sync());
  check(await count(B.page, 'Water') === 2, 'offline entry reaches the other device after reconnecting');

  // ---------- reload keeps device unlocked ----------
  await B.page.reload();
  await B.page.waitForSelector('.tile[data-h]');
  check(true, 'device stays unlocked after reload');

  // ---------- settings gate + password change ----------
  await A.page.goto(`${URL}#set`);
  await A.page.waitForSelector('#secUnlock');
  check(!(await A.page.content()).includes('good-token'), 'token not shown while settings are locked');
  await A.page.fill('#secPw', 'nope');
  await A.page.click('#secUnlock [type=submit]');
  await A.page.waitForFunction(() => /Wrong/.test(document.querySelector('#secErr').textContent));
  await A.page.fill('#secPw', PW);
  await A.page.click('#secUnlock [type=submit]');
  await A.page.waitForSelector('#pwForm');
  check(true, 'settings unlock with password');
  const NEW = 'brass owl window';
  await A.page.fill('#pwForm [name=pw]', NEW);
  await A.page.fill('#pwForm [name=pw2]', NEW);
  await A.page.click('#pwForm [type=submit]');
  await A.page.waitForFunction(() => /Password changed/.test(document.querySelector('#toast').textContent), null, { timeout: 20000 });
  check(true, 'password changed');
  const v2 = JSON.parse(gh.fileAt('data', 'vault.json'));
  check(v2.kdf.salt !== vault.kdf.salt, 'vault re-keyed');
  // B should now be locked out on next sync and accept the new password
  await B.page.evaluate(() => window.tally.sync());
  await B.page.waitForSelector('#unlockForm', { timeout: 10000 });
  check(/changed on another device/.test(await B.page.textContent('#gate')), 'other device notices the password change');
  await B.page.fill('#unlockForm [name=pw]', NEW);
  await B.page.click('#unlockForm [type=submit]');
  await B.page.waitForSelector('.tile[data-h]', { timeout: 20000 });
  check(await count(B.page, 'Smoking') === 2 && await count(B.page, 'Exercise') === 2, 'data intact after re-encryption');

  // ---------- edit and delete an entry ----------
  await B.page.goto(`${URL}#hist`);
  await B.page.waitForSelector('.ev');
  const before = (await B.page.$$('.ev')).length;
  await B.page.click('.ev >> nth=0');
  await B.page.fill('#evForm [name=n]', 'after lunch');
  await B.page.fill('#evForm [name=q]', '2');
  await B.page.click('#evForm [type=submit]');
  await B.page.waitForSelector('.ev-note:text("after lunch")');
  await B.page.click('.ev >> nth=1');
  await B.page.click('[data-act=ev-delete]');
  await B.page.waitForFunction(n => document.querySelectorAll('.ev').length === n, before - 1, { timeout: 5000 }).catch(() => {});
  check((await B.page.$$('.ev')).length === before - 1, 'edit and delete in history');
  check(await B.page.evaluate(() => window.tally.view.events.some(e => e.n === 'after lunch' && e.q === 2)), 'edited note and quantity saved');
  await synced(B.page);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASSED'} · ${gh.commitCount('data')} commits on data branch`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
