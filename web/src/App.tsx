import { lazy, Suspense, useEffect, useState } from 'react';
import type { DemoState, LedgerEvent } from '../../shared/types';
import { chf, dayLong, getState, post } from './api';
import { Flow } from './components/Flow';
import { OfferPage } from './components/Offer';
import { RushPayPage } from './components/PayPal';
import { RUSH_SAMPLES } from './samples';

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
        <div className="mail-icon">✉</div>
        <div className="mail-body">
          <small>New email · Thomas Schmid, Hof Schmid (farm), Escholzmatt</small>
          <b>Mähdrescher: Halter gerissen, brauche 6 Stück bis Dienstag</b>
          <span className="muted">Harvest starts Wednesday. Saying no loses the best order of the week; bumping someone silently loses a customer.</span>
        </div>
        <button className="btn accent" onClick={onOpen}>Open request</button>
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

function LogItem({ e }: { e: LedgerEvent }) {
  const tool = e.source === 'tool' ? /^tool (\w+)/.exec(e.title)?.[1] : undefined;
  const title = tool ? TOOL_TITLES[tool] ?? e.title : e.title;
  const raw = tool || e.detail.length > 180;
  return (
    <li className={`src-${e.source}`}>
      <span className="time">{new Date(e.at).toLocaleTimeString('de-CH')}</span>
      <span className="src">{e.source}</span>
      <b>{title}</b>
      {e.amountChf !== undefined && <span className="amt">{chf(e.amountChf)}</span>}
      {e.paypalId && <code title="PayPal id">{e.paypalId}</code>}
      {raw ? (
        <details className="detail">
          <summary>{tool ? 'tool call' : `${e.detail.slice(0, 120)}…`}</summary>
          <span>{e.detail}</span>
        </details>
      ) : (
        <span className="detail">{e.detail}</span>
      )}
    </li>
  );
}

export function App() {
  const [state, setState] = useState<DemoState | null>(null);
  const [draft, setDraft] = useState(RUSH_SAMPLES[0].text);
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

  if (!state) return <div className="center muted">Loading…</div>;

  const offerMatch = hash.match(/^#\/offer\/(.+)$/);
  if (offerMatch) return <OfferPage id={offerMatch[1]} state={state} onState={setState} />;
  if (hash === '#/pay') return <RushPayPage state={state} onState={setState} />;

  const showProposal = ['planned', 'offers-sent', 'awaiting-approval', 'awaiting-payment'].includes(state.stage);
  const coldOpen = state.stage === 'idle' && !state.rush && !state.intakeQuestion && !state.move;
  const a = state.agent;
  const left = a.liveLeft;
  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo">▤</span>
          <div>
            <b>Takt</b>
            <small>Airline bumping for factory schedules</small>
          </div>
        </div>
        <div className="shop">Werkstatt Reuss · Emmen LU</div>
        <div className="yield">
          <div><small>Rush premiums</small><b>{chf(state.yield.premiumsChf)}</b></div>
          <div><small>Compensations</small><b>−{chf(state.yield.compensationsChf)}</b></div>
          <div className="net"><small>Net uplift</small><b>{state.yield.netChf < 0 ? '−' : '+'}{chf(Math.abs(state.yield.netChf))}</b></div>
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
            const card = document.querySelector('.intake-card');
            card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            setTimeout(() => document.querySelector<HTMLButtonElement>('#read-request')?.focus({ preventScroll: true }), 50);
          }}
        />
      )}
      <main className="main">
        <section className="left">
          <Suspense fallback={<div className="board board-loading muted">Loading the board…</div>}>
            <Board state={state} showProposal={showProposal} onState={setState} />
          </Suspense>
          <div className="ledger">
            <h3>PayPal &amp; agent log</h3>
            <ul>
              {state.ledger.slice(0, 30).map((e) => <LogItem key={e.id} e={e} />)}
            </ul>
          </div>
        </section>
        <Flow state={state} onState={setState} draft={draft} setDraft={setDraft} primed={primed} onPrime={() => setPrimed((n) => n || 1)} />
      </main>
    </div>
  );
}
