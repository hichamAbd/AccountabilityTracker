// End-to-end test: setup, logging (+ sheet), habit menu, dashboard links, suggestions,
// sync, second device, conflicts, offline, password change, editing entries.
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
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) console.log(`[${name}] console.error`, m.text()); });
  return { ctx, page };
}
const synced = page => page.waitForFunction(() => window.tally.status.state === 'ok' && window.tally.pending.length === 0, null, { timeout: 15000 });
const count = (page, name) => page.evaluate(n => {
  const v = window.tally.view; const h = v.habits.find(x => x.name === n); return h ? (v.byHabit.get(h.id) || []).length : -1;
}, name);
const tileSel = n => `.tile:has(.tile-name:text-is("${n}"))`;
// Tap + on a habit, optionally change the sheet, then confirm.
async function logVia(page, name, fill) {
  await page.click(`${tileSel(name)} .btn-plus`);
  await page.waitForSelector('#logForm');
  if (fill) await fill(page);
  await page.click('#logForm [type=submit]');
  await page.waitForFunction(() => !document.querySelector('#sheet').open, null, { timeout: 5000 });
}
const pad = n => String(n).padStart(2, '0');
const dayKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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

  // ---------- welcome: tick several suggestions, add them at once ----------
  check(await A.page.isDisabled('[data-act=add-picked]'), 'welcome add button disabled until something is ticked');
  for (const n of ['Smoking', 'Water', 'Exercise']) await A.page.click(`[data-act=pick]:has-text("${n}")`);
  check((await A.page.textContent('[data-act=add-picked]')).includes('Add 3 habits'), 'welcome counts ticked suggestions');
  await A.page.click('[data-act=add-picked]');
  await A.page.waitForSelector('.tile[data-h]');
  check((await A.page.$$('.tile')).length === 3, 'three habit tiles shown');
  check(await A.page.locator('[data-act=pick], [data-act=suggest], .quick-add').count() === 0, 'no suggestions on Today once habits exist');

  // ---------- + opens the log sheet ----------
  await A.page.click(`${tileSel('Smoking')} .btn-plus`);
  await A.page.waitForSelector('#logForm');
  check(await A.page.inputValue('#logForm [name=d]') === dayKey(new Date()), '+ sheet: date defaults to today');
  check(await A.page.locator('#logForm [data-act=log-day].on').textContent() === 'Today', '+ sheet: “Today” chip selected');
  check(await A.page.locator('#logForm [name=n]').count() === 1, '+ sheet: has a comment field');
  await A.page.keyboard.press('Escape');
  check(await count(A.page, 'Smoking') === 0, 'closing the sheet logs nothing');

  // log: 3 smoking, 2 water, then undo one water
  await logVia(A.page, 'Smoking'); await logVia(A.page, 'Smoking'); await logVia(A.page, 'Smoking');
  await logVia(A.page, 'Water'); await logVia(A.page, 'Water');
  await A.page.click('#toast button');
  check(await count(A.page, 'Smoking') === 3 && await count(A.page, 'Water') === 1, 'logs and undo counted locally');
  check((await A.page.textContent(`${tileSel('Smoking')} .num`)).trim() === '3', 'tile shows today count 3');

  // yesterday + comment
  await logVia(A.page, 'Exercise', async p => { await p.click('#logForm [data-act=log-day]:has-text("Yesterday")'); await p.fill('#logForm [name=n]', 'Morning run'); });
  const ex = await A.page.evaluate(() => { const v = window.tally.view; const h = v.habits.find(x => x.name === 'Exercise'); return v.byHabit.get(h.id).map(e => ({ t: e.t, n: e.n })); });
  check(ex.length === 1 && dayKey(new Date(ex[0].t)) === dayKey(new Date(Date.now() - 864e5)) && ex[0].n === 'Morning run', 'logged on yesterday with a comment');
  check((await A.page.textContent(`${tileSel('Exercise')} .num`)).trim() === '0', 'yesterday’s entry is not counted as today');

  // no future entries
  await A.page.click(`${tileSel('Water')} .btn-plus`);
  await A.page.waitForSelector('#logForm');
  const tomorrow = dayKey(new Date(Date.now() + 864e5));
  await A.page.evaluate(d => { document.querySelector('#logForm [name=d]').value = d; }, tomorrow);
  await A.page.click('#logForm [type=submit]');
  await A.page.waitForTimeout(300);
  check(await A.page.evaluate(() => document.querySelector('#sheet').open) && await count(A.page, 'Water') === 1, 'a future date is refused');
  await A.page.keyboard.press('Escape');

  await synced(A.page);
  const files = gh.filesAt('data');
  const evFile = files.find(f => f.startsWith('events/'));
  check(!!evFile, `events file committed (${evFile})`);
  const raw = files.filter(f => f.endsWith('.json')).map(f => gh.fileAt('data', f)).join('');
  check(!/Smoking|Water|Morning run/.test(raw), 'habit names and comments are not readable in the repo');

  // minus removes one from today
  await A.page.click(`${tileSel('Smoking')} .btn-minus`);
  check(await count(A.page, 'Smoking') === 2, 'minus removes one');

  // ---------- ⋯ menu is about managing the habit ----------
  await A.page.click(`${tileSel('Water')} [data-act=habit-menu]`);
  await A.page.waitForSelector('#sheet .menu');
  const menu = await A.page.locator('#sheet .menu-item b').allTextContents();
  check(await A.page.locator('#sheet #logForm').count() === 0, '⋯ menu no longer has a log form');
  check(['Edit habit', 'Dashboard', 'All entries', 'Position on Today', 'Hide from Today', 'Archive', 'Delete…'].every(x => menu.includes(x)), `⋯ menu: ${menu.join(', ')}`);
  await A.page.click('#sheet [data-act=menu-move][data-v="-1"]');
  await A.page.waitForTimeout(150);
  const order = await A.page.evaluate(() => [...document.querySelectorAll('.tile .tile-name')].map(e => e.textContent));
  check(order[0] === 'Water', `move earlier from the menu reorders Today (${order.join(', ')})`);
  await A.page.click('#sheet [data-act=goto-dash]');
  await A.page.waitForSelector('.hero h2');
  check(A.page.url().includes('#dash/') && await A.page.textContent('.hero h2') === 'Water', 'menu → habit dashboard');

  // ---------- direct access: tap the tile ----------
  await A.page.goto(`${URL}#log`);
  await A.page.waitForSelector('.tile');
  await A.page.click(`${tileSel('Smoking')} .tile-body`);
  await A.page.waitForSelector('.hero h2');
  check(await A.page.textContent('.hero h2') === 'Smoking', 'tapping a tile opens that habit’s dashboard');
  await A.page.goBack();
  await A.page.waitForSelector('.tile');
  check(!A.page.url().includes('#dash'), 'Back returns to Today');

  // ---------- suggestions in the New habit sheet ----------
  await A.page.click('.page-head [data-act=habit-new]');
  await A.page.waitForSelector('#habitForm');
  const sug = await A.page.locator('#habitForm [data-act=prefill]').allTextContents();
  check(sug.length > 5 && !sug.some(s => /Smoking|Water|Exercise/.test(s)), `new habit sheet suggests habits not yet added (${sug.length})`);
  await A.page.click('#habitForm [data-act=prefill]:has-text("Reading")');
  check(await A.page.inputValue('#habitForm [name=name]') === 'Reading' && await A.page.isChecked('#habitForm [name=kind][value=good]'), 'a suggestion fills in the form');
  await A.page.click('#habitForm [type=submit]');
  await A.page.waitForSelector(tileSel('Reading'));
  check(true, 'suggested habit created');
  await A.page.click('.page-head [data-act=habit-new]');
  await A.page.waitForSelector('#habitForm');
  check(!(await A.page.locator('#habitForm [data-act=prefill]').allTextContents()).some(s => s.includes('Reading')), 'added suggestion is no longer offered');
  await A.page.keyboard.press('Escape');

  // ---------- optional instant mode ----------
  await A.page.evaluate(() => window.tally.setPrefs({ logDetails: false }));
  await A.page.click(`${tileSel('Reading')} .btn-plus`);
  await A.page.waitForTimeout(150);
  check(await count(A.page, 'Reading') === 1 && !(await A.page.evaluate(() => document.querySelector('#sheet').open)), 'instant mode: + logs in one tap');
  await A.page.evaluate(() => window.tally.setPrefs({ logDetails: true }));
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
  check(await count(B.page, 'Smoking') === 2 && await count(B.page, 'Water') === 1 && await count(B.page, 'Reading') === 1, 'second device sees the same data');

  // ---------- concurrent writes from both devices ----------
  gh.writeDelay = 150;
  await Promise.all([logVia(A.page, 'Exercise'), logVia(B.page, 'Exercise')]);
  await Promise.all([synced(A.page), synced(B.page)]);
  await A.page.evaluate(() => window.tally.sync());
  await B.page.evaluate(() => window.tally.sync());
  check(await count(A.page, 'Exercise') === 3 && await count(B.page, 'Exercise') === 3, 'simultaneous logs from two devices both kept');
  gh.writeDelay = 0;

  // ---------- offline ----------
  A.ctx.__offline = true;
  await logVia(A.page, 'Water');
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
  await B.page.evaluate(() => window.tally.sync());
  await B.page.waitForSelector('#unlockForm', { timeout: 10000 });
  check(/changed on another device/.test(await B.page.textContent('#gate')), 'other device notices the password change');
  await B.page.fill('#unlockForm [name=pw]', NEW);
  await B.page.click('#unlockForm [type=submit]');
  await B.page.waitForSelector('.tile[data-h]', { timeout: 20000 });
  check(await count(B.page, 'Smoking') === 2 && await count(B.page, 'Exercise') === 3, 'data intact after re-encryption');

  // ---------- edit and delete an entry ----------
  await B.page.goto(`${URL}#hist/all`);
  await B.page.waitForSelector('.ev');
  const before = (await B.page.$$('.ev')).length;
  await B.page.click('.ev >> nth=0');
  await B.page.waitForSelector('#evForm');
  await B.page.fill('#evForm [name=n]', 'after lunch');
  await B.page.fill('#evForm [name=q]', '2');
  await B.page.click('#evForm [type=submit]');
  await B.page.waitForSelector('.ev-note:text("after lunch")');
  await B.page.click('.ev >> nth=1');
  await B.page.click('[data-act=ev-delete]');
  await B.page.waitForFunction(n => document.querySelectorAll('.ev').length === n, before - 1, { timeout: 5000 }).catch(() => {});
  check((await B.page.$$('.ev')).length === before - 1, 'edit and delete in history');
  check(await B.page.evaluate(() => window.tally.view.events.some(e => e.n === 'after lunch' && e.q === 2)), 'edited comment and quantity saved');
  // move an entry to another day from the editor
  await B.page.click('.ev >> nth=0');
  await B.page.waitForSelector('#evForm');
  const twoDaysAgo = dayKey(new Date(Date.now() - 2 * 864e5));
  await B.page.fill('#evForm [name=d]', twoDaysAgo);
  await B.page.click('#evForm [type=submit]');
  await B.page.waitForTimeout(200);
  check(await B.page.evaluate(d => window.tally.view.events.some(e => { const x = new Date(e.t); const k = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; return k === d; }), twoDaysAgo), 'entry moved to another date');
  await synced(B.page);

  console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASSED'} · ${gh.commitCount('data')} commits on data branch`);
  await browser.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
