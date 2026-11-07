import { describe, expect, it } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import {
  COUNT_KEYS,
  createPrerunSource,
  drawPass,
  loadExports,
  parseChshExport,
  parseProvenance,
  parseWiesnerExport,
  provenanceLabel,
  sampleOutcome,
  type ChshExport,
  type ChshPair,
  type ChipProvenance,
  type Provenance,
  type SimulatorProvenance,
} from './results';
import { chshWin, type Bit } from './rules';

interface LooseRun {
  id: string;
  provenance: Record<string, unknown>;
  points: Record<string, unknown>[];
}
interface LooseChsh extends Record<string, unknown> {
  runs: (Omit<LooseRun, 'points'> & {
    points: { dial: number; pairs: { shots: number; counts: Record<string, number> }[] }[];
  })[];
  logicalCircuits: { pairs: unknown[] }[];
}
interface LooseWiesner extends Record<string, unknown> {
  runs: (Omit<LooseRun, 'points'> & {
    points: { length: number; passes: number; shots: number }[];
  })[];
  logicalCircuits: unknown[];
}

function looseChsh(): LooseChsh {
  return structuredClone(chshJson);
}

function looseWiesner(): LooseWiesner {
  return structuredClone(wiesnerJson);
}

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const chsh = parseChshExport(chshJson);
const wiesner = parseWiesnerExport(wiesnerJson);
const exports = { chsh, wiesner };
const ideal = createPrerunSource(exports, 'ideal');
const noisy = createPrerunSource(exports, 'ibm-noise-model');

function bit(char: string | undefined): Bit {
  return char === '1' ? 1 : 0;
}

function winRateFromCounts(pair: ChshPair): number {
  let wins = 0;
  for (const key of COUNT_KEYS) {
    const a = bit(key[1]);
    const b = bit(key[0]);
    if (chshWin(pair.x, pair.y, a, b)) wins += pair.counts[key];
  }
  return wins / pair.shots;
}

const simulator: SimulatorProvenance = {
  source: 'pre-run-simulator',
  backend: 'aer_simulator',
  noiseModel: null,
  qubits: null,
  shots: 8192,
  qiskitVersion: '2.6.2',
  aerVersion: '0.18.2',
  runtimeVersion: '0.51.0',
  date: '2026-11-07',
  jobId: null,
};

describe('parsers', () => {
  it('accept both real exports', () => {
    expect(chsh.runs.map((r) => r.id)).toEqual(['ideal', 'ibm-noise-model']);
    expect(chsh.runs[0]?.points).toHaveLength(33);
    expect(wiesner.runs.map((r) => r.id)).toEqual(['ideal', 'ibm-noise-model']);
    expect(wiesner.runs[0]?.points).toHaveLength(8);
  });

  it('keeps the noise model scope and null qubits', () => {
    expect(wiesner.runs[1]?.provenance.noiseModel?.scope).toContain('gate and readout');
    expect(wiesner.runs[0]?.points[0]?.qubits).toBeNull();
    expect(wiesner.runs[1]?.points[1]?.qubits).toEqual([50, 148]);
  });

  it('accepts a sparse run, because real-chip runs will be', () => {
    const bad = looseChsh();
    bad.runs[0]?.points.splice(1);
    expect(parseChshExport(bad).runs[0]?.points).toHaveLength(1);
  });

  it.each<[string, (d: LooseChsh) => void, RegExp]>([
    ['bad version', (d) => (d.schemaVersion = 2), /schemaVersion/],
    ['wrong experiment', (d) => (d.experiment = 'wiesner'), /experiment/],
    ['unknown outcome order', (d) => (d.outcomeOrder = 'ab'), /outcomeOrder/],
    ['no runs', (d) => (d.runs = []), /runs/],
    ['no points', (d) => (d.runs[0]!.points = []), /points/],
    ['three pairs', (d) => d.runs[0]!.points[0]!.pairs.pop(), /pairs/],
    [
      'a repeated pair',
      (d) => {
        const pairs = d.runs[0]!.points[0]!.pairs;
        pairs[1] = pairs[0]!;
      },
      /pairs/,
    ],
    ['counts not summing', (d) => (d.runs[0]!.points[0]!.pairs[0]!.counts['00']! += 1), /shots/],
    ['a negative count', (d) => (d.runs[0]!.points[0]!.pairs[0]!.counts['00'] = -1), /counts/],
    ['a fractional count', (d) => (d.runs[0]!.points[0]!.pairs[0]!.counts['00'] = 0.5), /counts/],
    [
      'a missing count key',
      (d) => {
        const counts = d.runs[0]!.points[0]!.pairs[0]!.counts;
        counts['xx'] = counts['00']!;
        Reflect.deleteProperty(counts, '00');
      },
      /counts/,
    ],
    ['an extra count key', (d) => (d.runs[0]!.points[0]!.pairs[0]!.counts['22'] = 0), /counts/],
    ['unknown source', (d) => (d.runs[0]!.provenance.source = 'vibes'), /source/],
    ['simulator with a job id', (d) => (d.runs[0]!.provenance.jobId = 'abc'), /jobId/],
    [
      'chip without a job id',
      (d) => {
        d.runs[0]!.provenance.source = 'ibm-chip';
      },
      /jobId/,
    ],
    [
      'chip with an empty job id',
      (d) => {
        d.runs[0]!.provenance.source = 'ibm-chip';
        d.runs[0]!.provenance.jobId = ' ';
      },
      /jobId/,
    ],
    [
      'chip with a noise model',
      (d) => {
        d.runs[1]!.provenance.source = 'ibm-chip';
        d.runs[1]!.provenance.jobId = 'abc';
      },
      /noiseModel/,
    ],
    [
      'chip on a simulator backend',
      (d) => {
        d.runs[0]!.provenance.source = 'ibm-chip';
        d.runs[0]!.provenance.jobId = 'abc';
      },
      /backend/,
    ],
    ['simulator on a chip backend', (d) => (d.runs[0]!.provenance.backend = 'ibm_kingston'), /backend/],
    ['a live source in an export', (d) => (d.runs[0]!.provenance.source = 'live-simulator'), /source/],
    ['a point with no circuits', (d) => d.logicalCircuits.splice(0, 1), /circuit/],
    ['a duplicate dial', (d) => (d.runs[0]!.points[1]!.dial = 0), /duplicates/],
    ['a duplicate run id', (d) => (d.runs[1]!.id = 'ideal'), /duplicates/],
    ['a dial out of range', (d) => (d.runs[0]!.points[0]!.dial = 1.5), /dial/],
  ])('rejects chsh with %s', (_name, spoil, message) => {
    const bad = looseChsh();
    spoil(bad);
    expect(() => parseChshExport(bad)).toThrow(message);
  });

  it.each<[string, (d: LooseWiesner) => void, RegExp]>([
    ['bad version', (d) => (d.schemaVersion = 0), /schemaVersion/],
    ['wrong experiment', (d) => (d.experiment = 'chsh'), /experiment/],
    ['no points', (d) => (d.runs[0]!.points = []), /points/],
    ['passes over shots', (d) => (d.runs[0]!.points[0]!.passes = 8193), /passes/],
    ['negative passes', (d) => (d.runs[0]!.points[0]!.passes = -1), /passes/],
    ['unknown source', (d) => (d.runs[0]!.provenance.source = 'vibes'), /source/],
    ['simulator with a job id', (d) => (d.runs[0]!.provenance.jobId = 'abc'), /jobId/],
    [
      'chip on a simulator backend',
      (d) => {
        d.runs[0]!.provenance.source = 'ibm-chip';
        d.runs[0]!.provenance.jobId = 'abc';
      },
      /backend/,
    ],
    ['simulator on a chip backend', (d) => (d.runs[0]!.provenance.backend = 'ibm_kingston'), /backend/],
    ['a live source in an export', (d) => (d.runs[0]!.provenance.source = 'live-simulator'), /source/],
    ['a duplicate length', (d) => (d.runs[0]!.points[1]!.length = 1), /duplicates/],
    ['a duplicate run id', (d) => (d.runs[1]!.id = 'ideal'), /duplicates/],
    ['a point with no circuit', (d) => d.logicalCircuits.splice(0, 1), /circuit/],
    [
      'a point with no payout',
      (d) => {
        (d.payouts as { table: unknown[] }).table.splice(0, 1);
      },
      /payout/,
    ],
  ])('rejects wiesner with %s', (_name, spoil, message) => {
    const bad = looseWiesner();
    spoil(bad);
    expect(() => parseWiesnerExport(bad)).toThrow(message);
  });

  it('accepts a chip run that carries a job id and no noise model', () => {
    const good = looseChsh();
    good.runs[0]!.provenance.source = 'ibm-chip';
    good.runs[0]!.provenance.backend = 'ibm_kingston';
    good.runs[0]!.provenance.jobId = 'd1abc';
    expect(parseChshExport(good).runs[0]?.provenance.jobId).toBe('d1abc');
  });

  it('keeps a noisy simulator backend named after its snapshot', () => {
    expect(chsh.runs[1]?.provenance.backend).toBe('aer_simulator_from(fake_kingston)');
    expect(wiesner.runs[1]?.provenance.backend).toBe('aer_simulator_from(fake_kingston)');
  });

  it.each([null, 3, 'x', []])('rejects %j as a chsh export', (raw) => {
    expect(() => parseChshExport(raw)).toThrow(Error);
  });
});

describe('parseProvenance', () => {
  it('accepts a live simulator, which only a live source returns', () => {
    const live = parseProvenance({ ...simulator, source: 'live-simulator' });
    expect(live.source).toBe('live-simulator');
    expect(provenanceLabel(live)).toBe('Live Qiskit simulator');
  });

  it('applies the honesty checks to a live simulator too', () => {
    const raw = { ...simulator, source: 'live-simulator' };
    expect(() => parseProvenance({ ...raw, jobId: 'abc' })).toThrow(/jobId/);
    expect(() => parseProvenance({ ...raw, backend: 'ibm_kingston' })).toThrow(/backend/);
  });

  it('accepts a chip backend only in the ibm_ form', () => {
    const chip = { ...simulator, source: 'ibm-chip', jobId: 'abc' };
    expect(parseProvenance({ ...chip, backend: 'ibm_kingston' }).jobId).toBe('abc');
    for (const backend of ['aer_simulator', 'ibm_', 'IBM_KINGSTON', 'fake_kingston']) {
      expect(() => parseProvenance({ ...chip, backend })).toThrow(/backend/);
    }
  });
});

describe('the exports read through the game rules', () => {
  it('agree with chshWin on every pair of every point', () => {
    for (const run of chsh.runs) {
      for (const point of run.points) {
        for (const pair of point.pairs) {
          expect(winRateFromCounts(pair)).toBeCloseTo(pair.winRate, 12);
        }
      }
    }
  });

  it('peaks over break-even and under the Qiskit limit plus shot noise', () => {
    for (const source of [ideal, noisy]) {
      const peak = Math.max(...source.dials.map((d) => source.previewWinRate(d)));
      expect(peak).toBeGreaterThan(0.8);
      expect(peak).toBeLessThan(chsh.limits.quantum.value + 0.01);
    }
  });

  it('passes the limits through unchanged', () => {
    expect(ideal.limits.quantum).toBe(chshJson.limits.quantum.value);
    expect(ideal.limits.classical).toBe(chshJson.limits.classical.value);
  });
});

describe('sampleOutcome', () => {
  const pairAt = (x: Bit, y: Bit, counts: ChshPair['counts']): ChshPair => ({
    x,
    y,
    shots: 8,
    winRate: 0,
    counts,
  });

  it('reads the first key character as b and the second as a', () => {
    const pair = pairAt(0, 0, { '00': 0, '01': 8, '10': 0, '11': 0 });
    expect(sampleOutcome(pair, () => 0.5)).toEqual({ a: 1, b: 0 });
    const flipped = pairAt(0, 0, { '00': 0, '01': 0, '10': 8, '11': 0 });
    expect(sampleOutcome(flipped, () => 0.5)).toEqual({ a: 0, b: 1 });
  });

  it('never returns an outcome with no counts', () => {
    const pair = pairAt(1, 1, { '00': 0, '01': 0, '10': 0, '11': 8 });
    expect(sampleOutcome(pair, () => 0)).toEqual({ a: 1, b: 1 });
    expect(sampleOutcome(pair, () => 0.999999)).toEqual({ a: 1, b: 1 });
  });

  it('lands near the exported rate over many draws', async () => {
    const result = await ideal.chsh(0.5);
    const rng = seeded(11);
    for (const pair of result.pairs) {
      let wins = 0;
      const draws = 20000;
      for (let i = 0; i < draws; i += 1) {
        const { a, b } = sampleOutcome(pair, rng);
        if (chshWin(pair.x, pair.y, a, b)) wins += 1;
      }
      expect(Math.abs(wins / draws - pair.winRate)).toBeLessThan(0.01);
    }
  });
});

describe('drawPass', () => {
  it('lands near the exported pass rate', async () => {
    const result = await noisy.wiesner(3);
    const rng = seeded(12);
    let passes = 0;
    const draws = 20000;
    for (let i = 0; i < draws; i += 1) if (drawPass(result, rng)) passes += 1;
    expect(Math.abs(passes / draws - result.passRate)).toBeLessThan(0.01);
  });

  it('respects the ends of the range', () => {
    expect(drawPass({ passes: 0, shots: 10 }, () => 0)).toBe(false);
    expect(drawPass({ passes: 10, shots: 10 }, () => 0.999999)).toBe(true);
  });
});

describe('snapDial', () => {
  it('clamps', () => {
    expect(ideal.snapDial(-3)).toBe(0);
    expect(ideal.snapDial(7)).toBe(1);
  });

  it('finds the nearest grid dial', () => {
    expect(ideal.snapDial(0.14)).toBe(0.125);
    expect(ideal.snapDial(0.5)).toBe(0.5);
    expect(ideal.snapDial(0.51)).toBe(0.5);
  });

  it('breaks ties to the lower index', () => {
    expect(ideal.snapDial(1 / 64)).toBe(0);
    expect(ideal.snapDial(3 / 64)).toBe(1 / 32);
  });

  it('maps non-finite input to the first dial', () => {
    expect(ideal.snapDial(Number.NaN)).toBe(0);
    expect(ideal.snapDial(Number.POSITIVE_INFINITY)).toBe(0);
    expect(ideal.snapDial(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  it('works on a sparse, unordered run', () => {
    const sparse = looseChsh();
    const points = sparse.runs[0]!.points;
    sparse.runs[0]!.points = [points[24]!, points[8]!];
    const source = createPrerunSource(
      { chsh: parseChshExport(sparse), wiesner },
      'ideal',
    );
    expect(source.dials).toEqual([0.25, 0.75]);
    expect(source.snapDial(0.5)).toBe(0.25);
    expect(source.snapDial(0.9)).toBe(0.75);
  });
});

describe('previewWinRate', () => {
  it('says where the preview rates come from', () => {
    expect(ideal.previewProvenance).toBe(chsh.runs[0]?.provenance);
  });

  it('is a lookup of the exported win rate and snaps its input', () => {
    expect(ideal.previewWinRate(0.5)).toBe(chsh.runs[0]?.points[16]?.winRate);
    expect(ideal.previewWinRate(0.51)).toBe(ideal.previewWinRate(0.5));
  });
});

describe('provenanceLabel', () => {
  it('labels a pre-run simulator', () => {
    expect(provenanceLabel(simulator)).toBe('Pre-run Qiskit simulator');
  });

  it('names the noise model on a noisy run', () => {
    const label = provenanceLabel(chsh.runs[1]!.provenance);
    expect(label).toBe('Pre-run Qiskit simulator, fake_kingston noise model');
  });

  it('labels a live simulator', () => {
    expect(provenanceLabel({ ...simulator, source: 'live-simulator' })).toBe(
      'Live Qiskit simulator',
    );
  });

  it('never says chip on a simulator', () => {
    for (const run of [...chsh.runs, ...wiesner.runs]) {
      expect(provenanceLabel(run.provenance).toLowerCase()).not.toContain('chip');
    }
    const live: Provenance = { ...simulator, source: 'live-simulator' };
    expect(provenanceLabel(live).toLowerCase()).not.toContain('chip');
  });

  it('holds the backend and job id on a chip run', () => {
    const chip: ChipProvenance = {
      ...simulator,
      source: 'ibm-chip',
      backend: 'ibm_kingston',
      noiseModel: null,
      jobId: 'd1abc',
    };
    expect(provenanceLabel(chip)).toBe('IBM chip ibm_kingston, job d1abc');
  });
});

describe('createPrerunSource', () => {
  it('throws on an unknown run id', () => {
    expect(() => createPrerunSource(exports, 'nope')).toThrow(/nope/);
  });

  it('throws when the run exists for only one experiment', () => {
    const lopsided: ChshExport = { ...chsh, runs: [chsh.runs[0]!] };
    expect(() =>
      createPrerunSource({ chsh: lopsided, wiesner }, 'ibm-noise-model'),
    ).toThrow(/ibm-noise-model/);
  });

  it("takes dials from the run's points", () => {
    expect(ideal.dials).toHaveLength(33);
    expect(ideal.dials[0]).toBe(0);
    expect(ideal.dials[32]).toBe(1);
  });

  it("carries the run's provenance and the circuits for its dial", async () => {
    const result = await noisy.chsh(0.5);
    const circuits = chsh.logicalCircuits.find((c) => c.dial === 0.5)?.pairs;
    expect(result.experiment).toBe('chsh');
    expect(result.runId).toBe('ibm-noise-model');
    expect(result.dial).toBe(0.5);
    expect(result.outcomeOrder).toBe('ba');
    expect(result.provenance).toEqual(chsh.runs[1]?.provenance);
    expect(result.circuits).toEqual(circuits);
    expect(result.pairs).toHaveLength(4);
    expect(result.winRate).toBe(chsh.runs[1]?.points[16]?.winRate);
  });

  it('snaps the dial it is asked for', async () => {
    expect((await ideal.chsh(0.51)).dial).toBe(0.5);
  });

  it('gives the noisy run its own numbers', async () => {
    const clean = await ideal.chsh(0.5);
    const rough = await noisy.chsh(0.5);
    expect(rough.winRate).not.toBe(clean.winRate);
    expect(rough.pairs).not.toEqual(clean.pairs);
    expect((await noisy.wiesner(1)).passes).not.toBe((await ideal.wiesner(1)).passes);
  });

  it('builds a Wiesner result from the export', async () => {
    const result = await noisy.wiesner(3);
    const point = wiesner.runs[1]?.points[2];
    expect(result).toMatchObject({
      experiment: 'wiesner',
      runId: 'ibm-noise-model',
      length: 3,
      shots: point?.shots,
      passes: point?.passes,
      passRate: point?.passRate,
      qubits: [50, 148, 21],
      circuitNote: wiesner.logicalCircuitsNote,
    });
    expect(result.payout.pays).toBe(125);
    expect(result.provenance).toEqual(wiesner.runs[1]?.provenance);
    expect(result.circuit.ticket.bits).toEqual([0, 1, 0]);
    expect(result.circuit.qasm).toBe(wiesner.logicalCircuits[2]?.qasm);
  });

  it('rejects a Wiesner length with no point', async () => {
    await expect(ideal.wiesner(9)).rejects.toThrow(/9/);
  });
});

describe('loadExports', () => {
  const body = (url: string): unknown => (url.includes('chsh') ? chshJson : wiesnerJson);

  it('fetches and parses both files under the base path', async () => {
    const urls: string[] = [];
    const fetchFn = (url: string) => {
      urls.push(url);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body(url)) });
    };
    const loaded = await loadExports(fetchFn, '/casino/');
    expect(urls.sort()).toEqual(['/casino/data/chsh.v1.json', '/casino/data/wiesner.v1.json']);
    expect(loaded.chsh.experiment).toBe('chsh');
    expect(loaded.wiesner.experiment).toBe('wiesner');
  });

  it('throws on a response that is not OK', async () => {
    const fetchFn = () =>
      Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    await expect(loadExports(fetchFn, '/')).rejects.toThrow(/404/);
  });

  it('throws on a body that fails validation', async () => {
    const fetchFn = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    await expect(loadExports(fetchFn, '/')).rejects.toThrow(/schemaVersion/);
  });
});
