// The rush agent's contract. Two implementations: ClaudeAgent (Claude Haiku 5.5 with tool use) and
// DeterministicAgent (rules + templates, the on-stage fallback). HybridAgent runs Claude and falls back.
// Rule of the house: the agent reads, chooses and writes; deterministic code prices, plans and moves money.
import type { AgentStatus, BumpOffer, Customer, Job, Lang, Operation, RushRequest } from '../../shared/types.js';

export interface IntakeResult {
  customerName: string;
  contact: string;
  city: string;
  lang: Lang;
  title: string;
  material: string;
  qty: number;
  ops: Operation[];
  dueDay: number;
  basePriceChf: number;
  partFamily: string;
  thicknessMm: number;
  notes?: string;
}

export interface OfferDraft {
  message: string;
  messageEn: string;
}

export interface BumpDetail {
  jobId: string;
  jobTitle: string;
  customerId: string;
  customerName: string;
  contact: string;
  lang: Lang;
  fromDay: number;
  toDay: number;
  delayDays: number;
  compensationChf: number;
  mechanism: BumpOffer['mechanism'];
  capChf: number;
}

export interface OptionDetail {
  optionId: string;
  bumps: BumpDetail[];
  compensationTotalChf: number;
  rushPremiumChf: number;
  rushPriceChf: number;
  netUpliftChf: number;
  budgetCapChf: number;
}

export interface PlannerView {
  feasible: boolean;
  reason: string;
  candidatesEvaluated: number;
  options: OptionDetail[];
}

export interface PlanInput {
  rush: RushRequest;
  customers: Customer[];
  jobs: Job[];
  boardStart: Date;
  /** The deterministic planner, exposed to the agent as a tool. Declined customers are always excluded. */
  runPlanner(excludeCustomerIds: string[]): PlannerView;
}

export interface PlanDecision {
  optionId: string;
  justification: string;
  /** Keyed by job id. */
  drafts: Record<string, OfferDraft>;
}

export interface ReplyInput {
  offer: BumpOffer;
  customer: Customer;
  job: Job;
  /** Hard ceiling for this offer (guardrails.offerCeiling). */
  ceilingChf: number;
  replyText: string;
  boardStart: Date;
}

export interface ReplyDecision {
  action: 'accept' | 'decline' | 'counter' | 'reply' | 'escalate';
  /** counter: agreed amount; reply: amount proposed back to the customer (optional). */
  compensationChf?: number;
  /** counter: agreed delivery day. */
  deliveryDay?: number;
  message?: string;
  messageEn?: string;
  reason: string;
}

export interface AgentStep {
  kind: 'tool' | 'guardrail' | 'note';
  title: string;
  detail: string;
}

export interface AgentResult<T> {
  value: T;
  steps: AgentStep[];
  source: 'live' | 'replay' | 'deterministic' | 'fallback';
  fallbackReason?: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface RushAgent {
  readonly kind: 'llm' | 'deterministic';
  intake(text: string, boardStart: Date): Promise<AgentResult<IntakeResult>>;
  plan(input: PlanInput): Promise<AgentResult<PlanDecision>>;
  reply(input: ReplyInput): Promise<AgentResult<ReplyDecision>>;
  status(): AgentStatus;
}

// ---- Calendar helpers -------------------------------------------------------------------------------
export const WEEKDAYS: Record<Lang, string[]> = {
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
  de: ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'],
  fr: ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi'],
};

export function workDayToDate(boardStart: Date, day: number): Date {
  const d = new Date(boardStart);
  d.setDate(d.getDate() + Math.floor(day / 5) * 7 + (day % 5));
  return d;
}

/** Calendar label, e.g. "Wednesday 4 Nov" / "Mittwoch 4.11.". Used in the UI and deterministic templates. */
export function dayLabel(boardStart: Date, day: number, lang: Lang): string {
  const d = workDayToDate(boardStart, day);
  const wd = WEEKDAYS[lang][day % 5];
  const dm = `${d.getDate()}.${d.getMonth() + 1}.`;
  return lang === 'en' ? `${wd} ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}` : `${wd} ${dm}`;
}

/**
 * Relative label without calendar dates, e.g. "Wednesday" / "mercredi de la semaine prochaine". The LLM only sees
 * these (plus day indices), so prompts are identical every week and recorded demo responses keep replaying.
 */
export function relDay(day: number, lang: Lang): string {
  const wd = WEEKDAYS[lang][day % 5];
  if (day < 5) return wd;
  return { en: `${wd} next week`, de: `${wd} nächste Woche`, fr: `${wd} de la semaine prochaine` }[lang];
}

export function emptyStatus(configured: 'llm' | 'deterministic', model: string): AgentStatus {
  return { configured, model, last: null, liveCalls: 0, replayCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
}
