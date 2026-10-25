// Rule-based agent: regex intake, cheapest planner option, DE/FR/EN templates, keyword reply parsing.
// It is the fallback whenever Claude is not configured, errors, is rate-limited, or AGENT_MODE=deterministic.
import type { AgentStatus, Lang } from '../../shared/types.js';
import { basePrice } from '../domain/pricing.js';
import { materialChf, routeFor } from '../domain/routing.js';
import type { AgentResult, BumpDetail, IntakeResult, OfferDraft, PlanDecision, PlanInput, ReplyDecision, ReplyInput, RushAgent } from './agent.js';
import { dayLabel, emptyStatus, WEEKDAYS } from './agent.js';
import { checkAmount, checkDeliveryDay, chfAmounts } from './guardrails.js';

const NUM_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12,
  zwei: 2, drei: 3, vier: 4, fünf: 5, sechs: 6, acht: 8, zehn: 10, zwölf: 12,
  deux: 2, trois: 3, quatre: 4, cinq: 5, huit: 8, dix: 10, douze: 12,
};
const PARTS: [RegExp, string][] = [
  [/bracket|halter|winkel|konsole|patte|équerre|equerre/, 'bracket'],
  [/plate|platte|plaque|blech/, 'plate'],
  [/gusset|knotenblech|gousset/, 'gusset'],
  [/flange|flansch|bride/, 'flange'],
  [/housing|gehäuse|boîtier|boitier/, 'housing'],
  [/adapter|adaptateur/, 'adapter'],
  [/guard|schutz|protection|carter/, 'guard'],
  [/mount|halterung|fixation|support/, 'mount'],
];
const DAY_WORDS: Record<string, number> = {};
for (const lang of ['en', 'de', 'fr'] as Lang[]) WEEKDAYS[lang].forEach((d, i) => (DAY_WORDS[d.toLowerCase()] = i));

function detectLang(t: string): Lang {
  const de = (t.match(/\b(brauche|bis|und|wir|ich|stück|halter|bitte|gruss|grüsse|dienstag|montag|mittwoch|donnerstag|freitag|ja|nein|passt|aber)\b/g) ?? []).length;
  const fr = (t.match(/\b(il|faut|pour|nous|je|pièces|merci|bonjour|lundi|mardi|mercredi|jeudi|vendredi|oui|mais|d'accord|plutôt)\b/g) ?? []).length;
  const en = (t.match(/\b(need|by|the|we|our|please|thanks|monday|tuesday|wednesday|thursday|friday|yes|but)\b/g) ?? []).length;
  return de > en && de >= fr ? 'de' : fr > en && fr > de ? 'fr' : 'en';
}

/** First weekday mentioned, shifted by a week when the text says "next week". */
export function findDay(text: string): number | undefined {
  const t = text.toLowerCase();
  const m = t.match(/\b(monday|tuesday|wednesday|thursday|friday|montag|dienstag|mittwoch|donnerstag|freitag|lundi|mardi|mercredi|jeudi|vendredi)\b/);
  if (!m) return undefined;
  const next = /next week|nächste[nr]? woche|semaine prochaine/.test(t) ? 5 : 0;
  return DAY_WORDS[m[1]] + next;
}

export class DeterministicAgent implements RushAgent {
  readonly kind = 'deterministic' as const;
  private st: AgentStatus = emptyStatus('deterministic', 'rules');

  status() {
    return this.st;
  }

  private done<T>(value: T, title: string, detail: string): AgentResult<T> {
    this.st.last = 'deterministic';
    return { value, source: 'deterministic', steps: [{ kind: 'note', title, detail }] };
  }

  async intake(text: string): Promise<AgentResult<IntakeResult>> {
    return this.done(parseIntake(text), 'Rules parsed the request', 'Regex intake (no LLM)');
  }

  async plan(input: PlanInput): Promise<AgentResult<PlanDecision>> {
    const view = input.runPlanner([]);
    const opt = view.options[0];
    if (!opt) return this.done({ optionId: '', justification: view.reason, drafts: {} }, 'No feasible option', view.reason);
    const drafts: Record<string, OfferDraft> = {};
    for (const b of opt.bumps) drafts[b.jobId] = templateOffer(b, input.boardStart);
    const who = opt.bumps.map((b) => `${b.customerName} (+${b.delayDays} d, CHF ${b.compensationChf})`).join(' and ');
    const justification = opt.bumps.length
      ? `Cheapest of ${view.options.length} feasible option(s): ask ${who}. Total CHF ${opt.compensationTotalChf} of a CHF ${opt.budgetCapChf} budget; net uplift CHF ${opt.netUpliftChf}.`
      : 'The rush job fits without moving anyone.';
    return this.done({ optionId: opt.optionId, justification, drafts }, `Chose option ${opt.optionId}`, justification);
  }

  async reply(input: ReplyInput): Promise<AgentResult<ReplyDecision>> {
    return this.done(parseReply(input), 'Rules parsed the reply', 'Keyword parsing (no LLM)');
  }
}

export function parseIntake(text: string): IntakeResult {
  const t = text.toLowerCase();
  const numM = t.match(/(?<![\w.,'])(?<!chf\s?)(\d{1,3})(?![\d.,]*\s*(?:mm|h\b|uhr|%|chf|fr\b))/);
  const wordM = t.match(/\b(one|two|three|four|five|six|eight|ten|twelve|zwei|drei|vier|fünf|sechs|acht|zehn|zwölf|deux|trois|quatre|cinq|huit|dix|douze)\b/);
  const qty = numM ? Number(numM[1]) : wordM ? NUM_WORDS[wordM[1]] : 1;
  const thick = Number(t.match(/(\d+(?:[.,]\d+)?)\s*mm/)?.[1]?.replace(',', '.') ?? 3);
  const grade = text.match(/\b(S\d{3}|Inox|1\.4301|Alu\s?\d{4}|Ti)\b/i)?.[1] ?? 'S355';
  const part = PARTS.find(([re]) => re.test(t))?.[1] ?? 'part';
  const dueDay = findDay(text) ?? 1;
  const lang = detectLang(t);
  const ops = routeFor(part, qty, thick);
  const sig = text.match(/(?:—|–|-|from|von|de)\s*([A-ZÄÖÜ][\wäöüéè-]+(?:\s[A-ZÄÖÜ][\wäöüéè-]+){0,3})\s*,\s*([A-ZÄÖÜ][\wäöüéè\s-]+?)\s*$/m);
  const title = part === 'part' ? 'Parts' : `${part[0].toUpperCase()}${part.slice(1)}s`;
  return {
    customerName: sig ? sig[1] : 'Hof Schmid (farm)',
    contact: sig?.[1] ?? 'Thomas Schmid',
    city: sig?.[2]?.trim() ?? 'Escholzmatt',
    lang,
    title: `${title} (rush)`,
    material: `${grade} ${thick} mm`,
    qty,
    ops,
    dueDay,
    basePriceChf: basePrice(ops, materialChf(qty, thick)),
    partFamily: part,
    thicknessMm: thick,
  };
}

export function templateOffer(b: BumpDetail, boardStart: Date, chf = b.compensationChf, toDay = b.toDay): OfferDraft {
  const from = (l: Lang) => dayLabel(boardStart, b.fromDay, l);
  const to = (l: Lang) => dayLabel(boardStart, toDay, l);
  const amount = `CHF ${chf}`;
  const first = b.contact.split(' ')[0];
  const how: Record<Lang, string> = b.mechanism === 'reduced-capture'
    ? {
        en: `We simply capture ${amount} less on the PayPal authorization you already gave us — nothing to do on your side.`,
        de: `Wir buchen auf Ihrer bestehenden PayPal-Autorisierung einfach ${amount} weniger ab — Sie müssen nichts tun.`,
        fr: `Nous prélevons simplement ${amount} de moins sur votre autorisation PayPal existante — rien à faire de votre côté.`,
      }
    : {
        en: `You already paid in full, so we send ${amount} to your PayPal account right away.`,
        de: `Sie haben bereits bezahlt, deshalb überweisen wir Ihnen ${amount} sofort auf Ihr PayPal-Konto.`,
        fr: `Vous avez déjà tout payé : nous vous versons ${amount} immédiatement sur votre compte PayPal.`,
      };
  const body: Record<Lang, string> = {
    en: `Hi ${first}, a customer has an emergency repair and needs our laser on short notice. Could we deliver your ${b.jobTitle.toLowerCase()} (${b.jobId}) on ${to('en')} instead of ${from('en')}? As a thank-you we take ${amount} off. ${how.en}`,
    de: `Grüezi ${b.contact}, ein Kunde hat einen dringenden Notfall und braucht kurzfristig unseren Laser. Dürften wir Ihre Bestellung ${b.jobId} (${b.jobTitle}) am ${to('de')} statt am ${from('de')} liefern? Als Dankeschön erhalten Sie ${amount}. ${how.de}`,
    fr: `Bonjour ${b.contact}, un client a une réparation urgente et a besoin de notre laser rapidement. Pourrions-nous livrer votre commande ${b.jobId} (${b.jobTitle}) le ${to('fr')} au lieu du ${from('fr')} ? Pour vous remercier, nous vous offrons ${amount}. ${how.fr}`,
  };
  return { message: body[b.lang], messageEn: body.en };
}

const INJECTION = /ignore (all|any|the|previous|your)|instructions|system prompt|\bsystem:|admin mode|developer mode|override|jailbreak|you are now|payout to|send (the )?money to|https?:\/\/|[\w.+-]+@[\w-]+\.[\w.]+/i;
const ACCEPT = /\b(ok|okay|yes|ja|oui|d'accord|daccord|einverstanden|passt|gerne|parfait|fine|deal|agreed|volontiers|bien sûr|no problem|kein problem|pas de (souci|problème)|sounds good|abgemacht|super)\b/i;
const DECLINE = /\b(no|nein|non|leider|can't|cannot|can not|impossible|unfortunately|sorry|pas possible|geht nicht|nicht möglich|désolé)\b/i;

const SHOP_REPLY: Record<'cap' | 'early' | 'confirm', Record<Lang, (chf: number, day: string) => string>> = {
  cap: {
    en: (c) => `Thank you! The most we can offer for this move is CHF ${c}. Shall we go ahead on that basis?`,
    de: (c) => `Vielen Dank! Für diese Verschiebung können wir höchstens CHF ${c} anbieten. Sollen wir so verbleiben?`,
    fr: (c) => `Merci ! Pour ce report, nous pouvons offrir au maximum CHF ${c}. Est-ce que cela vous convient ?`,
  },
  early: {
    en: (c, d) => `Thank you! The earliest we can deliver is ${d}, with CHF ${c} as a thank-you. Does that work?`,
    de: (c, d) => `Vielen Dank! Frühestens können wir am ${d} liefern, mit CHF ${c} als Dankeschön. Passt das?`,
    fr: (c, d) => `Merci ! Au plus tôt, nous pouvons livrer le ${d}, avec CHF ${c} en remerciement. Cela vous convient-il ?`,
  },
  confirm: {
    en: (c, d) => `Thank you! Confirmed: delivery on ${d} and CHF ${c} for you.`,
    de: (c, d) => `Vielen Dank! Bestätigt: Lieferung am ${d} und CHF ${c} für Sie.`,
    fr: (c, d) => `Merci ! C'est confirmé : livraison le ${d} et CHF ${c} pour vous.`,
  },
};

export function parseReply(input: ReplyInput): ReplyDecision {
  const { offer, replyText, ceilingChf, boardStart } = input;
  const lang = offer.lang;
  const text = replyText.trim();
  if (INJECTION.test(text)) return { action: 'escalate', reason: 'Reply contains instructions, links or payment details: handed to the owner' };
  const amounts = chfAmounts(text);
  const day = findDay(text);
  const chf = amounts.length ? Math.max(...amounts) : offer.compensationChf;
  const toDay = day ?? offer.toDay;
  const wantsChange = amounts.some((a) => a !== offer.compensationChf) || (day !== undefined && day !== offer.toDay);
  const msg = (k: keyof typeof SHOP_REPLY, c: number, d: number) => ({ message: SHOP_REPLY[k][lang](c, dayLabel(boardStart, d, lang)), messageEn: SHOP_REPLY[k].en(c, dayLabel(boardStart, d, 'en')) });
  if (wantsChange) {
    if (!checkAmount(chf, ceilingChf).ok) return { action: 'reply', compensationChf: ceilingChf, reason: `Counter of CHF ${chf} is above the cap CHF ${ceilingChf}`, ...msg('cap', ceilingChf, offer.toDay) };
    if (!checkDeliveryDay(toDay, offer.toDay).ok) return { action: 'reply', compensationChf: offer.compensationChf, reason: 'Requested date is earlier than feasible', ...msg('early', offer.compensationChf, offer.toDay) };
    return { action: 'counter', compensationChf: chf, deliveryDay: toDay, reason: `Counter-offer within limits: CHF ${chf}, day ${toDay}`, ...msg('confirm', chf, toDay) };
  }
  if (ACCEPT.test(text)) return { action: 'accept', reason: 'Reply reads as a yes', ...msg('confirm', offer.compensationChf, offer.toDay) };
  if (DECLINE.test(text)) return { action: 'decline', reason: 'Reply reads as a no' };
  return { action: 'escalate', reason: 'Could not tell what the customer wants' };
}
