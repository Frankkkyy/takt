// Real PayPal sandbox client over REST (fetch, no SDK): maps 1:1 to developer.paypal.com docs.
// Verified end-to-end against api-m.sandbox.paypal.com on 2026-10-25 (see docs/SPIKE.md and scripts/sandbox-smoke.ts).
//
// No webhooks needed: after each money move the client reconciles by polling the resource and dispatches a
// webhook-shaped event (id prefixed "RECON-") through the same onEvent() path real, verified webhooks use.
import { randomUUID } from 'node:crypto';
import type {
  AuthorizationResult, CaptureInput, CaptureResult, CreateAuthorizeOrderInput, Money, OrderResult,
  PayPalGateway, PayPalWebhookEvent, PayoutItemInput, PayoutItemStatus, PayoutResult, RefundResult,
} from './gateway.js';
import { fmt } from './gateway.js';

const BASE = { sandbox: 'https://api-m.sandbox.paypal.com' };

/** PayPal's public sandbox test Visa. Authorizes immediately via payment_source.card (verified in CHF). */
export const SANDBOX_TEST_CARD = { number: '4032039317984658', expiry: '2030-12', security_code: '123' };

export class PayPalApiError extends Error {
  constructor(public status: number, public issue: string, public debugId: string | undefined, public body: unknown) {
    super(`PayPal ${status} ${issue}${debugId ? ` (debug_id ${debugId})` : ''}`);
  }
}

type Json = Record<string, any>;

export interface RestPayPalOptions {
  webhookId?: string;
  base?: string;
  /** Poll interval for reconciliation (ms). 0 disables background reconciliation (used by the smoke script). */
  reconcileMs?: number;
  /** Give up watching an unapproved order after this long (ms). */
  approvalTimeoutMs?: number;
}

const money = (a: Json): Money => ({ currency: a.currency_code ?? a.currency, value: Number(a.value) });
const TERMINAL_PAYOUT_ITEM = new Set(['SUCCESS', 'UNCLAIMED', 'FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'DENIED']);
const PAYOUT_ITEM_EVENT: Record<string, string> = {
  SUCCESS: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', UNCLAIMED: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED', FAILED: 'PAYMENT.PAYOUTS-ITEM.FAILED',
  RETURNED: 'PAYMENT.PAYOUTS-ITEM.RETURNED', BLOCKED: 'PAYMENT.PAYOUTS-ITEM.BLOCKED', REFUNDED: 'PAYMENT.PAYOUTS-ITEM.REFUNDED', DENIED: 'PAYMENT.PAYOUTS-ITEM.DENIED',
};

export class RestPayPal implements PayPalGateway {
  readonly mode = 'sandbox' as const;
  private token?: { value: string; exp: number };
  private handlers: ((e: PayPalWebhookEvent) => void)[] = [];
  private readonly webhookId?: string;
  private readonly base: string;
  private readonly reconcileMs: number;
  private readonly approvalTimeoutMs: number;

  constructor(readonly clientId: string, private secret: string, opts: RestPayPalOptions = {}) {
    this.webhookId = opts.webhookId;
    this.base = opts.base ?? BASE.sandbox;
    this.reconcileMs = opts.reconcileMs ?? 2500;
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 20 * 60_000;
  }

  onEvent(h: (e: PayPalWebhookEvent) => void) {
    this.handlers.push(h);
    return () => { this.handlers = this.handlers.filter((x) => x !== h); };
  }
  dispatch(e: PayPalWebhookEvent) { for (const h of [...this.handlers]) h(e); }

  private reconciled(event_type: string, resource_type: string, summary: string, resource: Json, key: string) {
    this.dispatch({ id: `RECON-${event_type}-${key}`, event_type, resource_type, summary, resource, create_time: new Date().toISOString() });
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.clientId}:${this.secret}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = (await res.json()) as Json;
    if (!res.ok) throw new PayPalApiError(res.status, body.error ?? 'AUTH_FAILED', undefined, { error: body.error });
    this.token = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
    return this.token.value;
  }

  private async call(method: string, path: string, body?: Json, idempotencyKey?: string): Promise<Json> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(idempotencyKey ? { 'PayPal-Request-Id': idempotencyKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Json) : {};
    if (!res.ok) {
      const issue = json.details?.[0]?.issue ?? json.name ?? 'UNKNOWN';
      throw new PayPalApiError(res.status, issue, json.debug_id, json);
    }
    return json;
  }

  private money(m: Money) { return { currency_code: m.currency, value: fmt(m) }; }

  private toAuth(orderId: string, a: Json): AuthorizationResult {
    return { orderId, authorizationId: a.id, status: a.status, amount: money(a.amount), expirationTime: a.expiration_time };
  }

  async createAuthorizeOrder(i: CreateAuthorizeOrderInput): Promise<OrderResult> {
    const r = await this.call('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: i.referenceId, invoice_id: i.invoiceId, description: i.description, amount: this.money(i.amount) }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'Takt demo shop',
            user_action: 'CONTINUE',
            shipping_preference: 'NO_SHIPPING',
            ...(i.returnUrl ? { return_url: i.returnUrl, cancel_url: i.cancelUrl ?? i.returnUrl } : {}),
          },
        },
      },
    }, randomUUID());
    if (this.reconcileMs > 0) void this.watchApproval(r.id);
    // Verified: status PAYER_ACTION_REQUIRED, approval link rel "payer-action" (…/checkoutnow?token={id}).
    return { orderId: r.id, status: r.status, approveUrl: r.links?.find((l: Json) => l.rel === 'payer-action' || l.rel === 'approve')?.href };
  }

  /** Reconcile instead of waiting for CHECKOUT.ORDER.APPROVED: poll the order until the buyer has approved. */
  private async watchApproval(orderId: string) {
    const until = Date.now() + this.approvalTimeoutMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, this.reconcileMs));
      try {
        const o = await this.getOrder(orderId);
        if (o.status === 'APPROVED' || o.status === 'COMPLETED') {
          this.reconciled('CHECKOUT.ORDER.APPROVED', 'checkout-order', 'Buyer approved the order (reconciled: GET /v2/checkout/orders/{id})', { id: orderId, status: o.status }, orderId);
          return;
        }
        if (o.status === 'VOIDED') return;
      } catch { /* transient: keep polling */ }
    }
  }

  async getOrder(orderId: string): Promise<OrderResult> {
    const r = await this.call('GET', `/v2/checkout/orders/${orderId}`);
    return { orderId: r.id, status: r.status, payerEmail: r.payer?.email_address };
  }

  async authorizeOrder(orderId: string): Promise<AuthorizationResult> {
    const r = await this.call('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${orderId}`);
    const auth = this.toAuth(orderId, r.purchase_units?.[0]?.payments?.authorizations?.[0]);
    if (this.reconcileMs > 0) void this.confirmAuthorization(auth.authorizationId, orderId);
    return auth;
  }

  /** Reconcile instead of waiting for PAYMENT.AUTHORIZATION.CREATED: read the authorization back. */
  private async confirmAuthorization(authorizationId: string, orderId: string) {
    for (let i = 0; i < 20; i++) {
      try {
        const a = await this.getAuthorization(authorizationId);
        if (a.status === 'CREATED' || a.status === 'PENDING') {
          this.reconciled('PAYMENT.AUTHORIZATION.CREATED', 'authorization', `Authorization ${a.status} for ${a.amount.currency} ${fmt(a.amount)} (reconciled: GET /v2/payments/authorizations/{id})`,
            { id: authorizationId, status: a.status, amount: { currency_code: a.amount.currency, value: fmt(a.amount) }, supplementary_data: { related_ids: { order_id: orderId } } }, authorizationId);
          return;
        }
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, this.reconcileMs));
    }
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationResult> {
    const a = await this.call('GET', `/v2/payments/authorizations/${authorizationId}`);
    return this.toAuth(a.supplementary_data?.related_ids?.order_id ?? '', a);
  }

  async createCardAuthorization(i: CreateAuthorizeOrderInput): Promise<AuthorizationResult> {
    const r = await this.call('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{ reference_id: i.referenceId, invoice_id: i.invoiceId, description: i.description, amount: this.money(i.amount) }],
      payment_source: { card: { ...SANDBOX_TEST_CARD, name: 'Takt Sandbox Seed' } },
    }, randomUUID());
    const a = r.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!a) throw new PayPalApiError(422, `CARD_AUTH_${r.status}`, undefined, { status: r.status });
    return this.toAuth(r.id, a);
  }

  async captureAuthorization(authorizationId: string, i: CaptureInput): Promise<CaptureResult> {
    const r = await this.call('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {
      amount: this.money(i.amount),
      final_capture: i.finalCapture,
      ...(i.invoiceId ? { invoice_id: i.invoiceId } : {}),
      ...(i.noteToPayer ? { note_to_payer: i.noteToPayer.slice(0, 255) } : {}),
    }, i.requestId ?? randomUUID());
    return { captureId: r.id, status: r.status, amount: money(r.amount) };
  }

  async voidAuthorization(authorizationId: string) {
    // With Prefer: return=representation the sandbox answers 200 + the authorization (status VOIDED).
    const r = await this.call('POST', `/v2/payments/authorizations/${authorizationId}/void`, undefined, randomUUID());
    return { status: r.status ?? 'VOIDED' };
  }

  async reauthorize(authorizationId: string, amount: Money): Promise<AuthorizationResult> {
    const r = await this.call('POST', `/v2/payments/authorizations/${authorizationId}/reauthorize`, { amount: this.money(amount) }, randomUUID());
    return { orderId: '', authorizationId: r.id, status: r.status, amount, expirationTime: r.expiration_time };
  }

  async refundCapture(captureId: string, amount: Money | undefined, noteToPayer: string): Promise<RefundResult> {
    const r = await this.call('POST', `/v2/payments/captures/${captureId}/refund`, {
      ...(amount ? { amount: this.money(amount) } : {}),
      note_to_payer: noteToPayer.slice(0, 255),
    }, randomUUID());
    return { refundId: r.id, status: r.status, amount: r.amount ? money(r.amount) : amount! };
  }

  async createPayout(batchId: string, emailSubject: string, items: PayoutItemInput[]): Promise<PayoutResult> {
    const r = await this.call('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: batchId, email_subject: emailSubject },
      items: items.map((it) => ({
        recipient_type: 'EMAIL',
        receiver: it.receiverEmail,
        amount: { value: fmt(it.amount), currency: it.amount.currency },
        note: it.note,
        sender_item_id: it.senderItemId,
        recipient_wallet: 'PAYPAL',
      })),
    });
    const id = r.batch_header.payout_batch_id;
    if (this.reconcileMs > 0) void this.watchPayout(id);
    return { payoutBatchId: id, batchStatus: r.batch_header.batch_status };
  }

  /** Verified: batch PENDING → PROCESSING → SUCCESS in ~20 s; items settle to SUCCESS or UNCLAIMED. */
  private async watchPayout(payoutBatchId: string) {
    const done = new Set<string>();
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => setTimeout(r, Math.max(this.reconcileMs, 3000)));
      try {
        const p = await this.getPayout(payoutBatchId);
        for (const it of p.items ?? []) {
          if (done.has(it.payoutItemId) || !TERMINAL_PAYOUT_ITEM.has(it.status)) continue;
          done.add(it.payoutItemId);
          this.reconciled(PAYOUT_ITEM_EVENT[it.status], 'payouts_item', `Payout item ${it.status}${it.errorName ? ` (${it.errorName})` : ''} (reconciled: GET /v1/payments/payouts/{id})`,
            { payout_item_id: it.payoutItemId, payout_batch_id: payoutBatchId, transaction_status: it.status, errors: it.errorName ? { name: it.errorName } : undefined, payout_item: { sender_item_id: it.senderItemId, receiver: it.receiver } }, it.payoutItemId);
        }
        const settled = (p.items?.length ?? 0) > 0 && p.items!.every((it) => done.has(it.payoutItemId));
        if (settled || p.batchStatus === 'DENIED' || p.batchStatus === 'CANCELED') return;
      } catch { /* keep polling */ }
    }
  }

  async getPayout(payoutBatchId: string): Promise<PayoutResult> {
    const r = await this.call('GET', `/v1/payments/payouts/${payoutBatchId}`);
    const items: PayoutItemStatus[] = (r.items ?? []).map((it: Json) => ({
      payoutItemId: it.payout_item_id,
      senderItemId: it.payout_item?.sender_item_id,
      receiver: it.payout_item?.receiver,
      status: it.transaction_status,
      errorName: it.errors?.name,
      fee: it.payout_item_fee ? money(it.payout_item_fee) : undefined,
    }));
    return { payoutBatchId, batchStatus: r.batch_header.batch_status, items };
  }

  async verifyWebhook(h: Record<string, string | undefined>, rawBody: string): Promise<boolean> {
    if (!this.webhookId) return false;
    const r = await this.call('POST', '/v1/notifications/verify-webhook-signature', {
      auth_algo: h['paypal-auth-algo'],
      cert_url: h['paypal-cert-url'],
      transmission_id: h['paypal-transmission-id'],
      transmission_sig: h['paypal-transmission-sig'],
      transmission_time: h['paypal-transmission-time'],
      webhook_id: this.webhookId,
      webhook_event: JSON.parse(rawBody),
    });
    return r.verification_status === 'SUCCESS';
  }
}
