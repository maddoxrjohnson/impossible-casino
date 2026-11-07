import { describe, expect, it, vi } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import { createLiveSource } from './live';
import { createPrerunSource, parseChshExport, parseWiesnerExport, provenanceLabel, ticketSplit, type ChshPoint, type GameExports, type ResultSource } from './results';
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
/** Only the simulators, so these tests hold before and after a real chip run lands in the file. */
const bareWiesner = { ...wiesnerJson, runs: wiesnerJson.runs.filter((run) => run.provenance.source !== 'ibm-chip') };
const wiesner = parseWiesnerExport(bareWiesner);
const plain: GameExports = { chsh: parseChshExport(bare), wiesner };
const withChip: GameExports = {
  chsh: parseChshExport({ ...bare, runs: [...bare.runs, chipRun] }),
  wiesner,
};
const base = createPrerunSource(plain, 'ibm-noise-model');
const source = withChipRuns(createPrerunSource(withChip, 'ibm-noise-model'), withChip);
const WIESNER_JOB = 'd4forge';
const WIESNER_LABEL = `IBM chip ibm_kingston, job ${WIESNER_JOB}`;
const NOISE_ID = 'ibm-noise-model';

const wiesnerChipRun = {
  id: 'ibm-chip',
  provenance: { ...chipRun.provenance, jobId: WIESNER_JOB, qubits: [61, 42, 5, 48, 15, 21, 93, 62], shots: 1024 },
  ticketsPerPoint: 32,
  shotsPerTicket: 32,
  points: [{ length: 4, seed: 3000040000, shots: 1024, qubits: [61, 42, 5, 48], passes: 256, passRate: 0.25 }],
};
const wiesnerWithChip = parseWiesnerExport({ ...bareWiesner, runs: [...bareWiesner.runs, wiesnerChipRun] });
const forgeOnly: GameExports = { chsh: plain.chsh, wiesner: wiesnerWithChip };
const forgeSource = withChipRuns(createPrerunSource(forgeOnly, NOISE_ID), forgeOnly);

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

describe('withChipRuns in the Cage', () => {
  it('answers a chip length with the chip counts and label', async () => {
    const result = await forgeSource.wiesner(4);
    expect(result.runId).toBe('ibm-chip');
    expect(result.length).toBe(4);
    expect(result.shots).toBe(1024);
    expect(result.passes).toBe(256);
    expect(result.passRate).toBe(0.25);
    expect(result.qubits).toEqual([61, 42, 5, 48]);
    expect(provenanceLabel(result.provenance)).toBe(WIESNER_LABEL);
  });

  it('carries the exported payout and example circuit, and the ticket split', async () => {
    const result = await forgeSource.wiesner(4);
    const exported = wiesnerWithChip.logicalCircuits.find((c) => c.length === 4);
    expect(result.payout).toEqual(wiesnerWithChip.payouts.table.find((row) => row.length === 4));
    expect(result.circuit.qasm).toBe(exported?.qasm);
    expect(ticketSplit(result)).toBe('32 tickets × 32 shots');
  });

  it('never says a chip result used a fresh ticket every shot', async () => {
    const { circuitNote } = await forgeSource.wiesner(4);
    expect(wiesnerWithChip.logicalCircuitsNote).toMatch(/fresh ticket/);
    expect(circuitNote).not.toMatch(/fresh ticket|ideal run/);
    expect(circuitNote).toMatch(/example/);
    expect(circuitNote).toContain('32 random tickets');
    expect(circuitNote).toContain('3000040000');
  });

  it('leaves every other length with the base source, truly labelled', async () => {
    const result = await forgeSource.wiesner(3);
    expect(result).toEqual(await createPrerunSource(forgeOnly, NOISE_ID).wiesner(3));
    expect(provenanceLabel(result.provenance)).toBe(PRERUN_LABEL);
    expect(result.runId).toBe(NOISE_ID);
    expect(ticketSplit(result)).toBeNull();
  });

  it('never calls the base source for a chip length, so live cannot answer first', async () => {
    const wiesnerCall = vi.fn((length: number) => base.wiesner(length));
    const spied = withChipRuns({ ...base, wiesner: wiesnerCall }, forgeOnly);
    await spied.wiesner(4);
    expect(wiesnerCall).not.toHaveBeenCalled();
    await spied.wiesner(5);
    expect(wiesnerCall).toHaveBeenCalledOnce();
  });

  it('keeps the live label at a length the chip never ran', async () => {
    const live = createLiveSource(createPrerunSource(forgeOnly, NOISE_ID), { url: undefined });
    const running = vi.fn((length: number) => live.wiesner(length).then((r) => ({
      ...r,
      runId: 'live',
      provenance: { ...r.provenance, source: 'live-simulator' as const } as typeof r.provenance,
    })));
    const spied = withChipRuns({ ...live, wiesner: running }, forgeOnly);
    expect((await spied.wiesner(6)).provenance.source).toBe('live-simulator');
    expect((await spied.wiesner(4)).provenance.source).toBe('ibm-chip');
  });

  it('runs a Wiesner chip with no CHSH chip', async () => {
    expect(forgeSource.previewWinRate(CLEARS)).toBe(base.previewWinRate(CLEARS));
    expect(provenanceLabel(forgeSource.previewProvenance(CLEARS))).toBe(PRERUN_LABEL);
    expect(await forgeSource.chsh(CLEARS)).toEqual(await base.chsh(CLEARS));
    expect((await forgeSource.wiesner(4)).provenance.source).toBe('ibm-chip');
  });

  it('runs a CHSH chip with no Wiesner chip', async () => {
    expect((await source.chsh(CLEARS)).provenance.source).toBe('ibm-chip');
    expect((await source.wiesner(4)).provenance.source).toBe('pre-run-simulator');
  });

  it('keeps each chip run with its own job when both exist', async () => {
    const both: GameExports = { chsh: withChip.chsh, wiesner: wiesnerWithChip };
    const table = withChipRuns(createPrerunSource(both, NOISE_ID), both);
    expect(provenanceLabel((await table.chsh(CLEARS)).provenance)).toBe(CHIP_LABEL);
    expect(provenanceLabel((await table.wiesner(4)).provenance)).toBe(WIESNER_LABEL);
  });

  it('ignores a simulator run filed under the chip id in either export', async () => {
    const mislabelled: GameExports = {
      chsh: plain.chsh,
      wiesner: { ...plain.wiesner, runs: plain.wiesner.runs.map((r) => ({ ...r, id: r.id === 'ideal' ? 'ibm-chip' : r.id })) },
    };
    expect(withChipRuns(base, mislabelled)).toBe(base);
    const named = { ...forgeOnly, wiesner: { ...wiesnerWithChip, runs: wiesnerWithChip.runs.filter((r) => r.id !== 'ibm-chip') } };
    expect((await withChipRuns(base, named).wiesner(4)).provenance.source).toBe('pre-run-simulator');
  });

  it('keeps the Cage on its true source when only the CHSH chip run is real', async () => {
    const mixed: GameExports = {
      chsh: withChip.chsh,
      wiesner: { ...plain.wiesner, runs: plain.wiesner.runs.map((r) => ({ ...r, id: r.id === 'ideal' ? 'ibm-chip' : r.id })) },
    };
    const table = withChipRuns(createPrerunSource(mixed, NOISE_ID), mixed);
    expect(provenanceLabel((await table.chsh(CLEARS)).provenance)).toBe(CHIP_LABEL);
    const forge = await table.wiesner(4);
    expect(forge.runId).toBe(NOISE_ID);
    expect(provenanceLabel(forge.provenance)).toBe(PRERUN_LABEL);
    expect(ticketSplit(forge)).toBeNull();
  });
});

describe('a Wiesner chip run in an export', () => {
  const withoutField = (field: 'ticketsPerPoint' | 'shotsPerTicket') => {
    const run: Record<string, unknown> = { ...wiesnerChipRun };
    run[field] = undefined;
    return { ...bareWiesner, runs: [...bareWiesner.runs, run] };
  };

  it('parses with fewer points than the board, keeping its ticket split', () => {
    const run = wiesnerWithChip.runs.find((r) => r.id === 'ibm-chip');
    expect(run?.points.map((p) => p.length)).toEqual([4]);
    expect(run?.ticketsPerPoint).toBe(32);
    expect(run?.shotsPerTicket).toBe(32);
  });

  it('leaves simulators without a ticket split', () => {
    for (const run of plain.wiesner.runs) {
      expect(run).not.toHaveProperty('ticketsPerPoint');
      expect(run).not.toHaveProperty('shotsPerTicket');
      expect(ticketSplit(run)).toBeNull();
    }
  });

  it('refuses a chip run that does not say how its shots were split', () => {
    expect(() => parseWiesnerExport(withoutField('ticketsPerPoint'))).toThrow(/ticket/i);
    expect(() => parseWiesnerExport(withoutField('shotsPerTicket'))).toThrow(/ticket/i);
  });

  it('refuses a split that does not multiply out to the shots', () => {
    const raw = { ...bareWiesner, runs: [...bareWiesner.runs, { ...wiesnerChipRun, shotsPerTicket: 16 }] };
    expect(() => parseWiesnerExport(raw)).toThrow(/shots/);
  });

  it('refuses a chip run with no job id', () => {
    const noJob = { ...wiesnerChipRun, provenance: { ...wiesnerChipRun.provenance, jobId: null } };
    expect(() => parseWiesnerExport({ ...bareWiesner, runs: [...bareWiesner.runs, noJob] })).toThrow(/job id/);
  });

  it('never prints a split for a simulator, whatever fields it carries', () => {
    const run = bareWiesner.runs[1];
    if (!run) throw new Error('no simulator run');
    const fake = parseWiesnerExport({
      ...bareWiesner,
      runs: [bareWiesner.runs[0], { ...run, ticketsPerPoint: 8192, shotsPerTicket: 1 }],
    }).runs[1];
    expect(fake && ticketSplit(fake)).toBeNull();
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
