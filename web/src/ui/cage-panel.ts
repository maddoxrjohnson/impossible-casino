// The Cashier's Cage on the HUD: a teller's board over the camera's view of the door. The words and numbers come from cage-view.
import type { CageBoard } from '../game/cage';
import type { GameState } from '../game/store';
import { RESTART_ARM_MS, cageView, createRestartGuard } from './cage-view';

export interface CagePanelOptions {
  board: CageBoard;
  stakes: readonly number[];
  onForge: (length: number) => void;
  onRestart: () => void;
  onStake: (value: number) => void;
}

export function createCagePanel({ board, stakes, onForge, onRestart, onStake }: CagePanelOptions) {
  const box = document.createElement('section');
  box.className = 'dc-cage';
  box.setAttribute('aria-label', "The Cashier's Cage");
  box.hidden = true;
  box.innerHTML = `<h2>Forge a chip</h2><p class="dc-cage-goal"></p>
    <div class="dc-cage-head" aria-hidden="true"><span>Qubits</span><span>This run</span><span>Proven limit</span><span>Pays</span></div>
    <div class="dc-cage-rows" role="radiogroup" aria-label="Chip length">${board.rows.map(({ length }) => `<label class="dc-cage-row"><input type="radio" name="dc-cage-length" value="${length}"><span>${length}</span><span></span><span></span><span></span></label>`).join('')}</div>
    <div class="dc-stakes" role="radiogroup" aria-label="Stake on this forge"><span>Stake</span>${stakes.map((value) => `<label class="dc-stake"><input type="radio" name="dc-cage-stake" value="${value}"><span>${value.toLocaleString('en-US')}</span></label>`).join('')}</div>
    <div class="dc-cage-act"><button type="button" class="dc-btn"></button><div class="dc-cage-result" role="status"><b></b><span></span></div></div>
    <p class="dc-cage-note"></p>
    <p class="dc-source dc-cage-source"></p>`;

  const rows = [...box.querySelectorAll<HTMLLabelElement>('.dc-cage-row')].map((label) => {
    const [input, , pass, limit, pays] = label.children;
    return { input: input as HTMLInputElement, pass: pass as HTMLElement, limit: limit as HTMLElement, pays: pays as HTMLElement };
  });
  const lengthGroup = box.querySelector('.dc-cage-rows') as HTMLElement;
  const stakeGroup = box.querySelector('.dc-stakes') as HTMLElement;
  const stakeInputs = [...stakeGroup.querySelectorAll('input')];
  const button = box.querySelector('.dc-btn') as HTMLButtonElement;
  const goal = box.querySelector('.dc-cage-goal') as HTMLElement;
  const result = box.querySelector('.dc-cage-result') as HTMLElement;
  const head = result.querySelector('b') as HTMLElement;
  const detail = result.querySelector('span') as HTMLElement;
  const note = box.querySelector('.dc-cage-note') as HTMLElement;
  const sourceTag = box.querySelector('.dc-cage-source') as HTMLElement;

  let length = board.rows[0]?.length ?? 1;
  let held: GameState | null = null;
  let act: 'forge' | 'restart' | null = null;
  let armTimer = 0;
  const guard = createRestartGuard(() => performance.now());

  const paint = (s: GameState): void => {
    const view = cageView(s, board);
    view.rows.forEach((row, i) => {
      const dom = rows[i];
      if (!dom) return;
      dom.input.checked = row.length === length;
      dom.input.setAttribute('aria-label', row.label);
      dom.pass.textContent = row.pass; dom.limit.textContent = row.limit; dom.pays.textContent = row.pays;
    });
    stakeInputs.forEach((input, i) => { input.checked = +input.value === s.stake; input.disabled = !!view.stakes[i]?.disabled; });
    goal.textContent = view.goal;
    note.textContent = view.note;
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
    sourceTag.textContent = view.sources.join(' · ');
  };

  const onLength = (e: Event): void => { if (e.target instanceof HTMLInputElement) length = +e.target.value; };
  const onStakeChange = (e: Event): void => { if (e.target instanceof HTMLInputElement) onStake(+e.target.value); };
  // A second click of a double-click is the same gesture, and must not stake again.
  const onButton = (e: MouseEvent): void => {
    if (e.detail > 1) return;
    if (act === 'forge') onForge(length); else if (act === 'restart') onRestart();
  };
  // A held key is one press, so it cannot chain forges into a restart.
  const onButtonKey = (e: KeyboardEvent): void => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); };
  lengthGroup.addEventListener('change', onLength);
  stakeGroup.addEventListener('change', onStakeChange);
  button.addEventListener('click', onButton);
  button.addEventListener('keydown', onButtonKey);

  return {
    box,
    /** Nothing is written while the panel is shut, so a run at the table costs nothing here. */
    sync(s: GameState): void {
      held = s;
      if (!box.hidden) paint(s);
    },
    show(on: boolean): void {
      if (box.hidden !== on) return;
      box.hidden = !on;
      if (!on) return;
      if (held) paint(held);
      rows.find((row) => row.input.checked)?.input.focus({ preventScroll: true });
    },
    dispose(): void {
      lengthGroup.removeEventListener('change', onLength);
      stakeGroup.removeEventListener('change', onStakeChange);
      button.removeEventListener('click', onButton);
      button.removeEventListener('keydown', onButtonKey);
      clearTimeout(armTimer);
    },
  };
}
