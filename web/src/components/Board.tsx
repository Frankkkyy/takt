// The shop floor board: Bryntum Scheduler Pro (trial package, see THIRD_PARTY.md).
//  - machines = resources, scheduled operations = events, cut → bend = dependencies;
//  - the axis shows working time only (Mon–Fri 07:00–15:00), one week by default;
//  - a partnered ResourceHistogram under the board shows how booked each machine is (laser + press brake at 100 %);
//  - the agent's proposal appears as ghost events (dashed) with a badge per bumped job;
//  - when PayPal confirms, the real events move into the accepted plan (Scheduler Pro event animations);
//  - the owner can drag a booked job later: Takt reviews the move, and if the customer must agree it becomes a
//    proposal (ghost) that runs the same offer → owner approval → PayPal path before the bar really moves.
// Takt's own deterministic scheduler stays the source of truth; the board mirrors /api/state every second.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BryntumResourceHistogram, BryntumSchedulerPro } from '@bryntum/schedulerpro-react';
import { ProjectModel, StringHelper, type EventModel, type SchedulerEventModel } from '@bryntum/schedulerpro';
import '@bryntum/schedulerpro/schedulerpro.css';
import '@bryntum/schedulerpro/svalbard-light.css';
import '@bryntum/schedulerpro/fontawesome/css/fontawesome.css';
import '@bryntum/schedulerpro/fontawesome/css/solid.css';
import { BOARD_DAYS, HOURS_PER_DAY, type BumpOffer, type DemoState, type Job, type MoveReview, type Schedule } from '../../../shared/types';
import { chf, dayDate, dayLong, MACHINE_SHORT, post } from '../api';

const DAY_START_HOUR = 7;
const HISTO_ROW = 30;

interface Props {
  state: DemoState;
  showProposal: boolean;
  onState: (s: DemoState) => void;
}

/** One bar on the board (real or ghost), already in Bryntum's terms. */
interface BoardEvent {
  id: string;
  resourceId: string;
  startDate: Date;
  endDate: Date;
  name: string;
  cls: string;
  /** Everything the renderer and tooltip need; kept as one JSON string so a change re-renders the bar. */
  info: string;
}

interface EventInfo {
  jobId: string;
  customer: string;
  /** Short name for narrow bars ("Rochat"). */
  short: string;
  title: string;
  op: string;
  due: string;
  late: boolean;
  payState: PayState;
  payLine: string;
  ids: string[];
  ghost?: 'rush' | 'bump';
  badge?: string;
  /** Second line of a ghost bar, e.g. "CHF 50" (hidden when the bar is narrow). */
  detail?: string;
  moving?: boolean;
}

type PayState = 'authorized' | 'prepaid' | 'rush' | 'compensated';

/** Hour index (0 = Monday 07:00 of the first board week) → wall-clock date. A shift end (t = 8k) stays on day k-1. */
function hourToDate(boardStartIso: string, t: number, isEnd = false): Date {
  let day = Math.floor(t / HOURS_PER_DAY);
  let h = t - day * HOURS_PER_DAY;
  if (isEnd && h === 0 && day > 0) {
    day -= 1;
    h = HOURS_PER_DAY;
  }
  const d = dayDate(boardStartIso, day);
  d.setHours(DAY_START_HOUR + Math.floor(h), Math.round((h % 1) * 60), 0, 0);
  return d;
}

/** Rush ids differ between proposal (RUSH-x) and committed job (R-x); one board id lets the ghost turn solid in place. */
const boardKey = (jobId: string) => jobId.replace(/^RUSH-/, 'rush-').replace(/^R-/, 'rush-');

function payStateOf(j: Job | undefined, rush: boolean): PayState {
  if (rush || j?.rush) return 'rush';
  if (j?.compensationChf) return 'compensated';
  return j?.payment.kind === 'prepaid' ? 'prepaid' : 'authorized';
}

function payLineOf(j: Job | undefined): { line: string; ids: string[] } {
  if (!j) return { line: 'Rush order: PayPal authorization pending', ids: [] };
  const ids: string[] = [];
  let line: string;
  if (j.payment.kind === 'authorization') {
    line = `PayPal authorization ${chf(j.payment.authorizedChf)} (captured at shipment)`;
    ids.push(`order ${j.payment.orderId}`, `authorization ${j.payment.authorizationId}`);
  } else {
    line = `Prepaid ${chf(j.payment.paidChf)} via ${j.payment.paidVia === 'paypal' ? 'PayPal' : 'bank transfer'}`;
    if (j.payment.captureId) ids.push(`capture ${j.payment.captureId}`);
  }
  if (j.compensationChf) line += ` · compensation ${chf(j.compensationChf)} agreed`;
  for (const s of j.paypal ?? []) if (s.id && !ids.some((x) => x.endsWith(s.id!))) ids.push(`${s.idKind ?? 'id'} ${s.id}`);
  return { line, ids };
}

/** What the board shows as ghosts: the rush plan, or the owner's open board move. */
interface Proposal {
  schedule: Schedule;
  bumped: string[];
  offers: BumpOffer[];
  kind: 'rush' | 'move';
}

function buildEvents(state: DemoState, prop: Proposal | undefined): BoardEvent[] {
  const plan = state.plan;
  const proposal = prop?.schedule;
  const bumped = new Set(prop?.bumped ?? []);
  const jobById = new Map(state.jobs.map((j) => [j.id, j]));
  const custName = (id: string) => state.customers.find((c) => c.id === id)?.name ?? (id === 'rush' ? state.rush?.customer.name ?? 'Rush' : id);
  const out: BoardEvent[] = [];
  const iso = state.boardStartIso;

  for (const o of state.schedule.ops) {
    const j = jobById.get(o.jobId);
    if (!j) continue;
    const timing = state.schedule.timing[j.id];
    const pay = payLineOf(j);
    const moving = !!proposal && proposal.ops.some((p) => p.jobId === o.jobId && p.machineId === o.machineId && p.start !== o.start);
    const info: EventInfo = {
      jobId: j.id,
      customer: custName(j.customerId),
      short: shortName(j.customerId, custName(j.customerId)),
      title: j.title,
      op: o.label,
      due: dayLong(iso, j.dueDay),
      late: !!timing?.late,
      payState: payStateOf(j, false),
      payLine: pay.line,
      ids: pay.ids,
      moving: moving || (!!proposal && bumped.has(j.id)),
    };
    out.push({
      id: `${boardKey(j.id)}|${o.machineId}`,
      resourceId: o.machineId,
      startDate: hourToDate(iso, o.start),
      endDate: hourToDate(iso, o.end, true),
      name: `${info.customer} · ${j.id}`,
      cls: `takt-ev pay-${info.payState}${info.moving ? ' moving' : ''}${bumped.has(j.id) && proposal ? ' bumped' : ''}`,
      info: JSON.stringify(info),
    });
  }

  if (proposal && prop) {
    for (const g of proposal.ops) {
      const isRush = g.jobId.startsWith('RUSH-');
      if (!isRush && !bumped.has(g.jobId)) continue;
      if (isRush && !plan) continue;
      const j = jobById.get(g.jobId);
      const offer = prop.offers.find((x) => x.jobId === g.jobId);
      const mech = offer?.mechanism === 'payout' ? 'payout' : 'capture less';
      const info: EventInfo = isRush
        ? {
            jobId: g.jobId,
            customer: state.rush?.customer.name ?? 'Rush',
            short: state.rush?.customer.name ?? 'Rush',
            title: state.rush?.title ?? 'Rush job',
            op: g.label,
            due: dayLong(iso, state.rush?.dueDay ?? 0),
            late: false,
            payState: 'rush',
            payLine: `Rush premium ${chf(plan!.rushPremiumChf)} · PayPal hold ${chf(plan!.rushPriceChf)} on approval`,
            ids: state.rushOrder ? [`order ${state.rushOrder.orderId}`] : [],
            ghost: 'rush',
            badge: 'RUSH',
          }
        : {
            jobId: g.jobId,
            customer: custName(j?.customerId ?? ''),
            short: shortName(j?.customerId ?? '', custName(j?.customerId ?? '')),
            title: j?.title ?? '',
            op: g.label,
            due: offer ? dayLong(iso, offer.toDay) : '',
            late: false,
            payState: payStateOf(j, false),
            payLine: offer ? `${prop.kind === 'move' ? 'Board move · ' : ''}Offer: ${chf(offer.compensationChf)} via ${mech} · ${offer.status === 'accepted' ? 'agreed by the customer' : offer.status === 'sent' ? 'waiting for the customer' : offer.status}` :  prop.kind === 'move' ? 'Board move: within the promised date' : 'Proposed slot',
            ids: [],
            ghost: 'bump',
            badge: offer ? `+${offer.delayDays}d${offer.status === 'accepted' ? ' ✓' : ''}` : prop.kind === 'move' ? 'move' : 'proposed',
            detail: offer ? chf(offer.compensationChf) : undefined,
          };
      // The rush ghost keeps the id the committed rush job will get, so it turns solid in place.
      const id = isRush ? `${boardKey(g.jobId)}|${g.machineId}` : `ghost|${boardKey(g.jobId)}|${g.machineId}`;
      out.push({
        id,
        resourceId: g.machineId,
        startDate: hourToDate(iso, g.start),
        endDate: hourToDate(iso, g.end, true),
        name: info.badge ?? '',
        cls: `takt-ev ghost ghost-${info.ghost} pay-${info.payState}${!isRush && offer?.status === 'accepted' ? ' agreed' : ''}`,
        info: JSON.stringify(info),
      });
    }
  }
  return out;
}

/** cut → bend: consecutive operations of a job (only between bars that are both on the board and not bump ghosts). */
function buildDependencies(events: BoardEvent[]): { id: string; fromEvent: string; toEvent: string }[] {
  const byJob = new Map<string, BoardEvent[]>();
  for (const e of events) {
    if (e.id.startsWith('ghost|')) continue;
    const k = e.id.split('|')[0];
    byJob.set(k, [...(byJob.get(k) ?? []), e]);
  }
  const deps: { id: string; fromEvent: string; toEvent: string }[] = [];
  for (const [k, evs] of byJob) {
    const sorted = [...evs].sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
    for (let i = 1; i < sorted.length; i++) deps.push({ id: `dep|${k}|${i}`, fromEvent: sorted[i - 1].id, toEvent: sorted[i].id });
  }
  return deps;
}

const info = (r: { get: (f: string) => unknown }): EventInfo | undefined => {
  try {
    return JSON.parse(String(r.get('info') ?? '')) as EventInfo;
  } catch {
    return undefined;
  }
};

const enc = (s: string) => StringHelper.encodeHtml(s);

// Working-hour ticks (07–15) so nights and weekends drop out of the axis; one week labels every second hour
// (7 9 11 13), two weeks only name the days, short ("Mon 9"), so ten of them fit at 1280 px.
const PRESET_1W = {
  base: 'hourAndDay',
  id: 'taktShift1w',
  tickWidth: 18,
  displayDateFormat: 'ddd H:mm',
  shiftUnit: 'day',
  timeResolution: { unit: 'hour', increment: 1 },
  headers: [
    { unit: 'day', dateFormat: 'ddd D MMM' },
    // one tick per hour (bars start on the hour), labelled every second hour so it stays readable at 1280 px
    { unit: 'hour', increment: 1, renderer: (d: Date) => (d.getHours() % 2 ? String(d.getHours()) : '') },
  ],
};
const PRESET_2W = {
  ...PRESET_1W,
  id: 'taktShift2w',
  tickWidth: 9,
  headers: [
    { unit: 'day', dateFormat: 'ddd D' },
    { unit: 'hour', increment: 1, renderer: () => '' },
  ],
};

function viewRange(boardStartIso: string, days: number) {
  const start = dayDate(boardStartIso, 0);
  const end = dayDate(boardStartIso, days - 1);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

export function Board({ state, showProposal, onState }: Props) {
  const [days, setDays] = useState(5);
  const [review, setReview] = useState<MoveReview | { error: string } | { pending: string } | null>(null);
  const schedulerRef = useRef<BryntumSchedulerPro>(null);
  const histogramRef = useRef<BryntumResourceHistogram>(null);

  // One project (engine + stores) shared by the scheduler and the histogram. Events are positioned by Takt's
  // scheduler (manuallyScheduled), the shift calendar gives the histogram its 8 h/day capacity.
  const project = useMemo(
    () =>
      new ProjectModel({
        calendar: 'shift',
        calendars: [
          {
            id: 'shift',
            name: 'Day shift 07:00–15:00',
            unspecifiedTimeIsWorking: false,
            intervals: [{ recurrentStartDate: `at ${DAY_START_HOUR}:00`, recurrentEndDate: `at ${DAY_START_HOUR + HOURS_PER_DAY}:00`, isWorking: true }],
          },
        ],
        eventStore: { fields: ['info'] },
      }),
    [],
  );

  const plan = state.plan;
  const move = state.move;
  const moveOpen = !!move && ['drafted', 'offer-sent', 'awaiting-approval'].includes(move.stage);
  const rushProposal = showProposal && plan?.feasible ? plan.proposed : undefined;
  const prop: Proposal | undefined = rushProposal
    ? { schedule: rushProposal, bumped: plan!.bumpedJobIds, offers: plan!.offers, kind: 'rush' }
    : moveOpen
      ? { schedule: move!.proposed, bumped: [move!.jobId], offers: move!.offer ? [move!.offer] : [], kind: 'move' }
      : undefined;
  const proposal = prop?.schedule;
  const agreedCount = prop?.offers.filter((o) => o.status === 'accepted').length ?? 0;
  const askingCount = (prop?.offers.length ?? 0) - agreedCount;

  // Payoff moment: a short glow around the board when the plan commits (CSS respects prefers-reduced-motion).
  const [justCommitted, setJustCommitted] = useState(false);
  const lastStage = useRef(state.stage);
  useEffect(() => {
    if (state.stage === 'committed' && lastStage.current !== 'committed') {
      setJustCommitted(true);
      const t = setTimeout(() => setJustCommitted(false), 1900);
      lastStage.current = state.stage;
      return () => clearTimeout(t);
    }
    lastStage.current = state.stage;
  }, [state.stage]);
  const events = useMemo(() => buildEvents(state, prop), [state, prop?.schedule, prop?.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  // Bryntum binds listeners once; read the latest values through refs.
  // The review note belongs to an open move: once it is sent on, committed, declined or discarded, drop it.
  const moveKey = moveOpen ? `${move!.id}|${move!.stage}` : '';
  useEffect(() => {
    setReview((r) => (r && !('error' in r) && !('pending' in r) && r.verdict !== 'refused' && moveKey.split('|')[1] !== 'drafted' ? null : r));
  }, [moveKey]);

  // A drafted (unsent) board move may be replaced by a new drag; a sent one or a rush proposal locks the board.
  const locked = !!rushProposal || (moveOpen && move!.stage !== 'drafted');
  const live = useRef({ locked, iso: state.boardStartIso });
  live.current = { locked, iso: state.boardStartIso };
  const sig = JSON.stringify(events) + JSON.stringify(state.machines);

  // Mirror the server state into the Bryntum stores with minimal changes, so moves animate instead of re-rendering.
  useEffect(() => {
    const { resourceStore, eventStore, dependencyStore } = project;
    if (resourceStore.count !== state.machines.length) {
      resourceStore.data = state.machines.map((m) => ({ id: m.id, name: m.name, kind: m.kind }));
    }
    const want = new Map(events.map((e) => [e.id, e]));
    const stale = (eventStore.records as EventModel[]).filter((r) => !want.has(String(r.id)));
    if (stale.length) eventStore.remove(stale);
    const toAdd: object[] = [];
    for (const e of events) {
      const r = eventStore.getById(e.id) as EventModel | undefined;
      if (!r) {
        const { resourceId: _r, ...data } = e;
        toAdd.push({ ...data, manuallyScheduled: true });
        continue;
      }
      const changes: Record<string, unknown> = {};
      if (r.startDate?.valueOf() !== e.startDate.valueOf()) changes.startDate = e.startDate;
      if (r.endDate?.valueOf() !== e.endDate.valueOf()) changes.endDate = e.endDate;
      if (r.name !== e.name) changes.name = e.name;
      if (String(r.cls) !== e.cls) changes.cls = e.cls;
      if (r.get('info') !== e.info) changes.info = e.info;
      if (Object.keys(changes).length) r.set(changes);
    }
    if (toAdd.length) {
      const added = eventStore.add(toAdd) as EventModel[];
      for (const a of added) {
        const src = want.get(String(a.id))!;
        project.assignmentStore.add({ id: `as|${a.id}`, eventId: a.id, resourceId: src.resourceId });
      }
    }
    const deps = buildDependencies(events);
    const wantDeps = new Set(deps.map((d) => d.id));
    const staleDeps = dependencyStore.records.filter((d) => !wantDeps.has(String(d.id)));
    if (staleDeps.length) dependencyStore.remove(staleDeps);
    const newDeps = deps.filter((d) => !dependencyStore.getById(d.id));
    if (newDeps.length) dependencyStore.add(newDeps.map((d) => ({ id: d.id, fromEvent: d.fromEvent, toEvent: d.toEvent, lag: 0 })));
    project.commitAsync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, project]);

  const { start, end } = viewRange(state.boardStartIso, days);
  useEffect(() => {
    schedulerRef.current?.instance?.setTimeSpan(start, end);
    histogramRef.current?.instance?.setTimeSpan(start, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, state.boardStartIso]);

  // The rush customer's deadline as a Scheduler Pro time range (end of the promised day).
  const rushDueAt = state.rush && state.stage !== 'idle' ? hourToDate(state.boardStartIso, (state.rush.dueDay + 1) * HOURS_PER_DAY, true).valueOf() : 0;
  useEffect(() => {
    const store = project.timeRangeStore;
    store.removeAll();
    if (rushDueAt) store.add({ id: 'rush-due', name: 'Rush due', startDate: new Date(rushDueAt), duration: 0, durationUnit: 'h', cls: 'rush-due' });
  }, [rushDueAt, project]);

  // Booked share of the visible range per machine (code, from Takt's schedule): the "100 % booked" read-out.
  const bookedPct = useMemo(() => {
    const total = days * HOURS_PER_DAY;
    const pct: Record<string, number> = {};
    for (const m of state.machines) {
      const h = state.schedule.ops.filter((o) => o.machineId === m.id).reduce((a, o) => a + Math.max(0, Math.min(o.end, total) - Math.min(o.start, total)), 0);
      pct[m.id] = Math.round((h / total) * 100);
    }
    return pct;
  }, [state.schedule, state.machines, days]);
  const pctRef = useRef(bookedPct);
  pctRef.current = bookedPct;
  useEffect(() => {
    histogramRef.current?.instance?.refreshRows();
  }, [bookedPct]);

  return (
    <div className={`board bryntum-board${justCommitted ? ' just-committed' : ''}`} aria-label="Shop floor board: machines and booked jobs">
      <div className="board-bar">
        <div className="zoom" role="group" aria-label="Board range">
          <button className={days === 5 ? 'on' : ''} onClick={() => setDays(5)}>1 week</button>
          <button className={days === BOARD_DAYS ? 'on' : ''} onClick={() => setDays(BOARD_DAYS)}>2 weeks</button>
        </div>
        <div className="legend">
          <span><i className="sw pay-authorized" /> authorized (PayPal hold)</span>
          <span><i className="sw pay-prepaid" /> prepaid</span>
          <span><i className="sw pay-compensated" /> compensated</span>
          <span><i className="sw pay-rush" /> rush</span>
          {!locked && <span className="hint">Drag a booked job later: Takt reviews the move</span>}
          {prop?.kind === 'rush' && <span><i className="sw ghost-rush-sw" /> proposed rush slot</span>}
          {proposal && (askingCount > 0 || !prop?.offers.length) && <span><i className="sw ghost-bump-sw" /> proposed new slot ({prop?.kind === 'move' && !move?.offer ? 'board move' : 'needs consent'})</span>}
          {proposal && agreedCount > 0 && <span><i className="sw ghost-agreed-sw" /> agreed new slot</span>}
        </div>
      </div>
      {review && (
        <div className={`move-review ${'error' in review ? 'refused' : 'pending' in review ? 'offer' : review.verdict}`} role="status" aria-live="polite">
          <button className="close" aria-label="Dismiss" onClick={() => setReview(null)}>×</button>
          {'error' in review ? (
            <p>{review.error}</p>
          ) : 'pending' in review ? (
            <p>Takt is reviewing the move of {review.pending}…</p>
          ) : (
            <>
              <small>Board move · {review.jobId} {review.customerName} · +{review.toDay - review.fromDay} d · code checks dates, other promises and caps</small>
              <b>{review.verdict === 'offer' ? 'Breaks the promised date: the customer must agree' : review.verdict === 'fits' ? 'Fits the promise' : 'Takt will not move this job'}</b>
              <p>{review.reason}</p>
              {review.verdict !== 'refused' && <p className="small muted">The dashed bar shows the new slot. {review.verdict === 'offer' ? 'Send the offer from the panel on the right; nothing moves or pays before the customer agrees and you approve.' : 'Apply it from the panel on the right.'}</p>}
            </>
          )}
        </div>
      )}
      <div className="sched-wrap">
        <BryntumSchedulerPro
          ref={schedulerRef}
          project={project}
          startDate={start}
          endDate={end}
          workingTime={{ fromDay: 1, toDay: 6, fromHour: DAY_START_HOUR, toHour: DAY_START_HOUR + HOURS_PER_DAY }}
          viewPreset={days > 5 ? PRESET_2W : PRESET_1W}
          forceFit
          rowHeight={56}
          autoHeight
          barMargin={6}
          resourceMargin={6}
          eventStyle={null}
          eventLayout="stack"
          useInitialAnimation="fade-in"
          transition={{ changeEvent: true, removeEvent: true }}
          transitionDuration={900}
          // Two-way board: the owner may drag a booked job later on its machine; Takt reviews the move (what-if) and
          // the bar snaps back, because only agreed and PayPal-confirmed plans change the schedule.
          eventDragFeature={{ constrainDragToResource: true, showTooltip: true }}
          eventResizeFeature={false}
          eventDragCreateFeature={false}
          eventEditFeature={false}
          taskEditFeature={false}
          eventMenuFeature={false}
          scheduleMenuFeature={false}
          cellMenuFeature={false}
          cellEditFeature={false}
          dependencyEditFeature={false}
          eventCopyPasteFeature={false}
          enableDeleteKey={false}
          onBeforeEventDrag={({ eventRecord }) => {
            const i = info(eventRecord as unknown as { get: (f: string) => unknown });
            return !!i && !i.ghost && i.payState !== 'rush' && !live.current.locked;
          }}
          onBeforeEventDropFinalize={({ context }) => {
            const i = info(context.eventRecord as unknown as { get: (f: string) => unknown });
            const iso = live.current.iso;
            const delay = workDayIndex(iso, context.startDate) - workDayIndex(iso, context.eventRecord.startDate as Date);
            // Snap back: the bar only really moves once the customer agreed and the owner approved (Flow panel).
            context.valid = false;
            if (!i || delay === 0) return;
            setReview({ pending: i.jobId });
            post<MoveReview>(`/api/jobs/${encodeURIComponent(i.jobId)}/review-move`, { delayDays: delay })
              .then((r) => { setReview(r.result); onState(r.state); })
              .catch((e: Error) => setReview({ error: e.message }));
          }}
          columns={[
            {
              text: 'Machine',
              field: 'name',
              width: 170,
              htmlEncode: false,
              renderer: ({ record }: { record: { get: (f: string) => unknown; id: unknown } }) =>
                `<div class="res-cell"><b>${enc(String(record.get('name')))}</b><small>${enc(String(record.id))}</small></div>`,
            },
          ]}
          timeRangesFeature={{ showCurrentTimeLine: false, showHeaderElements: true }}
          dependenciesFeature={{ radius: 6, allowCreate: false }}
          eventTooltipFeature={{
            hoverDelay: 150,
            template: ({ eventRecord }: { eventRecord: SchedulerEventModel }) => {
              const i = info(eventRecord as unknown as { get: (f: string) => unknown });
              if (!i) return '';
              return `<div class="takt-tip"><b>${enc(i.customer)}</b> · ${enc(i.jobId)} ${enc(i.title)}<br>
                ${enc(i.op)} · ${enc(dayTime(eventRecord.startDate as Date))}–${enc(dayTime(eventRecord.endDate as Date))}<br>
                ${i.ghost ? 'Proposed' : 'Promised'}: ${enc(i.due)}${i.late ? ' <span class="late">late</span>' : ''}<br>
                <span class="tip-pay">${enc(i.payLine)}</span>
                ${i.ids.length ? `<br><small>${i.ids.map(enc).join('<br>')}</small>` : ''}</div>`;
            },
          }}
          eventRenderer={({ eventRecord }: { eventRecord: SchedulerEventModel }) => {
            const i = info(eventRecord as unknown as { get: (f: string) => unknown });
            if (!i) return enc(eventRecord.name ?? '');
            // Ghosts: a short label that survives a narrow bar ("RUSH", "+1d"); details stay in the tooltip.
            if (i.ghost === 'rush') return `<div class="ev-txt"><b>RUSH</b><span>${enc(i.short)} · ${enc(i.op)}</span></div>`;
            if (i.ghost) return `<div class="ev-txt"><b>${enc(i.badge ?? '')}</b><span>${enc(i.short)}${i.detail ? ` · ${enc(i.detail)}` : ''}</span></div>`;
            if (i.payState === 'rush') return `<div class="ev-txt"><b>RUSH</b><span>${enc(i.short)} · ${enc(i.op)} · ${enc(i.title)}</span></div>`;
            return `<div class="ev-txt"><b>${enc(i.short)}</b><span>${enc(i.jobId)} · ${enc(i.op)} · ${enc(i.title)}</span></div>`;
          }}
        />
      </div>
      <div className="histo-wrap">
        {/* Same project, same range and working time, one tick per day: bars read "100 %" per machine and day. */}
        <BryntumResourceHistogram
            ref={histogramRef}
            project={project}
            startDate={start}
            endDate={end}
            workingTime={{ fromDay: 1, toDay: 6 }}
            viewPreset={{ base: 'dayAndWeek', id: 'taktDays', tickWidth: 100, shiftUnit: 'day', headers: [{ unit: 'day', dateFormat: 'ddd' }] }}
            forceFit
            height={state.machines.length * HISTO_ROW + 2}
            minHeight={0}
            hideHeaders
            hideHorizontalScrollbar
            rowHeight={HISTO_ROW}
            getBarTextDOMConfig={(dom, datum) => ({ ...dom, y: HISTO_ROW / 2, className: { 'b-bar-legend': 1, full: isFull(datum), over: isOver(datum) } })}
            scaleColumn={null as never}
            showBarTip
            showBarText
            showMaxEffort={false}
            effortUnit="hour"
            barTextEffortUnit="hour"
            assignmentFilterFn={(a) => !String((a.event as EventModel | undefined)?.cls ?? '').includes('ghost')}
            getBarText={(datum) => (datum.maxEffort ? `${Math.round((datum.effort / datum.maxEffort) * 100)} %` : '')}
            getBarClass={(_s, _d, datum) => (isOver(datum) ? 'over' : isFull(datum) ? 'full' : '')}
            columns={[
              {
                text: 'Booked',
                field: 'name',
                width: 170,
                htmlEncode: false,
                renderer: ({ record }: { record: { get: (f: string) => unknown; id: unknown } }) => {
                  const p = pctRef.current[String(record.id)] ?? 0;
                  return `<span class="histo-res ${p >= 95 ? 'full' : ''}"><b>${p} %</b> booked · ${enc(MACHINE_SHORT[String(record.id)] ?? String(record.id))}</span>`;
                },
              },
            ]}
          />
      </div>
    </div>
  );
}

const isFull = (d: { effort: number; maxEffort: number }) => !!d.maxEffort && d.effort >= d.maxEffort - 1;
/** Booked beyond the shift: shown in strong red, unlike a merely full day. */
const isOver = (d: { effort: number; maxEffort: number }) => !!d.maxEffort && d.effort > d.maxEffort + 0.01;

const SHORT: Record<string, string> = { alpdrone: 'Alpine Drone' };
function shortName(customerId: string, full: string): string {
  if (customerId === 'rush' || !customerId) return full;
  return SHORT[customerId] ?? customerId.charAt(0).toUpperCase() + customerId.slice(1);
}

/** Working-day index of a date on the board (0 = first Monday; weekends count as the Friday before). */
function workDayIndex(boardStartIso: string, d: Date): number {
  const start = dayDate(boardStartIso, 0);
  const cal = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()).valueOf() - start.valueOf()) / 86_400_000 + 0.5);
  return Math.floor(cal / 7) * 5 + Math.min(((cal % 7) + 7) % 7, 4);
}

function dayTime(d: Date): string {
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
