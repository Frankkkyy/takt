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
}

export interface OrderResult {
  orderId: string;
  status: string; // CREATED | APPROVED | COMPLETED
  approveUrl?: string;
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

export interface PayoutResult {
  payoutBatchId: string;
  batchStatus: string; // PENDING | PROCESSING | SUCCESS | DENIED
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
  captureAuthorization(authorizationId: string, input: CaptureInput): Promise<CaptureResult>;
  voidAuthorization(authorizationId: string): Promise<{ status: string }>;
  reauthorize(authorizationId: string, amount: Money): Promise<AuthorizationResult>;
  refundCapture(captureId: string, amount: Money | undefined, noteToPayer: string): Promise<RefundResult>;
  createPayout(batchId: string, emailSubject: string, items: PayoutItemInput[]): Promise<PayoutResult>;
  getPayout(payoutBatchId: string): Promise<PayoutResult>;
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): Promise<boolean>;
  /** Subscribe to (mock-generated or real, verified) webhook events. */
  onEvent(handler: (e: PayPalWebhookEvent) => void): void;
  /** Called by the webhook route after verification (sandbox), or internally (mock). */
  dispatch(e: PayPalWebhookEvent): void;
}

export const fmt = (m: Money) => m.value.toFixed(2);
