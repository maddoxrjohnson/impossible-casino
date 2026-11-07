// Opt-in sound, entirely synthesised: rain on the shaft, a click for each hand, one chord when the colour arrives.
export interface GameAudio {
  set(on: boolean): void;
  tick(win: boolean): void;
  chord(): void;
  dispose(): void;
}

export function createAudio(): GameAudio {
  let ctx: AudioContext | null = null, master: GainNode | null = null, rain: AudioBufferSourceNode | null = null;
  function start() {
    ctx = new AudioContext(); master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0; for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; last = last * .86 + w * .14; d[i] = last * 1.6; }
    rain = ctx.createBufferSource(); rain.buffer = buf; rain.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 900; hp.Q.value = .4;
    const g = ctx.createGain(); g.gain.value = .22; rain.connect(hp); hp.connect(g); g.connect(master); rain.start();
    master.gain.linearRampToValueAtTime(.7, ctx.currentTime + 1.2);
  }
  function tone(c: AudioContext, out: GainNode, f: number, t0: number, dur: number, vol: number, type: OscillatorType = 'sine') {
    const o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + Math.min(.6, dur * .3)); g.gain.exponentialRampToValueAtTime(.0005, t0 + dur);
    o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + dur + .05);
  }
  return {
    set(on) { if (on && !ctx) start(); if (ctx && master) { if (on) void ctx.resume(); master.gain.cancelScheduledValues(ctx.currentTime); master.gain.linearRampToValueAtTime(on ? .7 : 0, ctx.currentTime + .4); } },
    tick(win) { if (!ctx || !master || ctx.state !== 'running') return; const t = ctx.currentTime; tone(ctx, master, win ? 1320 : 180, t, .07, .05, win ? 'triangle' : 'square'); },
    chord() { if (!ctx || !master || ctx.state !== 'running') return; const c = ctx, out = master, t = c.currentTime; [110, 164.81, 220, 277.18, 329.63, 440, 554.37].forEach((f, i) => { tone(c, out, f, t + i * .13, 5.5, .05, 'triangle'); }); },
    dispose() { if (ctx) { try { rain?.stop(); } catch { /* already stopped */ } void ctx.close(); ctx = null; } },
  };
}
