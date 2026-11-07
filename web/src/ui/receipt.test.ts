import { describe, expect, it } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import {
  createPrerunSource,
  parseChshExport,
  parseWiesnerExport,
  type ChipProvenance,
  type ChshResult,
  type SimulatorProvenance,
} from '../game/results';
import { chshReceipt } from './receipt';

const exports = { chsh: parseChshExport(chshJson), wiesner: parseWiesnerExport(wiesnerJson) };
const noisy = createPrerunSource(exports, 'ibm-noise-model');
const ideal = createPrerunSource(exports, 'ideal');
const limits = noisy.limits;
const hand = { x: 1, y: 0, a: 0, b: 0, win: true, delta: 25 } as const;

const value = (receipt: ReturnType<typeof chshReceipt>, label: string) =>
  receipt.rows.find(([k]) => k === label)?.[1];

const chip: ChipProvenance = {
  source: 'ibm-chip',
  backend: 'ibm_kingston',
  noiseModel: null,
  qubits: [147, 148],
  shots: 4096,
  qiskitVersion: '2.6.2',
  aerVersion: '0.18.2',
  runtimeVersion: '0.51.0',
  date: '2026-11-07',
  jobId: 'd4example',
};

describe('chshReceipt', () => {
  it('shows the exported circuit behind the last hand, at the dial that ran', async () => {
    const result = await noisy.chsh(0.5);
    const receipt = chshReceipt(result, hand, limits);
    const exported = exports.chsh.logicalCircuits.find((c) => c.dial === 0.5);
    expect(receipt.qasm).toBe(exported?.pairs.find((p) => p.x === 1 && p.y === 0)?.qasm);
    expect(receipt.circuitTitle).toContain('last hand');
    expect(receipt.circuitTitle).toContain('1 and 0');
    expect(receipt.circuitTitle).toContain('0.5');
  });

  it('labels the circuit by what it is when no hand was dealt', async () => {
    const result = await noisy.chsh(0.5);
    const receipt = chshReceipt(result, null, limits);
    expect(receipt.circuitTitle).not.toContain('last hand');
    expect(receipt.qasm).toBe(result.circuits.find((c) => c.x === 0 && c.y === 0)?.qasm);
  });

  it('never passes a mismatched circuit off as the hand', async () => {
    const result = await noisy.chsh(0.5);
    const partial: ChshResult = { ...result, circuits: result.circuits.filter((c) => c.x === 0 && c.y === 0) };
    const receipt = chshReceipt(partial, hand, limits);
    expect(receipt.circuitTitle).not.toContain('last hand');
    expect(receipt.circuitTitle).toContain('0 and 0');
  });

  it('says the circuit is logical, because the run compiled it', async () => {
    const receipt = chshReceipt(await noisy.chsh(0.5), hand, limits);
    expect(receipt.circuitNote).toMatch(/logical circuit/i);
    expect(receipt.circuitNote).toMatch(/compiled/i);
  });

  it('reports the run: source, backend, shots, rate and limits from the data', async () => {
    const result = await noisy.chsh(0.5);
    const receipt = chshReceipt(result, hand, limits);
    expect(value(receipt, 'Source')).toBe('Pre-run Qiskit simulator, fake_kingston noise model');
    expect(value(receipt, 'Backend')).toBe('aer_simulator_from(fake_kingston)');
    expect(value(receipt, 'Shots')).toBe('32,768 across 4 question pairs');
    expect(value(receipt, 'Win rate')).toBe(`${(result.winRate * 100).toFixed(1)}% at this dial`);
    expect(value(receipt, 'Limits')).toBe('75.0% for any plan, 85.36% for quantum');
    expect(value(receipt, 'Run date')).toBe('2026-11-07');
  });

  it('prints the quantum limit from the limit, not from a sampled point', async () => {
    const result = await noisy.chsh(0.5);
    const receipt = chshReceipt({ ...result, winRate: 0.5 }, hand, { ...limits, quantum: 0.9 });
    expect(value(receipt, 'Limits')).toContain('90.00%');
  });

  it('names the noise model and how its qubits were picked', async () => {
    const receipt = chshReceipt(await noisy.chsh(0.5), hand, limits);
    expect(value(receipt, 'Noise model')).toBe('fake_kingston, calibrated 2026-04-15');
    expect(value(receipt, 'Qubits')).toBe('147, 148 (lowest CZ plus readout error in the snapshot)');
    expect(value(receipt, 'Software')).toBe('Qiskit 2.6.2, Aer 0.18.2');
  });

  it('leaves out rows an ideal run does not have', async () => {
    const receipt = chshReceipt(await ideal.chsh(0.5), hand, limits);
    expect(value(receipt, 'Noise model')).toBeUndefined();
    expect(value(receipt, 'Qubits')).toBeUndefined();
    expect(value(receipt, 'Source')).toBe('Pre-run Qiskit simulator');
  });

  it('says plainly that a simulated run never ran on a chip', async () => {
    const receipt = chshReceipt(await noisy.chsh(0.5), hand, limits);
    expect(value(receipt, 'Job')).toMatch(/^None/);
    expect(receipt.stamp).toMatch(/simulated/i);
    expect(receipt.stamp).toMatch(/never/i);
  });

  it('says the same for a live simulator', async () => {
    const result = await noisy.chsh(0.5);
    const live: SimulatorProvenance = { ...(result.provenance as SimulatorProvenance), source: 'live-simulator' };
    const receipt = chshReceipt({ ...result, provenance: live }, hand, limits);
    expect(value(receipt, 'Source')).toMatch(/^Live Qiskit simulator/);
    expect(receipt.stamp).toMatch(/never/i);
  });

  it('names the chip and its job only for a chip run', async () => {
    const receipt = chshReceipt({ ...(await noisy.chsh(0.5)), provenance: chip }, hand, limits);
    expect(value(receipt, 'Job')).toBe('d4example');
    expect(receipt.stamp).toContain('ibm_kingston');
    expect(receipt.stamp).toContain('d4example');
    expect(receipt.stamp).not.toMatch(/simulated/i);
    expect(value(receipt, 'Qubits')).toBe('147, 148');
    expect(value(receipt, 'Software')).toBe('Qiskit 2.6.2, Runtime 0.51.0');
  });
});
