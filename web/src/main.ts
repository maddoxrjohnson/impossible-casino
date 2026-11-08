import './styles.css';
import './ui/hud.css';
import { createAudio } from './audio/audio';
import { ambienceFor, cuesFor, type CueState } from './audio/cues';
import { cageBoard } from './game/cage';
import { withChipRuns } from './game/chip';
import { createLiveSource } from './game/live';
import { createChipPress, pressStorage, withPressedRun } from './game/press';
import { createPrerunSource, loadExports, loadRoulette } from './game/results';
import { playedRunId, rouletteBoard } from './game/roulette';
import { STAKES } from './game/rules';
import { createGameStore } from './game/store';
import { showFallback } from './ui/fallback';
import { expertSheet } from './ui/expert';
import { createFlatTable } from './ui/flat';
import { createHud, type HudAction } from './ui/hud';
import { dialStep } from './ui/lines';
import { createPressPanel } from './ui/press-panel';
import { markerFor } from './ui/receipt';
import { ROLL_MS } from './ui/roulette-wheel';
import { createSpinReveal } from './ui/spin-reveal';
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
    const [{ createStage }, { createDecoView, STAGE_LABELS }, exports, rouletteExport] = await Promise.all([
      import('./render/stage'),
      import('./world/deco/view'),
      loadExports(),
      loadRoulette(),
      waitForFonts(),
    ]);
    const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
    const live = createLiveSource(createPrerunSource(exports, RUN_ID), { url: apiUrl });
    void live.warm();
    const press = createChipPress({ url: apiUrl, storage: pressStorage() });
    // A pressed chip result sits over the exported chip runs, at its one dial.
    const source = withPressedRun(withChipRuns(live, exports), exports, () => press.result());
    const store = createGameStore({ source });
    const audio = createAudio();
    // A spin settles in the store at once; the HUD, the sound and the rest of the panel show it as the panel's ball lands.
    const reveal = createSpinReveal({ rollMs: () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ROLL_MS) });
    const cage = cageBoard(exports.wiesner, RUN_ID);
    const wheel = rouletteBoard(rouletteExport, playedRunId(rouletteExport));
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
        const shown = reveal.shown(store.state);
        hud.stakes(stakeChoices(shown, shown.forging), shown.stake);
        hud.cage(store.state);
        hud.roulette(store.state);
      },
      onSound: (on) => {
        audio.set(on);
      },
      onReceipt: (room) => markerFor(reveal.shown(store.state), room, source.limits, cage, wheel),
      onExpert: (room) => expertSheet(room, reveal.shown(store.state), { chsh: exports.chsh, wiesner: exports.wiesner, roulette: rouletteExport, wheel }),
      cage,
      onForge: (length) => {
        void store.forge(length, cage.payoutStake);
      },
      roulette: {
        board: wheel,
        text: rouletteExport,
        onOpen: () => {
          store.rouletteOpen(wheel);
        },
        onPlay: (card) => {
          store.roulettePlay(wheel, card);
        },
        onSpin: (pocket) => {
          store.rouletteSpin(wheel, pocket);
        },
        onLeave: () => {
          store.rouletteLeave();
        },
        shown: reveal.shown,
        onLanded: (spin) => {
          reveal.land(spin);
        },
      },
    });
    // Only the owner's ?owner visit shows the button. A job left from one still shows its status.
    const pressPanel = createPressPanel(press, new URLSearchParams(location.search).has('owner'));
    hud.card.append(pressPanel.box);
    // The pressed result changes what the dial previews at its dial, and under which label.
    let pressed = press.result();
    press.subscribe(() => {
      if (press.result() === pressed) return;
      pressed = press.result();
      store.refreshPreview();
    });
    press.resume();
    // The store mutates one state object in place, so what was heard is kept as a copy.
    let heard: CueState | null = null;
    // The 3D stage times the crack and the shatter to its own glass; only the flat table needs them played here.
    let flat = false;
    const hear = (state: CueState): void => {
      for (const cue of cuesFor(heard, state)) if (flat || (cue !== 'entangle' && cue !== 'shatter')) audio.cue(cue);
      audio.ambience(ambienceFor(state));
      heard = { phase: state.phase, forge: state.forge, roulette: state.roulette, cleared: [...state.cleared] };
    };
    // The panel holds its own result, so it reads the store as it is.
    store.subscribe((state) => {
      hud.cage(state);
      hud.roulette(state);
      hear(reveal.shown(state));
    });
    reveal.subscribe(() => {
      hear(reveal.shown(store.state));
    });

    let closed = false;
    let closeFlat = (): void => undefined;
    close = () => {
      if (closed) return;
      closed = true;
      closeFlat();
      reveal.dispose();
      pressPanel.dispose();
      press.dispose();
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
          reveal,
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
      flat = true;
      closeFlat = createFlatTable(root, { store, source, hud, audio, reveal, stages: STAGE_LABELS });
    }
  } catch (error) {
    close();
    fail(root, error);
  }
}

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app element');
void boot(root);
