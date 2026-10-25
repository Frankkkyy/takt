// Thin wrapper around the Anthropic Messages API with:
//  - record / replay: responses are stored by a hash of the exact request, so the scripted demo inputs replay
//    recorded Claude responses (cost 0, never fails on stage) while new inputs go live;
//  - spend guard: a hard USD ceiling per process and a per-minute call limit; beyond it the caller falls back
//    to the deterministic agent;
//  - token / cost accounting for the UI badge and the eval report.
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiveCallLimiter, LlmUnavailable } from './limits.js';
export { LlmUnavailable };

// Claude Haiku 5.5, prompts ≤ 100K tokens (USD per million tokens).
export const PRICE_PER_MTOK = { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 };

export type CacheMode = 'replay-or-live' | 'replay-only' | 'live-only';

export interface LlmOptions {
  apiKey?: string;
  model: string;
  effort?: 'low' | 'medium' | 'high';
  cacheDir?: string;
  cacheMode?: CacheMode;
  /** Write live responses to the cache (scripts/agent-eval.ts --record, or AGENT_RECORD=1). */
  record?: boolean;
  maxUsd?: number;
  maxCallsPerMinute?: number;
  /** Hosted demo: per-session / per-IP / per-day limits on live calls (replays are never counted). */
  limiter?: LiveCallLimiter;
}

export interface LlmUsage {
  liveCalls: number;
  replayCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}


export interface CreateArgs {
  system: string;
  tools: Anthropic.Tool[];
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
}

export interface LlmTransport {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CACHE_DIR = path.join(here, 'llm-cache');

export function costOf(u: Anthropic.Usage): number {
  return (
    ((u.input_tokens ?? 0) * PRICE_PER_MTOK.input +
      (u.output_tokens ?? 0) * PRICE_PER_MTOK.output +
      (u.cache_creation_input_tokens ?? 0) * PRICE_PER_MTOK.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * PRICE_PER_MTOK.cacheRead) /
    1e6
  );
}

export class LlmClient {
  readonly model: string;
  readonly usage: LlmUsage = { liveCalls: 0, replayCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  private transport?: LlmTransport;
  private recent: number[] = [];

  constructor(private opts: LlmOptions, transport?: LlmTransport) {
    this.model = opts.model;
    if (transport) this.transport = transport;
    else if (opts.apiKey) {
      const client = new Anthropic({ apiKey: opts.apiKey, timeout: 25_000, maxRetries: 1 });
      this.transport = { create: (p) => client.messages.create(p) };
    }
  }

  get canGoLive() {
    return !!this.transport && this.opts.cacheMode !== 'replay-only';
  }

  private params(a: CreateArgs): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: a.maxTokens ?? 4000,
      system: a.system,
      tools: a.tools,
      messages: a.messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: this.opts.effort ?? 'low' },
      cache_control: { type: 'ephemeral' },
    };
  }

  static key(p: Anthropic.MessageCreateParamsNonStreaming): string {
    return createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 24);
  }

  private file(key: string) {
    return path.join(this.opts.cacheDir ?? DEFAULT_CACHE_DIR, `${key}.json`);
  }

  async create(a: CreateArgs): Promise<{ message: Anthropic.Message; source: 'live' | 'replay' }> {
    const p = this.params(a);
    const key = LlmClient.key(p);
    const f = this.file(key);
    if (this.opts.cacheMode !== 'live-only' && existsSync(f)) {
      const message = JSON.parse(readFileSync(f, 'utf8')).response as Anthropic.Message;
      this.usage.replayCalls++;
      return { message, source: 'replay' };
    }
    if (!this.canGoLive) throw new LlmUnavailable(this.transport ? 'no recorded response for this input (replay-only mode)' : 'no ANTHROPIC_API_KEY');
    if (this.usage.costUsd >= (this.opts.maxUsd ?? 0.25)) throw new LlmUnavailable(`spend ceiling of USD ${this.opts.maxUsd ?? 0.25} reached`);
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= (this.opts.maxCallsPerMinute ?? 20)) throw new LlmUnavailable('rate limit (calls per minute) reached');
    this.opts.limiter?.reserve();
    this.recent.push(now);

    const message = await this.transport!.create(p);
    this.usage.liveCalls++;
    this.usage.inputTokens += (message.usage.input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0) + (message.usage.cache_creation_input_tokens ?? 0);
    this.usage.outputTokens += message.usage.output_tokens ?? 0;
    this.usage.costUsd += costOf(message.usage);
    if (this.opts.record) {
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify({ key, model: this.model, recordedAt: new Date().toISOString(), response: message }, null, 1));
    }
    return { message, source: 'live' };
  }
}
