// Walks the demo path in headless Chromium and saves screenshots to docs/screenshots/.
// Usage: npm run dev (in another shell), then npm run screenshot [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { approveInSandbox } from './paypal-approve.js';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.env.SCREENSHOT_DIR ?? 'docs/screenshots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(base);
await page.getByRole('button', { name: 'Reset demo' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/1-board.png` });
await page.getByRole('button', { name: 'Let Takt read it' }).click();
await page.getByRole('button', { name: 'Make room' }).click();
await page.waitForSelector('text=Takt can make room');
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/2-make-room.png` });
await page.getByRole('button', { name: 'Send offers' }).click();
await page.waitForSelector('.phone');
await page.screenshot({ path: `${out}/3-offers.png`, fullPage: true });
// Accept every offer (sandbox round-trips are slower: wait for the stage instead of fixed sleeps).
for (let i = 0; i < 8; i++) {
  const st = await (await page.request.get(`${base}/api/state`)).json();
  if (st.stage !== 'offers-sent') break;
  const b = page.locator('.phone .btn.primary:not([disabled])').first();
  if (await b.count()) await b.click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);
}
const sandbox = (await (await page.request.get(`${base}/api/config`)).json()).paypalMode === 'sandbox';
if (sandbox) {
  // Real sandbox: the buyer approves on paypal.com (automated guest checkout), PayPal redirects to /api/paypal/return.
  const link = page.locator('#paypal-approve');
  await link.waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `${out}/4a-sandbox-awaiting-approval.png` });
  await approveInSandbox(browser, (await link.getAttribute('href'))!, `${out}/4b-sandbox-paypal-checkout.png`);
  await page.waitForSelector('text=Schedule committed', { timeout: 60_000 });
} else {
  await page.getByRole('button', { name: /Pay with PayPal/ }).click();
  await page.waitForSelector('text=Schedule committed', { timeout: 10_000 });
}
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/4-committed.png` });
// Settle: ship the first bumped/rush job with an authorization (capture less, final_capture=true).
const ship = page.locator('.settle .btn.small').first();
if (await ship.count()) {
  await ship.click();
  await page.waitForTimeout(sandbox ? 6000 : 1500);
  await page.screenshot({ path: `${out}/5-settled.png` });
}
await browser.close();
console.log('screenshots in', out);
