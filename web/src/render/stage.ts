import { WebGLRenderer } from 'three';
import { createDprController } from './dpr';
import { createPerf } from './perf';

export interface StageSize {
  /** CSS pixels. */
  width: number;
  height: number;
  /** Rounded CSS size times `dpr`, for sizing render targets. The real canvas buffer may be 1px smaller. */
  pixelWidth: number;
  pixelHeight: number;
  dpr: number;
  tier: number;
}

/** What the stage drives. Each view owns its scene, camera and GPU resources. */
export interface StageView {
  resize(size: StageSize): void;
  /** Advances and draws one frame. `seconds` is unclamped wall-clock time since the last frame. */
  frame(seconds: number): void;
  /** The GPU context came back. Anything drawn once, such as baked environments, must be redrawn here. */
  restored?(): void;
  dispose(): void;
}

export interface StageOptions {
  /** Set false to hold full resolution, for screenshots on a software GPU. */
  adaptiveDpr: boolean;
  /** Shows the frame timing readout. */
  perf: boolean;
  /** Called after the stage has shut itself down because a frame threw. */
  onFailure: (error: unknown) => void;
}

export interface Stage {
  /** Safe to call twice. */
  dispose(): void;
}

/**
 * Asked on a spare canvas: three logs an error when it finds no context, and
 * this is a state the game handles. The renderer's own canvas must stay
 * untouched, because the first request fixes a canvas's context attributes.
 */
function hasWebgl2(): boolean {
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  return probe.getContext('webgl2') !== null;
}

function createRenderer(): WebGLRenderer | null {
  try {
    if (!hasWebgl2()) return null;
    // Depth, stencil and antialiasing live in the post chain's own targets, so
    // the default framebuffer stays bare.
    return new WebGLRenderer({
      antialias: false,
      stencil: false,
      depth: false,
      powerPreference: 'high-performance',
    });
  } catch {
    return null;
  }
}

/**
 * Owns the renderer and its lifecycle: sizing, adaptive resolution, pausing
 * while the tab is hidden or the GPU context is lost, and teardown. Returns
 * null when this browser cannot create a WebGL 2 context.
 */
export function createStage(
  root: HTMLElement,
  createView: (renderer: WebGLRenderer) => StageView,
  { adaptiveDpr, perf: showPerf, onFailure }: StageOptions,
): Stage | null {
  const renderer = createRenderer();
  if (!renderer) return null;

  let view: StageView;
  try {
    view = createView(renderer);
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }

  const canvas = renderer.domElement;
  const dpr = createDprController(window.devicePixelRatio);
  const perf = showPerf ? createPerf(renderer, dpr, adaptiveDpr) : null;

  let width = 0;
  let height = 0;
  const applySize = (): void => {
    width = Math.max(2, root.clientWidth);
    height = Math.max(2, root.clientHeight);
    renderer.setPixelRatio(dpr.dpr);
    renderer.setSize(width, height, false);
    view.resize({
      width,
      height,
      pixelWidth: Math.round(width * dpr.dpr),
      pixelHeight: Math.round(height * dpr.dpr),
      dpr: dpr.dpr,
      tier: dpr.tier,
    });
  };

  // Resizing a canvas clears it, and ResizeObserver fires after animation
  // frames, so resizing there would show a blank frame. Apply it before a draw.
  let sizeStale = false;
  // The observer also fires once on attach, so compare instead of trusting it:
  // a resize reallocates every render target in the post chain.
  const observer = new ResizeObserver(() => {
    if (Math.max(2, root.clientWidth) !== width || Math.max(2, root.clientHeight) !== height) {
      sizeStale = true;
    }
  });

  // A resolution query only reports leaving its value, so it is re-armed for
  // each new one. Moving to another monitor and browser zoom both land here.
  let density: MediaQueryList | null = null;
  const watchDensity = (): void => {
    density?.removeEventListener('change', onDensityChange);
    density = matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
    density.addEventListener('change', onDensityChange);
  };
  const onDensityChange = (): void => {
    watchDensity();
    if (dpr.setDeviceRatio(window.devicePixelRatio)) sizeStale = true;
  };

  let raf = 0;
  let running = false;
  let last = 0;
  let contextLost = false;
  let disposed = false;

  function tick(now: number): void {
    raf = requestAnimationFrame(tick);
    // The first timestamp can predate the start of the loop.
    const seconds = Math.max(0, (now - last) / 1000);
    last = now;
    try {
      if (adaptiveDpr && dpr.sample(seconds)) sizeStale = true;
      if (sizeStale) {
        sizeStale = false;
        applySize();
      }
      if (perf) {
        const start = performance.now();
        view.frame(seconds);
        perf.frame(seconds * 1000, performance.now() - start);
      } else {
        view.frame(seconds);
      }
    } catch (error) {
      shutDown(error);
    }
  }

  function syncLoop(): void {
    const shouldRun = !disposed && !contextLost && !document.hidden;
    if (shouldRun === running) return;
    running = shouldRun;
    if (shouldRun) {
      last = performance.now();
      dpr.reset();
      raf = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(raf);
    }
  }

  // The renderer itself calls preventDefault on loss and rebuilds its state on
  // restore, but render target contents are gone, so the view is told.
  const onContextLost = (): void => {
    contextLost = true;
    syncLoop();
  };
  const onContextRestored = (): void => {
    contextLost = false;
    sizeStale = true;
    try {
      view.restored?.();
    } catch (error) {
      shutDown(error);
      return;
    }
    syncLoop();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    syncLoop();
    observer.disconnect();
    density?.removeEventListener('change', onDensityChange);
    perf?.dispose();
    document.removeEventListener('visibilitychange', syncLoop);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    try {
      view.dispose();
    } catch (error) {
      console.error(error);
    }
    renderer.setRenderTarget(null);
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };

  const shutDown = (error: unknown): void => {
    dispose();
    onFailure(error);
  };

  try {
    applySize();
  } catch (error) {
    dispose();
    throw error;
  }
  root.prepend(canvas);
  observer.observe(root);
  watchDensity();
  document.addEventListener('visibilitychange', syncLoop);
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  syncLoop();

  return { dispose };
}
