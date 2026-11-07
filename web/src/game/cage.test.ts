import { describe, expect, it, vi } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import { cageBoard, clearsCage, forgeWin, settleForge } from './cage';
import { createPrerunSource, parseChshExport, parseWiesnerExport } from './results';
import { CAGE_CLEAR_LENGTH, FORGE_LENGTHS, STAKES, isForgeLength } from './rules';

const wiesner = parseWiesnerExport(wiesnerJson);
const exports = { chsh: parseChshExport(chshJson), wiesner };
const source = createPrerunSource(exports, 'ibm-noise-model');

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
