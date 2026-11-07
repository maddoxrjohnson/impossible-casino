// Real chip results over any other source. A dial or length the chip never ran stays with the source underneath.
import type { ChipProvenance, ChshPoint, ChshResult, GameExports, Provenance, ResultSource, WiesnerResult } from './results';

const CHIP_RUN_ID = 'ibm-chip';

/** The run filed under this id, only if it really came from a chip. */
export function chipRunIn<R extends { readonly id: string; readonly provenance: Provenance }>(
  runs: readonly R[],
  chipRunId = CHIP_RUN_ID,
): (R & { readonly provenance: ChipProvenance }) | undefined {
  return runs.find((r): r is R & { readonly provenance: ChipProvenance } => r.id === chipRunId && r.provenance.source === 'ibm-chip');
}

export function withChipRuns(base: ResultSource, exports: GameExports, chipRunId = CHIP_RUN_ID): ResultSource {
  const { chsh, wiesner } = exports;
  const chshRun = chipRunIn(chsh.runs, chipRunId);
  const wiesnerRun = chipRunIn(wiesner.runs, chipRunId);
  if (!chshRun && !wiesnerRun) return base;

  const pointAt = (dial: number): ChshPoint | undefined => {
    const snapped = base.snapDial(dial);
    return chshRun?.points.find((p) => p.dial === snapped);
  };

  return {
    dials: base.dials,
    limits: base.limits,
    snapDial: (value) => base.snapDial(value),
    previewProvenance: (dial) => (chshRun && pointAt(dial) ? chshRun.provenance : base.previewProvenance(dial)),
    previewWinRate: (dial) => pointAt(dial)?.winRate ?? base.previewWinRate(dial),
    async chsh(dial): Promise<ChshResult> {
      const point = pointAt(dial);
      if (!chshRun || !point) return base.chsh(dial);
      const circuits = chsh.logicalCircuits.find((c) => c.dial === point.dial);
      if (!circuits) throw new Error(`No circuits at dial ${point.dial}`);
      return {
        experiment: 'chsh',
        runId: chshRun.id,
        dial: point.dial,
        winRate: point.winRate,
        outcomeOrder: chsh.outcomeOrder,
        pairs: point.pairs,
        circuits: circuits.pairs,
        provenance: chshRun.provenance,
      };
    },
    async wiesner(length): Promise<WiesnerResult> {
      const point = wiesnerRun?.points.find((p) => p.length === length);
      if (!wiesnerRun || !point) return base.wiesner(length);
      const payout = wiesner.payouts.table.find((row) => row.length === length);
      const circuit = wiesner.logicalCircuits.find((c) => c.length === length);
      const { ticketsPerPoint, shotsPerTicket } = wiesnerRun;
      if (!payout || !circuit || ticketsPerPoint === undefined || shotsPerTicket === undefined) {
        throw new Error(`No Wiesner chip data at length ${length}`);
      }
      return {
        experiment: 'wiesner',
        runId: wiesnerRun.id,
        length,
        shots: point.shots,
        passes: point.passes,
        passRate: point.passRate,
        qubits: point.qubits,
        payout,
        circuit: { ticket: circuit.ticket, qasm: circuit.qasm },
        // The exported note describes the simulators, which forge a fresh ticket every shot.
        circuitNote: `each circuit is one example ticket, not taken from this run; its ${ticketsPerPoint} random tickets replay from seed ${point.seed}`,
        provenance: wiesnerRun.provenance,
        ticketsPerPoint,
        shotsPerTicket,
      };
    },
  };
}
