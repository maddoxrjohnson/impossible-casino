import { describe, expect, it } from 'vitest';
import chshJson from '../../public/data/chsh.v1.json';
import wiesnerJson from '../../public/data/wiesner.v1.json';
import rouletteJson from '../../public/data/roulette.v1.json';
import { cageBoard, settleForge } from '../game/cage';
import { createPrerunSource, parseChshExport, parseRouletteExport, parseWiesnerExport, provenanceLabel, type ChshResult, type SimulatorProvenance } from '../game/results';
import { playedRunId, rouletteBoard, type RouletteRound } from '../game/roulette';
import { FIXTURE_JOB_ID, rouletteWithChip } from '../game/roulette-chip.fixture';
import { BREAK_EVEN, START_DIAL } from '../game/rules';
import { expertSheet, type ExpertSheet, type ExpertState } from './expert';
import { oneIn } from './roulette-view';

type Loose = Record<string, unknown> & { runs: (Record<string, unknown> & { points: Record<string, unknown>[] })[] };

/** The Wiesner export with every standard error taken out, so these hold before and after the file gains them. */
function bareWiesner(): Loose {
  const raw = structuredClone(wiesnerJson) as unknown as Loose;
  for (const run of raw.runs) {
    delete run.stdErrMethod;
    for (const point of run.points) delete point.stdErr;
  }
  return raw;
}

/** Fixed error bars on the chip run only, wide enough that lengths 1 and 2 sit within two of them. */
function withChipErrors(se: number): Loose {
  const raw = bareWiesner();
  const chip = raw.runs.find((r) => r.id === 'ibm-chip')!;
  chip.stdErrMethod = 'binomial over tickets';
  for (const point of chip.points) point.stdErr = se;
  return raw;
}

const chsh = parseChshExport(chshJson);
const roulette = parseRouletteExport(rouletteJson);
const wheel = rouletteBoard(roulette);
const data = (wiesner = parseWiesnerExport(bareWiesner())) => ({ chsh, wiesner, roulette, wheel });

const fresh: ExpertState = { dial: 0.5, result: null, forge: null, roulette: null };
const chart = (sheet: ExpertSheet, i = 0) => sheet.charts[i]!;
const series = (sheet: ExpertSheet, label: RegExp, i = 0) => chart(sheet, i).series.find((s) => label.test(s.label));
const text = (sheet: ExpertSheet) => JSON.stringify(sheet);

describe('the Tables sheet', () => {
  const sheet = expertSheet(null, fresh, data());
  const { classical, quantum } = chsh.limits;

  it('states the win rule, both limits with their methods, and break-even from the house rules', () => {
    const maths = sheet.maths.join(' ');
    expect(maths).toContain('a ⊕ b = x ∧ y');
    expect(maths).toContain('75.0%');
    expect(maths).toContain(classical.method);
    expect(maths).toContain('cos²(π/8)');
    expect(maths).toContain('85.36%');
    expect(maths).toContain(quantum.method);
    expect(maths).toContain('80%');
    expect(maths).toMatch(/pays 25 on 100/);
  });

  it('names the noise model qubits as the export picked them', () => {
    const noisy = chsh.runs.find((r) => r.id === 'ibm-noise-model')!.provenance as SimulatorProvenance;
    expect(sheet.maths.join(' ')).toContain(noisy.noiseModel!.qubitSelection);
  });

  it('plots every exported run as it is, labelled with its source', () => {
    for (const run of chsh.runs) {
      const s = chart(sheet).series.find((x) => x.source === provenanceLabel(run.provenance));
      expect(s, run.id).toBeDefined();
      expect(s!.points.map((p) => [p.x, p.y])).toEqual(run.points.map((p) => [p.dial, p.winRate]));
    }
    const chip = series(sheet, /chip/i)!;
    expect(chip.line).toBeNull();
    expect(chip.shape).not.toBeNull();
    expect(series(sheet, /ideal/i)!.line).not.toEqual(series(sheet, /noise/i)!.line);
  });

  it('draws the limits and break-even as reference lines, and marks the dial', () => {
    expect(chart(sheet).rules.map((r) => r.y)).toEqual([classical.value, BREAK_EVEN, quantum.value]);
    expect(chart(sheet).rules[2]!.label).toContain('cos²(π/8)');
    expect(chart(sheet).marker).toMatchObject({ x: 0.5 });
    expect(expertSheet(null, { ...fresh, dial: 0.25 }, data()).charts[0]!.marker?.x).toBe(0.25);
  });

  it('fits the axis to the data and the lines', () => {
    const { y } = chart(sheet);
    const all = [...chart(sheet).series.flatMap((s) => s.points.map((p) => p.y)), ...chart(sheet).rules.map((r) => r.y)];
    expect(y.min).toBeLessThanOrEqual(Math.min(...all));
    expect(y.max).toBeGreaterThanOrEqual(Math.max(...all));
    expect(y.ticks.length).toBeGreaterThan(2);
  });

  it('lists each pair at the dial for every run that has the dial', () => {
    const table = sheet.tables[0]!;
    expect(table.head).toHaveLength(6);
    expect(table.rows).toHaveLength(chsh.runs.length);
    const ideal = chsh.runs[0]!.points.find((p) => p.dial === 0.5)!;
    expect(table.rows[0]!.slice(1)).toEqual([...ideal.pairs.map((p) => `${(p.winRate * 100).toFixed(1)}%`), `${(ideal.winRate * 100).toFixed(1)}%`]);
    // The chip ran 9 dials, so a dial between them has only the simulators.
    const between = expertSheet(null, { ...fresh, dial: 0.03125 }, data());
    expect(between.tables[0]!.rows).toHaveLength(chsh.runs.filter((r) => r.points.some((p) => p.dial === 0.03125)).length);
  });

  it('adds the last run under its own provenance, live or not', async () => {
    const run = await createPrerunSource({ chsh, wiesner: data().wiesner }, 'ideal').chsh(0.25);
    const live: ChshResult = { ...run, provenance: { ...(run.provenance as SimulatorProvenance), source: 'live-simulator' } };
    const sheet = expertSheet(null, { ...fresh, result: live }, data());
    const rows = sheet.tables[0]!.rows;
    expect(rows[rows.length - 1]![0]).toContain(provenanceLabel(live.provenance));
    expect(rows[rows.length - 1]![0]).toContain('0.25');
  });

  it('is the same sheet from START_DIAL as from any other dial, apart from the marker', () => {
    expect(expertSheet(null, { ...fresh, dial: START_DIAL }, data()).charts[0]!.series).toEqual(chart(sheet).series);
  });
});

describe('the Cage sheet', () => {
  const plain = data();
  const sheet = expertSheet('cage', fresh, plain);
  const w = plain.wiesner;

  it('states the per-qubit limit, how lengths multiply and the house edge, from the export', () => {
    const maths = sheet.maths.join(' ');
    expect(maths).toContain('75%');
    expect(maths).toContain(w.limits.perQubit.method);
    expect(maths).toContain(w.limits.byLengthMethod);
    expect(maths).toContain('(3/4)ⁿ');
    expect(maths).toContain(w.payouts.rule);
    expect(maths).toContain('5.1%');
    expect(maths).toContain('7.2%');
  });

  it('quotes the noise model scope and the example ticket note', () => {
    const noisy = w.runs.find((r) => r.id === 'ibm-noise-model')!.provenance as SimulatorProvenance;
    const maths = sheet.maths.join(' ');
    expect(maths).toContain(noisy.noiseModel!.scope);
    expect(maths).toContain(noisy.noiseModel!.qubitSelection);
    expect(maths).toContain(w.logicalCircuitsNote);
  });

  it('plots the exact limit, each run and break-even per length, all read from the export', () => {
    expect(series(sheet, /limit/i)!.points.map((p) => [p.x, p.y])).toEqual(w.limits.byLength.map((l) => [l.length, l.value]));
    expect(series(sheet, /break-even/i)!.points.map((p) => p.y)).toEqual(w.payouts.table.map((r) => r.breakEven));
    for (const run of w.runs) {
      const s = chart(sheet).series.find((x) => x.source === provenanceLabel(run.provenance))!;
      expect(s.points.map((p) => p.y)).toEqual(run.points.map((p) => p.passRate));
    }
  });

  it('draws no error bars and says so when the export has none', () => {
    expect(chart(sheet).series.every((s) => s.points.every((p) => p.lo === undefined && p.hi === undefined))).toBe(true);
    expect(chart(sheet).note.join(' ')).toMatch(/no standard errors/i);
  });

  it('draws ±1 standard error on the chip and names the method', () => {
    const sheet = expertSheet('cage', fresh, data(parseWiesnerExport(withChipErrors(0.025))));
    const chip = series(sheet, /chip/i)!;
    const first = chip.points[0]!;
    expect(first.lo).toBeCloseTo(first.y - 0.025, 12);
    expect(first.hi).toBeCloseTo(first.y + 0.025, 12);
    expect(chart(sheet).note.join(' ')).toContain('binomial over tickets');
    expect(sheet.tables[0]!.rows[0]![4]).toBe('78.2% ± 2.5%');
  });

  it('never says the chip beat the limit when it lands above it within the error bars', () => {
    const sheet = expertSheet('cage', fresh, data(parseWiesnerExport(withChipErrors(0.025))));
    const maths = sheet.maths.join(' ');
    expect(maths).toMatch(/lengths 1 and 2/);
    expect(maths).toMatch(/1\.3 standard errors/);
    expect(maths).not.toMatch(/(?<!evidence of )beat(s|ing)? the limit|broke the limit/i);
    // Without error bars it still says a sample can land above a long-run value.
    expect(expertSheet('cage', fresh, plain).maths.join(' ')).toMatch(/lengths 1 and 2.*long-run/);
  });

  it('tabulates every length with the exact limit, the runs, break-even and the pay', () => {
    const table = sheet.tables[0]!;
    expect(table.rows).toHaveLength(8);
    expect(table.rows[0]).toEqual(['1', '75.0%', '75.3%', '74.1%', '78.2%', '80.0%', '25']);
  });

  it('words the real chip, noise and ideal figures from the committed export without claiming a beaten limit', () => {
    const real = expertSheet('cage', fresh, data(parseWiesnerExport(wiesnerJson)));
    const maths = real.maths.join(' ');
    expect(maths).toMatch(/lengths 1 and 2 sit above the exact limit by at most 1\.4 standard errors/);
    expect(maths).toMatch(/within sampling spread, so those rates are no evidence of beating the limit/);
    expect(maths).toMatch(/cashier reads all zeros/);
    expect(maths).toMatch(/By 8 qubits that is 10\.0%/);
    // At length 1 the noise model is 1.2 points under the ideal run, past their combined error bars, so the within-shot-noise line stays out.
    expect(maths).not.toMatch(/within shot noise of the ideal run/);
    expect(maths).not.toMatch(/(?<!evidence of )beat(s|ing)? the limit|broke the limit/i);
    expect(real.tables[0]!.rows[0]![2]).toBe('75.3% ± 0.5%');
  });

  it('marks the length of the last forge', async () => {
    const result = await createPrerunSource({ chsh, wiesner: w }, 'ibm-noise-model').wiesner(3);
    const board = cageBoard(w, 'ibm-noise-model');
    const forge = settleForge(result, 100, board.payoutStake, () => 0);
    expect(expertSheet('cage', { ...fresh, forge }, plain).charts[0]!.marker).toMatchObject({ x: 3 });
    expect(chart(sheet).marker).toBeNull();
  });
});

describe('the Wheel sheet', () => {
  const at = (draft: readonly number[], spin: RouletteRound['spin'] = null): RouletteRound => {
    const node = wheel.node(draft)!;
    return { stake: 100, draft, turn: node.turn, wheel: wheel.wheel(draft)!, best: node.value, spin };
  };
  const LIMIT_LINE = [2, 3, 4, 0];

  it('states the pockets, the opening, the limits with methods and the draft counts', () => {
    const sheet = expertSheet('roulette', fresh, data());
    const maths = sheet.maths.join(' ');
    expect(maths).toContain('32 pockets');
    expect(maths).toContain(roulette.pocketOrder.split(', so ')[0]);
    expect(maths.toLowerCase()).toContain(roulette.opening.toLowerCase());
    for (const limit of [roulette.limits.fairWheel, roulette.limits.classicalWheel, roulette.limits.houseLimit]) expect(maths).toContain(limit.method);
    expect(maths).toContain('1 in 4');
    expect(maths).toContain('360');
    expect(maths).toContain('108');
    expect(maths).toContain(roulette.payouts.rule);
  });

  it('shows the fair opening wheel with no round and no run shots', () => {
    const sheet = expertSheet('roulette', fresh, data());
    expect(chart(sheet).series).toHaveLength(1);
    expect(chart(sheet).series[0]!.points.map((p) => p.y)).toEqual(roulette.wheels[wheel.node([])!.wheel]);
    expect(chart(sheet).marker).toBeNull();
    expect(chart(sheet).title).toMatch(/fair/i);
  });

  it('shows the exact wheel mid-draft, with no shots until the draft is finished', () => {
    const sheet = expertSheet('roulette', { ...fresh, roulette: at([2, 3]) }, data());
    expect(chart(sheet).series).toHaveLength(1);
    expect(chart(sheet).series[0]!.points.map((p) => p.y)).toEqual(wheel.wheel([2, 3]));
  });

  it('sets the play run beside the exact wheel for a finished draft, and marks the bet', () => {
    const point = wheel.point(LIMIT_LINE)!;
    const spin = { pocket: 6, landed: 6, won: true, delta: 280, clears: true, shots: point.shots, landedShots: point.counts[6]!, draft: LIMIT_LINE };
    const sheet = expertSheet('roulette', { ...fresh, roulette: at(LIMIT_LINE, spin) }, data());
    const run = chart(sheet).series[1]!;
    expect(run.source).toBe(provenanceLabel(wheel.provenance));
    expect(run.points.map((p) => p.y)).toEqual(point.counts.map((c) => c / point.shots));
    expect(chart(sheet).series[0]!.points.map((p) => p.y)).toEqual(wheel.wheel(LIMIT_LINE));
    expect(chart(sheet).marker).toMatchObject({ x: 6 });
  });

  it('tabulates the pockets the chart shows, so no value hides in a tooltip', () => {
    const opening = expertSheet('roulette', fresh, data()).tables[0]!;
    expect(opening.rows).toEqual([['Every pocket', '1 in 32']]);
    const point = wheel.point(LIMIT_LINE)!;
    const exact = wheel.wheel(LIMIT_LINE)!;
    const finished = expertSheet('roulette', { ...fresh, roulette: at(LIMIT_LINE) }, data()).tables[0]!;
    const lit = exact.flatMap((c, i) => (c > 0 || point.counts[i]! > 0 ? [i] : []));
    expect(finished.rows.map((r) => r[0])).toEqual(lit.map(String));
    const top = lit.find((i) => exact[i]! > 0)!;
    expect(finished.rows.find((r) => r[0] === String(top))).toEqual([String(top), oneIn(exact[top]!), `${point.counts[top]!.toLocaleString('en-US')} (${((point.counts[top]! / point.shots) * 100).toFixed(1)}%)`]);
  });

  it('tabulates the play styles, the edge per run, the deck and the pay', () => {
    const sheet = expertSheet('roulette', fresh, data());
    const [, styles, edge, deck, pay] = sheet.tables;
    expect(styles!.rows.map((r) => r[0])).toEqual(roulette.limits.playStyles.map((s) => s.style));
    expect(styles!.rows[0]![1]).toBe(oneIn(0.25));
    expect(edge!.rows).toHaveLength(roulette.edge.length);
    expect(edge!.rows[1]).toEqual([expect.stringMatching(/noise/i), '95.6', '96.4', '24.6%']);
    expect(deck!.rows.map((r) => r[0])).toEqual(['Sweep', 'Spin q0', 'Tie q1-q2 (two in the deck)', 'Tie q3-q4 (two in the deck)']);
    expect(deck!.rows[0]![1]).toBe('H on q0, H on q1, H on q2, H on q3, H on q4');
    expect(pay!.rows[0]).toEqual(['Straight', '280', '300', '26.3%', '5.0%']);
  });
});

describe('every sheet', () => {
  it.each(['tables', 'cage', 'roulette'] as const)('%s labels every series with a source and never calls a simulator a chip', (room) => {
    const sheet = expertSheet(room === 'tables' ? null : room, fresh, data());
    for (const c of sheet.charts) {
      for (const s of c.series) {
        expect(s.source.length, s.label).toBeGreaterThan(0);
        if (/chip/i.test(s.label)) expect(s.source).toMatch(/^IBM chip/);
        else expect(s.source).not.toMatch(/^IBM chip/);
      }
    }
    expect(text(sheet)).not.toMatch(/sample data/i);
  });
});

describe('the Wheel sheet on a chip run', () => {
  const withChip = parseRouletteExport(rouletteWithChip());
  const chipWheel = rouletteBoard(withChip, playedRunId(withChip));
  const LIMIT_LINE = [2, 3, 4, 0];
  const node = chipWheel.node(LIMIT_LINE)!;
  const finished: RouletteRound = { stake: 100, draft: LIMIT_LINE, turn: node.turn, wheel: chipWheel.wheel(LIMIT_LINE)!, best: node.value, spin: null };
  const sheet = (on = chipWheel, r = withChip, round: RouletteRound | null = null) =>
    expertSheet('roulette', { ...fresh, roulette: round }, { chsh, wiesner: parseWiesnerExport(bareWiesner()), roulette: r, wheel: on });

  it('says the game spins on the chip and names its job', () => {
    const maths = sheet().maths.join(' ');
    expect(maths).toContain(`The game spins on IBM chip ibm_kingston, job ${FIXTURE_JOB_ID}.`);
    expect(maths).not.toContain('spins on the noise model');
  });

  it('sets the chip run beside the exact wheel', () => {
    const run = chart(sheet(chipWheel, withChip, finished)).series[1]!;
    expect(run.label).toBe('IBM chip');
    expect(run.source).toBe(`IBM chip ibm_kingston, job ${FIXTURE_JOB_ID}`);
  });

  it('says the noise model when the chip run cannot play', () => {
    const partial = { ...withChip, edge: withChip.edge.filter((e) => e.run !== 'ibm-chip') };
    const maths = sheet(rouletteBoard(partial, playedRunId(partial)), partial).maths.join(' ');
    expect(maths).toContain('The game spins on the noise model.');
    expect(maths).not.toContain('The game spins on IBM chip');
  });
});
