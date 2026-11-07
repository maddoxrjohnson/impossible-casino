// Real chip results over any other source. A dial the chip never ran stays with the source underneath.
import type { ChshPoint, ChshResult, GameExports, ResultSource } from './results';

export function withChipRuns(base: ResultSource, exports: GameExports, chipRunId = 'ibm-chip'): ResultSource {
  const { chsh } = exports;
  const run = chsh.runs.find((r) => r.id === chipRunId && r.provenance.source === 'ibm-chip');
  if (!run) return base;

  const pointAt = (dial: number): ChshPoint | undefined => {
    const snapped = base.snapDial(dial);
    return run.points.find((p) => p.dial === snapped);
  };

  return {
    dials: base.dials,
    limits: base.limits,
    snapDial: (value) => base.snapDial(value),
    previewProvenance: (dial) => (pointAt(dial) ? run.provenance : base.previewProvenance(dial)),
    previewWinRate: (dial) => pointAt(dial)?.winRate ?? base.previewWinRate(dial),
    async chsh(dial): Promise<ChshResult> {
      const point = pointAt(dial);
      if (!point) return base.chsh(dial);
      const circuits = chsh.logicalCircuits.find((c) => c.dial === point.dial);
      if (!circuits) throw new Error(`No circuits at dial ${point.dial}`);
      return {
        experiment: 'chsh',
        runId: run.id,
        dial: point.dial,
        winRate: point.winRate,
        outcomeOrder: chsh.outcomeOrder,
        pairs: point.pairs,
        circuits: circuits.pairs,
        provenance: run.provenance,
      };
    },
    wiesner: (length) => base.wiesner(length),
  };
}
