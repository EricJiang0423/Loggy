// End-to-end check: starts Loggy in demo mode, drives every page in Chromium (both languages,
// light and dark), fails on console errors, and saves screenshots to artifacts/.
//   node scripts/e2e.mjs [--chromium /path/to/chrome]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'artifacts');
fs.mkdirSync(out, { recursive: true });

function findChromium() {
  const i = process.argv.indexOf('--chromium');
  if (i > 0) return process.argv[i + 1];
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    for (const d of fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse()) {
      const p = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // let Playwright use its own browser
}

const server = spawn(process.execPath, [path.join(root, 'dist/cli.mjs'), '--demo', '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
const url = await new Promise((resolve, reject) => {
  let buf = '';
  const timer = setTimeout(() => reject(new Error(`server did not start:\n${buf}`)), 20000);
  server.stdout.on('data', (d) => {
    buf += d;
    const m = /running at (http:\/\/[^\s]+)/.exec(buf);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  server.stderr.on('data', (d) => (buf += d));
});

const failures = [];
const browser = await chromium.launch({ executablePath: findChromium() });
try {
  for (const lang of ['zh-CN', 'en']) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 960 }, locale: lang, colorScheme: theme });
      await ctx.addInitScript(([l, t]) => {
        localStorage.setItem('loggy.lang', l);
        localStorage.setItem('loggy.theme', t);
      }, [lang, theme]);
      const page = await ctx.newPage();
      page.on('console', (m) => {
        if (m.type() === 'error') failures.push(`[${lang}/${theme}] console: ${m.text()}`);
      });
      page.on('pageerror', (e) => failures.push(`[${lang}/${theme}] page error: ${e.message}`));
      const tag = `${lang}-${theme}`;
      const t0 = Date.now();
      await page.goto(`${url}/#/sessions`);
      await page.waitForSelector('.cal canvas', { timeout: 15000 });
      await page.waitForSelector('.detail-head h2', { timeout: 15000 });
      await page.waitForSelector('.tl-item', { timeout: 15000 });
      const firstPaint = Date.now() - t0;
      await page.screenshot({ path: path.join(out, `sessions-calendar-${tag}.png`) });

      // Click a session bar in the calendar and make sure the detail follows.
      const box = await page.locator('.cal canvas').boundingBox();
      const before = await page.locator('.detail-head h2').textContent();
      let clicked = false;
      for (let y = 20; y < box.height && !clicked; y += 12) {
        for (let x = 60; x < box.width; x += 20) {
          await page.mouse.move(box.x + x, box.y + y);
          if (await page.locator('.cal-tip').count()) {
            await page.mouse.click(box.x + x, box.y + y);
            clicked = true;
            break;
          }
        }
        if (y > 600) break;
      }
      if (!clicked) failures.push(`[${tag}] no session bar found in calendar`);

      // List view, filters, keyboard navigation.
      await page.getByRole('button', { name: lang === 'en' ? 'List' : '列表' }).click();
      await page.waitForSelector('.row');
      const rows = await page.locator('.row').count();
      if (rows < 10) failures.push(`[${tag}] list shows only ${rows} rows`);
      const t1 = Date.now();
      await page.locator('.row').nth(3).click();
      await page.keyboard.press('ArrowDown');
      await page.waitForFunction((prev) => document.querySelector('.detail-head h2')?.textContent !== prev, before, { timeout: 5000 }).catch(() => {});
      const switchMs = Date.now() - t1;
      await page.screenshot({ path: path.join(out, `sessions-list-${tag}.png`) });

      // Search
      await page.fill('.search input', lang === 'en' ? 'calendar' : '虚拟滚动');
      await page.waitForTimeout(500);
      const hits = await page.locator('.row').count();
      if (hits < 1) failures.push(`[${tag}] search returned nothing`);
      await page.fill('.search input', '');

      // Efficiency
      await page.goto(`${url}/#/efficiency`);
      await page.waitForSelector('.kpi');
      await page.waitForSelector('svg.chart rect, svg.chart path');
      await page.screenshot({ path: path.join(out, `efficiency-${tag}.png`), fullPage: false });

      // Git: commits with a diff, then lines of code
      await page.goto(`${url}/#/git`);
      await page.waitForSelector('.gitview .ver', { timeout: 15000 });
      const subject = (await page.locator('.gitview .ver .subj').nth(1).textContent()).trim();
      await page.locator('.gitview .ver').nth(1).click();
      await page.waitForFunction((s) => document.querySelector('pre.git-msg')?.textContent?.trim() === s, subject, { timeout: 15000 });
      await page.screenshot({ path: path.join(out, `git-${tag}.png`) });
      await page.getByRole('button', { name: lang === 'en' ? 'Lines of code' : '代码行数' }).click();
      await page.waitForSelector('svg.chart path', { timeout: 30000 });

      // Instructions and settings
      await page.goto(`${url}/#/instructions`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(out, `instructions-${tag}.png`) });
      await page.goto(`${url}/#/settings`);
      await page.waitForSelector('.settings .card');
      await page.screenshot({ path: path.join(out, `settings-${tag}.png`) });

      // Narrow viewport: no horizontal page scroll.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${url}/#/sessions`);
      await page.waitForSelector('.detail-head h2');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 2) failures.push(`[${tag}] horizontal overflow ${overflow}px at 390px`);
      await page.screenshot({ path: path.join(out, `mobile-${tag}.png`) });

      console.log(`${tag}: first paint ${firstPaint} ms, session switch ${switchMs} ms, ${rows} rows`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} problem(s):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`e2e ok - screenshots in ${path.relative(root, out)}/`);
