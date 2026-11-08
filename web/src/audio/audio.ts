// Opt-in sound, entirely synthesised: rain on the shaft, a drone that fills out with each room cleared, a click for each hand, and a short cue for each turn of the game.
import type { Ambience, Cue } from './cues';

export interface GameAudio {
  set(on: boolean): void;
  tick(win: boolean): void;
  chord(): void;
  cue(cue: Cue): void;
  ambience(a: Ambience): void;
  dispose(): void;
}

/** The roulette ball's run before it settles. The spin itself resolves at once, so this is the sound's own length. */
const SPIN_RUN_S = 0.9;
/** Voices alive at once. Hand ticks stop at 20, cues at 28 and the chord at 32, so autoplay cannot crowd a cue out. A cue that adds many voices can run past its cap. */
const MAX_VOICES = 40;
const TICK_VOICES = 20;
const MIN_TICK_GAP_S = 0.06;
/** The drone: A, its octave, the fifth and a major third above. A voice joins with each room cleared. */
const DRONE = [55, 110, 164.81, 277.18];
const DRONE_VOL = 0.035;

export function createAudio(): GameAudio {
  let ctx: AudioContext | null = null, master: GainNode | null = null, rain: AudioBufferSourceNode | null = null;
  // The rain bed sits well under the cues; at .22 it drowned them.
  const RAIN_VOL = .05;
  let rainGain: GainNode | null = null, rainBand: BiquadFilterNode | null = null, noise: AudioBuffer | null = null;
  let drone: { o: OscillatorNode; g: GainNode }[] = [];
  let want: Ambience = { rain: 0.5, step: 0 }, on = false, gone = false, voices = 0, lastTick = -1;

  function shape(a: Ambience, c: AudioContext, ramp: number) {
    if (rainGain && rainBand) {
      const t = c.currentTime;
      rainGain.gain.cancelScheduledValues(t); rainGain.gain.setTargetAtTime(RAIN_VOL * a.rain, t, ramp);
      rainBand.frequency.cancelScheduledValues(t); rainBand.frequency.setTargetAtTime(700 + 400 * a.rain, t, ramp);
    }
    drone.forEach(({ g }, i) => { g.gain.cancelScheduledValues(c.currentTime); g.gain.setTargetAtTime(i < a.step ? DRONE_VOL : 0, c.currentTime, ramp); });
  }
  function start() {
    const c = ctx = new AudioContext(); master = c.createGain(); master.gain.value = 0; master.connect(c.destination);
    const buf = c.createBuffer(1, c.sampleRate * 3, c.sampleRate), d = buf.getChannelData(0);
    let last = 0; for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = last * .86 + w * .14; d[i] = last * 1.6; }
    rain = c.createBufferSource(); rain.buffer = buf; rain.loop = true;
    rainBand = c.createBiquadFilter(); rainBand.type = 'bandpass'; rainBand.frequency.value = 900; rainBand.Q.value = .4;
    rainGain = c.createGain(); rainGain.gain.value = RAIN_VOL; rain.connect(rainBand); rainBand.connect(rainGain); rainGain.connect(master); rain.start();
    // One second of white noise, shared by every burst.
    noise = c.createBuffer(1, c.sampleRate, c.sampleRate); const n = noise.getChannelData(0); for (let i = 0; i < n.length; i++) n[i] = Math.random() * 2 - 1;
    const low = c.createBiquadFilter(); low.type = 'lowpass'; low.frequency.value = 500; low.connect(master);
    drone = DRONE.map((f, i) => {
      const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = f; o.detune.value = (i % 2 ? 1 : -1) * 4; g.gain.value = 0;
      o.connect(g); g.connect(low); o.start(); return { o, g };
    });
    shape(want, c, .01);
  }
  /** The context and output, only while sound is on and the context is running. */
  const live = (): { c: AudioContext; out: GainNode } | null => (ctx && master && on && ctx.state === 'running' ? { c: ctx, out: master } : null);

  function end(src: AudioScheduledSourceNode, t: number) { voices++; src.onended = () => { voices--; src.disconnect(); }; src.stop(t); }
  /** A pitched voice: quick attack (`attack` seconds), exponential fall. `to` glides the pitch. */
  function tone(c: AudioContext, out: AudioNode, f: number, t0: number, dur: number, vol: number, type: OscillatorType = 'sine', to = f, attack = Math.min(.006, dur * .3)) {
    const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.setValueAtTime(f, t0);
    if (to !== f) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + attack); g.gain.exponentialRampToValueAtTime(.0005, t0 + dur);
    o.connect(g); g.connect(out); o.start(t0); end(o, t0 + dur + .05);
  }
  /** A filtered noise burst that sweeps from `f0` to `f1`. */
  function burst(c: AudioContext, out: AudioNode, t0: number, dur: number, vol: number, type: BiquadFilterType, f0: number, f1: number, q = 1) {
    if (!noise) return;
    const s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain(); s.buffer = noise;
    fl.type = type; fl.Q.value = q; fl.frequency.setValueAtTime(f0, t0); fl.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(.0005, t0 + dur);
    s.connect(fl); fl.connect(g); g.connect(out); s.start(t0); end(s, t0 + dur + .02);
  }
  /** A dull buzz: two saws a hair apart under a low-pass. */
  function buzz(c: AudioContext, out: AudioNode, f: number, t0: number, dur: number, vol: number) {
    const fl = c.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = 280; fl.connect(out);
    tone(c, fl, f, t0, dur, vol, 'sawtooth'); tone(c, fl, f * 1.03, t0, dur, vol, 'sawtooth');
  }
  const chime = (c: AudioContext, out: AudioNode, t: number, notes: number[], gap: number, vol: number) => {
    notes.forEach((f, i) => { tone(c, out, f, t + i * gap, .45, vol, 'triangle'); tone(c, out, f * 2, t + i * gap, .3, vol * .25); });
  };
  /** The ball clicks round the rim, each gap longer than the last, then the result lands. */
  function ballRun(c: AudioContext, out: AudioNode, t: number) {
    for (let at = 0, gap = .045; at < SPIN_RUN_S; at += gap, gap *= 1.17) {
      burst(c, out, t + at, .018, .1 * (1 - at / SPIN_RUN_S * .5), 'bandpass', 2600 - 700 * (at / SPIN_RUN_S), 1800, 3);
    }
  }

  const cues: Record<Cue, (c: AudioContext, out: GainNode, t: number) => void> = {
    wall(c, out, t) { tone(c, out, 95, t, .45, .3, 'sine', 42); burst(c, out, t, .18, .16, 'lowpass', 400, 80, .7); },
    entangle(c, out, t) {
      tone(c, out, 2093, t, 1.1, .05); tone(c, out, 3136, t, .8, .035); tone(c, out, 4186, t, .5, .015);
      burst(c, out, t, .05, .1, 'highpass', 5200, 4200);
    },
    shatter(c, out, t) {
      burst(c, out, t, .55, .22, 'bandpass', 7000, 1400, .8);
      [5588, 4699, 4186, 3520, 3136, 2637].forEach((f, i) => { tone(c, out, f, t + .04 + i * .085 + Math.random() * .03, .5 - i * .05, .035 * (1 - i * .12)); });
    },
    forgePass(c, out, t) { chime(c, out, t, [784, 1175], .09, .06); },
    forgeFail(c, out, t) { buzz(c, out, 62, t, .4, .09); },
    card(c, out, t) { burst(c, out, t, .035, .12, 'bandpass', 1800, 1200, 1.2); tone(c, out, 210, t, .06, .05, 'sine', 140); },
    spinWin(c, out, t) { ballRun(c, out, t); chime(c, out, t + SPIN_RUN_S, [659, 988, 1319], .1, .06); },
    spinLoss(c, out, t) { ballRun(c, out, t); tone(c, out, 120, t + SPIN_RUN_S, .5, .1, 'triangle', 80); },
  };

  return {
    set(next) {
      if (gone) return;
      on = next;
      if (on && !ctx) start();
      if (ctx && master) { if (on) void ctx.resume(); master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(on ? .7 : 0, ctx.currentTime + .4); }
    },
    tick(win) {
      const h = live(); if (!h || voices >= TICK_VOICES) return;
      const t = h.c.currentTime; if (t - lastTick < MIN_TICK_GAP_S) return; lastTick = t;
      tone(h.c, h.out, win ? 1320 : 180, t, .07, .05, win ? 'triangle' : 'square', undefined, .021);
    },
    chord() { const h = live(); if (!h || voices >= MAX_VOICES - 8) return; const t = h.c.currentTime; [110, 164.81, 220, 277.18, 329.63, 440, 554.37].forEach((f, i) => { tone(h.c, h.out, f, t + i * .13, 5.5, .05, 'triangle', f, Math.min(.6, 5.5 * .3)); }); },
    cue(cue) { const h = live(); if (!h || voices >= MAX_VOICES - 12) return; cues[cue](h.c, h.out, h.c.currentTime); },
    ambience(a) { if (a.rain === want.rain && a.step === want.step) return; want = a; if (ctx) shape(a, ctx, 1.5); },
    dispose() {
      gone = true; on = false;
      if (ctx) {
        try { rain?.stop(); } catch { /* already stopped */ }
        drone.forEach(({ o }) => { try { o.stop(); } catch { /* already stopped */ } });
        void ctx.close(); ctx = null; master = null; rain = null; drone = []; noise = null;
      }
    },
  };
}
