// Domain types shared by server and web.
// Time model: the board covers N working days; each day has HOURS_PER_DAY working hours.
// A point in time is an hour index t (0 = Monday 07:00 of the first board week).

export const HOURS_PER_DAY = 8;
export const BOARD_DAYS = 10;

export type Lang = 'en' | 'de' | 'fr';

export interface Machine {
  id: string;
  name: string;
  kind: 'laser' | 'press-brake' | 'mill-5ax' | 'mill-3ax';
}

/**
 * How the customer pays for a booked job. This decides how Takt compensates a bump:
 *  - authorization: card/PayPal hold placed at booking (Orders v2 intent=AUTHORIZE). Compensation = capture less.
 *  - prepaid: customer already paid in full. Compensation = PayPal Payout to their PayPal email.
 */
export type PaymentTerms =
  | { kind: 'authorization'; orderId: string; authorizationId: string; authorizedChf: number }
  | { kind: 'prepaid'; paidChf: number; paidVia: 'paypal' | 'bank-transfer'; captureId?: string };

export interface Customer {
  id: string;
  name: string;
  contact: string;
  city: string;
  lang: Lang;
  email: string; // sandbox personal account email in sandbox mode
  /** Willing to be offered compensation to take delivery later. */
  flexible: boolean;
  /** Max working days they said they could wait (only if flexible). */
  maxDelayDays: number;
  /** What a day of delay is worth to them (CHF), used by the deterministic pricer. */
  delayCostPerDayChf: number;
  note: string;
}

export interface Operation {
  machineId: string;
  hours: number;
  label: string;
}

export type JobStatus = 'booked' | 'shipped' | 'cancelled';

export interface Job {
  id: string;
  customerId: string;
  title: string;
  material: string;
  qty: number;
  ops: Operation[];
  /** Earliest working day the job can start (material arrival). */
  releaseDay: number;
  /** Promised delivery: end of this working day. */
  dueDay: number;
  priceChf: number;
  payment: PaymentTerms;
  status: JobStatus;
  /** Dispatch order (lower = earlier). */
  seq: number;
  rush?: boolean;
  /** Compensation agreed for a bump, settled at ship (capture less) or immediately (payout). */
  compensationChf?: number;
  /** Every PayPal object this job touched, oldest first (order → authorization → capture / void / refund, payouts). */
  paypal?: PayPalStep[];
  /** Rush job only: the capture id once shipped (refund path). */
  captureId?: string;
  /** Rush job only: set when the rush was cancelled (void before shipment, refund after). */
  cancelledVia?: 'void' | 'refund';
}

/** One entry in a job's PayPal timeline. ids link to the sandbox (merchant view) where PayPal has a page for them. */
export interface PayPalStep {
  at: string;
  label: string;
  /** PayPal's own status string, e.g. PAYER_ACTION_REQUIRED, APPROVED, CREATED, CAPTURED, VOIDED, COMPLETED, SUCCESS. */
  status: string;
  id?: string;
  idKind?: 'order' | 'authorization' | 'capture' | 'refund' | 'payout-batch' | 'payout-item';
  api?: string;
  amountChf?: number;
  /** confirmed = read back from PayPal (webhook, reconcile poll or a live GET), not just our own call's response. */
  source: 'call' | 'confirmed' | 'live-check' | 'buyer';
}

export interface ScheduledOp {
  jobId: string;
  machineId: string;
  start: number; // hour index
  end: number;
  label: string;
}

export interface JobTiming {
  jobId: string;
  end: number;
  deliveryDay: number;
  late: boolean;
}

export interface Schedule {
  ops: ScheduledOp[];
  timing: Record<string, JobTiming>;
}

export interface RushRequest {
  id: string;
  rawText: string;
  customer: { name: string; contact: string; city: string; email: string; lang: Lang };
  title: string;
  material: string;
  qty: number;
  ops: Operation[];
  dueDay: number;
  basePriceChf: number;
  /** Delivery day if the rush job were simply appended to the full schedule (nobody moves). Code, not AI. */
  firstFitDay?: number;
  /** Which parts of the intake came from the AI vs. deterministic code. */
  extractedBy: 'llm' | 'deterministic';
}

export interface BumpOffer {
  id: string;
  jobId: string;
  customerId: string;
  fromDay: number;
  toDay: number;
  delayDays: number;
  compensationChf: number;
  mechanism: 'reduced-capture' | 'payout';
  lang: Lang;
  message: string; // in the customer's language
  messageEn: string; // English translation for the owner / judges
  status: 'draft' | 'sent' | 'accepted' | 'declined';
  respondedAt?: string;
  /** Hard cap for this offer (code, not AI): min(per-job cap, what is left of the rush budget). */
  capChf: number;
  /** Amount of the first offer. Counter-offers may raise it by at most 50 % without the owner (guardrails.counterLimit). */
  openingChf?: number;
  /** Free-text thread with the customer (customer replies are untrusted input). */
  thread: OfferMessage[];
  /** Set when the agent hands the reply to the owner (unclear, over the cap, or looks like manipulation). */
  escalation?: string;
  /** How the final answer was reached. */
  decidedBy?: 'button' | 'llm' | 'deterministic';
}

export interface OfferMessage {
  from: 'customer' | 'shop';
  text: string;
  textEn?: string;
  at: string;
}

/** One bump plan the deterministic planner found (the agent picks one and says why). */
export interface PlanOptionView {
  optionId: string;
  bumps: { jobId: string; customerId: string; delayDays: number; compensationChf: number; mechanism: 'reduced-capture' | 'payout' }[];
  compensationTotalChf: number;
  rushPremiumChf: number;
  netUpliftChf: number;
}

export interface GuardrailCheck {
  label: string;
  ok: boolean;
}

/** A money move waiting for the shop owner's approval. Nothing reaches PayPal before approval. */
export interface MoneyMove {
  id: string;
  kind: 'payout' | 'capture-less' | 'rush-authorize';
  customerName: string;
  amountChf: number;
  api: string;
  detail: string;
}

export interface Plan {
  id: string;
  rushId: string;
  feasible: boolean;
  reason: string;
  insertAt: number;
  bumpedJobIds: string[];
  proposed: Schedule;
  offers: BumpOffer[];
  rushPriceChf: number;
  rushPremiumChf: number;
  compensationTotalChf: number;
  netUpliftChf: number;
  explanation: string[];
  candidatesEvaluated: number;
  /** Code-enforced budget: total compensation may not exceed this share of the rush premium. */
  budgetCapChf: number;
  options: PlanOptionView[];
  chosenOptionId: string;
  /** Owner-facing reason for asking exactly these customers (written by the agent). */
  justification: string;
  chosenBy: 'llm' | 'deterministic';
}

/** The owner dragged a booked job on the board: what Takt says about it. Code decides the slot and the price. */
export interface MoveReview {
  jobId: string;
  customerName: string;
  delayDays: number;
  fromDay: number;
  toDay: number;
  dueDay: number;
  /** fits: still within the promise (owner can apply it, no money); offer: needs the customer's consent. */
  verdict: 'fits' | 'offer' | 'refused';
  /** Owner-facing explanation (English). */
  reason: string;
  /** What the move frees for other work (owner-facing, code). */
  frees?: string;
  offer?: { compensationChf: number; capChf: number; mechanism: BumpOffer['mechanism']; lang: Lang; message: string; messageEn: string };
}

/**
 * A board move the owner wants: it runs the same path as the agent's proposals. Draft (Claude writes the offer) →
 * owner sends it → the customer answers (the agent negotiates within the cap) → owner approves the money move with
 * the guardrail checklist → PayPal (capture less at shipment, or a payout) → the schedule changes.
 */
export interface MoveProposal {
  id: string;
  jobId: string;
  review: MoveReview;
  /** Undefined when the move fits the promise (no consent or money needed). */
  offer?: BumpOffer;
  stage: 'drafted' | 'offer-sent' | 'awaiting-approval' | 'committed' | 'declined' | 'discarded';
  /** The schedule with the move applied (ghost on the board until it commits). */
  proposed: Schedule;
  draftedBy?: 'llm' | 'deterministic';
  approval?: { moves: MoneyMove[]; checks: GuardrailCheck[]; status: 'pending' | 'approved'; doneMoveIds?: string[] };
}

export type PayPalEventType =
  | 'CHECKOUT.ORDER.APPROVED'
  | 'PAYMENT.AUTHORIZATION.CREATED'
  | 'PAYMENT.AUTHORIZATION.VOIDED'
  | 'PAYMENT.CAPTURE.COMPLETED'
  | 'PAYMENT.CAPTURE.REFUNDED'
  | 'PAYMENT.PAYOUTSBATCH.SUCCESS'
  | 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED';

export interface LedgerEvent {
  id: string;
  at: string;
  source: 'api' | 'webhook' | 'agent' | 'tool' | 'guardrail' | 'owner' | 'system';
  title: string;
  detail: string;
  paypalId?: string;
  amountChf?: number;
}

export type RushStage =
  | 'idle'
  | 'intake'
  | 'planned'
  | 'offers-sent'
  | 'awaiting-approval'
  | 'awaiting-payment'
  | 'committed';

export interface DemoState {
  boardStartIso: string; // Monday of the first board week (local date)
  now: string;
  machines: Machine[];
  customers: Customer[];
  jobs: Job[];
  schedule: Schedule;
  rush?: RushRequest;
  plan?: Plan;
  rushOrder?: { orderId: string; status: 'created' | 'approved' | 'authorized'; authorizationId?: string; amountChf: number; approveUrl?: string; cancelledAt?: string; expiresAt?: string; paypal: PayPalStep[] };
  /** Set when the intake could not read a job from the text: Takt asks the owner instead of inventing one. */
  intakeQuestion?: { missing: string[]; message: string };
  /** Offers that are closed and no longer part of the plan (declined), so their links still show the answer. */
  pastOffers?: BumpOffer[];
  /** Start-state capacity (code): week-1 utilisation per machine and the first day a new laser + press-brake job could ship. */
  capacity?: { week1Pct: Record<string, number>; nextFreeDay: number };
  /** Last PayPal-side event the owner should see (buyer cancelled, authorization failed). */
  paypalNotice?: { kind: 'cancelled' | 'error'; text: string; at: string };
  stage: RushStage;
  ledger: LedgerEvent[];
  yield: { premiumsChf: number; compensationsChf: number; netChf: number; rushJobsWon: number };
  approval?: { moves: MoneyMove[]; checks: GuardrailCheck[]; status: 'pending' | 'approved'; doneMoveIds?: string[] };
  /** The owner's board move, if one is open or just finished. */
  move?: MoveProposal;
  modes: { paypal: 'mock' | 'sandbox'; agent: 'deterministic' | 'llm'; currency: string };
  agent: AgentStatus;
}

export interface AgentStatus {
  /** What is configured: Claude (with deterministic fallback) or rules only. */
  configured: 'llm' | 'deterministic';
  model: string;
  /** How the last agent step actually ran. replay = recorded Claude response for a scripted demo input. */
  last: 'live' | 'replay' | 'deterministic' | 'fallback' | null;
  fallbackReason?: string;
  liveCalls: number;
  replayCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Hosted demo: live Claude calls left for this session (this hour) and for the whole demo today. */
  liveLeft?: { session: number | null; today: number };
}
