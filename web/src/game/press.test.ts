import { describe, expect, it } from 'vitest';
import serviceDone from '../../../api/tests/fixtures/chip-press-done.json';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import type { LiveClock, LiveFetch } from './live';
import {
  PRESS_DIAL,
  PRESS_JOB_KEY,
  createChipPress,
  pollDelay,
  withPressedRun,
  type PressState,
  type PressStorage,
} from './press';
import {
  createPrerunSource,
  parseChshExport,
  parseLiveChipChsh,
  parseWiesnerExport,
  provenanceLabel,
} from './results';

const URL = 'https://api.example';
const JOB = 'd0fakejob0000000000a';
const chsh = parseChshExport(chshJson);
const wiesner = parseWiesnerExport(wiesnerJson);
const exports = { chsh, wiesner };
const base = createPrerunSource(exports, 'ibm-noise-model');
const chipRun = chsh.runs.find((r) => r.id === 'ibm-chip')!;
const chipPoint = chipRun.points.find((p) => p.dial === PRESS_DIAL)!;

/** Shaped like the service's done result. The counts are the exported chip run's, relabelled with a fake job. */
const doneResult = {
  experiment: 'chsh',
  runId: 'ibm-chip',
  outcomeOrder: 'ba',
  dial: PRESS_DIAL,
  seed: 20261107,
  winRate: chipPoint.winRate,
  pairs: chipPoint.pairs,
  provenance: { ...chipRun.provenance, jobId: JOB },
};

function fakeClock(): LiveClock & { advance(ms: number): Promise<void>; pending(): number[] } {
  let time = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 0;
  return {
    now: () => time,
    schedule(fn, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: time + ms, fn });
      return () => {
        timers.delete(id);
      };
    },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.fn();
        }
      }
      await flush();
    },
    pending: () => [...timers.values()].map((t) => t.at - time),
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function reply(status: number, body: unknown) {
  return { status, json: () => Promise.resolve(body) };
}

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(answers: ((call: Call) => ReturnType<typeof reply> | Promise<never>)[]) {
  const calls: Call[] = [];
  const fetch: LiveFetch = (url, init) => {
    const call = { url, init };
    calls.push(call);
    const answer = answers.shift();
    if (!answer) return Promise.reject(new Error('no answer queued'));
    return Promise.resolve(answer(call));
  };
  return { fetch, calls };
}

function memoryStorage(initial: Record<string, string> = {}): PressStorage & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: (key) => {
      delete data[key];
    },
  };
}

const queued = () => reply(200, { status: 'queued', jobId: JOB, backend: 'ibm_kingston' });
const status = (s: string) => () => reply(200, { status: s, jobId: JOB });
const done = () => reply(200, { status: 'done', jobId: JOB, result: doneResult });

function setup(answers: Parameters<typeof fakeFetch>[0], storage = memoryStorage()) {
  const clock = fakeClock();
  const { fetch, calls } = fakeFetch(answers);
  const press = createChipPress({ url: URL, fetch, clock, storage });
  const seen: PressState[] = [];
  press.subscribe((s) => seen.push(s));
  return { clock, calls, press, storage, seen };
}

describe('parseLiveChipChsh', () => {
  it("reads the service's own done answer", () => {
    // Written by api/tests/test_chip.py from the service's code, so both sides meet on one shape.
    const live = parseLiveChipChsh(serviceDone.result, PRESS_DIAL);
    expect(live.provenance).toMatchObject({ source: 'ibm-chip', jobId: serviceDone.jobId, qubits: [61, 62] });
  });

  it('reads a done result with its chip label', () => {
    const live = parseLiveChipChsh(doneResult, PRESS_DIAL);
    expect(live.provenance).toMatchObject({ source: 'ibm-chip', backend: 'ibm_kingston', jobId: JOB });
    expect(live.winRate).toBe(chipPoint.winRate);
  });

  it.each([
    ['a simulator source', { source: 'live-simulator', jobId: null, backend: 'aer_simulator' }],
    ['a non-chip backend', { backend: 'fake_kingston' }],
    ['no job id', { jobId: '' }],
    ['a noise model', { noiseModel: { name: 'x', calibrated: 'y', qubitSelection: 'z' } }],
    ['shots off the pairs', { shots: 1 }],
    ['no qubit pick', { qubitSelection: undefined }],
  ])('refuses %s', (_, change) => {
    const provenance = { ...doneResult.provenance, ...change };
    expect(() => parseLiveChipChsh({ ...doneResult, provenance }, PRESS_DIAL)).toThrow();
  });

  it('refuses another dial', () => {
    expect(() => parseLiveChipChsh({ ...doneResult, dial: 0.25 }, PRESS_DIAL)).toThrow();
  });
});

describe('pollDelay', () => {
  it('starts at 5 s and grows to 30 s', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6, 20].map(pollDelay);
    expect(delays[0]).toBe(5_000);
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(delays.at(-1)).toBe(30_000);
    expect(Math.max(...delays)).toBe(30_000);
  });
});

describe('a press', () => {
  it('posts the passphrase once, and stores only the job id', async () => {
    const { press, calls, storage } = setup([queued]);
    await press.press('hunter2');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${URL}/v1/chip/run`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ passphrase: 'hunter2' });
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(storage.data).toEqual({ [PRESS_JOB_KEY]: JOB });
    expect(JSON.stringify(storage.data)).not.toContain('hunter2');
    expect(press.state).toEqual({ kind: 'queued', jobId: JOB, backend: 'ibm_kingston' });
  });

  it('never puts the passphrase in a URL', async () => {
    const { press, calls, clock } = setup([queued, status('queued')]);
    await press.press('hunter2');
    await clock.advance(5_000);
    expect(calls.map((c) => c.url).join(' ')).not.toContain('hunter2');
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it('shows a refusal in plain words and stores nothing', async () => {
    const { press, storage, clock } = setup([() => reply(409, { detail: 'A chip run is already in flight.' })]);
    await press.press('hunter2');
    expect(press.state).toEqual({ kind: 'refused', message: 'A chip run is already in flight.' });
    expect(storage.data).toEqual({});
    expect(clock.pending()).toEqual([]);
  });

  it.each([
    ['cannot be reached', () => Promise.reject(new Error('offline'))],
    ['times out at the gateway', () => reply(504, null)],
    ['fails', () => reply(502, { detail: 'IBM did not answer.' })],
  ])('says the run may have been sent when the service %s', async (_, answer) => {
    const { press, storage } = setup([answer]);
    await press.press('hunter2');
    expect(press.state.kind).toBe('refused');
    expect(press.state.kind === 'refused' && press.state.message).toMatch(/may have been sent/);
    expect(storage.data).toEqual({});
  });

  it('gives up on a press after the service timeout', async () => {
    const { press, clock } = setup([() => new Promise<never>(() => undefined)]);
    const pressing = press.press('hunter2');
    await clock.advance(60_000);
    await pressing;
    expect(press.state.kind).toBe('refused');
  });

  it('follows our own job when a press finds it in flight', async () => {
    const inFlight = () => reply(409, { detail: 'A chip run is already in flight.', jobId: JOB });
    const { press, storage, clock, calls } = setup([inFlight, done]);
    await press.press('hunter2');
    expect(press.state).toEqual({ kind: 'queued', jobId: JOB, backend: null });
    expect(storage.data).toEqual({ [PRESS_JOB_KEY]: JOB });
    await clock.advance(0);
    expect(calls[1]!.url).toBe(`${URL}/v1/chip/run/${JOB}`);
    expect(press.state.kind).toBe('done');
  });

  it('keeps playing the last result through a refused press, and drops it once a new job is accepted', async () => {
    const refusal = () => reply(429, { detail: "Today's chip presses are used up." });
    const { press, clock } = setup([queued, done, refusal, queued]);
    await press.press('hunter2');
    await clock.advance(5_000);
    const first = press.result();
    expect(first).not.toBeNull();
    await press.press('hunter2');
    expect(press.state.kind).toBe('refused');
    expect(press.result()).toBe(first);
    await press.press('hunter2');
    expect(press.state.kind).toBe('queued');
    expect(press.result()).toBeNull();
  });

  it('ignores a second press while one is out', async () => {
    const { press, calls } = setup([queued]);
    await press.press('hunter2');
    await press.press('hunter2');
    expect(calls).toHaveLength(1);
  });

  it('refuses an answer that is not a job id', async () => {
    const { press, storage } = setup([() => reply(200, { status: 'queued', jobId: '../x' })]);
    await press.press('hunter2');
    expect(press.state.kind).toBe('refused');
    expect(storage.data).toEqual({});
  });
});

describe('polling', () => {
  it('backs off from 5 s to 30 s while the job waits', async () => {
    const waits = Array.from({ length: 12 }, () => status('queued'));
    const { press, clock, calls } = setup([queued, ...waits]);
    await press.press('hunter2');
    const gaps: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const [gap] = clock.pending();
      gaps.push(gap!);
      await clock.advance(gap!);
    }
    expect(gaps[0]).toBe(5_000);
    expect(gaps.at(-1)).toBe(30_000);
    expect(calls.slice(1).every((c) => c.url === `${URL}/v1/chip/run/${JOB}` && c.init.method === 'GET')).toBe(true);
  });

  it('moves through queued, running and done', async () => {
    const { press, clock, seen, storage } = setup([queued, status('running'), done]);
    await press.press('hunter2');
    await clock.advance(5_000);
    expect(press.state).toEqual({ kind: 'running', jobId: JOB, backend: 'ibm_kingston' });
    await clock.advance(pollDelay(1));
    expect(press.state.kind).toBe('done');
    expect(seen.map((s) => s.kind)).toEqual(['sending', 'queued', 'running', 'done']);
    expect(clock.pending()).toEqual([]);
    // Kept, so a reload plays the same result again.
    expect(storage.data[PRESS_JOB_KEY]).toBe(JOB);
  });

  it.each(['error', 'cancelled'])('ends on %s, with no numbers, and clears the job', async (end) => {
    const { press, clock, storage } = setup([queued, status(end)]);
    await press.press('hunter2');
    await clock.advance(5_000);
    expect(press.state).toEqual({ kind: 'ended', jobId: JOB, outcome: end });
    expect(storage.data).toEqual({});
    expect(clock.pending()).toEqual([]);
    expect(press.result()).toBeNull();
  });

  it('ends and clears the job when the service no longer knows it', async () => {
    const { press, clock, storage } = setup([queued, () => reply(404, { detail: 'No such chip run.' })]);
    await press.press('hunter2');
    await clock.advance(5_000);
    expect(press.state).toEqual({ kind: 'ended', jobId: JOB, outcome: 'gone' });
    expect(storage.data).toEqual({});
  });

  it('keeps polling through network trouble and busy answers', async () => {
    const { press, clock, storage } = setup([
      queued,
      () => Promise.reject(new Error('offline')),
      () => reply(502, { detail: 'IBM did not answer.' }),
      () => reply(429, { detail: 'Too many requests.' }),
      done,
    ]);
    await press.press('hunter2');
    for (let i = 0; i < 4; i += 1) await clock.advance(clock.pending()[0]!);
    expect(press.state.kind).toBe('done');
    expect(storage.data[PRESS_JOB_KEY]).toBe(JOB);
  });

  it('ends on a done result that does not check out', async () => {
    const bad = { ...doneResult, provenance: { ...doneResult.provenance, source: 'live-simulator' } };
    const { press, clock, storage } = setup([queued, () => reply(200, { status: 'done', jobId: JOB, result: bad })]);
    await press.press('hunter2');
    await clock.advance(5_000);
    expect(press.state).toEqual({ kind: 'ended', jobId: JOB, outcome: 'error' });
    expect(press.result()).toBeNull();
    expect(storage.data).toEqual({});
  });

  it('gives up waiting on a hung poll and tries again', async () => {
    const { press, clock, calls } = setup([queued, () => new Promise<never>(() => undefined), done]);
    await press.press('hunter2');
    await clock.advance(5_000);
    expect(press.state.kind).toBe('queued');
    for (let i = 0; i < 3 && press.state.kind !== 'done'; i += 1) await clock.advance(clock.pending()[0]!);
    expect(press.state.kind).toBe('done');
    expect(calls).toHaveLength(3);
  });

  it('stops on dispose', async () => {
    const { press, clock, calls } = setup([queued, status('queued')]);
    await press.press('hunter2');
    press.dispose();
    await clock.advance(60_000);
    expect(calls).toHaveLength(1);
    expect(clock.pending()).toEqual([]);
  });
});

describe('resuming after a reload', () => {
  it('polls a stored job at once', async () => {
    const storage = memoryStorage({ [PRESS_JOB_KEY]: JOB });
    const { press, calls, clock } = setup([status('running')], storage);
    expect(press.state).toEqual({ kind: 'queued', jobId: JOB, backend: null });
    press.resume();
    await clock.advance(0);
    expect(calls[0]!.url).toBe(`${URL}/v1/chip/run/${JOB}`);
    expect(press.state).toEqual({ kind: 'running', jobId: JOB, backend: null });
  });

  it('plays a stored done job again', async () => {
    const storage = memoryStorage({ [PRESS_JOB_KEY]: JOB });
    const { press, clock } = setup([done], storage);
    press.resume();
    await clock.advance(0);
    expect(press.result()?.provenance.jobId).toBe(JOB);
  });

  it.each(['', '../../etc', 'UPPER0000000000000000', 'x'.repeat(80)])('drops a stored id like %j', (id) => {
    const storage = memoryStorage({ [PRESS_JOB_KEY]: id });
    const { press, clock } = setup([], storage);
    press.resume();
    expect(press.state).toEqual({ kind: 'idle' });
    expect(storage.data).toEqual({});
    expect(clock.pending()).toEqual([]);
  });

  it('works with no storage at all', async () => {
    const clock = fakeClock();
    const { fetch } = fakeFetch([queued]);
    const press = createChipPress({ url: URL, fetch, clock, storage: null });
    press.resume();
    await press.press('hunter2');
    expect(press.state.kind).toBe('queued');
  });

  it('survives storage that throws', async () => {
    const throwing: PressStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const { press } = setup([queued], throwing as ReturnType<typeof memoryStorage>);
    press.resume();
    await press.press('hunter2');
    expect(press.state.kind).toBe('queued');
  });

  it('does nothing with no service url', async () => {
    const clock = fakeClock();
    const { fetch, calls } = fakeFetch([]);
    const press = createChipPress({ url: undefined, fetch, clock, storage: memoryStorage({ [PRESS_JOB_KEY]: JOB }) });
    press.resume();
    await press.press('hunter2');
    expect(calls).toEqual([]);
    expect(press.available).toBe(false);
  });
});

describe('withPressedRun', () => {
  it('is the base source until a press is done', async () => {
    const source = withPressedRun(base, exports, () => null);
    expect(await source.chsh(PRESS_DIAL)).toEqual(await base.chsh(PRESS_DIAL));
    expect(source.previewProvenance(PRESS_DIAL)).toEqual(base.previewProvenance(PRESS_DIAL));
  });

  it('plays the pressed result at its dial, with its own label and the logical circuits', async () => {
    const live = parseLiveChipChsh(doneResult, PRESS_DIAL);
    const source = withPressedRun(base, exports, () => live);
    const result = await source.chsh(0.49);
    expect(result.dial).toBe(PRESS_DIAL);
    expect(result.pairs).toEqual(chipPoint.pairs);
    expect(result.provenance).toEqual(live.provenance);
    expect(provenanceLabel(result.provenance)).toBe(`IBM chip ibm_kingston, job ${JOB}`);
    expect(result.circuits).toEqual(chsh.logicalCircuits.find((c) => c.dial === PRESS_DIAL)!.pairs);
    expect(source.previewWinRate(PRESS_DIAL)).toBe(live.winRate);
    expect(source.previewProvenance(PRESS_DIAL)).toEqual(live.provenance);
  });

  it('leaves every other dial and the Cage with the base source', async () => {
    const live = parseLiveChipChsh(doneResult, PRESS_DIAL);
    const source = withPressedRun(base, exports, () => live);
    expect(await source.chsh(0.25)).toEqual(await base.chsh(0.25));
    expect(source.previewWinRate(0.25)).toBe(base.previewWinRate(0.25));
    expect(await source.wiesner(2)).toEqual(await base.wiesner(2));
  });
});
