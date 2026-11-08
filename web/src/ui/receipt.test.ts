import { describe, expect, it } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import rouletteJson from '../../public/data/roulette.v1.json';
import {
  createPrerunSource,
  parseChshExport,
  parseRouletteExport,
  parseWiesnerExport,
  type ChipProvenance,
  type ChshResult,
  type SimulatorProvenance,
} from '../game/results';
import { cageBoard, settleForge } from '../game/cage';
import { withChipRuns } from '../game/chip';
import { playedRunId, rouletteBoard, spinRound, type RouletteRound } from '../game/roulette';
import { FIXTURE_JOB_ID, rouletteWithChip } from '../game/roulette-chip.fixture';
import { chshReceipt, markerFor, rouletteReceipt, wiesnerReceipt } from './receipt';

/** Only the simulators, so these tests hold before and after a real chip run lands in the file. */
const bareWiesner = { ...wiesnerJson, runs: wiesnerJson.runs.filter((run) => run.provenance.source !== 'ibm-chip') };
const exports = { chsh: parseChshExport(chshJson), wiesner: parseWiesnerExport(bareWiesner) };
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

  it("gives a chip run's win rate with its exported standard error", async () => {
    const result = { ...(await noisy.chsh(0.5)), provenance: chip, winRate: 0.8448486328125, stdErr: 0.0028285 };
    expect(value(chshReceipt(result, hand, limits), 'Win rate')).toBe('84.5% ± 0.28% at this dial');
    expect(value(chshReceipt({ ...result, stdErr: undefined }, hand, limits), 'Win rate')).toBe('84.5% at this dial');
  });

  it('keeps the simulator win rate as it was', async () => {
    const result = { ...(await noisy.chsh(0.5)), stdErr: 0.002 };
    expect(value(chshReceipt(result, hand, limits), 'Win rate')).toBe(`${(result.winRate * 100).toFixed(1)}% at this dial`);
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
    expect(note).toBe('That rate is a long-run value. This figure is a 512-shot sample, so it can land above or below it.');
    expect(labels.indexOf('Reading this')).toBe(labels.indexOf("This attack's rate") + 1);
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
    expect(value(receipt, "This attack's rate")).toContain(`${(limit * 100).toFixed(1)}%`);
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

describe('wiesnerReceipt on a chip run', () => {
  const run = {
    id: 'ibm-chip',
    provenance: { ...chip, jobId: 'd4forge', qubits: [61, 42, 5, 48, 15, 21, 93, 62], shots: 1024 },
    ticketsPerPoint: 32,
    shotsPerTicket: 32,
    points: [{ length: 4, seed: 3000040000, shots: 1024, qubits: [61, 42, 5, 48], passes: 256, passRate: 0.25 }],
  };
  const wiesner = parseWiesnerExport({ ...bareWiesner, runs: [...bareWiesner.runs, run] });
  const both = { ...exports, wiesner };
  const source = withChipRuns(createPrerunSource(both, 'ibm-noise-model'), both);
  const board = cageBoard(wiesner, 'ibm-noise-model');
  const receiptAt = async (length: number) =>
    wiesnerReceipt(settleForge(await source.wiesner(length), 100, board.payoutStake, () => 0), board);

  it('prints the shots with their tickets and shots per ticket', async () => {
    const receipt = await receiptAt(4);
    expect(value(receipt, 'Shots')).toBe('1,024 (32 tickets × 32 shots)');
    expect(value(receipt, 'Passes')).toBe('256, or 25.0%');
    expect(JSON.stringify(receipt)).not.toMatch(/independent/i);
  });

  it('says the spread is wider than the shot count suggests', async () => {
    const receipt = await receiptAt(4);
    const labels = receipt.rows.map(([label]) => label);
    expect(value(receipt, 'Reading this')).toMatch(/fixed set of random tickets/);
    expect(value(receipt, 'Reading this')).toContain('1,024 shots');
    expect(labels.indexOf('Reading this')).toBe(labels.indexOf("This attack's rate") + 1);
  });

  it('does not let the example ticket pass for one that ran', async () => {
    const receipt = await receiptAt(4);
    expect(receipt.circuitTitle).toMatch(/example/i);
    expect(receipt.circuitNote).toMatch(/not taken from this run/);
    expect(receipt.circuitNote).toContain('3000040000');
    expect(receipt.circuitNote).not.toMatch(/fresh ticket/);
    expect(receipt.stamp).toBe('Ran on ibm_kingston. IBM job d4forge. The example ticket is not from this run.');
  });

  it('never reads as a simulator or prints Aer', async () => {
    const receipt = await receiptAt(4);
    const printed = [...receipt.rows.flat(), receipt.stamp, receipt.sub, receipt.circuitNote].join(' ');
    expect(printed).not.toMatch(/simulat|\baer\b/i);
    expect(value(receipt, 'Job')).toBe('d4forge');
    expect(value(receipt, 'Qubits')).toBe('61, 42, 5, 48');
    expect(value(receipt, 'Software')).toBe('Qiskit 2.6.2, Runtime 0.51.0');
  });

  it('keeps a simulated length next to it reading as a simulator', async () => {
    const receipt = await receiptAt(3);
    expect(value(receipt, 'Source')).toMatch(/^Pre-run Qiskit simulator/);
    expect(value(receipt, 'Shots')).not.toContain('tickets');
    expect(value(receipt, 'Reading this')).toBeUndefined();
    expect(receipt.stamp).toMatch(/never touched a chip/);
    expect(receipt.circuitNote).toContain(wiesner.logicalCircuitsNote);
  });
});

describe('markerFor', () => {
  const board = cageBoard(exports.wiesner, 'ibm-noise-model');
  const wheel = rouletteBoard(parseRouletteExport(rouletteJson));

  it('shows the last forge in the cage, the last spin at the wheel and the last run everywhere else', async () => {
    const result = await noisy.chsh(0.5);
    const forge = settleForge(await noisy.wiesner(3), 100, board.payoutStake, () => 0);
    const roulette = spinRound(wheel, spinTurn(wheel, LIMIT_LINE), 0, () => 0);
    const state = { result, last: hand, forge, roulette };
    expect(markerFor(state, 'cage', limits, board, wheel)?.circuitTitle).toContain('3 qubits');
    expect(markerFor(state, null, limits, board, wheel)?.circuitTitle).toContain('last hand');
    expect(markerFor(state, 'roulette', limits, board, wheel)?.circuitTitle).toContain('Your draft');
  });

  it('has nothing to show when that room has no result', async () => {
    const result = await noisy.chsh(0.5);
    const forge = settleForge(await noisy.wiesner(3), 100, board.payoutStake, () => 0);
    expect(markerFor({ result, last: hand, forge: null, roulette: null }, 'cage', limits, board, wheel)).toBeNull();
    expect(markerFor({ result: null, last: null, forge, roulette: null }, null, limits, board, wheel)).toBeNull();
    expect(markerFor({ result, last: hand, forge, roulette: spinTurn(wheel, LIMIT_LINE) }, 'roulette', limits, board, wheel)).toBeNull();
  });
});

/** The line the export solves to the house limit. */
const LIMIT_LINE = [2, 3, 4, 0];

/** A round on its spin turn, read straight from the board's node. */
function spinTurn(on: ReturnType<typeof rouletteBoard>, draft: readonly number[], stake = 100): RouletteRound {
  const node = on.node(draft);
  const wheel = on.wheel(draft);
  if (node?.turn !== 'spin' || !wheel) throw new Error('not a spin turn');
  return { stake, draft, turn: 'spin', wheel, best: node.value, spin: null };
}

describe('rouletteReceipt', () => {
  const roulette = parseRouletteExport(rouletteJson);
  const board = rouletteBoard(roulette);
  const point = board.point(LIMIT_LINE);
  const node = board.node(LIMIT_LINE);
  const limitPocket = node?.turn === 'spin' ? (node.limitPockets[0] as number) : -1;
  const at = (pocket: number) => (point?.counts.slice(0, pocket).reduce((sum, c) => sum + c, 0) ?? 0) / (point?.shots ?? 1);
  const settled = (bet: number, lands: number, stake = 100) => {
    const spin = spinRound(board, spinTurn(board, LIMIT_LINE, stake), bet, () => at(lands))?.spin;
    if (!spin) throw new Error('refused spin');
    return spin;
  };

  it('prints the logical circuit for the draft', () => {
    const receipt = rouletteReceipt(settled(limitPocket, limitPocket), board, 100);
    expect(receipt.qasm).toBe(board.circuit(LIMIT_LINE));
    expect(receipt.circuitTitle).toBe('Your draft: Tie q1-q2, Tie q1-q2, Tie q3-q4, Sweep');
  });

  it('says the spin, its stake and its delta', () => {
    const won = rouletteReceipt(settled(limitPocket, limitPocket, 200), board, 200);
    expect(value(won, 'Your spin')).toBe(`Bet pocket ${limitPocket} at 200, landed on ${limitPocket}: won +560`);
    const other = point?.counts.findIndex((c, i) => c > 0 && i !== limitPocket) ?? -1;
    const lost = rouletteReceipt(settled(limitPocket, other), board, 100);
    expect(value(lost, 'Your spin')).toBe(`Bet pocket ${limitPocket} at 100, landed on ${other}: lost −100`);
  });

  it('reads the run, its machine and the landed pocket’s shots from the export', () => {
    const spin = settled(limitPocket, limitPocket);
    const receipt = rouletteReceipt(spin, board, 100);
    const p = board.provenance;
    expect(value(receipt, 'Source')).toBe('Pre-run Qiskit simulator, fake_kingston noise model');
    expect(value(receipt, 'Backend')).toBe(p.backend);
    expect(value(receipt, 'Noise model')).toMatch(/^fake_kingston, calibrated /);
    expect(value(receipt, 'Qubits')).toMatch(/^50, 20, 21, 105, 117 \(/);
    expect(value(receipt, 'Shots')).toBe('8,192');
    expect(value(receipt, 'Landed')).toBe(`Pocket ${limitPocket}: ${(point?.counts[limitPocket] ?? 0).toLocaleString('en-US')} of 8,192 shots`);
    expect(value(receipt, 'House limit')).toContain('1 in 4');
    expect(value(receipt, 'Job')).toMatch(/^None/);
    expect(value(receipt, 'Software')).toBe('Qiskit 2.6.2, Aer 0.18.2');
    expect(value(receipt, 'Run date')).toBe(p.date);
    expect(receipt.stamp).toMatch(/never touched a chip/);
  });
});

describe('rouletteReceipt on a chip run', () => {
  const withChip = parseRouletteExport(rouletteWithChip());
  const board = rouletteBoard(withChip, playedRunId(withChip));
  const settled = (draft: readonly number[]) => {
    const point = board.point(draft)!;
    const pocket = point.counts.findIndex((c) => c > 0);
    const spin = spinRound(board, spinTurn(board, draft), pocket, () => 0)?.spin;
    if (!spin) throw new Error('refused spin');
    return { spin, point, pocket };
  };

  it('names the chip and its job, never a simulator', () => {
    const receipt = rouletteReceipt(settled(LIMIT_LINE).spin, board, 100);
    expect(value(receipt, 'Source')).toBe(`IBM chip ibm_kingston, job ${FIXTURE_JOB_ID}`);
    expect(value(receipt, 'Backend')).toBe('ibm_kingston');
    expect(value(receipt, 'Job')).toBe(FIXTURE_JOB_ID);
    expect(value(receipt, 'Noise model')).toBeUndefined();
    expect(value(receipt, 'Qubit choice')).toBe('best-case pick: test qubits');
    expect(value(receipt, 'Software')).toBe('Qiskit 2.6.2, Runtime 0.51.0');
    expect(receipt.stamp).toBe(`Ran on ibm_kingston. IBM job ${FIXTURE_JOB_ID}.`);
    expect(JSON.stringify(receipt)).not.toMatch(/simulat/i);
  });

  it('shows the drawn draft’s own shots', () => {
    expect(value(rouletteReceipt(settled(LIMIT_LINE).spin, board, 100), 'Shots')).toBe('8,192');
    const small = board.points.find((p) => p.shots === 512)!;
    const { spin, point, pocket } = settled(small.draft);
    const receipt = rouletteReceipt(spin, board, 100);
    expect(value(receipt, 'Shots')).toBe('512');
    expect(value(receipt, 'Landed')).toBe(`Pocket ${pocket}: ${point.counts[pocket]} of 512 shots`);
  });

  it('names the noise model when the chip run cannot play', () => {
    const partial = { ...withChip, edge: withChip.edge.filter((e) => e.run !== 'ibm-chip') };
    const noisy = rouletteBoard(partial, playedRunId(partial));
    const receipt = rouletteReceipt(spinRound(noisy, spinTurn(noisy, LIMIT_LINE), 0, () => 0)!.spin!, noisy, 100);
    expect(value(receipt, 'Source')).toBe('Pre-run Qiskit simulator, fake_kingston noise model');
    expect(receipt.stamp).toMatch(/never touched a chip/);
  });
});
