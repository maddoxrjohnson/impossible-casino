import { describe, expect, it, vi } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import { createLiveSource } from './live';
import { createPrerunSource, parseChshExport, parseWiesnerExport, provenanceLabel, type ChshPoint, type GameExports, type ResultSource } from './results';
import { BREAK_EVEN } from './rules';
import { writeSave } from './save';
import { createGameStore, type GameStore } from './store';
import { withChipRuns } from './chip';
import { sourceLine } from '../ui/table';

const QUBIT_SELECTION = 'best-case pick: a test coupler';
const JOB = 'd4example';
const CHIP_LABEL = `IBM chip ibm_kingston, job ${JOB}`;
const PRERUN_LABEL = 'Pre-run Qiskit simulator, fake_kingston noise model';

/** A pair's counts with `wins` of its 4,096 shots on the winning answers. */
function chipPair(x: 0 | 1, y: 0 | 1, wins: number) {
  const losses = 4096 - wins;
  const counts = x === 1 && y === 1
    ? { '00': 0, '01': wins, '10': 0, '11': losses }
    : { '00': wins, '01': losses, '10': 0, '11': 0 };
  return { x, y, shots: 4096, winRate: wins / 4096, counts };
}

function chipPoint(dial: number, wins: number) {
  const pairs = [chipPair(0, 0, wins), chipPair(0, 1, wins), chipPair(1, 0, wins), chipPair(1, 1, wins)];
  return { dial, seed: 20261107, winRate: wins / 4096, pairs };
}

const chipRun = {
  id: 'ibm-chip',
  provenance: {
    source: 'ibm-chip',
    backend: 'ibm_kingston',
    noiseModel: null,
    qubits: [61, 62],
    qubitSelection: QUBIT_SELECTION,
    shots: 4096,
    qiskitVersion: '2.6.2',
    aerVersion: '0.18.2',
    runtimeVersion: '0.51.0',
    date: '2026-11-07',
    jobId: JOB,
  },
  points: [chipPoint(0.25, 2800), chipPoint(0.5, 3400)],
};

/** Only the simulators, so these tests hold before and after a real chip run lands in the file. */
const bare = { ...chshJson, runs: chshJson.runs.filter((run) => run.provenance.source !== 'ibm-chip') };
const wiesner = parseWiesnerExport(wiesnerJson);
const plain: GameExports = { chsh: parseChshExport(bare), wiesner };
const withChip: GameExports = {
  chsh: parseChshExport({ ...bare, runs: [...bare.runs, chipRun] }),
  wiesner,
};
const base = createPrerunSource(plain, 'ibm-noise-model');
const source = withChipRuns(createPrerunSource(withChip, 'ibm-noise-model'), withChip);
const CLEARS = 0.5;
const SHORT = 0.25;
const OFF_CHIP = 0.53125;

function tableAt(table: ResultSource, dial: number, rng = () => 0.5): GameStore {
  const saved = new Map<string, string>();
  const storage = {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => {
      saved.set(key, value);
    },
  };
  writeSave(storage, { version: 1, bankroll: 1_000_000, phase: 'entangled', dial, stake: 100, cleared: [] });
  return createGameStore({ source: table, storage, handMs: 0, rng });
}

function shown(store: GameStore, table: ResultSource) {
  return sourceLine(store.state, table.previewProvenance(store.state.dial));
}

describe('the chip run in an export', () => {
  it('parses with fewer points than the dial grid', () => {
    const run = withChip.chsh.runs.find((r) => r.id === 'ibm-chip');
    expect(run?.points.map((p) => p.dial)).toEqual([0.25, 0.5]);
    expect(run?.provenance.qubitSelection).toBe(QUBIT_SELECTION);
  });

  it('refuses a chip run that does not say how its qubits were picked', () => {
    const silent = { ...chipRun.provenance, qubitSelection: undefined };
    const raw = { ...bare, runs: [...bare.runs, { ...chipRun, provenance: silent }] };
    expect(() => parseChshExport(raw)).toThrow(/qubitSelection/);
  });

  it('refuses a point at a dial with no logical circuit', () => {
    const raw = { ...bare, runs: [...bare.runs, { ...chipRun, points: [chipPoint(0.51, 3400)] }] };
    expect(() => parseChshExport(raw)).toThrow(/logical circuit/);
  });
});

describe('withChipRuns', () => {
  it('is the base source when the export has no chip run', () => {
    const live = createLiveSource(base, { url: undefined });
    expect(withChipRuns(live, plain)).toBe(live);
  });

  it('ignores a simulator run filed under the chip id', () => {
    const mislabelled = {
      ...plain,
      chsh: { ...plain.chsh, runs: plain.chsh.runs.map((r) => ({ ...r, id: r.id === 'ideal' ? 'ibm-chip' : r.id })) },
    };
    expect(withChipRuns(base, mislabelled)).toBe(base);
  });

  it('keeps all 33 dial positions', () => {
    expect(source.dials).toEqual(base.dials);
    expect(source.dials).toHaveLength(33);
    expect(source.limits).toEqual(base.limits);
    expect(source.snapDial(0.51)).toBe(base.snapDial(0.51));
  });

  it('answers a chip dial with the chip counts, label and logical circuits', async () => {
    const result = await source.chsh(CLEARS);
    const point = chipRun.points[1] as ChshPoint;
    expect(result.runId).toBe('ibm-chip');
    expect(result.dial).toBe(CLEARS);
    expect(result.winRate).toBe(point.winRate);
    expect(result.pairs).toEqual(point.pairs);
    expect(result.outcomeOrder).toBe('ba');
    expect(provenanceLabel(result.provenance)).toBe(CHIP_LABEL);
    expect(result.circuits).toEqual(withChip.chsh.logicalCircuits.find((c) => c.dial === CLEARS)?.pairs);
  });

  it('snaps first, so a value near a chip dial still gets the chip', async () => {
    expect(source.snapDial(0.507)).toBe(CLEARS);
    expect(source.previewWinRate(0.507)).toBe(3400 / 4096);
    expect((await source.chsh(0.507)).dial).toBe(CLEARS);
  });

  it('previews a chip dial from the chip', () => {
    expect(source.previewWinRate(CLEARS)).toBe(3400 / 4096);
    expect(provenanceLabel(source.previewProvenance(CLEARS))).toBe(CHIP_LABEL);
  });

  it('leaves every other dial with the base source', async () => {
    expect(source.previewWinRate(OFF_CHIP)).toBe(base.previewWinRate(OFF_CHIP));
    expect(provenanceLabel(source.previewProvenance(OFF_CHIP))).toBe(PRERUN_LABEL);
    expect(await source.chsh(OFF_CHIP)).toEqual(await base.chsh(OFF_CHIP));
  });

  it('never calls the base source for a chip result, so live cannot answer first', async () => {
    const chsh = vi.fn((dial: number) => base.chsh(dial));
    const spied = withChipRuns({ ...base, chsh }, withChip);
    await spied.chsh(CLEARS);
    expect(chsh).not.toHaveBeenCalled();
    await spied.chsh(OFF_CHIP);
    expect(chsh).toHaveBeenCalledOnce();
  });

  it('leaves the Cage with the base source', async () => {
    const wiesnerCall = vi.fn((length: number) => base.wiesner(length));
    const spied = withChipRuns({ ...base, wiesner: wiesnerCall }, withChip);
    expect(await spied.wiesner(3)).toEqual(await base.wiesner(3));
    expect(wiesnerCall).toHaveBeenCalledWith(3);
  });
});

describe('the store on mixed sources', () => {
  it('plays a chip dial on chip counts and passes its dial check', async () => {
    const store = tableAt(source, CLEARS);
    await store.run(1);
    expect(store.state.rounds).toBe(1);
    expect(store.state.result?.provenance.jobId).toBe(JOB);
    store.dispose();
  });

  it('shows the chip rate as the target, in a saved game and on a dial turn', () => {
    const store = tableAt(source, CLEARS);
    expect(store.state.target).toBe(3400 / 4096);
    store.setDial(SHORT);
    expect(store.state.target).toBe(2800 / 4096);
    store.setDial(OFF_CHIP);
    expect(store.state.target).toBe(base.previewWinRate(OFF_CHIP));
    store.dispose();
  });

  it('clears the tables at a chip dial above break-even', async () => {
    expect(source.previewWinRate(CLEARS)).toBeGreaterThan(BREAK_EVEN);
    const store = tableAt(source, CLEARS, () => 0);
    await store.run();
    expect(store.state.phase).toBe('beyond');
    store.dispose();
  });

  it('does not clear them at a chip dial under break-even, however the hands fall', async () => {
    expect(source.previewWinRate(SHORT)).toBeLessThanOrEqual(BREAK_EVEN);
    const store = tableAt(source, SHORT, () => 0);
    await store.run();
    expect(store.state.winRate).toBeGreaterThan(BREAK_EVEN);
    expect(store.state.phase).toBe('entangled');
    store.dispose();
  });
});

describe('the source line on mixed sources', () => {
  it('names the chip before a run at a chip dial, and the simulator elsewhere', () => {
    const store = tableAt(source, CLEARS);
    expect(shown(store, source)).toBe(`Source: ${CHIP_LABEL}`);
    store.setDial(OFF_CHIP);
    expect(shown(store, source)).toBe(`Source: ${PRERUN_LABEL}`);
    store.dispose();
  });

  it('keeps chip hands labelled after the dial turns to a simulated preview', async () => {
    const store = tableAt(source, CLEARS);
    await store.run(1);
    expect(shown(store, source)).toBe(`Source: ${CHIP_LABEL}`);
    store.setDial(OFF_CHIP);
    expect(shown(store, source)).toBe(`Odds source: ${PRERUN_LABEL} · Last run source: ${CHIP_LABEL}`);
    store.dispose();
  });

  it('never lets simulated hands sit under a chip label alone', async () => {
    const store = tableAt(source, OFF_CHIP);
    await store.run(1);
    expect(shown(store, source)).toBe(`Source: ${PRERUN_LABEL}`);
    store.setDial(CLEARS);
    expect(shown(store, source)).toBe(`Odds source: ${CHIP_LABEL} · Last run source: ${PRERUN_LABEL}`);
    store.dispose();
  });

  it('goes back to one source once the next run starts', async () => {
    const store = tableAt(source, OFF_CHIP);
    await store.run(1);
    store.setDial(CLEARS);
    await store.run(1);
    expect(shown(store, source)).toBe(`Source: ${CHIP_LABEL}`);
    store.dispose();
  });
});
