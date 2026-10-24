// "Make room" search: where can a rush job go, and which flexible customers must be asked to wait?
//
// A candidate plan = (insert position p in the dispatch order, set S of flexible jobs dispatched before p that
// give their slot to the rush job). New order = [jobs before p not in S] + [rush] + [S] + [jobs from p on].
// A plan is feasible when:
//   - the rush job is delivered by its due day,
//   - every job that would be late is flexible, delayed at most its maxDelayDays (these become bump offers),
//   - at most POLICY.maxBumps offers, and net uplift >= margin floor.
// Cheapest compensation wins; ties -> fewer bumps -> later insertion (less disruption).
import type { Customer, Job, Plan, RushRequest } from '../../shared/types.js';
import { schedule } from './scheduler.js';
import { POLICY, compensation, rushPremium } from './pricing.js';

export interface BumpCandidate {
  jobId: string;
  customerId: string;
  fromDay: number;
  toDay: number;
  delayDays: number;
  compensationChf: number;
}

export interface PlanResult {
  feasible: boolean;
  reason: string;
  insertAt: number;
  rushJob: Job;
  orderedJobs: Job[];
  bumps: BumpCandidate[];
  rushPriceChf: number;
  rushPremiumChf: number;
  compensationTotalChf: number;
  netUpliftChf: number;
  candidatesEvaluated: number;
  firstFitDay: number; // when the rush job could ship without bumping anyone
}

export function rushToJob(rush: RushRequest, seq: number): Job {
  return {
    id: 'RUSH-' + rush.id,
    customerId: 'rush',
    title: rush.title,
    material: rush.material,
    qty: rush.qty,
    ops: rush.ops,
    releaseDay: 0,
    dueDay: rush.dueDay,
    priceChf: rush.basePriceChf,
    payment: { kind: 'authorization', orderId: '', authorizationId: '', authorizedChf: 0 },
    status: 'booked',
    seq,
    rush: true,
  };
}

function subsets<T>(items: T[], max: number): T[][] {
  const out: T[][] = [[]];
  for (const it of items) {
    const n = out.length;
    for (let i = 0; i < n; i++) if (out[i].length < max) out.push([...out[i], it]);
  }
  return out;
}

export function planRush(jobs: Job[], customers: Customer[], rush: RushRequest): PlanResult {
  const booked = jobs.filter((j) => j.status === 'booked').sort((a, b) => a.seq - b.seq);
  const custById = new Map(customers.map((c) => [c.id, c]));
  const baseline = schedule(booked);
  const rushMachines = new Set(rush.ops.map((o) => o.machineId));
  const windowEnd = (rush.dueDay + 1) * 8;

  // Where would it fit without bumping anyone? (append at the end)
  const tail = schedule([...booked, rushToJob(rush, 1e9)]);
  const firstFitDay = tail.timing['RUSH-' + rush.id].deliveryDay;

  let best: PlanResult | null = null;
  let evaluated = 0;

  for (let p = 0; p <= booked.length; p++) {
    const before = booked.slice(0, p);
    const after = booked.slice(p);
    // Only flexible jobs that use a rush machine inside the rush window can usefully give up their slot.
    const pool = before.filter((j) => {
      const c = custById.get(j.customerId);
      if (!c?.flexible) return false;
      return baseline.ops.some((o) => o.jobId === j.id && rushMachines.has(o.machineId) && o.start < windowEnd);
    });
    for (const S of subsets(pool, POLICY.maxBumps)) {
      evaluated++;
      const sIds = new Set(S.map((j) => j.id));
      const order = [...before.filter((j) => !sIds.has(j.id)), rushToJob(rush, 0), ...S, ...after].map((j, i) => ({ ...j, seq: (i + 1) * 10 }));
      const sim = schedule(order);
      const rt = sim.timing['RUSH-' + rush.id];
      if (rt.deliveryDay > rush.dueDay) continue;
      const bumps: BumpCandidate[] = [];
      let ok = true;
      for (const j of booked) {
        const t = sim.timing[j.id];
        if (!t.late) continue;
        const c = custById.get(j.customerId)!;
        const delayDays = t.deliveryDay - j.dueDay;
        if (!c.flexible || delayDays > c.maxDelayDays) { ok = false; break; }
        bumps.push({ jobId: j.id, customerId: c.id, fromDay: j.dueDay, toDay: t.deliveryDay, delayDays, compensationChf: compensation(j, c, delayDays) });
      }
      if (!ok || bumps.length > POLICY.maxBumps) continue;
      const compTotal = bumps.reduce((s, b) => s + b.compensationChf, 0);
      const premium = rushPremium(rush.basePriceChf, compTotal);
      const net = premium - compTotal;
      if (net < POLICY.marginFloorChf) continue;
      const cand: PlanResult = {
        feasible: true,
        reason: bumps.length ? `Fits by ${bumps.length} voluntary bump(s)` : 'Fits without bumping anyone',
        insertAt: p,
        rushJob: order.find((j) => j.rush)!,
        orderedJobs: order,
        bumps,
        rushPriceChf: rush.basePriceChf + premium,
        rushPremiumChf: premium,
        compensationTotalChf: compTotal,
        netUpliftChf: net,
        candidatesEvaluated: 0,
        firstFitDay,
      };
      if (
        !best ||
        compTotal < best.compensationTotalChf ||
        (compTotal === best.compensationTotalChf && (bumps.length < best.bumps.length || (bumps.length === best.bumps.length && p > best.insertAt)))
      ) best = cand;
    }
  }

  if (!best) {
    return {
      feasible: false,
      reason: `No feasible plan: earliest delivery without breaking a firm promise is day ${firstFitDay}`,
      insertAt: -1,
      rushJob: rushToJob(rush, 0),
      orderedJobs: booked,
      bumps: [],
      rushPriceChf: rush.basePriceChf,
      rushPremiumChf: 0,
      compensationTotalChf: 0,
      netUpliftChf: 0,
      candidatesEvaluated: evaluated,
      firstFitDay,
    };
  }
  best.candidatesEvaluated = evaluated;
  return best;
}

export type { Plan };
