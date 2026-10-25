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
  source: 'api' | 'webhook' | 'agent' | 'system';
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
  rushOrder?: { orderId: string; status: 'created' | 'approved' | 'authorized'; authorizationId?: string; amountChf: number; approveUrl?: string };
  stage: RushStage;
  ledger: LedgerEvent[];
  yield: { premiumsChf: number; compensationsChf: number; netChf: number; rushJobsWon: number };
  modes: { paypal: 'mock' | 'sandbox'; agent: 'deterministic' | 'llm'; currency: string };
}
