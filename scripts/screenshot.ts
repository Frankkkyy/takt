// Walks the demo path in headless Chromium and saves screenshots to docs/screenshots/.
// Usage: npm run dev (in another shell), then npm run screenshot [baseUrl]
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true }); // sandbox buyer login, if set
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
// Answer in free text: the agent reads each reply (recorded Claude responses for these scripted inputs).
const answer = async (who: RegExp, chip: string) => {
  const phone = page.locator('.phone', { hasText: who });
  if (!(await phone.count())) return false;
  await phone.getByRole('button', { name: chip }).click();
  await phone.locator('.send-reply').click();
  await phone.locator('.offer-done').or(page.locator('#approve-moves')).first().waitFor({ timeout: 45_000 });
  return true;
};
const counterSent = await answer(/Rochat/, 'Counter (FR)');
const yesSent = await answer(/Meier/, 'Yes (DE)');
if (!counterSent || !yesSent) {
  // Planner chose other customers: accept the rest with the button.
  for (let i = 0; i < 6; i++) {
    const b = page.locator('.phone .btn.primary:not([disabled])').first();
    if (!(await b.count())) break;
    await b.click();
    await page.waitForTimeout(800);
  }
}
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/3b-agent-replies.png`, fullPage: true });
await page.locator('#approve-moves').waitFor({ timeout: 10_000 });
await page.screenshot({ path: `${out}/3c-owner-approval.png`, fullPage: true });
await page.locator('#approve-moves').click();
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
