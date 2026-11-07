// The Roulette Wheel on the HUD: the draft, the wheel and the bet beside the door. The words and numbers come from roulette-view.
import type { RouletteBoard } from '../game/roulette';
import { ROULETTE_POCKETS } from '../game/results';
import type { GameState } from '../game/store';
import { RESTART_ARM_MS, createRestartGuard } from './cage-view';
import { rouletteView, type RouletteButton, type RouletteText } from './roulette-view';

export interface RoulettePanelOptions {
  board: RouletteBoard;
  text: RouletteText;
  stakes: readonly number[];
  onOpen: () => void;
  onPlay: (card: number) => void;
  onSpin: (pocket: number) => void;
  onRestart: () => void;
  onStake: (value: number) => void;
}

export function createRoulettePanel({ board, text, stakes, onOpen, onPlay, onSpin, onRestart, onStake }: RoulettePanelOptions) {
  const box = document.createElement('section');
  box.className = 'dc-roulette';
  box.setAttribute('aria-label', 'The Roulette Wheel');
  box.hidden = true;
  box.innerHTML = `<h2>Gather the wheel</h2><p class="dc-cage-goal"></p>
    <ol class="dc-rl-draft" aria-label="Cards drafted"></ol>
    <div class="dc-rl-deck" role="group" aria-label="The deck">${board.deck.map((_, i) => `<button type="button" class="dc-rl-card" data-card="${i}"></button>`).join('')}</div>
    <p class="dc-rl-turn" role="status"><span></span><b></b></p>
    <p class="dc-rl-last" aria-live="polite"></p>
    <div class="dc-rl-wheel" role="radiogroup" aria-label="Pocket to bet on">${Array.from({ length: ROULETTE_POCKETS }, (_, n) => `<label class="dc-rl-pocket"><input type="radio" name="dc-rl-pocket" value="${n}"><span>${n}</span><i></i></label>`).join('')}</div>
    <dl class="dc-rl-rows"></dl>
    <div class="dc-stakes" role="radiogroup" aria-label="Stake on this round"><span>Stake</span>${stakes.map((value) => `<label class="dc-stake"><input type="radio" name="dc-rl-stake" value="${value}"><span>${value.toLocaleString('en-US')}</span></label>`).join('')}</div>
    <div class="dc-cage-act"><button type="button" class="dc-btn"></button><div class="dc-cage-result" role="status"><b></b><span></span></div></div>
    <p class="dc-cage-note"></p>
    <p class="dc-source dc-cage-source"></p>`;

  const q = <T extends Element>(sel: string) => box.querySelector(sel) as T;
  const goal = q<HTMLElement>('.dc-cage-goal');
  const draftList = q<HTMLOListElement>('.dc-rl-draft');
  const deck = q<HTMLElement>('.dc-rl-deck');
  const cards = [...deck.querySelectorAll<HTMLButtonElement>('.dc-rl-card')];
  const turn = q<HTMLElement>('.dc-rl-turn span');
  const tied = q<HTMLElement>('.dc-rl-turn b');
  const last = q<HTMLElement>('.dc-rl-last');
  const wheelGroup = q<HTMLElement>('.dc-rl-wheel');
  const pockets = [...wheelGroup.querySelectorAll<HTMLLabelElement>('.dc-rl-pocket')].map((label) => {
    const [input, , odds] = label.children;
    return { label, input: input as HTMLInputElement, odds: odds as HTMLElement };
  });
  const rows = q<HTMLElement>('.dc-rl-rows');
  const stakeGroup = q<HTMLElement>('.dc-stakes');
  const stakeInputs = [...stakeGroup.querySelectorAll('input')];
  const button = q<HTMLButtonElement>('.dc-btn');
  const result = q<HTMLElement>('.dc-cage-result');
  const head = result.querySelector('b') as HTMLElement;
  const detail = result.querySelector('span') as HTMLElement;
  const note = q<HTMLElement>('.dc-cage-note');
  const sourceTag = q<HTMLElement>('.dc-cage-source');

  let picked: number | null = null;
  let held: GameState | null = null;
  let act: RouletteButton['act'] | null = null;
  let locked = true;
  let rowsKey = '';
  let armTimer = 0;
  let guard = createRestartGuard(() => performance.now(), 'spin');

  const paint = (s: GameState): void => {
    // A new draft starts with no pocket picked.
    if (s.roulette?.turn !== 'spin') picked = null;
    const view = rouletteView(s, board, text, picked);
    goal.textContent = view.goal;
    draftList.replaceChildren(...view.drafted.map((d) => {
      const li = document.createElement('li');
      li.className = d.by === 'House' ? 'is-house' : 'is-you';
      li.innerHTML = '<b></b> <span></span> <i></i>';
      const [who, name, lit] = li.children as unknown as [HTMLElement, HTMLElement, HTMLElement];
      who.textContent = d.by; name.textContent = d.name; lit.textContent = `${d.lit} lit`;
      li.title = d.note;
      return li;
    }));
    view.deck.forEach((card, i) => {
      const dom = cards[i];
      if (!dom) return;
      dom.textContent = card.name;
      dom.setAttribute('aria-label', card.label);
      dom.setAttribute('aria-disabled', String(card.disabled));
      dom.classList.toggle('is-drafted', card.drafted);
    });
    turn.textContent = [view.turn, view.hint ?? ''].filter(Boolean).join(' ');
    tied.textContent = view.tied.length ? `Tied: ${view.tied.join(', ')}` : '';
    tied.hidden = !view.tied.length;
    last.textContent = view.lastCard ?? '';
    locked = view.pocketsLocked;
    wheelGroup.setAttribute('aria-disabled', String(locked));
    view.pockets.forEach((p, i) => {
      const dom = pockets[i];
      if (!dom) return;
      dom.input.checked = p.picked;
      dom.input.setAttribute('aria-label', p.label);
      dom.input.setAttribute('aria-disabled', String(locked));
      dom.odds.textContent = p.short;
      dom.label.style.setProperty('--lit', p.level.toFixed(3));
      dom.label.classList.toggle('is-landed', p.landed);
      dom.label.classList.toggle('is-empty', p.chance <= 0);
    });
    const key = view.rows.map(([k, v]) => `${k}:${v}`).join('|');
    if (key !== rowsKey) {
      rowsKey = key;
      rows.replaceChildren(...view.rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
    }
    stakeInputs.forEach((input, i) => { input.checked = +input.value === s.stake; input.disabled = !!view.stakes[i]?.disabled; });
    button.textContent = view.button.label;
    guard.see(view.button.act);
    const off = view.button.disabled || guard.holding();
    button.setAttribute('aria-disabled', String(off));
    clearTimeout(armTimer);
    if (guard.holding()) armTimer = window.setTimeout(() => { if (held) paint(held); }, RESTART_ARM_MS);
    button.classList.toggle('is-brass', view.button.brass);
    act = off ? null : view.button.act;
    result.classList.toggle('is-won', !!view.result?.won);
    head.textContent = view.result?.head ?? '';
    detail.textContent = view.result?.detail ?? '';
    note.textContent = view.note;
    sourceTag.textContent = view.sources.join(' · ');
  };

  const repaint = (): void => { if (held) paint(held); };
  const onCard = (e: MouseEvent): void => {
    if (e.detail > 1) return;
    const b = e.target instanceof Element ? e.target.closest<HTMLButtonElement>('.dc-rl-card') : null;
    if (!b || b.getAttribute('aria-disabled') === 'true') return;
    onPlay(+(b.dataset.card ?? -1));
  };
  // A locked wheel puts the radios back as the view has them.
  const onPocket = (e: Event): void => {
    if (!(e.target instanceof HTMLInputElement)) return;
    if (!locked) picked = +e.target.value;
    repaint();
  };
  const onStakeChange = (e: Event): void => { if (e.target instanceof HTMLInputElement) onStake(+e.target.value); };
  // A second click of a double-click is the same gesture, and must not open a round over the result.
  const onButton = (e: MouseEvent): void => {
    if (e.detail > 1) return;
    if (act === 'open') onOpen();
    else if (act === 'spin' && picked !== null) onSpin(picked);
    else if (act === 'restart') onRestart();
  };
  // A held key is one press, so it cannot chain a spin into the next round.
  const onButtonKey = (e: KeyboardEvent): void => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); };
  deck.addEventListener('click', onCard);
  wheelGroup.addEventListener('change', onPocket);
  stakeGroup.addEventListener('change', onStakeChange);
  button.addEventListener('click', onButton);
  button.addEventListener('keydown', onButtonKey);

  return {
    box,
    /** Nothing is written while the panel is shut. */
    sync(s: GameState): void {
      held = s;
      if (!box.hidden) paint(s);
    },
    show(on: boolean): void {
      if (box.hidden !== on) return;
      box.hidden = !on;
      // A spin left behind must not hold the button on return.
      if (!on) {
        guard = createRestartGuard(() => performance.now(), 'spin');
        clearTimeout(armTimer);
        return;
      }
      if (held) paint(held);
      button.focus({ preventScroll: true });
    },
    dispose(): void {
      deck.removeEventListener('click', onCard);
      wheelGroup.removeEventListener('change', onPocket);
      stakeGroup.removeEventListener('change', onStakeChange);
      button.removeEventListener('click', onButton);
      button.removeEventListener('keydown', onButtonKey);
      clearTimeout(armTimer);
    },
  };
}
