import './styles.css';
import './ui/hud.css';
import { createAudio } from './audio/audio';
import { createPrerunSource, loadExports } from './game/results';
import { STAKES } from './game/rules';
import { createGameStore } from './game/store';
import { showFallback } from './ui/fallback';
import { createHud, type HudAction } from './ui/hud';
import { dialStep } from './ui/lines';
import { chshReceipt } from './ui/receipt';
import { stakeChoices } from './ui/table';

/** The exported run the table plays. Noisy on purpose: it is the closest stand-in for a real chip. */
const RUN_ID = 'ibm-noise-model';

const FONTS = ['64px "Limelight"', '40px "Federo"', 'italic 20px "Bodoni Moda"'];
const FONT_WAIT_MS = 1400;

function fail(root: HTMLElement, error: unknown): void {
  console.error(error);
  showFallback(root, 'failed');
}

/** Fonts get printed into canvas textures, so wait briefly for them, but never hold the curtain. */
async function waitForFonts(): Promise<void> {
  try {
    await Promise.race([
      Promise.all(FONTS.map((font) => document.fonts.load(font))),
      new Promise((resolve) => {
        setTimeout(resolve, FONT_WAIT_MS);
      }),
    ]);
  } catch {
    // Fallback stacks are fine.
  }
}

async function boot(root: HTMLElement): Promise<void> {
  let close = (): void => undefined;
  try {
    // Loaded on demand so the first paint is the loading state, not a wait for Three.js.
    const [{ createStage }, { createDecoView, STAGE_LABELS }, exports] = await Promise.all([
      import('./render/stage'),
      import('./world/deco/view'),
      loadExports(),
      waitForFonts(),
    ]);
    const source = createPrerunSource(exports, RUN_ID);
    const store = createGameStore({ source });
    const audio = createAudio();
    const actions: Record<HudAction, () => void> = {
      deal: () => {
        store.deal();
      },
      entangle: () => {
        store.entangle();
      },
      run: () => {
        void store.run();
      },
      restart: () => {
        store.restart();
      },
    };
    const hud = createHud(root, {
      stages: STAGE_LABELS,
      dial: {
        min: source.dials[0] ?? 0,
        max: source.dials[source.dials.length - 1] ?? 1,
        step: dialStep(source.dials),
      },
      stakes: STAKES,
      onAction: (action) => {
        actions[action]();
      },
      onDial: (value) => {
        store.setDial(value);
        // The store can refuse or snap this value, and then it does not emit.
        hud.input.value = String(store.state.dial);
      },
      onStake: (value) => {
        store.setStake(value);
        // As with the dial, a refused stake does not emit.
        hud.stakes(stakeChoices(store.state, false), store.state.stake);
      },
      onSound: (on) => {
        audio.set(on);
      },
      onReceipt: () => {
        const { result, last } = store.state;
        return result ? chshReceipt(result, last, source.limits) : null;
      },
    });

    let closed = false;
    close = () => {
      if (closed) return;
      closed = true;
      hud.dispose();
      audio.dispose();
      store.dispose();
    };

    const stage = createStage(
      root,
      (renderer) =>
        createDecoView(renderer, {
          root,
          store,
          source,
          hud,
          audio,
          reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
          onDispose: close,
        }),
      {
        adaptiveDpr: !navigator.webdriver,
        onFailure: (error) => {
          fail(root, error);
        },
      },
    );
    if (stage) {
      document.getElementById('status')?.remove();
    } else {
      close();
      showFallback(root, 'no-webgl');
    }
  } catch (error) {
    close();
    fail(root, error);
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');
void boot(root);
