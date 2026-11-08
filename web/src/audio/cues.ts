// Which sound each change in the game calls for. Pure: it reads two states and names cues, and audio.ts voices them.
import { colourStep } from '../game/rooms';
import type { GameState } from '../game/store';

export type Cue = 'wall' | 'entangle' | 'shatter' | 'forgePass' | 'forgeFail' | 'card' | 'spinWin' | 'spinLoss';

/** The parts of the game that sound reads. */
export type CueState = Pick<GameState, 'phase' | 'forge' | 'roulette' | 'cleared'>;

/**
 * The cues for a change while playing. The first state is what a save or a fresh load
 * landed on, so it sounds nothing. A forge or spin sounds once, as the new object arrives.
 */
export function cuesFor(prev: CueState | null, next: CueState): Cue[] {
  if (!prev) return [];
  const cues: Cue[] = [];
  if (prev.phase !== next.phase) {
    if (prev.phase === 'classical' && next.phase === 'wall') cues.push('wall');
    else if (prev.phase === 'wall' && next.phase === 'entangled') cues.push('entangle');
    else if (prev.phase === 'entangled' && next.phase === 'beyond') cues.push('shatter');
  }
  if (next.forge && next.forge !== prev.forge) cues.push(next.forge.passed ? 'forgePass' : 'forgeFail');
  const spin = next.roulette?.spin ?? null;
  if (spin && spin !== (prev.roulette?.spin ?? null)) cues.push(spin.won ? 'spinWin' : 'spinLoss');
  else if (next.roulette && !spin) {
    // A settled round's draft is behind us when the next one opens.
    const before = prev.roulette && !prev.roulette.spin ? prev.roulette.draft.length : 0;
    if (next.roulette.draft.length > before) cues.push('card');
  }
  return cues;
}

export interface Ambience {
  /** How full the rain is, 0 to 1. */
  readonly rain: number;
  /** Rooms cleared, which is how many voices the drone has. */
  readonly step: number;
}

/** Calm rain until the rules break, fuller after. Unlike a cue, this follows a restored save too. */
const RAIN: Record<GameState['phase'], number> = { intro: 0.5, classical: 0.55, wall: 0.5, entangled: 0.7, beyond: 1 };

export function ambienceFor({ phase, cleared }: CueState): Ambience {
  return { rain: RAIN[phase], step: colourStep(cleared) };
}
