// Guardrails: deterministic checks that sit between the agent (LLM or rules) and any money move.
// The agent proposes; these functions decide. Customer text and model output are both treated as untrusted:
// amounts are only ever accepted when they are within the caps computed here from the planner and the policy.
import type { BumpOffer, GuardrailCheck, Plan } from '../../shared/types.js';
import { POLICY } from '../domain/pricing.js';

export const BOARD_LAST_DAY = 9;

/** All CHF amounts mentioned in a text ("CHF 70", "70 CHF", "Fr. 70.-", "70 francs", "CHF 1'200"). */
export function chfAmounts(text: string): number[] {
  const out: number[] = [];
  const num = String.raw`(\d{1,3}(?:['’ ]\d{3})+|\d+)(?:[.,](\d{1,2}|-|–))?`;
  const re = new RegExp(String.raw`(?:CHF|Fr\.|SFr\.?)\s*${num}|${num}\s*(?:CHF|Fr\.|francs?|Franken)`, 'gi');
  for (const m of text.matchAll(re)) {
    const whole = m[1] ?? m[3];
    const frac = m[2] ?? m[4];
    let v = Number(whole.replace(/['’ ]/g, ''));
    if (frac && /^\d+$/.test(frac)) v += Number(frac) / 10 ** frac.length;
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

export interface CapContext {
  offer: BumpOffer;
  plan: Plan;
}

/** Money left in the rush budget for this offer, counting every other offer at its current amount. */
export function remainingBudget(plan: Plan, offerId: string): number {
  const others = plan.offers.filter((o) => o.id !== offerId && o.status !== 'declined').reduce((s, o) => s + o.compensationChf, 0);
  return plan.budgetCapChf - others;
}

/** The hard ceiling for one offer: per-job cap and the remaining rush budget, and the margin floor. */
export function offerCeiling(plan: Plan, offer: BumpOffer, perJobCapChf: number): number {
  const others = plan.offers.filter((o) => o.id !== offer.id && o.status !== 'declined').reduce((s, o) => s + o.compensationChf, 0);
  const byMargin = plan.rushPremiumChf - POLICY.marginFloorChf - others;
  return Math.max(0, Math.min(perJobCapChf, remainingBudget(plan, offer.id), byMargin));
}

export type Verdict = { ok: true } | { ok: false; error: string };

export function checkAmount(amountChf: unknown, ceilingChf: number): Verdict {
  if (typeof amountChf !== 'number' || !Number.isFinite(amountChf) || !Number.isInteger(amountChf)) return { ok: false, error: 'compensation must be a whole number of CHF' };
  if (amountChf < 0) return { ok: false, error: 'compensation cannot be negative' };
  if (amountChf > ceilingChf) return { ok: false, error: `CHF ${amountChf} exceeds the hard cap of CHF ${ceilingChf} for this offer` };
  return { ok: true };
}

/** A delivery day the shop can promise: not earlier than the planner's new date, inside the board. */
export function checkDeliveryDay(day: unknown, earliestDay: number): Verdict {
  if (typeof day !== 'number' || !Number.isInteger(day)) return { ok: false, error: 'delivery_day must be a board day index' };
  if (day < earliestDay) return { ok: false, error: `not feasible: the earliest possible delivery for this job is day ${earliestDay}` };
  if (day > BOARD_LAST_DAY) return { ok: false, error: `day ${day} is outside the planning board (last day ${BOARD_LAST_DAY})` };
  return { ok: true };
}

/**
 * A message to a customer may only mention money the code approved: it must contain the agreed amount, and no
 * CHF amount above the ceiling (so a model can't promise more than the cap in prose).
 */
export function checkMessage(message: unknown, mustMentionChf: number | null, ceilingChf: number): Verdict {
  if (typeof message !== 'string' || message.trim().length < 10) return { ok: false, error: 'message is empty' };
  if (message.length > 900) return { ok: false, error: 'message is too long (max 900 characters)' };
  const amounts = chfAmounts(message);
  const over = amounts.find((a) => a > ceilingChf && a !== mustMentionChf);
  if (over !== undefined) return { ok: false, error: `message mentions CHF ${over}, above the cap of CHF ${ceilingChf}` };
  if (mustMentionChf !== null && !amounts.includes(mustMentionChf)) return { ok: false, error: `message must state the amount exactly as "CHF ${mustMentionChf}"` };
  return { ok: true };
}

/** Checks shown to the owner next to the approval button, re-run right before money moves. */
export function approvalChecks(plan: Plan, perJobCaps: Record<string, number>): GuardrailCheck[] {
  const accepted = plan.offers.filter((o) => o.status === 'accepted');
  const total = accepted.reduce((s, o) => s + o.compensationChf, 0);
  const net = plan.rushPremiumChf - total;
  return [
    { label: `Every bumped customer accepted (${accepted.length}/${plan.offers.length})`, ok: accepted.length === plan.offers.length },
    { label: `Each compensation within its job cap (${Math.round(POLICY.compCapShare * 100)} % of job price)`, ok: accepted.every((o) => o.compensationChf <= (perJobCaps[o.jobId] ?? 0)) },
    { label: `Total compensation CHF ${total} ≤ budget CHF ${plan.budgetCapChf} (${Math.round(POLICY.compBudgetShare * 100)} % of rush premium)`, ok: total <= plan.budgetCapChf },
    { label: `Net uplift CHF ${net} ≥ margin floor CHF ${POLICY.marginFloorChf}`, ok: net >= POLICY.marginFloorChf },
    { label: 'Payees come from the booking records, never from message text', ok: true },
  ];
}
