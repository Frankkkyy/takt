// Deterministic finite-capacity scheduler (job-order dispatch).
// Jobs are dispatched in `seq` order; each operation starts at max(machine free, previous op end, release).
// This is the simulation the agent uses to evaluate "what if" moves. Bryntum Scheduler Pro renders the result
// (and later its engine can replace this module for richer constraints).
import { HOURS_PER_DAY, type Job, type Schedule, type ScheduledOp } from '../../shared/types.js';

export function deliveryDayOf(endHour: number): number {
  return Math.max(0, Math.ceil(endHour / HOURS_PER_DAY) - 1);
}

export function schedule(jobs: Job[]): Schedule {
  const free: Record<string, number> = {};
  const ops: ScheduledOp[] = [];
  const timing: Schedule['timing'] = {};
  const active = jobs.filter((j) => j.status === 'booked').sort((a, b) => a.seq - b.seq);
  for (const job of active) {
    let t = job.releaseDay * HOURS_PER_DAY;
    for (const o of job.ops) {
      const start = Math.max(t, free[o.machineId] ?? 0);
      const end = start + o.hours;
      free[o.machineId] = end;
      ops.push({ jobId: job.id, machineId: o.machineId, start, end, label: o.label });
      t = end;
    }
    const deliveryDay = deliveryDayOf(t);
    timing[job.id] = { jobId: job.id, end: t, deliveryDay, late: deliveryDay > job.dueDay };
  }
  return { ops, timing };
}
