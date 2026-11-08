// One place for money and count wording, used by the owner console and the server's owner-facing text
// (log, plan explanation, approval checklist). Customer offer texts keep their own language rules.

/** "CHF 2,055": the same grouping as the README and the Devpost write-up. */
export const chf = (v: number) => `CHF ${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** "1 day", "2 days"; pass the plural when it is not just "+s" ("1 option", "3 options"). */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Owner-facing machine names (ids like LAS1 stay in code and the PayPal/agent log). */
export const MACHINE_SHORT: Record<string, string> = { LAS1: 'laser', PB1: 'press brake', MILL1: '5-axis mill', MILL2: '3-axis mill' };
