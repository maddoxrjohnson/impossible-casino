// What the Cage panel shows at each moment. Rates come from the board and the forge's own result. No DOM.
import { forgeWin, type CageBoard } from '../game/cage';
import { provenanceLabel, ticketSplit } from '../game/results';
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
  readonly note: string;
  /** What the asterisk on chip rows means; shown beside the table whenever a chip row is. */
  readonly chipNote: string | null;
  readonly sources: readonly string[];
}

/** Long enough to outlast a double press or a tap that lands twice, short enough not to feel stuck. */
export const RESTART_ARM_MS = 700;

/**
 * A forge settles at once, so Forge can turn into Start over under a press already on
 * its way. This holds whatever replaces the `press` act back for a moment, until the result can be read.
 */
export function createRestartGuard(now: () => number, press = 'forge') {
  let shown: string | null = null, armsAt = 0;
  return {
    see(act: string): void {
      if (shown === press && act !== press) armsAt = now() + RESTART_ARM_MS;
      else if (act === press) armsAt = 0;
      shown = act;
    },
    holding: (): boolean => now() < armsAt,
  };
}

const RUN_NOTE = "A run is a sample of shots, so it can land a little either side of the attack's rate.";
const CHIP_NOTE = '* Chip rates repeat a fixed set of tickets, so they spread wider than their shots suggest.';

const qubits = (length: number): string => `${length} qubit${length === 1 ? '' : 's'}`;

function button({ broke, forging, autoplaying }: CageState): CageButton {
  if (broke) return { label: 'Start over', act: 'restart', disabled: false, brass: true };
  return { label: forging ? 'At the wicket' : 'Forge', act: 'forge', disabled: forging || autoplaying, brass: false };
}

function result({ forge, bankroll }: CageState): CageResult | null {
  if (!forge) return null;
  const { passed, delta, length, stake, result: run } = forge;
  const split = ticketSplit(run);
  const counts = `${money(run.passes)} passes in ${money(run.shots)} shots${split ? ` (${split})` : ''}`;
  return {
    head: `${passed ? 'Passed' : 'Caught'} ${signedAmount(delta)}`,
    detail: `${qubits(length)} at ${money(stake)}. One draw at ${pct(run.passRate, 1)}, from ${counts}. Bankroll now ${money(bankroll)}.`,
    won: passed,
  };
}

export function cageView(state: CageState, board: CageBoard): CageView {
  const { chip } = board;
  const split = chip && ticketSplit(chip);
  const rows = board.rows.map((row) => {
    const pass = pct(row.passRate, 1), limit = pct(row.limit, 1);
    const pays = `+${money(forgeWin(row.pays, state.stake, board.payoutStake))}`;
    const measured = row.onChip ? `${pass} on chip, ${split ?? ''}` : `${pass} this run`;
    const label = `${qubits(row.length)}, ${measured}, this attack's rate ${limit}, pays ${pays}`;
    return { length: row.length, pass: row.onChip ? `${pass}*` : pass, limit, pays, label };
  });
  const sources: string[] = [];
  if (board.rows.some((row) => !row.onChip)) sources.push(`Odds source: ${provenanceLabel(board.provenance)}`);
  if (chip) sources.push(`* Odds source: ${provenanceLabel(chip.provenance)}, ${split ?? ''}`);
  if (state.forge) sources.push(`Last forge source: ${provenanceLabel(state.forge.result.provenance)}`);
  return {
    rows,
    stakes: stakeChoices(state, state.forging),
    button: button(state),
    result: result(state),
    goal: state.cleared.includes('cage') ? 'The Cage is cleared.' : `Pass ${qubits(CAGE_CLEAR_LENGTH)} or longer to clear the Cage.`,
    note: RUN_NOTE,
    chipNote: chip ? CHIP_NOTE : null,
    sources,
  };
}
