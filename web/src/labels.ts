// Display-only wording for log titles that come from the server. The raw text stays in the data (and in a tooltip /
// small mono tag), so phase grouping, tests and scripts keep matching the server's own strings.

/** PayPal webhook event types in plain English. */
const PAYPAL_EVENT: Record<string, string> = {
  'CHECKOUT.ORDER.APPROVED': 'Order approved by the buyer',
  'CHECKOUT.ORDER.COMPLETED': 'Order completed',
  'PAYMENT.AUTHORIZATION.CREATED': 'Authorization created',
  'PAYMENT.AUTHORIZATION.VOIDED': 'Authorization voided',
  'PAYMENT.CAPTURE.COMPLETED': 'Capture completed',
  'PAYMENT.CAPTURE.PENDING': 'Capture pending',
  'PAYMENT.CAPTURE.DENIED': 'Capture denied',
  'PAYMENT.CAPTURE.REFUNDED': 'Capture refunded',
  'PAYMENT.PAYOUTSBATCH.SUCCESS': 'Payout batch succeeded',
  'PAYMENT.PAYOUTSBATCH.DENIED': 'Payout batch denied',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': 'Payout item succeeded',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED': 'Payout item unclaimed',
  'PAYMENT.PAYOUTS-ITEM.FAILED': 'Payout item failed',
};

const RAW_EVENT = /^[A-Z]+(\.[A-Z_-]+)+$/;

/** True for a raw PayPal event type such as PAYMENT.CAPTURE.COMPLETED. */
export const isPayPalEvent = (title: string) => RAW_EVENT.test(title);

/** "PAYMENT.AUTHORIZATION.CREATED" → "Authorization created"; unknown types are humanised the same way. */
export function paypalEventLabel(type: string): string {
  if (PAYPAL_EVENT[type]) return PAYPAL_EVENT[type];
  const words = type.split('.').slice(1).join(' ').replace(/[-_]/g, ' ').toLowerCase().replace(/^payouts?batch/, 'payout batch');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One spelling in the UI: "capture less" (the server logs "Capture-less booked …"). */
export function displayTitle(title: string): string {
  if (isPayPalEvent(title)) return paypalEventLabel(title);
  return title.replace(/^Capture-less\b/, 'Capture less').replace(/\bcapture-less\b/g, 'capture less');
}
