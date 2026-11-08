// Deterministic finite-capacity scheduler (job-order dispatch).
// Jobs are dispatched in `seq` order; each operation starts at max(machine free, previous op end, release).
// Shipped jobs keep the slot they had when they shipped (`shippedSlot`): they still occupy their machine hours
// on the board, but never move again; booked work is dispatched around them.
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
  // Shipped work is history: its hours stay blocked exactly where they were.
  const fixed: Record<string, ScheduledOp[]> = {};
  const active = jobs.filter((j) => j.status === 'booked' || (j.status === 'shipped' && j.shippedSlot)).sort((a, b) => a.seq - b.seq);
  for (const job of active) {
    if (job.status !== 'shipped') continue;
    for (const o of job.shippedSlot!.ops) (fixed[o.machineId] ??= []).push(o);
  }
  for (const job of active) {
    if (job.status === 'shipped') {
      // In dispatch order the shipped slot still counts as taken, so later jobs keep their places behind it.
      const slot = job.shippedSlot!;
      for (const o of slot.ops) {
        ops.push({ ...o });
        free[o.machineId] = Math.max(free[o.machineId] ?? 0, o.end);
      }
      timing[job.id] = { ...slot.timing };
      continue;
    }
    let t = job.releaseDay * HOURS_PER_DAY;
    for (const o of job.ops) {
      let start = Math.max(t, free[o.machineId] ?? 0);
      // A booked job dispatched ahead of a shipped one must not overlap its (fixed) hours.
      for (let clash = true; clash; ) {
        clash = false;
        for (const f of fixed[o.machineId] ?? []) {
          if (start < f.end && start + o.hours > f.start) { start = f.end; clash = true; }
        }
      }
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
