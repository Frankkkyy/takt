// Offline PayPal: same contract as the REST client, deterministic IDs, emits webhook-shaped events after a short
// delay so the UI exercises the same "only commit when PayPal confirms" path it will use in sandbox.
// The UI labels this mode clearly ("PayPal: MOCK") — it is a development tool, never shown in the video.
import type {
  AuthorizationResult, CaptureInput, CaptureResult, CreateAuthorizeOrderInput, Money, OrderResult,
  PayPalGateway, PayPalWebhookEvent, PayoutItemInput, PayoutResult, RefundResult,
} from './gateway.js';

interface MockOrder { id: string; status: string; amount: Money; authId?: string; invoiceId: string }
interface MockAuth { id: string; orderId: string; status: string; amount: Money; captured: number }

export class MockPayPal implements PayPalGateway {
  readonly mode = 'mock' as const;
  readonly clientId = undefined;
  private n = 0;
  private orders = new Map<string, MockOrder>();
  private auths = new Map<string, MockAuth>();
  private captures = new Map<string, { id: string; amount: Money; refunded: number }>();
  private payouts = new Map<string, PayoutResult>();
  private handlers: ((e: PayPalWebhookEvent) => void)[] = [];
  constructor(private delayMs = 700) {}

  private id(prefix: string) {
    this.n++;
    return `${prefix}${(1e6 + this.n * 7919).toString(36).toUpperCase()}MOCK`;
  }
  private emit(event_type: string, resource_type: string, summary: string, resource: Record<string, unknown>) {
    const e: PayPalWebhookEvent = { id: this.id('WH-'), event_type, resource_type, summary, resource, create_time: new Date().toISOString() };
    setTimeout(() => this.dispatch(e), this.delayMs);
  }
  onEvent(h: (e: PayPalWebhookEvent) => void) { this.handlers.push(h); }
  dispatch(e: PayPalWebhookEvent) { for (const h of this.handlers) h(e); }

  async createAuthorizeOrder(input: CreateAuthorizeOrderInput): Promise<OrderResult> {
    const id = this.id('ORD-');
    this.orders.set(id, { id, status: 'CREATED', amount: input.amount, invoiceId: input.invoiceId });
    return { orderId: id, status: 'CREATED' };
  }
  async getOrder(orderId: string): Promise<OrderResult> {
    const o = this.orders.get(orderId);
    if (!o) throw new Error('RESOURCE_NOT_FOUND');
    return { orderId, status: o.status };
  }
  async simulateBuyerApproval(orderId: string) {
    const o = this.orders.get(orderId);
    if (!o) throw new Error('RESOURCE_NOT_FOUND');
    o.status = 'APPROVED';
    this.emit('CHECKOUT.ORDER.APPROVED', 'checkout-order', `An order has been approved by buyer`, { id: orderId, status: 'APPROVED' });
  }
  async authorizeOrder(orderId: string): Promise<AuthorizationResult> {
    const o = this.orders.get(orderId);
    if (!o) throw new Error('RESOURCE_NOT_FOUND');
    if (o.status !== 'APPROVED') throw new Error('ORDER_NOT_APPROVED');
    const authId = this.id('AUTH-');
    o.status = 'COMPLETED';
    o.authId = authId;
    this.auths.set(authId, { id: authId, orderId, status: 'CREATED', amount: o.amount, captured: 0 });
    const expirationTime = new Date(Date.now() + 29 * 864e5).toISOString();
    this.emit('PAYMENT.AUTHORIZATION.CREATED', 'authorization', `A payment authorization was created`, { id: authId, status: 'CREATED', amount: o.amount, supplementary_data: { related_ids: { order_id: orderId } } });
    return { orderId, authorizationId: authId, status: 'CREATED', amount: o.amount, expirationTime };
  }
  async captureAuthorization(authorizationId: string, input: CaptureInput): Promise<CaptureResult> {
    // Seeded bookings have SEED-AUTH ids: accept them so the demo can settle pre-existing jobs.
    let a = this.auths.get(authorizationId);
    if (!a && authorizationId.startsWith('SEED-AUTH')) {
      a = { id: authorizationId, orderId: '', status: 'CREATED', amount: input.amount, captured: 0 };
      this.auths.set(authorizationId, a);
    }
    if (!a) throw new Error('RESOURCE_NOT_FOUND');
    if (a.status === 'CAPTURED' || a.status === 'VOIDED') throw new Error('AUTHORIZATION_ALREADY_CAPTURED');
    a.captured += input.amount.value;
    a.status = input.finalCapture ? 'CAPTURED' : 'PARTIALLY_CAPTURED';
    const captureId = this.id('CAP-');
    this.captures.set(captureId, { id: captureId, amount: input.amount, refunded: 0 });
    this.emit('PAYMENT.CAPTURE.COMPLETED', 'capture', `Payment completed for ${input.amount.currency} ${input.amount.value.toFixed(2)}`, { id: captureId, status: 'COMPLETED', amount: input.amount, final_capture: input.finalCapture, note_to_payer: input.noteToPayer, supplementary_data: { related_ids: { authorization_id: authorizationId } } });
    return { captureId, status: 'COMPLETED', amount: input.amount };
  }
  async voidAuthorization(authorizationId: string) {
    const a = this.auths.get(authorizationId) ?? { id: authorizationId, orderId: '', status: 'CREATED', amount: { currency: 'CHF', value: 0 }, captured: 0 };
    a.status = 'VOIDED';
    this.auths.set(authorizationId, a);
    this.emit('PAYMENT.AUTHORIZATION.VOIDED', 'authorization', 'A payment authorization was voided', { id: authorizationId, status: 'VOIDED' });
    return { status: 'VOIDED' };
  }
  async reauthorize(authorizationId: string, amount: Money): Promise<AuthorizationResult> {
    // Mirrors PayPal: not allowed inside the 3-day honor period. Mock auths are always "fresh".
    throw Object.assign(new Error('REAUTHORIZATION_TOO_SOON'), { authorizationId, amount });
  }
  async refundCapture(captureId: string, amount: Money | undefined, noteToPayer: string): Promise<RefundResult> {
    const c = this.captures.get(captureId);
    const amt = amount ?? c?.amount ?? { currency: 'CHF', value: 0 };
    const refundId = this.id('REF-');
    this.emit('PAYMENT.CAPTURE.REFUNDED', 'refund', `A ${amt.currency} ${amt.value.toFixed(2)} capture payment was refunded`, { id: refundId, status: 'COMPLETED', amount: amt, note_to_payer: noteToPayer });
    return { refundId, status: 'COMPLETED', amount: amt };
  }
  async createPayout(batchId: string, _subject: string, items: PayoutItemInput[]): Promise<PayoutResult> {
    const payoutBatchId = this.id('PB-');
    const res = { payoutBatchId, batchStatus: 'PENDING' };
    this.payouts.set(payoutBatchId, res);
    setTimeout(() => {
      res.batchStatus = 'SUCCESS';
      for (const it of items) {
        this.dispatch({ id: this.id('WH-'), event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource_type: 'payouts_item', create_time: new Date().toISOString(), summary: `Payout item ${it.senderItemId} succeeded`, resource: { payout_batch_id: payoutBatchId, payout_item: { receiver: it.receiverEmail, amount: { value: it.amount.value.toFixed(2), currency: it.amount.currency }, sender_item_id: it.senderItemId }, transaction_status: 'SUCCESS' } });
      }
    }, this.delayMs * 2);
    void batchId;
    return { ...res };
  }
  async getPayout(payoutBatchId: string): Promise<PayoutResult> {
    const p = this.payouts.get(payoutBatchId);
    if (!p) throw new Error('RESOURCE_NOT_FOUND');
    return { ...p };
  }
  async verifyWebhook() { return true; }
}
