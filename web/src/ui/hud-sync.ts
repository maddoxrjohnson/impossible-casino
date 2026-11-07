// Puts the game on the HUD. Shared by the 3D view and the flat table, so it stays clear of the renderer.
import { BREAK_EVEN, winPayout } from '../game/rules';
import type { ResultSource } from '../game/results';
import type { GameState, Phase } from '../game/store';
import type { Hud } from './hud';
import { type LineKey, money, pct, signedAmount } from './lines';
import { settledLine, sourceLine, stakeChoices, tableButtons, type TableMoment } from './table';

export type HudSurface = Pick<Hud, 'put' | 'say' | 'buttons' | 'input' | 'stubs' | 'source' | 'title' | 'dial' | 'dialLocked' | 'stakes' | 'ticket' | 'colour'>;

export interface HudSyncOptions {
  source: Pick<ResultSource, 'limits' | 'previewProvenance'>;
  lines: Record<LineKey, string>;
  /** Read on every sync, so the caller can lock the table or leave it for a side room. */
  moment: () => TableMoment;
}

export function createHudSync(hud: HudSurface, { source, lines, moment }: HudSyncOptions) {
  const LIMIT = pct(source.limits.classical), EVEN = pct(BREAK_EVEN);
  let lastPhase: Phase | null = null, lastBroke = false, lastBand: LineKey | '' = '', running = false, buttonKey = '', ticketFilled = false;
  return {
    sync: (s: GameState): void => {
      hud.put('bank', money(s.bankroll));
      hud.put('rate', s.rounds ? pct(s.winRate, 1) : 'No hands');
      hud.put('hands', s.rounds ? `over ${s.rounds} hand${s.rounds === 1 ? '' : 's'}` : 'dealt yet');
      hud.put('limit', LIMIT); hud.put('even', `break even ${EVEN}`);
      const odds = `${pct(s.target, 1)} at this angle`;
      hud.put('odds', odds); hud.input.setAttribute('aria-valuetext', odds);
      hud.put('pays', `a win pays ${money(winPayout(s.stake))}`);
      if (+hud.input.value !== s.dial) hud.input.value = String(s.dial);
      if (s.last) {
        const l = s.last;
        hud.put('tt', s.rounds ? `Hand ${s.rounds}` : 'Last hand');
        hud.put('x', String(l.x)); hud.put('y', String(l.y)); hud.put('a', String(l.a)); hud.put('b', String(l.b));
        hud.put('res', l.win ? 'Won' : 'Lost');
        hud.put('amt', signedAmount(l.delta));
        hud.put('delta', `last hand ${signedAmount(l.delta)}`);
      } else hud.put('delta', '\u00a0');
      const p = s.phase, b = s.autoplaying, { locked: lock, inRoom } = moment();
      // A reloaded game has no last hand, and a run clears it, so the stub stays down until it has one to show.
      ticketFilled = p !== 'intro' && (ticketFilled || !!s.last);
      hud.ticket(ticketFilled);
      // Restarting from broke can land in the same phase, and the dealer still has to move on.
      if (p !== lastPhase || (lastBroke && !s.broke)) {
        hud.title(p === 'intro');
        if (p === 'intro' || p === 'classical' || p === 'wall') hud.colour(false);
        hud.say(lines[p]); lastBand = ''; running = false;
      }
      hud.dial((p === 'entangled' || p === 'beyond') && !lock && !inRoom && !s.broke);
      hud.dialLocked(b);
      hud.stakes(stakeChoices(s, lock), s.stake);
      hud.source(inRoom ? null : sourceLine(s, source.previewProvenance));
      const key = `${p}|${b}|${lock}|${inRoom}|${s.broke}|${!!s.result}`;
      if (buttonKey !== key) {
        buttonKey = key;
        const { main, alt } = tableButtons(s, { locked: lock, inRoom });
        hud.buttons(main, alt);
        hud.stubs(p !== 'classical' && !b && !lock, !!s.result);
      }
      if (!b && !lock && !inRoom) {
        const owed = settledLine(s, running, source.limits, lastBand);
        // A phase line gets its moment first; only being broke overrides it at once.
        if (owed && owed !== lastBand && (s.broke || lastPhase === p)) { lastBand = owed; hud.say(lines[owed]); }
        running = false;
      }
      if (b && s.mode === 'quantum') running = true;
      lastPhase = p; lastBroke = s.broke;
    },
    /** The card was rewritten from outside, so the next settled line is owed again. */
    clearBand: (): void => { lastBand = ''; },
  };
}
