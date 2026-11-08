// The Roulette Wheel on the HUD: the draft, the wheel and the bet beside the door. The words and numbers come from roulette-view.
import type { RouletteBoard, RouletteSpin } from '../game/roulette';
import { ROULETTE_POCKETS } from '../game/results';
import type { GameState } from '../game/store';
import { RESTART_ARM_MS, createRestartGuard } from './cage-view';
import { rouletteView, type RouletteButton, type RouletteText } from './roulette-view';
import { ballAt, pocketAngle, pocketPath, radialTurn, REST_R, rollPlan, wheelPoint, type RollPlan } from './roulette-wheel';

export interface RoulettePanelOptions {
  board: RouletteBoard;
  text: RouletteText;
  stakes: readonly number[];
  onOpen: () => void;
  onPlay: (card: number) => void;
  onSpin: (pocket: number) => void;
  onRestart: () => void;
  onStake: (value: number) => void;
  /** What of the state to show. The ball follows the store's spin, and the rest of the panel waits for it here. */
  shown?: (s: GameState) => GameState;
  /** The ball has come to rest on `spin`, or was placed there at once with no roll. */
  onLanded?: (spin: RouletteSpin) => void;
}

/** The pocket ring, the label radii and the hub, in wheel units: the wheel is 200 across. */
const RING_IN = 50, RING_OUT = 88, NUM_R = 75, ODDS_R = 60.5, HUB_R = 46;
const BRASS_STOPS = [['0', '#6f5426'], ['.3', '#f6e5ae'], ['.55', '#a9843a'], ['.8', '#fff0bd'], ['1', '#8a6b30']];

/** The wheel's face. Drawn once; the panel only moves classes, the glow and the ball. */
function wheelSvg(count: number): string {
  const all = Array.from({ length: count }, (_, n) => n);
  const rays = Array.from({ length: 16 }, (_, i) => { const a = wheelPoint(i * 22.5, 15), b = wheelPoint(i * 22.5, HUB_R - 3); return `<line x1="${a.x.toFixed(2)}" y1="${a.y.toFixed(2)}" x2="${b.x.toFixed(2)}" y2="${b.y.toFixed(2)}"/>`; }).join('');
  const odds = all.map((n) => { const deg = pocketAngle(n, count), at = wheelPoint(deg, ODDS_R); return `<text class="dc-rl-odds" transform="translate(${at.x.toFixed(2)} ${at.y.toFixed(2)}) rotate(${radialTurn(deg)})"></text>`; }).join('');
  return `<svg viewBox="-100 -100 200 200" aria-hidden="true" focusable="false">
    <defs><linearGradient id="dcRlBrass" x1="0" y1="0" x2="1" y2=".3">${BRASS_STOPS.map(([o = '', c = '']) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>
      <filter id="dcRlGlow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3.2"/></filter></defs>
    <circle class="dc-rl-rim" r="99"/><circle class="dc-rl-rim is-thin" r="95.6"/>
    <g class="dc-rl-glow" filter="url(#dcRlGlow)">${all.map((n) => `<path d="${pocketPath(n, count, RING_IN, RING_OUT)}"/>`).join('')}</g>
    <g class="dc-rl-slots">${all.map((n) => `<path class="dc-rl-slot" data-pocket="${n}" d="${pocketPath(n, count, RING_IN, RING_OUT)}"/>`).join('')}</g>
    <circle class="dc-rl-rim is-thin" r="${RING_OUT}"/><circle class="dc-rl-rim is-thin" r="${RING_IN}"/>
    <g class="dc-rl-nums">${all.map((n) => `<text class="dc-rl-num" transform="rotate(${pocketAngle(n, count)}) translate(0 ${-NUM_R})">${n}</text>`).join('')}</g>
    <g class="dc-rl-oddsg">${odds}</g>
    <path class="dc-rl-mark is-landed" d=""/><path class="dc-rl-mark is-focus" d=""/>
    <g class="dc-rl-hub"><circle r="${HUB_R}"/><g class="dc-rl-rays">${rays}</g><circle class="dc-rl-boss" r="15"/>
      <text class="dc-rl-hub-n" y="-1"></text><text class="dc-rl-hub-s" y="26"></text></g>
    <g class="dc-rl-ball"><circle r="3.1"/></g>
  </svg>`;
}

export function createRoulettePanel({ board, text, stakes, onOpen, onPlay, onSpin, onRestart, onStake, shown: showState = (s) => s, onLanded = () => undefined }: RoulettePanelOptions) {
  const box = document.createElement('section');
  box.className = 'dc-roulette';
  box.setAttribute('aria-label', 'The Roulette Wheel');
  box.hidden = true;
  box.innerHTML = `<h2>Gather the wheel</h2><p class="dc-cage-goal"></p>
    <ol class="dc-rl-draft" aria-label="Cards drafted"></ol>
    <div class="dc-rl-play">
      <div class="dc-rl-deck" role="group" aria-label="The deck">${board.deck.map((_, i) => `<button type="button" class="dc-rl-card" data-card="${i}"></button>`).join('')}</div>
      <div class="dc-rl-side"><p class="dc-rl-turn" role="status"><span></span><b></b></p><p class="dc-rl-last" aria-live="polite"></p></div>
      <div class="dc-rl-wheel" role="radiogroup" aria-label="Pocket to bet on">${wheelSvg(ROULETTE_POCKETS)}${Array.from({ length: ROULETTE_POCKETS }, (_, n) => `<label class="dc-rl-pocket"><input type="radio" name="dc-rl-pocket" value="${n}"><span>${n}</span></label>`).join('')}</div>
    </div>
    <div class="dc-rl-foot">
      <div class="dc-stakes" role="radiogroup" aria-label="Stake on this round"><span>Stake</span>${stakes.map((value) => `<label class="dc-stake"><input type="radio" name="dc-rl-stake" value="${value}"><span>${value.toLocaleString('en-US')}</span></label>`).join('')}</div>
      <div class="dc-cage-act"><button type="button" class="dc-btn"></button><div class="dc-cage-result" role="status"><b></b><span></span></div></div>
    </div>
    <dl class="dc-rl-rows"></dl>
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
  const pockets = [...wheelGroup.querySelectorAll<HTMLLabelElement>('.dc-rl-pocket')].map((label) => ({ label, input: label.querySelector('input') as HTMLInputElement }));
  const slots = [...wheelGroup.querySelectorAll<SVGPathElement>('.dc-rl-slot')];
  const glows = [...wheelGroup.querySelectorAll<SVGPathElement>('.dc-rl-glow path')];
  const nums = [...wheelGroup.querySelectorAll<SVGTextElement>('.dc-rl-num')];
  const oddsText = [...wheelGroup.querySelectorAll<SVGTextElement>('.dc-rl-odds')];
  const landedMark = q<SVGPathElement>('.dc-rl-mark.is-landed');
  const focusMark = q<SVGPathElement>('.dc-rl-mark.is-focus');
  const hubN = q<SVGTextElement>('.dc-rl-hub-n');
  const hubS = q<SVGTextElement>('.dc-rl-hub-s');
  const ball = q<SVGGElement>('.dc-rl-ball');
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
  // The ball only shows the spin the store already settled. It never picks a pocket.
  let seenSpin: RouletteSpin | null = null;
  let roll: { plan: RollPlan; t0: number } | null = null;
  let rollFrame = 0;
  let ballDeg = 0;
  let focused: number | null = null;
  const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const placeBall = (deg: number, r: number): void => { ball.setAttribute('transform', `rotate(${deg.toFixed(2)}) translate(0 ${(-r).toFixed(2)})`); };
  const stopRoll = (): void => { cancelAnimationFrame(rollFrame); roll = null; };
  const tick = (now: number): void => {
    if (!roll) return;
    const at = ballAt(roll.plan, now - roll.t0);
    placeBall(at.deg, at.r);
    if (!at.done) { rollFrame = requestAnimationFrame(tick); return; }
    ballDeg = at.deg;
    roll = null;
    if (seenSpin) onLanded(seenSpin);
    if (held) paint(held);
  };
  /** Follows the store's spin: a new one rolls the ball to its landed pocket, none parks it out of sight. */
  const follow = (spin: RouletteSpin | null): void => {
    if (spin === seenSpin) return;
    seenSpin = spin;
    stopRoll();
    ball.classList.toggle('is-on', !!spin);
    if (!spin) return;
    const plan = rollPlan(spin.landed, ROULETTE_POCKETS, ballDeg, reduced());
    if (plan.ms === 0) { ballDeg = plan.to; placeBall(plan.to, REST_R); onLanded(spin); return; }
    roll = { plan, t0: performance.now() };
    placeBall(plan.from, ballAt(plan, 0).r);
    rollFrame = requestAnimationFrame(tick);
  };
  const markFocus = (): void => {
    focusMark.setAttribute('d', focused === null ? '' : pocketPath(focused, ROULETTE_POCKETS, RING_IN, RING_OUT));
  };

  const paint = (state: GameState): void => {
    // A new draft starts with no pocket picked.
    if (state.roulette?.turn !== 'spin') picked = null;
    follow(state.roulette?.spin ?? null);
    const rolling = roll !== null;
    // Until the ball lands, the panel reads as it did before the spin: the goal, the button, the stakes and the rows.
    const s = showState(state);
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
    let landedAt: number | null = null, betAt: number | null = null;
    view.pockets.forEach((p, i) => {
      const dom = pockets[i], slot = slots[i], glow = glows[i], num = nums[i], odds = oddsText[i];
      if (!dom || !slot || !glow || !num || !odds) return;
      dom.input.checked = p.picked;
      // Until the ball rests, the labels still read as before the spin.
      if (!rolling) dom.input.setAttribute('aria-label', p.label);
      dom.input.setAttribute('aria-disabled', String(locked));
      const lit = p.level.toFixed(3);
      slot.style.setProperty('--lit', lit); glow.style.setProperty('--lit', lit);
      odds.textContent = p.short;
      const empty = p.chance <= 0;
      for (const n of [slot, num, odds]) { n.classList.toggle('is-empty', empty); n.classList.toggle('is-bet', p.picked); }
      if (p.picked) betAt = p.pocket;
      if (p.landed) landedAt = p.pocket;
    });
    const shown = rolling ? null : landedAt;
    landedMark.setAttribute('d', shown === null ? '' : pocketPath(shown, ROULETTE_POCKETS, RING_IN, RING_OUT));
    wheelGroup.classList.toggle('is-won', shown !== null && shown === betAt);
    const spin = s.roulette?.spin;
    const litCount = view.pockets.filter((p) => p.chance > 0).length;
    const betOdds = betAt === null ? '' : view.pockets[betAt]?.odds ?? '';
    const [hubNum, hubSub] = spin && !rolling ? [String(spin.landed), spin.won ? 'won' : `lost, bet ${spin.pocket}`]
      : betAt !== null ? [String(betAt), rolling ? 'your bet' : `bet, ${betOdds}`]
      : [String(litCount), litCount === 1 ? 'pocket lit' : 'pockets lit'];
    hubN.textContent = hubNum; hubS.textContent = hubSub;
    const key = view.rows.map(([k, v]) => `${k}:${v}`).join('|');
    if (key !== rowsKey) {
      rowsKey = key;
      rows.replaceChildren(...view.rows.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
    }
    stakeInputs.forEach((input, i) => { input.checked = +input.value === s.stake; input.disabled = !!view.stakes[i]?.disabled; });
    button.textContent = view.button.label;
    guard.see(view.button.act);
    const off = view.button.disabled || guard.holding() || rolling;
    button.setAttribute('aria-disabled', String(off));
    clearTimeout(armTimer);
    if (guard.holding()) armTimer = window.setTimeout(() => { if (held) paint(held); }, RESTART_ARM_MS);
    button.classList.toggle('is-brass', view.button.brass);
    act = off ? null : view.button.act;
    // The result reads out as the ball rests, not before.
    const told = rolling ? null : view.result;
    result.classList.toggle('is-won', !!told?.won);
    head.textContent = told?.head ?? '';
    detail.textContent = told?.detail ?? '';
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
  // A click on the drawn pocket is a click on its radio, so the radios stay the one way to bet.
  const onSlot = (e: MouseEvent): void => {
    const slot = e.target instanceof Element ? e.target.closest<SVGPathElement>('.dc-rl-slot') : null;
    const input = slot ? pockets[+(slot.dataset.pocket ?? -1)]?.input : undefined;
    if (!input) return;
    input.click();
    input.focus({ preventScroll: true });
  };
  // The radios are out of sight, so a keyboard focus ring is drawn on the wheel instead.
  const onFocusIn = (e: FocusEvent): void => {
    focused = e.target instanceof HTMLInputElement && e.target.name === 'dc-rl-pocket' && e.target.matches(':focus-visible') ? +e.target.value : null;
    markFocus();
  };
  const onFocusOut = (): void => { focused = null; markFocus(); };
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
  wheelGroup.addEventListener('click', onSlot);
  wheelGroup.addEventListener('focusin', onFocusIn);
  wheelGroup.addEventListener('focusout', onFocusOut);
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
        stopRoll();
        return;
      }
      if (held) paint(held);
      button.focus({ preventScroll: true });
    },
    dispose(): void {
      deck.removeEventListener('click', onCard);
      wheelGroup.removeEventListener('change', onPocket);
      wheelGroup.removeEventListener('click', onSlot);
      wheelGroup.removeEventListener('focusin', onFocusIn);
      wheelGroup.removeEventListener('focusout', onFocusOut);
      stakeGroup.removeEventListener('change', onStakeChange);
      button.removeEventListener('click', onButton);
      button.removeEventListener('keydown', onButtonKey);
      clearTimeout(armTimer);
      stopRoll();
    },
  };
}
