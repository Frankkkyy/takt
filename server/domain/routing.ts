// Routing knowledge as code: part family -> operations and machine hours. The agent extracts the part family,
// quantity and thickness from free text; this function (not the LLM) turns them into hours and therefore price.
import type { Operation } from '../../shared/types.js';

export const PART_FAMILIES = ['bracket', 'plate', 'gusset', 'mount', 'tab', 'guard', 'flange', 'housing', 'adapter', 'block', 'other'] as const;
export type PartFamily = (typeof PART_FAMILIES)[number];

export function routeFor(part: string, qty: number, thicknessMm: number): Operation[] {
  const heavy = thicknessMm >= 6 ? 1.5 : 1;
  if (/bracket|plate|gusset|tab|mount|guard/.test(part)) {
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

export const materialChf = (qty: number, thicknessMm: number) => 40 + qty * thicknessMm * 2;
