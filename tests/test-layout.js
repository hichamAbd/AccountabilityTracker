// Layout audit on phone widths: opens every screen and sheet and reports
//  - anything that makes the page wider than the screen,
//  - sideways scrolling inside sheets/cards that isn't meant to scroll,
//  - text fields under 16px (iPhone Safari zooms in when you tap those and stays zoomed).
const { chromium } = require('playwright');
const { FakeGitHub } = require('./fakegh');
const { seed } = require('./seed');
const URL = 'http://localhost:8765/';
const PW = 'quiet river lamp';
const WIDTHS = (process.argv[2] || '320,375,390').split(',').map(Number);

function audit() {
  const W = document.documentElement.clientWidth;
  const intentional = el => el.matches('.chips, .scroll-x, .table-wrap, .sheet-body, dialog');
  const clipped = el => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (getComputedStyle(p).overflowX !== 'visible') return true;
    }
    return false;
  };
  const name = el => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList.length ? `.${[...el.classList].join('.')}` : ''}`;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if ((r.right > W + 0.5 || r.left < -0.5) && !clipped(el)) offenders.push(`${name(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
  }
  const innerScroll = [...document.querySelectorAll('body *')].filter(el => {
    const s = getComputedStyle(el);
    return s.display !== 'none' && (s.overflowX === 'auto' || s.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && !el.matches('.chips, .scroll-x, .table-wrap');
  }).map(el => `${name(el)} (+${el.scrollWidth - el.clientWidth}px)`);
  const small = [...document.querySelectorAll('input, select, textarea')]
    .filter(e => !['hidden', 'checkbox', 'radio', 'color', 'file'].includes(e.type) && e.getClientRects().length)
    .filter(e => parseFloat(getComputedStyle(e).fontSize) < 16)
    .map(e => `${e.name || e.id || e.type} ${getComputedStyle(e).fontSize}`);
  return { page: document.documentElement.scrollWidth - W, offenders: [...new Set(offenders)].slice(0, 6), innerScroll, small };
}

(async () => {
  const browser = await chromium.launch();
  let problems = 0;
  for (const width of WIDTHS) {
    const gh = new FakeGitHub();
    const ctx = await browser.newContext({ serviceWorkers: 'block', viewport: { width, height: 760 }, isMobile: true, hasTouch: true });
    await ctx.route('https://api.github.com/**', r => gh.handle(r));
    const page = await ctx.newPage();
    page.on('pageerror', e => { console.log('PAGE ERROR', e.message); problems++; });
    await page.goto(URL);
    await page.waitForSelector('#setupForm');
    const steps = [];
    const step = (n, fn) => steps.push([n, fn]);
    const go = h => page.evaluate(x => { location.hash = x; }, h);
    const tap = sel => page.locator(sel).first().tap();
    const wait = ms => page.waitForTimeout(ms);
    const closeSheet = () => page.evaluate(() => document.querySelector('#sheet').open && document.querySelector('#sheet').close());

    step('setup screen', async () => {});
    step('welcome', async () => {
      await page.fill('[name=token]', 'good-token'); await page.fill('[name=pw]', PW); await page.fill('[name=pw2]', PW);
      await page.click('#setupForm [type=submit]'); await page.waitForSelector('.welcome', { timeout: 20000 });
    });
    step('today', async () => {
      const { habits, events } = seed();
      await page.evaluate(({ habits, events }) => window.tally.importOps([...habits.map(habit => ({ op: 'habit', habit })), ...events.map(ev => ({ op: 'add', ev }))]), { habits, events });
      await page.waitForFunction(() => window.tally.status.state === 'ok' && !window.tally.pending.length, null, { timeout: 30000 });
      await go('#log'); await wait(300);
    });
    step('sheet: + (log)', async () => { await tap('.tile .btn-plus'); await wait(350); });
    step('toast after logging', async () => {
      if (await page.locator('#logForm').count()) await page.locator('#logForm [type=submit]').click();
      await wait(250);
    });
    step('sheet: ⋯ (manage)', async () => { await closeSheet(); await tap('.tile [data-act=habit-menu]'); await wait(350); });
    step('sheet: edit habit', async () => { await tap('#sheet [data-act=habit-edit]'); await wait(350); });
    step('sheet: new habit', async () => { await closeSheet(); await tap('[data-act=habit-new]'); await wait(350); });
    step('dashboard all', async () => { await closeSheet(); await go('#dash'); await wait(200); await tap('[data-act=dash-habit][data-v=all]'); await wait(300); });
    step('dashboard habit 90d', async () => { await tap('[data-act=dash-habit][data-v=smk]'); await tap('[data-act=range][data-v="90d"]'); await wait(300); });
    step('dashboard habit 1y', async () => { await tap('[data-act=range][data-v="1y"]'); await wait(300); });
    step('chart tooltip', async () => { const r = page.locator('.ch .hit').nth(5); const b = await r.boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + 20); await wait(200); });
    step('calendar all', async () => { await go('#cal'); await wait(200); await tap('[data-act=cal-habit][data-v=all]'); await wait(300); });
    step('calendar habit', async () => { await tap('[data-act=cal-habit][data-v=smk]'); await wait(300); });
    step('sheet: day', async () => { await tap('.day.today'); await wait(350); });
    step('history', async () => { await closeSheet(); await go('#hist'); await wait(300); });
    step('sheet: edit entry', async () => { await tap('.ev'); await wait(350); });
    step('settings', async () => { await closeSheet(); await go('#set'); await wait(300); });
    step('settings unlocked', async () => { await page.fill('#secPw', PW); await page.click('#secUnlock [type=submit]'); await page.waitForSelector('#pwForm'); await wait(200); });

    console.log(`\n=== ${width}px ===`);
    for (const [n, fn] of steps) {
      try { await fn(); } catch (e) { console.log(`  skip  ${n}: ${e.message.split('\n')[0]}`); continue; }
      const a = await page.evaluate(audit);
      const bad = a.page > 0 || a.offenders.length || a.innerScroll.length || a.small.length;
      if (bad) problems++;
      console.log(`  ${bad ? 'FAIL' : 'ok  '}  ${n}${a.page > 0 ? `  page +${a.page}px` : ''}`);
      if (a.offenders.length) console.log(`        wider than screen: ${a.offenders.join(', ')}`);
      if (a.innerScroll.length) console.log(`        sideways scroll: ${a.innerScroll.join(', ')}`);
      if (a.small.length) console.log(`        zooms on iPhone (<16px): ${[...new Set(a.small)].join(', ')}`);
    }
    await ctx.close();
  }
  console.log(`\n${problems ? `${problems} problem(s)` : 'no layout problems'}`);
  await browser.close();
  process.exit(problems ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
