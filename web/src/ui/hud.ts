// The DOM over the film: brass plaques, a lift dial, intertitles, ticket stubs and a paper marker. A hotel floor indicator over a noir title card.
import type { CageBoard } from '../game/cage';
import { ROOM_LIST, colourLevel, colourStep, elevatorStops, nextStop, roomInfo } from '../game/rooms';
import type { RoomId } from '../game/rules';
import type { GameState } from '../game/store';
import { createCagePanel } from './cage-panel';
import type { Receipt } from './receipt';
import type { StakeChoice } from './table';

export type HudKey = 'bank' | 'delta' | 'rate' | 'hands' | 'limit' | 'even' | 'odds' | 'pays' | 'tt' | 'x' | 'y' | 'a' | 'b' | 'res' | 'amt';
export type HudAction = 'deal' | 'entangle' | 'run' | 'restart';
/** A room off the Tables, reached by the elevator. */
export type SideName = Exclude<RoomId, 'tables'>;

export interface HudButton {
  label: string;
  act?: HudAction;
  disabled?: boolean;
  brass?: boolean;
}

export interface HudOptions {
  stages: readonly string[];
  /** The slider's range and step, matching the exported dial grid. */
  dial: { min: number; max: number; step: number };
  stakes: readonly number[];
  onAction: (action: HudAction) => void;
  onDial: (value: number) => void;
  onStake: (value: number) => void;
  onSound: (on: boolean) => void;
  /** The marker for the room in view, or null when there is nothing to show. */
  onReceipt: (inCage: boolean) => Receipt | null;
  /** The Cage's board, read from the export. */
  cage: CageBoard;
  onForge: (length: number) => void;
}

export type Hud = ReturnType<typeof createHud>;

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag: string, attrs: Record<string, string | number>, parent?: Element | null, text?: string) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, String(attrs[k])); if (text != null) e.textContent = text; if (parent) parent.appendChild(e); return e; };
const LIFT_A = (i: number) => -76 + i * 38;   // stage angle in degrees either side of straight up
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };

export function createHud(root: HTMLElement, { stages, dial: dialRange, stakes, onAction, onDial, onStake, onSound, onReceipt, cage, onForge }: HudOptions) {
  root.classList.add('deco');
  root.dataset.colour = '0';

  const hud = el('div', 'dc-hud');
  const plaque = el('div', 'dc-plaque', `
    <div class="dc-cell"><div class="dc-k">Bankroll</div><div class="dc-v" data-v="bank"></div><div class="dc-s" data-v="delta">&nbsp;</div></div>
    <div class="dc-cell"><div class="dc-k">Win rate</div><div class="dc-v" data-v="rate"></div><div class="dc-s" data-v="hands"></div></div>
    <div class="dc-cell is-limit"><div class="dc-k">The limit</div><div class="dc-v" data-v="limit"></div><div class="dc-s" data-v="even"></div></div>`);
  const mid = el('div', 'dc-mid');
  const title = el('div', 'dc-title', `<h1>The Impossible <br>Casino</h1><p>Built inside a dilution refrigerator</p>`);
  const cagePanel = createCagePanel({ board: cage, stakes, onForge, onRestart: () => { onAction('restart'); }, onStake });
  mid.append(title, cagePanel.box);
  const ticket = el('div', 'dc-ticket', `<b data-v="tt">Hand</b>
    <div class="row"><span>Your question</span><span data-v="x"></span></div>
    <div class="row"><span>Theirs</span><span data-v="y"></span></div>
    <div class="row"><span>Your answer</span><span data-v="a"></span></div>
    <div class="row"><span>Theirs</span><span data-v="b"></span></div>
    <div class="res"><span data-v="res"></span><span data-v="amt"></span></div>`);
  const base = el('div', 'dc-base');
  const card = el('div', 'dc-card'); const line = el('p'); line.setAttribute('aria-live', 'polite'); card.appendChild(line);
  const sourceTag = el('div', 'dc-source'); sourceTag.hidden = true; card.appendChild(sourceTag);
  const dial = el('div', 'dc-dial', `<label for="dc-dial-input"><span>Your dial</span><output data-v="odds"></output></label>
    <input id="dc-dial-input" type="range" aria-label="Measurement angle dial">
    <div class="dc-stakes" role="radiogroup" aria-label="Stake per hand"><span>Stake</span>${stakes.map((value) => `<label class="dc-stake"><input type="radio" name="dc-stake" value="${value}"><span>${value.toLocaleString('en-US')}</span></label>`).join('')}<output data-v="pays"></output></div>`);
  const row = el('div', 'dc-row');
  const main = el('button', 'dc-btn'); main.type = 'button';
  const alt = el('button', 'dc-btn'); alt.type = 'button'; alt.hidden = true;
  row.append(main, alt);
  const stubs = el('div', 'dc-row');
  const receiptBtn = el('button', 'dc-stub', 'Receipt'); receiptBtn.type = 'button'; receiptBtn.disabled = true;
  const liftBtn = el('button', 'dc-stub dc-lift-stub', 'Elevator'); liftBtn.type = 'button'; liftBtn.setAttribute('aria-haspopup', 'dialog');
  const soundBtn = el('button', 'dc-stub', 'Sound off'); soundBtn.type = 'button'; soundBtn.setAttribute('aria-pressed', 'false');
  stubs.append(receiptBtn, liftBtn, soundBtn);
  stubs.classList.add('dc-stubs');
  base.append(card, dial, row);
  const lift = el('div', 'dc-lift'); lift.setAttribute('role', 'img');
  const face = svg('svg', { viewBox: '-150 -128 300 136', 'aria-hidden': 'true' }, lift);
  const defs = svg('defs', {}, face), lg = svg('linearGradient', { id: 'dcBrass', x1: '0', y1: '0', x2: '1', y2: '.3' }, defs);
  [['0', '#6f5426'], ['.3', '#f6e5ae'], ['.55', '#a9843a'], ['.8', '#fff0bd'], ['1', '#8a6b30']].forEach(([o = '', c = '']) => svg('stop', { offset: o, 'stop-color': c }, lg));
  for (let i = 0; i < 25; i++) { const a = (-84 + i * 7) * Math.PI / 180, r0 = 22, r1 = i % 2 ? 74 : 86;
    svg('path', { d: `M${r0 * Math.sin(a - .012)} ${-r0 * Math.cos(a - .012)} L${r1 * Math.sin(a - .05)} ${-r1 * Math.cos(a - .05)} L${r1 * Math.sin(a + .05)} ${-r1 * Math.cos(a + .05)} L${r0 * Math.sin(a + .012)} ${-r0 * Math.cos(a + .012)}Z`, fill: '#2a2110' }, face); }
  svg('path', { d: 'M-92.6 -22.1 A95 95 0 0 1 92.6 -22.1', fill: 'none', stroke: 'url(#dcBrass)', 'stroke-width': 3 }, face);
  const stageT = stages.map((label, i) => { const a = LIFT_A(i) * Math.PI / 180, x = Math.sin(a), y = -Math.cos(a);
    svg('line', { x1: 90 * x, y1: 90 * y, x2: 101 * x, y2: 101 * y, stroke: '#f6e5ae', 'stroke-width': 2.4 }, face);
    return svg('text', { class: 't', x: 108 * x + (i === 2 ? 0 : x * 4), y: 108 * y + (i === 2 ? -3 : 4), 'text-anchor': i < 2 ? 'end' : i > 2 ? 'start' : 'middle' }, face, label); });
  const arrow = svg('g', { class: 'dc-lift-g' }, face);
  svg('path', { d: 'M-5 0 L-1.4 -56 L-7 -62 L0 -88 L7 -62 L1.4 -56 L5 0Z', fill: 'url(#dcBrass)', stroke: '#000', 'stroke-width': .8 }, arrow);
  svg('circle', { r: 10, fill: 'url(#dcBrass)', stroke: '#000', 'stroke-width': .8 }, face);
  const tempEl = el('div', 'dc-temp');
  lift.appendChild(tempEl);
  hud.append(plaque, mid, base, stubs, ticket, lift);
  const hint = el('div', 'dc-hint');
  hud.appendChild(hint);

  const receipt = el('div', 'dc-receipt');
  receipt.setAttribute('role', 'dialog'); receipt.setAttribute('aria-modal', 'true'); receipt.setAttribute('aria-label', 'Casino marker with the Qiskit receipt');
  const marker = el('div', 'dc-marker');
  // Focusable so a keyboard can scroll a marker taller than the screen.
  marker.tabIndex = 0;
  const markerSub = el('p', 'sub'), circuitTitle = el('p', 'cap'), pre = el('pre'), circuitNote = el('p', 'cap'), details = el('dl'), stamp = el('span', 'dc-stamp');
  const close = el('button', 'dc-btn', 'Close marker'); close.type = 'button';
  marker.append(el('h2', '', 'Casino marker'), markerSub, circuitTitle, pre, circuitNote, details, stamp, close);
  receipt.append(marker);

  // The elevator: a floor panel over the film, every stop listed top to bottom of the fridge.
  const elevator = el('div', 'dc-receipt dc-elevator');
  elevator.setAttribute('role', 'dialog'); elevator.setAttribute('aria-modal', 'true'); elevator.setAttribute('aria-labelledby', 'dc-elevator-h');
  const car = el('div', 'dc-car', `<h2 id="dc-elevator-h">Elevator</h2><p class="sub">Any open floor, in any order.</p>`);
  const floors = el('div', 'dc-floors');
  const floorBtns = elevatorStops().map((room) => {
    const b = el('button', 'dc-floor'); b.type = 'button'; b.dataset.room = room.id;
    b.innerHTML = `<span class="dc-floor-k"></span><span class="dc-floor-n"></span><span class="dc-floor-t"></span>`;
    const [k, n, t] = b.children as unknown as [HTMLElement, HTMLElement, HTMLElement];
    k.textContent = room.stage; n.textContent = room.name;
    floors.appendChild(b);
    return { id: room.id, b, t };
  });
  const liftNote = el('p', 'dc-car-note');
  const stay = el('button', 'dc-btn', 'Stay on this floor'); stay.type = 'button';
  car.append(floors, liftNote, stay);
  elevator.append(car);

  root.append(hud, receipt, elevator);

  const v = new Map<string, HTMLElement>(); root.querySelectorAll<HTMLElement>('[data-v]').forEach((n) => { if (n.dataset.v) v.set(n.dataset.v, n); });
  const cache = new Map<string, string | number>();
  const put = (k: HudKey, s: string) => { if (cache.get(k) !== s) { cache.set(k, s); v.get(k)!.textContent = s; } };
  const input = dial.querySelector<HTMLInputElement>('#dc-dial-input')!;
  const stakeRow = dial.querySelector<HTMLElement>('.dc-stakes')!;
  const stakeInputs = [...stakeRow.querySelectorAll('input')];
  input.min = String(dialRange.min); input.max = String(dialRange.max); input.step = String(dialRange.step);

  let swapTimer = 0, room: SideName | null = null;
  let cleared: readonly RoomId[] = [], reachable: (id: RoomId) => boolean = () => true, liftOn = true, progressKey = '';
  const here = (): RoomId => room ?? 'tables';
  const canStop = (id: RoomId) => roomInfo(id).open && reachable(id);
  function say(text: string) {
    if (cache.get('say') === text) return; cache.set('say', text);
    clearTimeout(swapTimer); line.classList.add('is-swap');
    swapTimer = window.setTimeout(() => { line.textContent = text; line.classList.remove('is-swap'); }, line.textContent ? 170 : 0);
  }
  let mainAct: HudAction | undefined, altAct: HudAction | undefined, onSide: (name: SideName | 'back') => void = () => undefined;
  // aria-disabled, not disabled: a disabled button drops keyboard focus to the page, and Enter would stop working when the button comes back.
  function buttons(m: HudButton, a?: HudButton) {
    main.textContent = m.label; main.setAttribute('aria-disabled', String(!!m.disabled)); mainAct = m.disabled ? undefined : m.act;
    main.classList.toggle('is-brass', !!m.brass);
    const altHadFocus = document.activeElement === alt;
    alt.hidden = !a; if (a) { alt.textContent = a.label; alt.setAttribute('aria-disabled', String(!!a.disabled)); altAct = a.disabled ? undefined : a.act; } else if (altHadFocus) main.focus();
  }
  const clickMain = () => { if (mainAct) onAction(mainAct); };
  const clickAlt = () => { if (altAct) onAction(altAct); };
  const onInput = () => { onDial(+input.value); };
  const onStakeChange = (e: Event) => { if (e.target instanceof HTMLInputElement) onStake(+e.target.value); };
  const isOpen = () => receipt.classList.contains('is-on');
  const onReceiptOpen = () => {
    const data = onReceipt(room === 'cage');
    if (!data) return;
    markerSub.textContent = data.sub; circuitTitle.textContent = data.circuitTitle; pre.textContent = data.qasm; circuitNote.textContent = data.circuitNote; stamp.textContent = data.stamp;
    details.replaceChildren(...data.rows.flatMap(([k, value]) => { const a = el('dt'), b = el('dd'); a.textContent = k; b.textContent = value; return [a, b]; }));
    hud.inert = true; receipt.classList.add('is-on'); marker.scrollTop = 0; marker.focus({ preventScroll: true });
  };
  const onReceiptClose = () => { hud.inert = false; receipt.classList.remove('is-on'); receiptBtn.focus(); };
  // Only a press that starts on the backdrop closes it, so dragging a text selection off the paper does not.
  let downOnBackdrop = false;
  const onReceiptDown = (e: PointerEvent) => { downOnBackdrop = e.target === receipt; };
  const onBackdrop = (e: MouseEvent) => { if (downOnBackdrop && e.target === receipt) onReceiptClose(); };
  const isLiftOpen = () => elevator.classList.contains('is-on');
  /** The stops, the quiet hint on the stub and the panel, all from the cleared rooms. Nothing is forced. */
  const paintLift = () => {
    const next = nextStop(cleared, ROOM_LIST, reachable), at = here();
    for (const { id, b, t } of floorBtns) {
      const can = canStop(id), parts = [id === at ? 'You are here' : '', !can ? 'Not open yet' : '', can && cleared.includes(id) ? 'Cleared' : '', can && id === next && id !== at ? 'Suggested next' : ''].filter(Boolean);
      t.textContent = parts.join(' · ');
      b.setAttribute('aria-disabled', String(!can));
      if (id === at) b.setAttribute('aria-current', 'location'); else b.removeAttribute('aria-current');
      b.classList.toggle('is-next', can && id === next && id !== at);
    }
    const nextName = next ? roomInfo(next).name : '';
    liftNote.textContent = !next ? 'Every open floor is cleared. The house still takes bets on all of them.' : next === at ? 'You are on the suggested floor.' : `Suggested next: ${nextName}.`;
    const hint = !!next && next !== at;
    liftBtn.classList.toggle('is-next', hint);
    liftBtn.setAttribute('aria-label', hint ? `Elevator, suggested next: ${nextName}` : 'Elevator');
  };
  const onLiftOpen = () => {
    if (!liftOn || isLiftOpen() || isOpen()) return;
    paintLift();
    hud.inert = true; elevator.classList.add('is-on');
    const next = floorBtns.find((f) => f.b.classList.contains('is-next')) ?? floorBtns.find((f) => f.id === here());
    next?.b.focus({ preventScroll: true });
  };
  const closeLift = (refocus = true) => { if (!isLiftOpen()) return; hud.inert = false; elevator.classList.remove('is-on'); if (refocus) liftBtn.focus({ preventScroll: true }); };
  /** Glides to the stop. Focus lands on the room's first control, or back on the stub if the world said not now. */
  const travel = (id: RoomId) => {
    if (!canStop(id)) return;
    if (id === here()) { closeLift(); return; }
    closeLift(false);
    onSide(id === 'tables' ? 'back' : id);
    if (here() !== id) liftBtn.focus({ preventScroll: true });
    else if (id === 'tables') main.focus({ preventScroll: true });
    else if (!hud.contains(document.activeElement)) liftBtn.focus({ preventScroll: true });
  };
  const onFloor = (e: MouseEvent) => { const b = e.target instanceof Element ? e.target.closest<HTMLElement>('.dc-floor') : null; const id = floorBtns.find((f) => f.b === b)?.id; if (id) travel(id); };
  const onStay = () => { closeLift(); };
  let downOnLift = false;
  const onLiftDown = (e: PointerEvent) => { downOnLift = e.target === elevator; };
  const onLiftBackdrop = (e: MouseEvent) => { if (downOnLift && e.target === elevator) closeLift(); };
  const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; if (isOpen()) onReceiptClose(); else if (isLiftOpen()) closeLift(); else onSide('back'); };
  let soundOn = false;
  const onSnd = () => { soundOn = !soundOn; soundBtn.textContent = soundOn ? 'Sound on' : 'Sound off'; soundBtn.setAttribute('aria-pressed', String(soundOn)); onSound(soundOn); };
  main.addEventListener('click', clickMain); alt.addEventListener('click', clickAlt); input.addEventListener('input', onInput); stakeRow.addEventListener('change', onStakeChange);
  receiptBtn.addEventListener('click', onReceiptOpen); close.addEventListener('click', onReceiptClose); receipt.addEventListener('pointerdown', onReceiptDown); receipt.addEventListener('click', onBackdrop);
  liftBtn.addEventListener('click', onLiftOpen); floors.addEventListener('click', onFloor); stay.addEventListener('click', onStay); elevator.addEventListener('pointerdown', onLiftDown); elevator.addEventListener('click', onLiftBackdrop); soundBtn.addEventListener('click', onSnd);
  // On the document, so Escape still works after a click on the canvas leaves focus on the page.
  document.addEventListener('keydown', onKey);

  return {
    put, say, buttons, input, hud,
    /** The caption card under the table, which also holds the source line. */
    card,
    /** The world answers the side-room buttons once it exists. */
    setSide(fn: (name: SideName | 'back') => void) { onSide = fn; },
    gauge(label: string, frac: number, here: number) {
      if (cache.get('t') !== label) { cache.set('t', label); tempEl.textContent = label; lift.setAttribute('aria-label', `Lift dial: ${label}`); }
      const rot = Math.round(frac * 152 - 76);
      if (cache.get('rot') !== rot) { cache.set('rot', rot); arrow.style.transform = `rotate(${rot}deg)`; }
      if (cache.get('here') !== here) { cache.set('here', here); stageT.forEach((t, i) => t.classList.toggle('is-here', i === here)); }
    },
    stubs(on: boolean, hasReceipt: boolean) {
      if (liftOn !== on) { liftOn = on; liftBtn.setAttribute('aria-disabled', String(!on)); if (!on) closeLift(); }
      receiptBtn.disabled = !(on && hasReceipt);
    },
    /** Which rooms this surface can show. The Cage is a panel, so it works without a building. */
    rooms(can: (id: RoomId) => boolean) { reachable = can; progressKey = ''; paintLift(); },
    /** The cleared rooms set the colour of the HUD and the elevator's hint. */
    progress(done: readonly RoomId[]) {
      const key = done.join();
      if (key === progressKey) return;
      progressKey = key; cleared = [...done];
      root.dataset.colour = String(colourStep(cleared)); root.style.setProperty('--dc-wash', String(colourLevel(cleared)));
      paintLift();
    },
    source(text: string | null) { const s = text ?? ''; if (cache.get('source') !== s) { cache.set('source', s); sourceTag.textContent = s; sourceTag.hidden = !s; } },
    title(on: boolean) { title.classList.toggle('is-gone', !on); },
    dial(on: boolean) { dial.classList.toggle('is-on', on); },
    dialLocked(on: boolean) { input.disabled = on; },
    stakes(choices: readonly StakeChoice[], stake: number) { stakeInputs.forEach((box, i) => { box.checked = +box.value === stake; box.disabled = !!choices[i]?.disabled; }); },
    ticket(on: boolean) { ticket.classList.toggle('is-on', on); },
    colour(on: boolean) { root.classList.toggle('is-colour', on); },
    side(name: SideName | null) {
      const focused = cagePanel.box.contains(document.activeElement);
      room = name; root.classList.toggle('is-side', !!name); root.classList.toggle('is-cage', name === 'cage'); cagePanel.show(name === 'cage');
      if (focused && name !== 'cage') liftBtn.focus({ preventScroll: true });
      paintLift();
    },
    /** Hands the panel the game. Called on every store change, in or out of the room. */
    cage(s: GameState) { cagePanel.sync(s); },
    hot(on: boolean) { root.querySelector('canvas')?.classList.toggle('is-hot', on); hint.classList.toggle('is-on', on); },
    hint(text: string, x: number, y: number) { hint.textContent = text; hint.style.left = `${x}px`; hint.style.top = `${y}px`; },
    dispose() {
      clearTimeout(swapTimer); cagePanel.dispose();
      main.removeEventListener('click', clickMain); alt.removeEventListener('click', clickAlt); input.removeEventListener('input', onInput); stakeRow.removeEventListener('change', onStakeChange);
      receiptBtn.removeEventListener('click', onReceiptOpen); close.removeEventListener('click', onReceiptClose); receipt.removeEventListener('pointerdown', onReceiptDown); receipt.removeEventListener('click', onBackdrop);
      liftBtn.removeEventListener('click', onLiftOpen); floors.removeEventListener('click', onFloor); stay.removeEventListener('click', onStay); elevator.removeEventListener('pointerdown', onLiftDown); elevator.removeEventListener('click', onLiftBackdrop); soundBtn.removeEventListener('click', onSnd);
      document.removeEventListener('keydown', onKey);
      hud.remove(); receipt.remove(); elevator.remove(); root.classList.remove('deco', 'is-colour', 'is-side', 'is-cage');
      delete root.dataset.colour; root.style.removeProperty('--dc-wash');
    },
  };
}
