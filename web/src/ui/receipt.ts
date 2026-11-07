// What a casino marker says about a run. Every value is read from the result and its provenance. No DOM.
import { provenanceLabel, type ChshResult, type Provenance } from '../game/results';
import type { LastHand } from '../game/store';
import { pct, type Limits } from './lines';

export type ReceiptRow = readonly [label: string, value: string];

export interface Receipt {
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

function machineRows(p: Provenance): ReceiptRow[] {
  const rows: ReceiptRow[] = [];
  const model = p.noiseModel;
  if (model) rows.push(['Noise model', `${model.name}, calibrated ${model.calibrated.slice(0, 10)}`]);
  if (p.qubits) {
    const qubits = p.qubits.join(', ');
    rows.push(['Qubits', model ? `${qubits} (${model.qubitSelection})` : qubits]);
  }
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
