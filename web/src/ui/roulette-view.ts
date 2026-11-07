// What the Roulette panel shows at each moment. Every chance and count comes from the board's exported wheels and run. No DOM.
import { forgeWin } from '../game/cage';
import { provenanceLabel, type RouletteCard, type RouletteExport } from '../game/results';
import type { RouletteBoard } from '../game/roulette';
import type { GameState } from '../game/store';
import { money, pct, signedAmount } from './lines';
import { stakeChoices, type StakeChoice } from './table';

export type RouletteState = Pick<GameState, 'bankroll' | 'stake' | 'autoplaying' | 'forging' | 'broke' | 'roulette' | 'cleared'>;
/** The export's own words for its rules and its wheels. */
export type RouletteText = Pick<RouletteExport, 'houseRule' | 'stakeRule' | 'bet' | 'wheelsMethod'>;

export type RouletteStage = 'idle' | 'player' | 'spin' | 'settled';

export interface RoulettePocket {
  readonly pocket: number;
  readonly chance: number;
  /** "1 in 4", for reading out. */
  readonly odds: string;
  /** "1/4", to fit inside the pocket. */
  readonly short: string;
  /** How bright to draw it, from 0 for an empty pocket to 1 for a certain one. */
  readonly level: number;
  readonly picked: boolean;
  readonly landed: boolean;
  readonly label: string;
}

export interface RouletteDrafted {
  readonly card: number;
  readonly name: string;
  readonly by: 'House' | 'You';
  /** Pockets lit once it was played. */
  readonly lit: number;
  /** What it did to the wheel. */
  readonly note: string;
}

export interface RouletteDeckCard {
  readonly card: number;
  readonly name: string;
  readonly drafted: boolean;
  readonly disabled: boolean;
  readonly label: string;
}

export interface RouletteButton {
  readonly label: string;
  readonly act: 'open' | 'spin' | 'restart';
  readonly disabled: boolean;
  readonly brass: boolean;
}

export interface RouletteResult {
  readonly head: string;
  readonly detail: string;
  readonly won: boolean;
}

export interface RouletteView {
  readonly stage: RouletteStage;
  readonly goal: string;
  readonly drafted: readonly RouletteDrafted[];
  readonly deck: readonly RouletteDeckCard[];
  readonly pockets: readonly RoulettePocket[];
  readonly pocketsLocked: boolean;
  /** What to do now. */
  readonly turn: string;
  readonly hint: string | null;
  readonly tied: readonly string[];
  readonly lastCard: string | null;
  readonly stakes: readonly StakeChoice[];
  readonly button: RouletteButton;
  readonly result: RouletteResult | null;
  readonly rows: readonly (readonly [label: string, value: string])[];
  readonly note: string;
  readonly sources: readonly string[];
}

/** An exact wheel chance as "1 in N", "0" or "certain". Anything else, as a percentage. */
export function oneIn(chance: number): string {
  if (chance <= 0) return '0';
  if (chance >= 1) return 'certain';
  const n = 1 / chance;
  return Math.abs(n - Math.round(n)) < 1e-6 ? `1 in ${Math.round(n)}` : pct(chance, 1);
}

function shortOdds(chance: number): string {
  if (chance <= 0) return '0';
  if (chance >= 1) return '1';
  const n = 1 / chance;
  return Math.abs(n - Math.round(n)) < 1e-6 ? `1/${Math.round(n)}` : pct(chance);
}

/** The pair a Tie card acts on, as "q1-q2", or null for any other card. */
function pairOf(card: RouletteCard | undefined): string | null {
  const [op, ...rest] = card?.ops ?? [];
  return op && !rest.length && op.gate === 'cz' ? op.qubits.map((q) => `q${q}`).join('-') : null;
}

/** The pairs the export marks tied at this stage, as "q1-q2". */
function tiedAt(board: RouletteBoard, draft: readonly number[]): string[] {
  return (board.node(draft)?.tiedPairs ?? []).map((pair) => pair.map((q) => `q${q}`).join('-'));
}

function tieNote(pair: string, was: boolean, now: boolean): string {
  if (!was && now) return `The pair ${pair} is now tied, so a Sweep cannot settle it.`;
  if (was && !now) return `The twin card untied ${pair}.`;
  return now ? `${pair} is still tied.` : `${pair} is still not tied.`;
}

const lit = (wheel: readonly number[] | null): number => wheel?.filter((p) => p > 0).length ?? 0;
const per100 = (r: number): string => (r * 100).toFixed(1);
const pockets = (n: number): string => `${n} pocket${n === 1 ? '' : 's'}`;
const sameWheel = (a: readonly number[] | null, b: readonly number[] | null): boolean => !!a && !!b && a.length === b.length && a.every((p, i) => p === b[i]);
/** The export's rule up to its first semicolon, as a sentence. */
const clause = (rule: string): string => { const head = rule.split(';')[0]?.trim() ?? ''; return `${head.charAt(0).toUpperCase()}${head.slice(1)}.`; };

function drafted(board: RouletteBoard, draft: readonly number[]): RouletteDrafted[] {
  return draft.map((card, i) => {
    const before = draft.slice(0, i), after = draft.slice(0, i + 1);
    const by = board.node(before)?.turn === 'house' ? 'House' : 'You';
    const name = board.deck[card]?.name ?? `Card ${card}`;
    const was = board.wheel(before), now = board.wheel(after);
    const litNow = lit(now), litWas = lit(was);
    const moved = sameWheel(was, now) ? `The wheel did not move: ${pockets(litNow)} lit` : litWas === litNow ? `Still ${pockets(litNow)} lit, at new odds` : `${pockets(litWas)} lit, now ${litNow}`;
    const parts = [`${by === 'House' ? 'The house' : 'You'} played ${name}. ${moved}.`];
    const pair = pairOf(board.deck[card]);
    const held = tiedAt(board, before);
    if (pair) parts.push(tieNote(pair, held.includes(pair), tiedAt(board, after).includes(pair)));
    if (board.deck[card]?.id === 'sweep' && held.length) {
      parts.push(`The Sweep could not settle ${held.join(' or ')}: ${held.length === 1 ? 'that pair was' : 'those pairs were'} tied.`);
    }
    return { card, name, by, lit: litNow, note: parts.join(' ') };
  });
}

function button(state: RouletteState, stage: RouletteStage, picked: number | null): RouletteButton {
  if (state.broke && (stage === 'idle' || stage === 'settled')) return { label: 'Start over', act: 'restart', disabled: false, brass: true };
  if (stage === 'idle' || stage === 'settled') {
    const disabled = state.autoplaying || state.forging || state.stake > state.bankroll;
    return { label: stage === 'idle' ? 'Open a round' : 'Another round', act: 'open', disabled, brass: false };
  }
  return { label: 'Spin', act: 'spin', disabled: stage !== 'spin' || picked === null, brass: stage === 'spin' };
}

function result({ roulette, bankroll }: RouletteState): RouletteResult | null {
  const spin = roulette?.spin;
  if (!roulette || !spin) return null;
  const clears = spin.clears ? ' It won on a pocket at the house limit, which clears the Wheel.' : '';
  return {
    head: `${spin.won ? 'Won' : 'Lost'} ${signedAmount(spin.delta)}`,
    detail: `Pocket ${spin.pocket} at ${money(roulette.stake)}. Landed on ${spin.landed}, which took ${money(spin.landedShots)} of ${money(spin.shots)} shots.${clears} Bankroll now ${money(bankroll)}.`,
    won: spin.won,
  };
}

export function rouletteView(state: RouletteState, board: RouletteBoard, text: RouletteText, picked: number | null): RouletteView {
  const round = state.roulette;
  const stage: RouletteStage = !round ? 'idle' : round.spin ? 'settled' : round.turn === 'spin' ? 'spin' : 'player';
  const drafting = stage === 'player' || stage === 'spin';
  const draft = round?.draft ?? [];
  const list = drafted(board, draft);
  const bet = round?.spin?.pocket ?? (stage === 'spin' ? picked : null);
  const landed = round?.spin?.landed ?? null;
  const wheel = round?.wheel ?? board.wheel([]) ?? [];
  const full = Math.log2(wheel.length || 1);
  const turn = { idle: 'Pick a stake and open a round. The house plays the first card.', player: 'Your card. Pick one from the deck.', spin: bet === null ? 'Pick a pocket, then spin.' : `Pocket ${bet}, at ${oneIn(wheel[bet] ?? 0)} on the exact wheel. Spin when ready.`, settled: '' }[stage];
  return {
    stage,
    goal: state.cleared.includes('roulette') ? 'The Roulette Wheel is cleared.' : `Win on a pocket at the house limit, ${oneIn(board.houseLimit)}, to clear the Wheel.`,
    drafted: list,
    deck: board.deck.map((card, i) => {
      const down = draft.includes(i), disabled = stage !== 'player' || down;
      const by = list.find((d) => d.card === i)?.by;
      return { card: i, name: card.name, drafted: down, disabled, label: down ? `${card.name}, played by ${by === 'House' ? 'the house' : 'you'}` : card.name };
    }),
    pockets: wheel.map((chance, pocket) => {
      const odds = oneIn(chance), isBet = pocket === bet, isLanded = pocket === landed;
      const level = chance > 0 ? 0.3 + 0.7 * Math.min(1, Math.max(0, Math.log2(chance * wheel.length) / full)) : 0;
      const tags = [isBet ? 'your bet' : '', isLanded ? 'the ball landed here' : ''].filter(Boolean).join(', ');
      return { pocket, chance, odds, short: shortOdds(chance), level, picked: isBet, landed: isLanded, label: `Pocket ${pocket}, ${odds} on the exact wheel${tags ? `, ${tags}` : ''}` };
    }),
    pocketsLocked: stage !== 'spin',
    turn,
    hint: drafting && round ? `Dealer's hint: the best you can still force is ${oneIn(round.best)} on the exact wheel.` : null,
    tied: tiedAt(board, draft),
    lastCard: list[list.length - 1]?.note ?? null,
    stakes: stakeChoices(state, drafting || state.forging),
    button: button(state, stage, picked),
    result: result(state),
    rows: [
      ['Pays', `${money(board.pays)} on ${money(board.payoutStake)}, so +${money(forgeWin(board.pays, state.stake, board.payoutStake))} at your stake`],
      ['House limit', `${oneIn(board.houseLimit)} on one pocket of the exact wheel, against a perfect house`],
      ['Best return', `Playing every draft to the spin, no strategy gets back more than ${per100(board.edge.bestReturn)} per 100 in this run. Leaving bad drafts, the most is ${per100(board.edge.worstSpin.return)} per 100${board.edge.worstSpin.return < 1 ? ', still under 100' : ''}.`],
      ['Clear chance', `${pct(board.edge.clearChance, 1)} a spin on the best line, in this run`],
    ],
    note: drafting
      ? clause(stage === 'spin' ? text.bet : text.houseRule)
      : `${clause(text.stakeRule)} Leaving the room drops a draft, and the stake is only taken at the spin.`,
    sources: [
      `Wheel: the exact ${text.wheelsMethod}`,
      `Spin, return and clear chance: one shot from ${money(board.provenance.shots)} per draft, ${provenanceLabel(board.provenance)}`,
    ],
  };
}
