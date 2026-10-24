// Walks the demo path in headless Chromium and saves screenshots to docs/screenshots/.
// Usage: npm run dev (in another shell), then npm run screenshot [baseUrl]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = 'docs/screenshots';
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
for (let i = 0; i < 5; i++) {
  const b = page.locator('.phone .btn.primary').first();
  if (!(await b.count())) break;
  await b.click();
  await page.waitForTimeout(300);
}
await page.getByRole('button', { name: /Pay with PayPal/ }).click();
await page.waitForSelector('text=Schedule committed', { timeout: 10_000 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/4-committed.png` });
await browser.close();
console.log('screenshots in', out);
