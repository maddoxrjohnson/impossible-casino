// What the table offers at each moment: buttons, stakes, and which line the dealer owes. No DOM, no drawing.
import { BREAK_EVEN, RUN_HANDS, STAKES } from '../game/rules';
import { provenanceLabel, type Provenance } from '../game/results';
import type { GameState, Phase } from '../game/store';
import type { HudButton } from './hud';
import { bandFor, pastClassical, pct, signedAmount, type Limits, type LineKey } from './lines';

export interface TableMoment {
  /** A story beat owns the screen. */
  readonly locked: boolean;
  /** The player is looking through a side-room door. */
  readonly inRoom: boolean;
}

export interface StakeChoice {
  readonly value: number;
  readonly disabled: boolean;
}

export function tableButtons(
  { phase, autoplaying, broke, forging }: Pick<GameState, 'phase' | 'autoplaying' | 'broke' | 'forging'>,
  { locked, inRoom }: TableMoment,
): { main: HudButton; alt?: HudButton } {
  if (broke && !autoplaying) {
    return { main: { label: 'Start over', act: 'restart', brass: true, disabled: locked } };
  }
  const run: HudButton = {
    label: autoplaying ? 'Running' : 'Run',
    act: 'run',
    disabled: autoplaying || locked || inRoom || forging,
  };
  switch (phase) {
    case 'intro':
      return { main: { label: 'Deal', act: 'deal', disabled: forging } };
    case 'classical':
      return { main: { label: 'Dealing', disabled: true } };
    case 'wall':
      return { main: { label: 'Entangle the pair', act: 'entangle', brass: true, disabled: forging } };
    case 'entangled':
      return { main: run };
    case 'beyond':
      return { main: run, alt: { label: 'Restart', act: 'restart', disabled: autoplaying || locked || forging } };
  }
}

export function stakeChoices(
  { bankroll, autoplaying }: Pick<GameState, 'bankroll' | 'autoplaying'>,
  locked: boolean,
): StakeChoice[] {
  return STAKES.map((value) => ({ value, disabled: autoplaying || locked || value > bankroll }));
}

/**
 * The source of the quantum numbers on the table, or null while none are showing.
 * Classical hands come from a plan, not a circuit, so they carry no source.
 * The plaque keeps the last run's hands through a dial turn, so when they came from
 * somewhere other than the odds on the dial, the line names both.
 */
export function sourceLine(
  { phase, dial, target, result, rounds }: Pick<GameState, 'phase' | 'dial' | 'target' | 'result' | 'rounds'>,
  preview: Provenance,
): string | null {
  if (phase !== 'entangled' && phase !== 'beyond') return null;
  // Any turn of the dial puts the preview rate back on screen, even if it returns to the run's dial.
  const showingRun = result?.dial === dial && result.winRate === target;
  const odds = provenanceLabel(showingRun ? result.provenance : preview);
  const hands = result && rounds > 0 ? provenanceLabel(result.provenance) : odds;
  return hands === odds ? `Source: ${odds}` : `Odds source: ${odds} · Last run source: ${hands}`;
}

/**
 * The line owed once nothing is moving, or null to keep the one showing.
 * `ran` means a quantum run has just ended. A failed run deals no hands, and a run
 * stopped by the bankroll deals fewer than a full run. `showing` is the settled line
 * on the card, empty when the card still holds the phase line.
 */
export function settledLine(
  { phase, broke, rounds, target }: Pick<GameState, 'phase' | 'broke' | 'rounds' | 'target'>,
  ran: boolean,
  limits: Limits,
  showing: LineKey | '' = '',
): LineKey | null {
  if (broke) return 'broke';
  if (ran && rounds === 0) return 'misdeal';
  if (ran && rounds < RUN_HANDS) return 'covered';
  if (phase === 'beyond' && ran && showing) return 'past';
  if (phase !== 'entangled') return null;
  if (ran) return target > BREAK_EVEN ? 'cold' : 'short';
  return bandFor(target, limits);
}

/** Where the flat table stands on the lift dial: outside the stack before the deal, then down at the table. */
export function flatFloor(phase: Phase, stages: number): number {
  return phase === 'intro' ? 0 : stages - 1;
}

/** The running win rate as the flat table draws it. `fill` is a percentage of the bar. */
export function flatRate({ rounds, winRate }: Pick<GameState, 'rounds' | 'winRate'>, limits: Limits) {
  if (!rounds) return { text: 'No hands', hands: 'dealt yet', fill: 0, past: false };
  return {
    text: pct(winRate, 1),
    hands: `over ${rounds} hand${rounds === 1 ? '' : 's'}`,
    fill: winRate * 100,
    past: pastClassical(winRate, limits.classical),
  };
}

export interface FlatHand {
  readonly title: string;
  readonly x: string;
  readonly y: string;
  readonly a: string;
  readonly b: string;
  readonly result: string;
  readonly win: boolean;
}

/**
 * The hand on the flat table. A run clears the store's last hand, so the one on
 * the table stays until the next is dealt, marked as no longer the current hand.
 */
export function flatHand({ phase, rounds, last }: Pick<GameState, 'phase' | 'rounds' | 'last'>, held: FlatHand | null): FlatHand | null {
  if (last) {
    return {
      title: rounds ? `Hand ${rounds}` : 'Last hand',
      x: String(last.x),
      y: String(last.y),
      a: String(last.a),
      b: String(last.b),
      result: `${last.win ? 'Won' : 'Lost'} ${signedAmount(last.delta)}`,
      win: last.win,
    };
  }
  return phase === 'intro' || !held ? null : { ...held, title: 'Last hand' };
}
