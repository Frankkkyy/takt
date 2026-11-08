import type { DemoState, LedgerEvent } from '../../../shared/types';
import { chf, plural } from '../api';
import { paypalEventLabel, isPayPalEvent } from '../labels';

/**
 * "Claude / code" strip: the last three things that happened, each labelled by who did it. It makes the split
 * visible at a glance: Claude reads and writes, code does the numbers, the owner decides, PayPal moves the money.
 * Built from the same ledger as the log (newest first there); it shows beats, not the full log.
 */
type Who = 'claude' | 'code' | 'owner' | 'paypal';
interface Beat { id: string; who: Who; text: string }

const WHO_LABEL: Record<Who, string> = { claude: 'Claude', code: 'Code', owner: 'Owner', paypal: 'PayPal' };
const WHO_ROLE: Record<Who, string> = { claude: 'reads & writes', code: 'does the numbers', owner: 'decides', paypal: 'moves money' };

/** "Claude Haiku 5.5 (recorded): …" or "Read by Claude…" → Claude; "rules: …" → code; "button: …" → the customer tapped (code records it). */
const viaWho = (detail: string): Who => (/^(Read by )?Claude/.test(detail) ? 'claude' : 'code');
const afterVia = (detail: string) => detail.replace(/^[^:]{1,40}:\s*/, '');
const nameIn = (title: string, re: RegExp) => re.exec(title)?.[1] ?? '';

/** Events that only repeat the one before them: PayPal's webhook echo of our own call, the "accepted" after a counter. */
function echoes(e: LedgerEvent, prev: LedgerEvent | undefined): boolean {
  if (!prev) return false;
  if (e.source === 'webhook' && prev.source === 'api' && e.paypalId && e.paypalId === prev.paypalId) return true;
  const who = / accepted$/.exec(e.title) && e.title.replace(/ accepted$/, '');
  return !!who && prev.title === `Counter-offer agreed with ${who}`;
}

function beatsOf(e: LedgerEvent, state: DemoState): Omit<Beat, 'id'>[] {
  const t = e.title;
  const { rush, plan } = state;
  const amt = e.amountChf !== undefined ? ` · ${chf(e.amountChf)}` : '';
  switch (e.source) {
    case 'tool':
      return []; // the agent's summary events below say the same in fewer words
    case 'agent': {
      if (/^Rush request understood/.test(t)) {
        const read: Omit<Beat, 'id'> = rush
          ? { who: viaWho(e.detail), text: `read the ${rush.customer.lang.toUpperCase()} request → ${rush.qty}× ${rush.title.replace(/\s*\(rush\)$/i, '')}` }
          : { who: viaWho(e.detail), text: 'read the request and recorded the job' };
        return rush ? [read, { who: 'code', text: `priced it from the rate card · ${chf(rush.basePriceChf)}` }] : [read];
      }
      if (/^Request unclear/.test(t)) return [{ who: viaWho(e.detail), text: 'found no complete job, asked the owner' }];
      if (/^Room found/.test(t)) {
        const opt = nameIn(t, /option (\S+)/);
        const n = plan?.offers.length ?? 0;
        return [
          { who: 'code', text: `planner compared ${plural(plan?.options.length || 1, 'option')}${plan ? ` · budget cap ${chf(plan.budgetCapChf)}` : ''}` },
          { who: viaWho(e.detail), text: `chose option ${opt}${n ? `, wrote ${plural(n, 'offer')} in each customer's language` : ''}` },
        ];
      }
      if (/^No room/.test(t)) return [{ who: 'code', text: 'planner found no slot that keeps every firm promise' }];
      if (/^Offers sent/.test(t)) return [{ who: 'owner', text: `sent the offers: ${e.detail}` }];
      if (/^Reply from/.test(t)) return []; // the next beat (accepted / counter / answered) carries it
      if (/^Counter-offer agreed with (.+)$/.test(t)) {
        const m = /(CHF[^→]+)→\s*(CHF\s?[\d'’,.]*\d).*\(cap (CHF\s?[\d'’,.]*\d)\)/.exec(e.detail);
        return [
          { who: 'claude', text: `agreed ${nameIn(t, /with (.+)$/)}'s counter${m ? `: ${m[2]}` : ''}, replied in their language` },
          ...(m ? [{ who: 'code' as Who, text: `checked ${m[2]} against the cap ${m[3]}` }] : []),
        ];
      }
      if (/ accepted( the board move)?$/.test(t)) {
        const who = nameIn(t, /^(.+?) accepted/);
        return [/^button/.test(e.detail)
          ? { who: 'code', text: `recorded ${who}'s yes${amt}, queued for approval` }
          : { who: viaWho(e.detail), text: `read ${who}'s reply: yes${amt}` }];
      }
      if (/ declined( the board move)?$/.test(t)) return [{ who: /^button/.test(e.detail) ? 'code' : viaWho(e.detail), text: `recorded ${nameIn(t, /^(.+?) declined/)}'s no` }];
      if (/^Answered (.+)$/.test(t)) return [{ who: viaWho(e.detail), text: `answered ${nameIn(t, /^Answered (.+)$/)}` }];
      if (/^Capture-less booked for (.+)$/.test(t)) return [{ who: 'code', text: `booked capture less for ${nameIn(t, /for (.+)$/)}${amt} at shipment` }];
      if (/^Board move reviewed/.test(t)) {
        const r = state.move?.review;
        return [
          { who: 'code', text: r?.offer ? `priced the move · ${chf(r.offer.compensationChf)}, cap ${chf(r.offer.capChf)}` : 'checked the move against the promised date' },
          ...(r?.offer ? [{ who: (state.move?.draftedBy === 'llm' ? 'claude' : 'code') as Who, text: `drafted the offer to ${r.customerName} (${r.offer.lang.toUpperCase()})` }] : []),
        ];
      }
      return [{ who: viaWho(e.detail), text: t.charAt(0).toLowerCase() + t.slice(1) }];
    }
    case 'guardrail': {
      if (/^(Board move )?[Ww]aiting for owner approval/.test(t)) {
        const m = /(\d+)\/(\d+) checks pass/.exec(e.detail);
        return [{ who: 'code', text: m ? `${m[1]} of ${m[2]} guardrail checks pass · nothing paid yet` : 'guardrail checks ready · nothing paid yet' }];
      }
      if (/^Escalated to owner: (.+)$/.test(t)) return [{ who: viaWho(e.detail), text: `handed ${nameIn(t, /: (.+)$/)}'s reply to the owner · nothing changed` }];
      if (/^Template offer for (.+)$/.test(t)) return [{ who: 'code', text: `wrote a template offer for ${nameIn(t, /for (.+)$/)}` }];
      return [{ who: 'code', text: `${t.charAt(0).toLowerCase() + t.slice(1)}` }];
    }
    case 'owner': {
      if (/^Owner approved the money moves/.test(t)) return [{ who: 'owner', text: `approved ${e.detail.split(',')[0]}` }];
      return [{ who: 'owner', text: t.replace(/^Owner /, '').replace(/^\w/, (c) => c.toLowerCase()) }];
    }
    case 'api':
    case 'webhook': {
      const title = isPayPalEvent(t) ? paypalEventLabel(t) : t;
      return [{ who: 'paypal', text: `${title.charAt(0).toLowerCase() + title.slice(1)}${amt}` }];
    }
    case 'system': {
      if (/reset/i.test(t)) return [];
      if (/committed/i.test(t)) return [{ who: 'paypal', text: `confirmed the hold · schedule committed${amt ? ` · net +${chf(e.amountChf!)}` : ''}` }];
      if (e.paypalId || /PayPal|Payout|Buyer|Compensation delivered/i.test(t)) return [{ who: 'paypal', text: `${t.charAt(0).toLowerCase() + t.slice(1)}${amt}` }];
      return [];
    }
  }
}

export function ClaudeCodeStrip({ state }: { state: DemoState }) {
  // Oldest → newest since the last reset; keep the last three beats.
  const events = state.ledger.slice(0, 60);
  const resetAt = events.findIndex((e) => e.source === 'system' && /reset/i.test(e.title));
  const run = (resetAt === -1 ? events : events.slice(0, resetAt)).slice().reverse();
  const beats: Beat[] = run.flatMap((e, k) => (echoes(e, run[k - 1]) ? [] : beatsOf(e, state).map((b, i) => ({ ...b, id: `${e.id}-${i}` }))));
  const last = beats.slice(-3);
  return (
    <section className="cc-strip" aria-label="Who did what: Claude, code, owner, PayPal">
      <div className="cc-key">
        {(Object.keys(WHO_LABEL) as Who[]).map((w) => (
          <span key={w} className={`cc-${w}`}><i aria-hidden>●</i><b>{WHO_LABEL[w]}</b> {WHO_ROLE[w]}</span>
        ))}
      </div>
      <ol className="cc-lines" aria-live="polite">
        {last.length === 0 && <li className="cc-empty">Nothing yet. Open the request and watch who does what.</li>}
        {last.map((b) => (
          <li key={b.id} className={`cc-${b.who}`}>
            <span className="cc-who"><i aria-hidden>●</i>{WHO_LABEL[b.who]}</span>
            <span className="cc-text">{b.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
