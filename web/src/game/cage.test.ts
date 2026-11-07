import { describe, expect, it, vi } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import { cageBoard, clearsCage, forgeWin, settleForge } from './cage';
import { createPrerunSource, parseChshExport, parseWiesnerExport } from './results';
import { CAGE_CLEAR_LENGTH, FORGE_LENGTHS, STAKES, isForgeLength } from './rules';

/** Only the simulators, so these tests hold before and after a real chip run lands in the file. */
const bareWiesner = { ...wiesnerJson, runs: wiesnerJson.runs.filter((run) => run.provenance.source !== 'ibm-chip') };
const wiesner = parseWiesnerExport(bareWiesner);
const exports = { chsh: parseChshExport(chshJson), wiesner };
const source = createPrerunSource(exports, 'ibm-noise-model');

const chipRun = {
  id: 'ibm-chip',
  provenance: {
    source: 'ibm-chip',
    backend: 'ibm_kingston',
    noiseModel: null,
    qubits: [61, 42, 5, 48, 15, 21, 93, 62],
    qubitSelection: 'best-case pick: test qubits',
    shots: 1024,
    qiskitVersion: '2.6.2',
    aerVersion: '0.18.2',
    runtimeVersion: '0.51.0',
    date: '2026-11-07',
    jobId: 'd4forge',
  },
  ticketsPerPoint: 32,
  shotsPerTicket: 32,
  points: [{ length: 4, seed: 3000040000, shots: 1024, qubits: [61, 42, 5, 48], passes: 256, passRate: 0.25 }],
};
const withChip = parseWiesnerExport({ ...bareWiesner, runs: [...bareWiesner.runs, chipRun] });

describe('forge lengths', () => {
  it('covers every length the export carries', () => {
    expect([...FORGE_LENGTHS]).toEqual(wiesner.payouts.table.map((row) => row.length));
  });

  it('accepts only those lengths', () => {
    expect(isForgeLength(1)).toBe(true);
    expect(isForgeLength(8)).toBe(true);
    for (const bad of [0, 9, 1.5, -1, Number.NaN, '4', null]) expect(isForgeLength(bad)).toBe(false);
  });

  it('keeps the clearing length on the board', () => {
    expect(isForgeLength(CAGE_CLEAR_LENGTH)).toBe(true);
  });
});

describe('cageBoard', () => {
  it('reads each row from the named run, the proven limits and the pay table', () => {
    const { rows } = cageBoard(wiesner, 'ibm-noise-model');
    const run = wiesner.runs.find((r) => r.id === 'ibm-noise-model');
    expect(rows.map((row) => row.length)).toEqual([...FORGE_LENGTHS]);
    rows.forEach((row) => {
      expect(row.passRate).toBe(run?.points.find((p) => p.length === row.length)?.passRate);
      expect(row.limit).toBe(wiesner.limits.byLength.find((l) => l.length === row.length)?.value);
      expect(row.pays).toBe(wiesner.payouts.table.find((p) => p.length === row.length)?.pays);
    });
  });

  it('follows the run it was given', () => {
    const ideal = cageBoard(wiesner, 'ideal');
    const noisy = cageBoard(wiesner, 'ibm-noise-model');
    expect(ideal.rows.map((r) => r.passRate)).not.toEqual(noisy.rows.map((r) => r.passRate));
    expect(ideal.provenance).toBe(wiesner.runs.find((r) => r.id === 'ideal')?.provenance);
    expect(noisy.provenance).toBe(wiesner.runs.find((r) => r.id === 'ibm-noise-model')?.provenance);
  });

  it('carries the stake the pay table is quoted on', () => {
    expect(cageBoard(wiesner, 'ideal').payoutStake).toBe(wiesner.payouts.stake);
  });

  it('refuses an unknown run or a length with no limit', () => {
    expect(() => cageBoard(wiesner, 'nope')).toThrow(/nope/);
    const short = { ...wiesner, limits: { ...wiesner.limits, byLength: wiesner.limits.byLength.slice(1) } };
    expect(() => cageBoard(short, 'ideal')).toThrow(/length 1/);
  });
});

describe('cageBoard with a chip run', () => {
  const board = cageBoard(withChip, 'ibm-noise-model');
  const noisy = cageBoard(wiesner, 'ibm-noise-model');

  it('reads the chip rate at the length the chip ran, against the proven limit', () => {
    const row = board.rows.find((r) => r.length === 4);
    expect(row?.passRate).toBe(0.25);
    expect(row?.onChip).toBe(true);
    expect(row?.limit).toBe(wiesner.limits.byLength.find((l) => l.length === 4)?.value);
    expect(row?.pays).toBe(wiesner.payouts.table.find((p) => p.length === 4)?.pays);
  });

  it('keeps every other length on the board run, unblended', () => {
    board.rows.filter((r) => r.length !== 4).forEach((row, i) => {
      const plain = noisy.rows.filter((r) => r.length !== 4)[i];
      expect(row.passRate).toBe(plain?.passRate);
      expect(row.onChip).toBe(false);
    });
  });

  it('keeps the run it was given as the provenance, and names the chip run apart', () => {
    expect(board.provenance).toEqual(noisy.provenance);
    expect(board.chip?.provenance.source).toBe('ibm-chip');
  });

  it('has no chip when the export has none, or only a simulator under the chip id', () => {
    expect(noisy.chip).toBeNull();
    expect(noisy.rows.some((row) => row.onChip)).toBe(false);
    const mislabelled = { ...wiesner, runs: wiesner.runs.map((r) => ({ ...r, id: r.id === 'ideal' ? 'ibm-chip' : r.id })) };
    const board = cageBoard(mislabelled, 'ibm-noise-model');
    expect(board.chip).toBeNull();
    expect(board.rows.some((row) => row.onChip)).toBe(false);
  });
});

describe('forgeWin', () => {
  it('scales the exported net profit to the stake', () => {
    expect(forgeWin(25, 100, 100)).toBe(25);
    expect(forgeWin(25, 200, 100)).toBe(50);
    expect(forgeWin(845, 1000, 100)).toBe(8450);
  });

  it('pays whole chips at every stake and length', () => {
    for (const { pays } of wiesner.payouts.table) {
      for (const stake of STAKES) {
        expect(Number.isInteger(forgeWin(pays, stake, wiesner.payouts.stake))).toBe(true);
      }
    }
  });

  it('rounds a fractional payout down, in the house favour', () => {
    expect(forgeWin(25, 100, 40)).toBe(62);
  });
});

describe('settleForge', () => {
  it('pays the win when the draw lands inside the passes', async () => {
    const result = await source.wiesner(4);
    const attempt = settleForge(result, 500, 100, () => 0);
    expect(attempt).toEqual({ length: 4, stake: 500, passed: true, delta: 1000, result });
  });

  it('takes the stake when the draw lands outside', async () => {
    const result = await source.wiesner(4);
    const attempt = settleForge(result, 500, 100, () => 0.999);
    expect(attempt).toEqual({ length: 4, stake: 500, passed: false, delta: -500, result });
  });

  it('draws exactly once', async () => {
    const rng = vi.fn(() => 0.5);
    settleForge(await source.wiesner(2), 100, 100, rng);
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it('draws from the result it was handed, not the export', async () => {
    const result = await source.wiesner(8);
    const sure = { ...result, shots: 10, passes: 10 };
    expect(settleForge(sure, 100, 100, () => 0.99).passed).toBe(true);
    const hopeless = { ...result, shots: 10, passes: 0 };
    expect(settleForge(hopeless, 100, 100, () => 0).passed).toBe(false);
  });
});

describe('clearsCage', () => {
  it('asks for a pass at the clearing length or longer', () => {
    expect(clearsCage({ length: CAGE_CLEAR_LENGTH, passed: true })).toBe(true);
    expect(clearsCage({ length: CAGE_CLEAR_LENGTH + 1, passed: true })).toBe(true);
    expect(clearsCage({ length: CAGE_CLEAR_LENGTH - 1, passed: true })).toBe(false);
    expect(clearsCage({ length: CAGE_CLEAR_LENGTH, passed: false })).toBe(false);
  });
});
