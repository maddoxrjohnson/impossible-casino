import { describe, expect, it } from 'vitest';
import type { ForgeAttempt } from '../game/cage';
import type { RouletteRound, RouletteSpin } from '../game/roulette';
import { ambienceFor, cuesFor, type CueState } from './cues';

const forge = (passed: boolean): ForgeAttempt => ({ length: 3, stake: 100, passed, delta: passed ? 100 : -100 }) as ForgeAttempt;
const spin = (won: boolean): RouletteSpin => ({ pocket: 1, landed: won ? 1 : 2, won, delta: won ? 100 : -100, clears: false }) as RouletteSpin;
const round = (draft: number[], settled: RouletteSpin | null = null): RouletteRound => ({ stake: 100, draft, spin: settled }) as unknown as RouletteRound;
const at = (over: Partial<CueState> = {}): CueState => ({ phase: 'classical', forge: null, roulette: null, cleared: [], ...over });

describe('cuesFor', () => {
  it('plays nothing for the first state, however far along the save is', () => {
    expect(cuesFor(null, at({ phase: 'beyond', cleared: ['tables'] }))).toEqual([]);
    expect(cuesFor(null, at({ forge: forge(true), roulette: round([1], spin(true)) }))).toEqual([]);
  });

  it('plays nothing when nothing moved', () => {
    const s = at({ phase: 'entangled', forge: forge(true), roulette: round([1, 2]) });
    expect(cuesFor(s, s)).toEqual([]);
    expect(cuesFor(s, { ...s })).toEqual([]);
  });

  it('thuds at the wall, cracks at the entangle and shatters at beyond', () => {
    expect(cuesFor(at({ phase: 'classical' }), at({ phase: 'wall' }))).toEqual(['wall']);
    expect(cuesFor(at({ phase: 'wall' }), at({ phase: 'entangled' }))).toEqual(['entangle']);
    expect(cuesFor(at({ phase: 'entangled' }), at({ phase: 'beyond' }))).toEqual(['shatter']);
  });

  it('stays quiet for phase moves that are not those steps', () => {
    expect(cuesFor(at({ phase: 'intro' }), at({ phase: 'classical' }))).toEqual([]);
    expect(cuesFor(at({ phase: 'beyond' }), at({ phase: 'intro' }))).toEqual([]);
    expect(cuesFor(at({ phase: 'classical' }), at({ phase: 'beyond' }))).toEqual([]);
  });

  it('chimes a passed forge and buzzes a failed one, once per attempt', () => {
    const pass = forge(true), fail = forge(false);
    expect(cuesFor(at(), at({ forge: pass }))).toEqual(['forgePass']);
    expect(cuesFor(at({ forge: pass }), at({ forge: fail }))).toEqual(['forgeFail']);
    expect(cuesFor(at({ forge: pass }), at({ forge: pass, cleared: ['cage'] }))).toEqual([]);
    expect(cuesFor(at({ forge: pass }), at({ forge: null }))).toEqual([]);
  });

  it('snaps a card when the draft grows, including the house opening card', () => {
    expect(cuesFor(at(), at({ roulette: round([1]) }))).toEqual(['card']);
    expect(cuesFor(at({ roulette: round([1]) }), at({ roulette: round([1, 2, 3]) }))).toEqual(['card']);
    expect(cuesFor(at({ roulette: round([1, 2]) }), at({ roulette: round([1, 2]) }))).toEqual([]);
    expect(cuesFor(at({ roulette: round([1, 2]) }), at({ roulette: null }))).toEqual([]);
  });

  it('opens a new round after a settled one with a card', () => {
    const settled = round([1, 2, 3, 4], spin(true));
    expect(cuesFor(at({ roulette: settled }), at({ roulette: round([5]) }))).toEqual(['card']);
  });

  it('runs the ball for a spin and says how it ended, once per spin', () => {
    const won = spin(true), lost = spin(false);
    expect(cuesFor(at({ roulette: round([1, 2]) }), at({ roulette: round([1, 2], won) }))).toEqual(['spinWin']);
    expect(cuesFor(at({ roulette: round([1, 2]) }), at({ roulette: round([1, 2], lost) }))).toEqual(['spinLoss']);
    const done = at({ roulette: round([1, 2], won) });
    expect(cuesFor(done, at({ roulette: round([1, 2], won), cleared: ['roulette'] }))).toEqual([]);
    expect(cuesFor(done, { ...done, roulette: { ...done.roulette!, spin: won } })).toEqual([]);
  });

  it('gives a spin alone when the draft is the same', () => {
    expect(cuesFor(at({ roulette: round([1, 2]) }), at({ roulette: round([1, 2], spin(true)) }))).toHaveLength(1);
  });
});

describe('ambienceFor', () => {
  it('is calmer before the rules break and fuller after', () => {
    const rain = (phase: CueState['phase']): number => ambienceFor(at({ phase })).rain;
    expect(rain('classical')).toBeLessThan(rain('entangled'));
    expect(rain('entangled')).toBeLessThan(rain('beyond'));
    expect(rain('intro')).toBeLessThanOrEqual(rain('classical'));
    expect(rain('wall')).toBeLessThan(rain('beyond'));
  });

  it('fills out the drone with each cleared room', () => {
    expect(ambienceFor(at()).step).toBe(0);
    expect(ambienceFor(at({ cleared: ['cage'] })).step).toBe(1);
    expect(ambienceFor(at({ cleared: ['cage', 'tables', 'roulette'] })).step).toBe(3);
  });
});
