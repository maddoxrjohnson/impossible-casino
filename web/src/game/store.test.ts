import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import {
  COUNT_KEYS,
  createPrerunSource,
  parseChshExport,
  parseWiesnerExport,
  type ChshPair,
  type ChshResult,
  type Counts,
  type ResultSource,
  type WiesnerResult,
} from './results';
import {
  BEYOND_MIN_HANDS,
  BREAK_EVEN,
  CAGE_CLEAR_LENGTH,
  CLASSICAL_HANDS,
  HAND_MS,
  HISTORY_CAP,
  RUN_HANDS,
  START_BANKROLL,
  chshWin,
  dealDeck,
  type Rng,
} from './rules';
import { SAVE_KEY, readSave, writeSave, type SaveData } from './save';
import { createGameStore, type GameStore, type LastHand } from './store';

const exportsData = {
  chsh: parseChshExport(chshJson),
  wiesner: parseWiesnerExport(wiesnerJson),
};
const source = createPrerunSource(exportsData, 'ideal');
const TUNED = 0.5;
const MISTUNED = 0.125;

function seeded(seed: number): Rng {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> & { writes: number } {
  const map = new Map<string, string>();
  return {
    writes: 0,
    getItem: (key) => map.get(key) ?? null,
    setItem(key, value) {
      this.writes += 1;
      map.set(key, value);
    },
  };
}

const brokenStorage = {
  getItem(): string | null {
    throw new Error('denied');
  },
  setItem() {
    throw new Error('denied');
  },
};

/** A draw that lands inside a key of the wanted kind for this pair of the real counts. */
function drawFor(pair: ChshPair, win: boolean): number {
  let seen = 0;
  for (const key of COUNT_KEYS) {
    const count = pair.counts[key];
    const a = key[1] === '1' ? 1 : 0;
    const b = key[0] === '1' ? 1 : 0;
    if (count > 0 && chshWin(pair.x, pair.y, a, b) === win) {
      return (seen + count / 2) / pair.shots;
    }
    seen += count;
  }
  throw new Error('no such outcome');
}

/**
 * An rng that replays one seeded deck, then steers each hand to the wanted outcome
 * using the real counts. Past the planned hands it falls back to the seeded stream.
 */
async function steeredRng(
  dial: number,
  hands: number,
  wins: (hand: number) => boolean,
): Promise<Rng> {
  const result = await source.chsh(dial);
  const stream = seeded(99);
  const draws: number[] = [];
  const deck = dealDeck(hands, () => {
    const value = stream();
    draws.push(value);
    return value;
  });
  deck.forEach((q, hand) => {
    const pair = result.pairs.find((p) => p.x === q.x && p.y === q.y);
    if (!pair) throw new Error('no pair');
    draws.push(drawFor(pair, wins(hand)));
  });
  let next = 0;
  return () => draws[next++] ?? stream();
}

/** Every shot of every pair on one key, so a hand's answers show which result it read. */
function allOn(result: ChshResult, key: keyof Counts): ChshResult {
  const empty = { '00': 0, '01': 0, '10': 0, '11': 0 };
  return {
    ...result,
    pairs: result.pairs.map((p) => ({ ...p, counts: { ...empty, [key]: p.shots } })),
  };
}

/** A source whose chsh call waits until the test settles it. */
function heldSource(): {
  source: ResultSource;
  release: (result: ChshResult) => void;
  refuse: (error: Error) => void;
} {
  let release: (result: ChshResult) => void = () => undefined;
  let refuse: (error: Error) => void = () => undefined;
  return {
    source: {
      ...source,
      chsh: () =>
        new Promise((resolve, reject) => {
          release = resolve;
          refuse = reject;
        }),
    },
    release: (result) => {
      release(result);
    },
    refuse: (error) => {
      refuse(error);
    },
  };
}

function saved(over: Partial<SaveData> = {}): ReturnType<typeof memoryStorage> {
  const storage = memoryStorage();
  writeSave(storage, {
    version: 1,
    bankroll: 9700,
    phase: 'entangled',
    dial: TUNED,
    stake: 100,
    cleared: [],
    ...over,
  });
  storage.writes = 0;
  return storage;
}

function saveOf(storage: Pick<Storage, 'getItem' | 'setItem'>): SaveData | null {
  return readSave(storage);
}

async function hands(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(HAND_MS * n);
}

async function reachWall(store: GameStore): Promise<void> {
  store.deal();
  await hands(CLASSICAL_HANDS);
}

const stores: GameStore[] = [];
function make(options: Partial<Parameters<typeof createGameStore>[0]> = {}): GameStore {
  const store = createGameStore({ source, rng: seeded(7), storage: memoryStorage(), ...options });
  stores.push(store);
  return store;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

describe('fresh state', () => {
  it('starts in the intro, mistuned, at the classical limit', () => {
    const { state } = make();
    expect(state).toMatchObject({
      phase: 'intro',
      mode: 'classical',
      dial: MISTUNED,
      bankroll: START_BANKROLL,
      rounds: 0,
      wins: 0,
      winRate: 0,
      target: 0.75,
      last: null,
      history: [],
      autoplaying: false,
      stake: 100,
      cleared: [],
      broke: false,
      result: null,
    });
  });
});

describe('the whole flow', () => {
  it('goes deal, wall, entangle, dial, run, beyond', async () => {
    const storage = memoryStorage();
    const store = make({ storage });
    const { state } = store;

    store.deal();
    expect(state.phase).toBe('classical');
    expect(state.autoplaying).toBe(true);
    await hands(CLASSICAL_HANDS - 1);
    expect(state.phase).toBe('classical');
    await hands(1);
    expect(state).toMatchObject({
      phase: 'wall',
      mode: 'classical',
      autoplaying: false,
      rounds: 48,
      wins: 36,
      winRate: 0.75,
      bankroll: 9700,
      result: null,
    });

    store.entangle();
    expect(state).toMatchObject({ phase: 'entangled', mode: 'quantum', rounds: 0, wins: 0 });
    expect(state.history).toEqual([]);
    expect(state.target).toBe(source.previewWinRate(state.dial));

    store.setDial(TUNED);
    expect(state.target).toBe(source.previewWinRate(TUNED));

    const finished = store.run();
    expect(state.autoplaying).toBe(true);
    await hands(RUN_HANDS);
    await finished;
    expect(state.autoplaying).toBe(false);
    expect(state.rounds).toBe(RUN_HANDS);
    expect(state.phase).toBe('beyond');
    expect(state.cleared).toContain('tables');
    expect(saveOf(storage)).toMatchObject({ phase: 'beyond', cleared: ['tables'] });
  });

  it('plays only the classical answers before the wall', async () => {
    const store = make();
    const seen: LastHand[] = [];
    store.onRound((last) => seen.push(last));
    await reachWall(store);
    expect(seen).toHaveLength(CLASSICAL_HANDS);
    for (const hand of seen) expect([hand.a, hand.b]).toEqual([0, 0]);
    expect(seen.filter((h) => h.x === 1 && h.y === 1)).toHaveLength(12);
  });
});

describe('illegal transitions', () => {
  it('ignores entangle and run before the wall', async () => {
    const store = make();
    store.entangle();
    await store.run();
    expect(store.state.phase).toBe('intro');
    expect(store.state.autoplaying).toBe(false);
  });

  it('ignores a second deal', async () => {
    const store = make();
    store.deal();
    await hands(3);
    store.deal();
    expect(store.state.rounds).toBe(3);
    store.entangle();
    expect(store.state.phase).toBe('classical');
  });

  it('ignores the dial outside quantum mode', async () => {
    const store = make();
    store.setDial(TUNED);
    expect(store.state.dial).toBe(MISTUNED);
    await reachWall(store);
    store.setDial(TUNED);
    expect(store.state.dial).toBe(MISTUNED);
    expect(store.state.target).toBe(0.75);
  });

  it('ignores deal and entangle once past them', async () => {
    const store = make();
    await reachWall(store);
    store.deal();
    expect(store.state.phase).toBe('wall');
    store.entangle();
    store.entangle();
    store.deal();
    expect(store.state.phase).toBe('entangled');
  });

  it('runs no quantum hands from the wall', async () => {
    const store = make();
    await reachWall(store);
    await store.run();
    expect(store.state.autoplaying).toBe(false);
    expect(store.state.rounds).toBe(CLASSICAL_HANDS);
  });

  it('ignores a stake outside the table or over the bankroll', () => {
    const store = make({ storage: saved({ bankroll: 300 }) });
    store.setStake(150);
    expect(store.state.stake).toBe(100);
    store.setStake(500);
    expect(store.state.stake).toBe(100);
    store.setStake(200);
    expect(store.state.stake).toBe(200);
  });

  it('plays the classical stage at the classical stake whatever was chosen', async () => {
    const store = make({ storage: saved({ phase: 'intro', stake: 500, bankroll: 10000 }) });
    await reachWall(store);
    expect(store.state.bankroll).toBe(9700);
  });
});

describe('during a run', () => {
  it('locks the dial and stake, from the first moment', async () => {
    const store = make({ storage: saved() });
    const finished = store.run();
    store.setDial(0.25);
    store.setStake(500);
    await hands(5);
    store.setDial(0.25);
    store.setStake(500);
    expect(store.state.dial).toBe(TUNED);
    expect(store.state.stake).toBe(100);
    await hands(RUN_HANDS);
    await finished;
    store.setDial(0.25);
    store.setStake(500);
    expect(store.state.dial).toBe(0.25);
    expect(store.state.stake).toBe(500);
  });

  it('refuses a second run while one is going', async () => {
    const store = make({ storage: saved() });
    const finished = store.run();
    await store.run(2);
    await hands(RUN_HANDS);
    await finished;
    expect(store.state.rounds).toBe(RUN_HANDS);
  });

  it('resets the counters synchronously', async () => {
    const store = make({ storage: saved() });
    const first = store.run(3);
    await hands(3);
    await first;
    expect(store.state.rounds).toBe(3);
    const second = store.run(3);
    expect(store.state).toMatchObject({ rounds: 0, wins: 0, winRate: 0, history: [] });
    await hands(3);
    await second;
  });

  it('plays the chosen stake and only that', async () => {
    const store = make({ storage: saved() });
    store.setStake(500);
    const deltas = new Set<number>();
    store.onRound((last) => deltas.add(last.delta));
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect([...deltas].sort((a, b) => a - b)).toEqual([-500, 125]);
  });

  it('settles every hand by chshWin on the sampled answers', async () => {
    const store = make({ storage: saved({ dial: 0.3125 }) });
    let bankroll = store.state.bankroll;
    const seen: LastHand[] = [];
    store.onRound((last, state) => {
      seen.push(last);
      expect(last.win).toBe(chshWin(last.x, last.y, last.a, last.b));
      expect(last.delta).toBe(last.win ? 25 : -100);
      bankroll += last.delta;
      expect(state.bankroll).toBe(bankroll);
    });
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect(seen).toHaveLength(RUN_HANDS);
    expect(seen.filter((h) => h.x === 1 && h.y === 1)).toHaveLength(9);
    expect(store.state.history).toEqual(seen.map((h) => (h.win ? 1 : 0)));
    expect(store.state.wins).toBe(seen.filter((h) => h.win).length);
  });

  it('caps the history', async () => {
    const store = make({ storage: saved({ bankroll: 1000000 }) });
    const finished = store.run(HISTORY_CAP + 5);
    await hands(HISTORY_CAP + 5);
    await finished;
    expect(store.state.history).toHaveLength(HISTORY_CAP);
    expect(store.state.rounds).toBe(HISTORY_CAP + 5);
  });

  it('records the provenance on state.result', async () => {
    const noisy = createPrerunSource(exportsData, 'ibm-noise-model');
    const store = make({ source: noisy, storage: saved() });
    expect(store.state.result).toBeNull();
    const finished = store.run();
    await hands(1);
    expect(store.state.result).toEqual(await noisy.chsh(TUNED));
    await hands(RUN_HANDS);
    await finished;
    expect(store.state.result?.runId).toBe('ibm-noise-model');
    expect(store.state.result?.provenance.noiseModel?.name).toBe('fake_kingston');
  });

  it.each([0, 0.5, -3, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a run of %d hands with no state change',
    async (count) => {
      const store = make({ storage: saved() });
      const first = store.run(2);
      await hands(2);
      await first;
      const before = structuredClone(store.state);
      const change = vi.fn();
      store.subscribe(change);
      change.mockClear();
      await store.run(count);
      expect(store.state).toEqual(before);
      expect(change).not.toHaveBeenCalled();
    },
  );

  it('plays on when the bankroll exactly equals the stake', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, (hand) => hand !== 0);
    const store = make({ rng, storage: saved({ bankroll: 200, stake: 100 }) });
    const finished = store.run();
    await hands(1);
    expect(store.state).toMatchObject({ rounds: 1, bankroll: 100, stake: 100, autoplaying: true });
    await hands(RUN_HANDS - 1);
    await finished;
    expect(store.state.rounds).toBe(RUN_HANDS);
  });

  it('plays a second run at a new dial from that run only', async () => {
    const backends: Record<number, string> = { [TUNED]: 'aer_simulator', [0.25]: 'aer_second' };
    const stub: ResultSource = {
      ...source,
      chsh: async (dial) => {
        const result = await source.chsh(dial);
        return {
          ...allOn(result, dial === TUNED ? '00' : '11'),
          provenance: { ...result.provenance, backend: backends[dial] ?? 'unknown' },
        };
      },
    };
    const store = make({ source: stub, storage: saved() });
    const first = store.run();
    await hands(RUN_HANDS);
    await first;

    store.setDial(0.25);
    const seen: LastHand[] = [];
    store.onRound((last) => seen.push(last));
    const second = store.run();
    await hands(RUN_HANDS);
    await second;

    expect(store.state.result?.dial).toBe(0.25);
    expect(store.state.result?.provenance.backend).toBe('aer_second');
    expect(seen).toHaveLength(RUN_HANDS);
    for (const hand of seen) expect([hand.a, hand.b]).toEqual([1, 1]);
  });

  it('clears the last result at run start, so no badge outlives its run', async () => {
    const held = heldSource();
    const store = make({ source: held.source, storage: saved() });
    const running = store.run(1);
    held.release(await source.chsh(TUNED));
    await hands(1);
    await running;
    expect(store.state.result).not.toBeNull();

    const next = store.run(1);
    expect(store.state.result).toBeNull();
    await hands(0);
    expect(store.state.result).toBeNull();
    held.refuse(new Error('down'));
    await next;
    expect(store.state.result).toBeNull();
  });

  it('plays only when the result has all four pairs', async () => {
    const stub: ResultSource = {
      ...source,
      chsh: async (dial) => {
        const result = await source.chsh(dial);
        return { ...result, pairs: result.pairs.slice(0, 3) };
      },
    };
    const store = make({ source: stub, storage: saved() });
    const seen = vi.fn();
    store.onRound(seen);
    await store.run();
    await hands(RUN_HANDS);
    expect(seen).not.toHaveBeenCalled();
    expect(store.state).toMatchObject({ autoplaying: false, rounds: 0, result: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('plays only when the result is for the dial that was locked', async () => {
    const stub: ResultSource = { ...source, chsh: () => source.chsh(0.25) };
    const store = make({ source: stub, storage: saved() });
    const seen = vi.fn();
    store.onRound(seen);
    await store.run();
    await hands(RUN_HANDS);
    expect(seen).not.toHaveBeenCalled();
    expect(store.state).toMatchObject({ autoplaying: false, rounds: 0, result: null });
    store.setDial(0.25);
    expect(store.state.dial).toBe(0.25);
  });
});

describe('the shatter rule', () => {
  it('fires on the first qualifying hand from the minimum on', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => true);
    const store = make({ rng, storage: saved() });
    const phases: string[] = [];
    store.onRound((_last, state) => phases.push(state.phase));
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect(phases.indexOf('beyond')).toBe(BEYOND_MIN_HANDS - 1);
    expect(store.state.cleared).toEqual(['tables']);
  });

  it('does not fire at exactly break-even', async () => {
    const rng = await steeredRng(TUNED, 25, (hand) => hand % 5 !== 0);
    const store = make({ rng, storage: saved() });
    const finished = store.run(25);
    await hands(25);
    await finished;
    expect(store.state.winRate).toBe(BREAK_EVEN);
    expect(store.state.phase).toBe('entangled');
  });

  it.each([MISTUNED, 0.25, 0.75])('never fires at dial %d even on a lucky rng', async (dial) => {
    expect(source.previewWinRate(dial)).toBeLessThanOrEqual(BREAK_EVEN);
    const rng = await steeredRng(dial, RUN_HANDS, () => true);
    const store = make({ rng, storage: saved({ dial }) });
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect(store.state.winRate).toBe(1);
    expect(store.state.phase).toBe('entangled');
    expect(store.state.cleared).toEqual([]);
  });

  it('reads the target from the result being played, not the preview', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => true);
    const lower = BREAK_EVEN - 0.05;
    const stub: ResultSource = {
      ...source,
      chsh: async (dial) => ({ ...(await source.chsh(dial)), winRate: lower }),
    };
    const store = make({ source: stub, rng, storage: saved() });
    expect(store.state.target).toBe(source.previewWinRate(TUNED));
    const finished = store.run();
    await hands(1);
    expect(store.state.target).toBe(lower);
    await hands(RUN_HANDS - 1);
    await finished;
    expect(store.state.winRate).toBe(1);
    expect(store.state.phase).toBe('entangled');
  });

  it('goes back to the preview once the dial moves', async () => {
    const stub: ResultSource = {
      ...source,
      chsh: async (dial) => ({ ...(await source.chsh(dial)), winRate: 0.1 }),
    };
    const store = make({ source: stub, storage: saved() });
    const finished = store.run(1);
    await hands(1);
    await finished;
    store.setDial(0.25);
    expect(store.state.target).toBe(source.previewWinRate(0.25));
  });

  it('holds off when the rate is under break-even on a tuned dial', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => false);
    const store = make({ rng, storage: saved() });
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect(store.state.phase).toBe('entangled');
  });
});

describe('going broke', () => {
  it('stops a run early and flags broke', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => false);
    const store = make({ rng, storage: saved({ bankroll: 250, stake: 200 }) });
    store.setStake(200);
    const finished = store.run();
    await hands(1);
    await finished;
    expect(store.state).toMatchObject({
      rounds: 1,
      bankroll: 50,
      broke: true,
      autoplaying: false,
      stake: 100,
    });
    await hands(RUN_HANDS);
    expect(store.state.rounds).toBe(1);
  });

  it('stops early and lowers the stake to the largest affordable', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => false);
    const store = make({ rng, storage: saved({ bankroll: 1200, stake: 500 }) });
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect(store.state).toMatchObject({ rounds: 2, bankroll: 200, stake: 200, broke: false });
  });

  it('plays the last affordable hand down to exactly zero', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => false);
    const store = make({ rng, storage: saved({ bankroll: 100, stake: 100 }) });
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect(store.state).toMatchObject({ rounds: 1, bankroll: 0, broke: true });
  });

  it('keeps the stake at the run value until the run stops', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => false);
    const store = make({ rng, storage: saved({ bankroll: 1200, stake: 500 }) });
    const stakes: number[] = [];
    store.onRound((last) => stakes.push(last.delta));
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect(stakes).toEqual([-500, -500]);
  });

  it('never lets the bankroll go negative', async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      const store = make({ rng: seeded(seed), storage: saved({ bankroll: 730, dial: 0 }) });
      store.setStake(200);
      store.onRound((_last, state) => {
        expect(state.bankroll).toBeGreaterThanOrEqual(0);
      });
      for (let run = 0; run < 3; run += 1) {
        const finished = store.run();
        await hands(RUN_HANDS);
        await finished;
      }
    }
  });

  it('leaves only restart useful', async () => {
    const storage = saved({ bankroll: 75 });
    const store = make({ storage });
    expect(store.state.broke).toBe(true);
    await store.run();
    expect(store.state.autoplaying).toBe(false);
    store.setDial(0.25);
    store.setStake(100);
    store.clearRoom('cage');
    expect(store.state).toMatchObject({ dial: TUNED, cleared: [], bankroll: 75 });
    expect(storage.writes).toBe(0);
    store.restart();
    expect(store.state).toMatchObject({ phase: 'intro', bankroll: START_BANKROLL, broke: false });
  });

  it('stops the classical stage early and stays there', async () => {
    const storage = saved({ phase: 'intro', bankroll: 150 });
    const store = make({ storage });
    store.deal();
    await hands(CLASSICAL_HANDS);
    expect(storage.writes).toBe(0);
    expect(store.state.phase).toBe('classical');
    expect(store.state.autoplaying).toBe(false);
    expect(store.state.broke).toBe(true);
    expect(store.state.rounds).toBeLessThan(CLASSICAL_HANDS);
    expect(store.state.bankroll).toBeLessThan(100);
  });

  it('cannot deal or entangle while broke', () => {
    const intro = make({ storage: saved({ phase: 'intro', bankroll: 50 }) });
    intro.deal();
    expect(intro.state.phase).toBe('intro');
    const wall = make({ storage: saved({ phase: 'wall', bankroll: 50 }) });
    wall.entangle();
    expect(wall.state.phase).toBe('wall');
  });
});

describe('restart and dispose', () => {
  it('restart mid-run leaves no stray hands and resolves the run', async () => {
    const storage = saved({ stake: 200, cleared: ['cage'] });
    const store = make({ storage });
    const seen = vi.fn();
    store.onRound(seen);
    const finished = store.run();
    await hands(5);
    seen.mockClear();
    store.restart();
    await finished;
    await hands(RUN_HANDS);
    expect(seen).not.toHaveBeenCalled();
    expect(store.state).toMatchObject({
      phase: 'intro',
      mode: 'classical',
      dial: MISTUNED,
      bankroll: START_BANKROLL,
      stake: 100,
      cleared: [],
      last: null,
      result: null,
      history: [],
      target: 0.75,
      autoplaying: false,
    });
    expect(saveOf(storage)).toMatchObject({ phase: 'intro', bankroll: START_BANKROLL });
  });

  it('restart during the await ignores the result when it lands', async () => {
    const held = heldSource();
    const store = make({ source: held.source, storage: saved() });
    const seen = vi.fn();
    store.onRound(seen);
    const finished = store.run();
    store.restart();
    held.release(await source.chsh(TUNED));
    await finished;
    await hands(RUN_HANDS);
    expect(seen).not.toHaveBeenCalled();
    expect(store.state.result).toBeNull();
    expect(store.state.autoplaying).toBe(false);
  });

  it('dispose during the await leaves no stray hands or listeners', async () => {
    const held = heldSource();
    const storage = saved();
    const store = make({ source: held.source, storage });
    const round = vi.fn();
    const change = vi.fn();
    store.onRound(round);
    store.subscribe(change);
    change.mockClear();
    const finished = store.run();
    change.mockClear();
    store.dispose();
    held.release(await source.chsh(TUNED));
    await finished;
    await hands(RUN_HANDS);
    expect(round).not.toHaveBeenCalled();
    expect(change).not.toHaveBeenCalled();
    expect(store.state.result).toBeNull();
    expect(storage.writes).toBe(0);
  });

  it('dispose mid-run stops the hands and resolves the run', async () => {
    const store = make({ storage: saved() });
    const finished = store.run();
    await hands(5);
    store.dispose();
    await finished;
    const rounds = store.state.rounds;
    await hands(RUN_HANDS);
    expect(store.state.rounds).toBe(rounds);
  });

  it('does nothing after dispose', async () => {
    const storage = saved({ phase: 'intro', bankroll: 10000 });
    const store = make({ storage });
    store.dispose();
    const change = vi.fn();
    store.subscribe(change);
    store.deal();
    store.restart();
    store.clearRoom('cage');
    await store.run();
    await hands(CLASSICAL_HANDS);
    expect(change).not.toHaveBeenCalled();
    expect(store.state.phase).toBe('intro');
    expect(store.state.cleared).toEqual([]);
    expect(storage.writes).toBe(0);
  });

  it.each(['restart', 'dispose'] as const)(
    'plays no hands when a listener calls %s as the result lands',
    async (method) => {
      const store = make({ storage: saved() });
      const seen = vi.fn();
      store.onRound(seen);
      store.subscribe((state) => {
        if (state.result) store[method]();
      });
      await store.run();
      await hands(RUN_HANDS);
      expect(seen).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(store.state.autoplaying).toBe(false);
      expect(store.state.rounds).toBe(0);
    },
  );

  it('does not let a stale rejection touch the next game', async () => {
    const held = heldSource();
    const store = make({ source: held.source, storage: saved() });
    const stale = store.run();
    store.restart();
    store.deal();
    held.refuse(new Error('down'));
    await stale;
    expect(store.state).toMatchObject({ phase: 'classical', autoplaying: true });
    await hands(CLASSICAL_HANDS);
    expect(store.state).toMatchObject({ phase: 'wall', rounds: CLASSICAL_HANDS, bankroll: 9700 });
  });

  it('survives a listener restarting from inside a hand', async () => {
    const store = make({ storage: saved() });
    let fired = 0;
    store.onRound(() => {
      fired += 1;
      if (fired === 2) store.restart();
    });
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect(fired).toBe(2);
    expect(store.state.phase).toBe('intro');
  });
});

describe('a rejected source', () => {
  const failing: ResultSource = {
    ...source,
    chsh: () => Promise.reject(new Error('backend down')),
  };

  it('ends the run cleanly and unlocks the dial', async () => {
    const store = make({ source: failing, storage: saved() });
    await expect(store.run()).resolves.toBeUndefined();
    expect(store.state.autoplaying).toBe(false);
    expect(store.state.rounds).toBe(0);
    expect(store.state.result).toBeNull();
    store.setDial(0.25);
    expect(store.state.dial).toBe(0.25);
  });

  it('can be retried', async () => {
    let calls = 0;
    const flaky: ResultSource = {
      ...source,
      chsh: (dial) => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('down')) : source.chsh(dial);
      },
    };
    const store = make({ source: flaky, storage: saved() });
    await store.run();
    expect(store.state.rounds).toBe(0);
    const retry = store.run();
    await hands(RUN_HANDS);
    await retry;
    expect(calls).toBe(2);
    expect(store.state.rounds).toBe(RUN_HANDS);
    expect(store.state.result?.dial).toBe(TUNED);
  });

  it('copes with a source that throws synchronously', async () => {
    const throwing: ResultSource = {
      ...source,
      chsh: () => {
        throw new Error('backend down');
      },
    };
    const store = make({ source: throwing, storage: saved() });
    await expect(store.run()).resolves.toBeUndefined();
    expect(store.state.autoplaying).toBe(false);
  });
});

describe('rooms', () => {
  it('clears a room once and saves it', () => {
    const storage = saved();
    const store = make({ storage });
    store.clearRoom('cage');
    store.clearRoom('cage');
    expect(store.state.cleared).toEqual(['cage']);
    expect(storage.writes).toBe(1);
    expect(saveOf(storage)?.cleared).toEqual(['cage']);
  });

  it('ignores tables, which only reaching beyond can clear', async () => {
    const storage = saved();
    const store = make({ storage });
    const change = vi.fn();
    store.subscribe(change);
    change.mockClear();
    store.clearRoom('tables');
    expect(store.state.cleared).toEqual([]);
    expect(storage.writes).toBe(0);
    expect(change).not.toHaveBeenCalled();

    const rng = await steeredRng(TUNED, RUN_HANDS, () => true);
    const tuned = make({ rng, storage: saved() });
    const finished = tuned.run();
    await hands(RUN_HANDS);
    await finished;
    expect(tuned.state.cleared).toEqual(['tables']);
  });

  it('holds a mid-run clear for the end-of-run save', async () => {
    const storage = saved();
    const store = make({ storage });
    const finished = store.run();
    await hands(1);
    store.clearRoom('cage');
    expect(storage.writes).toBe(0);
    await hands(RUN_HANDS);
    await finished;
    expect(saveOf(storage)?.cleared).toContain('cage');
  });

  it('keeps a clear made while a run that then fails was waiting', async () => {
    const held = heldSource();
    const storage = saved();
    const store = make({ source: held.source, storage });
    const finished = store.run();
    store.clearRoom('cage');
    expect(storage.writes).toBe(0);
    held.refuse(new Error('down'));
    await finished;
    expect(saveOf(storage)?.cleared).toContain('cage');
  });

  it('shows no earlier hand while the next run waits for its source', async () => {
    const held = heldSource();
    let calls = 0;
    const store = make({
      source: {
        ...held.source,
        chsh: (dial) => {
          calls += 1;
          return calls === 1 ? source.chsh(dial) : held.source.chsh(dial);
        },
      },
      storage: saved(),
    });
    const opening = store.run(1);
    await hands(1);
    await opening;
    expect(store.state.last).not.toBeNull();
    const next = store.run();
    expect(store.state.last).toBeNull();
    held.refuse(new Error('down'));
    await next;
    expect(store.state.last).toBeNull();
  });

  describe('one bankroll across them', () => {
    const PAYS = exportsData.wiesner.payouts.stake;
    const forgePays = (length: number): number =>
      exportsData.wiesner.payouts.table.find((row) => row.length === length)?.pays ?? 0;

    it('keeps one bankroll from a Tables loss through a Cage win, and across a reload', async () => {
      const storage = memoryStorage();
      let draw: Rng = seeded(7);
      const store = make({ storage, rng: () => draw() });
      await reachWall(store);
      expect(store.state.bankroll).toBe(9700);
      draw = () => 0;
      await store.forge(2, PAYS);
      expect(store.state.bankroll).toBe(9700 + forgePays(2));
      store.entangle();
      expect(store.state.bankroll).toBe(9700 + forgePays(2));

      const reloaded = make({ storage });
      expect(reloaded.state).toMatchObject({ phase: 'entangled', bankroll: 9700 + forgePays(2) });
    });

    it('lets a forge at the intro set the stack the Tables deal from', async () => {
      const storage = memoryStorage();
      const store = make({ storage, rng: () => 0.999999 });
      await store.forge(1, PAYS);
      expect(store.state.bankroll).toBe(START_BANKROLL - 100);
      const reloaded = make({ storage });
      expect(reloaded.state).toMatchObject({ phase: 'intro', bankroll: START_BANKROLL - 100 });
      await reachWall(reloaded);
      expect(reloaded.state).toMatchObject({ phase: 'wall', bankroll: START_BANKROLL - 100 - 300 });
    });

    it('keeps both clears and the bankroll together in one save', async () => {
      const storage = saved({ phase: 'beyond', cleared: ['tables'] });
      const store = make({ storage, rng: () => 0 });
      await store.forge(CAGE_CLEAR_LENGTH, PAYS);
      const after = store.state.bankroll;
      expect(saveOf(storage)).toMatchObject({ bankroll: after, cleared: ['tables', 'cage'] });
      expect(make({ storage }).state.cleared).toEqual(['tables', 'cage']);
    });

    it('leaves restart as the only way on at the Tables once the Cage takes the last chips', async () => {
      const table = make({ storage: saved({ bankroll: 100, phase: 'entangled' }), rng: () => 0.999999 });
      await table.forge(1, PAYS);
      expect(table.state).toMatchObject({ bankroll: 0, broke: true });
      table.deal();
      table.entangle();
      void table.run();
      await table.forge(1, PAYS);
      expect(table.state).toMatchObject({ bankroll: 0, autoplaying: false, forging: false });
      table.restart();
      expect(table.state).toMatchObject({ bankroll: START_BANKROLL, broke: false, cleared: [] });
    });
  });
});

describe('the cage', () => {
  const PAYS = exportsData.wiesner.payouts.stake;
  const passing: Rng = () => 0;
  const caught: Rng = () => 0.999999;
  const pays = (length: number): number =>
    exportsData.wiesner.payouts.table.find((row) => row.length === length)?.pays ?? 0;

  /** A source whose wiesner call waits until the test settles it. */
  function heldForge(): {
    source: ResultSource;
    calls: () => number;
    release: (result: WiesnerResult) => void;
    refuse: (error: Error) => void;
  } {
    let release: (result: WiesnerResult) => void = () => undefined;
    let refuse: (error: Error) => void = () => undefined;
    let calls = 0;
    return {
      source: {
        ...source,
        wiesner: () => {
          calls += 1;
          return new Promise((resolve, reject) => {
            release = resolve;
            refuse = reject;
          });
        },
      },
      calls: () => calls,
      release: (result) => {
        release(result);
      },
      refuse: (error) => {
        refuse(error);
      },
    };
  }

  describe('a settled forge', () => {
    it('starts with nothing forged', () => {
      const store = make();
      expect(store.state.forge).toBeNull();
      expect(store.state.forging).toBe(false);
    });

    it('pays the exported win, scaled to the stake', async () => {
      const store = make({ rng: passing, storage: saved({ bankroll: 2000, stake: 200 }) });
      await store.forge(3, PAYS);
      expect(store.state.bankroll).toBe(2000 + pays(3) * 2);
      expect(store.state.forging).toBe(false);
      expect(store.state.forge).toMatchObject({ length: 3, stake: 200, passed: true, delta: pays(3) * 2 });
      expect(store.state.forge?.result).toEqual(await source.wiesner(3));
    });

    it('takes the stake on a catch', async () => {
      const store = make({ rng: caught, storage: saved({ bankroll: 2000, stake: 500 }) });
      await store.forge(2, PAYS);
      expect(store.state.bankroll).toBe(1500);
      expect(store.state.forge).toMatchObject({ length: 2, stake: 500, passed: false, delta: -500 });
    });

    it('reads the odds and the label from whatever the source returned', async () => {
      const real = await source.wiesner(8);
      const live: WiesnerResult = {
        ...real,
        shots: 1000,
        passes: 1000,
        provenance: { ...real.provenance, source: 'live-simulator' } as WiesnerResult['provenance'],
      };
      const store = make({
        source: { ...source, wiesner: () => Promise.resolve(live) },
        rng: () => 0.99,
        storage: saved(),
      });
      await store.forge(8, PAYS);
      expect(store.state.forge?.passed).toBe(true);
      expect(store.state.forge?.result.provenance.source).toBe('live-simulator');
    });

    it('leaves the table exactly as the player left it', async () => {
      const rng = await steeredRng(TUNED, 2, () => true);
      const store = make({ rng, storage: saved() });
      const finished = store.run(2);
      await hands(2);
      await finished;
      const { phase, mode, rounds, wins, winRate, target, last, dial, result } = store.state;
      const history = [...store.state.history];
      await store.forge(1, PAYS);
      expect(store.state.forge).not.toBeNull();
      expect(store.state).toMatchObject({ phase, mode, rounds, wins, winRate, target, last, dial });
      expect(store.state.result).toBe(result);
      expect(store.state.history).toEqual(history);
    });

    it('fires no round listeners', async () => {
      const store = make({ storage: saved() });
      const heard = vi.fn();
      store.onRound(heard);
      await store.forge(1, PAYS);
      expect(heard).not.toHaveBeenCalled();
    });

    it('works before the first deal and keeps the phase', async () => {
      const storage = memoryStorage();
      const store = make({ rng: passing, storage });
      await store.forge(1, PAYS);
      expect(store.state.phase).toBe('intro');
      expect(store.state.bankroll).toBe(START_BANKROLL + pays(1));
      expect(saveOf(storage)?.phase).toBe('intro');
    });

    it('trims the stake to what is left after a catch', async () => {
      const store = make({ rng: caught, storage: saved({ bankroll: 1200, stake: 1000 }) });
      await store.forge(1, PAYS);
      expect(store.state.bankroll).toBe(200);
      expect(store.state.stake).toBe(200);
      expect(store.state.broke).toBe(false);
    });

    it('goes broke on a catch that takes the last chips', async () => {
      const store = make({ rng: caught, storage: saved({ bankroll: 100, stake: 100 }) });
      await store.forge(1, PAYS);
      expect(store.state.bankroll).toBe(0);
      expect(store.state.broke).toBe(true);
      expect(store.state.stake).toBe(100);
    });

    it('emits when it starts and when it settles', async () => {
      const store = make({ storage: saved() });
      const seen: boolean[] = [];
      store.subscribe((s) => seen.push(s.forging));
      await store.forge(1, PAYS);
      expect(seen).toEqual([false, true, false]);
    });
  });

  describe('what it refuses', () => {
    it('a bad length, without asking the source', async () => {
      const held = heldForge();
      const store = make({ source: held.source, storage: saved() });
      for (const bad of [0, 9, 1.5, -2, Number.NaN]) await store.forge(bad, PAYS);
      expect(held.calls()).toBe(0);
      expect(store.state.forging).toBe(false);
    });

    it('a pay table with no stake behind it', async () => {
      const held = heldForge();
      const store = make({ source: held.source, storage: saved() });
      await store.forge(1, 0);
      await store.forge(1, Number.NaN);
      expect(held.calls()).toBe(0);
    });

    it('a second forge while one is in flight', async () => {
      const held = heldForge();
      const store = make({ source: held.source, rng: passing, storage: saved() });
      const first = store.forge(1, PAYS);
      await store.forge(2, PAYS);
      expect(held.calls()).toBe(1);
      held.release(await source.wiesner(1));
      await first;
      expect(store.state.forge?.length).toBe(1);
      expect(store.state.bankroll).toBe(9700 + pays(1));
    });

    it('a forge while the table is playing', async () => {
      const held = heldForge();
      const store = make({ source: held.source, storage: saved() });
      const finished = store.run();
      await store.forge(1, PAYS);
      expect(held.calls()).toBe(0);
      await hands(RUN_HANDS);
      await finished;
    });

    it('a forge once broke', async () => {
      const held = heldForge();
      const store = make({ source: held.source, storage: saved({ bankroll: 50, stake: 100 }) });
      expect(store.state.broke).toBe(true);
      await store.forge(1, PAYS);
      expect(held.calls()).toBe(0);
    });

    it('a forge after dispose', async () => {
      const held = heldForge();
      const store = make({ source: held.source, storage: saved() });
      store.dispose();
      await store.forge(1, PAYS);
      expect(held.calls()).toBe(0);
    });

    it('anything that would move the bankroll or the stake while one is in flight', async () => {
      const held = heldForge();
      const store = make({ source: held.source, rng: caught, storage: saved() });
      const forged = store.forge(1, PAYS);
      void store.run();
      store.setStake(500);
      expect(store.state.autoplaying).toBe(false);
      expect(store.state.stake).toBe(100);
      held.release(await source.wiesner(1));
      await forged;
      expect(store.state.bankroll).toBe(9600);
    });

    it('a deal or an entangle while one is in flight', async () => {
      const intro = heldForge();
      const fresh = make({ source: intro.source, storage: memoryStorage() });
      const a = fresh.forge(1, PAYS);
      fresh.deal();
      expect(fresh.state.phase).toBe('intro');
      intro.release(await source.wiesner(1));
      await a;

      const wall = heldForge();
      const waiting = make({ source: wall.source, storage: saved({ phase: 'wall' }) });
      const b = waiting.forge(1, PAYS);
      waiting.entangle();
      expect(waiting.state.phase).toBe('wall');
      wall.release(await source.wiesner(1));
      await b;
    });
  });

  describe('a failed forge', () => {
    it('costs nothing and frees the lock when the source rejects', async () => {
      const held = heldForge();
      const storage = saved();
      const store = make({ source: held.source, storage });
      const forged = store.forge(1, PAYS);
      expect(store.state.forging).toBe(true);
      held.refuse(new Error('down'));
      await forged;
      expect(store.state.forging).toBe(false);
      expect(store.state.forge).toBeNull();
      expect(store.state.bankroll).toBe(9700);
      expect(storage.writes).toBe(0);

      const retry = store.forge(1, PAYS);
      expect(held.calls()).toBe(2);
      held.release(await source.wiesner(1));
      await retry;
      expect(store.state.forge).not.toBeNull();
    });

    it('keeps the last forge on show', async () => {
      let calls = 0;
      const store = make({
        source: {
          ...source,
          wiesner: (length) => {
            calls += 1;
            return calls === 1 ? source.wiesner(length) : Promise.reject(new Error('down'));
          },
        },
        storage: saved(),
      });
      await store.forge(2, PAYS);
      const first = store.state.forge;
      await store.forge(3, PAYS);
      expect(store.state.forge).toBe(first);
    });

    it('rejects a result for another length or with no shots', async () => {
      const wrong = await source.wiesner(5);
      const empty = { ...(await source.wiesner(1)), shots: 0, passes: 0 };
      for (const bad of [wrong, empty]) {
        const store = make({
          source: { ...source, wiesner: () => Promise.resolve(bad) },
          storage: saved(),
        });
        await store.forge(1, PAYS);
        expect(store.state.forge).toBeNull();
        expect(store.state.bankroll).toBe(9700);
        expect(store.state.forging).toBe(false);
      }
    });
  });

  describe('clearing the room', () => {
    it('clears on a pass at the clearing length', async () => {
      const storage = saved();
      const store = make({ rng: passing, storage });
      await store.forge(CAGE_CLEAR_LENGTH, PAYS);
      expect(store.state.cleared).toEqual(['cage']);
      expect(saveOf(storage)?.cleared).toEqual(['cage']);
    });

    it('does not clear on a shorter pass or a catch', async () => {
      const short = make({ rng: passing, storage: saved() });
      await short.forge(CAGE_CLEAR_LENGTH - 1, PAYS);
      expect(short.state.cleared).toEqual([]);
      const lost = make({ rng: caught, storage: saved() });
      await lost.forge(8, PAYS);
      expect(lost.state.cleared).toEqual([]);
    });

    it('clears once', async () => {
      const store = make({ rng: passing, storage: saved() });
      await store.forge(CAGE_CLEAR_LENGTH, PAYS);
      await store.forge(8, PAYS);
      expect(store.state.cleared).toEqual(['cage']);
    });

    it('cannot lose a clearing win staked with the last chips', async () => {
      const storage = saved({ bankroll: 100, stake: 100 });
      const store = make({ rng: passing, storage });
      await store.forge(CAGE_CLEAR_LENGTH, PAYS);
      expect(store.state.broke).toBe(false);
      expect(store.state.cleared).toEqual(['cage']);
      expect(saveOf(storage)?.cleared).toEqual(['cage']);
    });

    it('stays cleared across a reload, and restart clears it', async () => {
      const storage = saved();
      const store = make({ rng: passing, storage });
      await store.forge(CAGE_CLEAR_LENGTH, PAYS);
      const reloaded = make({ storage });
      expect(reloaded.state.cleared).toEqual(['cage']);
      reloaded.restart();
      expect(reloaded.state.cleared).toEqual([]);
    });
  });

  describe('saving', () => {
    it('writes the bankroll once, at the settled point', async () => {
      const held = heldForge();
      const storage = saved();
      const store = make({ source: held.source, rng: passing, storage });
      const forged = store.forge(1, PAYS);
      expect(storage.writes).toBe(0);
      held.release(await source.wiesner(1));
      await forged;
      expect(storage.writes).toBe(1);
      expect(saveOf(storage)?.bankroll).toBe(9700 + pays(1));
    });

    it('never writes the forge, so a reload starts with no receipt', async () => {
      const storage = saved();
      const store = make({ rng: passing, storage });
      await store.forge(1, PAYS);
      expect(storage.getItem(SAVE_KEY)).not.toContain('forge');
      const reloaded = make({ storage });
      expect(reloaded.state.forge).toBeNull();
      expect(reloaded.state.bankroll).toBe(9700 + pays(1));
    });

    it('still loads a save written before the cage existed', () => {
      const storage = memoryStorage();
      storage.setItem(
        SAVE_KEY,
        JSON.stringify({ version: 1, bankroll: 1234, phase: 'wall', dial: 0.25, stake: 200, cleared: [] }),
      );
      const store = make({ storage });
      expect(store.state.bankroll).toBe(1234);
      expect(store.state.forge).toBeNull();
    });

    it('brings a save that went broke at the cage back broke', async () => {
      const storage = saved({ phase: 'intro', bankroll: 100, stake: 100 });
      const store = make({ rng: caught, storage });
      await store.forge(1, PAYS);
      const reloaded = make({ storage });
      expect(reloaded.state.broke).toBe(true);
      expect(reloaded.state.bankroll).toBe(0);
    });
  });

  describe('restart and dispose', () => {
    it('restart clears the forge and works from broke', async () => {
      const store = make({ rng: caught, storage: saved({ bankroll: 100, stake: 100 }) });
      await store.forge(1, PAYS);
      expect(store.state.broke).toBe(true);
      store.restart();
      expect(store.state.forge).toBeNull();
      expect(store.state.broke).toBe(false);
      expect(store.state.bankroll).toBe(START_BANKROLL);
    });

    it('restart abandons a forge in flight', async () => {
      const held = heldForge();
      const store = make({ source: held.source, rng: passing, storage: saved() });
      const forged = store.forge(1, PAYS);
      store.restart();
      expect(store.state.forging).toBe(false);
      held.release(await source.wiesner(1));
      await forged;
      expect(store.state.forge).toBeNull();
      expect(store.state.bankroll).toBe(START_BANKROLL);
    });

    it('a new forge after restart is not ended by the old one', async () => {
      const pending: ((result: WiesnerResult) => void)[] = [];
      const store = make({
        source: { ...source, wiesner: () => new Promise((resolve) => { pending.push(resolve); }) },
        rng: passing,
        storage: saved(),
      });
      const old = store.forge(1, PAYS);
      store.restart();
      const fresh = store.forge(2, PAYS);
      pending[0]?.(await source.wiesner(1));
      await old;
      expect(store.state.forging).toBe(true);
      pending[1]?.(await source.wiesner(2));
      await fresh;
      expect(store.state.forge?.length).toBe(2);
      expect(store.state.forging).toBe(false);
    });

    it('dispose abandons a forge in flight', async () => {
      const held = heldForge();
      const storage = saved();
      const store = make({ source: held.source, rng: passing, storage });
      const forged = store.forge(1, PAYS);
      store.dispose();
      held.release(await source.wiesner(1));
      await forged;
      expect(store.state.bankroll).toBe(9700);
      expect(storage.writes).toBe(0);
    });
  });
});

describe('persistence', () => {
  it('saves on entering the wall and entangled, never the classical phase', async () => {
    const storage = memoryStorage();
    const store = make({ storage });
    store.deal();
    await hands(CLASSICAL_HANDS - 1);
    expect(storage.writes).toBe(0);
    await hands(1);
    expect(saveOf(storage)).toMatchObject({ phase: 'wall', bankroll: 9700 });
    store.entangle();
    expect(saveOf(storage)?.phase).toBe('entangled');
    expect(storage.writes).toBe(2);
  });

  it('saves a real change of dial or stake and nothing else', () => {
    const storage = saved();
    const store = make({ storage });
    store.setDial(TUNED);
    store.setDial(0.51);
    store.setStake(100);
    expect(storage.writes).toBe(0);
    store.setDial(0.25);
    expect(storage.writes).toBe(1);
    store.setStake(200);
    expect(storage.writes).toBe(2);
    expect(saveOf(storage)).toMatchObject({ dial: 0.25, stake: 200 });
  });

  it('does not save during a run, even on the shatter, and saves once at the end', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => true);
    const storage = saved();
    const store = make({ rng, storage });
    const finished = store.run();
    await hands(RUN_HANDS - 1);
    expect(store.state.phase).toBe('beyond');
    expect(storage.writes).toBe(0);
    await hands(1);
    await finished;
    expect(storage.writes).toBe(1);
    expect(saveOf(storage)).toMatchObject({
      phase: 'beyond',
      cleared: ['tables'],
      bankroll: store.state.bankroll,
    });
  });

  it('writes saves its own reader accepts, tables only in beyond', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => true);
    const storage = saved();
    const store = make({ rng, storage });
    const finished = store.run();
    await hands(RUN_HANDS);
    await finished;
    expect(saveOf(storage)).toMatchObject({ phase: 'beyond', cleared: ['tables'] });
    expect(make({ storage }).state).toMatchObject({ phase: 'beyond', cleared: ['tables'] });

    store.restart();
    expect(saveOf(storage)).toMatchObject({ phase: 'intro', cleared: [] });
    expect(make({ storage }).state).toMatchObject({ phase: 'intro', cleared: [] });
  });

  it('rolls a mid-run reload back to the last settled point', async () => {
    const rng = await steeredRng(TUNED, RUN_HANDS, () => true);
    const storage = saved({ bankroll: 5000 });
    const store = make({ rng, storage });
    void store.run();
    await hands(10);
    expect(store.state.bankroll).toBe(5250);
    store.dispose();
    const reloaded = make({ storage });
    expect(reloaded.state).toMatchObject({
      phase: 'entangled',
      bankroll: 5000,
      rounds: 0,
      last: null,
      history: [],
      autoplaying: false,
      result: null,
    });
  });

  it('rolls a reload in the classical stage back to the fresh game', async () => {
    const storage = memoryStorage();
    const store = make({ storage });
    store.deal();
    await hands(10);
    store.dispose();
    expect(make({ storage }).state).toMatchObject({ phase: 'intro', bankroll: START_BANKROLL });
  });

  it('restores the intro', () => {
    const store = make({ storage: saved({ phase: 'intro', bankroll: 10000, dial: 0.14 }) });
    expect(store.state).toMatchObject({
      phase: 'intro',
      mode: 'classical',
      dial: MISTUNED,
      target: 0.75,
    });
  });

  it('restores the wall in classical mode', () => {
    const store = make({ storage: saved({ phase: 'wall', dial: TUNED }) });
    expect(store.state).toMatchObject({
      phase: 'wall',
      mode: 'classical',
      target: 0.75,
      bankroll: 9700,
    });
  });

  it('restores entangled in quantum mode with a looked-up target', () => {
    const store = make({ storage: saved({ dial: 0.51 }) });
    expect(store.state).toMatchObject({
      phase: 'entangled',
      mode: 'quantum',
      dial: TUNED,
      target: source.previewWinRate(TUNED),
    });
  });

  it('restores beyond with tables cleared', () => {
    const store = make({ storage: saved({ phase: 'beyond', cleared: ['cage'] }) });
    expect(store.state.mode).toBe('quantum');
    expect(store.state.cleared).toEqual(expect.arrayContaining(['tables', 'cage']));
  });

  it('lowers an unaffordable stake and recomputes broke on restore', () => {
    const low = make({ storage: saved({ bankroll: 300, stake: 1000 }) });
    expect(low.state).toMatchObject({ stake: 200, broke: false });
    const out = make({ storage: saved({ bankroll: 99, stake: 100 }) });
    expect(out.state).toMatchObject({ stake: 100, broke: true });
  });

  it('starts fresh on a corrupted save', () => {
    const storage = memoryStorage();
    storage.setItem(SAVE_KEY, '{nope');
    expect(make({ storage }).state.phase).toBe('intro');
  });

  it('keeps playing on storage that throws', async () => {
    const store = make({ storage: brokenStorage });
    await reachWall(store);
    store.entangle();
    const finished = store.run(3);
    await hands(3);
    await finished;
    expect(store.state.rounds).toBe(3);
    store.restart();
    expect(store.state.phase).toBe('intro');
  });

  it('plays with no storage at all', async () => {
    const store = make({ storage: null });
    await reachWall(store);
    expect(store.state.phase).toBe('wall');
  });
});

describe('subscribe and onRound', () => {
  it('subscribe fires at once and stops after unsubscribing', () => {
    const store = make({ storage: saved() });
    const fn = vi.fn();
    const off = store.subscribe(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(store.state);
    store.setDial(0.25);
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    store.setDial(0.5);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('onRound stops after unsubscribing', async () => {
    const store = make({ storage: saved() });
    const fn = vi.fn();
    const off = store.onRound(fn);
    const finished = store.run();
    await hands(2);
    off();
    await hands(RUN_HANDS);
    await finished;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('calls onRound before the emit for the same hand', async () => {
    const store = make({ storage: saved() });
    const order: string[] = [];
    store.onRound(() => order.push('round'));
    const finished = store.run(1);
    await hands(0);
    store.subscribe(() => order.push('emit'));
    order.length = 0;
    await hands(1);
    await finished;
    expect(order).toEqual(['round', 'emit']);
  });

  it('keeps the state object identity', async () => {
    const store = make({ storage: saved() });
    const { state } = store;
    const finished = store.run(2);
    await hands(2);
    await finished;
    store.restart();
    expect(store.state).toBe(state);
  });
});

describe('refreshPreview', () => {
  function switchable() {
    let rate: number | null = null;
    const swapped: ResultSource = {
      ...source,
      previewWinRate: (dial) => (rate !== null && source.snapDial(dial) === TUNED ? rate : source.previewWinRate(dial)),
    };
    return { source: swapped, set: (value: number | null) => { rate = value; } };
  }

  it('reads the preview again when the source underneath changes', () => {
    const { source: swapped, set } = switchable();
    const store = make({ source: swapped, storage: saved() });
    const fn = vi.fn();
    store.subscribe(fn);
    set(0.7);
    store.refreshPreview();
    expect(store.state.target).toBe(0.7);
    expect(fn).toHaveBeenCalledTimes(2);
    set(null);
    store.refreshPreview();
    expect(store.state.target).toBe(source.previewWinRate(TUNED));
  });

  it('leaves a run in progress alone', async () => {
    const { source: swapped, set } = switchable();
    const store = make({ source: swapped, storage: saved() });
    const finished = store.run(2);
    await hands(0);
    const target = store.state.target;
    set(0.7);
    store.refreshPreview();
    expect(store.state.target).toBe(target);
    await hands(2);
    await finished;
  });

  it('leaves the classical table alone', () => {
    const { source: swapped, set } = switchable();
    const store = make({ source: swapped });
    set(0.7);
    store.refreshPreview();
    expect(store.state.target).toBe(source.limits.classical);
  });
});
