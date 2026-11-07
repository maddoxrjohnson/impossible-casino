// What the dealer says, and how numbers are written on the table. Rates come from the rules and the export.
import { BEYOND_MIN_HANDS, BREAK_EVEN } from '../game/rules';
import type { Phase } from '../game/store';

export interface Limits {
  readonly classical: number;
  readonly quantum: number;
}

export type Band = 'low' | 'over' | 'even' | 'best';
export type LineKey = Phase | Band | 'short' | 'cage' | 'wheel';

/** Where the best band starts, as a share of the span from break-even to the quantum limit. */
const BEST_SHARE = 0.75;

export const pct = (rate: number, digits = 0): string => `${(rate * 100).toFixed(digits)}%`;
export const money = (amount: number): string => Math.round(amount).toLocaleString('en-US');
export const signedAmount = (delta: number): string => `${delta > 0 ? '+' : '−'}${Math.abs(delta)}`;

/**
 * Whether a rate clears the classical limit at the precision the table prints,
 * so sampling noise on a dial that reads 75.0% is never called a win over the limit.
 */
export function pastClassical(rate: number, classical: number): boolean {
  return Math.round(rate * 1000) > Math.round(classical * 1000);
}

/**
 * Which line a dial earns. `even` starts where the store starts counting a dial
 * toward clearing the table: strictly above break-even.
 */
export function bandFor(target: number, limits: Limits): Band {
  if (!pastClassical(target, limits.classical)) return 'low';
  if (target <= BREAK_EVEN) return 'over';
  return target >= BREAK_EVEN + (limits.quantum - BREAK_EVEN) * BEST_SHARE ? 'best' : 'even';
}

export function createLines(limits: Limits): Record<LineKey, string> {
  const even = pct(BREAK_EVEN);
  return {
    intro: 'You and a partner sit in separate rooms. Each of you draws a question, 0 or 1, and answers without talking. Answer alike and you win, unless you both drew a 1. Then you must differ.',
    classical: 'You both always say 0. It is the best plan two people can make in advance, and it fails only when both questions come up 1.',
    wall: `Three hands in four. That glass is where every plan made in advance stops, and you need ${even} to break even. I keep a pair of particles for people in your position.`,
    entangled: 'That colour was always in the building. Now turn your dial until the pair does what no plan can.',
    beyond: 'Your two answers just won more often than any plan allows, and nothing passed between them. The house has no rule for this. It only has more floors.',
    low: 'Not past the line. A good plan could do that much.',
    over: `Past the line, which no plan can do. Until you clear ${even} the house still takes your money, so keep turning.`,
    even: 'Past break-even. A little further and the table runs out of angle.',
    best: `Nearly all the angle there is. ${pct(limits.quantum, 2)} is as far as the physics goes. Press Run.`,
    short: `Not yet. The table wants ${BEYOND_MIN_HANDS} hands running above ${even}, on an angle that runs above ${even}. Tune the dial and run it again.`,
    cage: "The Cashier's Cage, 4 K. Nobody has ever cashed out warm. It opens when the table has something to pay.",
    wheel: 'The Roulette Wheel, 800 mK. It has not stopped since 1926. Another night.',
  };
}

/** Slider step for the exported dial grid: its smallest gap, so the thumb can reach every point. */
export function dialStep(dials: readonly number[]): number {
  let step = Infinity;
  for (let i = 1; i < dials.length; i += 1) {
    step = Math.min(step, (dials[i] as number) - (dials[i - 1] as number));
  }
  return Number.isFinite(step) ? step : 1;
}
