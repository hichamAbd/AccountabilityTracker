const { chromium } = require('playwright');
const path = require('path');
const out = path.join(__dirname, '..', 'icons');
const svg = (rx, pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${rx}" fill="#1d1c1a"/><g transform="translate(32 32) scale(${pad}) translate(-32 -32)" stroke="#f3efe6" stroke-width="3.6" stroke-linecap="round"><path d="M20 18v28M27.5 18v28M35 18v28M42.5 18v28"/><path d="M14.5 39.5 49 23.5" stroke="#d9a441"/></g></svg>`;
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const shots = [['icon-192.png', 192, 14, 1], ['icon-512.png', 512, 14, 1], ['apple-touch-icon.png', 180, 0, 1], ['icon-maskable-512.png', 512, 0, 0.78]];
  for (const [name, size, rx, pad] of shots) {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg(rx, pad).replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await p.screenshot({ path: path.join(out, name), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  }
  await b.close();
})();
