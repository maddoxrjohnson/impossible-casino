// The Deco Chandelier. A 1920s architect was commissioned to put a casino inside the cryostat.
// The building opens in black, white and gold. The colour was always in it; you had not been allowed to see it.
import * as THREE from 'three';
import { BREAK_EVEN, CLASSICAL_STAKE } from '../../game/rules';
import type { GameState, GameStore, LastHand, Phase } from '../../game/store';
import type { ResultSource } from '../../game/results';
import type { GameAudio } from '../../audio/audio';
import type { StageSize, StageView } from '../../render/stage';
import type { Hud, HudButton, SideName } from '../../ui/hud';
import { bandFor, createLines, money, pastClassical, pct, signedAmount } from '../../ui/lines';
import { buildWorld, FROST, TIERS, TOP_Y, SEAL_S, FLOOR_Y, TABLE_Y, PAIR_A, PAIR_B, WIN_DIR } from './scene';
import { questionCell } from './textures';
import { createPost } from './post';

/** Where the gimbals close up. Animation only; rates come from the export. */
const GIMBAL_TRUE_DIAL = .5;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const clamp01 = (x: number) => clamp(x, 0, 1);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const damp = (cur: number, goal: number, rate: number, dt: number) => cur + (goal - cur) * (1 - Math.exp(-rate * dt));
const EASE = {
  inOut: (t: number) => t < .5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2,
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  in: (t: number) => t * t * t,
  rise: (t: number) => Math.pow(t, 2.4),
  glide: (t: number) => t * t * t * (t * (6 * t - 15) + 10),
  linear: (t: number) => t,
};

// Authored poses in cylindrical coordinates around the shaft axis, so a glide between two poses is a helix.
interface Pose { r: number; a: number; y: number; ty: number; fov: number }
const POSE: Record<Phase, Pose> = {
  intro: { r: 64, a: 2.9, y: 23, ty: 12.5, fov: 50 },
  classical: { r: 2.9, a: 1.8, y: 3.3, ty: .95, fov: 72 },
  wall: { r: .3, a: Math.PI / 2, y: 1.72, ty: 7.75, fov: 72 },
  entangled: { r: 3.15, a: 1.5, y: 4.7, ty: -.35, fov: 72 },
  beyond: { r: 23, a: 1.22, y: 15, ty: 9, fov: 60 },
};

const RAIN_MAP_FRAG = /* glsl */`
varying vec2 vUv; uniform float uRainT;
float h(float n){ return fract(sin(n*91.7)*47453.1); }
void main(){
  float s = abs(fract(vUv.y*62.)-.5);
  float slat = smoothstep(.14,.21,s);
  float x = vUv.x*150.; float id = floor(x);
  float sp = 1.+h(id)*2.2;
  float y = fract(vUv.y*3.+uRainT*sp*.5+h(id+3.));
  float streak = smoothstep(.0,.02,y)*smoothstep(.34,.0,y)*step(.62,h(id+9.));
  gl_FragColor = vec4(vec3(slat*(.8-streak*.62)*1.25),1.);
}`;

type Ease = (t: number) => number;
interface Tween { obj: object; key: string; read(): number; write(value: number): void; from: number | null; to: number; t0: number; dur: number; ease: Ease }
interface Beat { at: number; fn: () => void }
interface CameraPath { keys: Pose[]; t0: number; dur: number; ease: Ease }

export interface DecoViewOptions {
  root: HTMLElement;
  store: GameStore;
  source: ResultSource;
  hud: Hud;
  audio: GameAudio;
  reducedMotion: boolean;
  /** Called from `dispose`, so everything built for the view goes with the stage. */
  onDispose: () => void;
}

export const STAGE_LABELS: readonly string[] = TIERS.map((t) => t.label);

export function createDecoView(renderer: THREE.WebGLRenderer, { root, store, source, hud, audio, reducedMotion, onDispose }: DecoViewOptions): StageView {
  const cleanups: (() => void)[] = [];
  const CLASSICAL_LIMIT = source.limits.classical, QUANTUM_LIMIT = source.limits.quantum;
  const LINES = createLines(source.limits);
  const LIMIT = pct(CLASSICAL_LIMIT), EVEN = pct(BREAK_EVEN);

  // ---- HUD logic ----
  const story = { locked: false };
  let lastPhase: Phase | null = null, lastBand = '', running = false, side: SideName | null = null, buttonKey = '', ticketFilled = false;
  function hudSync(s: GameState) {
    hud.put('bank', money(s.bankroll));
    hud.put('rate', s.rounds ? pct(s.winRate, 1) : 'No hands');
    hud.put('hands', s.rounds ? `over ${s.rounds} hand${s.rounds === 1 ? '' : 's'}` : 'dealt yet');
    hud.put('limit', LIMIT); hud.put('even', `break even ${EVEN}`);
    hud.put('odds', `${pct(s.target, 1)} at this angle`);
    if (+hud.input.value !== s.dial) hud.input.value = String(s.dial);
    if (s.last) {
      const l = s.last;
      hud.put('tt', s.rounds ? `Hand ${s.rounds}` : 'Last hand');
      hud.put('x', String(l.x)); hud.put('y', String(l.y)); hud.put('a', String(l.a)); hud.put('b', String(l.b));
      hud.put('res', l.win ? 'Won' : 'Lost');
      hud.put('amt', signedAmount(l.delta));
      hud.put('delta', `last hand ${signedAmount(l.delta)}`);
    } else hud.put('delta', ' ');
    const p = s.phase, b = s.autoplaying, lock = story.locked;
    // A reloaded game has no last hand, and a run clears it, so the stub stays down until it has one to show.
    ticketFilled = p !== 'intro' && (ticketFilled || !!s.last);
    hud.ticket(ticketFilled);
    if (p !== lastPhase) {
      hud.title(p === 'intro');
      if (p === 'intro' || p === 'classical' || p === 'wall') hud.colour(false);
      hud.say(LINES[p]); lastBand = ''; running = false;
    }
    hud.dial((p === 'entangled' || p === 'beyond') && !lock && !side);
    const key = `${p}|${b}|${lock}`;
    if (buttonKey !== key) {
      buttonKey = key;
      const run: HudButton = { label: b ? 'Running' : 'Run', act: 'run', disabled: b || lock };
      if (p === 'intro') hud.buttons({ label: 'Deal', act: 'deal' });
      if (p === 'classical') hud.buttons({ label: 'Dealing', disabled: true });
      if (p === 'wall') hud.buttons({ label: 'Entangle the pair', act: 'entangle', brass: true });
      if (p === 'entangled') hud.buttons(run);
      if (p === 'beyond') hud.buttons(run, { label: 'Restart', act: 'restart' });
      hud.stubs(p !== 'classical' && !b && !lock);
    }
    if (p === 'entangled' && !b && !lock && !side) {
      const band = running ? 'short' : bandFor(s.target, source.limits);
      if (band !== lastBand && lastPhase === 'entangled') { lastBand = band; hud.say(LINES[band]); }
      running = false;
    }
    if (p === 'entangled' && b) running = true;
    lastPhase = p;
  }

  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NoToneMapping; // the final pass develops the film

  const trash = new Set<{ dispose(): void }>(); const track = <T extends { dispose(): void }>(x: T) => { trash.add(x); return x; };
  const world = buildWorld(renderer, { limitPct: LIMIT, breakEvenPct: EVEN, reduced: reducedMotion });
  const { scene, U } = world;
  world.setPins(CLASSICAL_LIMIT, BREAK_EVEN);
  const camera = new THREE.PerspectiveCamera(50, 1.6, .12, 280);

  // Lights. Only two cast shadows, and everything else is reflection.
  const lampSpot = new THREE.SpotLight(0xffffff, 1500, 34, .25, .07, 2);
  lampSpot.position.set(0, 10.4, 0); lampSpot.target.position.set(0, 0, 0);
  lampSpot.castShadow = true; lampSpot.shadow.mapSize.set(1024, 1024); lampSpot.shadow.camera.near = 1; lampSpot.shadow.camera.far = 20;
  lampSpot.shadow.bias = -.0005; lampSpot.shadow.normalBias = .02;
  scene.add(lampSpot, lampSpot.target);
  // The hard key: one high light down the rotunda, off axis so it rakes every rim. Plates shade what lies under them, so the table keeps its own pool.
  const keySpot = new THREE.SpotLight(0xffffff, 11000, 0, .3, .12, 2);
  keySpot.position.set(-16, 84, 9); keySpot.target.position.set(0, 12, 0);
  keySpot.castShadow = true; keySpot.shadow.mapSize.set(2048, 2048); keySpot.shadow.camera.near = 40; keySpot.shadow.camera.far = 110; keySpot.shadow.bias = -.0004; keySpot.shadow.autoUpdate = false; keySpot.shadow.needsUpdate = true;
  scene.add(keySpot, keySpot.target);

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { uRainT: U.uRainT }, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=vec4(position.xy,0.,1.); }', fragmentShader: RAIN_MAP_FRAG,
  }));
  quad.frustumCulled = false; track(quad.geometry); track(quad.material);
  const rainScene = new THREE.Scene(); rainScene.add(quad);
  const rainCam = new THREE.Camera();
  const rainRT = track(new THREE.WebGLRenderTarget(512, 512, { depthBuffer: false, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));

  const winTarget = new THREE.Vector3(0, 14, 0);
  const winSpot = new THREE.SpotLight(0xffffff, 15, 0, .46, .03, 0);
  winSpot.position.copy(winTarget).addScaledVector(WIN_DIR, -80); winSpot.target.position.copy(winTarget);
  winSpot.castShadow = true; winSpot.shadow.mapSize.set(2048, 2048); winSpot.shadow.camera.near = 30; winSpot.shadow.camera.far = 130;
  winSpot.shadow.bias = -.0004; winSpot.shadow.autoUpdate = false; winSpot.shadow.needsUpdate = true; winSpot.map = rainRT.texture;
  scene.add(winSpot, winSpot.target);

  const warmFill = new THREE.PointLight(0xffd29a, 0, 46, 1.6); warmFill.position.set(0, 12, 9); scene.add(warmFill);
  const oxFill = new THREE.PointLight(0xff2b30, 0, 30, 1.6); oxFill.position.set(-9, 3, 5); scene.add(oxFill);
  const jadeFill = new THREE.PointLight(0x33ff99, 0, 9, 1.6); jadeFill.position.set(0, .9, 0); scene.add(jadeFill);

  const post = createPost(renderer, track);
  post.final.uniforms.uA.value.copy(PAIR_A); post.final.uniforms.uB.value.copy(PAIR_B);
  post.haze.uniforms.tMapB.value = rainRT.texture; post.haze.uniforms.uFloor.value = FLOOR_Y;

  const automated = navigator.webdriver;   // software GPU in an automated browser: keep resolution, let real time pass
  const mirrorCam = new THREE.PerspectiveCamera();
  let mirrorRT: THREE.WebGLRenderTarget | null = null, tier = 0, frameNo = 0;
  function resize({ width, height, pixelWidth: pw, pixelHeight: ph, dpr, tier: nextTier }: StageSize) {
    tier = nextTier;
    post.size(pw, ph, automated ? 0 : tier > 0 || dpr > 1.3 ? 2 : 4);
    mirrorRT?.dispose();
    mirrorRT = new THREE.WebGLRenderTarget(pw >> 1, ph >> 1, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true });
    U.tMirror.value = mirrorRT.texture;
    camera.aspect = width / height; camera.updateProjectionMatrix();
    world.setDpr(dpr);
  }

  // --- tiny timeline: tweens and scheduled beats, on wall-clock seconds so a slow frame never stalls the story.
  let now = 0, tweens: Tween[] = [], beats: Beat[] = [];
  const fx = { env: 1, exposure: 1.02, ca: 0, shake: 0, spin: 0, rise: 0, fade: 0, chipBase: .55, lamp: 1, flash: 0, pluck: 0, lit: 0, lift: 0 };
  const tw = <K extends string>(obj: { [P in K]: number }, key: K, to: number, dur: number, ease: Ease = EASE.out, delay = 0) => {
    tweens = tweens.filter((t) => !(t.obj === obj && t.key === key));
    tweens.push({ obj, key, read: () => obj[key], write: (value) => { obj[key] = value; }, from: null, to, t0: now + delay, dur: Math.max(.001, dur), ease });
  };
  const after = (d: number, fn: () => void) => { beats.push({ at: now + d, fn }); };
  const clearStory = () => { tweens = tweens.filter((x) => x.key === 'fade'); beats = []; };

  // --- camera
  const pose = { ...POSE.intro };
  let path: CameraPath | null = null, phaseArmed = false;
  const glide = (keys: Pose[], dur: number, ease: Ease = EASE.glide) => {
    const start = { ...pose };
    if (reducedMotion) { const lastKey = keys[keys.length - 1] as Pose; tw(fx, 'fade', 0, .3, EASE.linear); after(.32, () => { Object.assign(pose, lastKey); path = null; tw(fx, 'fade', 1, .45, EASE.linear); }); return; }
    path = { keys: [start, ...keys], t0: now, dur, ease };
  };
  const catmull = (p0: number, p1: number, p2: number, p3: number, t: number) => .5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  const samplePath = (p: CameraPath) => {
    const raw = clamp01((now - p.t0) / p.dur), e = p.ease(raw), n = p.keys.length - 1, f = e * n, i = Math.min(Math.floor(f), n - 1), t = f - i;
    const k = (j: number) => p.keys[clamp(j, 0, n)] as Pose;
    for (const key of ['r', 'a', 'y', 'ty', 'fov'] as const) pose[key] = catmull(k(i - 1)[key], k(i)[key], k(i + 1)[key], k(i + 2)[key], t);
    if (raw >= 1) path = null;
  };
  const pointer = { x: 0, y: 0, sx: 0, sy: 0 };

  // --- the two rooms behind the lift doors
  type Door = (typeof world.doors)[number];
  const doorByName = Object.fromEntries(world.doors.map((d) => [d.name, d])) as Record<SideName, Door>;
  const setGate = (d: Door, open: boolean) => { d.leaves.forEach((l) => { tw(l.scale, 'x', open ? .22 : 1, 1.1, EASE.inOut, open ? 1.5 : 0); }); };
  const home = (phase: Phase) => POSE[phase];
  const leaveKeys = (t: { R: number; y: number }): Pose[] => (pose.r < 6 ? [{ r: 10.5, a: pose.a, y: 3.6, ty: 3.2, fov: 52 }] : []).concat([{ r: t.R + 7.5, a: pose.a - .2, y: t.y + 2.5, ty: t.y + 1, fov: 46 }]);
  function openSide(name: SideName) {
    const s = store.state;
    if (s.phase === 'classical' || s.autoplaying || story.locked) return;
    const d = doorByName[name], t = TIERS[d.tier], prev = side;
    if (prev) setGate(doorByName[prev], false);
    side = name; hud.side(name); hud.say(LINES[name]);
    tw(fx, 'spin', 0, .7);
    const az = d.az + (U.uRot.value[d.tier] as number);
    glide([...leaveKeys(t), { r: t.R + 5, a: az, y: t.y + 2, ty: t.y + 1.75, fov: 50 }], 3.4);
    setGate(d, true);
    hudSync(s);
  }
  function closeSide() {
    if (!side) return;
    const d = doorByName[side], t = TIERS[d.tier], ph = store.state.phase;
    setGate(d, false); side = null; hud.side(null); hud.say(LINES[ph]); lastBand = '';
    hudSync(store.state);
    const inner = home(ph).r < 6;
    glide([{ r: t.R + 7.5, a: pose.a + .2, y: inner ? 4 : t.y + 1, ty: 3, fov: 50 }, ...(inner ? [{ r: 10.5, a: home(ph).a, y: 3.6, ty: 3, fov: 52 }] : []), home(ph)], 2.8);
    if (ph === 'beyond') tw(fx, 'spin', 1, 1.6, EASE.inOut);
  }
  hud.setSide((n) => { if (n === 'back' || n === side) closeSide(); else openSide(n); });

  // --- world state
  let sealGone = false, cross75 = false, beat = 0, armKick = 0, time = 0, hazeT = 0, hazeSpeed = 1, rainSpeed = 1, chipN = -1, floodOn = false;
  const armQueue: number[] = [];
  const dummy = new THREE.Object3D();
  function layoutChips(n: number) {
    const count = Math.min(world.CHIPS, Math.max(0, n));
    world.chips.count = count;
    for (let i = 0; i < count; i++) {
      const col = Math.floor(i / 12), lvl = i % 12;
      dummy.position.set(-1.92 + (col % 5) * .27 + Math.sin(i * 7.1) * .005, TABLE_Y + .017 + lvl * .031, -.62 - Math.floor(col / 5) * .27 + Math.cos(i * 5.3) * .005);
      dummy.rotation.set(0, i * 2.4, 0); dummy.scale.setScalar(1); dummy.updateMatrix(); world.chips.setMatrixAt(i, dummy.matrix);
    }
    world.chips.instanceMatrix.needsUpdate = true;
  }
  const flights = Array.from({ length: 10 }, () => ({ t: 1, a: new THREE.Vector3(), b: new THREE.Vector3() }));
  let flightI = 0, flying = false;
  dummy.scale.setScalar(0); dummy.updateMatrix();
  for (let i = 0; i < 10; i++) world.flyers.setMatrixAt(i, dummy.matrix);
  dummy.scale.setScalar(1);
  const HOUSE = new THREE.Vector3(.2, TABLE_Y + .1, -1.9), STACK = new THREE.Vector3(-1.4, TABLE_Y + .22, -.9);
  function launch(win: boolean) {
    const f = flights[flightI]!; flightI = (flightI + 1) % flights.length; f.t = 0;
    f.a.copy(win ? HOUSE : STACK); f.b.copy(win ? STACK : HOUSE); flying = true;
  }
  const aCard = world.cardFaces;
  function showQuestions(x: number | null, y: number | null) { const cx = questionCell(x), cy = questionCell(y); aCard.setX(0, cx); aCard.setY(0, cx); aCard.setX(1, cy); aCard.setY(1, cy); aCard.needsUpdate = true; }

  function showPair(on: boolean) { world.pair.forEach((p) => { p.g.visible = on; }); world.threads.forEach((t) => { t.visible = on; }); }
  function startFlood(dur: number) {
    floodOn = true; U.uR.value = 0; hud.colour(true); audio.chord();
    tw(U.uR, 'value', 80, dur, EASE.rise); tw(fx, 'lit', 1, dur * .9, EASE.inOut, dur * .12); tw(U.uSc, 'value', 1, dur * .7, EASE.out, .3);
  }
  function entangleSequence() {
    story.locked = true; side = null; hud.side(null); path = null; hudSync(store.state);
    // Hold the breath: everything goes out.
    tw(fx, 'env', .14, .42); tw(fx, 'lamp', .04, .34); tw(fx, 'chipBase', .1, .4);
    // The current leaves the top plate and races down every cable at once, then stops dead at the glass overhead.
    after(.5, () => {
      U.uSweep.value = -.1; tw(U.uSweep, 'value', SEAL_S, 1, EASE.in);
      tw(fx, 'lamp', 1.5, 1, EASE.linear); tw(fx, 'env', .7, 1, EASE.linear); tw(U.uPluck, 'value', 1, .7, EASE.linear);
    });
    // It presses on the plate. Cracks run outward through the cames.
    after(1.5, () => {
      tw(U.uCrack, 'value', 1, .52, EASE.in);
      if (!reducedMotion) { tw(fx, 'shake', .03, .5, EASE.in); tw(fx, 'ca', .004, .5, EASE.in); }
    });
    // It goes, and the glass comes down.
    after(2.05, () => {
      tw(U.uOpen, 'value', 1.2, .95); tw(U.uSweep, 'value', 1.3, .85, EASE.linear);
      U.uImpactCol.value.setRGB(4, 3, 1.4); U.uImpact.value = 0;
      world.shards.visible = !reducedMotion; U.uShard.value = 0;
      fx.flash = 1; fx.shake = reducedMotion ? 0 : .22; fx.ca = reducedMotion ? 0 : .009; fx.exposure = 2.4;
      tw(fx, 'exposure', 1.02, 1.5); tw(fx, 'shake', 0, 1.4); tw(fx, 'ca', 0, 1.4);
      tw(U.uFrost, 'value', 0, 1.5);
      tw(fx, 'env', 1.08, 1.2); tw(fx, 'lamp', 1.1, 1.2); tw(fx, 'chipBase', 1, 1.2); tw(U.uPluck, 'value', 0, 3);
    });
    after(2.6, () => glide([{ r: 1.5, a: 1.6, y: 2.3, ty: 3.4, fov: 66 }, { r: 2.7, a: 1.54, y: 3, ty: 1.9, fov: 64 }, POSE.entangled], 2.7));
    // The pair lights over the jewel, and the colour comes out of it.
    after(3, () => { showPair(true); tw(U.uPair, 'value', 1, .8); tw(U.uThread, 'value', 1, .9); });
    after(3.3, () => startFlood(6.4));
    after(3.2, () => { world.seal.visible = false; world.sealRing.visible = false; sealGone = true; });
    after(6.2, () => { world.shards.visible = false; story.locked = false; hudSync(store.state); });
  }

  function arrive(p: Phase, prev: Phase | null) {
    side = null; hud.side(null); world.doors.forEach((d) => { setGate(d, false); });
    if (p === 'intro') {
      clearStory(); story.locked = false; sealGone = false; cross75 = false;
      world.seal.visible = true; world.sealRing.visible = true; world.shards.visible = false;
      if (floodOn) { floodOn = false; tw(U.uR, 'value', 0, 1.5, EASE.out); }
      showPair(false);
      for (const [u, v] of [[U.uOpen, 0], [U.uCrack, 0], [U.uSc, 0], [U.uFrost, FROST], [U.uPair, 0], [U.uThread, 0], [U.uBeam, 0], [U.uPeel, .67]] as const) tw(u, 'value', v, 1.6);
      for (const [k, v] of [['spin', 0], ['rise', 0], ['env', 1], ['lamp', 1], ['exposure', 1.02], ['chipBase', .55], ['lit', 0], ['lift', 0]] as const) tw(fx, k, v, 1.6);
      U.uSweep.value = -1; U.uSweepY.value = 80; world.beam.visible = false; showQuestions(null, null);
      if (prev) glide([{ r: 16, a: 2.4, y: 16, ty: 12, fov: 48 }, POSE.intro], 4.6);
    }
    // Deal crosses the dark, drops down the outside of the stack past every balcony, and steps in under the skylight.
    if (p === 'classical') glide([{ r: 42, a: 2.7, y: 20, ty: 12, fov: 50 }, { r: 19, a: 2.3, y: 16, ty: 9, fov: 50 }, { r: 11, a: 2, y: 8, ty: 4, fov: 54 }, { r: 6.4, a: 1.8, y: 3.7, ty: 1.8, fov: 58 }, POSE.classical], 5.2, EASE.inOut);
    // The camera tips back until the ceiling of the game is all there is.
    if (p === 'wall') glide(prev === 'classical' ? [{ r: 1.9, a: 1.7, y: 2.1, ty: 4.6, fov: 64 }, POSE.wall] : [{ r: 11, a: 1.4, y: 4, ty: 3, fov: 54 }, { r: 3.6, a: 1.7, y: 2.6, ty: 3, fov: 60 }, POSE.wall], prev === 'classical' ? 3.2 : 4.2);
    if (p === 'entangled') {
      if (prev === 'wall') entangleSequence();
      else { // a reloaded game: land straight in the state the sequence leaves behind
        clearStory(); story.locked = false; breakAll(); glide([{ r: 8, a: 1.5, y: 4, ty: 2, fov: 54 }, POSE.entangled], 3);
      }
    }
    if (p === 'beyond') {
      if (prev !== 'entangled') { clearStory(); story.locked = false; breakAll(); } else tw(fx, 'exposure', 1.02, 2);
      // The rules break: the balconies begin to turn, vapour falls upward, cards leave the deck and current climbs the bore.
      tw(fx, 'spin', 1, 3.2, EASE.inOut); tw(fx, 'rise', 1, 3, EASE.inOut); tw(fx, 'lift', 1, 4, EASE.inOut); tw(fx, 'env', 1.16, 2.4); tw(fx, 'lamp', 1.2, 2.4);
      tw(U.uPeel, 'value', 1.32, 7, EASE.inOut, 1);
      world.beam.visible = true; tw(U.uBeam, 'value', 1, 2.2, EASE.out, .4);
      glide([{ r: 8.4, a: 1.5, y: 5, ty: 2.6, fov: 58 }, POSE.beyond], 4.6);
    }
  }
  function breakAll() {
    U.uOpen.value = 1.2; U.uCrack.value = 1; U.uSweep.value = 1.3; U.uSweepY.value = -8; U.uFrost.value = 0;
    world.seal.visible = false; world.sealRing.visible = false; sealGone = true;
    showPair(true); U.uPair.value = 1; U.uThread.value = 1; fx.env = 1.08; fx.lamp = 1.1; fx.chipBase = 1;
    startFlood(4.5);
  }

  // ---- Game wiring ----
  let worldPhase: Phase | null = null;
  const unsub = store.subscribe((s) => {
    if (s.phase !== worldPhase) { const prev = worldPhase; worldPhase = s.phase; if (phaseArmed) arrive(s.phase, prev); }
    hudSync(s);
    const n = Math.floor(s.bankroll / CLASSICAL_STAKE);
    if (n !== chipN) { chipN = n; layoutChips(n); }
    if (s.last) showQuestions(s.last.x, s.last.y);
    if (s.mode === 'quantum' && pastClassical(s.target, CLASSICAL_LIMIT) && sealGone && !cross75) { cross75 = true; fx.flash = Math.max(fx.flash, .7); }
    if (s.mode === 'quantum' && !pastClassical(s.target, CLASSICAL_LIMIT)) cross75 = false;
  });
  phaseArmed = true;
  const unround = store.onRound((l: LastHand, s) => {
    audio.tick(l.win);
    launch(l.win); beat = l.win ? .34 : -.62;
    armQueue.push(time + (reducedMotion ? 0 : .34));
    world.firePulse(U.uTime.value, l.win, s.mode === 'quantum' ? 1.02 : SEAL_S);
    fx.pluck = Math.max(fx.pluck, l.win ? .35 : .6);
    if (s.mode === 'quantum') { U.uThreadPulse.value = l.win ? 1 : .15; fx.flash = Math.max(fx.flash, l.win ? .7 : .25); }
    else after(.68, () => { U.uImpact.value = l.win ? .9 : 1.1; U.uImpactR.value = 0; if (l.win) U.uImpactCol.value.setRGB(3, 2.2, .9); else U.uImpactCol.value.setRGB(1.6, 1.6, 1.7); });
  });
  cleanups.push(unsub, unround);

  // ---- Picking ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), picks = world.doors.map((d) => d.hit);
  function hit(e: PointerEvent) {
    const r = root.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const h = ray.intersectObjects(picks, false);
    return (h[0]?.object.name ?? null) as SideName | null;
  }
  const clickable = () => !side && !story.locked && !path && store.state.phase !== 'classical' && !store.state.autoplaying;
  const onMove = (e: PointerEvent) => {
    const r = root.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1; pointer.y = ((e.clientY - r.top) / r.height) * 2 - 1;
    const over = e.target instanceof Element ? e.target : null;
    if (e.pointerType === 'touch' || over !== renderer.domElement && !over?.classList.contains('dc-hud') && !over?.classList.contains('dc-mid')) { hud.hot(false); return; }
    const n = clickable() ? hit(e) : null;
    hud.hot(!!n);
    if (n) hud.hint(`Look through ${doorByName[n].sign.replace(/^The /, 'the ')}`, e.clientX - r.left, e.clientY - r.top);
  };
  let downAt: [number, number] | null = null;
  const onDown = (e: PointerEvent) => { downAt = [e.clientX, e.clientY]; };
  const onUp = (e: PointerEvent) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 8) return;
    if (e.target instanceof Element && e.target.closest('button, input, .dc-receipt')) return;
    if (side) { closeSide(); return; }
    const n = clickable() ? hit(e) : null;
    if (n) openSide(n);
  };
  root.addEventListener('pointermove', onMove); root.addEventListener('pointerdown', onDown); root.addEventListener('pointerup', onUp);
  cleanups.push(() => { root.removeEventListener('pointermove', onMove); root.removeEventListener('pointerdown', onDown); root.removeEventListener('pointerup', onUp); });

  // --- the lift dial, tied to the camera's depth
  const G_Y: number[] = [TIERS[0].y, TIERS[1].y, TIERS[2].y, TIERS[3].y, POSE.entangled.y], G_K = [50, 4, .8, .1, .015];
  const fmtK = (k: number) => k >= 9.95 ? `${k.toFixed(0)} K` : k >= 1 ? `${k.toFixed(1)} K` : `${Math.round(k * 1000)} mK`;
  const readGauge = (y: number) => {
    let i = 0; while (i < 3 && y < G_Y[i + 1]!) i++;
    const t = clamp01((G_Y[i]! - y) / (G_Y[i]! - G_Y[i + 1]!));
    const frac = (i + t) / 4, stage = Math.round(frac * 4);
    const label = Math.abs(frac * 4 - stage) < .04 ? TIERS[stage]!.label : fmtK(Math.exp(lerp(Math.log(G_K[i]!), Math.log(G_K[i + 1]!), t)));
    hud.gauge(label, frac, stage);
  };

  // ---- Per-frame ----
  const lampLag = (t: number, big: number) => ({ x: Math.sin(t * .62) * (.012 + big * .05), z: Math.cos(t * .47) * (.01 + big * .04) });
  const white = new THREE.Color(1, .985, .96), warm = new THREE.Color(1, .86, .62), moonMono = new THREE.Color(.96, .97, 1), moonWarm = new THREE.Color(1, .88, .66);
  const VELVET = world.velvetMat.color.clone();
  const tmpV = new THREE.Vector3(), tmpU = new THREE.Vector3(), camUp = new THREE.Vector3(), invVP = new THREE.Matrix4();
  let rateShown = 0, targetShown = 0, linkShown = 0, flow = 0, drift = 0;

  function update(rawDt: number, dt: number) {
    now += rawDt; time = now; U.uTime.value = now;
    if (beats.length) { const due = beats.filter((b) => b.at <= now); if (due.length) { beats = beats.filter((b) => b.at > now); due.forEach((b) => b.fn()); } }
    if (tweens.length) tweens = tweens.filter((x) => {
      if (now < x.t0) return true;
      x.from ??= x.read();
      const p = clamp01((now - x.t0) / x.dur); x.write(lerp(x.from, x.to, x.ease(p)));
      return p < 1;
    });
    if (fx.fade === 0 && !tweens.some((x) => x.key === 'fade') && now > .05) tw(fx, 'fade', 1, 1.2, EASE.linear);
    if (path) samplePath(path);
    else if (store.state.phase === 'intro' && !side && !reducedMotion) pose.r = Math.max(62, pose.r - dt * .2);   // the opening shot breathes in slowly

    if (!reducedMotion) { const k = (now * .045) % 2, e = k < 1 ? k : 2 - k, h = clamp01(e * 1.25 - .125); world.lift.position.y = lerp(13.2, 24.4, h * h * (3 - 2 * h)); } else world.lift.position.y = 18.9;

    const st = store.state, ph = st.phase, lit = fx.lit, Rv = U.uR.value, d = 1 - Math.exp(-dt * 7);
    rateShown += (st.winRate - rateShown) * d; targetShown += ((st.mode === 'quantum' ? st.target : 0) - targetShown) * d;
    U.uRate.value = rateShown; U.uTarget.value = targetShown;
    const tn = st.mode === 'quantum' ? clamp01((st.target - .5) / (QUANTUM_LIMIT - .5)) : 0;
    linkShown += (tn - linkShown) * d; U.uLink.value = linkShown * linkShown;
    U.uThreadPulse.value = damp(U.uThreadPulse.value, 0, 7, dt);
    U.uThreadAmp.value = damp(U.uThreadAmp.value, Math.abs(st.dial - GIMBAL_TRUE_DIAL) * .42 + .006, 5, dt);

    // Decaying beats.
    U.uImpact.value *= Math.exp(-dt * 5); U.uImpactR.value += dt * 1.9;
    fx.flash *= Math.exp(-dt * 6); U.uFlash.value = fx.flash;
    fx.pluck *= Math.exp(-dt * 3.5);
    if (!tweens.some((x) => x.obj === U.uPluck)) U.uPluck.value = fx.pluck;
    if (U.uShard.value >= 0 && world.shards.visible) U.uShard.value += dt;
    if (U.uSweep.value > -.5) U.uSweepY.value = TOP_Y * (1 - U.uSweep.value);

    // The freeze: on Entangle the rain stops and so does the haze, until the glass goes.
    const frozen = story.locked && !sealGone && !reducedMotion;
    rainSpeed = damp(rainSpeed, frozen ? 0 : ph === 'beyond' ? -.75 : floodOn ? .32 : 1, frozen ? 14 : 1.2, dt); U.uRainT.value += dt * rainSpeed * .2;
    hazeSpeed = damp(hazeSpeed, frozen ? 0 : ph === 'beyond' ? 2.6 : 1, frozen ? 12 : 1, dt); hazeT += dt * hazeSpeed;

    world.spin(dt, fx.spin);
    if (ph !== 'beyond' && fx.spin < .01) world.settleSpin(Math.exp(-dt * 2));
    flow -= lerp(-1, 1, fx.rise) * (reducedMotion ? .25 : .55) * dt; U.uFlow.value = flow;
    U.uLamp.value = fx.lamp;
    U.uAir.value = fx.lift;
    const outside = clamp01((pose.r - 30) / 40);   // from outside the plates stay matte: no lobe flare across the stack, and the blinds would only read as stripes
    U.uBlinds.value = (1 - lit * .5) * (1 - outside);
    U.uBars.value = (1 - lit * .25) * (1 - clamp01((pose.ty - pose.y) / 3) * .9);   // looking up the shaft, the blinds on the shield are only blocks in the corners

    const chip = fx.chipBase * (st.mode === 'quantum' ? .55 + tn * .85 : 1) + fx.flash * .8;
    U.uChip.value = chip;
    world.chipTop.emissiveIntensity = .7 + chip * 2.1;
    world.chipTop.emissive.setRGB(1 - lit * .32, 1 - lit * .12, 1);        // cold blue only ever whispers, and only here
    U.uChipCol.value.setRGB(1.1, 1.1, 1.2).multiplyScalar(.5 + chip);
        U.uTopCol.value.setRGB(2.6, 2.0, 1.25).multiplyScalar(fx.env * lerp(1, .15, outside));
    world.chipLight.intensity = 3 + chip * 9;
    world.chipLight.color.setRGB(.9 - lit * .3, .93 - lit * .12, 1);
    world.sealLight.intensity = U.uImpact.value * 60 + fx.flash * 50 * U.uSc.value;
    world.sealLight.color.copy(U.uImpactCol.value);
    scene.environmentIntensity = fx.env * (1 + lit * .15);
    world.doors.forEach((x) => { if (x.wheel) x.wheel.rotation.z -= dt * .9; });

    // Lamp: the hoop swings now, its light swings late, and that lag is the first thing wrong here.
    const big = reducedMotion ? 0 : fx.lift, lagT = .85 + big * 1.1;
    const sw = lampLag(now, big), lg = lampLag(now - lagT, big);
    world.lamp.rotation.z = sw.x * .7; world.lamp.rotation.x = sw.z * .7; world.lamp.visible = true;
    lampSpot.position.set(Math.sin(lg.x) * 9, 10.4, -Math.sin(lg.z) * 9);
    lampSpot.target.position.set(lampSpot.position.x * 1.5, 0, lampSpot.position.z * 1.5);
    beat = damp(beat, 0, 13, dt);
    lampSpot.intensity = (820 + beat * 420) * clamp(fx.lamp, 0, 1.15) * (1 - lit * .35);
    lampSpot.color.copy(white).lerp(warm, lit);
    world.feltMat.color.setScalar(.62 - .12 * lit);           // the room brightens after the flood; the baize must keep its print
    world.velvetMat.color.copy(VELVET).multiplyScalar(lerp(.3, 1, lit));   // before the flood the curtains are only dark mass at the edge of frame
    winSpot.color.copy(moonMono).lerp(moonWarm, lit);
    winSpot.intensity = 15 * clamp(fx.lamp, .1, 1);
    warmFill.intensity = 240 * lit; oxFill.intensity = 110 * lit * (.8 + .2 * Math.sin(now * 1.1) * Math.sin(now * 3.7)); jadeFill.intensity = 7 * lit;

    // Flying chips.
    if (flying) {
      let any = false;
      flights.forEach((f, i) => {
        if (f.t >= 1) { dummy.scale.setScalar(0); dummy.updateMatrix(); world.flyers.setMatrixAt(i, dummy.matrix); dummy.scale.setScalar(1); return; }
        f.t = Math.min(1, f.t + dt / .42); any = true;
        const e = 1 - (1 - f.t) ** 2.4;
        dummy.position.lerpVectors(f.a, f.b, e); dummy.position.y += Math.sin(e * Math.PI) * .5;
        dummy.rotation.set(e * 9, 0, e * 4); dummy.updateMatrix(); world.flyers.setMatrixAt(i, dummy.matrix);
      });
      world.flyers.instanceMatrix.needsUpdate = true; flying = any;
    }

    // Quiet wrongness: one chip in two places, and it rises when the rules go.
    const blink = Math.floor(now * .37 + Math.sin(now * .9) * .3) % 2, flick = Math.sin(now * 41) > .986;
    world.ghosts.forEach((g, i) => {
      const on = (i === blink) !== flick;
      g.material.opacity = damp(g.material.opacity, on ? .96 : .14, 22, dt);
      g.position.y = TABLE_Y + .017 + fx.lift * (.9 + Math.sin(now * .7 + i * 2.1) * .12);
      g.rotation.x = fx.lift * now * .6; g.rotation.z = fx.lift * now * .4;
    });

    // The dealer deals late.
    while (armQueue.length && armQueue[0]! <= now) { armQueue.shift(); armKick = 1; }
    armKick = damp(armKick, 0, 8, dt);
    U.uArm.value = -(-.04 + armKick * .32 + Math.sin(now * .5) * .02);

    // The pair's gimbals close up as the dial comes true.
    if (world.pair[0]?.g.visible) world.pair.forEach((p) => {
      const off = (st.dial - GIMBAL_TRUE_DIAL) * p.sign * 3.2;
      p.ring.rotation.set(Math.PI / 2 + off, now * .4 * p.sign, 0); p.ring2.rotation.set(off * .6, Math.PI / 2 + off, now * .3);
      p.g.position.y = PAIR_A.y + Math.sin(now * 1.4 + p.sign) * .03;
    });

    // Camera.
    const portrait = camera.aspect < 1 ? 1 + (1 - camera.aspect) * (pose.r < 6 ? .95 : .62) : 1;   // close to the table, wide enough to hold both seats
    pointer.sx += (pointer.x - pointer.sx) * (1 - Math.exp(-dt * 3)); pointer.sy += (pointer.y - pointer.sy) * (1 - Math.exp(-dt * 3));
    const par = reducedMotion ? 0 : 1;
    const idle = reducedMotion ? 0 : Math.sin(now * .13) * .025;
    drift += ((ph === 'beyond' && !side && !path && !reducedMotion ? Math.sin(now * .09) * .05 : 0) - drift) * d * .1;
    const inShaft = pose.r < 1;              // looking straight up, parallax must not swing the frame
    const a = pose.a + idle + drift + pointer.sx * (inShaft ? .05 : .022) * par;
    const y = pose.y - pointer.sy * .14 * par + (reducedMotion ? 0 : Math.sin(now * .21) * .05);
    const sh = fx.shake;
    camera.position.set(pose.r * Math.cos(a) + (sh ? (Math.random() - .5) * sh : 0), y + (sh ? (Math.random() - .5) * sh : 0), pose.r * Math.sin(a));
    const fov = Math.min(112, pose.fov * portrait);
    if (Math.abs(camera.fov - fov) > .01) { camera.fov = fov; camera.updateProjectionMatrix(); }
    camera.up.set(0, 1, 0); camera.lookAt(0, pose.ty, 0); camera.updateMatrixWorld();
    readGauge(side ? pose.y - 1.9 : lerp(pose.y, TIERS[0].y + 5, clamp01((pose.r - 22) / 18)));   // from outside the cold has not started

    // Post.
    const f = post.final.uniforms, hz = post.haze.uniforms;
    f.uExposure.value = fx.exposure * (reducedMotion || lit > .01 ? 1 : 1 + Math.sin(now * 31) * Math.sin(now * 19) * .012);
    f.uR.value = Rv; f.uTime.value = now; f.uFade.value = fx.fade;
    f.uCA.value = .0028 + fx.ca + (Rv > 0 && Rv < 74 && !reducedMotion ? .004 : 0);
    f.uFlash.value = reducedMotion ? 0 : Math.max(0, fx.exposure - 1.5) * .05;
    hz.uHazeT.value = hazeT; hz.uDensity.value = (.42 + lit * .1) * clamp(fx.lamp, .25, 1) * lerp(1, .3, clamp01((pose.r - 30) / 40));
    hz.uLamp.value.copy(lampSpot.position);
    hz.uLampDir.value.copy(lampSpot.target.position).sub(lampSpot.position).normalize();
    hz.uCosOuter.value = Math.cos(lampSpot.angle); hz.uCosInner.value = Math.cos(lampSpot.angle * (1 - lampSpot.penumbra));
    hz.uColA.value.copy(lampSpot.color).multiplyScalar((.8 + beat * .5) * clamp(fx.lamp, 0, 1));
    hz.uColB.value.copy(winSpot.color).multiplyScalar(.5 * clamp(fx.lamp, .1, 1));
    hz.uMatA.value.copy(lampSpot.shadow.matrix); hz.uMatB.value.copy(winSpot.shadow.matrix);
    if (lampSpot.shadow.map && winSpot.shadow.map) { hz.tShadowA.value = lampSpot.shadow.map.texture; hz.tShadowB.value = winSpot.shadow.map.texture; hz.uHasShadow.value = 1; }
    hz.uBlend.value = path ? .55 : .3;
  }

  function renderFrame() {
    renderer.setRenderTarget(rainRT); renderer.render(rainScene, rainCam);
    camera.getWorldDirection(tmpV);
    renderer.shadowMap.autoUpdate = true;
    frameNo += 1;
    // Reflect the camera in the floor, unless it is looking at the ceiling. Nothing lives below the floor, so no clip plane is needed.
    if (tmpV.y < .6 && (tier < 3 || frameNo % 2 === 0 || frameNo < 3)) {
      tmpU.copy(camera.position).add(tmpV); camUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
      const m = FLOOR_Y * 2;
      mirrorCam.position.set(camera.position.x, m - camera.position.y, camera.position.z);
      mirrorCam.up.set(camUp.x, -camUp.y, camUp.z);
      mirrorCam.lookAt(tmpU.x, m - tmpU.y, tmpU.z); mirrorCam.updateMatrixWorld();
      mirrorCam.projectionMatrix.copy(camera.projectionMatrix); mirrorCam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
      U.uMirrorVP.value.multiplyMatrices(mirrorCam.projectionMatrix, mirrorCam.matrixWorldInverse);
      world.floor.visible = false; world.mist.visible = false; world.dust.visible = false;
      renderer.setRenderTarget(mirrorRT); renderer.clear(); renderer.render(scene, mirrorCam);
      world.floor.visible = true; world.mist.visible = true; world.dust.visible = true;
      renderer.shadowMap.autoUpdate = false;
    }
    renderer.setRenderTarget(post.sceneTarget); renderer.clear(); renderer.render(scene, camera);
    renderer.shadowMap.autoUpdate = false;
    invVP.multiplyMatrices(camera.matrixWorld, camera.projectionMatrixInverse);
    post.render(camera, invVP);
  }

  // The automated-browser throttle: real time keeps accumulating between the frames it lets through.
  let held = 0;
  hud.title(store.state.phase === 'intro');
  if (store.state.phase !== 'intro') arrive(store.state.phase, null);

  return {
    resize,
    frame(seconds) {
      held += seconds;
      if (automated && held < 1.8) return;        // leave the software rasteriser room to take the screenshot
      const raw = held; held = 0;
      update(Math.min(raw, automated ? 6 : 3), Math.min(raw, automated ? 4 : .1));
      renderFrame();
    },
    restored() {
      world.rebake();
      keySpot.shadow.needsUpdate = true; winSpot.shadow.needsUpdate = true;
      frameNo = 0;
    },
    dispose() {
      try {
        cleanups.reverse().forEach((f) => { try { f(); } catch (e) { console.error(e); } });
        lampSpot.dispose(); winSpot.dispose(); keySpot.dispose();
        world.dispose();
        trash.forEach((x) => { x.dispose(); });
        mirrorRT?.dispose();
        post.dispose();
        scene.environment = null;
      } finally {
        onDispose();
      }
    },
  };
}
