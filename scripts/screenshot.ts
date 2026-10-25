// Demo-path end-to-end run in headless Chromium: walks the "wow" flow like a judge would, checks each step and saves
// screenshots (owner console at 1440×900, customer offer page at 390×844).
//
//   npm run dev            (or npm run build && npm start, then pass http://localhost:8787)
//   npm run screenshot [baseUrl]
//
// Env: SCREENSHOT_DIR (default docs/screenshots) · DEMO_SAMPLE (rush sample chip, default: the cold-open email = DE)
//      DEMO_RUNS (mock: repeat the path N times with Reset demo in between, default 1)
//      DEMO_CANCEL_FIRST=1 (the rush buyer cancels once on the PayPal page before approving)
//      PAY_VIA=sdk|redirect (sandbox, default sdk: JS SDK v6 popup; redirect = the fallback link)
//      DEMO_CANCEL_RUSH=1 (after shipping J-2044: cancel the rush = void its authorization)
// Sandbox mode is detected from /api/config; the buyer step then runs on paypal.com (scripts/paypal-approve.ts).
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true }); // sandbox buyer login, if set
import { chromium, type Browser, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { approveInPopup, approveInSandbox, cancelPopup } from './paypal-approve.js';

const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.env.SCREENSHOT_DIR ?? 'docs/screenshots';
const sample = process.env.DEMO_SAMPLE;
const runs = Number(process.env.DEMO_RUNS ?? 1);
const cancelFirst = process.env.DEMO_CANCEL_FIRST === '1';
const payVia = process.env.PAY_VIA ?? 'sdk';
const cancelRush = process.env.DEMO_CANCEL_RUSH === '1';
mkdirSync(out, { recursive: true });
// Pages behind the sandbox buyer's login (funding instruments, account language) go to a gitignored folder.
const privateOut = process.env.PRIVATE_SCREENSHOT_DIR ?? 'qa/sandbox';
mkdirSync(privateOut, { recursive: true });

const results: { step: string; ok: boolean; detail?: string }[] = [];
const check = (step: string, ok: boolean, detail = '') => {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `: ${detail}` : ''}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'en-GB' });
const page = await ctx.newPage();
const consoleErrors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const sandbox = (await (await page.request.get(`${base}/api/config`)).json()).paypalMode === 'sandbox';
console.log(`Demo path on ${base} (PayPal ${sandbox ? 'sandbox' : 'mock'})\n`);

const shot = (name: string, full = false) => page.screenshot({ path: `${out}/${name}.png`, fullPage: full });

async function answer(who: RegExp, chip: string) {
  const phone = page.locator('.phone', { hasText: who });
  if (!(await phone.count())) return false;
  await phone.locator('.demo-helper summary').click();
  await phone.getByRole('button', { name: chip }).click();
  await phone.locator('.send-reply').click();
  await phone.locator('.offer-done').or(page.locator('#approve-moves')).first().waitFor({ timeout: 45_000 });
  return true;
}

async function cancelOnPayPal(b: Browser, url: string) {
  const c = await b.newContext({ locale: 'en-GB' });
  const p = await c.newPage();
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(6000);
    const link = p.locator('#cancelLink, a[data-testid="cancel-link"]').or(p.getByText(/Cancel and return|Abbrechen und zurück|Cancelar y volver|Annuler et revenir/i)).first();
    await link.waitFor({ timeout: 40_000 });
    await p.screenshot({ path: `${out}/4c-sandbox-paypal-before-cancel.png` }).catch(() => {});
    await link.click();
    await p.waitForURL((u) => !u.hostname.endsWith('paypal.com'), { timeout: 40_000 });
    return p.url();
  } finally {
    await c.close();
  }
}

for (let run = 1; run <= runs; run++) {
  const tag = runs > 1 ? `run ${run}: ` : '';
  await page.goto(base);
  await page.getByRole('button', { name: 'Reset demo' }).click();
  // Cold open: full shop -> email slides in -> hook line (CSS-timed).
  await page.waitForTimeout(5200);
  check(`${tag}cold open shows the full shop, the rush email and the hook`, await page.locator('.story .hook').isVisible() && await page.locator('.mail-toast').isVisible());
  if (run === 1) await shot('0-cold-open');
  await page.getByRole('button', { name: 'Open request' }).click();
  if (sample) await page.getByRole('button', { name: sample, exact: true }).click();
  await page.getByRole('button', { name: 'Let Takt read it' }).click();
  await page.locator('.extracted').waitFor({ timeout: 30_000 });
  if (run === 1) await shot('1-intake');
  await page.getByRole('button', { name: 'Make room' }).click();
  await page.waitForSelector('text=Takt can make room', { timeout: 45_000 });
  await page.waitForTimeout(400);
  if (run === 1) await shot('2-make-room');
  await page.getByRole('button', { name: /^Send \d offers?$/ }).click();
  await page.waitForSelector('.phone');
  if (run === 1) {
    await shot('3-offers', true);
    // The customer's view on a real phone: no bezel, localised dates, demo helper collapsed.
    const phone = await ctx.newPage();
    await phone.setViewportSize({ width: 390, height: 844 });
    await phone.goto(`${base}/#/offer/OF-J-2044`);
    await phone.locator('.phone-screen').waitFor();
    check('customer page (FR) shows French dates', /(lun|mar|mer|jeu|ven)\. \d/.test(await phone.locator('.offer-dates').innerText()));
    await phone.screenshot({ path: `${out}/m-offer-rochat.png`, fullPage: true });
    await phone.close();
  }
  const counter = await answer(/Rochat/, 'Counter (FR)');
  const yes = await answer(/Meier/, 'Yes (DE)');
  check(`${tag}Rochat (FR counter) and Meier (DE yes) answered in free text`, counter && yes);
  const badge = await page.locator('.badge[class*="agent-"]').innerText();
  check(`${tag}agent ran on recorded Claude, not the fallback`, !/fallback/i.test(badge), badge);
  await page.waitForTimeout(300);
  if (run === 1) await shot('3b-agent-replies', true);
  await page.locator('#approve-moves').waitFor({ timeout: 10_000 });
  if (run === 1) await shot('3c-owner-approval', true);
  await page.locator('#approve-moves').click();

  if (sandbox && payVia === 'sdk') {
    // JS SDK v6: <paypal-button> in the rush checkout opens PayPal in a popup; onApprove -> POST /api/rush/authorize.
    const button = page.locator('#paypal-sdk-button');
    await button.waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.sdk-pay small', { hasText: 'JS SDK v6' }).waitFor({ timeout: 20_000 }).catch(() => {});
    await page.locator('.phone.checkout').scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500); // the button renders inside its shadow root
    await shot('4a-sandbox-sdk-button');
    const sdkInfo = await page.locator('.sdk-pay small').first().innerText();
    check('JS SDK v6 button rendered (client token, English locale)', /client token/.test(sdkInfo) && /locale en/.test(sdkInfo), sdkInfo);
    if (cancelFirst) {
      const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 30_000 }), button.click()]);
      await cancelPopup(popup);
      await page.locator('#paypal-notice').waitFor({ timeout: 20_000 });
      check('closing the PayPal popup shows the onCancel notice', /closed the PayPal window/.test(await page.locator('#paypal-notice').innerText()));
      await shot('4d-sandbox-buyer-cancelled');
    }
    const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 30_000 }), button.click()]);
    await popup.waitForLoadState('domcontentloaded');
    check('PayPal popup opens on sandbox.paypal.com', /sandbox\.paypal\.com/.test(popup.url()), new URL(popup.url()).hostname);
    const lang = await popup.evaluate(() => document.documentElement.lang).catch(() => '');
    await approveInPopup(popup, `${privateOut}/4b-sandbox-paypal-popup-review.png`, `${out}/4b-sandbox-paypal-popup-login.png`);
    check('PayPal login page in the popup is English (before the buyer logs in)', /^en/i.test(lang), `html lang="${lang}"`);
    await page.waitForSelector('text=Schedule committed', { timeout: 90_000 });
    const viaSdk = await page.evaluate(async () => (await (await fetch('/api/state')).json()).rushOrder.paypal.some((s: { label: string }) => /JS SDK v6 onApprove/.test(s.label)));
    check('authorized through onApprove (JS SDK), not the redirect', viaSdk);
  } else if (sandbox) {
    const link = page.locator('#paypal-approve');
    await link.waitFor({ timeout: 30_000 });
    await shot('4a-sandbox-awaiting-approval');
    const url = (await link.getAttribute('href'))!;
    if (cancelFirst) {
      try {
        const back = await cancelOnPayPal(browser, url);
        check('PayPal cancel returns to the app', /paypal=cancelled/.test(back), back.replace(/token=[^&]+/, 'token=…'));
        await page.locator('#paypal-notice').waitFor({ timeout: 15_000 });
        check('console shows the buyer-cancelled notice', /cancelled on the PayPal page/.test(await page.locator('#paypal-notice').innerText()));
        await shot('4d-sandbox-buyer-cancelled');
      } catch (e) {
        check('PayPal cancel step', false, (e as Error).message.split('\n')[0]);
      }
    }
    await approveInSandbox(browser, url, `${privateOut}/4b-sandbox-paypal-checkout.png`);
    await page.waitForSelector('text=Schedule committed', { timeout: 90_000 });
  } else {
    if (cancelFirst || run === 1) {
      await page.getByRole('button', { name: 'Buyer cancels (mock)' }).click();
      await page.locator('#paypal-notice').waitFor({ timeout: 5000 });
      check(`${tag}buyer cancel (mock) shows a clear notice`, /cancelled on the PayPal page/.test(await page.locator('#paypal-notice').innerText()));
      if (run === 1) await shot('4d-buyer-cancelled');
    }
    await page.getByRole('button', { name: /Pay with PayPal/ }).click();
    await page.waitForSelector('text=Schedule committed', { timeout: 10_000 });
  }
  check(`${tag}schedule committed after PayPal confirmed`, true);
  await page.waitForTimeout(800);
  if (run === 1) await shot('4-committed');
  // Settle: ship Rochat's table frames = capture less on his authorization (final_capture=true).
  const row = page.locator('.settle .offer-row', { hasText: 'J-2044' });
  await row.getByRole('button', { name: 'Ship' }).click();
  await row.locator('.good').waitFor({ timeout: sandbox ? 30_000 : 5000 }).catch(() => {});
  const settled = (await row.innerText()).replace(/\s+/g, ' ');
  const err = (await page.locator('.flow .callout.bad').count()) ? await page.locator('.flow .callout.bad').innerText() : '';
  check(`${tag}Ship J-2044 captures less (no error)`, /captured CHF 2.610 of CHF 2.680/.test(settled) && !err, err || settled);
  if (run === 1) {
    await row.locator('xpath=..').locator('details.pp-box summary').click();
    await page.waitForTimeout(300);
    await shot('5-settled');
    const job = page.locator('.settle-job[data-job="J-2044"]');
    await job.getByRole('button', { name: 'Check in PayPal' }).click();
    await job.locator('.src-live-check').first().waitFor({ timeout: sandbox ? 30_000 : 5000 });
    check('Check in PayPal reads the live status (GET authorization + capture)', /CAPTURED/.test(await job.locator('.pp-trail').innerText()));
    await job.screenshot({ path: `${out}/5b-paypal-timeline.png` });
  }
  if (cancelRush || run === 1) {
    const rushJob = page.locator('.settle-job', { hasText: '(rush)' });
    await rushJob.getByRole('button', { name: 'Cancel rush (void)' }).click();
    await rushJob.locator('.bad-text').waitFor({ timeout: sandbox ? 30_000 : 5000 });
    check(`${tag}cancel rush voids its authorization`, /hold voided/.test(await rushJob.innerText()));
    await rushJob.locator('details.pp-box summary').click();
    await page.waitForTimeout(sandbox ? 3000 : 1200);
    if (run === 1) await rushJob.screenshot({ path: `${out}/6-rush-cancelled-void.png` });
  }
}

check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed · screenshots in ${out}`);
process.exit(failed.length ? 1 : 0);
