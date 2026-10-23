#!/usr/bin/env node
// Usage: node capture-login.js <sign-in-url> <state-path> [timeout-minutes]
// Opens a headed browser on <sign-in-url>, waits for the human to land in the app on the same host,
// saves Playwright storage state to <state-path> (mode 600) and exits 0. Exits 1 on timeout.
const fs = require('fs');
const path = require('path');

const candidates = [
  process.env.PLAYWRIGHT_PATH,
  'playwright',
].filter(Boolean);
let chromium;
for (const c of candidates) { try { ({ chromium } = require(c)); break; } catch {} }
if (!chromium) { console.error('playwright not found; set PLAYWRIGHT_PATH'); process.exit(2); }

const [signInUrl, statePath, minutes = '15'] = process.argv.slice(2);
if (!signInUrl || !statePath) { console.error('usage: capture-login.js <sign-in-url> <state-path> [timeout-minutes]'); process.exit(2); }
const host = new URL(signInUrl).host;
const authLike = /sign[-_]?in|login|auth|sso|password|verify|code|mfa/i;

(async () => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto(signInUrl);
  const deadline = Date.now() + Number(minutes) * 60 * 1000;
  let stableSince = null;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    let url;
    try { url = new URL(page.url()); } catch { break; }
    const inApp = url.host === host && !authLike.test(url.pathname);
    stableSince = inApp ? (stableSince ?? Date.now()) : null;
    if (stableSince && Date.now() - stableSince > 6000) {
      await context.storageState({ path: statePath });
      fs.chmodSync(statePath, 0o600);
      console.log(`SAVED ${new Date().toISOString()} landed on ${url.pathname}`);
      await browser.close();
      process.exit(0);
    }
  }
  console.log('TIMEOUT or window closed; nothing saved');
  await browser.close().catch(() => {});
  process.exit(1);
})();
