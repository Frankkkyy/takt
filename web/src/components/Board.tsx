// Placeholder timeline (plain CSS) until Bryntum Scheduler Pro is wired in (trial starts >= 31 Oct).
// Same data contract: resources = machines, events = scheduled ops, ghost events = proposed plan.
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
  const total = BOARD_DAYS * HOURS_PER_DAY;
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
        <div className="res-col">Machine</div>
        <div className="days">
          {Array.from({ length: BOARD_DAYS }, (_, d) => (
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
              {Array.from({ length: BOARD_DAYS }, (_, d) => (
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
                    <span className="bar-id">{j.id}</span>
                    <span className="bar-cust">{custName(j.customerId)}</span>
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
                    <span className="bar-id">{g.jobId.startsWith('RUSH-') ? 'RUSH' : g.jobId}</span>
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
        <span className="muted">Placeholder timeline — Bryntum Scheduler Pro replaces this view</span>
      </div>
    </div>
  );
}
