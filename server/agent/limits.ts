// Live-Claude budget for the hosted demo. Only *live* API calls count: recorded (replayed) responses for the scripted
// demo inputs are free and never limited. Three limits, all checked before a live call:
//   - per demo session per hour (one browser = one session),
//   - per client IP per hour (so clearing cookies does not reset the session limit; needs `trust proxy` on Render),
//   - a global cap per UTC day that protects the API budget whatever the traffic.
// When a limit is hit the caller gets LlmUnavailable, and the hybrid agent answers with the rule-based fallback;
// the UI shows "rules (fallback)" with the reason.
import { AsyncLocalStorage } from 'node:async_hooks';

export class LlmUnavailable extends Error {}

/** Who is asking. Set by the HTTP layer around each request (AsyncLocalStorage), absent in scripts and tests. */
export interface LiveScope {
  sessionId: string;
  ip?: string;
}
export const liveScope = new AsyncLocalStorage<LiveScope>();

export interface LiveLimits {
  perSessionPerHour: number;
  perIpPerHour: number;
  perDay: number;
}

export interface LiveRemaining {
  session: number | null;
  today: number;
}

const HOUR = 3_600_000;

export class LiveCallLimiter {
  private bySession = new Map<string, number[]>();
  private byIp = new Map<string, number[]>();
  private day = { key: '', calls: 0 };

  constructor(readonly limits: LiveLimits, private now: () => number = Date.now) {}

  private recent(map: Map<string, number[]>, key: string) {
    const t = this.now();
    const list = (map.get(key) ?? []).filter((x) => t - x < HOUR);
    map.set(key, list);
    return list;
  }

  private today() {
    const key = new Date(this.now()).toISOString().slice(0, 10);
    if (this.day.key !== key) this.day = { key, calls: 0 };
    return this.day;
  }

  /** Throws LlmUnavailable when any limit is reached; otherwise counts one live call. */
  reserve(scope = liveScope.getStore()) {
    const day = this.today();
    if (day.calls >= this.limits.perDay) throw new LlmUnavailable(`daily live-AI cap of the public demo reached (${this.limits.perDay} calls)`);
    const s = scope ? this.recent(this.bySession, scope.sessionId) : undefined;
    if (s && s.length >= this.limits.perSessionPerHour) throw new LlmUnavailable(`live-AI limit for this demo session reached (${this.limits.perSessionPerHour} calls per hour)`);
    const ip = scope?.ip ? this.recent(this.byIp, scope.ip) : undefined;
    if (ip && ip.length >= this.limits.perIpPerHour) throw new LlmUnavailable(`live-AI limit for this network reached (${this.limits.perIpPerHour} calls per hour)`);
    const t = this.now();
    s?.push(t);
    ip?.push(t);
    day.calls++;
  }

  remaining(sessionId?: string): LiveRemaining {
    return {
      session: sessionId ? Math.max(0, this.limits.perSessionPerHour - this.recent(this.bySession, sessionId).length) : null,
      today: Math.max(0, this.limits.perDay - this.today().calls),
    };
  }

  /** Drop counters of sessions that no longer exist (memory hygiene for long-running hosts). */
  forget(sessionId: string) {
    this.bySession.delete(sessionId);
  }
}
