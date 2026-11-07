import { describe, expect, it } from 'vitest';
import { BEYOND_MIN_HANDS, BREAK_EVEN } from '../game/rules';
import { bandFor, createLines, dialStep, money, pastClassical, pct, signedAmount } from './lines';

const limits = { classical: 0.75, quantum: 0.8535533905932737 };

describe('pct', () => {
  it('formats a rate with the asked for digits', () => {
    expect(pct(0.75)).toBe('75%');
    expect(pct(0.8)).toBe('80%');
    expect(pct(0.7234, 1)).toBe('72.3%');
  });

  it('shows the exported quantum limit as 85.36%', () => {
    expect(pct(limits.quantum, 2)).toBe('85.36%');
  });
});

describe('money and signed amounts', () => {
  it('groups the bankroll', () => {
    expect(money(9700)).toBe('9,700');
    expect(money(10000.4)).toBe('10,000');
  });

  it('signs a change with a true minus', () => {
    expect(signedAmount(25)).toBe('+25');
    expect(signedAmount(-100)).toBe('−100');
  });
});

describe('pastClassical', () => {
  it('does not count sampling noise on a dial that reads 75.0%', () => {
    expect(pct(0.75003, 1)).toBe('75.0%');
    expect(pastClassical(0.75003, limits.classical)).toBe(false);
    expect(pastClassical(0.75, limits.classical)).toBe(false);
    expect(pastClassical(0.748, limits.classical)).toBe(false);
  });

  it('counts a rate the table shows above the limit', () => {
    expect(pct(0.7506, 1)).toBe('75.1%');
    expect(pastClassical(0.7506, limits.classical)).toBe(true);
    expect(pastClassical(0.77301, limits.classical)).toBe(true);
  });
});

describe('bandFor', () => {
  it('stays low up to and including the classical limit', () => {
    expect(bandFor(0.5, limits)).toBe('low');
    expect(bandFor(0.75, limits)).toBe('low');
    expect(bandFor(0.75003, limits)).toBe('low');
  });

  it('is over the line until the store would count the dial', () => {
    expect(bandFor(0.7506, limits)).toBe('over');
    expect(bandFor(BREAK_EVEN, limits)).toBe('over');
  });

  it('calls a dial above break-even even, the only rule the store has for a dial', () => {
    expect(bandFor(BREAK_EVEN + 0.0001, limits)).toBe('even');
    expect(bandFor(0.8388, limits)).toBe('even');
  });

  it('calls the top quarter of the span from break-even to the limit best', () => {
    expect(bandFor(0.8391, limits)).toBe('even');
    expect(bandFor(0.8403, limits)).toBe('best');
    expect(bandFor(limits.quantum, limits)).toBe('best');
    expect(bandFor(0.86, limits)).toBe('best');
  });

  it('follows the limits it is given, not a fixed rate', () => {
    const noisy = { classical: 0.75, quantum: 0.82 };
    expect(bandFor(0.8151, noisy)).toBe('best');
    expect(bandFor(0.81, noisy)).toBe('even');
  });
});

describe('createLines', () => {
  const lines = createLines(limits);

  it('reads the top rate from the exported limit', () => {
    expect(lines.best).toContain('85.36%');
  });

  it('states the store rule for clearing the table', () => {
    expect(lines.short).toContain('80%');
    expect(lines.cold).toContain(`${BEYOND_MIN_HANDS} hands`);
    expect(lines.cold).toContain('80%');
  });

  it('sends the player to the dial only when the dial is at fault', () => {
    expect(lines.short).toContain('Turn the dial');
    expect(lines.cold).not.toContain('dial');
  });

  it('never claims a rate under the line is strictly below it', () => {
    expect(lines.low).not.toContain('under the line');
    expect(lines.over).not.toContain('Below 80%');
  });

  it('claims wins at the payoff, not agreement, which a fixed plan can reach every hand', () => {
    expect(lines.beyond).toContain('won more often than any plan allows');
    expect(lines.beyond).not.toContain('agreed');
  });

  it('claims nothing about the rate after a run past the wall, which can be a bad one', () => {
    expect(lines.past).not.toMatch(/won|%/);
  });

  it('gives break-even from the rules', () => {
    expect(lines.wall).toContain('80%');
    expect(lines.over).toContain('80%');
  });
});

describe('dialStep', () => {
  it('is the spacing of an even grid', () => {
    expect(dialStep([0, 0.25, 0.5, 0.75, 1])).toBe(0.25);
  });

  it('is the smallest gap of an uneven grid', () => {
    expect(dialStep([0, 0.5, 0.625, 1])).toBe(0.125);
  });

  it('falls back to the whole range for a single point', () => {
    expect(dialStep([0.5])).toBe(1);
  });
});
