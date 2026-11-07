// What the Cage panel shows at each moment. Rates come from the board and the forge's own result. No DOM.
import { forgeWin, type CageBoard } from '../game/cage';
import { provenanceLabel } from '../game/results';
import { CAGE_CLEAR_LENGTH } from '../game/rules';
import type { GameState } from '../game/store';
import { money, pct, signedAmount } from './lines';
import { stakeChoices, type StakeChoice } from './table';

export type CageState = Pick<GameState, 'bankroll' | 'stake' | 'autoplaying' | 'forging' | 'broke' | 'forge' | 'cleared'>;

export interface CageViewRow {
  readonly length: number;
  readonly pass: string;
  readonly limit: string;
  readonly pays: string;
  /** The whole row as one spoken name, for the radio it sits on. */
  readonly label: string;
}

export interface CageButton {
  readonly label: string;
  readonly act: 'forge' | 'restart';
  readonly disabled: boolean;
  readonly brass: boolean;
}

export interface CageResult {
  readonly head: string;
  readonly detail: string;
  readonly won: boolean;
}

export interface CageView {
  readonly rows: readonly CageViewRow[];
  readonly stakes: readonly StakeChoice[];
  readonly button: CageButton;
  readonly result: CageResult | null;
  readonly goal: string;
  readonly sources: readonly string[];
}

const qubits = (length: number): string => `${length} qubit${length === 1 ? '' : 's'}`;

function button({ broke, forging, autoplaying }: CageState): CageButton {
  if (broke) return { label: 'Start over', act: 'restart', disabled: false, brass: true };
  return { label: forging ? 'At the wicket' : 'Forge', act: 'forge', disabled: forging || autoplaying, brass: false };
}

function result({ forge }: CageState): CageResult | null {
  if (!forge) return null;
  const { passed, delta, length, stake, result: run } = forge;
  const counts = `${money(run.passes)} passes in ${money(run.shots)} shots`;
  return {
    head: `${passed ? 'Passed' : 'Caught'} ${signedAmount(delta)}`,
    detail: `${qubits(length)} at ${money(stake)}. One draw at ${pct(run.passRate, 1)}, from ${counts}.`,
    won: passed,
  };
}

export function cageView(state: CageState, board: CageBoard): CageView {
  const rows = board.rows.map((row) => {
    const pass = pct(row.passRate, 1), limit = pct(row.limit, 1);
    const pays = `+${money(forgeWin(row.pays, state.stake, board.payoutStake))}`;
    const label = `${qubits(row.length)}, ${pass} this run, proven limit ${limit}, pays ${pays}`;
    return { length: row.length, pass, limit, pays, label };
  });
  const sources = [`Odds source: ${provenanceLabel(board.provenance)}`];
  if (state.forge) sources.push(`Last forge source: ${provenanceLabel(state.forge.result.provenance)}`);
  return {
    rows,
    stakes: stakeChoices(state, state.forging),
    button: button(state),
    result: result(state),
    goal: state.cleared.includes('cage') ? 'The Cage is cleared.' : `Pass ${qubits(CAGE_CLEAR_LENGTH)} or longer to clear the Cage.`,
    sources,
  };
}
