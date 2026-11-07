// The Cashier's Cage: what the board offers and how a forge settles. Every rate comes from the Qiskit export or the result. No DOM.
import { drawPass, type Provenance, type WiesnerExport, type WiesnerResult } from './results';
import { CAGE_CLEAR_LENGTH, type Rng } from './rules';

export interface CageRow {
  readonly length: number;
  /** The share of shots that passed in the board's run. */
  readonly passRate: number;
  /** The proven limit for this attack at this length. */
  readonly limit: number;
  /** Net profit on `CageBoard.payoutStake`. */
  readonly pays: number;
}

export interface CageBoard {
  readonly rows: readonly CageRow[];
  readonly payoutStake: number;
  /** Where `rows` read from. A forge reports its own provenance on its result. */
  readonly provenance: Provenance;
}

export interface ForgeAttempt {
  readonly length: number;
  readonly stake: number;
  readonly passed: boolean;
  readonly delta: number;
  readonly result: WiesnerResult;
}

export function cageBoard(wiesner: WiesnerExport, runId: string): CageBoard {
  const run = wiesner.runs.find((r) => r.id === runId);
  if (!run) throw new Error(`Unknown run id: ${runId}`);
  const rows = wiesner.payouts.table.map(({ length, pays }) => {
    const point = run.points.find((p) => p.length === length);
    const limit = wiesner.limits.byLength.find((l) => l.length === length);
    if (!point || !limit) throw new Error(`No Wiesner data at length ${length}`);
    return { length, passRate: point.passRate, limit: limit.value, pays };
  });
  return { rows, payoutStake: wiesner.payouts.stake, provenance: run.provenance };
}

/** The net win at this stake, in whole chips, rounded toward the house. */
export function forgeWin(pays: number, stake: number, payoutStake: number): number {
  return Math.floor((pays * stake) / payoutStake);
}

/** One draw from the result's own counts. */
export function settleForge(
  result: WiesnerResult,
  stake: number,
  payoutStake: number,
  rng: Rng,
): ForgeAttempt {
  const passed = drawPass(result, rng);
  const delta = passed ? forgeWin(result.payout.pays, stake, payoutStake) : -stake;
  return { length: result.length, stake, passed, delta, result };
}

export function clearsCage({ length, passed }: Pick<ForgeAttempt, 'length' | 'passed'>): boolean {
  return passed && length >= CAGE_CLEAR_LENGTH;
}
