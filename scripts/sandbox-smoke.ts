// Runs Takt's whole money story against the real PayPal sandbox (no mocks) and checks every result.
//
//   npm run smoke:sandbox                # full run, buyer approval automated in headless Chromium
//   npm run smoke:sandbox -- --no-browser   # prints the approval URL and funds the rush hold with a test card instead
//
// Needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env or in the parent workspace's .env. Never prints secrets.
// Optional: PAYPAL_SANDBOX_PAYOUT_RECEIVER (a sandbox personal account email: payout then ends SUCCESS, not UNCLAIMED),
// PAYPAL_SANDBOX_BUYER_EMAIL / PAYPAL_SANDBOX_BUYER_PASSWORD (approve with the PayPal wallet instead of guest card).
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import { RestPayPal, PayPalApiError } from '../server/paypal/rest.js';
import type { AuthorizationResult, Money } from '../server/paypal/gateway.js';
import { approveInSandbox } from './paypal-approve.js';

dotenv.config({ quiet: true });
dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname, quiet: true });
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) {
  console.error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET');
  process.exit(2);
}

const CUR = process.env.PAYPAL_CURRENCY ?? 'CHF';
const noBrowser = process.argv.includes('--no-browser');
const pp = new RestPayPal(id, secret, { reconcileMs: 0 }); // the script polls explicitly
const run = Date.now().toString(36);
const chf = (v: number): Money => ({ currency: CUR, value: v });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}: ${detail}`);
}
async function expectIssue(step: string, issue: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    check(step, false, `expected ${issue}, call succeeded`);
  } catch (e) {
    const got = e instanceof PayPalApiError ? e.issue : String(e);
    check(step, got === issue, `PayPal answered ${got}`);
  }
}

console.log(`Takt sandbox smoke run ${run} (${CUR})\n`);

// 1. Rush order: hold the rush price with intent=AUTHORIZE, buyer approves, server authorizes.
const rushPrice = 2055;
const order = await pp.createAuthorizeOrder({
  referenceId: `RUSH-${run}`, invoiceId: `TAKT-RUSH-${run}`, description: 'Rush: 6x harvester header bracket',
  amount: chf(rushPrice), returnUrl: 'https://example.com/takt-return',
});
check('rush order created', order.status === 'PAYER_ACTION_REQUIRED' && !!order.approveUrl, `${order.orderId} ${order.status}`);
let rushAuth: AuthorizationResult;
if (noBrowser) {
  console.log(`      approve manually: ${order.approveUrl}`);
  rushAuth = await pp.createCardAuthorization({ referenceId: `RUSH-${run}`, invoiceId: `TAKT-RUSH-${run}-card`, description: 'Rush (card-funded, --no-browser)', amount: chf(rushPrice) });
  check('rush authorized (test card, no browser)', rushAuth.status === 'CREATED', `${rushAuth.authorizationId} ${rushAuth.status}`);
} else {
  const browser = await chromium.launch();
  try {
    await approveInSandbox(browser, order.approveUrl!);
  } finally {
    await browser.close();
  }
  const approved = await pp.getOrder(order.orderId);
  check('buyer approved (headless sandbox checkout)', approved.status === 'APPROVED', `${approved.status}${approved.payerEmail ? `, payer ${approved.payerEmail.replace(/^(.{3}).*(@.*)$/, '$1…$2')}` : ''}`);
  rushAuth = await pp.authorizeOrder(order.orderId);
  check('rush authorized', rushAuth.status === 'CREATED' && rushAuth.amount.value === rushPrice, `${rushAuth.authorizationId} ${rushAuth.status} ${rushAuth.amount.currency} ${rushAuth.amount.value}, expires ${rushAuth.expirationTime}`);
}
const rushRead = await pp.getAuthorization(rushAuth.authorizationId);
check('rush authorization read back (reconcile)', rushRead.status === 'CREATED', rushRead.status);

// 2. Bumped customer who booked with an authorization: capture less (authorized − compensation), final_capture=true.
const booked = 2150, compensation = 50;
const bumped = await pp.createCardAuthorization({ referenceId: 'J-2042', invoiceId: `TAKT-J2042-${run}`, description: 'Booking J-2042: 60x dropout plates', amount: chf(booked) });
check('booked customer authorization', bumped.status === 'CREATED', `${bumped.authorizationId} ${CUR} ${bumped.amount.value}`);
const cap = await pp.captureAuthorization(bumped.authorizationId, {
  amount: chf(booked - compensation), finalCapture: true, invoiceId: `TAKT-J2042-${run}-cap`,
  noteToPayer: `${CUR} ${compensation} less than authorized: thank you for moving your delivery.`,
});
check('capture less, final_capture=true', cap.status === 'COMPLETED' && cap.amount.value === booked - compensation, `${cap.captureId} ${cap.status} ${cap.amount.currency} ${cap.amount.value}`);
const after = await pp.getAuthorization(bumped.authorizationId);
check('remainder released (authorization CAPTURED)', after.status === 'CAPTURED', `${after.status}; ${CUR} ${compensation} can no longer be captured`);
await expectIssue('second capture refused', 'AUTHORIZATION_ALREADY_CAPTURED', () =>
  pp.captureAuthorization(bumped.authorizationId, { amount: chf(1), finalCapture: true }));

// 3. Rush job ships: capture the full hold; then a partial refund (late-delivery policy).
const rushCap = await pp.captureAuthorization(rushAuth.authorizationId, { amount: chf(rushPrice), finalCapture: true, invoiceId: `TAKT-RUSH-${run}-cap` });
check('rush captured at shipment', rushCap.status === 'COMPLETED', `${rushCap.captureId} ${CUR} ${rushCap.amount.value}`);
const refund = await pp.refundCapture(rushCap.captureId, chf(20), 'Takt: CHF 20 back, delivered 2 hours late.');
check('partial refund', refund.status === 'COMPLETED' && refund.amount.value === 20, `${refund.refundId} ${refund.status} ${refund.amount.currency} ${refund.amount.value}`);

// 4. Cancellation: void an authorization.
const toVoid = await pp.createCardAuthorization({ referenceId: 'J-2061', invoiceId: `TAKT-J2061-${run}`, description: 'Booking J-2061 (cancelled)', amount: chf(2050) });
const voided = await pp.voidAuthorization(toVoid.authorizationId);
const voidRead = await pp.getAuthorization(toVoid.authorizationId);
check('void', voided.status === 'VOIDED' && voidRead.status === 'VOIDED', `${toVoid.authorizationId} ${voidRead.status}`);

// 5. Reauthorize is blocked during the 3-day honor period.
const fresh = await pp.createCardAuthorization({ referenceId: 'J-2048', invoiceId: `TAKT-J2048-${run}`, description: 'Booking J-2048 (long job)', amount: chf(300) });
await expectIssue('reauthorize on day 0 refused', 'REAUTHORIZATION_TOO_SOON', () => pp.reauthorize(fresh.authorizationId, chf(300)));
await pp.voidAuthorization(fresh.authorizationId);

// 6. Prepaid customer: Payout the compensation and poll until the item settles.
const receiver = process.env.PAYPAL_SANDBOX_PAYOUT_RECEIVER || 'nina.meier.takt@example.com';
const payout = await pp.createPayout(`takt-smoke-${run}`, 'Thank you for moving your slot', [
  { receiverEmail: receiver, amount: chf(45), note: 'Takt: thank you for moving J-2047', senderItemId: `OF-J-2047-${run}` },
]);
check('payout batch accepted', ['PENDING', 'PROCESSING', 'SUCCESS'].includes(payout.batchStatus), `${payout.payoutBatchId} ${payout.batchStatus}`);
let p = payout;
const t0 = Date.now();
for (let i = 0; i < 40; i++) {
  await sleep(5000);
  p = await pp.getPayout(payout.payoutBatchId);
  const st = p.items?.[0]?.status;
  if (st && st !== 'PENDING' && p.batchStatus !== 'PENDING' && p.batchStatus !== 'PROCESSING') break;
}
const item = p.items?.[0];
const expectSuccess = !!process.env.PAYPAL_SANDBOX_PAYOUT_RECEIVER;
check(`payout settled after ${Math.round((Date.now() - t0) / 1000)} s`,
  p.batchStatus === 'SUCCESS' && (expectSuccess ? item?.status === 'SUCCESS' : item?.status === 'SUCCESS' || item?.status === 'UNCLAIMED'),
  `batch ${p.batchStatus}, item ${item?.status}${item?.errorName ? ` (${item.errorName})` : ''}, fee ${item?.fee ? `${item.fee.currency} ${item.fee.value}` : '-'}${expectSuccess ? '' : ' — set PAYPAL_SANDBOX_PAYOUT_RECEIVER to a sandbox personal account for SUCCESS'}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
