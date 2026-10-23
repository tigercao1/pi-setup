#!/usr/bin/env node
// Usage: node capture-states.js <base-url> <states.json> <out-dir> [storage-state.json]
// states.json: [{ "name": "settings-empty", "path": "/settings", "waitFor": "#form",
//   "actions": [{ "click": "sel" } | { "hover": "sel" } | { "fill": ["sel", "text"] } | { "press": "Escape" }],
//   "mask": ["sel"], "fullPage": true, "viewport": { "width": 1280, "height": 860 } }]
// Writes <out-dir>/<name>.png per state with a fixed viewport, scale 1, reduced motion,
// animations disabled and the caret hidden. Run it unchanged against the baseline and the change build.
// Ends with: STATES expected=<n> captured=<n> failed=<n>. An empty or unnamed state list is an error (exit 2).
const fs = require('fs');
const path = require('path');

const [base, statesPath, outDir, storageState] = process.argv.slice(2);
if (!base || !statesPath || !outDir) {
  console.error('usage: capture-states.js <base-url> <states.json> <out-dir> [storage-state.json]');
  process.exit(2);
}
const states = JSON.parse(fs.readFileSync(statesPath, 'utf8'));
if (!Array.isArray(states) || states.length === 0) {
  console.error(`${statesPath} must be a non-empty array of states`);
  process.exit(2);
}
const names = states.map((s) => s && s.name);
const bad = names.findIndex((n, i) => typeof n !== 'string' || !/^[\w.-]+$/.test(n) || names.indexOf(n) !== i);
if (bad !== -1) {
  console.error(`every state needs a unique file-safe name; state ${bad} has ${JSON.stringify(names[bad] ?? null)}`);
  process.exit(2);
}

const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright'].filter(Boolean);
let chromium;
for (const c of candidates) { try { ({ chromium } = require(c)); break; } catch {} }
if (!chromium) { console.error('playwright not found; set PLAYWRIGHT_PATH'); process.exit(2); }

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  for (const s of states) {
    const context = await browser.newContext({
      viewport: s.viewport || { width: 1280, height: 860 },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'UTC',
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    try {
      await page.goto(new URL(s.path || '/', base).toString(), { waitUntil: 'networkidle' });
      if (s.waitFor) await page.waitForSelector(s.waitFor, { state: 'visible' });
      for (const a of s.actions || []) {
        if (a.click) await page.click(a.click);
        else if (a.hover) await page.hover(a.hover);
        else if (a.fill) await page.fill(a.fill[0], a.fill[1]);
        else if (a.press) await page.keyboard.press(a.press);
        await page.waitForLoadState('networkidle');
      }
      await page.evaluate(() => document.fonts.ready);
      const file = path.join(outDir, `${s.name}.png`);
      await page.screenshot({
        path: file,
        fullPage: s.fullPage !== false,
        animations: 'disabled',
        caret: 'hide',
        mask: (s.mask || []).map((sel) => page.locator(sel)),
      });
      console.log(`CAPTURED ${s.name} ${file}`);
    } catch (err) {
      failed++;
      console.log(`FAILED ${s.name} ${err.message.split('\n')[0]}`);
    }
    await context.close();
  }
  await browser.close();
  console.log(`STATES expected=${states.length} captured=${states.length - failed} failed=${failed}`);
  process.exit(failed ? 1 : 0);
})();
