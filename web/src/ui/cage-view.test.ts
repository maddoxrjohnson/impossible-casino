import { describe, expect, it } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import { cageBoard, settleForge } from '../game/cage';
import {
  createPrerunSource,
  parseChshExport,
  parseWiesnerExport,
  provenanceLabel,
  type SimulatorProvenance,
} from '../game/results';
import { CAGE_CLEAR_LENGTH, START_BANKROLL } from '../game/rules';
import { RESTART_ARM_MS, cageView, createRestartGuard, type CageState } from './cage-view';

const wiesner = parseWiesnerExport(wiesnerJson);
const board = cageBoard(wiesner, 'ibm-noise-model');
const source = createPrerunSource({ chsh: parseChshExport(chshJson), wiesner }, 'ibm-noise-model');

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

describe('cageView goal', () => {
  it('names the clearing length until the room is cleared', () => {
    expect(cageView(state(), board).goal).toContain(String(CAGE_CLEAR_LENGTH));
    expect(cageView(state({ cleared: ['cage'] }), board).goal).toMatch(/cleared/i);
    expect(cageView(state({ cleared: ['tables'] }), board).goal).toContain(String(CAGE_CLEAR_LENGTH));
  });
});
