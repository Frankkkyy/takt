import type { DemoState } from '../../shared/types';

export async function getState(): Promise<DemoState> {
  const r = await fetch('/api/state');
  return r.json();
}

export async function post<T = unknown>(path: string, body?: unknown): Promise<{ result: T; state: DemoState }> {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error ?? r.statusText);
  return j;
}

const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
export function dayDate(boardStartIso: string, day: number): Date {
  const [y, m, d] = boardStartIso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + Math.floor(day / 5) * 7 + (day % 5));
  return dt;
}
export function dayShort(boardStartIso: string, day: number): string {
  const d = dayDate(boardStartIso, day);
  return `${WD[day % 5]} ${d.getDate()}.${d.getMonth() + 1}.`;
}
export const chf = (v: number) => `CHF ${v.toLocaleString('de-CH')}`;
