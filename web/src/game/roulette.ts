// The Roulette Wheel: the draft, the house's play and the spin. Every chance, count and limit comes from the Qiskit export. No DOM.
import { forgeWin } from './cage';
import {
  draftKey,
  ROULETTE_POCKETS,
  type Provenance,
  type RouletteCard,
  type RouletteEdge,
  type RouletteExport,
  type RouletteNode,
  type RoulettePoint,
  type RouletteTurn,
} from './results';
import type { Rng } from './rules';

export interface RouletteBoard {
  readonly runId: string;
  readonly deck: readonly RouletteCard[];
  /** Net profit on a straight-up win, on `payoutStake`. */
  readonly pays: number;
  readonly payoutStake: number;
  /** Where every spin reads from. */
  readonly provenance: Provenance;
  readonly points: readonly RoulettePoint[];
  /** The run's own returns against the house. */
  readonly edge: RouletteEdge;
  /** The chance of clearing on the best line, at the exact wheel's house limit. */
  readonly clearChance: number;
  /** The most the player can force on one pocket against a perfect house. */
  readonly houseLimit: number;
  /** Null for a draft the game never reaches. */
  node(draft: readonly number[]): RouletteNode | null;
  /** The play run's shots for a finished draft. Null for any other. */
  point(draft: readonly number[]): RoulettePoint | null;
  /** The exact wheel after this draft, one chance per pocket. */
  wheel(draft: readonly number[]): readonly number[] | null;
  /** The logical circuit, as OpenQASM 2, for a finished draft. */
  circuit(draft: readonly number[]): string | null;
}

export interface RouletteSpin {
  /** The pocket bet on. */
  readonly pocket: number;
  readonly landed: number;
  readonly won: boolean;
  readonly delta: number;
  readonly clears: boolean;
  /** The point's shots, and how many of them landed where this spin did. */
  readonly shots: number;
  readonly landedShots: number;
  readonly draft: readonly number[];
}

/** One round, from the house's first card to the spin. Each move returns a new one. */
export interface RouletteRound {
  /** Fixed before the house's first card. */
  readonly stake: number;
  readonly draft: readonly number[];
  readonly turn: RouletteTurn;
  /** The exported wheel after the draft so far. */
  readonly wheel: readonly number[];
  /** The dealer's hint: the best chance the player can still force from here. */
  readonly best: number;
  /** Null until the spin settles the round. */
  readonly spin: RouletteSpin | null;
}

export function rouletteBoard(roulette: RouletteExport, runId: string = roulette.playRun): RouletteBoard {
  const run = roulette.runs.find((r) => r.id === runId);
  if (!run) throw new Error(`Unknown run id: ${runId}`);
  const edge = roulette.edge.find((e) => e.run === runId);
  if (!edge) throw new Error(`No roulette edge for run ${runId}`);
  const straight = roulette.payouts.table.find((row) => row.bet === 'straight');
  if (!straight) throw new Error('No straight bet in the roulette pay table');
  const nodes = new Map(roulette.nodes.map((n) => [draftKey(n.draft), n]));
  const points = new Map(run.points.map((p) => [draftKey(p.draft), p]));
  const circuits = new Map(roulette.logicalCircuits.map((c) => [draftKey(c.draft), c.qasm]));
  const node = (draft: readonly number[]): RouletteNode | null => nodes.get(draftKey(draft)) ?? null;
  return {
    runId,
    deck: roulette.deck,
    pays: straight.pays,
    payoutStake: roulette.payouts.stake,
    provenance: run.provenance,
    points: run.points,
    edge,
    clearChance: roulette.clear.chance,
    houseLimit: roulette.limits.houseLimit.value,
    node,
    point: (draft) => points.get(draftKey(draft)) ?? null,
    wheel(draft) {
      const at = node(draft);
      return at ? (roulette.wheels[at.wheel] ?? null) : null;
    },
    circuit: (draft) => circuits.get(draftKey(draft)) ?? null,
  };
}

/** The round at this draft, after the house has played any turn that is its own. */
function advance(board: RouletteBoard, stake: number, draft: readonly number[], rng: Rng): RouletteRound | null {
  let at = board.node(draft);
  while (at?.turn === 'house') {
    const cards = at.houseCards;
    const card = cards[Math.min(cards.length - 1, Math.floor(rng() * cards.length))] as number;
    at = board.node([...at.draft, card]);
  }
  const wheel = at && board.wheel(at.draft);
  if (!at || !wheel) return null;
  return { stake, draft: at.draft, turn: at.turn, wheel, best: at.value, spin: null };
}

/** A fresh round on the empty draft. The house plays its first card at once. */
export function openRound(board: RouletteBoard, stake: number, rng: Rng): RouletteRound {
  const round = advance(board, stake, [], rng);
  if (!round) throw new Error('No roulette node for the empty draft');
  return round;
}

/** The player's card, then the house's reply if it is the house's turn. Null for an illegal move. */
export function playCard(board: RouletteBoard, round: RouletteRound, card: number, rng: Rng): RouletteRound | null {
  if (round.turn !== 'player' || round.spin) return null;
  if (!Number.isInteger(card) || card < 0 || card >= board.deck.length || round.draft.includes(card)) return null;
  return advance(board, round.stake, [...round.draft, card], rng);
}

/** One shot from the play run's counts for this draft, weighted by count. Null for an illegal bet. */
export function spinRound(board: RouletteBoard, round: RouletteRound, pocket: number, rng: Rng): RouletteRound | null {
  if (round.turn !== 'spin' || round.spin) return null;
  if (!Number.isInteger(pocket) || pocket < 0 || pocket >= ROULETTE_POCKETS) return null;
  const point = board.point(round.draft);
  const node = board.node(round.draft);
  if (!point || node?.turn !== 'spin') return null;
  const draw = rng() * point.shots;
  let seen = 0;
  let landed = 0;
  for (let p = 0; p < point.counts.length; p += 1) {
    const count = point.counts[p] ?? 0;
    seen += count;
    // The last pocket with shots also takes a draw at the very top.
    if (count > 0) landed = p;
    if (draw < seen) break;
  }
  const won = landed === pocket;
  const spin: RouletteSpin = {
    pocket,
    landed,
    won,
    delta: won ? forgeWin(board.pays, round.stake, board.payoutStake) : -round.stake,
    clears: won && node.limitPockets.includes(landed),
    shots: point.shots,
    landedShots: point.counts[landed] ?? 0,
    draft: round.draft,
  };
  return { ...round, spin };
}
