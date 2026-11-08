import { describe, expect, it } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import { cageBoard, settleForge } from '../game/cage';
import { withChipRuns } from '../game/chip';
import {
  createPrerunSource,
  parseChshExport,
  parseWiesnerExport,
  provenanceLabel,
  type SimulatorProvenance,
} from '../game/results';
import { CAGE_CLEAR_LENGTH, START_BANKROLL } from '../game/rules';
import { RESTART_ARM_MS, cageView, createRestartGuard, type CageState } from './cage-view';

/** Only the simulators, so these tests hold before and after a real chip run lands in the file. */
const bareWiesner = { ...wiesnerJson, runs: wiesnerJson.runs.filter((run) => run.provenance.source !== 'ibm-chip') };
const wiesner = parseWiesnerExport(bareWiesner);
const board = cageBoard(wiesner, 'ibm-noise-model');
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
const SPLIT = '32 tickets × 32 shots';
const CHIP_LABEL = 'IBM chip ibm_kingston, job d4forge';
const wiesnerChip = parseWiesnerExport({ ...bareWiesner, runs: [...bareWiesner.runs, chipRun] });
const chipExports = { ...exports, wiesner: wiesnerChip };
const chipBoard = cageBoard(wiesnerChip, 'ibm-noise-model');
const chipSource = withChipRuns(createPrerunSource(chipExports, 'ibm-noise-model'), chipExports);

const state = (over: Partial<CageState> = {}): CageState => ({
  bankroll: START_BANKROLL,
  stake: 100,
  autoplaying: false,
  forging: false,
  broke: false,
  forge: null,
  cleared: [],
  ...over,
});

describe('cageView rows', () => {
  it('prints the run and the proven limit from the board', () => {
    const { rows } = cageView(state(), board);
    expect(rows).toHaveLength(8);
    const row = rows[3];
    const source = board.rows[3];
    expect(row?.length).toBe(4);
    expect(row?.pass).toBe(`${((source?.passRate ?? 0) * 100).toFixed(1)}%`);
    expect(row?.limit).toBe(`${((source?.limit ?? 0) * 100).toFixed(1)}%`);
  });

  it('prices each row at the current stake', () => {
    expect(cageView(state({ stake: 100 }), board).rows[0]?.pays).toBe('+25');
    expect(cageView(state({ stake: 1000 }), board).rows[7]?.pays).toBe('+8,450');
  });

  it('gives each row a full spoken name', () => {
    const { rows } = cageView(state(), board);
    expect(rows[0]?.label).toMatch(/^1 qubit, /);
    expect(rows[1]?.label).toMatch(/^2 qubits, /);
    expect(rows[0]?.label).toContain(rows[0]?.pass);
    expect(rows[0]?.label).toContain(rows[0]?.limit);
  });

  it('has no chip column, since no chip data exists', () => {
    const shown = JSON.stringify(cageView(state(), board));
    expect(shown).not.toMatch(/ibm_|real chip/i);
  });
});

describe('cageView button', () => {
  it('offers the forge when ready', () => {
    expect(cageView(state(), board).button).toEqual({ label: 'Forge', act: 'forge', disabled: false, brass: false });
  });

  it('locks while a forge waits or the table plays', () => {
    expect(cageView(state({ forging: true }), board).button.disabled).toBe(true);
    expect(cageView(state({ autoplaying: true }), board).button.disabled).toBe(true);
  });

  it('turns into Start over for a broke player', () => {
    const view = cageView(state({ broke: true, bankroll: 40 }), board);
    expect(view.button).toMatchObject({ label: 'Start over', act: 'restart', disabled: false });
  });
});

describe('cageView stakes', () => {
  it('turns off what the bankroll cannot cover', () => {
    const { stakes } = cageView(state({ bankroll: 300 }), board);
    expect(stakes.map((s) => s.disabled)).toEqual([false, false, true, true]);
  });

  it('locks them all while a forge waits', () => {
    const { stakes } = cageView(state({ forging: true }), board);
    expect(stakes.every((s) => s.disabled)).toBe(true);
  });
});

describe('cageView result', () => {
  it('shows nothing before a forge', () => {
    expect(cageView(state(), board).result).toBeNull();
  });

  it('reads pass and amount, with the draw taken from the result', async () => {
    const result = await source.wiesner(4);
    const forge = settleForge(result, 500, board.payoutStake, () => 0);
    const shown = cageView(state({ forge }), board).result;
    expect(shown?.head).toBe('Passed +1,000');
    expect(shown?.won).toBe(true);
    expect(shown?.detail).toContain(`${((result.passes / result.shots) * 100).toFixed(1)}%`);
    expect(shown?.detail).toContain(result.passes.toLocaleString('en-US'));
    expect(shown?.detail).toContain(result.shots.toLocaleString('en-US'));
  });

  it('changes the status text on every forge, even a repeat of the same catch', async () => {
    const forge = settleForge(await source.wiesner(4), 100, board.payoutStake, () => 0.999);
    const text = (bankroll: number) => {
      const shown = cageView(state({ forge, bankroll }), board).result;
      return `${shown?.head ?? ''} ${shown?.detail ?? ''}`;
    };
    expect(text(9800)).toContain('9,800');
    expect(text(9800)).not.toBe(text(9700));
  });

  it('reads caught and amount', async () => {
    const forge = settleForge(await source.wiesner(4), 500, board.payoutStake, () => 0.999);
    const shown = cageView(state({ forge }), board).result;
    expect(shown?.head).toBe('Caught −500');
    expect(shown?.won).toBe(false);
  });
});

describe('createRestartGuard', () => {
  function guarded() {
    let now = 1000;
    const guard = createRestartGuard(() => now);
    return { guard, tick: (ms: number) => { now += ms; } };
  }

  it('leaves a button alone until it flips', () => {
    const { guard } = guarded();
    guard.see('forge');
    expect(guard.holding()).toBe(false);
  });

  it('holds Start over just after Forge turned into it', () => {
    const { guard, tick } = guarded();
    guard.see('forge');
    guard.see('restart');
    expect(guard.holding()).toBe(true);
    tick(RESTART_ARM_MS - 1);
    expect(guard.holding()).toBe(true);
    tick(1);
    expect(guard.holding()).toBe(false);
  });

  it('does not restart the wait on a repaint of the same button', () => {
    const { guard, tick } = guarded();
    guard.see('forge');
    guard.see('restart');
    tick(RESTART_ARM_MS);
    guard.see('restart');
    expect(guard.holding()).toBe(false);
  });

  it('does not hold a Start over the player walked in on', () => {
    const { guard } = guarded();
    guard.see('restart');
    expect(guard.holding()).toBe(false);
  });

  it('holds only the restart, so the next game can forge at once', () => {
    const { guard } = guarded();
    guard.see('forge');
    guard.see('restart');
    guard.see('forge');
    expect(guard.holding()).toBe(false);
  });
});

describe('cageView sources', () => {
  it('labels the board with the Wiesner run before any forge', () => {
    expect(cageView(state(), board).sources).toEqual([`Odds source: ${provenanceLabel(board.provenance)}`]);
  });

  it('names a forge by its own provenance, however it differs from the board', async () => {
    const real = await source.wiesner(2);
    const live: SimulatorProvenance = { ...(real.provenance as SimulatorProvenance), source: 'live-simulator' };
    const forge = settleForge({ ...real, provenance: live }, 100, board.payoutStake, () => 0);
    expect(cageView(state({ forge }), board).sources).toEqual([
      `Odds source: ${provenanceLabel(board.provenance)}`,
      'Last forge source: Live Qiskit simulator, fake_kingston noise model',
    ]);
  });
});

describe('cageView with a chip run', () => {
  it('marks the chip row, shows its rate and names the split aloud', () => {
    const row = cageView(state(), chipBoard).rows[3];
    expect(row?.pass).toBe('25.0%*');
    expect(row?.label).toContain('25.0% on chip');
    expect(row?.label).toContain(SPLIT);
    expect(row?.label).toContain(`this attack's rate ${row?.limit ?? ''}`);
  });

  it('leaves every simulator row unmarked and free of chip words', () => {
    const rows = cageView(state(), chipBoard).rows.filter((row) => row.length !== 4);
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.pass).not.toContain('*');
      expect(row.label).not.toMatch(/chip|tickets/);
    }
  });

  it('labels both sources, with the split on the chip one', () => {
    expect(cageView(state(), chipBoard).sources).toEqual([
      `Odds source: ${provenanceLabel(board.provenance)}`,
      `* Odds source: ${CHIP_LABEL}, ${SPLIT}`,
    ]);
  });

  it('drops the simulator source once the chip covers every row', () => {
    const points = wiesnerChip.payouts.table.map(({ length }) => ({
      length, seed: 3000000000 + length, shots: 1024, qubits: chipRun.provenance.qubits.slice(0, length), passes: 100, passRate: 100 / 1024,
    }));
    const full = parseWiesnerExport({ ...bareWiesner, runs: [...bareWiesner.runs, { ...chipRun, points }] });
    expect(cageView(state(), cageBoard(full, 'ibm-noise-model')).sources).toEqual([`* Odds source: ${CHIP_LABEL}, ${SPLIT}`]);
  });

  it('says why a chip rate spreads wider, and never calls the shots independent', () => {
    const shown = cageView(state(), chipBoard);
    expect(shown.note).toMatch(/fixed set of tickets/);
    expect(JSON.stringify(shown)).not.toMatch(/independent/i);
  });

  it('keeps the plain note when no chip run exists', () => {
    expect(cageView(state(), board).note).toBe("A run is a sample of shots, so it can land a little either side of the attack's rate.");
  });

  it('shows the split beside a chip forge and its own label', async () => {
    const forge = settleForge(await chipSource.wiesner(4), 100, board.payoutStake, () => 0);
    const shown = cageView(state({ forge }), chipBoard);
    expect(shown.result?.detail).toContain(`256 passes in 1,024 shots (${SPLIT})`);
    expect(shown.sources).toContain(`Last forge source: ${CHIP_LABEL}`);
  });

  it('never shows a split or a chip label on a simulated forge at a chip board', async () => {
    const forge = settleForge(await chipSource.wiesner(3), 100, board.payoutStake, () => 0);
    const shown = cageView(state({ forge }), chipBoard);
    expect(shown.result?.detail).not.toContain('tickets');
    expect(shown.sources[2]).toBe(`Last forge source: ${provenanceLabel(board.provenance)}`);
  });
});

describe('cageView goal', () => {
  it('names the clearing length until the room is cleared', () => {
    expect(cageView(state(), board).goal).toContain(String(CAGE_CLEAR_LENGTH));
    expect(cageView(state({ cleared: ['cage'] }), board).goal).toMatch(/cleared/i);
    expect(cageView(state({ cleared: ['tables'] }), board).goal).toContain(String(CAGE_CLEAR_LENGTH));
  });
});
