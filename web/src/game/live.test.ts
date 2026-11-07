import { describe, expect, it, vi } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import { sourceLine } from '../ui/table';
import { createLiveSource, type LiveClock, type LiveFetch, type LiveOptions } from './live';
import {
  createPrerunSource,
  parseChshExport,
  parseWiesnerExport,
  type ChshPoint,
  type ResultSource,
} from './results';
import { writeSave } from './save';
import { createGameStore, type GameStore } from './store';

const URL = 'https://api.example';
const chsh = parseChshExport(chshJson);
const wiesner = parseWiesnerExport(wiesnerJson);
const base = createPrerunSource({ chsh, wiesner }, 'ibm-noise-model');
const run = chsh.runs[1]!;
const pointAt = (dial: number): ChshPoint => run.points.find((p) => p.dial === dial)!;

function chshBody(dial: number): Record<string, unknown> {
  const point = pointAt(dial);
  return {
    experiment: 'chsh',
    runId: 'live-7',
    dial,
    seed: 7,
    outcomeOrder: 'ba',
    winRate: 0.8125,
    pairs: point.pairs,
    provenance: { ...run.provenance, source: 'live-simulator' },
  };
}

function wiesnerBody(length: number): Record<string, unknown> {
  return {
    experiment: 'wiesner',
    runId: 'live-8',
    length,
    seed: 8,
    shots: 512,
    passes: 300,
    passRate: 300 / 512,
    qubits: [50, 148, 21].slice(0, length),
    provenance: { ...run.provenance, source: 'live-simulator', shots: 512 },
  };
}

function fakeClock(): LiveClock & { advance(ms: number): void; pending(): number[] } {
  let now = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 0;
  return {
    schedule(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => [...timers.values()].map((t) => t.at - now),
  };
}

function reply(status: number, body: unknown = { status: 'ok' }) {
  return { status, json: () => Promise.resolve(body) };
}

type Call = { url: string; init: RequestInit };

/** Answers pings with 200 and runs from `answer`, recording every call. */
function fakeFetch(answer: (url: string, init: RequestInit) => ReturnType<LiveFetch>) {
  const calls: Call[] = [];
  const fn: LiveFetch = (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/healthz') ? Promise.resolve(reply(200)) : answer(url, init);
  };
  return { fn, calls, runs: () => calls.filter((c) => !c.url.endsWith('/healthz')) };
}

const happy = (url: string, init: RequestInit): ReturnType<LiveFetch> => {
  const body = JSON.parse(init.body as string) as { dial: number; length: number };
  return Promise.resolve(reply(200, url.endsWith('/v1/chsh') ? chshBody(body.dial) : wiesnerBody(body.length)));
};

function setup(answer: Parameters<typeof fakeFetch>[0] = happy, options: Partial<LiveOptions> = {}) {
  const clock = fakeClock();
  const net = fakeFetch(answer);
  const source = createLiveSource(base, { url: URL, fetch: net.fn, clock, ...options });
  return { clock, net, source };
}

async function awake(answer?: Parameters<typeof fakeFetch>[0]) {
  const context = setup(answer);
  await context.source.warm();
  return context;
}

/** Lets settled promises run their continuations. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const never = (): ReturnType<LiveFetch> => new Promise(() => undefined);

describe('createLiveSource without a url', () => {
  it.each([undefined, ''])('behaves like the base source for url %j', async (url) => {
    const clock = fakeClock();
    const fetchFn = vi.fn<LiveFetch>();
    const source = createLiveSource(base, { url, fetch: fetchFn, clock });
    await source.warm();
    expect(await source.chsh(0.5)).toEqual(await base.chsh(0.5));
    expect(await source.wiesner(3)).toEqual(await base.wiesner(3));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(clock.pending()).toEqual([]);
  });
});

describe('createLiveSource delegation', () => {
  it('leaves the preview and the grid with the base source', () => {
    const { source } = setup();
    expect(source.dials).toBe(base.dials);
    expect(source.limits).toBe(base.limits);
    expect(source.previewProvenance).toBe(base.previewProvenance);
    expect(source.snapDial(0.51)).toBe(base.snapDial(0.51));
    expect(source.previewWinRate(0.25)).toBe(base.previewWinRate(0.25));
  });

  it('passes on a base failure rather than calling the service', async () => {
    const { source, net } = await awake();
    await expect(source.wiesner(99)).rejects.toThrow();
    expect(net.runs()).toEqual([]);
  });
});

describe('before the service has answered a ping', () => {
  it('goes straight to the base source', async () => {
    const { source, net } = setup();
    expect(await source.chsh(0.5)).toEqual(await base.chsh(0.5));
    expect(await source.wiesner(2)).toEqual(await base.wiesner(2));
    expect(net.calls).toEqual([]);
  });

  it('does not wait on a ping still in flight', async () => {
    const clock = fakeClock();
    const source = createLiveSource(base, { url: URL, fetch: never, clock });
    void source.warm();
    expect((await source.chsh(0.5)).provenance.source).toBe('pre-run-simulator');
  });
});

describe('warm', () => {
  it('pings healthz once, however often it is called', async () => {
    const { source, net } = setup();
    await Promise.all([source.warm(), source.warm()]);
    await source.warm();
    expect(net.calls.map((c) => c.url)).toEqual([`${URL}/healthz`]);
  });

  it('tolerates a trailing slash on the url', async () => {
    const { source, net } = setup(happy, { url: `${URL}/` });
    await source.warm();
    expect(net.calls[0]?.url).toBe(`${URL}/healthz`);
  });

  it('gives a cold start far longer than a run', () => {
    const clock = fakeClock();
    const signals: AbortSignal[] = [];
    const fetchFn: LiveFetch = (_, init) => {
      signals.push(init.signal!);
      return never();
    };
    const source = createLiveSource(base, { url: URL, fetch: fetchFn, clock });
    void source.warm();
    clock.advance(20_000);
    expect(signals[0]?.aborted).toBe(false);
    clock.advance(30_000);
    expect(signals[0]?.aborted).toBe(true);
  });

  it.each([
    ['a network error', () => Promise.reject(new Error('down'))],
    ['a 503', () => Promise.resolve(reply(503))],
    ['the wrong answer', () => Promise.resolve(reply(200, { status: 'nope' }))],
    ['a body that will not parse', () => Promise.resolve({ status: 200, json: () => Promise.reject(new Error('bad')) })],
  ])('retries with growing waits after %s, and stays on base', async (_, answer) => {
    const clock = fakeClock();
    const calls: string[] = [];
    let healthy = false;
    const fetchFn: LiveFetch = (url) => {
      calls.push(url);
      return healthy ? Promise.resolve(reply(200)) : answer();
    };
    const source = createLiveSource(base, { url: URL, fetch: fetchFn, clock });
    await source.warm();
    expect(clock.pending()).toEqual([5_000]);
    expect((await source.chsh(0.5)).provenance.source).toBe('pre-run-simulator');
    clock.advance(5_000);
    await flush();
    expect(clock.pending()).toEqual([10_000]);
    clock.advance(10_000);
    await flush();
    expect(clock.pending()).toEqual([20_000]);
    healthy = true;
    clock.advance(20_000);
    await flush();
    expect(clock.pending()).toEqual([]);
    expect(calls).toHaveLength(4);
  });

  it('never waits longer than the cap between pings', async () => {
    const clock = fakeClock();
    const fetchFn: LiveFetch = () => Promise.reject(new Error('down'));
    const source = createLiveSource(base, { url: URL, fetch: fetchFn, clock });
    await source.warm();
    for (let i = 0; i < 12; i += 1) {
      clock.advance(10_000_000);
      await flush();
    }
    expect(clock.pending()).toEqual([300_000]);
  });
});

describe('a live run', () => {
  it('carries the live numbers and label on the exported circuits', async () => {
    const { source, net } = await awake();
    const result = await source.chsh(0.5);
    const prerun = await base.chsh(0.5);
    expect(result.provenance.source).toBe('live-simulator');
    expect(result.runId).toBe('live-7');
    expect(result.winRate).toBe(0.8125);
    expect(result.dial).toBe(0.5);
    expect(result.circuits).toEqual(prerun.circuits);
    expect(net.runs()[0]).toMatchObject({
      url: `${URL}/v1/chsh`,
      init: { method: 'POST', body: '{"dial":0.5}' },
    });
  });

  it('sends the snapped dial and stays on the grid', async () => {
    const { source, net } = await awake();
    const result = await source.chsh(0.51);
    expect(result.dial).toBe(base.snapDial(0.51));
    expect(source.dials).toContain(result.dial);
    expect(net.runs()[0]?.init.body).toBe(`{"dial":${result.dial}}`);
  });

  it('keeps the exported payout and circuit on a wiesner run', async () => {
    const { source, net } = await awake();
    const result = await source.wiesner(2);
    const prerun = await base.wiesner(2);
    expect(result).toMatchObject({ runId: 'live-8', shots: 512, passes: 300, qubits: [50, 148] });
    expect(result.provenance.source).toBe('live-simulator');
    expect(result.payout).toEqual(prerun.payout);
    expect(result.circuit).toEqual(prerun.circuit);
    expect(result.circuitNote).toBe(prerun.circuitNote);
    expect(net.runs()[0]).toMatchObject({ url: `${URL}/v1/wiesner`, init: { body: '{"length":2}' } });
  });

  it('leaves no timer behind', async () => {
    const { source, clock } = await awake();
    await source.chsh(0.5);
    expect(clock.pending()).toEqual([]);
  });
});

describe('a failed live run', () => {
  const expectFallback = async (answer: Parameters<typeof fakeFetch>[0]) => {
    const { source, clock, net } = await awake(answer);
    const result = await source.chsh(0.5);
    expect(result).toEqual(await base.chsh(0.5));
    expect(clock.pending()).toEqual([5_000]);
    // Marked asleep: the next run does not try.
    await source.wiesner(1);
    expect(net.runs()).toHaveLength(1);
  };

  it('falls back on a network error', () => expectFallback(() => Promise.reject(new TypeError('failed'))));

  it.each([500, 503, 429, 422, 201])('falls back on status %i', (status) =>
    expectFallback(() => Promise.resolve(reply(status, chshBody(0.5)))),
  );

  it('falls back on a body that will not parse', () =>
    expectFallback(() => Promise.resolve({ status: 200, json: () => Promise.reject(new SyntaxError('bad')) })));

  it.each([
    ['a different dial', { dial: 0.25 }],
    ['a pair missing', { pairs: pointAt(0.5).pairs.slice(1) }],
    ['counts off the shots', { pairs: [{ ...pointAt(0.5).pairs[0], shots: 1 }, ...pointAt(0.5).pairs.slice(1)] }],
    ['a pre-run label', { provenance: run.provenance }],
    ['a chip label', { provenance: { ...run.provenance, source: 'ibm-chip', noiseModel: null, backend: 'ibm_kingston', jobId: 'x' } }],
  ])('falls back on %s', (_, change) =>
    expectFallback(() => Promise.resolve(reply(200, { ...chshBody(0.5), ...change }))),
  );

  it('falls back when a wiesner run reports more passes than shots', async () => {
    const { source } = await awake(() => Promise.resolve(reply(200, { ...wiesnerBody(2), passes: 513 })));
    expect(await source.wiesner(2)).toEqual(await base.wiesner(2));
  });

  it('times out at about 1.5 s, aborts, and ignores a late response', async () => {
    let answer: (value: Awaited<ReturnType<LiveFetch>>) => void = () => undefined;
    const signals: AbortSignal[] = [];
    const { source, clock, net } = await awake((_, init) => {
      signals.push(init.signal!);
      return new Promise((resolve) => {
        answer = resolve;
      });
    });
    const pending = source.chsh(0.5);
    await flush();
    clock.advance(1_499);
    await flush();
    expect(signals[0]?.aborted).toBe(false);
    clock.advance(1);
    const result = await pending;
    expect(signals[0]?.aborted).toBe(true);
    expect(result).toEqual(await base.chsh(0.5));
    answer(reply(200, chshBody(0.5)));
    await flush();
    // The late answer changes nothing: still asleep, and the run's result stands.
    expect(result.provenance.source).toBe('pre-run-simulator');
    await source.wiesner(1);
    expect(net.runs()).toHaveLength(1);
  });

  it('times out a response that stalls while its body arrives', async () => {
    const { source, clock } = await awake(() =>
      Promise.resolve({ status: 200, json: () => new Promise(() => undefined) }),
    );
    const pending = source.chsh(0.5);
    await flush();
    clock.advance(1_500);
    expect((await pending).provenance.source).toBe('pre-run-simulator');
  });

  it('comes back after a successful re-warm', async () => {
    let up = false;
    const { source, clock } = await awake((url, init) =>
      up ? happy(url, init) : Promise.reject(new Error('down')),
    );
    expect((await source.chsh(0.5)).provenance.source).toBe('pre-run-simulator');
    up = true;
    clock.advance(5_000);
    await flush();
    expect((await source.chsh(0.5)).provenance.source).toBe('live-simulator');
  });

  it('backs off when pings pass but runs keep failing, until a run works', async () => {
    let up = false;
    const { source, clock } = await awake((url, init) =>
      up ? happy(url, init) : Promise.resolve(reply(500)),
    );
    await source.chsh(0.5);
    expect(clock.pending()).toEqual([5_000]);
    clock.advance(5_000);
    await flush();
    await source.chsh(0.5);
    expect(clock.pending()).toEqual([10_000]);
    clock.advance(10_000);
    await flush();
    up = true;
    await source.chsh(0.5);
    up = false;
    await source.chsh(0.5);
    expect(clock.pending()).toEqual([5_000]);
  });

  it('queues one re-warm when two runs fail together', async () => {
    const { source, clock } = await awake(() => Promise.reject(new Error('down')));
    await Promise.all([source.chsh(0.5), source.wiesner(1)]);
    expect(clock.pending()).toEqual([5_000]);
  });
});

describe('the source badge', () => {
  const LIVE_LABEL = 'Source: Live Qiskit simulator, fake_kingston noise model';
  const PRERUN_LABEL = 'Source: Pre-run Qiskit simulator, fake_kingston noise model';

  function tableAt(source: ResultSource): GameStore {
    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => {
        saved.set(key, value);
      },
    };
    writeSave(storage, { version: 1, bankroll: 1000, phase: 'entangled', dial: 0.5, stake: 100, cleared: [] });
    return createGameStore({ source, storage, handMs: 0 });
  }

  it('reads live after a live run, and the preview after a dial turn', async () => {
    const { source } = await awake();
    const store = tableAt(source);
    await store.run(1);
    expect(store.state.result?.provenance.source).toBe('live-simulator');
    expect(sourceLine(store.state, source.previewProvenance)).toBe(LIVE_LABEL);
    store.setDial(0.25);
    expect(sourceLine(store.state, source.previewProvenance)).toBe(PRERUN_LABEL);
    store.dispose();
  });

  it('reads pre-run after a fallback, with hands still dealt', async () => {
    const { source } = await awake(() => Promise.reject(new Error('down')));
    const store = tableAt(source);
    await store.run(1);
    expect(store.state.rounds).toBe(1);
    expect(sourceLine(store.state, source.previewProvenance)).toBe(PRERUN_LABEL);
    store.dispose();
  });

  it('reads pre-run with no service at all', async () => {
    const source = createLiveSource(base, { url: undefined });
    const store = tableAt(source);
    await store.run(1);
    expect(sourceLine(store.state, source.previewProvenance)).toBe(PRERUN_LABEL);
    store.dispose();
  });
});
