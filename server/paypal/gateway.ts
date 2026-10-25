// PayPal service layer. Every money move in Takt goes through this interface.
// Two implementations: MockPayPal (offline, deterministic, emits webhook-shaped events) and RestPayPal
// (real sandbox REST calls via fetch). Selected by PAYPAL_MODE in .env.

export interface Money {
  currency: string;
  value: number; // major units, e.g. 680.5
}

export interface CreateAuthorizeOrderInput {
  referenceId: string;
  invoiceId: string;
  description: string;
  amount: Money;
  returnUrl?: string;
  cancelUrl?: string;
  /** experience_context.locale for PayPal's approval pages, e.g. en-CH (BCP-47; sandbox accepts en-CH, en-GB, en-US). */
  locale?: string;
}

export interface OrderResult {
  orderId: string;
  /** Sandbox-verified 2026-10-25: a PayPal-wallet order starts as PAYER_ACTION_REQUIRED (not CREATED), then APPROVED, then COMPLETED. */
  status: string; // PAYER_ACTION_REQUIRED | CREATED | APPROVED | COMPLETED
  approveUrl?: string;
  payerEmail?: string;
}

export interface AuthorizationResult {
  orderId: string;
  authorizationId: string;
  status: string; // CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED ...
  amount: Money;
  expirationTime?: string;
}

export interface CaptureInput {
  amount: Money;
  finalCapture: boolean;
  invoiceId?: string;
  noteToPayer?: string;
  /** PayPal-Request-Id: the same key within one demo run makes a retried/double-clicked capture idempotent. */
  requestId?: string;
}

export interface CaptureResult {
  captureId: string;
  status: string; // COMPLETED | PENDING
  amount: Money;
}

export interface RefundResult {
  refundId: string;
  status: string;
  amount: Money;
}

export interface PayoutItemInput {
  receiverEmail: string;
  amount: Money;
  note: string;
  senderItemId: string;
}

export interface PayoutItemStatus {
  payoutItemId: string;
  senderItemId?: string;
  receiver?: string;
  /** SUCCESS | UNCLAIMED | PENDING | ONHOLD | FAILED | RETURNED | BLOCKED | REFUNDED | DENIED */
  status: string;
  errorName?: string;
  fee?: Money;
}

export interface PayoutResult {
  payoutBatchId: string;
  batchStatus: string; // PENDING | PROCESSING | SUCCESS | DENIED | CANCELED
  items?: PayoutItemStatus[];
}

/** A webhook-shaped event. In mock mode the gateway generates these; in sandbox mode PayPal POSTs them. */
export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  create_time: string;
  resource_type: string;
  summary: string;
  resource: Record<string, unknown>;
}

export interface PayPalGateway {
  readonly mode: 'mock' | 'sandbox';
  readonly clientId?: string;
  createAuthorizeOrder(input: CreateAuthorizeOrderInput): Promise<OrderResult>;
  getOrder(orderId: string): Promise<OrderResult>;
  /** Mock only: simulates the buyer approving in the PayPal popup. In sandbox the JS SDK does this. */
  simulateBuyerApproval?(orderId: string): Promise<void>;
  authorizeOrder(orderId: string): Promise<AuthorizationResult>;
  getAuthorization(authorizationId: string): Promise<AuthorizationResult>;
  /**
   * Sandbox seeding only: an AUTHORIZE order funded by a sandbox test card (payment_source.card), which PayPal
   * authorizes immediately without a buyer step. Gives the seeded bookings real authorizations to capture/void.
   */
  createCardAuthorization?(input: CreateAuthorizeOrderInput): Promise<AuthorizationResult>;
  captureAuthorization(authorizationId: string, input: CaptureInput): Promise<CaptureResult>;
  voidAuthorization(authorizationId: string): Promise<{ status: string }>;
  reauthorize(authorizationId: string, amount: Money): Promise<AuthorizationResult>;
  refundCapture(captureId: string, amount: Money | undefined, noteToPayer: string): Promise<RefundResult>;
  createPayout(batchId: string, emailSubject: string, items: PayoutItemInput[]): Promise<PayoutResult>;
  getPayout(payoutBatchId: string): Promise<PayoutResult>;
  /** Browser-safe client token for the JS SDK v6 (POST /v1/oauth2/token, response_type=client_token). Sandbox only. */
  clientToken?(): Promise<{ clientToken: string; expiresIn: number }>;
  getCapture(captureId: string): Promise<CaptureResult>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean>;
  /** Subscribe to (mock-generated or real, verified) webhook events. Returns an unsubscribe function. */
  onEvent(handler: (e: PayPalWebhookEvent) => void): () => void;
  /** Called by the webhook route after verification (sandbox), or internally (mock). */
  dispatch(e: PayPalWebhookEvent): void;
}

export const fmt = (m: Money) => m.value.toFixed(2);
