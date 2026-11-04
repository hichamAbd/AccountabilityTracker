// Seed a year of realistic data and take screenshots of every screen.
const { chromium } = require('playwright');
const { FakeGitHub } = require('./fakegh');
const { seed } = require('./seed');
const URL = 'http://localhost:8765/';
const PW = 'quiet river lamp';
const OUT = process.argv[2] || 'shots';
const SCALE = +(process.argv[3] || 1);
const gh = new FakeGitHub();


(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, deviceScaleFactor: SCALE });
  await ctx.route('https://api.github.com/**', r => gh.handle(r));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL);
  await page.waitForSelector('#setupForm');
  await page.screenshot({ path: `${OUT}/m-setup.png`, fullPage: true });
  await page.fill('[name=token]', 'good-token');
  await page.fill('[name=pw]', PW);
  await page.fill('[name=pw2]', PW);
  await page.click('#setupForm [type=submit]');
  await page.waitForSelector('.welcome', { timeout: 20000 });
  await page.click('[data-act=pick]:has-text("Smoking")'); await page.click('[data-act=pick]:has-text("Water")');
  await page.screenshot({ path: `${OUT}/m-welcome.png`, fullPage: true });
  const { habits, events } = seed();
  await page.evaluate(({ habits, events }) => window.tally.importOps([
    ...habits.map(habit => ({ op: 'habit', habit })),
    ...events.map(ev => ({ op: 'add', ev })),
  ]), { habits, events });
  await page.waitForFunction(() => window.tally.status.state === 'ok' && !window.tally.pending.length, null, { timeout: 30000 });
  console.log(`seeded ${events.length} events, files: ${gh.filesAt('data').length}`);

  const shot = async (name, hash, setup) => {
    await page.evaluate(h => { location.hash = h; }, hash);
    await page.waitForTimeout(250);
    if (setup) await setup();
    await page.waitForTimeout(250);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    if (ov > 0) console.log(`OVERFLOW ${name}: ${ov}px`);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  };
  await shot('m-today', '#log');
  await shot('m-dash-all', '#dash', () => page.click('[data-act=dash-habit][data-v=all]'));
  await shot('m-dash-smoking', '#dash', async () => { await page.click('.chip:has-text("Smoking")'); await page.click('[data-act=range][data-v="90d"]'); });
  await shot('m-dash-water', '#dash', async () => { await page.click('.chip:has-text("Water")'); });
  await shot('m-cal', '#cal', () => page.click('[data-act=cal-habit][data-v=all]'));
  await shot('m-cal-smoking', '#cal', () => page.click('[data-act=cal-habit][data-v=smk]'));
  await shot('m-hist', '#hist');
  await shot('m-settings', '#set');
  await page.evaluate(() => { location.hash = '#log'; });
  await page.waitForTimeout(200);
  await page.click('.tile:has(.tile-name:text-is("Smoking")) [data-act=habit-menu]');
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/m-sheet-menu.png` });
  await page.click('[data-act=habit-edit]');
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/m-sheet-edit.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.click('.tile:has(.tile-name:text-is("Smoking")) .btn-plus');
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/m-sheet-log.png` });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.click('.page-head [data-act=habit-new]');
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/m-sheet-new.png` });
  await page.keyboard.press('Escape');

  // desktop
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot('d-today', '#log');
  await shot('d-dash-smoking', '#dash', async () => { await page.click('.chip:has-text("Smoking")'); await page.click('[data-act=range][data-v="1y"]'); });
  await shot('d-dash-all', '#dash', async () => { await page.click('[data-act=dash-habit][data-v=all]'); await page.click('[data-act=range][data-v="90d"]'); });
  await shot('d-cal', '#cal', () => page.click('[data-act=cal-habit][data-v=all]'));
  // dark
  await page.evaluate(() => window.tally.setPrefs({ theme: 'dark' }));
  await shot('d-dark-dash', '#dash', async () => { await page.click('.chip:has-text("Smoking")'); await page.click('[data-act=range][data-v="90d"]'); });
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('m-dark-today', '#log');
  await shot('m-dark-cal', '#cal', () => page.click('[data-act=cal-habit][data-v=smk]'));
  console.log(errors.length ? `PAGE ERRORS: ${errors.join(' | ')}` : 'no page errors');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
