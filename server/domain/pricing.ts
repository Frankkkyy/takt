// Deterministic rate card and policy. The LLM never sets prices; it only explains and words them.
import type { Customer, Job, Operation } from '../../shared/types.js';

export const RATE_CARD_CHF_PER_HOUR: Record<string, number> = {
  LAS1: 190,
  PB1: 150,
  MILL1: 175,
  MILL2: 130,
};

export const POLICY = {
  setupChf: 120,
  rushFactor: 0.5, // premium as share of the base price
  marginFloorChf: 150, // net uplift after compensations must stay above this
  compBaseChf: 30, // fixed "thank you" part of a bump compensation
  compCapShare: 0.12, // never compensate more than 12 % of the bumped job's price
  maxBumps: 3,
  compBudgetShare: 0.6, // all compensations of one rush together: at most 60 % of its rush premium
};

/** Hard budget for one rush: total compensation may never exceed this (enforced in code, whatever the agent says). */
export function compensationBudget(rushPremiumChf: number): number {
  return Math.floor(rushPremiumChf * POLICY.compBudgetShare);
}

/** Per-job cap: never compensate more than compCapShare of the bumped job's price. */
export function perJobCap(job: Job): number {
  return Math.floor(job.priceChf * POLICY.compCapShare);
}

export const roundTo5 = (x: number) => Math.round(x / 5) * 5;

export function basePrice(ops: Operation[], materialChf: number): number {
  const machining = ops.reduce((s, o) => s + o.hours * (RATE_CARD_CHF_PER_HOUR[o.machineId] ?? 150), 0);
  return roundTo5(POLICY.setupChf + machining + materialChf);
}

export function compensation(job: Job, customer: Customer, delayDays: number): number {
  const raw = POLICY.compBaseChf + customer.delayCostPerDayChf * delayDays;
  return roundTo5(Math.min(raw, job.priceChf * POLICY.compCapShare));
}

export function rushPremium(base: number, compensationTotal: number): number {
  return roundTo5(Math.max(base * POLICY.rushFactor, compensationTotal + POLICY.marginFloorChf));
}
