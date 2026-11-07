import './styles.css';
import { showFallback } from './ui/fallback';

function fail(root: HTMLElement, error: unknown): void {
  console.error(error);
  showFallback(root, 'failed');
}

async function boot(root: HTMLElement): Promise<void> {
  try {
    // Loaded on demand so the first paint is the loading state, not a wait for Three.js.
    const [{ createStage }, { createEmptyView }] = await Promise.all([
      import('./render/stage'),
      import('./render/emptyView'),
    ]);
    const stage = createStage(root, createEmptyView, {
      adaptiveDpr: !navigator.webdriver,
      onFailure: (error) => fail(root, error),
    });
    if (stage) document.getElementById('status')?.remove();
    else showFallback(root, 'no-webgl');
  } catch (error) {
    fail(root, error);
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');
void boot(root);
