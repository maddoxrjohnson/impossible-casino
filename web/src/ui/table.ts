// What the table offers at each moment: buttons, stakes, and which line the dealer owes. No DOM, no drawing.
import { BREAK_EVEN, RUN_HANDS, STAKES } from '../game/rules';
import type { GameState } from '../game/store';
import type { HudButton } from './hud';
import { bandFor, type Limits, type LineKey } from './lines';

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
  { phase, autoplaying, broke }: Pick<GameState, 'phase' | 'autoplaying' | 'broke'>,
  { locked, inRoom }: TableMoment,
): { main: HudButton; alt?: HudButton } {
  if (broke && !autoplaying) {
    return { main: { label: 'Start over', act: 'restart', brass: true, disabled: locked } };
  }
  const run: HudButton = {
    label: autoplaying ? 'Running' : 'Run',
    act: 'run',
    disabled: autoplaying || locked || inRoom,
  };
  switch (phase) {
    case 'intro':
      return { main: { label: 'Deal', act: 'deal' } };
    case 'classical':
      return { main: { label: 'Dealing', disabled: true } };
    case 'wall':
      return { main: { label: 'Entangle the pair', act: 'entangle', brass: true } };
    case 'entangled':
      return { main: run };
    case 'beyond':
      return { main: run, alt: { label: 'Restart', act: 'restart', disabled: autoplaying || locked } };
  }
}

export function stakeChoices(
  { bankroll, autoplaying }: Pick<GameState, 'bankroll' | 'autoplaying'>,
  locked: boolean,
): StakeChoice[] {
  return STAKES.map((value) => ({ value, disabled: autoplaying || locked || value > bankroll }));
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
