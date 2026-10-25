// Placeholder timeline (plain CSS) until Bryntum Scheduler Pro is wired in (trial starts >= 31 Oct).
// Same data contract: resources = machines, events = scheduled ops, ghost events = proposed plan.
import { useState } from 'react';
import { BOARD_DAYS, HOURS_PER_DAY, type DemoState, type Schedule } from '../../../shared/types';
import { dayShort } from '../api';

const PALETTE: Record<string, string> = {
  keller: '#5b7db1',
  brunner: '#3f9d8f',
  vuilleumier: '#8a6fb0',
  rochat: '#c9824a',
  gasser: '#6f9a4b',
  alpdrone: '#4f8fbf',
  meier: '#b5677d',
  rush: '#e0a100',
};

interface Props {
  state: DemoState;
  showProposal: boolean;
}

export function Board({ state, showProposal }: Props) {
  // One week by default: bars are twice as wide, so labels stay readable and a one-day bump is visible.
  const [days, setDays] = useState(5);
  const total = days * HOURS_PER_DAY;
  const plan = state.plan;
  const proposal: Schedule | undefined = showProposal && plan?.feasible ? plan.proposed : undefined;
  const bumped = new Set(plan?.bumpedJobIds ?? []);
  const jobById = new Map(state.jobs.map((j) => [j.id, j]));
  const custName = (id: string) => state.customers.find((c) => c.id === id)?.name ?? (id === 'rush' ? state.rush?.customer.name : id);
  const pct = (h: number) => `${(Math.min(h, total) / total) * 100}%`;
  const w = (a: number, b: number) => `${((Math.min(b, total) - Math.min(a, total)) / total) * 100}%`;

  return (
    <div className="board">
      <div className="board-head">
        <div className="res-col">
          <div className="zoom" role="group" aria-label="Board range">
            <button className={days === 5 ? 'on' : ''} onClick={() => setDays(5)}>1 week</button>
            <button className={days === BOARD_DAYS ? 'on' : ''} onClick={() => setDays(BOARD_DAYS)}>2 weeks</button>
          </div>
        </div>
        <div className="days" style={{ gridTemplateColumns: `repeat(${days}, 1fr)` }}>
          {Array.from({ length: days }, (_, d) => (
            <div key={d} className={`day ${d % 5 === 4 ? 'fri' : ''}`}>{dayShort(state.boardStartIso, d)}</div>
          ))}
        </div>
      </div>
      {state.machines.map((m) => {
        const ops = state.schedule.ops.filter((o) => o.machineId === m.id && o.start < total);
        const ghost = proposal?.ops.filter((o) => o.machineId === m.id && o.start < total) ?? [];
        return (
          <div key={m.id} className="row">
            <div className="res-col">
              <strong>{m.name}</strong>
              <span>{m.id}</span>
            </div>
            <div className="lane">
              {Array.from({ length: days }, (_, d) => (
                <div key={d} className="gridline" style={{ left: pct(d * HOURS_PER_DAY) }} />
              ))}
              {ops.map((o) => {
                const j = jobById.get(o.jobId);
                if (!j) return null;
                const moved = proposal && (bumped.has(j.id) || proposal.ops.some((p) => p.jobId === o.jobId && p.machineId === o.machineId && p.start !== o.start));
                return (
                  <div
                    key={o.jobId + o.machineId}
                    className={`bar ${j.rush ? 'rush' : ''} ${moved ? 'fading' : ''} ${bumped.has(j.id) ? 'bumped' : ''}`}
                    style={{ left: pct(o.start), width: w(o.start, o.end), background: PALETTE[j.rush ? 'rush' : j.customerId] }}
                    title={`${j.id} ${j.title} — ${custName(j.customerId)} — due ${dayShort(state.boardStartIso, j.dueDay)}`}
                  >
                    <span className="bar-id">{custName(j.customerId)}</span>
                    <span className="bar-cust">{j.id} · {j.title}</span>
                  </div>
                );
              })}
              {ghost
                .filter((g) => g.jobId.startsWith('RUSH-') || bumped.has(g.jobId))
                .map((g) => (
                  <div
                    key={'g' + g.jobId + g.machineId}
                    className={`bar ghost ${g.jobId.startsWith('RUSH-') ? 'ghost-rush' : 'ghost-bump'}`}
                    style={{ left: pct(g.start), width: w(g.start, g.end) }}
                  >
                    <span className="bar-id">{g.jobId.startsWith('RUSH-') ? `RUSH · ${state.rush?.customer.name ?? ''}` : `+${plan?.offers.find((o) => o.jobId === g.jobId)?.delayDays ?? 1} d · ${custName(jobById.get(g.jobId)?.customerId ?? '')}`}</span>
                  </div>
                ))}
            </div>
          </div>
        );
      })}
      <div className="legend">
        <span><i className="sw solid" /> booked</span>
        {proposal && <span><i className="sw ghost-rush" /> proposed rush slot</span>}
        {proposal && <span><i className="sw ghost-bump" /> proposed new slot (needs consent)</span>}
        <span className="muted">Simple timeline; Bryntum Scheduler Pro replaces this view</span>
      </div>
    </div>
  );
}
