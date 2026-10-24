// The agent's language layer. The LLM (when configured) extracts and writes; deterministic code decides.
// The deterministic implementation below is also the on-stage fallback: the demo path never depends on an API.
import type { BumpOffer, Customer, Job, Lang, Operation } from '../../shared/types.js';
import { basePrice } from '../domain/pricing.js';
import type { BumpCandidate } from '../domain/planner.js';

export interface IntakeResult {
  customerName: string;
  contact: string;
  city: string;
  lang: Lang;
  title: string;
  material: string;
  qty: number;
  ops: Operation[];
  dueDay: number;
  basePriceChf: number;
}

export interface OfferDraft {
  message: string;
  messageEn: string;
}

export interface Negotiator {
  readonly kind: 'deterministic' | 'llm';
  intake(text: string, boardStart: Date): Promise<IntakeResult>;
  draftOffer(c: Customer, job: Job, bump: BumpCandidate, mechanism: BumpOffer['mechanism'], boardStart: Date): Promise<OfferDraft>;
}

const WEEKDAYS_EN = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const WEEKDAYS: Record<Lang, string[]> = {
  en: WEEKDAYS_EN,
  de: ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'],
  fr: ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi'],
};

export function workDayToDate(boardStart: Date, day: number): Date {
  const d = new Date(boardStart);
  d.setDate(d.getDate() + Math.floor(day / 5) * 7 + (day % 5));
  return d;
}

export function dayLabel(boardStart: Date, day: number, lang: Lang): string {
  const d = workDayToDate(boardStart, day);
  const wd = WEEKDAYS[lang][day % 5];
  const dm = `${d.getDate()}.${d.getMonth() + 1}.`;
  return lang === 'en' ? `${wd} ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}` : `${wd} ${dm}`;
}

const NUM_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, eight: 8, ten: 10, twelve: 12 };

/** Routing knowledge as code: part family -> operations. Hours = setup + per-piece time. */
function routeFor(part: string, qty: number, thicknessMm: number): Operation[] {
  const heavy = thicknessMm >= 6 ? 1.5 : 1;
  if (/bracket|plate|gusset|tab|mount/.test(part)) {
    return [
      { machineId: 'LAS1', hours: Math.max(1, Math.round((1 + qty * 0.25 * heavy) * 2) / 2), label: 'cut' },
      { machineId: 'PB1', hours: Math.max(1, Math.round((1 + qty * 0.2 * heavy) * 2) / 2), label: 'bend' },
    ];
  }
  if (/flange|housing|adapter|block/.test(part)) {
    return [{ machineId: 'MILL2', hours: Math.max(2, Math.round(1.5 + qty * 0.5)), label: 'mill' }];
  }
  return [{ machineId: 'LAS1', hours: Math.max(1, Math.round((1 + qty * 0.2) * 2) / 2), label: 'cut' }];
}

export class DeterministicNegotiator implements Negotiator {
  readonly kind = 'deterministic' as const;

  async intake(text: string): Promise<IntakeResult> {
    const t = text.toLowerCase();
    const qtyM = t.match(/(\d+)\s*(?:x|×|pcs|pieces|stück)/) ?? t.match(/\b(one|two|three|four|five|six|eight|ten|twelve)\b/);
    const qty = qtyM ? (NUM_WORDS[qtyM[1]] ?? Number(qtyM[1])) : 1;
    const thick = Number(t.match(/(\d+(?:[.,]\d+)?)\s*mm/)?.[1]?.replace(',', '.') ?? 3);
    const grade = text.match(/\b(S\d{3}|Inox|1\.4301|Alu\s?\d{4}|Ti)\b/i)?.[1] ?? 'S355';
    const part = t.match(/(bracket|plate|gusset|flange|housing|adapter|mount|guard)s?/)?.[1] ?? 'part';
    const byDay = t.match(/(?:by|before|until)\s+(monday|tuesday|wednesday|thursday|friday)/)?.[1];
    const dayIdx = WEEKDAYS_EN.findIndex((d) => (byDay ?? t).includes(d.toLowerCase()));
    const dueDay = dayIdx >= 0 ? dayIdx : 1;
    const ops = routeFor(part, qty, thick);
    const name = text.match(/(?:—|-|from)\s*([A-Z][\w-]+(?:\s[A-Z][\w-]+){0,3})\s*,\s*([A-Z][\w\s]+?)\s*$/m);
    return {
      customerName: name ? `${name[1]} (farm)` : 'Hof Schmid (farm)',
      contact: name?.[1] ?? 'Thomas Schmid',
      city: name?.[2]?.trim() ?? 'Escholzmatt',
      lang: 'en',
      title: `${part[0].toUpperCase()}${part.slice(1)}s (rush)`,
      material: `${grade} ${thick} mm`,
      qty,
      ops,
      dueDay,
      basePriceChf: basePrice(ops, 40 + qty * thick * 2),
    };
  }

  async draftOffer(c: Customer, job: Job, b: BumpCandidate, mechanism: BumpOffer['mechanism'], boardStart: Date): Promise<OfferDraft> {
    const from = (l: Lang) => dayLabel(boardStart, b.fromDay, l);
    const to = (l: Lang) => dayLabel(boardStart, b.toDay, l);
    const chf = `CHF ${b.compensationChf}`;
    const first = c.contact.split(' ')[0];
    const how: Record<Lang, string> = mechanism === 'reduced-capture'
      ? {
          en: `We simply capture ${chf} less on the PayPal authorization you already gave us — nothing to do on your side.`,
          de: `Wir buchen auf Ihrer bestehenden PayPal-Autorisierung einfach ${chf} weniger ab — Sie müssen nichts tun.`,
          fr: `Nous prélevons simplement ${chf} de moins sur votre autorisation PayPal existante — rien à faire de votre côté.`,
        }
      : {
          en: `You already paid in full, so we send ${chf} to your PayPal account right away.`,
          de: `Sie haben bereits bezahlt, deshalb überweisen wir Ihnen ${chf} sofort auf Ihr PayPal-Konto.`,
          fr: `Vous avez déjà tout payé : nous vous versons ${chf} immédiatement sur votre compte PayPal.`,
        };
    const body: Record<Lang, string> = {
      en: `Hi ${first}, a customer has an emergency repair and needs our laser on short notice. Could we deliver your ${job.title.toLowerCase()} (${job.id}) on ${to('en')} instead of ${from('en')}? As a thank-you we take ${chf} off. ${how.en}`,
      de: `Grüezi ${c.contact}, ein Kunde hat einen dringenden Notfall und braucht kurzfristig unseren Laser. Dürften wir Ihre Bestellung ${job.id} (${job.title}) am ${to('de')} statt am ${from('de')} liefern? Als Dankeschön erhalten Sie ${chf}. ${how.de}`,
      fr: `Bonjour ${c.contact}, un client a une réparation urgente et a besoin de notre laser rapidement. Pourrions-nous livrer votre commande ${job.id} (${job.title}) le ${to('fr')} au lieu du ${from('fr')} ? Pour vous remercier, nous vous offrons ${chf}. ${how.fr}`,
    };
    return { message: body[c.lang], messageEn: body.en };
  }
}

export function createNegotiator(): Negotiator {
  // LLM-backed negotiator is added once the provider is chosen (see docs/SPIKE.md); it must fall back to this one.
  return new DeterministicNegotiator();
}
