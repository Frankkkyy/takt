// Claude first, rules as the safety net. Any API error, rate limit, spend ceiling, refusal, or an agent run that
// does not finish falls back to the deterministic agent for that step; the UI badge shows which one ran.
import type { AgentStatus } from '../../shared/types.js';
import type { AgentResult, IntakeResult, PlanDecision, PlanInput, ReplyDecision, ReplyInput, RushAgent } from './agent.js';
import { ClaudeAgent } from './claude.js';
import { DeterministicAgent } from './deterministic.js';
import { DEFAULT_CACHE_DIR, LlmClient, type CacheMode } from './llm.js';
import type { LiveCallLimiter } from './limits.js';

export class HybridAgent implements RushAgent {
  readonly kind = 'llm' as const;
  private fallback = new DeterministicAgent();
  private lastFallback?: string;
  private lastSource: AgentStatus['last'] = null;

  constructor(private claude: ClaudeAgent) {}

  status(): AgentStatus {
    const s = this.claude.status();
    return { ...s, last: this.lastSource, fallbackReason: this.lastSource === 'fallback' ? this.lastFallback : undefined };
  }

  private async run<T>(primary: () => Promise<AgentResult<T>>, backup: () => Promise<AgentResult<T>>): Promise<AgentResult<T>> {
    try {
      const r = await primary();
      this.lastSource = r.source;
      return r;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.lastFallback = reason.slice(0, 160);
      this.lastSource = 'fallback';
      const r = await backup();
      return { ...r, source: 'fallback', fallbackReason: this.lastFallback, steps: [{ kind: 'note', title: 'Fell back to rules', detail: this.lastFallback }, ...r.steps] };
    }
  }

  intake(text: string, boardStart: Date) {
    return this.run<IntakeResult>(() => this.claude.intake(text), () => this.fallback.intake(text));
  }
  plan(input: PlanInput) {
    return this.run<PlanDecision>(() => this.claude.plan(input), () => this.fallback.plan(input));
  }
  reply(input: ReplyInput) {
    return this.run<ReplyDecision>(() => this.claude.reply(input), () => this.fallback.reply(input));
  }
}

export interface AgentEnv {
  AGENT_MODE?: string; // llm (default when a key or recorded responses exist) | deterministic
  ANTHROPIC_API_KEY?: string;
  LLM_MODEL?: string;
  LLM_EFFORT?: string;
  AGENT_CACHE?: string; // replay-or-live (default) | replay-only | live-only
  AGENT_RECORD?: string; // 1 = store live responses for replay
  AGENT_MAX_USD?: string; // per-process live spend ceiling (default 0.25)
  AGENT_MAX_CALLS_PER_MIN?: string;
}

export function createAgent(env: AgentEnv = process.env, limiter?: LiveCallLimiter): RushAgent {
  if (env.AGENT_MODE === 'deterministic') return new DeterministicAgent();
  const llm = new LlmClient({
    apiKey: env.ANTHROPIC_API_KEY || undefined,
    model: env.LLM_MODEL || 'claude-haiku-5-5',
    effort: (env.LLM_EFFORT as 'low' | 'medium' | 'high') || 'low',
    cacheDir: DEFAULT_CACHE_DIR,
    cacheMode: (env.AGENT_CACHE as CacheMode) || 'replay-or-live',
    record: env.AGENT_RECORD === '1',
    maxUsd: Number(env.AGENT_MAX_USD ?? 0.25),
    maxCallsPerMinute: Number(env.AGENT_MAX_CALLS_PER_MIN ?? 20),
    limiter,
  });
  // Without a key, Claude still "runs" for the scripted demo inputs from recorded responses; others fall back.
  return new HybridAgent(new ClaudeAgent(llm));
}
