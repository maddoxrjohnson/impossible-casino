import './styles.css';
import './ui/hud.css';
import { createAudio } from './audio/audio';
import { cageBoard, type ForgeAttempt } from './game/cage';
import { withChipRuns } from './game/chip';
import { createLiveSource } from './game/live';
import { createPrerunSource, loadExports } from './game/results';
import { STAKES } from './game/rules';
import { createGameStore } from './game/store';
import { showFallback } from './ui/fallback';
import { createFlatTable } from './ui/flat';
import { createHud, type HudAction } from './ui/hud';
import { dialStep } from './ui/lines';
import { markerFor } from './ui/receipt';
import { stakeChoices } from './ui/table';

/** The exported run the table plays where it has no chip data. Noisy on purpose: it is the closest stand-in for a real chip. */
const RUN_ID = 'ibm-noise-model';

const FONTS = ['64px "Limelight"', '40px "Federo"', 'italic 20px "Bodoni Moda"'];
const FONT_SHEET =
  'https://fonts.googleapis.com/css2?family=Bodoni+Moda:ital,opsz,wght@0,6..96,400;0,6..96,600;1,6..96,400;1,6..96,500&family=Courier+Prime:wght@400;700&family=Federo&family=Limelight&display=swap';
const FONT_WAIT_MS = 1400;

function fail(root: HTMLElement, error: unknown): void {
  console.error(error);
  showFallback(root, 'failed');
}

/**
 * Added from here so a hung font host cannot hold the first paint. Settles on
 * success or failure. The link stays in the page, so a sheet that arrives late
 * still restyles DOM text.
 */
function loadFontSheet(): Promise<void> {
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONT_SHEET;
    link.onload = link.onerror = () => {
      resolve();
    };
    document.head.append(link);
  });
}

/** Fonts get printed into canvas textures, so wait briefly for them, but never hold the curtain. */
async function waitForFonts(): Promise<void> {
  try {
    await Promise.race([
      // Before the sheet is in, document.fonts.load resolves empty.
      loadFontSheet().then(() => Promise.all(FONTS.map((font) => document.fonts.load(font)))),
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
    const live = createLiveSource(createPrerunSource(exports, RUN_ID), { url: import.meta.env.VITE_API_URL as string | undefined });
    void live.warm();
    const source = withChipRuns(live, exports);
    const store = createGameStore({ source });
    const audio = createAudio();
    const cage = cageBoard(exports.wiesner, RUN_ID);
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
        hud.stakes(stakeChoices(store.state, store.state.forging), store.state.stake);
        hud.cage(store.state);
      },
      onSound: (on) => {
        audio.set(on);
      },
      onReceipt: (inCage) => markerFor(store.state, inCage, source.limits, cage),
      cage,
      onForge: (length) => {
        void store.forge(length, cage.payoutStake);
      },
    });
    let heard: ForgeAttempt | null = null;
    store.subscribe((state) => {
      hud.cage(state);
      if (state.forge && state.forge !== heard) audio.tick(state.forge.passed);
      heard = state.forge;
    });

    let closed = false;
    let closeFlat = (): void => undefined;
    close = () => {
      if (closed) return;
      closed = true;
      closeFlat();
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
        perf: new URLSearchParams(location.search).has('perf'),
        perfMoment: () => {
          const { phase, autoplaying, rounds } = store.state;
          return `${phase}${autoplaying ? ' running' : ''} hand ${String(rounds)}`;
        },
        onFailure: (error) => {
          fail(root, error);
        },
      },
    );
    document.getElementById('status')?.remove();
    if (!stage) {
      closeFlat = createFlatTable(root, { store, source, hud, audio, stages: STAGE_LABELS });
    }
  } catch (error) {
    close();
    fail(root, error);
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');
void boot(root);
