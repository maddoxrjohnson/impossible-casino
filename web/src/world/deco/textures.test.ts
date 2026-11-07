import { describe, expect, it } from 'vitest';
import { CARD_BACK, CARD_GRID, questionCell } from './textures';

describe('questionCell', () => {
  it('puts each dealt question on its own face', () => {
    expect(questionCell(0)).toBe(1);
    expect(questionCell(1)).toBe(2);
  });

  it('leaves the card face down until a hand is dealt', () => {
    expect(questionCell(null)).toBe(CARD_BACK);
  });

  it('stays on the first atlas row, away from the playing cards', () => {
    for (const question of [null, 0, 1]) expect(questionCell(question)).toBeLessThan(CARD_GRID[0]);
  });
});
