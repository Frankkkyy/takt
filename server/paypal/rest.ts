// Real PayPal sandbox client over REST (fetch, no SDK): maps 1:1 to developer.paypal.com docs.
// Status: written against the docs (see docs/SPIKE.md), NOT yet exercised — needs PAYPAL_CLIENT_ID/SECRET.
import { randomUUID } from 'node:crypto';
import type {
  AuthorizationResult, CaptureInput, CaptureResult, CreateAuthorizeOrderInput, Money, OrderResult,
  PayPalGateway, PayPalWebhookEvent, PayoutItemInput, PayoutResult, RefundResult,
} from './gateway.js';
import { fmt } from './gateway.js';

const BASE = { sandbox: 'https://api-m.sandbox.paypal.com' };

export class PayPalApiError extends Error {
  constructor(public status: number, public issue: string, public debugId: string | undefined, public body: unknown) {
    super(`PayPal ${status} ${issue}${debugId ? ` (debug_id ${debugId})` : ''}`);
  }
}

type Json = Record<string, any>;

export class RestPayPal implements PayPalGateway {
  readonly mode = 'sandbox' as const;
  private token?: { value: string; exp: number };
  private handlers: ((e: PayPalWebhookEvent) => void)[] = [];

  constructor(readonly clientId: string, private secret: string, private webhookId?: string, private base = BASE.sandbox) {}

  onEvent(h: (e: PayPalWebhookEvent) => void) { this.handlers.push(h); }
  dispatch(e: PayPalWebhookEvent) { for (const h of this.handlers) h(e); }

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
    if (!res.ok) throw new PayPalApiError(res.status, body.error ?? 'AUTH_FAILED', undefined, body);
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
    return { orderId: r.id, status: r.status, approveUrl: r.links?.find((l: Json) => l.rel === 'payer-action' || l.rel === 'approve')?.href };
  }

  async getOrder(orderId: string): Promise<OrderResult> {
    const r = await this.call('GET', `/v2/checkout/orders/${orderId}`);
    return { orderId: r.id, status: r.status };
  }

  async authorizeOrder(orderId: string): Promise<AuthorizationResult> {
    const r = await this.call('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${orderId}`);
    const a = r.purchase_units?.[0]?.payments?.authorizations?.[0];
    return {
      orderId,
      authorizationId: a.id,
      status: a.status,
      amount: { currency: a.amount.currency_code, value: Number(a.amount.value) },
      expirationTime: a.expiration_time,
    };
  }

  async captureAuthorization(authorizationId: string, i: CaptureInput): Promise<CaptureResult> {
    const r = await this.call('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {
      amount: this.money(i.amount),
      final_capture: i.finalCapture,
      ...(i.invoiceId ? { invoice_id: i.invoiceId } : {}),
      ...(i.noteToPayer ? { note_to_payer: i.noteToPayer.slice(0, 255) } : {}),
    }, randomUUID());
    return { captureId: r.id, status: r.status, amount: { currency: r.amount.currency_code, value: Number(r.amount.value) } };
  }

  async voidAuthorization(authorizationId: string) {
    await this.call('POST', `/v2/payments/authorizations/${authorizationId}/void`, undefined, randomUUID());
    return { status: 'VOIDED' };
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
    return { refundId: r.id, status: r.status, amount: amount ?? { currency: r.amount?.currency_code, value: Number(r.amount?.value) } };
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
    return { payoutBatchId: r.batch_header.payout_batch_id, batchStatus: r.batch_header.batch_status };
  }

  async getPayout(payoutBatchId: string): Promise<PayoutResult> {
    const r = await this.call('GET', `/v1/payments/payouts/${payoutBatchId}`);
    return { payoutBatchId, batchStatus: r.batch_header.batch_status };
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
