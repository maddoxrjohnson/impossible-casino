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
import { cageBoard, settleForge } from '../game/cage';
import { chshReceipt, markerFor, wiesnerReceipt } from './receipt';

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
  qubitSelection: 'best-case pick: a test coupler',
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

  it('shows a chip run was a best-case pick, even with no qubits to list', async () => {
    const result = await noisy.chsh(0.5);
    const receipt = chshReceipt({ ...result, provenance: chip }, hand, limits);
    expect(value(receipt, 'Qubits')).toBe('147, 148');
    expect(value(receipt, 'Qubit choice')).toBe(chip.qubitSelection);
    const bare = chshReceipt({ ...result, provenance: { ...chip, qubits: null } }, hand, limits);
    expect(value(bare, 'Qubit choice')).toBe(chip.qubitSelection);
  });

  it('never reads as a simulator or prints Aer on a chip run', async () => {
    const receipt = chshReceipt({ ...(await noisy.chsh(0.5)), provenance: chip }, hand, limits);
    const printed = [...receipt.rows.flat(), receipt.stamp, receipt.sub, receipt.circuitNote].join(' ');
    expect(printed).not.toMatch(/simulat|\baer\b/i);
    expect(value(receipt, 'Software')).toBe('Qiskit 2.6.2, Runtime 0.51.0');
    expect(value(receipt, 'Noise model')).toBeUndefined();
    expect(receipt.stamp).toBe('Ran on ibm_kingston. IBM job d4example.');
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

describe('wiesnerReceipt', () => {
  const board = cageBoard(exports.wiesner, 'ibm-noise-model');
  const passed = async (length = 4) => settleForge(await noisy.wiesner(length), 500, board.payoutStake, () => 0);
  const receiptAt = async (length = 4) => {
    const forge = await passed(length);
    return { forge, receipt: wiesnerReceipt(forge, board) };
  };

  it('shows the exported example ticket and says it is only an example', async () => {
    const { forge, receipt } = await receiptAt();
    expect(receipt.qasm).toBe(exports.wiesner.logicalCircuits.find((c) => c.length === 4)?.qasm);
    expect(receipt.circuitTitle).toMatch(/example/i);
    expect(receipt.circuitTitle).toContain('4 qubits');
    expect(receipt.circuitNote).toContain(forge.result.circuitNote);
  });

  it('heads the marker with the shots behind the draw, and claims nothing about the ticket', async () => {
    const { forge, receipt } = await receiptAt();
    expect(receipt.sub).toMatch(/shots/i);
    expect(receipt.sub).toMatch(/draw/i);
    expect(receipt.sub).not.toMatch(/ticket|circuit|checked|forgery|your forge/i);
    const live: SimulatorProvenance = { ...(forge.result.provenance as SimulatorProvenance), source: 'live-simulator' };
    const liveSub = wiesnerReceipt({ ...forge, result: { ...forge.result, provenance: live } }, board).sub;
    expect(liveSub).toBe(receipt.sub);
    expect(receipt.sub).not.toMatch(/pre-run|earlier|live/i);
  });

  it('says a live rate is a sample of its own shots, next to the limit', async () => {
    const { forge } = await receiptAt();
    const provenance: SimulatorProvenance = { ...(forge.result.provenance as SimulatorProvenance), source: 'live-simulator' };
    const live = { ...forge, result: { ...forge.result, provenance, shots: 512, passes: 300, passRate: 300 / 512 } };
    const rows = wiesnerReceipt(live, board).rows;
    const labels = rows.map(([label]) => label);
    const note = rows.find(([label]) => label === 'Reading this')?.[1];
    expect(note).toBe('The limit is a long-run value. This figure is a 512-shot sample, so it can land above or below it.');
    expect(labels.indexOf('Reading this')).toBe(labels.indexOf('Proven limit') + 1);
  });

  it('keeps pre-run wording as it was', async () => {
    const { receipt } = await receiptAt();
    expect(receipt.rows.map(([label]) => label)).not.toContain('Reading this');
  });

  it('reads shots and passes from the result, and the limit from the export', async () => {
    const { forge, receipt } = await receiptAt();
    expect(value(receipt, 'Shots')).toBe(forge.result.shots.toLocaleString('en-US'));
    expect(value(receipt, 'Passes')).toContain(forge.result.passes.toLocaleString('en-US'));
    const limit = exports.wiesner.limits.byLength.find((l) => l.length === 4)?.value ?? 0;
    expect(value(receipt, 'Proven limit')).toContain(`${(limit * 100).toFixed(1)}%`);
  });

  it('lists only the qubits this length used', async () => {
    const { forge, receipt } = await receiptAt(2);
    expect(value(receipt, 'Qubits')).toContain((forge.result.qubits ?? []).join(', '));
    expect(forge.result.qubits).toHaveLength(2);
  });

  it('states the outcome as one draw', async () => {
    const { receipt } = await receiptAt();
    expect(value(receipt, 'Your forge')).toContain('Passed');
    expect(value(receipt, 'Your forge')).toContain('+1,000');
    expect(value(receipt, 'Your forge')).toMatch(/one draw/i);
  });

  it('says plainly that a simulated forge never ran on a chip', async () => {
    const { receipt } = await receiptAt();
    expect(value(receipt, 'Job')).toMatch(/^None/);
    expect(receipt.stamp).toMatch(/never/i);
  });

  it('labels a live forge as live, whatever the board was', async () => {
    const forge = await passed();
    const live: SimulatorProvenance = { ...(forge.result.provenance as SimulatorProvenance), source: 'live-simulator' };
    const receipt = wiesnerReceipt({ ...forge, result: { ...forge.result, provenance: live } }, board);
    expect(value(receipt, 'Source')).toMatch(/^Live Qiskit simulator/);
  });
});

describe('markerFor', () => {
  const board = cageBoard(exports.wiesner, 'ibm-noise-model');

  it('shows the last forge in the cage and the last run everywhere else', async () => {
    const result = await noisy.chsh(0.5);
    const forge = settleForge(await noisy.wiesner(3), 100, board.payoutStake, () => 0);
    const state = { result, last: hand, forge };
    expect(markerFor(state, true, limits, board)?.circuitTitle).toContain('3 qubits');
    expect(markerFor(state, false, limits, board)?.circuitTitle).toContain('last hand');
  });

  it('has nothing to show when that room has no result', async () => {
    const result = await noisy.chsh(0.5);
    const forge = settleForge(await noisy.wiesner(3), 100, board.payoutStake, () => 0);
    expect(markerFor({ result, last: hand, forge: null }, true, limits, board)).toBeNull();
    expect(markerFor({ result: null, last: null, forge }, false, limits, board)).toBeNull();
  });
});
