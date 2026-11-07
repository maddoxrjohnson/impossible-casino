import type { WebGLRenderer } from 'three';
import type { DprController } from './dpr';

const WINDOW_MS = 1000;
const HITCH_MS = 50;

export interface Perf {
  /** Records one frame: wall-clock interval and CPU time in the view, in milliseconds. */
  frame(intervalMs: number, cpuMs: number): void;
  dispose(): void;
}

function summary(values: number[]): string {
  const sorted = [...values].sort((a, b) => a - b);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
  return `avg ${average.toFixed(1)}  p95 ${p95.toFixed(1)} ms`;
}

/** Plain numbers for reading off real hardware. Shown only with `?perf` in the URL. */
export function createPerf(renderer: WebGLRenderer, dpr: DprController, adaptive: boolean): Perf {
  const panel = document.createElement('pre');
  panel.style.cssText =
    'position:fixed;z-index:9999;left:max(4px,env(safe-area-inset-left));top:max(4px,env(safe-area-inset-top));margin:0;padding:6px 8px;max-width:min(330px,calc(100vw - 8px));box-sizing:border-box;pointer-events:none;white-space:pre-wrap;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#d8ffd8;background:rgba(0,0,0,.78);';
  panel.textContent = 'measuring';
  document.body.append(panel);

  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
  const intervals: number[] = [];
  const cpu: number[] = [];
  let elapsed = 0, longest = 0, hitches = 0, changes = 0;
  // Compared every frame, so steps that were later undone still show.
  let seen = dpr.dpr;
  let history: string[] = [];

  const publish = (): void => {
    const { width, height } = renderer.domElement;
    const state = !adaptive ? 'off' : dpr.latched ? 'latched, resolution is not the limit' : 'watching';
    panel.textContent = [
      `fps ${((intervals.length * 1000) / elapsed).toFixed(1)}`,
      `frame ${summary(intervals)}`,
      `cpu ${summary(cpu)}`,
      `longest ${longest.toFixed(1)} ms  hitches ${String(hitches)}`,
      `dpr ${dpr.dpr.toFixed(2)}  tier ${String(dpr.tier)}  device ${window.devicePixelRatio.toFixed(2)}`,
      `controller ${state}`,
      `dpr changes ${String(changes)}  ${history.join('  ')}`,
      `canvas ${String(width)}x${String(height)}`,
      `gpu ${gpu}`,
    ].join('\n');
  };

  return {
    frame(intervalMs, cpuMs) {
      if (dpr.dpr !== seen) {
        changes += 1;
        history = [...history.slice(-3), `${(performance.now() / 1000).toFixed(0)}s ${seen.toFixed(2)}>${dpr.dpr.toFixed(2)}`];
        seen = dpr.dpr;
      }
      // The first frame of a run can have no interval.
      if (intervalMs <= 0) return;
      intervals.push(intervalMs);
      cpu.push(cpuMs);
      elapsed += intervalMs;
      longest = Math.max(longest, intervalMs);
      if (intervalMs > HITCH_MS) hitches += 1;
      if (elapsed < WINDOW_MS) return;
      publish();
      intervals.length = 0;
      cpu.length = 0;
      elapsed = 0;
    },
    dispose() {
      panel.remove();
    },
  };
}
