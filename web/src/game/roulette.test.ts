import { describe, expect, it } from 'vitest';
import rouletteJson from '../../public/data/roulette.v1.json';
import { parseRouletteExport, ROULETTE_POCKETS, type RouletteExport } from './results';
import { openRound, playCard, playedRunId, rouletteBoard, spinRound, type RouletteBoard, type RouletteRound } from './roulette';
import { FIXTURE_EDGE, FIXTURE_JOB_ID, rouletteWithChip } from './roulette-chip.fixture';
import { STAKES, type Rng } from './rules';

const roulette = parseRouletteExport(rouletteJson);
const board = rouletteBoard(roulette);
const ideal = rouletteBoard(roulette, 'ideal');
/** The line the export solves to the house limit: tie, untie, the house ties the other pair, Sweep. */
const LIMIT_LINE = [2, 3, 4, 0];

function seeded(seed: number): Rng {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** An rng that answers each house turn with the card `draft` needs there. */
function lineTo(on: RouletteBoard, draft: readonly number[], stake = 100): RouletteRound {
  let pick = 0;
  const rng: Rng = () => pick;
  const aim = (at: readonly number[]): void => {
    const node = on.node(at);
    if (node?.turn !== 'house') return;
    const index = node.houseCards.indexOf(draft[at.length] ?? -1);
    if (index < 0) throw new Error(`the house never plays ${draft[at.length]} at ${at.join(',')}`);
    pick = (index + 0.5) / node.houseCards.length;
  };
  aim([]);
  let round = openRound(on, stake, rng);
  while (round.turn === 'player') {
    const card = draft[round.draft.length] as number;
    aim([...round.draft, card]);
    const next = playCard(on, round, card, rng);
    if (!next) throw new Error(`refused ${card}`);
    round = next;
  }
  expect(round.draft).toEqual(draft);
  return round;
}

/** A draw that lands on the first shot of `pocket` in the board's counts. */
function drawOn(on: RouletteBoard, draft: readonly number[], pocket: number): number {
  const point = on.point(draft);
  if (!point) throw new Error('no point');
  const before = point.counts.slice(0, pocket).reduce((sum, c) => sum + c, 0);
  return before / point.shots;
}

describe('rouletteBoard', () => {
  it('reads the play run from the export', () => {
    expect(board.runId).toBe('ibm-noise-model');
    expect(board.provenance).toEqual(roulette.runs[1]?.provenance);
    expect(board.points).toBe(roulette.runs[1]?.points);
    expect(board.edge).toEqual(roulette.edge.find((e) => e.run === 'ibm-noise-model'));
    expect(board.deck).toBe(roulette.deck);
    expect(board).toMatchObject({ pays: 280, payoutStake: 100, clearChance: 0.25, houseLimit: 0.25 });
  });

  it('can read another run', () => {
    expect(ideal.provenance).toEqual(roulette.runs[0]?.provenance);
    expect(ideal.edge.run).toBe('ideal');
  });

  it('throws on an unknown run', () => {
    expect(() => rouletteBoard(roulette, 'ibm_kingston')).toThrow(/ibm_kingston/);
  });

  it('throws when the run has no edge entry', () => {
    const bare: RouletteExport = { ...roulette, edge: roulette.edge.filter((e) => e.run !== 'ideal') };
    expect(() => rouletteBoard(bare, 'ideal')).toThrow(/edge/);
  });

  it('looks up nodes, points, wheels and circuits by draft', () => {
    expect(board.node([])).toMatchObject({ turn: 'house', houseCards: [2, 3, 4, 5] });
    expect(board.node(LIMIT_LINE)).toMatchObject({ turn: 'spin', value: 0.25 });
    expect(board.node([0, 0])).toBeNull();
    const point = board.point(LIMIT_LINE);
    expect(point?.shots).toBe(8192);
    expect(point?.draft).toEqual(LIMIT_LINE);
    expect(board.point([2])).toBeNull();
    expect(board.wheel(LIMIT_LINE)).toBe(roulette.wheels[4]);
    expect(board.wheel([9])).toBeNull();
    expect(board.circuit(LIMIT_LINE)).toBe(
      roulette.logicalCircuits.find((c) => c.draft.join(',') === '2,3,4,0')?.qasm,
    );
    expect(board.circuit([2])).toBeNull();
  });
});

describe('playedRunId', () => {
  const withChip = parseRouletteExport(rouletteWithChip());

  it('plays the noise model on the committed export, with any chip run set aside', () => {
    const bare = parseRouletteExport({ ...rouletteJson, runs: rouletteJson.runs.filter((r) => r.provenance.source !== 'ibm-chip') });
    expect(playedRunId(bare)).toBe('ibm-noise-model');
  });

  it('plays the chip run when it holds every finished draft and has an edge entry', () => {
    expect(playedRunId(withChip)).toBe('ibm-chip');
  });

  it('falls back to the play run when the chip run misses a draft', () => {
    const missing: RouletteExport = {
      ...withChip,
      runs: withChip.runs.map((r) => (r.id === 'ibm-chip' ? { ...r, points: r.points.slice(1) } : r)),
    };
    expect(playedRunId(missing)).toBe('ibm-noise-model');
  });

  it('falls back to the play run when the chip run has no edge entry', () => {
    const bare: RouletteExport = { ...withChip, edge: withChip.edge.filter((e) => e.run !== 'ibm-chip') };
    expect(playedRunId(bare)).toBe('ibm-noise-model');
  });

  it('never plays a simulator filed under the chip id', () => {
    const mislabelled: RouletteExport = {
      ...withChip,
      runs: withChip.runs.map((r) => (r.id === 'ibm-chip' ? { ...r, provenance: withChip.runs[1]!.provenance } : r)),
    };
    expect(playedRunId(mislabelled)).toBe('ibm-noise-model');
  });
});

describe('a board on the chip run', () => {
  const withChip = parseRouletteExport(rouletteWithChip());
  const chip = rouletteBoard(withChip, playedRunId(withChip));

  it('reads its provenance and edge from the chip run', () => {
    expect(chip.runId).toBe('ibm-chip');
    expect(chip.provenance).toMatchObject({ source: 'ibm-chip', jobId: FIXTURE_JOB_ID });
    expect(chip.edge).toMatchObject({ run: 'ibm-chip', bestReturn: FIXTURE_EDGE.bestReturn, clearChance: FIXTURE_EDGE.clearChance });
    expect(chip.edge.worstSpin.return).toBe(FIXTURE_EDGE.worstSpin);
  });

  it('draws each spin from that draft’s own shots', () => {
    const small = chip.points.find((p) => p.shots === 512)!;
    const round = lineTo(chip, small.draft);
    const last = small.counts.reduce((at, c, i) => (c > 0 ? i : at), 0);
    const spun = spinRound(chip, round, last, () => 0.999999)?.spin;
    expect(spun).toMatchObject({ shots: 512, landed: last, landedShots: small.counts[last] });
    const top = chip.points.find((p) => p.shots === 8192)!;
    const pocket = top.counts.findIndex((c) => c > 0);
    expect(spinRound(chip, lineTo(chip, top.draft), pocket, () => drawOn(chip, top.draft, pocket))?.spin).toMatchObject({ shots: 8192, landed: pocket });
  });
});

describe('openRound', () => {
  it('fixes the stake and lets the house play first', () => {
    const round = openRound(board, 500, () => 0);
    expect(round).toMatchObject({ stake: 500, draft: [2], turn: 'player', spin: null });
    expect(round.wheel).toBe(board.wheel([2]));
    expect(round.best).toBe(board.node([2])?.value);
  });

  it('picks each opening card at its share of the rng', () => {
    const cards = [0, 0.25, 0.5, 0.75, 0.999999].map((r) => openRound(board, 100, () => r).draft[0]);
    expect(cards).toEqual([2, 3, 4, 5, 5]);
  });

  it('covers every card the house may open with', () => {
    const rng = seeded(3);
    const seen = new Set<number>();
    for (let i = 0; i < 200; i += 1) seen.add(openRound(board, 100, rng).draft[0] as number);
    expect([...seen].sort()).toEqual([2, 3, 4, 5]);
  });
});

describe('playCard', () => {
  it('lets the house answer at once', () => {
    const opened = openRound(board, 100, () => 0);
    const round = playCard(board, opened, 0, () => 0);
    expect(round).toMatchObject({ draft: [2, 0, 1], turn: 'player', stake: 100 });
    expect(round?.best).toBe(board.node([2, 0, 1])?.value);
  });

  it('moves to the spin on the last card', () => {
    const round = lineTo(board, LIMIT_LINE);
    expect(round.turn).toBe('spin');
    expect(round.wheel).toBe(board.wheel(LIMIT_LINE));
    expect(round.spin).toBeNull();
  });

  it('never changes the round it was given', () => {
    const opened = openRound(board, 100, () => 0);
    playCard(board, opened, 3, () => 0);
    expect(opened.draft).toEqual([2]);
  });

  it('only plays house cards the export lists, over many random games', () => {
    const rng = seeded(11);
    for (let game = 0; game < 300; game += 1) {
      let round = openRound(board, 100, rng);
      while (round.turn === 'player') {
        const left = board.deck.map((_c, i) => i).filter((c) => !round.draft.includes(c));
        const card = left[Math.floor(rng() * left.length)] as number;
        const before = round.draft.length;
        const next = playCard(board, round, card, rng);
        if (!next) throw new Error('refused a legal card');
        if (next.draft.length > before + 1) {
          const house = board.node([...round.draft, card]);
          expect(house?.turn).toBe('house');
          if (house?.turn === 'house') expect(house.houseCards).toContain(next.draft[before + 1]);
        }
        round = next;
      }
      expect(round.draft).toHaveLength(4);
    }
  });

  it.each([
    ['a card already drafted', 2],
    ['a card off the deck', 6],
    ['a negative card', -1],
    ['a fractional card', 1.5],
    ['not a number', Number.NaN],
  ])('refuses %s with null', (_name, card) => {
    const opened = openRound(board, 100, () => 0);
    expect(playCard(board, opened, card, () => 0)).toBeNull();
  });

  it('refuses a card at the spin', () => {
    const round = lineTo(board, LIMIT_LINE);
    expect(playCard(board, round, 1, () => 0)).toBeNull();
  });

  it('follows the best hint to the house limit, whatever the house plays', () => {
    const rng = seeded(5);
    for (let game = 0; game < 50; game += 1) {
      let round = openRound(board, 100, rng);
      while (round.turn === 'player') {
        const left = board.deck.map((_c, i) => i).filter((c) => !round.draft.includes(c));
        const card = left.reduce((best, c) =>
          (board.node([...round.draft, c])?.value ?? 0) > (board.node([...round.draft, best])?.value ?? 0) ? c : best,
        );
        const next = playCard(board, round, card, rng);
        if (!next) throw new Error('refused');
        round = next;
      }
      expect(round.best).toBe(0.25);
      expect(round.best).toBe(board.houseLimit);
    }
  });
});

describe('spinRound', () => {
  it('lands on the pocket the draw falls in', () => {
    const round = lineTo(board, LIMIT_LINE, 100);
    const point = board.point(LIMIT_LINE);
    for (let pocket = 0; pocket < ROULETTE_POCKETS; pocket += 1) {
      if (!point?.counts[pocket]) continue;
      const spun = spinRound(board, round, pocket, () => drawOn(board, LIMIT_LINE, pocket));
      expect(spun?.spin?.landed).toBe(pocket);
      expect(spun?.spin?.landedShots).toBe(point.counts[pocket]);
    }
  });

  it('moves to the next pocket just past a pocket’s last shot', () => {
    const round = lineTo(ideal, LIMIT_LINE);
    const point = ideal.point(LIMIT_LINE);
    const lastOf0 = ((point?.counts[0] ?? 0) - 0.5) / (point?.shots ?? 1);
    const firstOf8 = (point?.counts[0] ?? 0) / (point?.shots ?? 1);
    expect(spinRound(ideal, round, 0, () => lastOf0)?.spin?.landed).toBe(0);
    expect(spinRound(ideal, round, 0, () => firstOf8)?.spin?.landed).toBe(8);
  });

  it('never lands on a pocket with no shots', () => {
    const round = lineTo(ideal, LIMIT_LINE);
    const point = ideal.point(LIMIT_LINE);
    expect(point?.counts.filter((c) => c === 0).length).toBeGreaterThan(0);
    const rng = seeded(21);
    for (let i = 0; i < 2000; i += 1) {
      const landed = spinRound(ideal, round, 0, rng)?.spin?.landed ?? -1;
      expect(point?.counts[landed]).toBeGreaterThan(0);
    }
    expect(spinRound(ideal, round, 0, () => 0)?.spin?.landed).toBe(0);
    expect(spinRound(ideal, round, 0, () => 0.9999999)?.spin?.landed).toBe(24);
  });

  it.each(STAKES.map((stake) => [stake]))('pays a straight-up win at stake %i', (stake) => {
    const round = lineTo(board, LIMIT_LINE, stake);
    const win = spinRound(board, round, 8, () => drawOn(board, LIMIT_LINE, 8));
    expect(win?.spin).toMatchObject({ pocket: 8, landed: 8, won: true, delta: Math.floor((280 * stake) / 100) });
    const loss = spinRound(board, round, 9, () => drawOn(board, LIMIT_LINE, 8));
    expect(loss?.spin).toMatchObject({ pocket: 9, landed: 8, won: false, delta: -stake, clears: false });
  });

  it('reports the shots and the draft it spun', () => {
    const round = lineTo(board, LIMIT_LINE);
    const spun = spinRound(board, round, 0, () => 0);
    expect(spun?.spin).toMatchObject({ shots: 8192, draft: LIMIT_LINE });
    expect(spun).toMatchObject({ stake: 100, draft: LIMIT_LINE, turn: 'spin' });
  });

  it('clears only on a win on a limit pocket', () => {
    const round = lineTo(board, LIMIT_LINE);
    const node = board.node(LIMIT_LINE);
    expect(node?.turn === 'spin' && node.limitPockets).toEqual([0, 8, 16, 24]);
    expect(spinRound(board, round, 16, () => drawOn(board, LIMIT_LINE, 16))?.spin?.clears).toBe(true);
    expect(spinRound(board, round, 0, () => drawOn(board, LIMIT_LINE, 16))?.spin?.clears).toBe(false);
    // The noise model lands off the limit pockets now and then; a win there does not clear.
    const point = board.point(LIMIT_LINE);
    const stray = point?.counts.findIndex((c, p) => c > 0 && ![0, 8, 16, 24].includes(p)) ?? -1;
    expect(stray).toBeGreaterThanOrEqual(0);
    const off = spinRound(board, round, stray, () => drawOn(board, LIMIT_LINE, stray));
    expect(off?.spin).toMatchObject({ won: true, clears: false });
  });

  it('never clears off the best line, where there are no limit pockets', () => {
    const draft = [2, 0, 1, 3];
    const round = lineTo(board, draft);
    const node = board.node(draft);
    expect(node?.turn === 'spin' && node.limitPockets).toEqual([]);
    for (let pocket = 0; pocket < ROULETTE_POCKETS; pocket += 1) {
      if (!board.point(draft)?.counts[pocket]) continue;
      const spun = spinRound(board, round, pocket, () => drawOn(board, draft, pocket));
      expect(spun?.spin).toMatchObject({ won: true, clears: false });
    }
  });

  it.each([
    ['a pocket off the wheel', 32],
    ['a negative pocket', -1],
    ['a fractional pocket', 2.5],
    ['not a number', Number.NaN],
  ])('refuses %s with null', (_name, pocket) => {
    const round = lineTo(board, LIMIT_LINE);
    expect(spinRound(board, round, pocket, () => 0)).toBeNull();
  });

  it('refuses before the draft is done', () => {
    expect(spinRound(board, openRound(board, 100, () => 0), 0, () => 0)).toBeNull();
  });

  it('refuses a second spin', () => {
    const spun = spinRound(board, lineTo(board, LIMIT_LINE), 0, () => 0);
    expect(spun).not.toBeNull();
    if (spun) expect(spinRound(board, spun, 0, () => 0)).toBeNull();
  });
});
