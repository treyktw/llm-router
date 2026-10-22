import { describe, expect, it } from 'vitest';
import {
  describeFault,
  FAILURES_BEFORE_TERMINAL,
  faultText,
  InMemoryHealthStore,
  isCurrentlyUnusable,
  isTerminalFault,
  nextHealthRecord,
  ProviderHealth,
  RECOVERABLE_COOLDOWN_MS,
} from '../src/health.js';

/** A controllable clock for cooldown tests. */
const makeClock = (start = 1_000_000) => {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
};

const makeHealth = () => {
  const clock = makeClock();
  const health = new ProviderHealth({ now: clock.now });
  return { clock, health };
};

describe('cooldown for recoverable faults', () => {
  it('hides a provider after one transient failure', async () => {
    const { health } = makeHealth();
    await health.record({ provider: 'google', ok: false, message: 'Request timed out' });
    expect(await health.unusable()).toEqual([
      { provider: 'google', reason: 'not responding', recoverable: true, observedAt: 1_000_000 },
    ]);
  });

  it('is still hidden just before the cooldown ends', async () => {
    const { clock, health } = makeHealth();
    await health.record({ provider: 'google', ok: false, message: 'rate limit exceeded' });
    clock.advance(RECOVERABLE_COOLDOWN_MS - 1);
    expect(await health.unusable()).toHaveLength(1);
  });

  it('is offered again once the cooldown has passed', async () => {
    const { clock, health } = makeHealth();
    await health.record({ provider: 'google', ok: false, message: 'rate limit exceeded' });
    clock.advance(RECOVERABLE_COOLDOWN_MS);
    expect(await health.unusable()).toEqual([]);
  });

  it('honours a custom cooldown', async () => {
    const clock = makeClock();
    const health = new ProviderHealth({ now: clock.now, cooldownMs: 1_000 });
    await health.record({ provider: 'google', ok: false, message: 'timeout' });
    clock.advance(999);
    expect(await health.unusable()).toHaveLength(1);
    clock.advance(1);
    expect(await health.unusable()).toHaveLength(0);
  });

  it('each new failure restarts the cooldown', async () => {
    const { clock, health } = makeHealth();
    await health.record({ provider: 'google', ok: false, message: 'timeout' });
    clock.advance(RECOVERABLE_COOLDOWN_MS - 10);
    await health.record({ provider: 'google', ok: false, message: 'timeout' });
    clock.advance(20);
    expect(await health.unusable()).toHaveLength(1);
  });
});

describe('three strikes → down', () => {
  it(`stays recoverable for ${FAILURES_BEFORE_TERMINAL - 1} failures, terminal on the ${FAILURES_BEFORE_TERMINAL}rd`, async () => {
    const { health } = makeHealth();
    const first = await health.record({ provider: 'zhipu', ok: false, message: 'Not Found' });
    const second = await health.record({ provider: 'zhipu', ok: false, message: 'Not Found' });
    const third = await health.record({ provider: 'zhipu', ok: false, message: 'Not Found' });
    expect([first.failures, second.failures, third.failures]).toEqual([1, 2, 3]);
    expect([first.recoverable, second.recoverable, third.recoverable]).toEqual([true, true, false]);
    expect(third.reason).toBe('model or endpoint not found');
  });

  it('a terminal provider does not age out', async () => {
    const { clock, health } = makeHealth();
    for (let i = 0; i < FAILURES_BEFORE_TERMINAL; i += 1) {
      await health.record({ provider: 'zhipu', ok: false, message: 'Not Found' });
    }
    clock.advance(RECOVERABLE_COOLDOWN_MS * 100);
    expect(await health.unusable()).toEqual([
      { provider: 'zhipu', reason: 'model or endpoint not found', recoverable: false, observedAt: 1_000_000 },
    ]);
  });

  it('a terminal fault message is terminal on the first failure', async () => {
    const { clock, health } = makeHealth();
    const row = await health.record({ provider: 'deepseek', ok: false, message: 'Insufficient Balance' });
    expect(row.recoverable).toBe(false);
    expect(row.reason).toBe('out of credit');
    clock.advance(RECOVERABLE_COOLDOWN_MS * 10);
    expect(await health.unusable()).toHaveLength(1);
  });

  it('failures are counted per provider', async () => {
    const { health } = makeHealth();
    await health.record({ provider: 'a', ok: false, message: 'timeout' });
    await health.record({ provider: 'a', ok: false, message: 'timeout' });
    const b = await health.record({ provider: 'b', ok: false, message: 'timeout' });
    expect(b.failures).toBe(1);
    expect(b.recoverable).toBe(true);
  });
});

describe('recovery', () => {
  it('one success clears a recoverable fault and resets the count', async () => {
    const { health } = makeHealth();
    await health.record({ provider: 'google', ok: false, message: 'timeout' });
    await health.record({ provider: 'google', ok: false, message: 'timeout' });
    const ok = await health.record({ provider: 'google', ok: true });
    expect(ok).toEqual({ provider: 'google', status: 'ok', reason: null, recoverable: true, failures: 0, observedAt: 1_000_000 });
    expect(await health.unusable()).toEqual([]);

    // The count really reset: the next failure is #1 again, not #3.
    const again = await health.record({ provider: 'google', ok: false, message: 'timeout' });
    expect(again.failures).toBe(1);
    expect(again.recoverable).toBe(true);
  });

  it('a success also clears a terminal fault (someone paid)', async () => {
    const { health } = makeHealth();
    await health.record({ provider: 'deepseek', ok: false, message: 'insufficient balance' });
    await health.record({ provider: 'deepseek', ok: true });
    expect(await health.unusable()).toEqual([]);
  });

  it('a fault can be cleared by hand', async () => {
    const { health } = makeHealth();
    await health.record({ provider: 'deepseek', ok: false, message: 'billing problem' });
    await health.clear('deepseek');
    expect(await health.unusable()).toEqual([]);
    expect(await health.store.get('deepseek')).toBeUndefined();
  });

  it('a first-ever success creates an ok row', async () => {
    const { health } = makeHealth();
    await health.record({ provider: 'openai', ok: true });
    expect((await health.store.get('openai'))?.status).toBe('ok');
  });
});

describe('nextHealthRecord / isCurrentlyUnusable (pure)', () => {
  it('treats a missing message as an unknown, recoverable fault', () => {
    const row = nextHealthRecord(undefined, { provider: 'x', ok: false }, 5);
    expect(row).toEqual({ provider: 'x', status: 'unusable', reason: 'unavailable', recoverable: true, failures: 1, observedAt: 5 });
  });

  it('ok rows are never unusable', () => {
    expect(isCurrentlyUnusable(nextHealthRecord(undefined, { provider: 'x', ok: true }, 0), 0)).toBe(false);
  });

  it('uses the default cooldown when none is passed', () => {
    const row = nextHealthRecord(undefined, { provider: 'x', ok: false, message: 'timeout' }, 0);
    expect(isCurrentlyUnusable(row, RECOVERABLE_COOLDOWN_MS - 1)).toBe(true);
    expect(isCurrentlyUnusable(row, RECOVERABLE_COOLDOWN_MS)).toBe(false);
  });

  it('defaults to Date.now and an in-memory store', async () => {
    const health = new ProviderHealth();
    const row = await health.record({ provider: 'x', ok: false, message: 'timeout' });
    expect(Math.abs(row.observedAt - Date.now())).toBeLessThan(1_000);
    expect(health.store).toBeInstanceOf(InMemoryHealthStore);
  });
});

describe('InMemoryHealthStore', () => {
  it('returns copies so callers cannot mutate stored rows', async () => {
    const store = new InMemoryHealthStore();
    await store.put({ provider: 'p', status: 'ok', reason: null, recoverable: true, failures: 0, observedAt: 1 });
    const row = await store.get('p');
    row!.failures = 99;
    (await store.all())[0]!.failures = 42;
    expect((await store.get('p'))?.failures).toBe(0);
  });
});

describe('faultText', () => {
  it('handles empty and string errors', () => {
    expect(faultText(null)).toBe('');
    expect(faultText(undefined)).toBe('');
    expect(faultText('plain')).toBe('plain');
  });

  it('reads message, response body, data, status and cause', () => {
    const error = {
      message: 'Not Found',
      responseBody: '{"error":"insufficient balance"}',
      data: { code: 1113 },
      statusCode: 429,
      cause: new Error('socket hang up'),
    };
    expect(faultText(error)).toBe('Not Found | {"error":"insufficient balance"} | {"code":1113} | status 429 | socket hang up');
  });

  it('the body changes the verdict: a generic message with a balance body is terminal', () => {
    const text = faultText({ message: 'Not Found', responseBody: 'insufficient balance or no resource package' });
    expect(isTerminalFault(text)).toBe(true);
    expect(describeFault(text)).toBe('out of credit');
  });

  it('skips data that will not serialise', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(faultText({ message: 'boom', data: circular })).toBe('boom');
  });

  it('does not recurse into a self-referencing cause', () => {
    const error: { message: string; cause?: unknown } = { message: 'loop' };
    error.cause = error;
    expect(faultText(error)).toBe('loop');
  });

  it('ignores non-string message/body and non-number status', () => {
    expect(faultText({ message: 1, responseBody: {}, statusCode: '500' })).toBe('');
  });
});

describe('fault classification', () => {
  it.each([
    'insufficient balance',
    'please recharge',
    'credit exhausted',
    'Billing hard limit',
    'quota exceeded',
    'API key expired',
    'Invalid API key',
    'invalid_api_key',
    '401 Unauthorized',
    'Forbidden',
  ])('terminal: %s', (message) => {
    expect(isTerminalFault(message)).toBe(true);
  });

  it.each(['rate limit', 'timeout', 'Not Found', 'internal server error'])('not terminal: %s', (message) => {
    expect(isTerminalFault(message)).toBe(false);
  });

  it.each([
    ['insufficient balance', 'out of credit'],
    ['quota exceeded', 'quota exhausted'],
    ['invalid api key', 'key was rejected'],
    ['Rate limit reached', 'rate limited'],
    ['status 429', 'rate limited'],
    ['404 page', 'model or endpoint not found'],
    ['operation timed out', 'not responding'],
    ['weird', 'unavailable'],
  ])('describeFault(%s) → %s', (message, description) => {
    expect(describeFault(message)).toBe(description);
  });
});
