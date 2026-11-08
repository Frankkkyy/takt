import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { DemoState, LedgerEvent } from '../../shared/types';
import { chf, dayLong, getState, post } from './api';
import { Flow } from './components/Flow';
import { OfferPage } from './components/Offer';
import { RushPayPage } from './components/PayPal';
import { RUSH_SAMPLES } from './samples';
import { displayTitle, isPayPalEvent } from './labels';
import { ClaudeCodeStrip } from './components/Strip';

// Bryntum Scheduler Pro is big; the customer phone pages (#/offer, #/pay) never load it.
const Board = lazy(() => import('./components/Board').then((m) => ({ default: m.Board })));

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const h = () => setHash(location.hash);
    addEventListener('hashchange', h);
    return () => removeEventListener('hashchange', h);
  }, []);
  return hash;
}

const STORY_SAMPLE = RUSH_SAMPLES.find((s) => s.label === 'DE email')!;

/** Cold open (first ~6 s of the video): the shop is full, a rush email arrives, the hook line. Code-computed numbers. */
function Story({ state, onOpen }: { state: DemoState; onOpen: () => void }) {
  const cap = state.capacity;
  return (
    <section className="story" aria-label="Start: the shop is full">
      <div className="story-clock">Friday, 15:00 · Werkstatt Reuss, Emmen LU · 12 people, 4 machines</div>
      {/* Code-checked claim: week 1 of the seed has the laser and the press brake at 100 % (the 2-week view shows gaps later). */}
      <h1>{cap && cap.week1Pct.LAS1 >= 100 && cap.week1Pct.PB1 >= 100 ? 'The laser and press brake are booked all week.' : 'The shop is nearly fully booked this week.'}</h1>
      {cap && (
        <div className="util">
          {state.machines.map((m) => (
            <div key={m.id} className={`util-row ${cap.week1Pct[m.id] >= 85 ? 'full' : ''}`}>
              <span>{m.name}</span>
              <div className="meter"><i style={{ width: `${Math.min(100, cap.week1Pct[m.id])}%` }} /></div>
              <b>{cap.week1Pct[m.id]} %</b>
            </div>
          ))}
          <p className="muted small">Booked hours this week. A new laser + press-brake job would ship <b>{dayLong(state.boardStartIso, cap.nextFreeDay)}</b> at the earliest.</p>
        </div>
      )}
      <div className="mail-toast" role="status">
        <div className="mail-icon" aria-hidden>✉</div>
        <div className="mail-body">
          <small>New email · Thomas Schmid, Hof Schmid (farm), Escholzmatt</small>
          <b>Mähdrescher: Halter gerissen, brauche 6 Stück bis Dienstag</b>
          <span className="muted">Harvest starts Wednesday. Saying no loses the best order of the week; bumping someone silently loses a customer.</span>
        </div>
        <button className="btn primary" onClick={onOpen}>Open request</button>
      </div>
      <p className="hook">Airlines pay passengers who can wait. <b>Takt does it for factories, with PayPal.</b></p>
    </section>
  );
}

/** Plain-language titles for the agent's tool calls; the raw JSON stays one click away. */
const TOOL_TITLES: Record<string, string> = {
  record_rush_job: 'Agent recorded the job',
  plan_bump_options: 'Agent ran the planner',
  choose_bump_plan: 'Agent chose a plan',
  draft_offer: 'Agent drafted an offer',
  accept_offer: 'Agent: customer accepts',
  counter_offer: 'Agent: counter-offer within limits',
  reply_to_customer: 'Agent answered the customer',
  decline_offer: 'Agent: customer declines',
  escalate_to_owner: 'Agent escalated to the owner',
  draft_move_offer: 'Agent drafted the board-move offer',
};
/** Short verbs for a grouped row: "ran the planner · chose a plan · drafted 2 offers". */
const TOOL_VERB: Record<string, [string, string]> = {
  record_rush_job: ['recorded the job', 'recorded jobs'],
  plan_bump_options: ['ran the planner', 'ran the planner'],
  choose_bump_plan: ['chose a plan', 'chose plans'],
  draft_offer: ['drafted an offer', 'drafted {n} offers'],
  accept_offer: ['accepted a reply', 'accepted {n} replies'],
  counter_offer: ['made a counter-offer', 'made {n} counter-offers'],
  reply_to_customer: ['answered a customer', 'answered {n} times'],
  decline_offer: ['recorded a no', 'recorded {n} noes'],
  escalate_to_owner: ['escalated to the owner', 'escalated {n} times'],
  draft_move_offer: ['drafted the move offer', 'drafted {n} move offers'],
};

type Cat = 'paypal' | 'agent' | 'tool' | 'guardrail' | 'owner' | 'milestone' | 'system';
const SRC_LABEL: Record<Cat, string> = { paypal: 'PayPal', agent: 'Agent', tool: 'Tool', guardrail: 'Guardrail', owner: 'Owner', milestone: 'Takt', system: 'Takt' };
function catOf(e: LedgerEvent): Cat {
  if (e.source === 'api' || e.source === 'webhook') return 'paypal';
  if (e.source === 'system' && /committed/i.test(e.title)) return 'milestone';
  if (e.source === 'system' && (e.paypalId || /PayPal|Payout|Buyer/i.test(e.title))) return 'paypal';
  return e.source as Cat;
}
const toolOf = (e: LedgerEvent) => (e.source === 'tool' ? /^tool (\w+)/.exec(e.title)?.[1] : undefined);

function Icon({ cat }: { cat: Cat }) {
  const p: Record<Cat, string> = {
    paypal: 'M5 8h13l-3-3M19 16H6l3 3', // money moves
    agent: 'M12 3l2.2 5.8L20 11l-5.8 2.2L12 19l-2.2-5.8L4 11l5.8-2.2z',
    tool: 'M14 6a4 4 0 0 0-5 5l-5 5 3 3 5-5a4 4 0 0 0 5-5l-2.5 2.5-2-.5-.5-2z',
    guardrail: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
    owner: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9c0-4 3-6 7-6s7 2 7 6',
    milestone: 'M5 12l4 4 10-10',
    system: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  };
  return (
    <span className="ico" aria-hidden>
      <svg viewBox="0 0 24 24" fill={cat === 'agent' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={cat === 'agent' ? 0 : 2.4} strokeLinecap="round" strokeLinejoin="round"><path d={p[cat]} /></svg>
    </span>
  );
}

const time = (at: string) => new Date(at).toLocaleTimeString('de-CH');

function LogItem({ e }: { e: LedgerEvent }) {
  const tool = toolOf(e);
  const title = tool ? TOOL_TITLES[tool] ?? e.title : displayTitle(e.title);
  const rawEvent = isPayPalEvent(e.title);
  const raw = tool || e.detail.length > 180;
  const cat = catOf(e);
  return (
    <li className={`src-${e.source} cat-${cat}`}>
      <Icon cat={cat} />
      <span className="time">{time(e.at)}</span>
      <div className="log-main">
        <span className="src">{SRC_LABEL[cat]}</span>
        <b title={rawEvent ? `PayPal webhook event ${e.title}` : undefined}>{title}</b>
        {rawEvent && <code className="evt" title="PayPal event type">{e.title}</code>}
        {e.amountChf !== undefined && <span className="amt">{chf(e.amountChf)}</span>}
        {e.paypalId && <code title="PayPal id">{e.paypalId}</code>}
        {raw ? (
          <details className="detail">
            <summary>{tool ? 'tool call' : `${e.detail.slice(0, 120)}…`}</summary>
            <span>{e.detail}</span>
          </details>
        ) : (
          e.detail && <span className="detail">{e.detail}</span>
        )}
      </div>
    </li>
  );
}

/** Consecutive tool calls fold into one row ("Agent used 4 tools: ran the planner · chose a plan · drafted 2 offers"). */
function ToolGroup({ items }: { items: LedgerEvent[] }) {
  const chrono = [...items].reverse();
  const counts = new Map<string, number>();
  for (const e of chrono) { const t = toolOf(e) ?? e.title; counts.set(t, (counts.get(t) ?? 0) + 1); }
  const summary = [...counts].map(([t, n]) => { const v = TOOL_VERB[t]; return v ? (n === 1 ? v[0] : v[1].replace('{n}', String(n))) : t; }).join(' · ');
  return (
    <li className="src-tool cat-tool group">
      <Icon cat="tool" />
      <span className="time">{time(items[0].at)}</span>
      <div className="log-main">
        <span className="src">Agent</span>
        <b>Agent used {items.length} tools</b>
        <details className="detail group">
          <summary>{summary}</summary>
          <ol className="tool-steps">
            {chrono.map((e) => (
              <li key={e.id}><b>{TOOL_TITLES[toolOf(e) ?? ''] ?? e.title}</b><span className="raw">{e.detail}</span></li>
            ))}
          </ol>
        </details>
      </div>
    </li>
  );
}

/** The story in phases, so a finished phase can fold into one summary row. PayPal stays its own, always-open phase. */
type Phase = 'start' | 'intake' | 'plan' | 'offers' | 'approval' | 'paypal' | 'move';
const PHASE_LABEL: Record<Phase, string> = { start: 'Start', intake: 'Intake', plan: 'Plan', offers: 'Offers', approval: 'Approval', paypal: 'PayPal', move: 'Board move' };
const TOOL_PHASE: Record<string, Phase> = {
  record_rush_job: 'intake',
  plan_bump_options: 'plan', choose_bump_plan: 'plan', draft_offer: 'plan',
  accept_offer: 'offers', counter_offer: 'offers', reply_to_customer: 'offers', decline_offer: 'offers', escalate_to_owner: 'offers',
  draft_move_offer: 'move',
};
function phaseOf(e: LedgerEvent, current: Phase): Phase {
  const cat = catOf(e);
  const t = e.title;
  if (cat === 'paypal' || cat === 'milestone' || /^Capture-less booked/.test(t)) return 'paypal';
  if (e.source === 'system' && /reset/i.test(t)) return 'start';
  const tool = toolOf(e);
  if (tool) return TOOL_PHASE[tool] ?? current;
  if (/^(Rush request understood|Request unclear)/.test(t)) return 'intake';
  if (/^(Room found|No room)/.test(t)) return 'plan';
  if (/^Template offer/.test(t)) return current === 'move' ? 'move' : 'plan';
  if (/^(Board move reviewed|Board move discarded|Owner applied the board move)/.test(t)) return 'move';
  if (/approval|^Owner (approved|retried)/i.test(t)) return 'approval';
  if (/^(Offers sent|Board move: offer sent|Reply from|Counter|Answered|Escalated|Message blocked)|(accepted|declined)( the board move)?$/.test(t)) return 'offers';
  return current;
}

/** Consecutive tool calls fold into one row; input and output are newest first. */
function foldTools(events: LedgerEvent[]): (LedgerEvent | LedgerEvent[])[] {
  const rows: (LedgerEvent | LedgerEvent[])[] = [];
  for (const e of events) {
    const last = rows[rows.length - 1];
    if (e.source === 'tool' && Array.isArray(last)) last.push(e);
    else if (e.source === 'tool' && last && !Array.isArray(last) && last.source === 'tool') rows[rows.length - 1] = [last, e];
    else rows.push(e);
  }
  return rows;
}

interface PhaseBlock { phase: Phase; events: LedgerEvent[] /* newest first */ }

function PhaseGroup({ block, open, current }: { block: PhaseBlock; open: boolean; current: boolean }) {
  const chrono = [...block.events].reverse();
  const keyTitles = chrono.filter((e) => e.source !== 'tool').map((e) => (e.amountChf !== undefined ? `${displayTitle(e.title)} ${chf(e.amountChf)}` : displayTitle(e.title)));
  const tools = chrono.length - keyTitles.length;
  const summary = [...keyTitles, ...(tools ? [`agent used ${plural(tools, 'tool')}`] : [])].join(' · ');
  // Follows the default (a phase folds when the next one starts) but keeps the owner's own clicks.
  const [isOpen, setOpen] = useState(open);
  useEffect(() => setOpen(open), [open]);
  return (
    <details className={`phase phase-${block.phase}${current ? ' current' : ''}`} open={isOpen} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className="ph-chev" aria-hidden />
        <span className="time">{time(chrono[0].at)}</span>
        <span className="ph-main">
          <span className="ph-name">{PHASE_LABEL[block.phase]}</span>
          <span className="ph-count">{plural(block.events.length, 'event')}</span>
          {/* only while folded, so the same words never sit hidden next to the real rows */}
          {!isOpen && <span className="ph-sum">{summary}</span>}
        </span>
      </summary>
      <ul>
        {foldTools(block.events).map((r) => (Array.isArray(r) ? <ToolGroup key={r[0].id} items={r} /> : <LogItem key={r.id} e={r} />))}
      </ul>
    </details>
  );
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function Ledger({ events }: { events: LedgerEvent[] }) {
  // Walk the log oldest → newest, give each event a phase, and cut a new block whenever the phase changes.
  const blocks: PhaseBlock[] = [];
  let current: Phase = 'start';
  for (const e of [...events].reverse()) {
    current = phaseOf(e, current);
    const last = blocks[blocks.length - 1];
    if (last && last.phase === current) last.events.unshift(e);
    else blocks.push({ phase: current, events: [e] });
  }
  const lastReset = blocks.map((b) => b.phase).lastIndexOf('start');
  const meaningful = events.some((e) => !(e.source === 'system' && /reset/i.test(e.title)));
  return (
    <section className="ledger" aria-label="PayPal and agent log">
      <div className="ledger-head">
        <h3>PayPal &amp; agent log</h3>
        <div className="ledger-key" aria-hidden>
          <span><i style={{ background: 'var(--pp-blue)' }} />PayPal</span>
          <span><i style={{ background: 'var(--ai)' }} />Agent</span>
          <span><i style={{ background: 'var(--n-900)' }} />Owner</span>
          <span><i style={{ background: 'var(--bad)' }} />Guardrail</span>
        </div>
      </div>
      <div className="phases" aria-live="polite" aria-relevant="additions">
        {blocks
          .map((b, i) => {
            const isCurrent = i === blocks.length - 1;
            // Finished phases fold into one row (click to expand); the current phase and this run's PayPal events stay open.
            const open = isCurrent || (b.phase === 'paypal' && i > lastReset);
            return <PhaseGroup key={b.events[b.events.length - 1].id} block={b} open={open} current={isCurrent} />;
          })
          .reverse()}
      </div>
      {!meaningful && <p className="empty-log">Nothing has happened yet. Every agent decision, guardrail check, owner approval and PayPal call will appear here, newest first.</p>}
    </section>
  );
}

/** The Takt mark: three schedule lines (also the favicon). */
export function LogoMark({ className = 'logo' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#232c38" />
      <path d="M8 10.5h16M8 16h10M8 21.5h13" stroke="#f2a20c" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Animated number for the header tiles (instant with prefers-reduced-motion). */
function useCountUp(value: number) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (start === value) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { from.current = value; setShown(value); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      const v = Math.round(start + (value - start) * (1 - Math.pow(1 - k, 3)));
      setShown(v);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = value; };
  }, [value]);
  return shown;
}

function YieldTile({ label, value, sign, className = '' }: { label: string; value: number; sign: '+' | '−' | ''; className?: string }) {
  const v = useCountUp(value);
  const [bump, setBump] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) { setBump(true); const t = setTimeout(() => setBump(false), 900); prev.current = value; return () => clearTimeout(t); }
  }, [value]);
  return (
    <div className={`${className}${bump ? ' bump' : ''}`}>
      <small>{label}</small>
      <b>{value ? sign : ''}{chf(Math.abs(v))}</b>
    </div>
  );
}

export function App() {
  const [state, setState] = useState<DemoState | null>(null);
  // The request panel starts with the same email the cold open shows, so the first screen tells one story.
  const [draft, setDraft] = useState(STORY_SAMPLE.text);
  // Cold open: one entry point. "Open request" (hero) loads the email into the panel and hands over to
  // "Let Takt read it", which only then becomes the primary button. Counts up so the highlight replays.
  const [primed, setPrimed] = useState(0);
  const hash = useHash();

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await getState();
        if (alive) setState(s);
      } catch {
        /* server restarting */
      }
    };
    tick();
    const t = setInterval(tick, 1000); // also our "reconcile" loop: webhooks are confirmations, polling is the backstop
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!state) return <div className="center"><div className="app-loading" role="status"><LogoMark /><span>Opening Werkstatt Reuss's schedule…</span></div></div>;

  const offerMatch = hash.match(/^#\/offer\/(.+)$/);
  if (offerMatch) return <OfferPage id={offerMatch[1]} state={state} onState={setState} />;
  if (hash === '#/pay') return <RushPayPage state={state} onState={setState} />;

  const showProposal = ['planned', 'offers-sent', 'awaiting-approval', 'awaiting-payment'].includes(state.stage);
  // The hero stays until the owner opens the email; then the console takes the whole screen.
  const coldOpen = state.stage === 'idle' && !state.rush && !state.intakeQuestion && !state.move && !primed;
  const a = state.agent;
  const left = a.liveLeft;
  return (
    <div className="app">
      <header className="top">
        <a className="skip" href="#flow">Skip to the current step</a>
        <div className="brand">
          <LogoMark />
          <div>
            <b>Takt</b>
            <small>Airline bumping for factory schedules</small>
          </div>
        </div>
        <div className="shop">Werkstatt Reuss · Emmen LU</div>
        <div className="yield" role="group" aria-label="This week's yield">
          <YieldTile label="Rush premiums" value={state.yield.premiumsChf} sign="" />
          <YieldTile label="Compensations" value={state.yield.compensationsChf} sign="−" />
          <YieldTile label="Net uplift" value={state.yield.netChf} sign={state.yield.netChf < 0 ? '−' : '+'} className="net" />
        </div>
        <div className="modes">
          <span className={`badge ${state.modes.paypal}`}>PayPal: {state.modes.paypal}</span>
          <span
            className={`badge agent-${a.last ?? a.configured}`}
            title={`Configured: ${a.configured === 'llm' ? `Claude ${a.model} with rules fallback` : 'rules only'}\nThis demo: live calls ${a.liveCalls}, recorded ${a.replayCalls}\nTokens ${a.inputTokens} in / ${a.outputTokens} out, USD ${a.costUsd.toFixed(4)}${left ? `\nLive Claude calls left: ${left.session ?? '–'} this hour (your session), ${left.today} today (whole demo)` : ''}${a.fallbackReason ? `\nLast fallback: ${a.fallbackReason}` : ''}`}
          >
            Agent: {a.configured === 'deterministic' ? 'rules' : a.last === 'fallback' ? 'rules (fallback)' : `Claude Haiku 5.5${a.last === 'replay' ? ' · recorded' : a.last === 'live' ? ' · live' : ''}`}
          </span>
          <button className="btn small ghost" onClick={async () => { setPrimed(0); setState((await post('/api/demo/reset')).state); }} title="Resets only your own demo session">Reset demo</button>
        </div>
      </header>
      {coldOpen && (
        <Story
          state={state}
          onOpen={() => {
            setDraft(STORY_SAMPLE.text);
            setPrimed((n) => n + 1);
            setTimeout(() => {
              document.querySelector('.intake-card')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
              document.querySelector<HTMLButtonElement>('#read-request')?.focus({ preventScroll: true });
            }, 50);
          }}
        />
      )}
      <main className="main">
        <section className="left">
          <Suspense fallback={<div className="board board-loading" role="status"><span className="muted">Loading the shop floor board…</span><div className="sk-line" /><div className="sk-line w80" /><div className="sk-line" /><div className="sk-line w60" /></div>}>
            <Board state={state} showProposal={showProposal} onState={setState} />
          </Suspense>
          <ClaudeCodeStrip state={state} />
          <Ledger events={state.ledger.slice(0, 40)} />
        </section>
        <Flow state={state} onState={setState} draft={draft} setDraft={setDraft} primed={primed} onPrime={() => setPrimed((n) => n || 1)} />
      </main>
    </div>
  );
}
