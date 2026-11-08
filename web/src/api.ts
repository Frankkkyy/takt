import type { DemoState } from '../../shared/types';

export async function getState(): Promise<DemoState> {
  const r = await fetch('/api/state', { credentials: 'same-origin' });
  return r.json();
}

export async function post<T = unknown>(path: string, body?: unknown): Promise<{ result: T; state: DemoState }> {
  const r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const WD_LANG: Record<'en' | 'de' | 'fr', string[]> = {
  en: WD,
  de: ['Mo', 'Di', 'Mi', 'Do', 'Fr'],
  fr: ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.'],
};
export function dayDate(boardStartIso: string, day: number): Date {
  const [y, m, d] = boardStartIso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + Math.floor(day / 5) * 7 + (day % 5));
  return dt;
}
export function dayShort(boardStartIso: string, day: number, lang: 'en' | 'de' | 'fr' = 'en'): string {
  const d = dayDate(boardStartIso, day);
  return `${WD_LANG[lang][day % 5]} ${d.getDate()}.${d.getMonth() + 1}.`;
}
/** "Fri 6 Nov" */
export function dayLong(boardStartIso: string, day: number): string {
  const d = dayDate(boardStartIso, day);
  return `${WD[day % 5]} ${d.getDate()} ${d.toLocaleString('en-GB', { month: 'short' })}`;
}
export { chf, plural, MACHINE_SHORT } from '../../shared/format';
