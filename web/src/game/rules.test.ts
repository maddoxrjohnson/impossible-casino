import { describe, expect, it } from 'vitest';
import {
  BEYOND_MIN_HANDS,
  BREAK_EVEN,
  CLASSICAL_ANSWER,
  CLASSICAL_HANDS,
  CLASSICAL_STAKE,
  HAND_MS,
  HISTORY_CAP,
  QUESTIONS,
  ROOMS,
  RUN_HANDS,
  STAKES,
  START_BANKROLL,
  START_DIAL,
  chshWin,
  dealDeck,
  isStake,
  winPayout,
  type Bit,
  type Question,
} from './rules';

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tally(deck: readonly Question[]): number[] {
  return QUESTIONS.map((q) => deck.filter((d) => d.x === q.x && d.y === q.y).length);
}

describe('constants', () => {
  it('match the agreed table rules', () => {
    expect(STAKES).toEqual([100, 200, 500, 1000]);
    expect(CLASSICAL_STAKE).toBe(100);
    expect(START_BANKROLL).toBe(10000);
    expect(CLASSICAL_HANDS).toBe(48);
    expect(RUN_HANDS).toBe(36);
    expect(BEYOND_MIN_HANDS).toBe(24);
    expect(HAND_MS).toBe(90);
    expect(HISTORY_CAP).toBe(120);
    expect(START_DIAL).toBe(0.14);
    expect(ROOMS).toEqual(['tables', 'cage', 'roulette']);
  });

  it('keeps every stake a multiple of 4 so payouts stay whole chips', () => {
    for (const stake of STAKES) expect(stake % 4).toBe(0);
  });

  it('recognises stakes', () => {
    expect(isStake(500)).toBe(true);
    expect(isStake(300)).toBe(false);
    expect(isStake('100')).toBe(false);
  });
});

describe('winPayout and BREAK_EVEN', () => {
  it('pays a quarter of the stake', () => {
    expect(winPayout(100)).toBe(25);
    expect(winPayout(1000)).toBe(250);
  });

  it('breaks even at 80%', () => {
    expect(BREAK_EVEN).toBe(0.8);
  });
});

describe('chshWin', () => {
  it('follows the truth table', () => {
    const bits: Bit[] = [0, 1];
    for (const x of bits) {
      for (const y of bits) {
        for (const a of bits) {
          for (const b of bits) {
            const parity = a === b ? 0 : 1;
            const both = x === 1 && y === 1 ? 1 : 0;
            expect(chshWin(x, y, a, b)).toBe(parity === both);
          }
        }
      }
    }
  });

  it('gives the classical strategy exactly 3 of the 4 pairs', () => {
    const wins = QUESTIONS.filter((q) => chshWin(q.x, q.y, CLASSICAL_ANSWER, CLASSICAL_ANSWER));
    expect(wins).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ]);
  });
});

describe('dealDeck', () => {
  it('holds 12 of each pair in 48 hands', () => {
    expect(tally(dealDeck(48, seeded(1)))).toEqual([12, 12, 12, 12]);
  });

  it('holds 9 of each pair in 36 hands', () => {
    expect(tally(dealDeck(36, seeded(2)))).toEqual([9, 9, 9, 9]);
  });

  it('stays within one for a size that does not divide evenly', () => {
    const counts = tally(dealDeck(37, seeded(3)));
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(37);
    expect(Math.max(...counts) - Math.min(...counts)).toBe(1);
  });

  it('does not always hand the spare card to the same pair', () => {
    const rng = seeded(4);
    const spare = new Set<number>();
    for (let i = 0; i < 40; i += 1) spare.add(tally(dealDeck(5, rng)).indexOf(2));
    expect(spare.size).toBe(4);
  });

  it('shuffles', () => {
    const rng = seeded(5);
    const first = JSON.stringify(dealDeck(48, rng));
    expect(JSON.stringify(dealDeck(48, rng))).not.toBe(first);
    expect(JSON.stringify(dealDeck(48, seeded(5)))).toBe(first);
  });

  it('is empty for no hands', () => {
    expect(dealDeck(0, seeded(6))).toEqual([]);
  });
});
