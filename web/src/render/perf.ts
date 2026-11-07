import type { WebGLRenderer } from 'three';
import type { DprController } from './dpr';

const WINDOW_MS = 1000;
const HITCH_MS = 50;
/** About an hour of one-second samples, and enough hitches to read a bad session. */
const MAX_SAMPLES = 3600;
const MAX_HITCHES = 2000;

export interface Perf {
  /** Records one frame: wall-clock interval and CPU time in the view, in milliseconds. */
  frame(intervalMs: number, cpuMs: number): void;
  dispose(): void;
}

interface Stats {
  average: number;
  p95: number;
  longest: number;
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0,
    longest: sorted[sorted.length - 1] ?? 0,
  };
}

const summary = ({ average, p95 }: Stats): string => `avg ${average.toFixed(1)}  p95 ${p95.toFixed(1)} ms`;
const tenth = (value: number): number => Math.round(value * 10) / 10;

/**
 * Plain numbers for reading off real hardware, plus a timeline of the session
 * that saves to a file. Shown only with `?perf` in the URL. `moment` names what
 * the game is doing, so each sample can be matched to play.
 */
export function createPerf(renderer: WebGLRenderer, dpr: DprController, adaptive: boolean, moment: () => string): Perf {
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;z-index:9999;left:max(4px,env(safe-area-inset-left));top:max(4px,env(safe-area-inset-top));max-width:min(330px,calc(100vw - 8px));pointer-events:none;';
  const panel = document.createElement('pre');
  panel.style.cssText =
    'margin:0;padding:6px 8px;box-sizing:border-box;white-space:pre-wrap;font:11px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#d8ffd8;background:rgba(0,0,0,.78);';
  panel.textContent = 'measuring';
  const save = document.createElement('button');
  save.type = 'button';
  save.textContent = 'Save log';
  save.style.cssText =
    'margin-top:4px;padding:4px 10px;pointer-events:auto;cursor:pointer;font:12px ui-monospace,Menlo,Consolas,monospace;color:#000;background:#d8ffd8;border:0;';
  box.append(panel, save);
  document.body.append(box);

  const gl = renderer.getContext();
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unavailable';
  const intervals: number[] = [];
  const cpu: number[] = [];
  let elapsed = 0, longest = 0, hitches = 0, changes = 0;
  // Compared every frame, so steps that were later undone still show.
  let seen = dpr.dpr;
  let history: string[] = [];
  const samples: Record<string, number | string>[] = [];
  const hitchLog: { t: number; ms: number; moment: string }[] = [];
  const clock = (): number => tenth(performance.now() / 1000);

  const download = (): void => {
    const log = {
      url: location.href,
      savedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      gpu,
      screen: { width: screen.width, height: screen.height, devicePixelRatio: window.devicePixelRatio },
      longestMs: tenth(longest),
      hitches,
      dprChanges: changes,
      controller: { adaptive, latched: dpr.latched },
      samples,
      hitchLog,
    };
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([JSON.stringify(log)], { type: 'application/json' }));
    link.download = `casino-perf-${String(Date.now())}.json`;
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
    }, 1000);
  };
  save.addEventListener('click', download);

  const publish = (): void => {
    const { width, height } = renderer.domElement;
    const state = !adaptive ? 'off' : dpr.latched ? 'latched, resolution is not the limit' : 'watching';
    const frames = stats(intervals), work = stats(cpu), fps = (intervals.length * 1000) / elapsed;
    if (samples.length < MAX_SAMPLES) {
      samples.push({
        t: clock(), moment: moment(), fps: tenth(fps),
        frameAvg: tenth(frames.average), frameP95: tenth(frames.p95), frameMax: tenth(frames.longest),
        cpuAvg: tenth(work.average), cpuP95: tenth(work.p95), dpr: tenth(dpr.dpr * 10) / 10, tier: dpr.tier, hitches,
      });
    }
    panel.textContent = [
      `fps ${fps.toFixed(1)}  logged ${String(samples.length)}s`,
      `frame ${summary(frames)}`,
      `cpu ${summary(work)}`,
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
      if (intervalMs > HITCH_MS) {
        hitches += 1;
        if (hitchLog.length < MAX_HITCHES) hitchLog.push({ t: clock(), ms: tenth(intervalMs), moment: moment() });
      }
      if (elapsed < WINDOW_MS) return;
      publish();
      intervals.length = 0;
      cpu.length = 0;
      elapsed = 0;
    },
    dispose() {
      save.removeEventListener('click', download);
      box.remove();
    },
  };
}
