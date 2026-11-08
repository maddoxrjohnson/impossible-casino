import { describe, expect, it } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import rouletteJson from '../../public/data/roulette.v1.json';
import { createPrerunSource, parseChshExport, parseRouletteExport, parseWiesnerExport } from '../game/results';
import { rouletteBoard } from '../game/roulette';
import { SAVE_KEY } from '../game/save';
import { createGameStore } from '../game/store';
import { ROLL_MS } from './roulette-wheel';
import { createSpinReveal, holdFor, LAND_SLACK_MS, shownState, spinShown } from './spin-reveal';

const source = createPrerunSource({ chsh: parseChshExport(chshJson), wiesner: parseWiesnerExport(wiesnerJson) }, 'ibm-noise-model');
const board = rouletteBoard(parseRouletteExport(rouletteJson));
const LIMIT_LINE = [2, 3, 4, 0];
const node = board.node(LIMIT_LINE);
const limitPocket = node?.turn === 'spin' ? (node.limitPockets[0] as number) : -1;
const point = board.point(LIMIT_LINE);
const other = point?.counts.findIndex((c, i) => c > 0 && i !== limitPocket) ?? -1;
const at = (pocket: number) => (point?.counts.slice(0, pocket).reduce((sum, c) => sum + c, 0) ?? 0) / (point?.shots ?? 1);

function memoryStorage(save: object) {
  const map = new Map<string, string>([[SAVE_KEY, JSON.stringify(save)]]);
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, map };
}

/** A store at the wheel, a hand-wound clock and timers, and a reveal reading the store on every emit. */
function wheel({ bankroll = 9000, ms = ROLL_MS }: { bankroll?: number; ms?: number } = {}) {
  let draw = 0, t = 1000;
  const storage = memoryStorage({ version: 1, bankroll, phase: 'beyond', dial: 0.5, stake: 100, cleared: [] });
  const store = createGameStore({ source, rng: () => draw, storage });
  const timers: { fn: () => void; at: number; live: boolean }[] = [];
  const reveal = createSpinReveal({
    now: () => t,
    rollMs: () => ms,
    later: (fn, wait) => { const timer = { fn, at: t + wait, live: true }; timers.push(timer); return () => { timer.live = false; }; },
  });
  const shown: ReturnType<typeof reveal.shown>[] = [];
  store.subscribe((s) => { const v = reveal.shown(s); shown.push({ ...v }); });
  let told = 0;
  reveal.subscribe(() => { told += 1; shown.push({ ...reveal.shown(store.state) }); });
  /** Moves the clock without running the timers, as a late timer would. */
  const skip = (by: number) => { t += by; };
  const advance = (by: number) => {
    t += by;
    for (const timer of timers) if (timer.live && timer.at <= t) { timer.live = false; timer.fn(); }
  };
  const house = (line: readonly number[], card: number) => {
    const n = board.node(line);
    if (n?.turn === 'house') draw = (n.houseCards.indexOf(card) + 0.5) / n.houseCards.length;
  };
  const draft = () => {
    house([], 2);
    store.rouletteOpen(board);
    house([2, 3], 4);
    store.roulettePlay(board, 3);
    store.roulettePlay(board, 0);
  };
  const spin = (lands: number) => { draw = at(lands); store.rouletteSpin(board, limitPocket); };
  const last = () => shown[shown.length - 1];
  return { store, reveal, storage, skip, advance, draft, spin, last, told: () => told, live: () => timers.filter((x) => x.live).length };
}

describe('holdFor', () => {
  it('holds nothing without a spin, and nothing when the roll takes no time', () => {
    const { store, draft, spin } = wheel();
    draft();
    const before = spinShown(store.state);
    expect(holdFor(null, before, store.state, 0, ROLL_MS)).toBeNull();
    spin(other);
    expect(holdFor(null, before, store.state, 0, 0)).toBeNull();
    const hold = holdFor(null, before, store.state, 0, ROLL_MS);
    expect(hold?.until).toBe(ROLL_MS);
    expect(hold?.before).toBe(before);
  });

  it('is revealed from the moment the roll ends', () => {
    const { store, draft, spin } = wheel();
    draft();
    const before = spinShown(store.state);
    spin(other);
    const hold = holdFor(null, before, store.state, 0, ROLL_MS);
    expect(holdFor(hold, before, store.state, ROLL_MS - 1, ROLL_MS)).toBe(hold);
    expect(holdFor(hold, before, store.state, ROLL_MS, ROLL_MS)).toBeNull();
  });
});

describe('shownState', () => {
  it('shows the bankroll, stake, broke, cleared rooms and spin from before, and leaves the store alone', () => {
    const { store, draft, spin } = wheel({ bankroll: 100 });
    draft();
    const before = spinShown(store.state);
    spin(other);
    const s = store.state;
    expect(s.broke).toBe(true);
    const hold = holdFor(null, before, s, 0, ROLL_MS);
    const v = shownState(s, hold);
    expect(v.bankroll).toBe(100);
    expect(v.broke).toBe(false);
    expect(v.roulette?.spin).toBeNull();
    expect(v.roulette?.draft).toEqual(s.roulette?.draft);
    expect(s.bankroll).toBe(0);
    expect(s.roulette?.spin).not.toBeNull();
    expect(shownState(s, null)).toBe(s);
  });
});

describe('createSpinReveal', () => {
  const FALLBACK = ROLL_MS + LAND_SLACK_MS;

  it('shows the pre-spin bankroll until the ball lands, while the store has settled and saved at once', () => {
    const { reveal, store, storage, advance, draft, spin, last, told } = wheel();
    draft();
    spin(other);
    expect(store.state.bankroll).toBe(8900);
    expect(JSON.parse(storage.map.get(SAVE_KEY) ?? '{}')).toMatchObject({ bankroll: 8900 });
    expect(last()?.bankroll).toBe(9000);
    expect(last()?.roulette?.spin).toBeNull();
    advance(1000);
    expect(told()).toBe(0);
    reveal.land(store.state.roulette?.spin ?? null);
    expect(told()).toBe(1);
    expect(last()?.bankroll).toBe(8900);
    expect(last()?.roulette?.spin).toBe(store.state.roulette?.spin);
  });

  it('waits for the ball past the usual roll, as a background tab would leave it', () => {
    const { reveal, store, advance, draft, spin, last, told } = wheel();
    draft();
    spin(other);
    advance(ROLL_MS + 500);
    expect(reveal.holding()).toBe(true);
    expect(told()).toBe(0);
    expect(last()?.bankroll).toBe(9000);
    reveal.land(store.state.roulette?.spin ?? null);
    expect(told()).toBe(1);
    expect(last()?.bankroll).toBe(8900);
  });

  it('lets go on its own after the fallback when no ball reports landing', () => {
    const { reveal, advance, draft, spin, last, told } = wheel();
    draft();
    spin(other);
    advance(FALLBACK - 1);
    expect(told()).toBe(0);
    advance(1);
    expect(told()).toBe(1);
    expect(reveal.holding()).toBe(false);
    expect(last()?.bankroll).toBe(8900);
  });

  it('still tells its subscribers when another reader sees the hold run out first', () => {
    const { reveal, store, skip, advance, draft, spin, told } = wheel();
    draft();
    spin(other);
    skip(FALLBACK);
    expect(reveal.shown(store.state).bankroll).toBe(8900);
    expect(told()).toBe(0);
    advance(0);
    expect(told()).toBe(1);
  });

  it('ignores a landing for a spin it is not holding', () => {
    const { reveal, draft, spin, told } = wheel();
    draft();
    spin(other);
    reveal.land(null);
    expect(reveal.holding()).toBe(true);
    expect(told()).toBe(0);
  });

  it('holds back a clearing win, so the cleared rooms wait too', () => {
    const { reveal, store, draft, spin, last } = wheel();
    draft();
    spin(limitPocket);
    expect(store.state.cleared).toContain('roulette');
    expect(last()?.cleared).not.toContain('roulette');
    reveal.land(store.state.roulette?.spin ?? null);
    expect(last()?.cleared).toContain('roulette');
  });

  it('shows the result at once when there is no roll', () => {
    const { reveal, store, draft, spin, last, live, told } = wheel({ ms: 0 });
    draft();
    spin(other);
    expect(last()?.bankroll).toBe(8900);
    expect(last()?.roulette?.spin).toBe(store.state.roulette?.spin);
    expect(live()).toBe(0);
    reveal.land(store.state.roulette?.spin ?? null);
    expect(told()).toBe(0);
  });

  it('lets go at once when the round is dropped mid-roll, with no timer left to fire', () => {
    const { store, advance, draft, spin, last, told, live } = wheel();
    draft();
    spin(other);
    store.rouletteLeave();
    expect(last()?.bankroll).toBe(8900);
    expect(live()).toBe(0);
    advance(FALLBACK);
    expect(told()).toBe(0);
  });

  it('lets go on dispose, and tells no one after', () => {
    const { reveal, advance, draft, spin, told, live } = wheel();
    draft();
    spin(other);
    expect(reveal.holding()).toBe(true);
    reveal.dispose();
    expect(reveal.holding()).toBe(false);
    expect(live()).toBe(0);
    advance(FALLBACK);
    expect(told()).toBe(0);
  });

  it('lets go at once when the next round opens, and holds the next spin afresh', () => {
    const { reveal, store, advance, draft, spin, last, told } = wheel();
    draft();
    spin(other);
    advance(1000);
    draft();
    expect(reveal.holding()).toBe(false);
    expect(last()?.bankroll).toBe(8900);
    spin(other);
    expect(last()?.bankroll).toBe(8900);
    reveal.land(store.state.roulette?.spin ?? null);
    expect(told()).toBe(1);
    expect(last()?.bankroll).toBe(8800);
  });
});
