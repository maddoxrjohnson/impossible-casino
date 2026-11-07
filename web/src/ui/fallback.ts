export type FallbackReason = 'no-webgl' | 'failed';

const MESSAGES: Record<FallbackReason, { heading: string; body: string }> = {
  'no-webgl': {
    heading: 'The lights are out',
    body: 'The casino is drawn with WebGL 2, and this browser cannot start it. Turn on hardware acceleration, or open the link in a current version of Chrome, Edge, Firefox or Safari.',
  },
  failed: {
    heading: 'The doors are stuck',
    body: 'The casino hit a fault and had to close. Check your connection and reload the page.',
  },
};

/** Replaces the page contents with a designed notice. */
export function showFallback(root: HTMLElement, reason: FallbackReason): void {
  const { heading, body } = MESSAGES[reason];
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
