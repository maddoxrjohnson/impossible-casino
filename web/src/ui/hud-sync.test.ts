import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import { createPrerunSource, parseChshExport, parseWiesnerExport } from '../game/results';
import { HAND_MS, type Rng } from '../game/rules';
import { SAVE_KEY } from '../game/save';
import { createGameStore, type GameStore, type Phase } from '../game/store';
import type { HudButton } from './hud';
import { createHudSync, type HudSurface } from './hud-sync';
import { createLines } from './lines';

const source = createPrerunSource({ chsh: parseChshExport(chshJson), wiesner: parseWiesnerExport(wiesnerJson) }, 'ibm-noise-model');
const LINES = createLines(source.limits);
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

function fakeHud() {
  const seen = {
    said: [] as string[],
    plaque: new Map<string, string>(),
    main: { label: '' } as HudButton,
    alt: undefined as HudButton | undefined,
    title: false,
    dial: false,
    dialLocked: false,
    stubs: false,
    receipt: false,
    ticket: false,
    colour: false,
    cleared: null as readonly string[] | null,
    source: null as string | null,
    ticks: null as readonly number[] | null,
    note: null as string | null,
    stakesDisabled: [] as boolean[],
  };
  const hud: HudSurface = {
    put: (key, text) => { seen.plaque.set(key, text); },
    say: (text) => { if (seen.said[seen.said.length - 1] !== text) seen.said.push(text); },
    buttons: (main, alt) => { seen.main = main; seen.alt = alt; },
    input: { value: '0', setAttribute: () => undefined } as unknown as HTMLInputElement,
    stubs: (on, hasReceipt) => { seen.stubs = on; seen.receipt = on && hasReceipt; },
    source: (text) => { seen.source = text; },
    title: (on) => { seen.title = on; },
    dial: (on) => { seen.dial = on; },
    dialTicks: (at) => { seen.ticks = [...at]; },
    dialNote: ({ text }) => { seen.note = text; },
    dialLocked: (on) => { seen.dialLocked = on; },
    stakes: (choices) => { seen.stakesDisabled = choices.map((c) => c.disabled); },
    ticket: (on) => { seen.ticket = on; },
    colour: (on) => { seen.colour = on; },
    progress: (cleared) => { seen.cleared = [...cleared]; },
  };
  return { hud, seen };
}

function memoryStorage(save?: object) {
  const map = new Map<string, string>(save ? [[SAVE_KEY, JSON.stringify(save)]] : []);
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
}

function table({ save, locked = false, seed = 7 }: { save?: object; locked?: boolean; seed?: number } = {}) {
  const store = createGameStore({ source, rng: seeded(seed), storage: memoryStorage(save) });
  const { hud, seen } = fakeHud();
  const moment = { locked, inRoom: false };
  const hudSync = createHudSync(hud, { source, lines: LINES, moment: () => moment });
  store.subscribe(hudSync.sync);
  return { store, seen, moment, hudSync };
}

const said = (seen: ReturnType<typeof fakeHud>['seen']) => seen.said[seen.said.length - 1];

async function settle(store: GameStore): Promise<void> {
  await vi.advanceTimersByTimeAsync(HAND_MS * 60);
  expect(store.state.autoplaying).toBe(false);
}

function press(store: GameStore, seen: ReturnType<typeof fakeHud>['seen'], button: HudButton = seen.main): void {
  expect(button.disabled).toBeFalsy();
  const acts = { deal: () => { store.deal(); }, entangle: () => { store.entangle(); }, run: () => { void store.run(); }, restart: () => { store.restart(); } };
  acts[button.act as keyof typeof acts]();
}

describe('createHudSync', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('prints the plaque and the opening line on a fresh game', () => {
    const { seen } = table();
    expect(seen.plaque.get('rate')).toBe('No hands');
    expect(seen.plaque.get('hands')).toBe('dealt yet');
    expect(seen.plaque.get('limit')).toBe('75%');
    expect(seen.plaque.get('even')).toBe('break even 80%');
    expect(said(seen)).toBe(LINES.intro);
    expect(seen.title).toBe(true);
    expect(seen.main).toMatchObject({ label: 'Deal', act: 'deal' });
  });

  it('marks no chip dials on a simulator-only source, and says so at the dial', () => {
    const { seen } = table({ save: { version: 1, bankroll: 10000, phase: 'entangled', dial: 0.5, stake: 100, cleared: [] } });
    expect(seen.ticks).toEqual([]);
    expect(seen.note).toBe('Simulator at this angle');
  });

  it('holds a band line back so the phase line gets its moment, then owes it after a story beat', () => {
    const { store, seen, moment, hudSync } = table({ save: { version: 1, bankroll: 9000, phase: 'wall', dial: MISTUNED, stake: 100, cleared: [] } });
    moment.locked = true;
    store.entangle();
    expect(said(seen)).toBe(LINES.entangled);
    expect(seen.main.disabled).toBe(true);
    expect(seen.dial).toBe(false);
    moment.locked = false;
    hudSync.sync(store.state);
    expect(said(seen)).toBe(LINES.low);
    expect(seen.main.disabled).toBeFalsy();
    expect(seen.dial).toBe(true);
  });

  it('keeps the phase line up when nothing locks, until the player next does something', () => {
    const { store, seen } = table({ save: { version: 1, bankroll: 9000, phase: 'wall', dial: MISTUNED, stake: 100, cleared: [] } });
    store.entangle();
    expect(said(seen)).toBe(LINES.entangled);
    expect(seen.main).toMatchObject({ label: 'Run', act: 'run' });
    store.setDial(TUNED);
    expect(said(seen)).not.toBe(LINES.entangled);
  });

  it('says the band line again once told the card was changed from outside', () => {
    const { store, seen, moment, hudSync } = table({ save: { version: 1, bankroll: 9000, phase: 'entangled', dial: MISTUNED, stake: 100, cleared: [] } });
    store.setDial(MISTUNED + 0.0625);
    const band = said(seen);
    moment.inRoom = true;
    hudSync.sync(store.state);
    expect(seen.source).toBeNull();
    expect(seen.dial).toBe(false);
    seen.said.push(LINES.cage);
    moment.inRoom = false;
    hudSync.sync(store.state);
    expect(said(seen)).toBe(LINES.cage);
    hudSync.clearBand();
    hudSync.sync(store.state);
    expect(said(seen)).toBe(band);
  });

  it('keeps the ticket down until there is a hand to show, and through a run', async () => {
    const { store, seen } = table({ save: { version: 1, bankroll: 9000, phase: 'entangled', dial: TUNED, stake: 100, cleared: [] } });
    expect(seen.ticket).toBe(false);
    void store.run();
    await settle(store);
    expect(seen.ticket).toBe(true);
    void store.run();
    expect(store.state.last).toBeNull();
    expect(seen.ticket).toBe(true);
    await settle(store);
    store.restart();
    expect(seen.ticket).toBe(false);
  });

  it('keeps the beyond line after a full run past the limit', async () => {
    const { store, seen } = table({ save: { version: 1, bankroll: 9000, phase: 'beyond', dial: TUNED, stake: 100, cleared: [] } });
    void store.run();
    await settle(store);
    expect(said(seen)).toBe(LINES.beyond);
  });

  it('lets a phase line stand while a crossing run plays out', async () => {
    for (let seed = 1; seed < 40; seed += 1) {
      const { store, seen } = table({ seed, save: { version: 1, bankroll: 90000, phase: 'entangled', dial: TUNED, stake: 100, cleared: [] } });
      void store.run();
      await settle(store);
      if (store.state.phase !== 'beyond') continue;
      expect(said(seen)).toBe(LINES.beyond);
      expect(seen.main).toMatchObject({ label: 'Run' });
      expect(seen.main.disabled).toBeFalsy();
      expect(seen.alt).toMatchObject({ act: 'restart' });
      expect(seen.alt?.disabled).toBeFalsy();
      return;
    }
    throw new Error('No seed crossed the limit');
  });

  it('offers Start over when a game goes broke during the classical hands', async () => {
    const { store, seen } = table({ save: { version: 1, bankroll: 100, phase: 'intro', dial: MISTUNED, stake: 100, cleared: [] } });
    expect(seen.main).toMatchObject({ label: 'Deal' });
    press(store, seen);
    await settle(store);
    expect(store.state.broke).toBe(true);
    expect(store.state.phase).toBe('classical');
    expect(said(seen)).toBe(LINES.broke);
    expect(seen.main).toMatchObject({ label: 'Start over', act: 'restart' });
    press(store, seen);
    expect(store.state.phase).toBe('intro');
    expect(said(seen)).toBe(LINES.intro);
    expect(seen.main).toMatchObject({ label: 'Deal' });
  });
});

describe('a table with nothing to wait for', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function expectPlayable(seen: ReturnType<typeof fakeHud>['seen'], phase: Phase): void {
    expect(seen.main.disabled, `main button in ${phase}`).toBeFalsy();
    expect(seen.main.act, `main action in ${phase}`).toBeDefined();
    expect(seen.alt?.disabled, `second button in ${phase}`).toBeFalsy();
    expect(seen.stubs, `stubs in ${phase}`).toBe(true);
    expect(seen.dialLocked, `dial in ${phase}`).toBe(false);
  }

  it('plays from the deal to past the limit and back to the start without locking', async () => {
    const { store, seen } = table({ seed: 11 });
    press(store, seen);
    expect(seen.main).toMatchObject({ label: 'Dealing', disabled: true });
    await settle(store);
    expect(store.state.phase).toBe('wall');
    expect(said(seen)).toBe(LINES.wall);
    expectPlayable(seen, 'wall');
    press(store, seen);
    expect(store.state.phase).toBe('entangled');
    expect(seen.dial).toBe(true);
    expectPlayable(seen, 'entangled');
    store.setDial(TUNED);
    for (let i = 0; i < 40 && store.state.phase === 'entangled'; i += 1) {
      press(store, seen);
      await settle(store);
      if (!store.state.broke) expectPlayable(seen, store.state.phase);
    }
    expect(store.state.phase).toBe('beyond');
    expect(seen.receipt).toBe(true);
    expect(seen.source).toContain('Source:');
    press(store, seen, seen.alt);
    expect(store.state.phase).toBe('intro');
    expectPlayable(seen, 'intro');
    expect(said(seen)).toBe(LINES.intro);
  });

  it('never leaves a broke player without Start over, in or past the limit', async () => {
    for (const phase of ['entangled', 'beyond'] as const) {
      const { store, seen } = table({ seed: 3, save: { version: 1, bankroll: 100, phase, dial: MISTUNED, stake: 100, cleared: [] } });
      for (let i = 0; i < 40 && !store.state.broke; i += 1) {
        press(store, seen);
        await settle(store);
      }
      expect(store.state.broke).toBe(true);
      expect(seen.main).toMatchObject({ label: 'Start over', act: 'restart' });
      expect(said(seen)).toBe(LINES.broke);
      expect(seen.dial).toBe(false);
      press(store, seen);
      expect(store.state.phase).toBe('intro');
      expectPlayable(seen, 'intro');
    }
  });

  it('reports a failed run and hands the controls back', async () => {
    const store = createGameStore({ source: { ...source, chsh: () => Promise.reject(new Error('down')) }, storage: memoryStorage({ version: 1, bankroll: 9000, phase: 'entangled', dial: TUNED, stake: 100, cleared: [] }) });
    const { hud, seen } = fakeHud();
    store.subscribe(createHudSync(hud, { source, lines: LINES, moment: () => ({ locked: false, inRoom: false }) }).sync);
    press(store, seen);
    await settle(store);
    expect(said(seen)).toBe(LINES.misdeal);
    expect(seen.main.disabled).toBeFalsy();
  });
});

describe('createHudSync in the cage', () => {
  const PAYS = 100;
  const pass = () => 0, catchAll = () => 0.999999;

  function cage({ save, rng = pass, wiesner = (length: number) => source.wiesner(length) }: { save?: object; rng?: Rng; wiesner?: typeof source.wiesner } = {}) {
    const store = createGameStore({ source: { ...source, wiesner }, rng, storage: memoryStorage(save ?? { version: 1, bankroll: 9000, phase: 'entangled', dial: 0.5, stake: 100, cleared: [] }) });
    const { hud, seen } = fakeHud();
    const moment = { locked: false, inRoom: true, inCage: true };
    store.subscribe(createHudSync(hud, { source, lines: LINES, moment: () => moment }).sync);
    return { store, seen, moment };
  }

  it('shows the table controls as held from the moment a forge starts until it settles', async () => {
    let settle: (result: Awaited<ReturnType<typeof source.wiesner>>) => void = () => undefined;
    const held = () => new Promise<Awaited<ReturnType<typeof source.wiesner>>>((resolve) => { settle = resolve; });
    const { store, seen, moment } = cage({ wiesner: held });
    moment.inRoom = false; moment.inCage = false;
    store.setStake(200);
    expect(seen.main.disabled).toBeFalsy();
    expect(seen.stakesDisabled).toEqual([false, false, false, false]);

    const forged = store.forge(1, PAYS);
    expect(seen.main).toMatchObject({ label: 'Run', disabled: true });
    expect(seen.stakesDisabled).toEqual([true, true, true, true]);

    settle(await source.wiesner(1));
    await forged;
    expect(seen.main.disabled).toBeFalsy();
    expect(seen.stakesDisabled).toEqual([false, false, false, false]);
  });

  it('hands the table back when a forge fails', async () => {
    const { store, seen, moment } = cage({ wiesner: () => Promise.reject(new Error('down')) });
    moment.inRoom = false; moment.inCage = false;
    await store.forge(1, PAYS);
    expect(seen.main.disabled).toBeFalsy();
  });

  it('says pass and caught', async () => {
    const won = cage();
    await won.store.forge(1, PAYS);
    expect(said(won.seen)).toBe(LINES.forged);
    const lost = cage({ rng: catchAll });
    await lost.store.forge(1, PAYS);
    expect(said(lost.seen)).toBe(LINES.caught);
  });

  it('says the room is cleared the first time only', async () => {
    const { store, seen } = cage();
    await store.forge(4, PAYS);
    expect(said(seen)).toBe(LINES.cageClear);
    await store.forge(4, PAYS);
    expect(said(seen)).toBe(LINES.forged);
  });

  it('hands the HUD the cleared rooms, so the colour and the elevator follow them', async () => {
    const { store, seen } = cage();
    expect(seen.cleared).toEqual([]);
    await store.forge(4, PAYS);
    expect(seen.cleared).toEqual(['cage']);
    store.restart();
    expect(seen.cleared).toEqual([]);
  });

  it('says broke when the catch took the last chips', async () => {
    const { store, seen } = cage({ rng: catchAll, save: { version: 1, bankroll: 100, phase: 'entangled', dial: 0.5, stake: 100, cleared: [] } });
    await store.forge(1, PAYS);
    expect(said(seen)).toBe(LINES.broke);
  });

  it('owns up to a rejected forge', async () => {
    const { store, seen } = cage({ wiesner: () => Promise.reject(new Error('down')) });
    await store.forge(1, PAYS);
    expect(said(seen)).toBe(LINES.forgeFailed);
  });

  it('stays in the cage on a restart that keeps the phase', async () => {
    const { store, seen } = cage({ rng: catchAll, save: { version: 1, bankroll: 100, phase: 'intro', dial: 0.5, stake: 100, cleared: [] } });
    await store.forge(1, PAYS);
    store.restart();
    expect(said(seen)).toBe(LINES.cage);
  });

  it('says nothing about a forge dropped by a restart', async () => {
    const { store, seen, moment } = cage({ save: { version: 1, bankroll: 9000, phase: 'beyond', dial: 0.5, stake: 100, cleared: ['tables'] } });
    moment.inRoom = false; moment.inCage = false;
    void store.forge(1, PAYS);
    store.restart();
    await vi.waitFor(() => { expect(said(seen)).toBe(LINES.intro); });
  });

  it('reports a result that lands after the player left', async () => {
    const { store, seen, moment } = cage();
    const forged = store.forge(1, PAYS);
    moment.inRoom = false; moment.inCage = false;
    await forged;
    expect(said(seen)).toBe(LINES.forged);
  });

  it('shows the last forge on the plaque in the cage, and the last hand elsewhere', async () => {
    const { store, seen, moment } = cage();
    await store.forge(1, PAYS);
    expect(seen.plaque.get('delta')).toBe('last forge +25');
    moment.inRoom = false; moment.inCage = false;
    store.setStake(200);
    expect(seen.plaque.get('delta')).toBe('\u00a0');
  });

  it('turns the receipt on for a forge in the cage, not for the table run', async () => {
    const { store, seen, moment } = cage();
    expect(seen.receipt).toBe(false);
    await store.forge(1, PAYS);
    expect(seen.receipt).toBe(true);
    moment.inRoom = false; moment.inCage = false;
    store.setStake(200);
    expect(seen.receipt).toBe(false);
  });

  it('keeps the table run behind the stub in the cage only when a forge exists', async () => {
    const { store, seen, moment } = cage();
    moment.inRoom = false; moment.inCage = false;
    await store.run(1);
    await vi.waitFor(() => { expect(store.state.autoplaying).toBe(false); });
    expect(seen.receipt).toBe(true);
    moment.inRoom = true; moment.inCage = true;
    store.setStake(200);
    expect(seen.receipt).toBe(false);
  });

  it('keeps the receipt off outside the Cage after a forge, while the table has no run', async () => {
    const { store, seen, moment } = cage();
    moment.inCage = false;
    await store.forge(1, PAYS);
    expect(seen.receipt).toBe(false);
  });
});
