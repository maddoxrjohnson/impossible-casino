// Tests only: a made-up chip run in the shape the chip export writes, built from the committed noise-model run.
import rouletteJson from '../../public/data/roulette.v1.json';

export const FIXTURE_JOB_ID = 'test-job-not-real';
export const FIXTURE_LIMIT_SHOTS = 8192;
export const FIXTURE_OTHER_SHOTS = 512;
export const FIXTURE_EDGE = { bestReturn: 0.81, worstSpin: 0.93, clearChance: 0.19 } as const;

interface LoosePoint {
  draft: number[];
  seed: number | null;
  shots: number;
  counts: number[];
}

interface LooseRun {
  id: string;
  provenance: Record<string, unknown>;
  points: LoosePoint[];
}

export interface LooseRouletteJson extends Record<string, unknown> {
  runs: LooseRun[];
  edge: (Record<string, unknown> & { run: string; worstSpin: Record<string, unknown> })[];
  nodes: (Record<string, unknown> & { draft: number[]; turn: string; value: number })[];
  limits: { houseLimit: { value: number } } & Record<string, unknown>;
}

/** The counts cut down to `shots`, any remainder on the fullest pocket. */
function scaled(counts: readonly number[], from: number, shots: number): number[] {
  const out = counts.map((c) => Math.floor((c * shots) / from));
  const short = shots - out.reduce((sum, c) => sum + c, 0);
  const top = out.indexOf(Math.max(...out));
  out[top] = (out[top] ?? 0) + short;
  return out;
}

/** The committed export with a chip run and its edge entry added after the simulator runs. */
export function rouletteWithChip(): LooseRouletteJson {
  const raw = structuredClone(rouletteJson) as unknown as LooseRouletteJson;
  const noisy = raw.runs.find((r) => r.id === 'ibm-noise-model');
  const noisyEdge = raw.edge.find((e) => e.run === 'ibm-noise-model');
  if (!noisy || !noisyEdge) throw new Error('no noise-model run to copy');
  const limit = raw.limits.houseLimit.value;
  const atLimit = new Set(
    raw.nodes.filter((n) => n.turn === 'spin' && n.value >= limit - 1e-9).map((n) => n.draft.join(',')),
  );
  const run: LooseRun = {
    id: 'ibm-chip',
    provenance: {
      source: 'ibm-chip',
      backend: 'ibm_kingston',
      noiseModel: null,
      qubits: [50, 20, 21, 105, 117],
      qubitSelection: 'best-case pick: test qubits',
      shots: FIXTURE_LIMIT_SHOTS,
      qiskitVersion: '2.6.2',
      aerVersion: '0.18.2',
      runtimeVersion: '0.51.0',
      date: '2026-11-07',
      jobId: FIXTURE_JOB_ID,
    },
    points: noisy.points.map((p) => {
      const shots = atLimit.has(p.draft.join(',')) ? FIXTURE_LIMIT_SHOTS : FIXTURE_OTHER_SHOTS;
      return { draft: [...p.draft], seed: null, shots, counts: scaled(p.counts, p.shots, shots) };
    }),
  };
  raw.runs.push(run);
  raw.edge.push({
    ...structuredClone(noisyEdge),
    run: 'ibm-chip',
    bestReturn: FIXTURE_EDGE.bestReturn,
    worstSpin: { ...noisyEdge.worstSpin, return: FIXTURE_EDGE.worstSpin },
    clearChance: FIXTURE_EDGE.clearChance,
  });
  return raw;
}
