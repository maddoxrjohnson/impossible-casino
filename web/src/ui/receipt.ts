// What a casino marker says about a run. Every value is read from the result and its provenance. No DOM.
import type { CageBoard, ForgeAttempt } from '../game/cage';
import { provenanceLabel, ticketSplit, type ChshResult, type Provenance } from '../game/results';
import type { RouletteBoard, RouletteSpin } from '../game/roulette';
import type { GameState, LastHand } from '../game/store';
import type { SideName } from './hud';
import { money, pct, signedAmount, type Limits } from './lines';
import { oneIn } from './roulette-view';

export type ReceiptRow = readonly [label: string, value: string];

export interface Receipt {
  readonly sub: string;
  readonly circuitTitle: string;
  readonly qasm: string;
  readonly circuitNote: string;
  readonly rows: readonly ReceiptRow[];
  readonly stamp: string;
}

const CIRCUIT_NOTE = 'Logical circuit, as written. The run compiled it for its backend first.';

function software(p: Provenance): string {
  const second = p.source === 'ibm-chip' ? `Runtime ${p.runtimeVersion}` : `Aer ${p.aerVersion}`;
  return `Qiskit ${p.qiskitVersion}, ${second}`;
}

function machineRows(p: Provenance, used: readonly number[] | null = p.qubits): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const model = p.noiseModel;
  if (model) rows.push(['Noise model', `${model.name}, calibrated ${model.calibrated.slice(0, 10)}`]);
  if (used) {
    const qubits = used.join(', ');
    rows.push(['Qubits', model ? `${qubits} (${model.qubitSelection})` : qubits]);
  }
  if (p.source === 'ibm-chip') rows.push(['Qubit choice', p.qubitSelection]);
  return rows;
}

function stamp(p: Provenance): string {
  if (p.source === 'ibm-chip') return `Ran on ${p.backend}. IBM job ${p.jobId}.`;
  return 'Simulated with Qiskit. This run never touched a chip.';
}

export function chshReceipt(result: ChshResult, last: LastHand | null, limits: Limits): Receipt {
  const { provenance: p, circuits, dial, pairs, winRate } = result;
  const wanted = last ?? { x: 0, y: 0 };
  const match = circuits.find((c) => c.x === wanted.x && c.y === wanted.y);
  const circuit = match ?? circuits[0];
  if (!circuit) throw new Error('A result arrived without circuits');
  const questions = `questions ${circuit.x} and ${circuit.y}, dial ${dial}`;
  const shots = pairs.reduce((sum, pair) => sum + pair.shots, 0);
  return {
    sub: 'Payable at the Cage: what the table ran, and where.',
    circuitTitle: match && last ? `Your last hand: ${questions}` : `Sample circuit: ${questions}`,
    qasm: circuit.qasm,
    circuitNote: CIRCUIT_NOTE,
    rows: [
      ['Source', provenanceLabel(p)],
      ['Backend', p.backend],
      ...machineRows(p),
      ['Shots', `${shots.toLocaleString('en-US')} across ${pairs.length} question pairs`],
      ['Win rate', `${pct(winRate, 1)} at this dial`],
      ['Limits', `${pct(limits.classical, 1)} for any plan, ${pct(limits.quantum, 2)} for quantum`],
      ['Job', p.jobId ?? 'None. Simulators take no job.'],
      ['Software', software(p)],
      ['Run date', p.date],
    ],
    stamp: stamp(p),
  };
}

export function wiesnerReceipt(forge: ForgeAttempt, board: CageBoard): Receipt {
  const { length, stake, passed, delta, result } = forge;
  const { provenance: p, circuit, circuitNote, qubits, shots, passes, passRate } = result;
  const limit = board.rows.find((row) => row.length === length)?.limit;
  const split = ticketSplit(result);
  return {
    sub: 'Held at the Cage: the shots your draw came from, and where they ran.',
    circuitTitle: `Example ticket: ${length} qubit${length === 1 ? '' : 's'}`,
    qasm: circuit.qasm,
    circuitNote: `Logical circuit, as written: ${circuitNote}.`,
    rows: [
      ['Your forge', `${passed ? 'Passed' : 'Caught'} ${signedAmount(delta)} at ${money(stake)}, one draw from these shots`],
      ['Source', provenanceLabel(p)],
      ['Backend', p.backend],
      ...machineRows(p, qubits),
      ['Shots', split ? `${money(shots)} (${split})` : money(shots)],
      ['Passes', `${money(passes)}, or ${pct(passRate, 1)}`],
      ...(limit === undefined ? [] : [["This attack's rate", `${pct(limit, 1)}, exact`] as const]),
      // Few live shots land either side of the limit often enough to look like a broken proof.
      ...(p.source === 'live-simulator' && limit !== undefined
        ? [['Reading this', `That rate is a long-run value. This figure is a ${money(shots)}-shot sample, so it can land above or below it.`] as const]
        : []),
      // Repeated tickets add their own spread, so the total shots overstate how tight this is.
      ...(split && limit !== undefined
        ? [['Reading this', `That rate is a long-run value. This figure repeats a fixed set of random tickets, so it can land further from it than ${money(shots)} shots suggest.`] as const]
        : []),
      ['Job', p.jobId ?? 'None. Simulators take no job.'],
      ['Software', software(p)],
      ['Run date', p.date],
    ],
    stamp: split ? `${stamp(p)} The example ticket is not from this run.` : stamp(p),
  };
}

export function rouletteReceipt(spin: RouletteSpin, board: RouletteBoard, stake: number): Receipt {
  const { pocket, landed, won, delta, shots, landedShots, draft } = spin;
  const p = board.provenance;
  const qasm = board.circuit(draft);
  if (!qasm) throw new Error(`No logical circuit for draft ${draft.join(',')}`);
  const names = draft.map((card) => board.deck[card]?.name ?? `Card ${card}`);
  return {
    sub: 'Held at the Wheel: the shots your spin came from, and where they ran.',
    circuitTitle: `Your draft: ${names.join(', ')}`,
    qasm,
    circuitNote: CIRCUIT_NOTE,
    rows: [
      ['Your spin', `Bet pocket ${pocket} at ${money(stake)}, landed on ${landed}: ${won ? 'won' : 'lost'} ${signedAmount(delta)}`],
      ['Source', provenanceLabel(p)],
      ['Backend', p.backend],
      ...machineRows(p),
      ['Shots', money(shots)],
      ['Landed', `Pocket ${landed}: ${money(landedShots)} of ${money(shots)} shots`],
      ['House limit', `${oneIn(board.houseLimit)} on one pocket against a perfect house, from the exact wheel`],
      ['Job', p.jobId ?? 'None. Simulators take no job.'],
      ['Software', software(p)],
      ['Run date', p.date],
    ],
    stamp: stamp(p),
  };
}

/** The marker for the room the player is in: the last forge in the Cage, the last spin at the Wheel, the last run anywhere else. */
export function markerFor(
  { result, last, forge, roulette }: Pick<GameState, 'result' | 'last' | 'forge' | 'roulette'>,
  room: SideName | null,
  limits: Limits,
  board: CageBoard,
  wheel: RouletteBoard,
): Receipt | null {
  if (room === 'cage') return forge ? wiesnerReceipt(forge, board) : null;
  if (room === 'roulette') return roulette?.spin ? rouletteReceipt(roulette.spin, wheel, roulette.stake) : null;
  return result ? chshReceipt(result, last, limits) : null;
}
