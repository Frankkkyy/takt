// Automates the PayPal sandbox buyer step in headless Chromium (tests and screenshots only).
//
// Two ways, verified on 2026-10-25:
// - With PAYPAL_SANDBOX_BUYER_EMAIL / PAYPAL_SANDBOX_BUYER_PASSWORD (a sandbox *personal* account from
//   developer.paypal.com > Testing Tools > Sandbox Accounts): log in and approve with the PayPal wallet.
// - Without them: PayPal's guest checkout ("Pay with credit or debit card") with a sandbox test card.
//   Card 4005519200000004 is accepted there; 4032039317984658 and 5555555555554444 are rejected ("couldn't add card").
import type { Browser, Page } from 'playwright';

const GUEST_CARD = { number: '4005519200000004', expiry: '1230', cvv: '123' };

async function fillIfVisible(page: Page, selector: string, value: string) {
  const l = page.locator(selector).first();
  if ((await l.count()) && (await l.isVisible())) await l.fill(value);
}

async function loginAndApprove(page: Page, email: string, password: string) {
  await page.locator('#email').fill(email);
  const next = page.locator('#btnNext');
  if (await next.isVisible()) await next.click();
  await page.locator('#password').fill(password);
  await page.locator('#btnLogin').click();
  // Review page: "Continue" / "Weiter" / "Agree & continue".
  const submit = page.locator('[data-testid="submit-button-initial"], #payment-submit-btn, button[data-id="payment-submit-btn"]').first();
  await submit.waitFor({ timeout: 60_000 });
  // The workspace sandbox buyer defaults to a SEPA bank account, which opens a direct-debit mandate (QA B9, verified
  // 2026-10-26). Pick the account's card funding instrument (data-testid "CC-…-fundingInstrument-container") instead.
  const card = page.locator('[data-testid^="CC-"][data-testid$="-fundingInstrument-container"]').first();
  if (await card.count()) {
    await card.click();
    await page.waitForTimeout(800);
  }
  await submit.click();
}

/** Returns false when PayPal served the card-form variant without a guest option (account signup required). */
async function guestApprove(page: Page): Promise<boolean> {
  await page.locator('#createAccount').click();
  await page.waitForURL(/signup/, { timeout: 30_000 });
  await page.locator('#cardNumber').waitFor({ timeout: 30_000 });
  // PayPal A/B-tests this page: one variant offers "No thanks" (guest), another demands a full account
  // (password, birth date, ID number). We never create accounts: report the variant and let the caller retry.
  await page.waitForTimeout(1500);
  if (!(await page.locator('#onboardOptionGuest').count())) return false;
  await page.locator('#cardNumber').pressSequentially(GUEST_CARD.number, { delay: 20 });
  await page.locator('#cardExpiry').pressSequentially(GUEST_CARD.expiry, { delay: 20 });
  await page.locator('#cardCvv').fill(GUEST_CARD.cvv);
  const fields: [string, string][] = [
    ['#firstName', 'Thomas'], ['#lastName', 'Schmid'], ['#billingLine1', 'Dorfstrasse 12'], ['#billingPostalCode', '6182'],
    ['#billingCity', 'Escholzmatt'], ['#phone', '0791234567'], ['#email', `thomas.schmid.${Date.now()}@example.com`],
  ];
  for (const [sel, v] of fields) await fillIfVisible(page, sel, v);
  // "No thanks" to opening a PayPal account (guest only, no account is created).
  await page.locator('label[for="onboardOptionGuest"]').click();
  await page.getByTestId('submit-button').click();
  return true;
}

/** Opens the approval URL and approves it. Resolves once PayPal redirects away (to return_url). */
export async function approveInSandbox(browser: Browser, approveUrl: string, screenshotPath?: string, attempts = 6): Promise<void> {
  const email = process.env.PAYPAL_SANDBOX_BUYER_EMAIL;
  const password = process.env.PAYPAL_SANDBOX_BUYER_PASSWORD;
  for (let i = 1; i <= attempts; i++) {
    // Fresh context per attempt = fresh cookies = a new roll of PayPal's page variant.
    const ctx = await browser.newContext({ locale: 'de-CH', viewport: { width: 1280, height: 1400 } });
    const page = await ctx.newPage();
    try {
      await page.goto(approveUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(6000); // the login/guest page hydrates late; clicking earlier is ignored
      if (email && password) await loginAndApprove(page, email, password);
      else if (!(await guestApprove(page))) {
        console.log(`      PayPal served the signup-only card form (attempt ${i}/${attempts}), retrying`);
        continue;
      }
      if (screenshotPath) await page.screenshot({ path: screenshotPath }).catch(() => {});
      await page.waitForURL((u) => !u.hostname.endsWith('paypal.com'), { timeout: 60_000 });
      return;
    } finally {
      await ctx.close();
    }
  }
  throw new Error(`Sandbox approval failed after ${attempts} attempts: approve manually at ${approveUrl}`);
}
