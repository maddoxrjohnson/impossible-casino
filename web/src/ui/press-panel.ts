// The owner's chip press under the table's caption: a passphrase field, one button and a status line. Hidden from everyone else.
import { PRESS_DIAL, type ChipPress, type PressState } from '../game/press';

export function pressLine(s: PressState): string {
  switch (s.kind) {
    case 'idle':
      return '';
    case 'sending':
      return 'Sending to IBM…';
    case 'queued':
      return `Queued on ${s.backend ?? 'the IBM chip'}. Keep playing; the queue can take half an hour.`;
    case 'running':
      return `Running on ${s.backend ?? 'the IBM chip'}.`;
    case 'done':
      return `Done. Dial ${String(PRESS_DIAL)} now plays IBM chip job ${s.jobId}.`;
    case 'ended':
      if (s.outcome === 'cancelled') return 'IBM cancelled the chip run. Nothing from it was played.';
      if (s.outcome === 'gone') return 'That chip run is no longer available.';
      return 'The chip run failed. Nothing from it was played.';
    case 'refused':
      return s.message;
  }
}

const busy = (s: PressState): boolean => s.kind === 'sending' || s.kind === 'queued' || s.kind === 'running';

/** `owner` shows the form. Without it, only the status of a job left from an earlier visit shows. */
export function createPressPanel(press: ChipPress, owner: boolean) {
  const box = document.createElement('div');
  box.className = 'dc-press';
  box.innerHTML = `<form class="dc-press-form"><input type="password" autocomplete="off" spellcheck="false" maxlength="256" aria-label="Chip passphrase" placeholder="Passphrase"><button type="submit" class="dc-stub">Run on IBM chip</button></form><div class="dc-source dc-press-line" role="status"></div>`;
  const form = box.querySelector('form') as HTMLFormElement;
  const field = box.querySelector('input') as HTMLInputElement;
  const button = box.querySelector('button') as HTMLButtonElement;
  const line = box.querySelector('.dc-press-line') as HTMLElement;
  form.hidden = !owner || !press.available;

  const paint = (s: PressState): void => {
    // aria-disabled, not disabled, so focus stays on the button while the job waits.
    button.setAttribute('aria-disabled', String(busy(s)));
    line.textContent = press.available ? pressLine(s) : 'No casino service is set for this site, so chip runs are off.';
    box.hidden = !owner && s.kind === 'idle';
  };

  const onSubmit = (e: SubmitEvent): void => {
    e.preventDefault();
    if (busy(press.state) || field.value === '') return;
    const passphrase = field.value;
    field.value = '';
    void press.press(passphrase);
  };
  form.addEventListener('submit', onSubmit);
  const unsubscribe = press.subscribe(paint);
  paint(press.state);

  return {
    box,
    dispose(): void {
      form.removeEventListener('submit', onSubmit);
      unsubscribe();
      box.remove();
    },
  };
}
