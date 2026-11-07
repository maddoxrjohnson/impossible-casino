import { describe, expect, it } from 'vitest';
import rouletteJson from '../../public/data/roulette.v1.json';
import { parseRouletteExport, provenanceLabel, ROULETTE_POCKETS } from '../game/results';
import { openRound, playCard, rouletteBoard, spinRound, type RouletteBoard, type RouletteRound } from '../game/roulette';
import { START_BANKROLL, type Rng } from '../game/rules';
import { createRestartGuard } from './cage-view';
import { oneIn, rouletteView, type RouletteState } from './roulette-view';

const roulette = parseRouletteExport(rouletteJson);
const board = rouletteBoard(roulette);
const text = roulette;
/** The line the export solves to the house limit: tie, untie, the house ties the other pair, Sweep. */
const LIMIT_LINE = [2, 3, 4, 0];
/** The trap: Sweep at once over a tied pair, then the house spins q0. */
const TRAP = [2, 0, 1];

/** The round along `draft`, with the house answering each of its turns with the card the draft names. */
function lineTo(on: RouletteBoard, draft: readonly number[]): RouletteRound {
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
  let round = openRound(on, 100, rng);
  while (round.draft.length < draft.length) {
    const card = draft[round.draft.length] as number;
    aim([...round.draft, card]);
    const next = playCard(on, round, card, rng);
    if (!next) throw new Error(`refused ${card}`);
    round = next;
  }
  return round;
}

/** Settles the round with the first shot of `pocket` in the run. */
function landOn(round: RouletteRound, bet: number, pocket: number): RouletteRound {
  const point = board.point(round.draft);
  if (!point) throw new Error('no point');
  const before = point.counts.slice(0, pocket).reduce((sum, c) => sum + c, 0);
  const next = spinRound(board, round, bet, () => before / point.shots);
  if (!next) throw new Error('refused spin');
  return next;
}

const state = (over: Partial<RouletteState> = {}): RouletteState => ({
  bankroll: START_BANKROLL,
  stake: 100,
  autoplaying: false,
  forging: false,
  broke: false,
  roulette: null,
  cleared: [],
  ...over,
});

describe('oneIn', () => {
  it('writes an exact wheel chance as one in so many', () => {
    expect(oneIn(0.25)).toBe('1 in 4');
    expect(oneIn(0.03125)).toBe('1 in 32');
    expect(oneIn(1)).toBe('certain');
    expect(oneIn(0)).toBe('0');
  });

  it('falls back to a percentage for a chance that is not one in a whole number', () => {
    expect(oneIn(0.3)).toBe('30.0%');
  });
});

describe('rouletteView idle', () => {
  it('offers the stakes and a button that opens a round', () => {
    const view = rouletteView(state(), board, text, null);
    expect(view.stage).toBe('idle');
    expect(view.stakes.map((s) => s.disabled)).toEqual([false, false, false, false]);
    expect(view.button).toMatchObject({ label: 'Open a round', act: 'open', disabled: false });
    expect(view.drafted).toEqual([]);
    expect(view.hint).toBeNull();
  });

  it('says plainly that the stake is fixed for the whole draft', () => {
    expect(rouletteView(state(), board, text, null).note).toMatch(/stake is fixed/i);
  });

  it('shows the fair wheel from the export, every pocket locked', () => {
    const { pockets, pocketsLocked } = rouletteView(state(), board, text, null);
    expect(pockets).toHaveLength(ROULETTE_POCKETS);
    expect(pockets.map((p) => p.chance)).toEqual(board.wheel([]));
    expect(pockets[0]?.odds).toBe('1 in 32');
    expect(pockets[0]?.label).toBe('Pocket 0, 1 in 32 on the exact wheel');
    expect(pocketsLocked).toBe(true);
  });

  it('labels a pocket the exact wheel never lands on as 0 there, never as no chance', () => {
    const view = rouletteView(state({ roulette: lineTo(board, LIMIT_LINE) }), board, text, null);
    const empty = view.pockets.find((p) => p.chance === 0);
    expect(empty?.label).toBe(`Pocket ${empty?.pocket}, 0 on the exact wheel`);
    expect(view.pockets.some((p) => /no chance/.test(p.label))).toBe(false);
  });

  it('cannot open a round the bankroll cannot cover', () => {
    expect(rouletteView(state({ bankroll: 50, stake: 100 }), board, text, null).button.disabled).toBe(true);
  });

  it('starts over when broke', () => {
    expect(rouletteView(state({ broke: true, bankroll: 0 }), board, text, null).button).toMatchObject({ act: 'restart', label: 'Start over', disabled: false });
  });
});

describe('rouletteView drafting', () => {
  const opened = lineTo(board, [2]);

  it('lists each drafted card with who played it', () => {
    const round = lineTo(board, [2, 3, 4]);
    const { drafted } = rouletteView(state({ roulette: round }), board, text, null);
    expect(drafted.map((c) => [c.by, c.name])).toEqual([['House', 'Tie q1-q2'], ['You', 'Tie q1-q2'], ['House', 'Tie q3-q4']]);
  });

  it('enables only the cards still in the deck, and only on the player’s turn', () => {
    const view = rouletteView(state({ roulette: opened }), board, text, null);
    expect(view.stage).toBe('player');
    expect(view.deck.map((c) => c.disabled)).toEqual([false, false, true, false, false, false]);
    expect(view.deck[2]?.drafted).toBe(true);
    const spin = rouletteView(state({ roulette: lineTo(board, LIMIT_LINE) }), board, text, null);
    expect(spin.deck.every((c) => c.disabled)).toBe(true);
  });

  it('locks the stake for the draft', () => {
    expect(rouletteView(state({ roulette: opened }), board, text, null).stakes.every((s) => s.disabled)).toBe(true);
  });

  it('shows the current wheel and the dealer’s hint from the export', () => {
    const round = lineTo(board, TRAP);
    const view = rouletteView(state({ roulette: round }), board, text, null);
    expect(view.pockets.map((p) => p.chance)).toEqual(board.wheel(round.draft));
    expect(view.hint).toContain(oneIn(round.best));
    expect(view.hint).toMatch(/1 in \d+ on the exact wheel/);
  });

  it('shows the tied pairs the export found', () => {
    expect(rouletteView(state({ roulette: opened }), board, text, null).tied).toEqual(['q1-q2']);
    expect(rouletteView(state({ roulette: lineTo(board, [2, 3, 4]) }), board, text, null).tied).toEqual(['q3-q4']);
  });

  it('does not call a pair tied when its Tie lands after the Sweep settled it', () => {
    const view = rouletteView(state({ roulette: lineTo(board, [2, 0, 1, 4]) }), board, text, null);
    expect(board.node([2, 0, 1, 4])?.tiedPairs).toEqual([[1, 2]]);
    expect(view.tied).toEqual(['q1-q2']);
    expect(view.drafted[3]?.note).toMatch(/q3-q4 is still not tied/);
    expect(view.drafted[3]?.note).not.toMatch(/now tied|untied/);
  });

  it('says what the last card did, counting the pockets lit on the exported wheels', () => {
    const lit = (draft: number[]) => board.wheel(draft)?.filter((p) => p > 0).length;
    const tie = rouletteView(state({ roulette: opened }), board, text, null);
    expect(tie.lastCard).toMatch(/house played Tie q1-q2/i);
    expect(tie.lastCard).toMatch(/did not move/i);
    expect(tie.lastCard).toContain(`${lit([2])} pockets`);
    expect(tie.lastCard).toMatch(/q1-q2 is now tied/);
    const untie = rouletteView(state({ roulette: lineTo(board, [2, 3, 4]) }), board, text, null);
    expect(untie.drafted[1]?.note).toMatch(/untied q1-q2/);
  });

  it('says when a Sweep could not settle a tied pair', () => {
    const round = lineTo(board, TRAP);
    const view = rouletteView(state({ roulette: round }), board, text, null);
    const sweep = view.drafted[1];
    expect(sweep?.name).toBe('Sweep');
    expect(sweep?.note).toMatch(/could not settle q1-q2/);
    expect(sweep?.note).toMatch(/tied/);
    expect(sweep?.note).toContain(`32 pockets lit, now ${board.wheel([2, 0])?.filter((p) => p > 0).length}`);
    const clean = rouletteView(state({ roulette: lineTo(board, LIMIT_LINE) }), board, text, null);
    expect(clean.drafted[3]?.note).toMatch(/could not settle q3-q4/);
    expect(clean.drafted[3]?.note).not.toMatch(/q1-q2/);
  });

  it('takes the last card’s note for the line under the wheel', () => {
    const view = rouletteView(state({ roulette: lineTo(board, [2, 3, 4]) }), board, text, null);
    expect(view.lastCard).toBe(view.drafted[2]?.note);
  });

  it('keeps the Spin button down until the spin turn and a pocket is picked', () => {
    expect(rouletteView(state({ roulette: opened }), board, text, null).button).toMatchObject({ act: 'spin', disabled: true });
    const round = lineTo(board, LIMIT_LINE);
    const none = rouletteView(state({ roulette: round }), board, text, null);
    expect(none.stage).toBe('spin');
    expect(none.pocketsLocked).toBe(false);
    expect(none.button).toMatchObject({ act: 'spin', disabled: true });
    const picked = rouletteView(state({ roulette: round }), board, text, 6);
    expect(picked.button).toMatchObject({ act: 'spin', disabled: false });
    expect(picked.turn).toBe(`Pocket 6, at ${oneIn(board.wheel(LIMIT_LINE)?.[6] ?? -1)} on the exact wheel. Spin when ready.`);
    expect(picked.pockets[6]?.picked).toBe(true);
  });
});

describe('rouletteView settled', () => {
  const round = lineTo(board, LIMIT_LINE);
  const node = board.node(LIMIT_LINE);
  const limitPocket = node?.turn === 'spin' ? (node.limitPockets[0] as number) : -1;
  const other = board.wheel(LIMIT_LINE)?.findIndex((p, i) => p > 0 && i !== limitPocket) ?? -1;

  it('says where the ball landed, the delta, and whether it cleared', () => {
    const won = landOn(round, limitPocket, limitPocket);
    const view = rouletteView(state({ roulette: won, bankroll: START_BANKROLL + (won.spin?.delta ?? 0) }), board, text, limitPocket);
    expect(view.stage).toBe('settled');
    expect(view.result?.won).toBe(true);
    expect(view.result?.head).toBe(`Won +${won.spin?.delta}`);
    expect(view.result?.detail).toContain(`Landed on ${limitPocket}`);
    expect(view.result?.detail).toMatch(/clears the Wheel/);
    expect(view.pockets[limitPocket]?.landed).toBe(true);
    expect(view.button).toMatchObject({ label: 'Another round', act: 'open' });
    expect(view.stakes.every((s) => !s.disabled)).toBe(true);
  });

  it('says a loss and leaves out the clear', () => {
    const lost = landOn(round, limitPocket, other);
    const view = rouletteView(state({ roulette: lost }), board, text, null);
    expect(view.result?.won).toBe(false);
    expect(view.result?.head).toBe('Lost −100');
    expect(view.result?.detail).not.toMatch(/clear/);
    expect(view.pockets[limitPocket]?.picked).toBe(true);
    expect(view.pockets[other]?.landed).toBe(true);
  });

  it('starts over once a loss leaves the player broke', () => {
    const lost = landOn(round, limitPocket, other);
    expect(rouletteView(state({ roulette: lost, broke: true, bankroll: 0 }), board, text, null).button.act).toBe('restart');
  });

  it('guards Start over and Another round from a press aimed at Spin', () => {
    let t = 0;
    const guard = createRestartGuard(() => t, 'spin');
    guard.see('spin');
    guard.see('open');
    expect(guard.holding()).toBe(true);
    t = 1000;
    expect(guard.holding()).toBe(false);
  });
});

describe('rouletteView rows and sources', () => {
  it('prints the pay table, the house limit, the run’s return and clear chance', () => {
    const { rows } = rouletteView(state({ stake: 200 }), board, text, null);
    const row = (k: string) => rows.find(([label]) => label === k)?.[1];
    expect(row('Pays')).toContain(`${board.pays} on ${board.payoutStake}`);
    expect(row('Pays')).toContain('+560');
    expect(row('House limit')).toContain(`${oneIn(board.houseLimit)} on one pocket of the exact wheel`);
    expect(row('Best return')).toContain(`Playing every draft to the spin, no strategy gets back more than ${(board.edge.bestReturn * 100).toFixed(1)} per 100 in this run`);
    expect(row('Best return')).toContain(`Leaving bad drafts, the most is ${(board.edge.worstSpin.return * 100).toFixed(1)} per 100, still under 100`);
    expect(board.edge.worstSpin.return).toBeLessThan(1);
    expect(row('Clear chance')).toContain(`${(board.edge.clearChance * 100).toFixed(1)}%`);
  });

  it('labels the wheel as the exact statevector and the spin as one shot of the play run', () => {
    const { sources } = rouletteView(state(), board, text, null);
    expect(sources[0]).toContain(roulette.wheelsMethod);
    expect(sources[1]).toContain(provenanceLabel(board.provenance));
    expect(sources[1]).toContain('8,192');
    expect(sources.join(' ')).not.toMatch(/chip/i);
  });

  it('says the house rule while drafting and the bet on the spin turn', () => {
    expect(rouletteView(state({ roulette: lineTo(board, [2]) }), board, text, null).note).toMatch(/^The house only plays/);
    expect(rouletteView(state({ roulette: lineTo(board, LIMIT_LINE) }), board, text, null).note).toMatch(/straight-up chip/);
  });

  it('sets the goal from the house limit, and marks the room cleared', () => {
    expect(rouletteView(state(), board, text, null).goal).toContain(oneIn(board.houseLimit));
    expect(rouletteView(state({ cleared: ['roulette'] }), board, text, null).goal).toMatch(/cleared/);
  });
});
