// The table without WebGL: the same game on the same HUD, over a flat surface in place of the felt. Nothing here waits on an animation.
import type { GameAudio } from '../audio/audio';
import { BREAK_EVEN, type RoomId } from '../game/rules';
import type { ResultSource } from '../game/results';
import type { GameStore } from '../game/store';
import { showFallback } from './fallback';
import type { Hud } from './hud';
import { createHudSync } from './hud-sync';
import { createLines, pct } from './lines';
import { flatFloor, flatHand, flatRate, type FlatHand } from './table';

export interface FlatTableOptions {
  store: GameStore;
  source: ResultSource;
  hud: Hud;
  audio: GameAudio;
  stages: readonly string[];
}

const BLANK = '–';
/** The rooms with a view that needs no building. A new room joins the elevator here once it has one. */
const FLAT_ROOMS: readonly RoomId[] = ['tables', 'cage'];

function seat(name: string) {
  const box = document.createElement('div');
  box.className = 'dc-seat';
  box.innerHTML = `<h3>${name}</h3><dl><div><dt>Question</dt><dd>${BLANK}</dd></div><div><dt>Answer</dt><dd>${BLANK}</dd></div></dl>`;
  const [question, answer] = box.querySelectorAll('dd');
  return { box, question: question as HTMLElement, answer: answer as HTMLElement };
}

/** Builds the surface, drives the HUD from the store, and returns the teardown. */
export function createFlatTable(root: HTMLElement, { store, source, hud, audio, stages }: FlatTableOptions): () => void {
  const { limits } = source;
  const surface = showFallback(root, 'no-webgl', hud.hud);
  root.classList.add('is-flat');
  hud.rooms((room) => FLAT_ROOMS.includes(room));

  const felt = document.createElement('div');
  felt.className = 'dc-felt';
  felt.innerHTML = `<div class="dc-felt-head"><span class="dc-felt-title"></span><span class="dc-felt-result"></span></div>
    <div class="dc-seats"></div>
    <div class="dc-felt-rate"><span>Win rate</span><b></b><i></i></div>
    <div class="dc-bar" aria-hidden="true"><div class="dc-bar-fill"></div>
      <span class="dc-bar-mark is-limit" style="left:${String(limits.classical * 100)}%"><span>The limit ${pct(limits.classical)}</span></span>
      <span class="dc-bar-mark is-even" style="left:${String(BREAK_EVEN * 100)}%"><span>${pct(BREAK_EVEN)} to break even</span></span></div>`;
  surface.append(felt);
  const you = seat('You'), partner = seat('Your partner');
  felt.querySelector('.dc-seats')?.append(you.box, partner.box);
  const title = felt.querySelector('.dc-felt-title') as HTMLElement;
  const result = felt.querySelector('.dc-felt-result') as HTMLElement;
  const rate = felt.querySelector('.dc-felt-rate b') as HTMLElement;
  const hands = felt.querySelector('.dc-felt-rate i') as HTMLElement;
  const bar = felt.querySelector('.dc-bar') as HTMLElement;
  const fill = felt.querySelector('.dc-bar-fill') as HTMLElement;

  // Story beats belong to the 3D view. Here the next control is always ready.
  const moment = { locked: false, inRoom: false, inCage: false };
  const lines = createLines(limits);
  const { sync, clearBand } = createHudSync(hud, { source, lines, moment: () => moment });

  // The Cage is the one room that needs no building, so it opens over the same HUD. A room with no flat view is ignored.
  hud.setSide((name) => {
    if (name !== 'back' && name !== 'cage') return;
    const enter = name === 'cage';
    if (enter === moment.inCage) return;
    moment.inRoom = moment.inCage = enter;
    hud.side(enter ? 'cage' : null);
    hud.say(enter ? lines.cage : lines[store.state.phase]);
    clearBand();
    sync(store.state);
  });

  let held: FlatHand | null = null, flooded = false;
  const paint = (s: GameStore['state']): void => {
    held = flatHand(s, held);
    title.textContent = held?.title ?? 'No hand dealt yet';
    result.textContent = held?.result ?? '';
    result.classList.toggle('is-won', !!held?.win);
    you.question.textContent = held?.x ?? BLANK; partner.question.textContent = held?.y ?? BLANK;
    you.answer.textContent = held?.a ?? BLANK; partner.answer.textContent = held?.b ?? BLANK;
    const shown = flatRate(s, limits);
    rate.textContent = shown.text;
    hands.textContent = shown.hands;
    fill.style.width = `${String(shown.fill)}%`;
    bar.classList.toggle('is-past', shown.past);
  };

  let floor = -1;
  const unsub = store.subscribe((s) => {
    const quantum = s.phase === 'entangled' || s.phase === 'beyond';
    // The colour arrives as the 3D flood would bring it, and leaves with the HUD's own reset.
    if (quantum && !flooded) { hud.colour(true); audio.chord(); }
    flooded = quantum;
    sync(s);
    paint(s);
    const here = flatFloor(s.phase, stages.length);
    if (here !== floor) {
      floor = here;
      hud.gauge(stages[here] ?? '', here / Math.max(1, stages.length - 1), here);
    }
  });
  const unround = store.onRound((last) => { audio.tick(last.win); });

  return () => {
    unsub(); unround();
    surface.remove();
    root.classList.remove('is-flat');
  };
}
