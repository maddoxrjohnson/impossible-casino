// Keeps a Roulette result off the rest of the HUD while the panel's ball rolls. Presentation only: the store has
// already settled the spin, saved it and moved the bankroll, and nothing here feeds back into the game.
import type { RouletteSpin } from '../game/roulette';
import type { GameState } from '../game/store';
import { ROLL_MS } from './roulette-wheel';

/** What a spin gives away beyond the panel: the bankroll, the stake it can force down, broke, the cleared rooms and the spin itself. */
export interface SpinShown {
  readonly bankroll: number;
  readonly stake: number;
  readonly broke: boolean;
  readonly cleared: GameState['cleared'];
  readonly spin: RouletteSpin | null;
}

export interface SpinHold {
  readonly spin: RouletteSpin;
  /** On the same clock as `now`. */
  readonly until: number;
  /** What was on show before the spin, and stays on show until `until`. */
  readonly before: SpinShown;
}

export function spinShown(s: GameState): SpinShown {
  return { bankroll: s.bankroll, stake: s.stake, broke: s.broke, cleared: [...s.cleared], spin: s.roulette?.spin ?? null };
}

/**
 * The hold after seeing `s` at `now`. A new spin holds what was shown before it for `ms`, and any other change of
 * spin, such as leaving the room or opening the next round, ends it. With no roll (`ms` 0, under reduced motion)
 * nothing is held.
 */
export function holdFor(hold: SpinHold | null, before: SpinShown | null, s: GameState, now: number, ms: number): SpinHold | null {
  const spin = s.roulette?.spin ?? null;
  if (hold && spin === hold.spin) return now < hold.until ? hold : null;
  if (!spin || ms <= 0 || !before || spin === before.spin) return null;
  return { spin, until: now + ms, before };
}

/** `s` as the HUD shows it under `hold`. */
export function shownState(s: GameState, hold: SpinHold | null): GameState {
  if (!hold || !s.roulette) return s;
  const { spin, ...rest } = hold.before;
  return { ...s, ...rest, roulette: { ...s.roulette, spin } };
}

/** How long past the roll a hold waits for the ball to report landing, in case the panel is not painting it. */
export const LAND_SLACK_MS = 1500;

export interface SpinRevealOptions {
  now?: () => number;
  /** How long the coming roll runs: 0 under reduced motion, read at each spin. */
  rollMs?: () => number;
  /** Runs `fn` after `ms` and returns its cancel. */
  later?: (fn: () => void, ms: number) => () => void;
}

const timeout = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => { clearTimeout(id); };
};

/**
 * Every reader passes the store's state through `shown` and draws what comes back. A hold ends when the panel's ball
 * reports landing, or after the roll and `LAND_SLACK_MS` if it never does, and subscribers are then told so they can
 * draw again. A hold ended by the state itself, such as leaving the room, is already being drawn.
 */
export function createSpinReveal({ now = () => performance.now(), rollMs = () => ROLL_MS, later = timeout }: SpinRevealOptions = {}) {
  let hold: SpinHold | null = null, before: SpinShown | null = null, cancel: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const stop = (): void => { cancel?.(); cancel = null; };
  const tell = (): void => { listeners.forEach((fn) => { fn(); }); };
  return {
    shown: (s: GameState): GameState => {
      const t = now();
      const ms = rollMs();
      const next = holdFor(hold, before, s, t, ms > 0 ? ms + LAND_SLACK_MS : 0);
      if (next !== hold) {
        // A hold that ran out here keeps its timer, which tells the subscribers; a changed spin needs no telling.
        const ranOut = hold !== null && next === null && (s.roulette?.spin ?? null) === hold.spin;
        if (!ranOut) stop();
        hold = next;
        if (next) cancel = later(() => { cancel = null; hold = null; tell(); }, next.until - t);
      }
      before = spinShown(s);
      return shownState(s, hold);
    },
    /** The panel's ball has come to rest on `spin`. */
    land(spin: RouletteSpin | null): void {
      if (!hold || hold.spin !== spin) return;
      stop();
      hold = null;
      tell();
    },
    /** Whether a result is being held back now. */
    holding: (): boolean => hold !== null,
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    dispose(): void { stop(); hold = null; listeners.clear(); },
  };
}

export type SpinReveal = ReturnType<typeof createSpinReveal>;
