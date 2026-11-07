export type FallbackReason = 'no-webgl' | 'failed';

const FLAT_NOTE = 'This browser has no WebGL, so the building is drawn flat. The table still plays.';

const FAILED = {
  heading: 'The doors are stuck',
  body: 'The casino hit a fault and had to close. Check your connection and reload the page.',
};

/** Without WebGL the game stays: the notice goes in under the HUD and returns the surface it heads. */
export function showFallback(root: HTMLElement, reason: 'no-webgl', hud: HTMLElement): HTMLElement;
/** Replaces the page contents with a designed notice. */
export function showFallback(root: HTMLElement, reason: 'failed'): void;
export function showFallback(root: HTMLElement, reason: FallbackReason, hud?: HTMLElement): HTMLElement | void {
  if (reason === 'no-webgl' && hud) {
    const surface = document.createElement('section');
    surface.className = 'dc-flat';
    surface.setAttribute('aria-label', 'The flat table');
    const note = document.createElement('p');
    note.className = 'dc-flat-note';
    note.textContent = FLAT_NOTE;
    surface.append(note);
    root.insertBefore(surface, hud);
    return surface;
  }
  const { heading, body } = FAILED;
  const notice = document.createElement('section');
  notice.className = 'notice';

  const title = document.createElement('h1');
  title.textContent = 'The Impossible Casino';
  const subtitle = document.createElement('h2');
  subtitle.textContent = heading;
  const text = document.createElement('p');
  text.textContent = body;

  notice.append(title, subtitle, text);
  root.replaceChildren(notice);
}
