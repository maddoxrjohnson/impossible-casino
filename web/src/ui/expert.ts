// The expert layer: the math, charts and tables behind each room, as plain data. Every number is read from an export or a result. No DOM.
import {
  provenanceLabel,
  ROULETTE_POCKETS,
  ticketSplit,
  type ChshExport,
  type Provenance,
  type RouletteExport,
  type WiesnerExport,
  type WiesnerRun,
} from '../game/results';
import type { RouletteBoard } from '../game/roulette';
import { BREAK_EVEN, CLASSICAL_STAKE, QUESTIONS, winPayout } from '../game/rules';
import type { GameState } from '../game/store';
import type { SideName } from './hud';
import { money, pct } from './lines';
import { oneIn } from './roulette-view';

export type ExpertState = Pick<GameState, 'dial' | 'result' | 'forge' | 'roulette'>;

export interface ExpertData {
  readonly chsh: ChshExport;
  readonly wiesner: WiesnerExport;
  readonly roulette: RouletteExport;
  readonly wheel: RouletteBoard;
}

export interface ExpertPoint {
  readonly x: number;
  readonly y: number;
  /** One standard error either side, where the export gives one. */
  readonly lo?: number;
  readonly hi?: number;
  /** What the point says on hover. */
  readonly tip: string;
}

export type ExpertTone = 'ink' | 'gold' | 'grey';
export type ExpertLine = 'solid' | 'dash' | 'dot' | 'long';
export type ExpertShape = 'circle' | 'square' | 'diamond' | 'triangle';

export interface ExpertSeries {
  readonly label: string;
  /** Where the numbers came from, in the export's own terms. */
  readonly source: string;
  readonly tone: ExpertTone;
  readonly line: ExpertLine | null;
  readonly shape: ExpertShape | null;
  readonly bars?: boolean;
  readonly points: readonly ExpertPoint[];
}

export interface ExpertRule {
  readonly y: number;
  readonly label: string;
  readonly source: string;
  readonly tone: ExpertTone;
  readonly line: ExpertLine;
}

export interface ExpertAxis {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly { readonly value: number; readonly label: string }[];
}

export interface ExpertChart {
  readonly title: string;
  /** What the chart's alt text says about where its values are. */
  readonly alt?: string;
  readonly note: readonly string[];
  readonly x: ExpertAxis;
  readonly y: ExpertAxis;
  readonly series: readonly ExpertSeries[];
  readonly rules: readonly ExpertRule[];
  readonly marker: { readonly x: number; readonly label: string } | null;
}

export interface ExpertTable {
  readonly title: string;
  readonly head: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly note?: string;
}

export interface ExpertSheet {
  readonly title: string;
  readonly sub: string;
  readonly maths: readonly string[];
  readonly charts: readonly ExpertChart[];
  readonly tables: readonly ExpertTable[];
  readonly sources: readonly string[];
}

/** Where the chip's best result sits on the dial. */
const MIDDLE_DIAL = 0.5;
const SUB = 'The quantum numbers come from Qiskit runs, each labelled with its source. Break-even and pays are the house rules. Formulas are written out beside the values they name.';
const DASH = '—';

/** A short name for a run, by where it ran. */
function runName(p: Provenance): string {
  if (p.source === 'ibm-chip') return 'IBM chip';
  if (p.source === 'live-simulator') return 'Live simulator';
  return p.noiseModel ? 'Noise model' : 'Ideal simulator';
}

const sentence = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const dialText = (d: number): string => String(d);
const lengthsText = (ns: readonly number[]): string => (ns.length === 1 ? `length ${ns[0]}` : `lengths ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

/** A rate axis that holds every value, on whole steps. */
function rateAxis(label: string, values: readonly number[], step: number, digits = 0): ExpertAxis {
  const lo = Math.max(0, Math.floor(Math.min(...values) / step - 1e-9) * step);
  const hi = Math.min(1, Math.ceil(Math.max(...values) / step + 1e-9) * step);
  const ticks = [];
  for (let i = 0; lo + i * step <= hi + 1e-9; i += 1) {
    const value = +(lo + i * step).toFixed(6);
    ticks.push({ value, label: pct(value, digits) });
  }
  return { label, min: lo, max: hi, ticks };
}

function tablesSheet({ dial, result }: ExpertState, chsh: ChshExport): ExpertSheet {
  const { classical, quantum } = chsh.limits;
  const pays = winPayout(CLASSICAL_STAKE);
  const style = (p: Provenance): Pick<ExpertSeries, 'tone' | 'line' | 'shape'> =>
    p.source === 'ibm-chip' ? { tone: 'ink', line: null, shape: 'diamond' } : p.noiseModel ? { tone: 'gold', line: 'dash', shape: null } : { tone: 'ink', line: 'solid', shape: null };
  const series: ExpertSeries[] = chsh.runs.map((run) => ({
    label: runName(run.provenance),
    source: provenanceLabel(run.provenance),
    ...style(run.provenance),
    points: run.points.map((p) => ({ x: p.dial, y: p.winRate, tip: `${runName(run.provenance)}, dial ${dialText(p.dial)}: ${pct(p.winRate, 1)}` })),
  }));
  const rules: ExpertRule[] = [
    { y: classical.value, label: `Best plan ${pct(classical.value, 1)}`, source: classical.method, tone: 'grey', line: 'solid' },
    { y: BREAK_EVEN, label: `Break-even ${pct(BREAK_EVEN)}`, source: `the house pays ${pays} on ${CLASSICAL_STAKE}`, tone: 'grey', line: 'dash' },
    { y: quantum.value, label: `cos²(π/8) ${pct(quantum.value, 2)}`, source: quantum.method, tone: 'gold', line: 'dot' },
  ];
  const values = [...series.flatMap((s) => s.points.map((p) => p.y)), ...rules.map((r) => r.y)];
  const pairRow = (name: string, pairs: readonly { x: number; y: number; winRate: number }[], all: number): string[] => [
    name,
    ...QUESTIONS.map((q) => { const pair = pairs.find((p) => p.x === q.x && p.y === q.y); return pair ? pct(pair.winRate, 1) : DASH; }),
    pct(all, 1),
  ];
  const rows = chsh.runs.flatMap((run) => {
    const point = run.points.find((p) => p.dial === dial);
    return point ? [pairRow(runName(run.provenance), point.pairs, point.winRate)] : [];
  });
  if (result) rows.push(pairRow(`Your last run, dial ${dialText(result.dial)}: ${provenanceLabel(result.provenance)}`, result.pairs, result.winRate));
  const picks = chsh.runs.flatMap((run) => {
    const p = run.provenance;
    const pick = p.noiseModel?.qubitSelection ?? p.qubitSelection;
    if (!pick || !p.qubits) return [];
    const best = p.noiseModel ? ' Picking the lowest-error qubits makes the noise model a best case, not a typical chip.' : '';
    return [`${runName(p)} ran on qubits ${p.qubits.join(' and ')}. How they were chosen: ${pick}.${best}`];
  });
  const chipPeak = chsh.runs.find((run) => run.provenance.source === 'ibm-chip')?.points.find((p) => p.dial === MIDDLE_DIAL);
  const sValue = (s: number): string => String(+s.toFixed(2));
  const beaten = chipPeak?.stdErr !== undefined && chipPeak.sigmasAboveClassical !== undefined && chipPeak.chshS !== undefined && classical.chshS !== undefined && quantum.chshS !== undefined
    ? [`IBM chip at the middle setting: ${pct(chipPeak.winRate, 2)} ± ${pct(chipPeak.stdErr, 2)}, about ${Math.round(chipPeak.sigmasAboveClassical)} standard errors above ${pct(classical.value)}. CHSH S = ${chipPeak.chshS.toFixed(2)} (classical bound ${sValue(classical.chshS)}, quantum limit ${sValue(quantum.chshS)}).`]
    : [];
  return {
    title: 'The math at the Tables',
    sub: SUB,
    maths: [
      'You draw a question x and your partner draws y, each 0 or 1. You answer a, they answer b. A hand wins when a ⊕ b = x ∧ y: answer alike, unless both questions are 1, and then differ.',
      `No plan made in advance wins more than ${pct(classical.value, 1)} of hands. Method: ${classical.method}.`,
      `A shared entangled pair, measured at the best dial, wins cos²(π/8) of hands: ${pct(quantum.value, 2)}. Method: ${quantum.method}.`,
      ...beaten,
      `A win pays ${pays} on ${CLASSICAL_STAKE} and a loss costs ${CLASSICAL_STAKE}, so a hand breaks even at ${CLASSICAL_STAKE} / (${CLASSICAL_STAKE} + ${pays}) = ${pct(BREAK_EVEN)}.${classical.value < BREAK_EVEN && BREAK_EVEN < quantum.value ? ' That sits between the two limits, so only the pair can beat the house.' : ''}`,
      ...picks,
    ],
    charts: [{
      title: 'Win rate at each dial',
      alt: 'The tables below give the pair rates at your dial.',
      note: ['Lines are the simulators at every dial in the export. Diamonds are the dials the chip ran.'],
      x: { label: 'Dial', min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1].map((value) => ({ value, label: dialText(value) })) },
      y: rateAxis('Win rate', values, 0.1),
      series,
      rules,
      marker: { x: dial, label: `Your dial ${dialText(dial)}` },
    }],
    tables: [{
      title: `Each question pair at dial ${dialText(dial)}`,
      head: ['Run', 'x 0, y 0', 'x 0, y 1', 'x 1, y 0', 'x 1, y 1', 'All four'],
      rows,
      note: 'A win on the first three pairs means answering alike. On x 1, y 1 it means answering differently.',
    }],
    sources: chsh.runs.map((run) => `${runName(run.provenance)}: ${provenanceLabel(run.provenance)}`),
  };
}

const hasErrors = (run: WiesnerRun | undefined): run is WiesnerRun => !!run && run.points.some((p) => p.stdErr !== undefined);

function cageSheet({ forge }: ExpertState, w: WiesnerExport): ExpertSheet {
  const { perQubit, byLength, byLengthMethod } = w.limits;
  const limitAt = (n: number) => byLength.find((l) => l.length === n)?.value;
  const chip = w.runs.find((r) => r.provenance.source === 'ibm-chip');
  const noisy = w.runs.find((r) => r.provenance.source !== 'ibm-chip' && r.provenance.noiseModel);
  const ideal = w.runs.find((r) => r.provenance.source !== 'ibm-chip' && !r.provenance.noiseModel);
  const edges = w.payouts.table.map((r) => r.houseEdge);
  const style = (p: Provenance): Pick<ExpertSeries, 'tone' | 'line' | 'shape'> =>
    p.source === 'ibm-chip' ? { tone: 'ink', line: null, shape: 'diamond' } : p.noiseModel ? { tone: 'ink', line: 'dot', shape: 'triangle' } : { tone: 'ink', line: 'dash', shape: 'square' };
  const runSeries = w.runs.map((run): ExpertSeries => ({
    label: runName(run.provenance),
    source: provenanceLabel(run.provenance),
    ...style(run.provenance),
    points: run.points.map((p) => ({
      x: p.length,
      y: p.passRate,
      ...(p.stdErr === undefined ? {} : { lo: p.passRate - p.stdErr, hi: p.passRate + p.stdErr }),
      tip: `${runName(run.provenance)}, length ${p.length}: ${pct(p.passRate, 1)}${p.stdErr === undefined ? '' : ` ± ${pct(p.stdErr, 1)}`}`,
    })),
  }));
  const series: ExpertSeries[] = [
    { label: "This attack's exact rate, (3/4)ⁿ", source: `${perQubit.method}; ${byLengthMethod}`, tone: 'gold', line: 'solid', shape: 'circle', points: byLength.map((l) => ({ x: l.length, y: l.value, tip: `This attack's exact rate, length ${l.length}: ${pct(l.value, 1)}` })) },
    ...runSeries,
    { label: 'Break-even', source: `the Cage's pay table: ${w.payouts.rule}`, tone: 'grey', line: 'long', shape: null, points: w.payouts.table.map((r) => ({ x: r.length, y: r.breakEven, tip: `Break-even, length ${r.length}: ${pct(r.breakEven, 1)}` })) },
  ];
  const values = series.flatMap((s) => s.points.flatMap((p) => [p.y, p.lo ?? p.y, p.hi ?? p.y]));
  const lengths = w.payouts.table.map((r) => r.length);
  const longest = Math.max(...byLength.map((l) => l.length));

  // A chip point above the attack's exact rate may be sampling or device bias; the copy has to say how far, not that the proof failed.
  const maths: string[] = [
    `The forger's attack: ${w.attack}. The check: ${w.passRule}.`,
    `Against that attack one qubit passes 3/4 of the time: ${pct(perQubit.value)}. Method: ${perQubit.method}.`,
    `A chip of n qubits passes (3/4)ⁿ: ${byLengthMethod}. By ${longest} qubits that is ${pct(limitAt(longest) ?? 0, 1)}.`,
    `Every length pays below fair odds: ${w.payouts.rule}. The house edge runs ${pct(Math.min(...edges), 1)} to ${pct(Math.max(...edges), 1)}.`,
  ];
  if (chip) {
    const above = chip.points.filter((p) => { const l = limitAt(p.length); return l !== undefined && p.passRate > l; });
    if (above.length) {
      const where = lengthsText(above.map((p) => p.length));
      if (above.every((p) => p.stdErr !== undefined && p.stdErr > 0)) {
        const most = Math.max(...above.map((p) => (p.passRate - (limitAt(p.length) ?? 0)) / (p.stdErr ?? 1)));
        maths.push(most <= 2
          ? `On the chip, ${where} sit above the attack's exact rate by at most ${most.toFixed(1)} standard errors. That is within sampling spread, so those rates are no evidence of beating that rate.`
          : `On the chip, ${where} sit above the attack's exact rate by up to ${most.toFixed(1)} standard errors. That rate is exact, so that is more than sampling spread usually gives. Device bias, with errors leaning toward a pass, is the likelier cause.`);
        maths.push('A pass means the cashier reads all zeros, so readout and decay errors that lean toward 0 can also lift the rate.');
      } else {
        const split = ticketSplit(chip);
        maths.push(`On the chip, ${where} land above the attack's exact rate. That rate is a long-run value, and each chip point is ${split ?? `${money(chip.points[0]?.shots ?? 0)} shots`}, so a sample can land above it.`);
      }
    }
  }
  if (noisy?.provenance.noiseModel) {
    const model = noisy.provenance.noiseModel;
    maths.push(`The noise model is a best case. Its qubits are a ${model.qubitSelection}.${model.scope ? ` What it covers: ${model.scope}.` : ''}`);
  }
  if (hasErrors(noisy) && hasErrors(ideal)) {
    const close = noisy.points.every((p) => {
      const q = ideal.points.find((i) => i.length === p.length);
      return !!q && p.stdErr !== undefined && q.stdErr !== undefined && Math.abs(p.passRate - q.passRate) <= p.stdErr + q.stdErr;
    });
    if (close) maths.push('At every length the noise model sits within shot noise of the ideal run, so the gap between them is not a noise effect this chart can show.');
  }
  maths.push(`On the marker, ${w.logicalCircuitsNote}.`);

  const errorRuns = w.runs.filter(hasErrors);
  const note = errorRuns.length
    ? [...new Set(errorRuns.map((r) => r.stdErrMethod))].map((method) => {
      const names = errorRuns.filter((r) => r.stdErrMethod === method).map((r) => runName(r.provenance));
      return `Bars on ${names.join(' and ')}: ±1 standard error, ${method ?? 'method not given'}.`;
    })
    : ['The export carries no standard errors, so no bars are drawn.'];
  const rate = (run: WiesnerRun | undefined, n: number): string => {
    const p = run?.points.find((x) => x.length === n);
    if (!p) return DASH;
    return p.stdErr === undefined ? pct(p.passRate, 1) : `${pct(p.passRate, 1)} ± ${pct(p.stdErr, 1)}`;
  };
  return {
    title: 'The math at the Cage',
    sub: SUB,
    maths,
    charts: [{
      title: 'Forgeries that pass, by length',
      note: [...note, 'A pass rate under the break-even line loses money on average at that length.'],
      x: { label: 'Qubits per ticket', min: Math.min(...lengths) - 0.5, max: Math.max(...lengths) + 0.5, ticks: lengths.map((n) => ({ value: n, label: String(n) })) },
      y: rateAxis('Pass rate', values, 0.1),
      series,
      rules: [],
      marker: forge ? { x: forge.length, label: `Your forge, length ${forge.length}` } : null,
    }],
    tables: [{
      title: 'Each length',
      head: ['Length', "Attack's exact rate", 'Ideal simulator', 'Noise model', 'IBM chip', 'Break-even', `Pays on ${money(w.payouts.stake)}`],
      rows: w.payouts.table.map((r) => [String(r.length), limitAt(r.length) === undefined ? DASH : pct(limitAt(r.length) ?? 0, 1), rate(ideal, r.length), rate(noisy, r.length), rate(chip, r.length), pct(r.breakEven, 1), money(r.pays)]),
      ...(chip ? { note: `${provenanceLabel(chip.provenance)}${ticketSplit(chip) ? `, ${ticketSplit(chip)} per length` : ''}.` } : {}),
    }],
    sources: w.runs.map((run) => `${runName(run.provenance)}: ${provenanceLabel(run.provenance)}`),
  };
}

const per100 = (r: number): string => (r * 100).toFixed(1);

/** The chart's pockets as rows: one row when every pocket has the same exact chance and no shots, else each lit pocket. */
function pocketTable(exact: readonly number[], counts: readonly number[] | null, shots: number): ExpertTable {
  const title = 'Each pocket';
  const first = exact[0];
  if (!counts && first !== undefined && exact.every((c) => c === first)) return { title, head: ['Pocket', 'Exact'], rows: [['Every pocket', oneIn(first)]] };
  const rows = exact.flatMap((chance, pocket) => {
    const count = counts?.[pocket] ?? 0;
    if (chance <= 0 && count <= 0) return [];
    const exactRow = [String(pocket), oneIn(chance)];
    return [counts ? [...exactRow, `${money(count)} (${pct(count / shots, 1)})`] : exactRow];
  });
  return { title, head: counts ? ['Pocket', 'Exact', 'Shots in the run'] : ['Pocket', 'Exact'], rows, note: 'Pockets with no exact chance and no shots are left out.' };
}

function wheelSheet({ roulette: round }: ExpertState, r: RouletteExport, board: RouletteBoard): ExpertSheet {
  const { fairWheel, classicalWheel, houseLimit, playStyles, legalDrafts, reachableDrafts } = r.limits;
  const draft = round?.draft ?? [];
  const exact = board.wheel(draft) ?? board.wheel([]) ?? [];
  const finished = round?.turn === 'spin';
  const point = finished ? board.point(draft) : null;
  const name = (card: number) => board.deck[card]?.name ?? `Card ${card}`;
  const series: ExpertSeries[] = [{
    label: 'Exact wheel',
    source: r.wheelsMethod,
    tone: 'grey',
    line: null,
    shape: null,
    bars: true,
    points: exact.map((chance, pocket) => ({ x: pocket, y: chance, tip: `Pocket ${pocket}, exact: ${oneIn(chance)}` })),
  }];
  if (point) {
    series.push({
      label: runName(board.provenance),
      source: provenanceLabel(board.provenance),
      tone: 'ink',
      line: null,
      shape: 'diamond',
      points: point.counts.map((count, pocket) => ({ x: pocket, y: count / point.shots, tip: `Pocket ${pocket}, ${runName(board.provenance)}: ${money(count)} of ${money(point.shots)} shots` })),
    });
  }
  const spin = round?.spin ?? null;
  const title = !round ? 'The fair opening wheel' : finished ? `The finished draft: ${draft.map(name).join(', ')}` : `The wheel so far: ${draft.length ? draft.map(name).join(', ') : 'no cards yet'}`;
  const note = [
    point ? `Bars are the exact wheel. Diamonds are the share of ${money(point.shots)} shots that landed in each pocket in the run the game spins on.` : 'Bars are the exact wheel. The runs only hold shots for a finished draft.',
    ...(spin ? [`Your bet was pocket ${spin.pocket}. The ball landed on ${spin.landed}.`] : []),
  ];
  const values = series.flatMap((s) => s.points.map((p) => p.y));
  const step = Math.max(...values) > 0.1 ? 0.05 : 0.01;
  const grouped = new Map<string, { gates: string; count: number }>();
  for (const card of r.deck) {
    const gates = card.ops.map((op) => `${op.gate.toUpperCase()} on ${op.qubits.map((q) => `q${q}`).join(', ')}`).join(', ');
    const seen = grouped.get(card.name);
    grouped.set(card.name, { gates, count: (seen?.count ?? 0) + 1 });
  }
  const runOf = (id: string) => r.runs.find((run) => run.id === id);
  const play = board.provenance;
  const straight = r.payouts.table.find((row) => row.bet === 'straight');
  const maths = [
    `Five qubits, read as five bits, give 2⁵ = ${ROULETTE_POCKETS} pockets: ${r.pocketOrder.split(', so ')[0]}.`,
    `${sentence(r.opening)}. Every pocket then comes up ${oneIn(fairWheel.value)}. Method: ${fairWheel.method}.`,
    `Each card is a gate or a row of gates, listed below. The wheels: ${r.wheelsMethod}.`,
    `Measure every qubit between cards, so nothing quantum carries over, and the best pocket is ${oneIn(classicalWheel.value)}. Method: ${classicalWheel.method}.`,
    `Played quantum, the best a player can force on one pocket against a perfect house is ${oneIn(houseLimit.value)}. Method: ${houseLimit.method}.`,
    `There are ${legalDrafts} legal drafts. ${reachableDrafts} of them can come up against this house, whose rule is: ${r.houseRule}.`,
    ...(straight ? [`A straight-up win pays ${money(straight.pays)} on ${money(r.payouts.stake)}: ${r.payouts.rule}.`] : []),
    ...(play.source === 'ibm-chip'
      ? [`The game spins on ${provenanceLabel(play)}. Its qubits are a ${play.qubitSelection}.`]
      : play.noiseModel
        ? [`The game spins on the noise model. Its qubits are a ${play.noiseModel.qubitSelection}.${play.noiseModel.scope ? ` What it covers: ${play.noiseModel.scope}.` : ''}`]
        : []),
  ];
  return {
    title: 'The math at the Wheel',
    sub: SUB,
    maths,
    charts: [{
      title,
      note,
      x: { label: 'Pocket', min: -0.5, max: ROULETTE_POCKETS - 0.5, ticks: [0, 4, 8, 12, 16, 20, 24, 28, ROULETTE_POCKETS - 1].map((value) => ({ value, label: String(value) })) },
      y: rateAxis('Chance', [0, ...values], step),
      series,
      rules: [],
      marker: spin ? { x: spin.pocket, label: `Your pocket ${spin.pocket}` } : null,
    }],
    tables: [
      pocketTable(exact, point?.counts ?? null, point?.shots ?? 0),
      { title: 'Play styles', head: ['Style', 'Best pocket', 'How it plays'], rows: playStyles.map((s) => [s.style, oneIn(s.value), sentence(s.rule)]) },
      {
        title: 'The edge, per run',
        head: ['Run', 'Best return per 100', 'Worst spin per 100', 'Clear chance'],
        rows: r.edge.map((e) => { const p = runOf(e.run)?.provenance; return [p ? runName(p) : e.run, per100(e.bestReturn), per100(e.worstSpin.return), pct(e.clearChance, 1)]; }),
        ...(r.edge[0] ? { note: `Method: ${r.edge[0].method}` } : {}),
      },
      { title: 'The deck', head: ['Card', 'Gates'], rows: [...grouped].map(([card, { gates, count }]) => [count > 1 ? `${card} (${count === 2 ? 'two' : count} in the deck)` : card, gates]) },
      { title: 'The pay table', head: ['Bet', 'Pays', 'Fair', 'Break-even', 'House edge'], rows: r.payouts.table.map((row) => [sentence(row.bet), money(row.pays), money(row.fairPays), pct(row.breakEven, 1), pct(row.houseEdge, 1)]) },
    ],
    sources: [`Exact wheel: ${r.wheelsMethod}`, ...r.runs.map((run) => `${runName(run.provenance)}: ${provenanceLabel(run.provenance)}`)],
  };
}

/** The expert sheet for the room in view. Built fresh on every open, so it cannot go stale. */
export function expertSheet(room: SideName | null, state: ExpertState, data: ExpertData): ExpertSheet {
  if (room === 'cage') return cageSheet(state, data.wiesner);
  if (room === 'roulette') return wheelSheet(state, data.roulette, data.wheel);
  return tablesSheet(state, data.chsh);
}
