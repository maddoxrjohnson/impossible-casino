export type Bit = 0 | 1;
export type Rng = () => number;
export interface Question {
  readonly x: Bit;
  readonly y: Bit;
}

export const ROOMS = ['tables', 'cage', 'roulette'] as const;
export type RoomId = (typeof ROOMS)[number];

/** Every stake is a multiple of 4, so a win always pays whole chips. */
export const STAKES = [100, 200, 500, 1000] as const;
export const CLASSICAL_STAKE = 100;
export const START_BANKROLL = 10000;
export const CLASSICAL_HANDS = 48;
export const RUN_HANDS = 36;
export const BEYOND_MIN_HANDS = 24;
export const HAND_MS = 90;
export const HISTORY_CAP = 120;
/** The chip lengths the Cage offers. */
export const FORGE_LENGTHS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
/** Provisional: a forgery that passes at this length or longer clears the Cage. */
export const CAGE_CLEAR_LENGTH = 4;
/** Starts mistuned, so the player has something to find. Snapped to the grid at use. */
export const START_DIAL = 0.14;
/** The best classical strategy: both players always answer 0. */
export const CLASSICAL_ANSWER: Bit = 0;

export const QUESTIONS: readonly Question[] = [
  { x: 0, y: 0 },
  { x: 0, y: 1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
];

export function winPayout(stake: number): number {
  return stake / 4;
}

export const BREAK_EVEN = CLASSICAL_STAKE / (CLASSICAL_STAKE + winPayout(CLASSICAL_STAKE));

export function isStake(value: unknown): value is number {
  return STAKES.some((stake) => stake === value);
}

export function isForgeLength(value: unknown): value is number {
  return FORGE_LENGTHS.some((length) => length === value);
}

export function chshWin(x: Bit, y: Bit, a: Bit, b: Bit): boolean {
  return (a ^ b) === (x & y);
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const held = items[i] as T;
    items[i] = items[j] as T;
    items[j] = held;
  }
  return items;
}

/** The four question pairs as evenly as possible; a remainder falls on random pairs. */
export function dealDeck(hands: number, rng: Rng): Question[] {
  const order = shuffle([...QUESTIONS], rng);
  const deck: Question[] = [];
  for (let i = 0; i < hands; i += 1) deck.push(order[i % order.length] as Question);
  return shuffle(deck, rng);
}
