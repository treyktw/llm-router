/**
 * Whether a provider will actually answer.
 *
 * A configured key means someone typed a secret, not that a call will succeed.
 * A valid key on an account with no balance is the classic case: every request
 * comes back "insufficient balance", and offering that provider in the picker
 * offers something that cannot work.
 *
 * Learned from real calls rather than a probe. A health check costs a request
 * per provider per interval and still only knows what was true when it ran;
 * this knows what happened the last time someone actually used it.
 */

/**
 * How long an unusable provider stays hidden before it is offered again.
 *
 * Only applies to faults that time can fix. An empty balance is not one of
 * those -- it stays until someone pays -- so it is held until a call succeeds
 * or the fault is cleared by hand.
 */
export const RECOVERABLE_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Consecutive failures after which a provider is treated as broken regardless
 * of what it said.
 *
 * Three, because one is noise and two is a coincidence. This exists because
 * some providers do not report their own faults usefully -- an account-level
 * failure can reach us as a bare "Not Found" -- and a count does not need to
 * understand the error to be right about it.
 */
export const FAILURES_BEFORE_TERMINAL = 3;

/**
 * Everything the provider actually said.
 *
 * The SDK's `message` is often a summary that loses the cause: a provider can
 * answer a balance failure with an HTTP error whose body names it, and the
 * summary still says something generic. Classifying on the summary alone marks
 * an empty account as a transient fault and re-offers it every cooldown forever.
 *
 * The response body is where the truth is, so it is read when present.
 */
export function faultText(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;

  const parts: string[] = [];
  const source = error as {
    message?: unknown;
    responseBody?: unknown;
    data?: unknown;
    statusCode?: unknown;
    cause?: unknown;
  };

  if (typeof source.message === 'string') parts.push(source.message);
  if (typeof source.responseBody === 'string') parts.push(source.responseBody);
  if (source.data !== undefined) {
    try {
      parts.push(JSON.stringify(source.data));
    } catch {
      // A body that will not serialise tells us nothing; the rest still might.
    }
  }
  if (typeof source.statusCode === 'number') parts.push(`status ${source.statusCode}`);
  if (source.cause && source.cause !== error) parts.push(faultText(source.cause));

  return parts.join(' | ');
}

/** Faults that stay until a human does something. */
export function isTerminalFault(message: string): boolean {
  const lower = message.toLowerCase();
  return /balance|recharge|insufficient|credit|billing|quota|expired|invalid.?api.?key|unauthorized|forbidden/.test(
    lower,
  );
}

/** A short reason worth showing beside a model. */
export function describeFault(message: string): string {
  const lower = message.toLowerCase();
  if (/balance|recharge|insufficient|credit|billing/.test(lower)) return 'out of credit';
  if (/quota/.test(lower)) return 'quota exhausted';
  if (/invalid.?api.?key|unauthorized|forbidden/.test(lower)) return 'key was rejected';
  if (/rate.?limit|429/.test(lower)) return 'rate limited';
  if (/not found|404/.test(lower)) return 'model or endpoint not found';
  if (/timeout|timed out/.test(lower)) return 'not responding';
  return 'unavailable';
}

/** One row per provider: the last thing a real call told us. */
export interface ProviderHealthRecord {
  provider: string;
  status: 'ok' | 'unusable';
  reason: string | null;
  /** False once the fault is one that waiting cannot fix. */
  recoverable: boolean;
  /** Consecutive failures since the last success. */
  failures: number;
  observedAt: number;
}

export interface UnusableProvider {
  provider: string;
  reason: string | null;
  recoverable: boolean;
  observedAt: number;
}

export interface CallOutcome {
  provider: string;
  ok: boolean;
  /** Use `faultText(error)` so the classification sees the response body. */
  message?: string;
}

/**
 * Persistence for provider health. The original implementation was a pair of
 * database mutations/queries; anything that can load and save one row per
 * provider will do.
 */
export interface HealthStore {
  get(provider: string): Promise<ProviderHealthRecord | undefined>;
  put(record: ProviderHealthRecord): Promise<void>;
  all(): Promise<ProviderHealthRecord[]>;
  /** Clear a fault by hand — e.g. after topping up an account. */
  clear(provider: string): Promise<void>;
}

/**
 * The state transition for one real call. Pure: given the previous row (if
 * any) and what happened, returns the next row.
 */
export function nextHealthRecord(
  existing: ProviderHealthRecord | undefined,
  outcome: CallOutcome,
  now: number,
): ProviderHealthRecord {
  if (outcome.ok) {
    return {
      provider: outcome.provider,
      status: 'ok',
      reason: null,
      recoverable: true,
      failures: 0,
      observedAt: now,
    };
  }

  const failures = (existing?.failures ?? 0) + 1;
  const message = outcome.message ?? '';
  return {
    provider: outcome.provider,
    status: 'unusable',
    reason: describeFault(message),
    // Stops ageing out once it has failed enough times. A provider that has
    // failed every recent attempt is not having a moment.
    recoverable: !isTerminalFault(message) && failures < FAILURES_BEFORE_TERMINAL,
    failures,
    observedAt: now,
  };
}

/**
 * Whether a row still counts against the provider.
 *
 * A recoverable fault ages out on its own; a terminal one does not, because
 * nothing about waiting adds money to an account.
 */
export function isCurrentlyUnusable(
  record: ProviderHealthRecord,
  now: number,
  cooldownMs: number = RECOVERABLE_COOLDOWN_MS,
): boolean {
  if (record.status !== 'unusable') return false;
  return !record.recoverable || now - record.observedAt < cooldownMs;
}

export interface ProviderHealthOptions {
  store?: HealthStore;
  now?: () => number;
  cooldownMs?: number;
}

/** Records real call outcomes and answers "which providers should we skip?". */
export class ProviderHealth {
  readonly store: HealthStore;
  private readonly now: () => number;
  private readonly cooldownMs: number;

  constructor(options: ProviderHealthOptions = {}) {
    this.store = options.store ?? new InMemoryHealthStore();
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? RECOVERABLE_COOLDOWN_MS;
  }

  async record(outcome: CallOutcome): Promise<ProviderHealthRecord> {
    const existing = await this.store.get(outcome.provider);
    const next = nextHealthRecord(existing, outcome, this.now());
    await this.store.put(next);
    return next;
  }

  /** Providers currently believed unusable, and why. */
  async unusable(): Promise<UnusableProvider[]> {
    const now = this.now();
    return (await this.store.all())
      .filter((row) => isCurrentlyUnusable(row, now, this.cooldownMs))
      .map((row) => ({
        provider: row.provider,
        reason: row.reason,
        recoverable: row.recoverable,
        observedAt: row.observedAt,
      }));
  }

  async clear(provider: string): Promise<void> {
    await this.store.clear(provider);
  }
}

export class InMemoryHealthStore implements HealthStore {
  private readonly rows = new Map<string, ProviderHealthRecord>();

  async get(provider: string): Promise<ProviderHealthRecord | undefined> {
    const row = this.rows.get(provider);
    return row ? { ...row } : undefined;
  }

  async put(record: ProviderHealthRecord): Promise<void> {
    this.rows.set(record.provider, { ...record });
  }

  async all(): Promise<ProviderHealthRecord[]> {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  async clear(provider: string): Promise<void> {
    this.rows.delete(provider);
  }
}
