// The Deco Chandelier: a 1920s grand casino built into the shaft of a dilution refrigerator.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { stageNumber, sealEngraving, feltTextures, chipTextures, cardAtlas, chipTexture, dealerTextures, doorSign, cageBackdrop, wheelTexture, CARD_BACK, CARD_GRID } from './textures';

// Five real temperature stages. `s` along the shaft runs 0 at the 50 K plate to 1 at the mixing chamber,
// so the seal sits exactly three quarters of the way down: the depth of the wall is the wall.
export const TOP_Y = 31;
export const SEAL_S = 0.75;
/** Frost on the cold plates before the seal breaks: a bloom on the metal, not a coat over it. */
export const FROST = .18;
export const SEAL_Y = TOP_Y * (1 - SEAL_S);
export const FLOOR_Y = -9;
export const TABLE_Y = .036;
export const PAIR_A = new THREE.Vector3(-2, 1.12, 0);
export const PAIR_B = new THREE.Vector3(2, 1.12, 0);
export const WIN_DIR = new THREE.Vector3(.92, -.36, .15).normalize();     // blind light, from a tall window in the shaft wall
const PLATE_T = 1, CROWN_Y = 27.75, ROOM_R = 72;
export const TIERS = [
  { label: '50 K', y: 22.75, R: 9.6, bore: 3.15, name: 'First stage' },
  { label: '4 K', y: 17.75, R: 8.2, bore: 3.15, name: 'Second stage' },
  { label: '800 mK', y: 12.75, R: 6.8, bore: 3.15, name: 'Still' },
  { label: '100 mK', y: SEAL_Y, R: 5.2, bore: 3.0, name: 'Cold plate' },
  { label: '15 mK', y: 0, R: 4.2, bore: 0, name: 'Mixing chamber' },
] as const;
export const DOORS = [
  { name: 'cage', tier: 1, az: 1.02, sign: "The Cashier's Cage", stage: '4 K' },
  { name: 'wheel', tier: 2, az: .24, sign: 'The Roulette Wheel', stage: '800 mK' },
] as const;
type ProfilePoint = readonly [r: number, y: number, finish?: number];
interface Tier { label: string; y: number; R: number; bore: number; name: string }
// r, angle, y, s at each end; the tiers each end hangs from; radius and a seed; then the U-bend.
type Cable = [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
type PanelGroup = [tier: number, r: number, a: number, w: number, under: boolean];
const SPIN = [.05, .05, .05, .05, .05, .05];   // one rigid machine: the stack turns together so no line twists

const GOLD = new THREE.Color().setRGB(1.0, 0.73, 0.33, THREE.LinearSRGBColorSpace);

const worldUniforms = (noise: THREE.Texture) => ({
  uTime: { value: 0 }, uNoise: { value: noise }, uSc: { value: 0 }, uSweep: { value: -1 }, uSweepY: { value: 80 },
  uRot: { value: [0, 0, 0, 0, 0, 0] }, uPulses: { value: Array.from({ length: 8 }, () => new THREE.Vector3(-99, 0, 1)) },
  uPluck: { value: 0 }, uFrost: { value: FROST }, uChipCol: { value: new THREE.Color(1.1, 1.1, 1.2) }, uTopCol: { value: new THREE.Color(2.6, 2.0, 1.25) },
  uCrack: { value: 0 }, uOpen: { value: 0 }, uImpact: { value: 0 }, uImpactCol: { value: new THREE.Color(1, 1, 1) }, uImpactR: { value: 0 },
  uFlow: { value: 0 }, uLamp: { value: 1 }, uChip: { value: .55 }, uPair: { value: 0 }, uLink: { value: 0 }, uBeam: { value: 0 },
  uRate: { value: 0 }, uTarget: { value: 0 }, uFlash: { value: 0 }, uShard: { value: -1 }, uBlinds: { value: 1 },
  uR: { value: 0 }, uAir: { value: 0 }, uRainT: { value: 0 }, uPeel: { value: .67 }, uArm: { value: 0 }, uBars: { value: 1 },
  uThreadAmp: { value: .1 }, uThread: { value: 0 }, uThreadPulse: { value: 0 },
  tMirror: { value: null as THREE.Texture | null }, uMirrorVP: { value: new THREE.Matrix4() },
});
export type WorldUniforms = ReturnType<typeof worldUniforms>;

function mulberry(seed: number) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Tileable noise baked once: R soft clouds, G fine grain, B ridged crystal veins, A white noise.
function noiseTexture() {
  const N = 256, data = new Uint8Array(N * N * 4), rand = mulberry(7);
  const lattice = (p: number) => { const a = new Float32Array(p * p); for (let i = 0; i < a.length; i++) a[i] = rand(); return a; };
  const octave = (x: number, y: number, p: number, g: Float32Array) => {
    const fx = x / N * p, fy = y / N * p, ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const at = (i: number, j: number) => g[(i % p) + (j % p) * p]!;
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
  const ps = [4, 8, 16, 32, 64], gs = ps.map(lattice);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let soft = 0, amp = 0.5, ridge = 0, fine = 0;
    ps.forEach((p, i) => {
      const v = octave(x, y, p, gs[i]!);
      soft += v * amp; ridge += (1 - Math.abs(v * 2 - 1)) * amp; if (i > 1) fine += v * amp * 2; amp *= 0.5;
    });
    const k = (x + y * N) * 4;
    data[k] = Math.min(255, soft * 275); data[k + 1] = Math.min(255, fine * 240);
    data[k + 2] = Math.min(255, Math.pow(ridge, 3.2) * 300); data[k + 3] = rand() * 255;
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

// Procedural environment: a dark shaft full of ring lights and softbox strips, warm above and silver below.
function bakeEnvironment(renderer: THREE.WebGLRenderer) {
  const s = new THREE.Scene();
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    vertexShader: 'varying vec3 vD; void main(){ vD = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec3 vD;
      float band(float x, float c, float w){ return smoothstep(w, w*.35, abs(x-c)); }
      void main(){
        vec3 d = normalize(vD); float y = d.y; float az = atan(d.z, d.x);
        vec3 warm = vec3(1.0,.74,.46), cold = vec3(.66,.7,.78);
        vec3 c = mix(vec3(.006), warm*.035, smoothstep(.0,.8,y));
        c = mix(c, cold*.04, smoothstep(.05,-.75,y));
        c += warm*8.*smoothstep(.95,.99,y);                                 // great lamp overhead
        c += warm*4.2*band(y,.72,.02) + warm*2.6*band(y,.50,.012);             // ring lights
        c += warm*1.3*band(y,.24,.01);
        c += cold*.6*band(y,-.20,.012) + cold*.8*band(y,-.47,.02);
        c += cold*.5*smoothstep(-.92,-.98,y);                                 // the chip, far below
        float strips = pow(max(0.,cos(az*7.)),60.)*smoothstep(.72,.5,abs(y-.08));
        float thin = pow(max(0.,cos(az*19.+.8)),180.)*smoothstep(.85,.6,abs(y));
        c += mix(cold,warm,smoothstep(-.25,.25,y))*(strips*6.+thin*3.5);
        float spokes = pow(.5+.5*cos(az*5.+1.),5.) + .5*pow(.5+.5*cos(az*11.),12.);        // radial structure for the spun plates
        c *= mix(1., .22+spokes*1.5, smoothstep(.28,.5,y));
        c *= mix(1., .35+spokes*1.9, 1.-smoothstep(-.34,-.12,y));            // and from below, or a plate seen from under its axis is one flat tone
        float bulbs = pow(max(0.,cos(az*42.)),40.)*(band(y,.58,.03)+band(y,.34,.024));
        c += warm*bulbs*16.;
        gl_FragColor = vec4(c,1.);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 32), m); s.add(sky);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0, 0.1, 120);
  pm.dispose(); sky.geometry.dispose(); m.dispose();
  return rt;
}

// Hard-edged lathe: each profile segment keeps its own normal, so chamfers catch light like machined edges.
// A third value on a profile point marks the following segment: 1 polished, 2 lacquered fan, 3 lacquered rim.
// lathe() faces outward when a profile runs top to bottom. This walks a bottom-up profile the other way, keeping each segment's finish.
const upward = (pr: readonly ProfilePoint[]): ProfilePoint[] => pr.map((q, i): ProfilePoint => [q[0], q[1], i ? pr[i - 1]![2] || 0 : 0]).reverse();
function lathe(profile: readonly ProfilePoint[], seg = 168, arc = Math.PI * 2) {
  const pos: number[] = [], nor: number[] = [], pol: number[] = [], lac: number[] = [], idx: number[] = [];
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, y0, p = 0] = profile[i]!, [r1, y1] = profile[i + 1]!;
    const dr = r1 - r0, dy = y1 - y0, L = Math.hypot(dr, dy); if (L < 1e-6) continue;
    const nr = -dy / L, ny = dr / L, base = pos.length / 3;
    for (let j = 0; j <= seg; j++) {
      const t = (j / seg - .5) * arc, c = Math.cos(t), s = Math.sin(t);
      pos.push(r0 * c, y0, r0 * s, r1 * c, y1, r1 * s);
      nor.push(nr * c, ny, nr * s, nr * c, ny, nr * s); pol.push(p === 1 ? 1 : 0, p === 1 ? 1 : 0); if (p === 4) lac.push(1, 1, 1, 0); else lac.push(p >= 2 ? p - 1 : 0, 0, p >= 2 ? p - 1 : 0, 1);
      if (j < seg) { const a = base + j * 2; idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aPolish', new THREE.Float32BufferAttribute(pol, 1));
  g.setAttribute('aLacq', new THREE.Float32BufferAttribute(lac, 2));
  g.setIndex(idx);
  return g;
}

// A balcony: spun gold round the bore, a lacquered sunburst floor, a ziggurat kerb, and a lacquered marquee band under the rail.
function plateProfile(R: number, bore: number) {
  const T = PLATE_T, P: ProfilePoint[] = [];
  if (bore > 0) P.push([bore, -T, 1], [bore, 0, 1], [bore + .12, 0]); else P.push([.001, 0]);
  P.push([R - .62, 0], [R - .62, .09, 1], [R - .36, .09], [R - .36, .18, 1], [R, .18, 1], [R, .1], [R + .1, .1, 1], [R + .1, 0, 3], [R + .1, -.66], [R + .2, -.66, 1], [R + .2, -.8],
    [R + .06, -.8, 1], [R + .06, -.9], [R - .14, -.9, 1], [R - .14, -T], [R - .5, -T, 4], [bore > 0 ? bore + .04 : .001, -T]);
  if (bore > 0) P.push([bore, -T]);
  return P;
}

function polarRing(r0: number, r1: number, seg = 200) {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j <= seg; j++) {
    const u = j / seg, t = u * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    pos.push(r0 * c, 0, r0 * s, r1 * c, 0, r1 * s); uv.push(u, 0, u, 1);
    if (j < seg) { const a = j * 2; idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// The make-or-break material. Three's PBR is kept; the environment lookup is replaced with four samples fanned across
// the lathe grooves, which smears reflections radially, and a Kajiya hair-style lobe adds the bow-tie highlight of spun metal.
// Height drives everything else: reflections lean toward the cold half of the map, frost forms, the sweep burns it off.
// Speculars roll off into a warm ceiling instead of clipping at it, so wide plates keep their gradient.
const GOLD_SHOULDER = `vec3 chCeil = vec3(1.15,.85,.46);
        vec3 totalSpecular = chCeil*(1.-exp(-(reflectedLight.directSpecular + reflectedLight.indirectSpecular)/chCeil));`;
function patchGold(mat: THREE.MeshStandardMaterial, U: WorldUniforms, { spun = false, cable = false } = {}) {
  mat.defines = { ...mat.defines, ...(spun ? { CH_SPUN: 1 } : {}), ...(cable ? { CH_CABLE: 1 } : {}) };
  mat.onBeforeCompile = (s) => {
    for (const k of ['uTime', 'uSweepY', 'uSc', 'uNoise', 'uRot', 'uPulses', 'uSweep', 'uPluck', 'uChipCol', 'uFrost', 'uTopCol', 'uBlinds'] as const) s.uniforms[k] = U[k];
    s.vertexShader = s.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        #ifdef CH_SPUN
          attribute float aPolish; attribute vec2 aLacq; varying float vPolish; varying vec4 vLq;
        #endif
        #ifdef CH_CABLE
          attribute vec4 aA; attribute vec4 aB; attribute vec4 aC; attribute vec4 aD;
          // D: U-bend depth, unused, where the bend starts along the line, how much of the line it takes.
          vec3 cPath(vec3 a, vec3 b, float t, vec4 D) {
            vec3 p = mix(a,b,t), rad = normalize(vec3(p.x,0.,p.z)+1e-4);
            float u = clamp((t-D.z)/max(D.w,.001),0.,1.);
            float k = smoothstep(0.,.3,u)*(1.-smoothstep(.7,1.,u));         // out, along, back: a square loop, not a ripple
            return p + rad*D.x*k;
          }
          uniform float uTime, uSweep, uPluck, uSc; uniform float uRot[6]; uniform vec3 uPulses[8];
          varying vec3 vGlow; varying vec3 vTint;
        #endif`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        #ifdef CH_CABLE
          float cT = position.y;
          cT = cT < .25 ? cT/.25*aD.z : cT < .75 ? aD.z+(cT-.25)/.5*aD.w : aD.z+aD.w+(cT-.75)/.25*(1.-aD.z-aD.w);   // spend the segments on the bend
          float ca0 = aA.y + uRot[int(aC.x)], ca1 = aB.y + uRot[int(aC.y)];
          vec3 cP0 = vec3(aA.x*cos(ca0), aA.z, aA.x*sin(ca0)), cP1 = vec3(aB.x*cos(ca1), aB.z, aB.x*sin(ca1));
          vec3 cC = cPath(cP0, cP1, cT, aD);
          vec3 cD = normalize(cPath(cP0, cP1, cT+.003, aD)-cPath(cP0, cP1, cT-.003, aD)), cB = normalize(cross(cD, vec3(.8,.1,.3))), cN = cross(cB, cD);
          cC += cN * uPluck * sin(3.14159*cT) * sin(cT*11. + uTime*42. + aC.w*30.) * .055 * step(aC.z, .05);
          vec3 cO = position.x*cN + position.z*cB;
          vec3 cPos = cC + cO*aC.z;
          objectNormal = cO;
          float cS = mix(aA.w, aB.w, cT);
          vec3 cG = vec3(0.);
          for (int i = 0; i < 8; i++) {
            float age = uTime - uPulses[i].x;
            if (age < 0. || age > 2.6) continue;
            float d = cS - age*1.08;
            float gate = step(.5, fract(aC.w*13.7 + float(i)*.618));
            float stop = 1. - smoothstep(uPulses[i].z-.012, uPulses[i].z, cS);
            cG += exp(-d*d*520.)*gate*stop*mix(vec3(1.5,1.5,1.55), vec3(4.4,2.9,1.), uPulses[i].y);
          }
          float h = cS - uSweep;
          cG += (exp(-h*h*900.)*30. + step(h,0.)*exp(h*9.)*5.) * vec3(1.5,1.08,.52) * smoothstep(-.2,.0,uSweep) * (1.-smoothstep(1.,1.12,uSweep));
          float wave = pow(.5+.5*sin(cS*46. - uTime*3.4 + aC.w*6.28), 14.);
          cG += uSc * wave * mix(vec3(.1,1.3,.45), vec3(2.2,1.45,.5), step(.45,fract(aC.w*7.))) * .6 * step(aC.z, .05);
          vGlow = cG;
          vTint = vec3(.8,.81,.83);
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef CH_CABLE
          transformed = cPos;
        #endif`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        { vec4 w = vec4(transformed, 1.);
          #ifdef USE_INSTANCING
            w = instanceMatrix * w;
          #endif
          vWPos = (modelMatrix * w).xyz;
          #ifdef CH_SPUN
            vPolish = aPolish; vLq = vec4(aLacq, position.x, position.z);
          #endif
        }`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos;
        uniform float uTime, uSweepY, uSc, uFrost, uBlinds; uniform sampler2D uNoise; uniform vec3 uChipCol, uTopCol;
        #ifdef CH_SPUN
          varying float vPolish; varying vec4 vLq;
        #endif
        #ifdef CH_CABLE
          varying vec3 vGlow; varying vec3 vTint;
        #endif`)
      .replace('void main() {', `
        vec3 chIBL(vec3 v, vec3 n, float rough, float bias) {
          vec3 r = reflect(-v, n);
          r = normalize(mix(r, n, rough*rough));
          r = inverseTransformDirection(r, viewMatrix);
          r.y -= bias; r = normalize(r);
          return textureCubeUV(envMap, envMapRotation*r, rough).rgb * envMapIntensity;
        }
        float chSpun(vec3 T, vec3 N, vec3 V, vec3 Lp) {
          vec3 L = normalize(Lp - vWPos), H = normalize(L + V);
          float th = dot(T, H);
          float s = pow(max(0., 1. - th*th), 420.) + pow(max(0., 1. - th*th), 46.) * .055;
          return s * smoothstep(-.05, .3, dot(N, L));
        }
        // Venetian blinds thrown across the metal. Metal has no diffuse to catch a gobo, so the bars cut its reflections instead.
        float chSlat(vec3 p) { const vec3 L = vec3(-.92,.36,-.15); vec3 up = normalize(vec3(0.,1.,0.)-L*L.y*.81);
          return smoothstep(.2,.3,abs(fract(dot(p,up)*.9+.13)-.5)); }
        void main() {
        float chLq = 0.;
        #ifdef CH_SPUN
        if (vLq.x > .5) {
          float a = atan(vLq.w, vLq.z)/6.2831853+.5, t = vLq.y;
          if (vLq.x < 1.5) { float n = 56., q = a*n, f = abs(fract(q)-.5)*2., fw = min(fwidth(q)*2.,.5);
            float w = mix(.08,.34,t), len = mod(floor(q),2.)<.5 ? 1. : .6;
            chLq = 1.-(1.-smoothstep(w-fw,w+fw,f))*step(t,len);
          } else { float q = a*72., f = abs(fract(q)-.5)*2.; chLq = mix(smoothstep(.1,.2,f), .3, smoothstep(.09,.2,fwidth(q)))*step(.05,t)*step(t,.95); }
        }
        #endif
        float chS = chSlat(vWPos);
        float chCold = smoothstep(21., 2.5, vWPos.y);
        float chR = length(vWPos.xz);
        vec2 chUv = vWPos.xz*.105 + vWPos.y*.061;
        float chN = texture2D(uNoise, chUv).r, chN2 = texture2D(uNoise, chUv*3.3).b;
        float chBurn = smoothstep(uSweepY-.8, uSweepY+.8, vWPos.y);
        float chFrost = uFrost*chCold*smoothstep(.36,.66, chN*.8 + chN2*.75 + chCold*.2)*(1.-chBurn);
        vec3 chWorldT = normalize(vec3(-vWPos.z, 0., vWPos.x) + 1e-4);`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        #ifdef CH_CABLE
          diffuseColor.rgb *= vTint;
        #endif
        #ifndef CH_CABLE
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb*vec3(.97,1.0,1.06), chCold*(1.-uSc*.7)*.6);
        #endif
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.09,.006,.011), chLq);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.82,.84,.87), chFrost);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        #ifdef CH_SPUN
          roughnessFactor = max(.05, roughnessFactor - vPolish*.13 + (chN-.5)*.05);
        #endif
        roughnessFactor = mix(roughnessFactor, .09, chLq);
        roughnessFactor = mix(roughnessFactor, .58, chFrost);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(metalnessFactor, .0, chLq);
        metalnessFactor = mix(metalnessFactor, .6, chFrost);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        #ifdef CH_SPUN
        { float fw = fwidth(chR);
          float g = (sin(chR*83.) + .5*sin(chR*211.+2.)) * (1.-smoothstep(.015,.07,fw)) * (1.-vPolish*.7) * (1.-chLq);
          vec3 rad = normalize(vec3(vWPos.x, 0., vWPos.z) + 1e-4);
          normal = normalize(normal + (viewMatrix*vec4(rad,0.)).xyz * g * .011);
          normal = normalize(normal + (viewMatrix*vec4(chWorldT,0.)).xyz * (chN2-.2) * chFrost * .5);
        }
        #endif`)
      .replace('#include <lights_fragment_maps>', `
        #if defined(RE_IndirectDiffuse) && defined(USE_ENVMAP)
          iblIrradiance += getIBLIrradiance(geometryNormal);
        #endif
        #if defined(USE_ENVMAP) && defined(RE_IndirectSpecular)
        { float bias = chCold*.18*(1.-uSc*.45);
          #ifdef CH_SPUN
            vec3 vT = normalize((viewMatrix*vec4(chWorldT,0.)).xyz);
            vec3 vB = normalize(cross(vT, geometryNormal));
            float rr = material.roughness, f = 1.-vPolish*.8;
            vec3 acc = chIBL(geometryViewDir, normalize(geometryNormal+vB*.25*f), rr, bias)
                     + chIBL(geometryViewDir, normalize(geometryNormal-vB*.25*f), rr, bias)
                     + chIBL(geometryViewDir, normalize(geometryNormal+vB*.08*f), rr, bias)
                     + chIBL(geometryViewDir, normalize(geometryNormal-vB*.08*f), rr, bias);
            radiance += acc*.155;
          #else
            radiance += chIBL(geometryViewDir, geometryNormal, material.roughness, bias*.6) * .42;
          #endif
          radiance *= mix(vec3(1.06,1.0,.94), vec3(.97,.98,1.03), chCold) * (1.+chLq*1.8);
          #ifndef CH_CABLE
          { vec3 Nb = inverseTransformDirection(geometryNormal, viewMatrix);
            radiance *= mix(1., mix(.2, 1.45, chS), uBlinds*smoothstep(.05,.4,dot(Nb,normalize(vec3(-.92,.36,-.15)))+.3)); }
          #endif
        }
        #endif`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        #ifdef CH_CABLE
          reflectedLight.directSpecular *= .07;
        #else
          reflectedLight.directSpecular *= .13;
        #endif
        #ifdef CH_SPUN
        { vec3 Vw = normalize(cameraPosition - vWPos);
          vec3 Nw = inverseTransformDirection(normal, viewMatrix);
          float top = chSpun(chWorldT, Nw, Vw, vec3(42.,50.,26.)) + chSpun(chWorldT, Nw, Vw, vec3(-48.,34.,-22.))*.7;
          float low = chSpun(chWorldT, Nw, Vw, vec3(0.,1.2,0.))*.2;
          float head = smoothstep(.985,.8,dot(Nw,Vw)); top *= head; low *= head;      // straight overhead the lobe floods the whole plate
          #ifdef CH_CABLE
          top *= .3;
          #endif
          reflectedLight.directSpecular += material.specularColor * (top*uTopCol*mix(1.,.4+chS*1.1,uBlinds) + low*uChipCol*.32) * (1.-chFrost) * (1.-chLq);
        }
        #endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        #ifdef CH_CABLE
          totalEmissiveRadiance += vGlow;
        #endif
        totalEmissiveRadiance += exp(-pow(vWPos.y-uSweepY,2.)*.18)*vec3(1.6,1.15,.55)*.9*(uSweepY<40.&&uSweepY>-3.?1.:0.);`)
      .replace('vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;', GOLD_SHOULDER)
      .replace('#include <fog_fragment>', `
        #ifdef USE_FOG
          float fogF = 1. - exp(-fogDensity*fogDensity*vFogDepth*vFogDepth);
          gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(vec3(.022,.016,.009), vec3(.009,.011,.016), smoothstep(26.,4.,vWPos.y)), fogF);
        #endif`);
  };
  return mat;
}

function zigShape(w: number, h: number) {
  const s = new THREE.Shape(), a = h * .7, b = h * .85, w2 = w * .78, w3 = w * .52;
  s.moveTo(-w, 0); s.lineTo(w, 0); s.lineTo(w, a); s.lineTo(w2, a); s.lineTo(w2, b); s.lineTo(w3, b); s.lineTo(w3, h);
  s.lineTo(-w3, h); s.lineTo(-w3, b); s.lineTo(-w2, b); s.lineTo(-w2, a); s.lineTo(-w, a); s.closePath();
  return s;
}
function fanShapes(r0: number, r1: number, rays: number) {
  const out: THREE.Shape[] = [];
  for (let i = 0; i < rays; i++) {
    const m = Math.PI * (i + .5) / rays, h0 = Math.PI / rays * .1, h1 = Math.PI / rays * .36, s = new THREE.Shape();
    s.moveTo(Math.cos(m - h0) * r0, Math.sin(m - h0) * r0); s.lineTo(Math.cos(m - h1) * r1, Math.sin(m - h1) * r1);
    s.lineTo(Math.cos(m + h1) * r1, Math.sin(m + h1) * r1); s.lineTo(Math.cos(m + h0) * r0, Math.sin(m + h0) * r0); s.closePath();
    out.push(s);
  }
  return out;
}

function floorMaterial(U: WorldUniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .3, metalness: 0, envMapIntensity: 0 });
  mat.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, { tMirror: U.tMirror, uMirrorVP: U.uMirrorVP, uT: U.uTime });
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWP;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWP = (modelMatrix*vec4(transformed,1.)).xyz;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
        varying vec3 vWP; uniform sampler2D tMirror; uniform mat4 uMirrorVP; uniform float uT;
        float h21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
        float vn(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h21(i),h21(i+vec2(1,0)),f.x),mix(h21(i+vec2(0,1)),h21(i+vec2(1,1)),f.x),f.y); }
        float fb(vec2 p){ float a=.5,s=0.; for(int i=0;i<4;i++){ s+=a*vn(p); p=p*2.03+7.1; a*=.5; } return s; }
        float ln(float d,float w){ float f=fwidth(d)+1e-4; return 1.-smoothstep(w-f,w+f,abs(d)); }
        struct Fl{ vec3 alb; float metal; float rough; };
        Fl pattern(vec2 p){
          Fl o; float vein = fb(p*vec2(.3,.2)+fb(p*.3)*2.4);
          float v = smoothstep(.015,.0,abs(vein-.46))*.5;
          vec3 stone = vec3(.008,.009,.01)+v*vec3(.05,.05,.046);
          float r = length(p), a = atan(p.y,p.x);
          float n = 48., ray = fract(a/6.2831853*n), wedge = step(.5,fract(a/6.2831853*n*.5));
          float inR = smoothstep(27.,26.95,r)*smoothstep(7.,7.05,r);
          stone = mix(stone, wedge>.5 ? vec3(.06,.005,.008) : vec3(.007,.007,.008), inR);
          float brass = inR*max(ln((ray-.5)*r*6.2831853/n,.03), ln(ray*r*6.2831853/n,.03));
          for(int i=0;i<3;i++){ brass = max(brass, ln(r-(6.8+float(i)*.22),.04)); brass = max(brass, ln(r-(27.+float(i)*.22),.04)); }
          o.alb = mix(stone, vec3(.86,.64,.28), brass);
          o.metal = brass;
          float wet = smoothstep(.34,.62,fb(p*.14+3.));
          o.rough = mix(.26-.1*wet, .3, brass);
          return o;
        }`)
      .replace('#include <color_fragment>', '#include <color_fragment>\nFl fl = pattern(vWP.xz); diffuseColor.rgb = fl.alb;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = fl.rough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = fl.metal;')
      .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directSpecular *= .05;')
      .replace('#include <opaque_fragment>', /* glsl */`
        { vec3 vv = normalize(cameraPosition-vWP);
          float cosT = clamp(vv.y,0.,1.);
          float F = .13+.87*pow(1.-cosT,3.6);
          float wob = (vn(vWP.xz*1.2+uT*.03)-.5)*.012+(vn(vWP.xz*5.)-.5)*.004;
          vec4 cp = uMirrorVP*vec4(vWP,1.); vec2 uv = cp.xy/cp.w*.5+.5;
          uv.x += wob*.6; uv.y += wob;
          float lod = .3+fl.rough*5.;
          vec3 R = textureLod(tMirror,uv,lod).rgb*.5 + textureLod(tMirror,uv+vec2(0.,.007*lod),lod+1.).rgb*.3 + textureLod(tMirror,uv-vec2(0.,.007*lod),lod+1.).rgb*.2;
          outgoingLight = outgoingLight*(1.-F*.4) + min(R,vec3(1.1))*F*mix(1.,1.25,fl.metal); }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'deco-floor';
  return mat;
}

export function buildWorld(renderer: THREE.WebGLRenderer, { limitPct, breakEvenPct, reduced }: { limitPct: string; breakEvenPct: string; reduced: boolean }) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x000000, 0.0048);
  const noise = noiseTexture();
  let envRT = bakeEnvironment(renderer);
  scene.environment = envRT.texture;

  const U = worldUniforms(noise);

  const owned = { textures: [noise] as THREE.Texture[], geos: [] as THREE.BufferGeometry[], mats: [] as THREE.Material[] };
  const tex = <T extends THREE.Texture>(t: T) => { owned.textures.push(t); return t; };
  const geo = <T extends THREE.BufferGeometry>(g: T) => { owned.geos.push(g); return g; };
  const std = (o: THREE.MeshStandardMaterialParameters) => { const m = new THREE.MeshStandardMaterial(o); owned.mats.push(m); return m; };

  const goldTop = patchGold(new THREE.MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: .17 }), U, { spun: true });
  const goldPlain = patchGold(new THREE.MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: .28 }), U);
  const goldThin = patchGold(new THREE.MeshStandardMaterial({ color: GOLD, metalness: 1, roughness: .28, side: THREE.DoubleSide }), U);
  const cableMat = patchGold(new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: .3 }), U, { cable: true });
  const goldDull = patchGold(new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(.4, .27, .11, THREE.LinearSRGBColorSpace), metalness: 1, roughness: .5 }), U);
  // Wide flat gold under the lamp: a brushed, part-diffuse finish, because full metal there goes to cream.
  const goldBase = new THREE.MeshStandardMaterial({ color: new THREE.Color().setRGB(.34, .23, .09, THREE.LinearSRGBColorSpace), metalness: .55, roughness: .62 }); owned.mats.push(goldBase);
  const shouldered = (sh: { fragmentShader: string }) => { sh.fragmentShader = sh.fragmentShader.replace('vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;', GOLD_SHOULDER); };
  goldBase.onBeforeCompile = shouldered;
  const lacquer = std({ color: 0x050507, roughness: .14, envMapIntensity: 1.5 }); lacquer.onBeforeCompile = shouldered;
  const velvet = std({ color: 0x5c0d18, roughness: .78, envMapIntensity: .15, side: THREE.DoubleSide });

  const tierGroups: THREE.Group[] = [];
  const numberGeo = geo(new THREE.PlaneGeometry(2.4, .6));
  const boltGeo = geo(new THREE.CylinderGeometry(.052, .06, .05, 6));
  const canGeo = geo(lathe(upward([[0, 0], [.42, 0], [.42, .07, 1], [.34, .07], [.34, .62], [.38, .62], [.38, .7, 1], [.3, .72], [0, .74]]), 12));
  const attenGeo = geo(lathe(upward([[.085, 0], [.085, .07, 1], [.06, .07], [.06, .24, 1], [.04, .24], [.04, .32]]), 6));
  const panelGeo = geo(new THREE.BoxGeometry(1, .05, .72));
  const cuffGeo = geo(lathe(upward([[.22, 0], [.22, .07, 1], [.17, .07], [.17, .15, 1], [.12, .15], [.12, .28, 1], [.08, .28]]), 14));

  // Sturdy posts, fluted just enough to catch a line of light.
  const fluteGeo = geo(new THREE.CylinderGeometry(.27, .27, 1, 36, 1, true)); fluteGeo.translate(0, -.5, 0);
  { const a = fluteGeo.getAttribute('position'); for (let i = 0; i < a.count; i++) { const th = Math.atan2(a.getZ(i), a.getX(i)), k = 1 + .06 * Math.cos(th * 12); a.setX(i, a.getX(i) * k); a.setZ(i, a.getZ(i) * k); } fluteGeo.computeVertexNormals(); }

  const rand = mulberry(11);
  const dummy = new THREE.Object3D();
  const CANS = [null, [8, 1.1, 5.2], [12, .8, 4.35], [16, .46, 3.5], [18, .34, 3.34]] as const;
  TIERS.forEach((t: Tier, ti) => {
    const g = new THREE.Group(); g.position.y = t.y; scene.add(g); tierGroups.push(g);
    const plateGeo = geo(lathe(plateProfile(t.R, t.bore)));
    const plate = new THREE.Mesh(plateGeo, goldTop); plate.castShadow = plate.receiveShadow = true; g.add(plate);

    const nB = Math.round(t.R * 6), bm = new THREE.InstancedMesh(boltGeo, goldPlain, nB);
    for (let i = 0; i < nB; i++) { const a = (i + .5) / nB * Math.PI * 2; dummy.position.set((t.R - .18) * Math.cos(a), .205, (t.R - .18) * Math.sin(a)); dummy.rotation.set(0, a * 3, 0); dummy.updateMatrix(); bm.setMatrixAt(i, dummy.matrix); }
    g.add(bm);

    // Cans and cylinders gather on the colder plates.
    const doorAz = DOORS.filter((d) => (d.tier as number) === ti).map((d) => d.az);
    const clear = (a: number) => doorAz.every((d) => Math.abs(Math.atan2(Math.sin(a - d), Math.cos(a - d))) > 1.4 / t.R);
    const canRow = CANS[ti]; if (canRow) { const [n, sc, rc] = canRow, cans: number[] = []; for (let i = 0; i < n; i++) { const a = (i + .5) / n * Math.PI * 2 + .3; if (clear(a)) cans.push(a); }
      const cm = new THREE.InstancedMesh(canGeo, goldPlain, cans.length);
      cans.forEach((a, i) => { dummy.position.set(rc * Math.cos(a), 0, rc * Math.sin(a)); dummy.scale.setScalar(sc); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); cm.setMatrixAt(i, dummy.matrix); });
      dummy.scale.set(1, 1, 1); cm.castShadow = true; g.add(cm); }

    // Stage numbers cast in brass on the rim, like the floor numbers in a hotel.
    const nP = ti < 4 ? 6 : 4, numM = std({ map: tex(stageNumber(t.label)), transparent: true, alphaTest: .35, metalness: .75, roughness: .34, envMapIntensity: .8, depthWrite: false, emissive: 0xffffff, emissiveIntensity: .42 }); numM.emissiveMap = numM.map;
    const nums = new THREE.InstancedMesh(numberGeo, numM, nP);
    for (let i = 0; i < nP; i++) { const a = i / nP * Math.PI * 2 + 2.9; dummy.position.set((t.R + .115) * Math.cos(a), -.33, (t.R + .115) * Math.sin(a)); dummy.rotation.set(0, Math.PI / 2 - a, 0); dummy.updateMatrix(); nums.setMatrixAt(i, dummy.matrix); }
    dummy.rotation.set(0, 0, 0); g.add(nums);
  });

  // The crown: a last, wider plate with a stepped shoulder, from which the column and the whole stack hang.
  const capGeo = geo(lathe([[0, 1.7], [2.5, 1.7], [2.5, 1.2, 1], [4.4, 1.2], [4.4, .8, 1], [6.6, .8], [6.6, .4, 1], [8.8, .4], [8.8, .18, 1], ...plateProfile(10.2, 0).slice(4)]));
  const cap = new THREE.Mesh(capGeo, goldTop); cap.position.y = CROWN_Y; cap.castShadow = true; scene.add(cap);

  // The cooling unit: a solid column from the ceiling to a stepped nose under the still. The lamp hangs below that nose.
  const noseY = TIERS[2].y - PLATE_T;
  const colProfile: ProfilePoint[] = [[1.7, 150], [1.7, CROWN_Y + 2.2, 1]];
  TIERS.slice(0, 3).forEach((t: Tier) => colProfile.push([2.02, t.y + 1.2], [2.02, t.y + .85, 1], [1.7, t.y + .85], [1.7, t.y - PLATE_T - .5, 1], [2.02, t.y - PLATE_T - .5], [2.02, t.y - PLATE_T - .85, 1], [1.7, t.y - PLATE_T - .85]));
  colProfile.splice(colProfile.length - 3);
  colProfile.push([1.7, noseY - .2, 1], [1.25, noseY - .2], [1.25, noseY - .55, 1], [.7, noseY - .55], [.7, noseY - .8, 1], [0, noseY - .8]);
  const colMesh = new THREE.Mesh(geo(lathe(colProfile, 72)), goldPlain); colMesh.castShadow = true; scene.add(colMesh);
  { const n = 14, pipeGeo = geo(new THREE.CylinderGeometry(.1, .1, 1, 8)), m = new THREE.InstancedMesh(pipeGeo, goldDull, n), top = 80;
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; dummy.position.set(1.78 * Math.cos(a), (top + noseY) / 2, 1.78 * Math.sin(a)); dummy.scale.set(1, top - noseY, 1); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); }
    dummy.scale.set(1, 1, 1); scene.add(m); }

  // The gilded lift: an open cage that rides round the column, through the bores.
  const lift = new THREE.Group(); scene.add(lift);
  { const collar = geo(lathe([[2.42, .16], [2.92, .16, 1], [2.92, .05], [3.0, .05, 1], [3.0, -.05], [2.42, -.05]], 64)), H = 2.1;
    lift.add(new THREE.Mesh(collar, goldPlain)); const roof = new THREE.Mesh(collar, goldPlain); roof.position.y = H; lift.add(roof);
    const mid = new THREE.Mesh(geo(new THREE.TorusGeometry(2.85, .03, 6, 64).rotateX(Math.PI / 2)), goldPlain); mid.position.y = H * .62; lift.add(mid);
    const n = 24, bars = new THREE.InstancedMesh(geo(new THREE.CylinderGeometry(.032, .032, H, 6)), goldPlain, n);
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; dummy.position.set(2.85 * Math.cos(a), H / 2, 2.85 * Math.sin(a)); dummy.updateMatrix(); bars.setMatrixAt(i, dummy.matrix); }
    lift.add(bars); }

  // The mixing chamber: a solid gold drum under the last plate, the chip mount at its foot.
  const mxGeo = geo(lathe([[3.32, -.98], [3.32, -1.18, 1], [3.05, -1.18], [3.05, -3.2], [3.32, -3.2, 1], [3.32, -3.4], [3.0, -3.4, 1], [2.4, -3.4], [2.4, -3.62, 1], [1.7, -3.62], [1.7, -3.84, 1], [1.1, -3.84], [1.1, -4.5], [1.36, -4.5, 1], [1.36, -4.72], [0, -4.72]], 96));
  const chamber = tierGroups[4]!, mx = new THREE.Mesh(mxGeo, goldTop); mx.castShadow = true; chamber.add(mx);
  { const n = 28, bolts = new THREE.InstancedMesh(boltGeo, goldPlain, n * 2);
    for (let i = 0; i < n * 2; i++) { const a = i / n * Math.PI * 2, y = i < n ? -1.2 : -3.42; dummy.position.set(3.18 * Math.cos(a), y, 3.18 * Math.sin(a)); dummy.rotation.set(Math.PI, 0, 0); dummy.updateMatrix(); bolts.setMatrixAt(i, dummy.matrix); }
    dummy.rotation.set(0, 0, 0); chamber.add(bolts);
    const pkg = new THREE.Mesh(geo(new THREE.BoxGeometry(1.2, .14, 1.2)), goldDull); pkg.position.y = -4.8; chamber.add(pkg); }

  // Sturdy posts between plates, each with a stepped cuff top and bottom.
  const postSpan = (tier: number, r: number, top: number, bottom: number, n: number, phase: number, sc: number) => { const m = new THREE.InstancedMesh(fluteGeo, goldPlain, n), c = new THREE.InstancedMesh(cuffGeo, goldPlain, n * 2);
    for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2 + phase, x = r * Math.cos(a), z = r * Math.sin(a);
      dummy.position.set(x, top, z); dummy.rotation.set(0, 0, 0); dummy.scale.set(sc, top - bottom, sc); dummy.updateMatrix(); m.setMatrixAt(k, dummy.matrix);
      dummy.scale.setScalar(sc * 2); dummy.position.y = bottom; dummy.updateMatrix(); c.setMatrixAt(k * 2, dummy.matrix);
      dummy.position.y = top; dummy.rotation.set(Math.PI, 0, 0); dummy.updateMatrix(); c.setMatrixAt(k * 2 + 1, dummy.matrix); }
    dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0); m.castShadow = true; tierGroups[tier]!.add(m, c); };
  postSpan(0, 9.1, CROWN_Y - PLATE_T - TIERS[0].y, .18, 8, .63, 1.15);
  for (let i = 0; i < 4; i++) { const B: Tier = TIERS[i + 1]!; postSpan(i, B.R - .4, -PLATE_T, B.y - TIERS[i]!.y, 8, .63, i < 3 ? 1.15 : .72); }

  // Nickel lines in tidy rows, plate to plate, each with one matching U-bend at its stage. Repetition is the point.
  const cables: Cable[] = [], groups: PanelGroup[] = [];
  const line = (i0: number, i1: number, r: number, th: number, D: [number, number, number, number]) => {
    const y0 = (i0 >= 0 ? TIERS[i0]!.y : CROWN_Y) - PLATE_T, y1 = TIERS[i1]!.y + .05;
    cables.push([r, th, y0, (TOP_Y - y0) / TOP_Y, r, th, y1, (TOP_Y - y1) / TOP_Y, i0 >= 0 ? i0 : 5, i1, .032, rand(), ...D]);
  };
  const span = (i0: number, i1: number, rs: number[], n: number, sectors: number, phase: number) => {
    const L = (i0 >= 0 ? TIERS[i0]!.y : CROWN_Y) - PLATE_T - TIERS[i1]!.y, w = Math.min(.34, 1.15 / L);
    rs.forEach((r, row) => { const dth = .2 / r;
      for (let s = 0; s < sectors; s++) { const c = s / sectors * Math.PI * 2 + phase;
        for (let k = 0; k < n; k++) line(i0, i1, r, c + (k - (n - 1) / 2) * dth, [.24, 0, (row ? .52 : .3), w]); } });
    for (let s = 0; s < sectors; s++) { const c = s / sectors * Math.PI * 2 + phase, r = rs.reduce((a, x) => a + x, 0) / rs.length; groups.push([i1, r, c, n * .2 + .16, false]); if (i0 >= 0) groups.push([i0, r, c, n * .2 + .16, true]); }
  };
  span(-1, 0, [8.2], 8, 12, .13);
  span(0, 1, [7.25, 6.85], 8, 12, .13);
  span(1, 2, [5.85, 5.45], 7, 12, .13);
  span(2, 3, [4.42, 4.02], 6, 12, .13);
  span(3, 4, [3.84], 6, 8, .24);

  // A connector at each end of every line, standing on a gold patch panel at the plate edge.
  const attens: [number, number, number, boolean][][] = [[], [], [], [], []];
  for (const c of cables) { if (c[8] < 5) attens[c[8]]!.push([c[0], c[1], -PLATE_T - .05, true]); attens[c[9]]!.push([c[4], c[5], .05, false]); }
  attens.forEach((list, i) => {
    const am = new THREE.InstancedMesh(attenGeo, goldPlain, list.length);
    list.forEach(([r, a, y, flip], k) => { dummy.position.set(r * Math.cos(a), y, r * Math.sin(a)); dummy.rotation.set(flip ? Math.PI : 0, 0, 0); dummy.updateMatrix(); am.setMatrixAt(k, dummy.matrix); });
    tierGroups[i]!.add(am); });
  { const perTier: PanelGroup[][] = [[], [], [], [], []]; groups.forEach((x) => perTier[x[0]]!.push(x));
    perTier.forEach((list, i) => { const pm = new THREE.InstancedMesh(panelGeo, goldDull, list.length);
      list.forEach(([, r, a, w, under], k) => { dummy.position.set(r * Math.cos(a), under ? -PLATE_T - .025 : .025, r * Math.sin(a)); dummy.rotation.set(0, Math.PI / 2 - a, 0); dummy.scale.set(w, 1, 1); dummy.updateMatrix(); pm.setMatrixAt(k, dummy.matrix); });
      dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0); tierGroups[i]!.add(pm); }); }

  const cableGeo = new THREE.InstancedBufferGeometry();
  { const seg = 20, sides = 4, pos: number[] = [], nor: number[] = [], idx: number[] = [];
    for (let j = 0; j <= seg; j++) for (let k = 0; k < sides; k++) { const p = k / sides * Math.PI * 2; pos.push(Math.cos(p), j / seg, Math.sin(p)); nor.push(Math.cos(p), 0, Math.sin(p));
      if (j < seg) { const a = j * sides + k, b = j * sides + (k + 1) % sides; idx.push(a, a + sides, b, b, a + sides, b + sides); } }
    cableGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    cableGeo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    cableGeo.setIndex(idx); }
  const inst = () => new THREE.InstancedBufferAttribute(new Float32Array(cables.length * 4), 4);
  const aA = inst(), aB = inst(), aC = inst(), aD = inst();
  cables.forEach((c, i) => { aA.setXYZW(i, c[0], c[1], c[2], c[3]); aB.setXYZW(i, c[4], c[5], c[6], c[7]); aC.setXYZW(i, c[8], c[9], c[10], c[11]); aD.setXYZW(i, c[12], c[13], c[14], c[15]); });
  cableGeo.setAttribute('aA', aA); cableGeo.setAttribute('aB', aB); cableGeo.setAttribute('aC', aC); cableGeo.setAttribute('aD', aD);
  cableGeo.instanceCount = cables.length; owned.geos.push(cableGeo);
  const cableMesh = new THREE.Mesh(cableGeo, cableMat); cableMesh.frustumCulled = false; scene.add(cableMesh);

  // The grand hall: a dark rotunda of pilasters and warm sconces, one tall window with its blinds down. Far enough off to stay a backdrop.
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(ROOM_R, ROOM_R, 260, 128, 1, true), new THREE.ShaderMaterial({
    side: THREE.BackSide, uniforms: { uSc: U.uSc, uLamp: U.uLamp, uTime: U.uTime, uSweepY: U.uSweepY, uRainT: U.uRainT },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix*vec4(position,1.); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }',
    fragmentShader: `varying vec3 vW; uniform float uSc,uLamp,uTime,uSweepY,uRainT;
      void main(){ float az = atan(vW.z,vW.x), y = vW.y;
        vec3 warm = vec3(1.,.72,.4);
        float n = 18., b = fract(az/6.2831853*n)-.5, w = b*${ROOM_R}.*6.2831853/n;
        float pil = 1.-smoothstep(1.5,1.56,abs(w)), flute = .75+.25*sin(w*9.);
        float S = y<20. ? 4. : 27.;
        float glow = exp(-(w*w*.02+(y-S)*(y-S)*.012));
        float cap = exp(-pow(y-20.,2.)*6.)+exp(-pow(y-48.,2.)*3.);
        vec3 c = vec3(.0022,.002,.0018) + warm*glow*(.05+pil*flute*.11);
        c += warm*cap*.018*(1.+pil);
        c *= smoothstep(66.,44.,y)*.9+.1;
        // Window, centred on the blind light's bearing, stepped at the head.
        float wa = abs(atan(sin(az+2.98),cos(az+2.98)))*${ROOM_R}.;
        float head = wa<3.5?60.:wa<6.?55.:wa<9.?49.:0.;
        float win = step(wa,9.)*step(y,head)*step(-9.,y)*step(.5,abs(wa-3.)*2.)*step(.5,abs(wa+0.)*40.);
        float slat = smoothstep(.16,.24,abs(fract(y*1.3)-.5));
        c += vec3(1.,.98,.94)*win*slat*.7*(.8+.2*sin(y*.7+uRainT*4.));
        c *= .4+.6*uLamp;
        c += vec3(1.5,1.1,.55)*exp(-pow(y-uSweepY,2.)*.04)*(uSweepY<40.?.3:0.);
        gl_FragColor = vec4(c,1.); }`,
  }));
  shaft.position.y = 16; scene.add(shaft);
  const roomDark = std({ color: 0x120c07, roughness: .55, metalness: .2, emissive: 0x2a1a0c, emissiveIntensity: .32, envMapIntensity: .25 });
  const roomBrass = std({ color: 0x8a6428, roughness: .4, metalness: .85, emissive: 0x7a4f1c, emissiveIntensity: .3, envMapIntensity: .3 });
  const sconceMat = new THREE.MeshBasicMaterial({ color: 0xffffff }); sconceMat.color.setRGB(1.5, 1.05, .6); owned.mats.push(sconceMat);
  { const arc = .62, RB = ROOM_R;
    const slab = geo(lathe([[RB + 1, -.8], [RB - 5.8, -.8], [RB - 5.8, -.4], [RB - 6.1, -.4], [RB - 6.1, 1.5], [RB - 5.8, 1.5], [RB - 5.8, 0], [RB + 1, 0]], 40, arc));
    const rail = geo(lathe([[RB - 6.18, 1.5], [RB - 6.18, 1.62], [RB - 5.74, 1.62], [RB - 5.74, 1.5]], 40, arc));
    const slabs = new THREE.InstancedMesh(slab, roomDark, 12), rails = new THREE.InstancedMesh(rail, roomBrass, 12);
    const bulbs = new THREE.InstancedMesh(geo(new THREE.IcosahedronGeometry(.34, 1)), sconceMat, 30), wallBulbs = 18;
    for (let k = 0; k < 12; k++) { const a = (k % 6) / 6 * Math.PI * 2 + .52, y = k < 6 ? 11 : 33; dummy.position.set(0, y, 0); dummy.rotation.set(0, -a, 0); dummy.updateMatrix(); slabs.setMatrixAt(k, dummy.matrix); rails.setMatrixAt(k, dummy.matrix);
      const bx = (RB - 6.3); dummy.rotation.set(0, 0, 0); dummy.position.set(bx * Math.cos(a), y + 2, bx * Math.sin(a)); dummy.updateMatrix(); bulbs.setMatrixAt(k, dummy.matrix); }
    for (let k = 0; k < wallBulbs; k++) { const a = (k + .5 * 0) / wallBulbs * Math.PI * 2, y = k % 2 ? 4 : 27, r = RB - .3; dummy.position.set(r * Math.cos(a), y, r * Math.sin(a)); dummy.updateMatrix(); bulbs.setMatrixAt(12 + k, dummy.matrix); }
    scene.add(slabs, rails, bulbs); }
  // The casino floor below: a few tables, each in its own small pool of light.
  { const n = 12, tGeo = geo(lathe([[0, 1.25], [2.5, 1.25], [2.6, 1.15], [2.6, 1.02], [.5, .9], [.34, 0], [1, 0]], 32)), feltG = geo(new THREE.CircleGeometry(2.25, 32)); feltG.rotateX(-Math.PI / 2);
    const bases = new THREE.InstancedMesh(tGeo, roomDark, n), felts = new THREE.InstancedMesh(feltG, std({ color: 0x0c5b3e, roughness: .9, emissive: 0x0c5b3e, emissiveIntensity: .5, envMapIntensity: 0 }), n);
    const pool = new THREE.InstancedMesh(geo(new THREE.CircleGeometry(7.5, 32).rotateX(-Math.PI / 2)), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xz/7.5; gl_Position = projectionMatrix*viewMatrix*modelMatrix*instanceMatrix*vec4(position,1.); }',
      fragmentShader: 'varying vec2 vP; void main(){ float r = dot(vP,vP); gl_FragColor = vec4(vec3(.1,.066,.034)*pow(max(1.-r,0.),2.),1.); }' }), n);
    owned.mats.push(pool.material);
    for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2 + .15, r = i % 2 ? 36 : 47, x = r * Math.cos(a), z = r * Math.sin(a);
      dummy.position.set(x, FLOOR_Y, z); dummy.updateMatrix(); bases.setMatrixAt(i, dummy.matrix); dummy.position.y = FLOOR_Y + 1.26; dummy.updateMatrix(); felts.setMatrixAt(i, dummy.matrix); dummy.position.y = FLOOR_Y + .03; dummy.updateMatrix(); pool.setMatrixAt(i, dummy.matrix); }
    scene.add(bases, felts, pool); pool.frustumCulled = false; }

  // A wet black floor, far below the last plate, so the whole machine stands on its own reflection.
  const floorGeo = geo(new THREE.CircleGeometry(ROOM_R, 96)); floorGeo.rotateX(-Math.PI / 2);
  const floorMat = floorMaterial(U); owned.mats.push(floorMat);
  const floor = new THREE.Mesh(floorGeo, floorMat); floor.position.y = FLOOR_Y; floor.receiveShadow = true; scene.add(floor);

  // Cold vapour falling through the shaft (and rising, once the rules break).
  const mistCount = 70;
  const mistGeo = new THREE.InstancedBufferGeometry();
  mistGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  mistGeo.setIndex([0, 1, 2, 0, 2, 3]);
  const mSeed = new Float32Array(mistCount * 4); for (let i = 0; i < mistCount * 4; i++) mSeed[i] = rand();
  mistGeo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(mSeed, 4)); mistGeo.instanceCount = mistCount; owned.geos.push(mistGeo);
  const mist = new THREE.Mesh(mistGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uFlow: U.uFlow, uNoise: U.uNoise, uTime: U.uTime, uSc: U.uSc },
    vertexShader: `attribute vec4 aSeed; uniform float uFlow; varying vec2 vP; varying float vA; varying float vY; varying vec2 vO;
      void main(){ float H = 36.; float y = mod(aSeed.y*H - uFlow*(.5+aSeed.w*.8), H) - 5.;
        float a = aSeed.x*6.283 + uFlow*.05*(aSeed.z-.5), r = 2.+aSeed.z*9.5;
        vec4 mv = viewMatrix*vec4(r*cos(a), y, r*sin(a), 1.);
        float size = 3.5+aSeed.w*6.;
        mv.xy += position.xy*size; vP = position.xy; vO = aSeed.xz*7.;
        float edge = smoothstep(0.,4.,y+5.)*smoothstep(0.,6.,31.-y);
        vA = edge*smoothstep(.5,5.,-mv.z); vY = y;
        gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying vec2 vP; varying float vA; varying float vY; varying vec2 vO; uniform sampler2D uNoise; uniform float uTime,uSc;
      void main(){ float r = dot(vP,vP); if (r>1.) discard;
        float n = texture2D(uNoise, vP*.22+vO+vec2(0.,uTime*.012)).r;
        float a = pow(1.-r,1.6)*smoothstep(.25,.8,n)*vA;
        float cold = smoothstep(24.,4.,vY);
        vec3 c = mix(vec3(.46,.4,.3), vec3(.44,.46,.5), cold);
        gl_FragColor = vec4(c*a*(.05+.04*cold+.012*uSc),1.); }`,
  }));
  mist.frustumCulled = false; scene.add(mist);

  // Diamond dust.
  const dustN = reduced ? 160 : 420, dPos = new Float32Array(dustN * 3), dSeed = new Float32Array(dustN * 2);
  for (let i = 0; i < dustN; i++) { const a = rand() * 6.283, r = 1 + Math.sqrt(rand()) * 15; dPos.set([r * Math.cos(a), rand(), r * Math.sin(a)], i * 3); dSeed.set([rand(), rand()], i * 2); }
  const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(dPos, 3)); dustGeo.setAttribute('aS', new THREE.BufferAttribute(dSeed, 2)); owned.geos.push(dustGeo);
  const dustDpr = { value: 1 };
  const dust = new THREE.Points(dustGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uFlow: U.uFlow, uTime: U.uTime, uDpr: dustDpr },
    vertexShader: `attribute vec2 aS; uniform float uFlow,uTime,uDpr; varying float vT; varying vec3 vC;
      void main(){ float H = 34.; float y = mod(position.y*H - uFlow*(.3+aS.x*.5), H) - 2.;
        vec4 mv = viewMatrix*vec4(position.x, y, position.z, 1.);
        vT = pow(.5+.5*sin(uTime*(1.+aS.y*4.)+aS.x*40.), 10.);
        vC = mix(vec3(1.8,1.8,1.9), vec3(2.2,1.6,.8), smoothstep(8.,26.,y));
        gl_PointSize = min(uDpr*5., uDpr*(1.2+vT*3.)*14./max(2.,-mv.z));
        gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying float vT; varying vec3 vC;
      void main(){ vec2 p = gl_PointCoord-.5; float d = length(p); if (d>.5) discard;
        gl_FragColor = vec4(vC*(.25+vT*4.)*(1.-d*2.),1.); }`,
  }));
  dust.frustumCulled = false; scene.add(dust);

  // The seal: a leaded skylight in the 100 mK plate, directly over the table, with the limit in its glass. Voronoi cells give it something to break along.
  const sealTex = tex(sealEngraving(limitPct));
  const sealGeo = geo(new THREE.CircleGeometry(TIERS[3].bore + .02, 96));
  const sealMat = new THREE.ShaderMaterial({
    uniforms: { uNoise: U.uNoise, uEng: { value: sealTex }, uCrack: U.uCrack, uOpen: U.uOpen, uTime: U.uTime, uImpact: U.uImpact, uImpactCol: U.uImpactCol, uImpactR: U.uImpactR, uChip: U.uChip, uLamp: U.uLamp },
    side: THREE.DoubleSide,
    vertexShader: `varying vec2 vP; varying vec2 vUv; void main(){ vUv = uv; vP = position.xy/${(TIERS[3].bore + .02).toFixed(3)}; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `varying vec2 vP; varying vec2 vUv;
      uniform sampler2D uNoise, uEng; uniform float uCrack,uOpen,uTime,uImpact,uImpactR,uChip,uLamp; uniform vec3 uImpactCol;
      vec2 h2(vec2 p){ p = vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))); return fract(sin(p)*43758.5453); }
      vec3 voro(vec2 x){ vec2 n = floor(x), f = fract(x); vec2 mg, mr; float md = 8.;
        for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){ vec2 g = vec2(float(i),float(j)), o = h2(n+g), r = g+o-f; float d = dot(r,r); if(d<md){ md=d; mr=r; mg=g; } }
        md = 8.;
        for(int j=-2;j<=2;j++) for(int i=-2;i<=2;i++){ vec2 g = mg+vec2(float(i),float(j)), o = h2(n+g), r = g+o-f; if(dot(mr-r,mr-r)>.00001) md = min(md, dot(.5*(mr+r), normalize(r-mr))); }
        return vec3(md, h2(n+mg)); }
      void main(){
        float r = length(vP);
        vec3 v = voro(vP*4.6 + (texture2D(uNoise,vP*.3).rg-.5)*.7);
        float cell = v.y*.42 + r*.58;
        if (uOpen > .001 && uOpen*1.5 > cell + .04) discard;
        float n = texture2D(uNoise, vP*.9).r, fern = texture2D(uNoise, vP*2.3+.3).b, fine = texture2D(uNoise, vP*7.).g;
        // Pale frosted glass, lit from above.
        vec3 c = mix(vec3(.16,.16,.165), vec3(.5,.5,.51), n*.45+fern*.55)*(.45+.95*exp(-r*r*1.6));
        c += vec3(1.)*pow(fine,4.)*.14;
        c *= (.25+.75*uLamp);
        c = mix(c, vec3(2.4,1.65,.62)*(.22+.5*uLamp), smoothstep(.022,.0,v.x)*(.55+.45*smoothstep(.45,.9,r)));   // brass cames between the panes
        vec2 eUv = gl_FrontFacing ? vUv : vec2(1.-vUv.x, vUv.y);
        float eng = texture2D(uEng, eUv).r, engN = texture2D(uEng, eUv+vec2(.0022,-.0022)).r;
        c = mix(c, vec3(.012,.01,.008), eng*.94);
        c += vec3(2.9,2.,.8)*max(engN-eng,0.)*(.3+.6*uLamp);
        if (uImpact > .001) { float k = exp(-pow(r-uImpactR,2.)*90.)*uImpact; c += uImpactCol*k; }
        float reach = smoothstep(uCrack*1.35, uCrack*1.35-.25, r);
        float crack = smoothstep(.055,.0,v.x)*reach*step(.001,uCrack);
        c += vec3(6.5,4.6,2.2)*crack*(1.+uCrack*3.);
        c += vec3(3.,2.2,1.1)*uCrack*uCrack*reach*.5;
        if (uOpen > .001) { float e = smoothstep(.12,.0,cell+.04-uOpen*1.5); c += vec3(9.,7.,4.)*e; }
        gl_FragColor = vec4(c,1.); }`,
  });
  owned.mats.push(sealMat);
  const seal = new THREE.Mesh(sealGeo, sealMat); seal.rotation.x = Math.PI / 2; seal.position.y = SEAL_Y - .02; scene.add(seal);
  const ringGeo = geo(polarRing(TIERS[3].bore - .03, TIERS[3].bore + .05));
  const sealRing = new THREE.Mesh(ringGeo, new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: { uImpact: U.uImpact, uTime: U.uTime, uCol: U.uImpactCol, uLamp: U.uLamp },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec2 vUv; uniform float uImpact,uTime,uLamp; uniform vec3 uCol;
      void main(){ float e = sin(vUv.y*3.14159);
        vec3 c = vec3(7.,5.,2.4)*(.8+.35*sin(uTime*2.+vUv.x*50.))*(.4+.6*uLamp);
        gl_FragColor = vec4((c+uCol*uImpact*7.)*e*e,1.); }`,
  }));
  sealRing.position.y = SEAL_Y - .3; scene.add(sealRing);

  // Glass thrown down onto the table when the seal breaks.
  const shardN = reduced ? 60 : 220;
  const shardGeo = new THREE.InstancedBufferGeometry();
  { const b = new THREE.ConeGeometry(1, .14, 3); shardGeo.index = b.index; shardGeo.setAttribute('position', b.getAttribute('position')); shardGeo.setAttribute('normal', b.getAttribute('normal')); }
  const sStart = new Float32Array(shardN * 4), sVel = new Float32Array(shardN * 4);
  for (let i = 0; i < shardN; i++) { const a = rand() * 6.283, r = Math.sqrt(rand()) * 2.95, sp = 1.2 + rand() * 3.6;
    sStart.set([r * Math.cos(a), SEAL_Y, r * Math.sin(a), .05 + rand() * .2], i * 4);
    sVel.set([Math.cos(a) * sp * (.3 + r * .4), rand() * 5 - 1.2, Math.sin(a) * sp * (.3 + r * .4), rand() * 6.28], i * 4); }
  shardGeo.setAttribute('aStart', new THREE.InstancedBufferAttribute(sStart, 4)); shardGeo.setAttribute('aVel', new THREE.InstancedBufferAttribute(sVel, 4));
  shardGeo.instanceCount = shardN; owned.geos.push(shardGeo);
  const shards = new THREE.Mesh(shardGeo, new THREE.ShaderMaterial({
    uniforms: { uShard: U.uShard },
    vertexShader: `attribute vec4 aStart; attribute vec4 aVel; uniform float uShard; varying vec3 vN; varying vec3 vV; varying float vF;
      mat3 rot(vec3 a, float t){ float c=cos(t), s=sin(t), o=1.-c; return mat3(o*a.x*a.x+c,o*a.x*a.y+a.z*s,o*a.z*a.x-a.y*s, o*a.x*a.y-a.z*s,o*a.y*a.y+c,o*a.y*a.z+a.x*s, o*a.z*a.x+a.y*s,o*a.y*a.z-a.x*s,o*a.z*a.z+c); }
      void main(){ float t = uShard; mat3 R = rot(normalize(vec3(sin(aVel.w),.6,cos(aVel.w*1.7))), t*(2.+aVel.w));
        vec3 p = aStart.xyz + aVel.xyz*t*exp(-t*.5)*.7 + vec3(0.,-2.6,0.)*t*t;
        vec3 w = p + R*position*aStart.w*1.5;
        vec4 mv = viewMatrix*vec4(w,1.); vN = normalize(normalMatrix*(R*normal)); vV = normalize(-mv.xyz);
        vF = smoothstep(3.2,1.2,t); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vN; varying vec3 vV; varying float vF;
      void main(){ float f = pow(1.-abs(dot(vN,vV)),2.5); float s = pow(max(dot(reflect(-vV,vN),normalize(vec3(.2,.9,.3))),0.),30.);
        gl_FragColor = vec4((vec3(1.2,1.,.7)*(.25+f*1.6)+vec3(8.,7.,5.)*s)*vF,1.); if (vF<.02) discard; }`,
  }));
  shards.frustumCulled = false; shards.visible = false; scene.add(shards);

  // The lamp: a stepped hoop hung under the skylight, wide enough to frame all the glass from the table. The pool on the table comes from above it, and answers its swing late.
  const HOOP_R = 1.95;
  const lamp = new THREE.Group(); lamp.position.y = SEAL_Y - .45; scene.add(lamp);
  const hoopGeo = geo(lathe([[HOOP_R, -2.3], [HOOP_R, -2.24, 1], [HOOP_R + .09, -2.24], [HOOP_R + .09, -2.16, 1], [HOOP_R + .18, -2.16], [HOOP_R + .18, -2.08, 1], [HOOP_R + .3, -2.08], [HOOP_R + .3, -1.98, 1], [HOOP_R, -1.98]], 96));
  const hoop = new THREE.Mesh(hoopGeo, goldTop); lamp.add(hoop);
  const stayGeo = geo(new THREE.CylinderGeometry(.012, .012, 1, 5)); stayGeo.translate(0, .5, 0);
  const stays = new THREE.InstancedMesh(stayGeo, goldPlain, 6);
  { const a = new THREE.Vector3(), b = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), q = new THREE.Quaternion();
    for (let i = 0; i < 6; i++) { const t = i / 6 * Math.PI * 2 + .26; a.set((HOOP_R + .3) * Math.cos(t), -2, (HOOP_R + .3) * Math.sin(t)); b.set(2.95 * Math.cos(t), .05, 2.95 * Math.sin(t));
      const d = b.clone().sub(a), l = d.length(); q.setFromUnitVectors(up, d.normalize()); dummy.position.copy(a); dummy.quaternion.copy(q); dummy.scale.set(1, l, 1); dummy.updateMatrix(); stays.setMatrixAt(i, dummy.matrix); }
    dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0); }
  lamp.add(stays);
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff }); bulbMat.color.setRGB(2.1, 1.8, 1.3); owned.mats.push(bulbMat);
  const tubeGeo = geo(new THREE.TorusGeometry(HOOP_R + .02, .016, 6, 96)); tubeGeo.rotateX(Math.PI / 2);
  const tube = new THREE.Mesh(tubeGeo, bulbMat); tube.position.y = -2.3; lamp.add(tube);

  // The radiation shield, half raised behind the table. Lacquer outside; inside, the pale wall a noir room needs: it takes the blinds and the dealer.
  const SH_R = 4.6, SH_H = 7.72, SH_A = 1.05, shStart = Math.PI - SH_A;
  const shieldGeo = geo(new THREE.CylinderGeometry(SH_R, SH_R, SH_H, 56, 1, true, shStart, SH_A * 2));
  const dealerTex = dealerTextures(); tex(dealerTex.body); tex(dealerTex.arm);
  const shieldMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { tBody: { value: dealerTex.body }, tArm: { value: dealerTex.arm }, uPeel: U.uPeel, uArm: U.uArm, uRainT: U.uRainT, uBars: U.uBars, uLamp: U.uLamp, uSc: U.uSc },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: /* glsl */`varying vec2 vUv; uniform sampler2D tBody,tArm; uniform float uPeel,uArm,uRainT,uBars,uLamp,uSc;
      float h(float n){ return fract(sin(n*91.7)*47453.1); }
      void main(){
        float s = 1.-vUv.x, v = vUv.y, y = v*7.72-.92;
        vec2 p = vec2(s+(v-.5)*.2, v);                                  // skewed like light through a tall frame
        float frame = smoothstep(.12,.15,p.x)*smoothstep(.99,.96,p.x)*smoothstep(.1,.12,p.y)*smoothstep(.97,.95,p.y);
        float mull = smoothstep(.0,.008,abs(p.x-.56)-.008);
        float sl = smoothstep(.2,.27,abs(fract(p.y*15.)-.5));
        float id = floor(p.x*70.), ry = fract(p.y*1.4+uRainT*(1.+h(id)*2.)+h(id+3.));
        float rain = smoothstep(.0,.03,ry)*smoothstep(.4,.0,ry)*step(.6,h(id+7.));
        float bars = frame*mull*sl*(1.-rain*.5);
        float flute = .9+.1*sin(s*190.);
        float pool = exp(-pow((s-.5)*2.4,2.))*smoothstep(7.,.5,y);
        vec3 c = vec3(.84,.82,.78)*flute*(.018+bars*uBars*.3+pool*.05*uLamp);
        vec2 d = vec2((s-uPeel)/.4+.5, (v-.118)/.71);
        if (d.x>0.&&d.x<1.&&d.y>0.&&d.y<1.) {
          vec2 pv = vec2(.3,.48), q = (d-pv)*vec2(.667,1.); float ca = cos(uArm), sa = sin(uArm);
          q = vec2(q.x*ca-q.y*sa, q.x*sa+q.y*ca)/vec2(.667,1.)+pv;
          float sh = texture2D(tBody,d).a;
          if (q.x>0.&&q.x<1.&&q.y>0.&&q.y<1.) sh = max(sh, texture2D(tArm,q).a);
          c *= 1.-.95*sh;
        }
        gl_FragColor = vec4(c,1.); }`,
  });
  owned.mats.push(shieldMat);
  const shield = new THREE.Mesh(shieldGeo, shieldMat); shield.position.y = -.92 + SH_H / 2; scene.add(shield);
  const shellGeo = geo(new THREE.CylinderGeometry(SH_R + .05, SH_R + .05, SH_H, 56, 1, true, shStart, SH_A * 2));
  const shell = new THREE.Mesh(shellGeo, lacquer); shell.position.copy(shield.position); shell.castShadow = true; scene.add(shell);
  { const ribG = geo(new THREE.BoxGeometry(.05, SH_H, .06)), n = 13, ribs = new THREE.InstancedMesh(ribG, goldPlain, n);
    for (let i = 0; i < n; i++) { const t = shStart + i / (n - 1) * SH_A * 2; dummy.position.set((SH_R + .08) * Math.sin(t), shield.position.y, (SH_R + .08) * Math.cos(t)); dummy.rotation.set(0, t, 0); dummy.updateMatrix(); ribs.setMatrixAt(i, dummy.matrix); }
    scene.add(ribs); }
  // Velvet at either end of the shield. It reads as grey until the flood.
  { const parts = [-1, 1].map((sd) => { const g = new THREE.PlaneGeometry(1.5, SH_H, 40, 1), a = g.getAttribute('position');
      for (let i = 0; i < a.count; i++) a.setZ(i, Math.sin(a.getX(i) * 13 + sd) * .09 + Math.sin(a.getX(i) * 6) * .05);
      g.computeVertexNormals(); const t = Math.PI + sd * (SH_A - .1); g.rotateY(t + Math.PI); g.translate((SH_R - .18) * Math.sin(t), shield.position.y, (SH_R - .18) * Math.cos(t)); return g; });
    const dg = geo(mergeGeometries(parts)); parts.forEach((g) => g.dispose());
    scene.add(new THREE.Mesh(dg, velvet)); }

  // The Impossible Table on the mixing chamber plate.
  const table = new THREE.Group(); scene.add(table);
  const felt = feltTextures(`${breakEvenPct} to break even`);
  tex(felt.map); tex(felt.mask);
  const feltGeo = geo(new THREE.CircleGeometry(2.62, 128));
  const feltMat = std({ map: felt.map, metalnessMap: felt.mask, roughnessMap: felt.mask, roughness: 1, metalness: 1, envMapIntensity: .3 });
  const feltMesh = new THREE.Mesh(feltGeo, feltMat); feltMesh.rotation.x = -Math.PI / 2; feltMesh.position.y = TABLE_Y; feltMesh.receiveShadow = true; table.add(feltMesh);
  const rimGeo = geo(lathe([[2.56, .0], [2.62, .03], [2.62, .09, 1], [2.66, .13, 1], [2.9, .13, 1], [2.96, .08, 1], [2.96, 0]], 168));
  table.add(new THREE.Mesh(rimGeo, goldBase));

  // Bezel: the running win rate drawn as light around the rim, with raised pins at the limit and at break-even.
  const bezelGeo = polarRing(2.68, 2.88); owned.geos.push(bezelGeo);
  const bezelMarks = { uLimit: { value: 0 }, uEven: { value: 0 } };
  const bezel = new THREE.Mesh(bezelGeo, new THREE.ShaderMaterial({
    uniforms: { uRate: U.uRate, uTarget: U.uTarget, uTime: U.uTime, uSc: U.uSc, ...bezelMarks },
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
    fragmentShader: `varying vec2 vUv; uniform float uRate,uTarget,uTime,uSc,uLimit,uEven;
      void main(){ float p = fract(1.025 - vUv.x);
        float e = pow(sin(vUv.y*3.14159),2.);
        float tick = smoothstep(.15,.5,abs(fract(p*100.)-.5));
        vec3 c = vec3(.25,.16,.07)*(1.-tick)*.6;
        float fill = step(p,uRate);
        vec3 lit = p < uLimit ? vec3(1.1,.72,.24) : vec3(.12,1.5,.8);
        c += fill*lit*(.65+.35*sin(p*90.-uTime*5.));
        c += vec3(4.5,4.,3.)*smoothstep(.0025,.0,abs(p-uTarget))*step(.01,uTarget);
        gl_FragColor = vec4(c*e,1.); }`,
  }));
  bezel.position.y = .136; table.add(bezel);

  const pinGeo = new THREE.CylinderGeometry(.03, .045, .34, 8);
  const pins = new THREE.InstancedMesh(pinGeo, goldPlain, 2); table.add(pins);
  const setPins = (limit: number, even: number) => { bezelMarks.uLimit.value = limit; bezelMarks.uEven.value = even; [limit, even].forEach((p, i) => {
    const th = (1.025 - p) * Math.PI * 2; dummy.position.set(2.78 * Math.cos(th), .3, 2.78 * Math.sin(th)); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); pins.setMatrixAt(i, dummy.matrix); }); };

  // The jewel: the chip held in a gold claw setting, on a stepped mount.
  const mountGeo = geo(lathe(upward([[1.05, 0], [1.05, .05, 1], [.94, .05], [.94, .12, 1], [.84, .12], [.84, .2, 1], [.74, .2], [.74, .28], [0, .28]]), 72));
  const mount = new THREE.Mesh(mountGeo, goldDull); mount.position.y = .034; table.add(mount);
  const chipTex = chipTextures(); tex(chipTex.map); tex(chipTex.emissive);
  const chipGeo = geo(new THREE.BoxGeometry(.98, .06, .98));
  const chipTop = std({ map: chipTex.map, emissiveMap: chipTex.emissive, emissive: 0xffffff, emissiveIntensity: 2, roughness: .22, metalness: .4 });
  const chipSide = std({ color: 0x1a1a1c, roughness: .3, metalness: .6 });
  const chip = new THREE.Mesh(chipGeo, [chipSide, chipSide, chipTop, chipSide, chipSide, chipSide]); chip.position.y = .35; table.add(chip);
  const clawGeo = geo(new THREE.CylinderGeometry(.03, .038, .24, 8));
  const claws = new THREE.InstancedMesh(clawGeo, goldDull, 4);
  ([[1, 1], [-1, 1], [1, -1], [-1, -1]] as const).forEach(([sx, sz], i) => { dummy.position.set(sx * .47, .4, sz * .47);
    dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); claws.setMatrixAt(i, dummy.matrix); });
  table.add(claws);

  // The two seats, the pair, and what links them.
  const seatGeo = geo(lathe(upward([[.34, 0], [.34, .04, 1], [.26, .04], [.26, .1, 1], [.17, .1], [.17, .18, 1], [.08, .18], [.07, .62, 1], [.14, .62], [.14, .68, 1], [.2, .68], [.2, .72], [0, .72]]), 40));
  const seats = new THREE.InstancedMesh(seatGeo, goldDull, 2); table.add(seats);
  const coreMat = (col: THREE.Color) => { const m = new THREE.ShaderMaterial({
    uniforms: { uTime: U.uTime, uCol: { value: col }, uPair: U.uPair, uLink: U.uLink, uFlash: U.uFlash },
    vertexShader: 'varying vec3 vN,vV,vP; void main(){ vP=position; vN=normalize(normalMatrix*normal); vec4 m=modelViewMatrix*vec4(position,1.); vV=normalize(-m.xyz); gl_Position=projectionMatrix*m; }',
    fragmentShader: `varying vec3 vN,vV,vP; uniform float uTime,uPair,uLink,uFlash; uniform vec3 uCol;
      void main(){ float f=pow(1.-abs(dot(normalize(vN),normalize(vV))),2.); float s=.5+.5*sin(vP.y*30.+uTime*3.+sin(vP.x*24.-uTime*2.)*1.6);
        gl_FragColor=vec4((uCol*(.9+s*.8)*(.7+uLink*.7)+vec3(1.,.93,.8)*(1.-f)*(5.+uFlash*4.))*uPair,1.); }`,
  }); owned.mats.push(m); return m; };
  const orbGeo = geo(new THREE.SphereGeometry(.15, 32, 24));
  const ringG = geo(new THREE.TorusGeometry(.33, .012, 8, 72));
  const pair = [PAIR_A, PAIR_B].map((P, i) => {
    dummy.position.set(P.x, .03, 0); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); seats.setMatrixAt(i, dummy.matrix);
    const g = new THREE.Group(); g.position.copy(P); table.add(g);
    const orb = new THREE.Mesh(orbGeo, coreMat(i ? new THREE.Color(.3, 5.2, 2.6) : new THREE.Color(5.2, .42, .3)));
    const ring = new THREE.Mesh(ringG, goldPlain), ring2 = new THREE.Mesh(ringG, goldPlain); ring2.scale.setScalar(.78);
    g.add(orb, ring, ring2); g.visible = false;
    return { g, ring, ring2, sign: i ? 1 : -1 };
  });
  const threadG = geo(new THREE.CylinderGeometry(.009, .009, 1, 5, 160, true)); threadG.translate(0, .5, 0);
  const threadM = (phase: number) => { const m = new THREE.ShaderMaterial({
    uniforms: { uT: U.uTime, uAmp: U.uThreadAmp, uShow: U.uThread, uPulse: U.uThreadPulse, uA: { value: PAIR_A }, uB: { value: PAIR_B }, uPhase: { value: phase } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`uniform float uT,uAmp,uPhase; uniform vec3 uA,uB; varying float vS;
      void main(){ float s=position.y; vS=s; vec3 p=mix(uA,uB,s); vec3 q=vec3(position.x,0.,position.z);
        float w=sin(3.14159*s); float a=s*18.+uT*2.2+uPhase;
        p+=vec3(0.,cos(a),sin(a))*w*(uAmp+.018)+q; p.y+=w*.42;
        gl_Position=projectionMatrix*viewMatrix*vec4(p,1.); }`,
    fragmentShader: /* glsl */`varying float vS; uniform float uShow,uPulse,uT;
      void main(){ if(vS>uShow) discard; vec3 c=mix(vec3(5.,.5,.3),vec3(.3,5.,2.6),smoothstep(.1,.9,vS));
        c=mix(c,vec3(4.,3.1,1.5),exp(-pow((vS-.5)*5.,2.)));
        float p=exp(-pow((fract(vS*2.-uT*1.3)-.5)*14.,2.))*1.5;
        gl_FragColor=vec4(c*(.8+p+uPulse*2.),1.); }`,
  }); owned.mats.push(m); return m; };
  const threads = [threadM(0), threadM(Math.PI)].map((m) => { const t = new THREE.Mesh(threadG, m); t.frustumCulled = false; t.visible = false; scene.add(t); return t; });

  // Cards. Two question cards, two that cannot decide, and a deck that will hang in the air.
  const atlas = tex(cardAtlas());
  const cardU = { uAir: U.uAir, uT: U.uTime, uR: U.uR };
  const cardM = std({ map: atlas, color: 0x8d8d8d, roughness: .5, side: THREE.DoubleSide, emissive: 0xffffff, emissiveIntensity: .04, emissiveMap: atlas, envMapIntensity: .4 });
  cardM.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, cardU);
    s.vertexShader = s.vertexShader
      .replace('#include <common>', /* glsl */`#include <common>
        attribute vec4 aCard; attribute vec4 aSeed; varying vec2 vCF; varying vec2 vCB; uniform float uAir,uT,uR;
        vec2 cell(float i){ return vec2(mod(i,${CARD_GRID[0]}.), ${CARD_GRID[1] - 1}.-floor(i/${CARD_GRID[0]}.)); }   // the atlas is drawn top down and uploaded flipped
        mat3 ry(float a){ float c=cos(a),s=sin(a); return mat3(c,0.,-s,0.,1.,0.,s,0.,c); }
        mat3 rx(float a){ float c=cos(a),s=sin(a); return mat3(1.,0.,0.,0.,c,s,0.,-s,c); }`)
      .replace('#include <uv_vertex>', /* glsl */`#include <uv_vertex>
        { float alt = step(.94,fract(uT*(.13+aSeed.w*.3)+aSeed.x)); vCF = cell(alt>.5?aCard.y:aCard.x); vCB = cell(0.); }`)
      .replace('#include <beginnormal_vertex>', /* glsl */`#include <beginnormal_vertex>
        mat3 cr = aSeed.y>0. ? ry(aSeed.x*9.+uT*aSeed.w*.5)*rx(aSeed.x*4.+uT*aSeed.w*.34) : mat3(1.);
        objectNormal = cr*objectNormal;`)
      .replace('#include <project_vertex>', /* glsl */`
        vec4 mvPosition;
        if(aSeed.y>0.){
          float rel = smoothstep(0.,14.,uR-aSeed.y); float vis = smoothstep(aSeed.x,aSeed.x+.08,uAir*1.08); float a = aSeed.x*6.283+uT*.09*(.4+aSeed.w);
          vec3 orbit = vec3(cos(a)*aSeed.y, aSeed.z+.3*sin(uT*.5+aSeed.x*20.), sin(a)*aSeed.y);
          vec3 p = mix(vec3(0.,.3,0.), orbit, rel*rel*(3.-2.*rel));
          mvPosition = vec4(p + cr*transformed*1.15*vis*smoothstep(.1,.4,rel),1.);
        } else mvPosition = instanceMatrix*vec4(transformed,1.);
        mvPosition = modelViewMatrix*mvPosition; gl_Position = projectionMatrix*mvPosition;`);
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCF; varying vec2 vCB; vec2 cardUv;')
      .replace('#include <map_fragment>', /* glsl */`
        cardUv = (vMapUv + (gl_FrontFacing?vCF:vCB)) / vec2(${CARD_GRID[0]}.,${CARD_GRID[1]}.);
        diffuseColor *= texture2D(map, cardUv);`)
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance *= texture2D(emissiveMap, cardUv).rgb;');
  };
  cardM.customProgramCacheKey = () => 'deco-card';
  const cardG = geo(new THREE.PlaneGeometry(.42, .6));
  const N_AIR = 120, N_TABLE = 4, nc = N_AIR + N_TABLE;
  const aCard = new Float32Array(nc * 4), aSeed = new Float32Array(nc * 4);
  const cards = new THREE.InstancedMesh(cardG, cardM, nc);
  const lay = (i: number, x: number, z: number, rot: number) => { dummy.position.set(x, TABLE_Y + .006, z); dummy.rotation.set(-Math.PI / 2, 0, rot); dummy.updateMatrix(); cards.setMatrixAt(i, dummy.matrix); };
  lay(0, -1.4, 0, .04); lay(1, 1.4, 0, -.04); lay(2, -.42, 1.62, .3); lay(3, -.12, 1.68, -.12);
  aCard.set([CARD_BACK, CARD_BACK, 0, 0, CARD_BACK, CARD_BACK, 0, 0, 3, 5, 0, 0, 4, 7, 0, 0], 0);
  aSeed.set([.1, 0, 0, 0, .2, 0, 0, 0, .3, 0, 0, 1.7, .71, 0, 0, 1.1], 0);
  for (let i = N_TABLE; i < nc; i++) {
    const k = i * 4, r = Math.random, ring = 5.4 + r() * 9;
    aCard[k] = 3 + Math.floor(r() * 5); aCard[k + 1] = 3 + Math.floor(r() * 5);
    aSeed.set([r(), ring, ring < 9.6 ? 1 + r() * 5 : 1 + r() * 29, .4 + r() * 1.3], k);
    cards.setMatrixAt(i, new THREE.Matrix4());
  }
  const cardFaces = new THREE.InstancedBufferAttribute(aCard, 4);
  cardG.setAttribute('aCard', cardFaces);
  cardG.setAttribute('aSeed', new THREE.InstancedBufferAttribute(aSeed, 4));
  cards.frustumCulled = false; scene.add(cards);

  // Chips. Each one is a hundred of the player's bankroll.
  const cTex = tex(chipTexture());
  const cSide = std({ color: 0x6e111c, roughness: .36, envMapIntensity: .7 });
  const cTop = std({ map: cTex, roughness: .33, envMapIntensity: .6 });
  const cGeo = geo(new THREE.CylinderGeometry(.125, .125, .03, 28));
  const CHIPS = 220;
  const chips = new THREE.InstancedMesh(cGeo, [cSide, cTop, cTop], CHIPS); chips.castShadow = chips.receiveShadow = true; chips.frustumCulled = false; scene.add(chips);
  const flyers = new THREE.InstancedMesh(cGeo, [cSide, cTop, cTop], 10); flyers.castShadow = true; flyers.frustumCulled = false; scene.add(flyers);
  // One chip that sits in two places.
  const ghosts = ([[.9, 1.72], [1.34, 1.5]] as const).map(([x, z]) => { const m = new THREE.Mesh(cGeo, std({ map: cTex, roughness: .4, transparent: true, opacity: .8 })); m.position.set(x, TABLE_Y + .017, z); scene.add(m); return m; });

  // A column of current up the bore, the wrong way for anything cold.
  const beamGeo = new THREE.CylinderGeometry(.55, .55, 80, 32, 1, true); owned.geos.push(beamGeo);
  const beam = new THREE.Mesh(beamGeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uBeam: U.uBeam, uTime: U.uTime, uNoise: U.uNoise },
    vertexShader: 'varying vec3 vN; varying vec3 vV; varying vec2 vUv; void main(){ vUv=uv; vec4 mv=modelViewMatrix*vec4(position,1.); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }',
    fragmentShader: `varying vec3 vN; varying vec3 vV; varying vec2 vUv; uniform float uBeam,uTime; uniform sampler2D uNoise;
      void main(){ float d = pow(abs(dot(vN,vV)),3.);
        float n = texture2D(uNoise, vec2(vUv.x*2., vUv.y*3.-uTime*.32)).r;
        float a = d*(.45+n*1.1)*smoothstep(1.,.5,vUv.y)*smoothstep(.0,.02,vUv.y);
        gl_FragColor = vec4(vec3(2.6,1.9,.8)*a*uBeam*.42,1.); }`,
  }));
  beam.position.y = 40.5; beam.visible = false; beam.frustumCulled = false; scene.add(beam);

  // Bronze lift doors hung on the outer rail. They say which rooms exist; tonight they open only far enough to look.
  const frame = (ow: number, oh: number, iw: number, ih: number, depth: number, mat: THREE.Material) => { const s = zigShape(ow, oh); s.holes.push(zigShape(iw, ih));
    const g = geo(new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 1 })); return new THREE.Mesh(g, mat); };
  const barG = geo(new THREE.BoxGeometry(1, 1, .018));
  const signG = geo(new THREE.PlaneGeometry(1.28, .32));
  const transomG = geo(new THREE.ShapeGeometry(fanShapes(.1, .6, 11), 1));
  const roomG = geo(new THREE.BoxGeometry(1.76, 2.62, .9));
  const roomM = new THREE.MeshBasicMaterial({ color: 0x030303, side: THREE.BackSide }); owned.mats.push(roomM);
  const backG = geo(new THREE.PlaneGeometry(1.7, 2.56));
  const doors = DOORS.map((d) => {
    const t: Tier = TIERS[d.tier], g = new THREE.Group();
    g.position.set((t.R + .1) * Math.cos(d.az), .21, (t.R + .1) * Math.sin(d.az)); g.rotation.y = Math.PI / 2 - d.az; g.scale.setScalar(.85); tierGroups[d.tier]!.add(g);
    const body = frame(1.26, 3.9, .86, 2.56, .28, lacquer); body.castShadow = true; g.add(body);
    g.add(frame(.96, 2.68, .86, 2.56, .34, goldPlain), frame(1.31, 3.97, 1.26, 3.9, .24, goldPlain));
    const fan = new THREE.Mesh(transomG, goldThin); fan.position.set(0, 2.62, .29); g.add(fan);
    const sign = new THREE.Mesh(signG, new THREE.MeshBasicMaterial({ map: tex(doorSign(d.sign, d.stage)) })); sign.material.color.setScalar(1.6); owned.mats.push(sign.material);
    sign.position.set(0, 3.5, .29); g.add(sign);
    const room = new THREE.Mesh(roomG, roomM); room.position.set(0, 1.28, -.3); g.add(room);
    let wheel: THREE.Mesh | null = null;
    if (d.name === 'cage') {
      const back = new THREE.Mesh(backG, new THREE.MeshBasicMaterial({ map: tex(cageBackdrop()) })); back.material.color.setScalar(1.7); owned.mats.push(back.material);
      back.position.set(0, 1.28, -.72); g.add(back);
    } else {
      const glow = new THREE.Mesh(backG, new THREE.MeshBasicMaterial({ color: 0x1d150a })); owned.mats.push(glow.material); glow.position.set(0, 1.28, -.72); g.add(glow);
      const tilt = new THREE.Group(); tilt.position.set(0, .86, -.42); tilt.rotation.x = -.88; g.add(tilt);
      const wheelM = new THREE.MeshBasicMaterial({ map: tex(wheelTexture()) }); wheelM.color.setScalar(2.4); owned.mats.push(wheelM);
      wheel = new THREE.Mesh(geo(new THREE.CircleGeometry(.8, 64)), wheelM); tilt.add(wheel);
    }
    // A folding bronze gate in two leaves: X lattice between uprights.
    const leaves = [-1, 1].map((sd) => {
      const leaf = new THREE.Group(); leaf.position.set(sd * .86, 0, .14); g.add(leaf);
      const rows = 6, cols = 2, h = 2.56, w = .43, ch = h / rows, cw = w / cols, list: [number, number, number, number, number][] = [];
      for (let c = 0; c <= cols; c++) list.push([-sd * c * cw, h / 2, 0, .034, h]);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const L = Math.hypot(ch, cw), a = Math.atan2(cw, ch), cx = -sd * (c + .5) * cw, cy = (r + .5) * ch; list.push([cx, cy, a, .016, L], [cx, cy, -a, .016, L]); }
      const m = new THREE.InstancedMesh(barG, goldPlain, list.length);
      list.forEach(([x, y, rz, sw, sh], i) => { dummy.position.set(x, y, 0); dummy.rotation.set(0, 0, rz); dummy.scale.set(sw, sh, 1); dummy.updateMatrix(); m.setMatrixAt(i, dummy.matrix); });
      dummy.scale.set(1, 1, 1); leaf.add(m); return leaf;
    });
    const hit = new THREE.Mesh(geo(new THREE.BoxGeometry(2.7, 4.2, 1.4)), new THREE.MeshBasicMaterial()); owned.mats.push(hit.material);
    hit.position.set(0, 2, 0); hit.visible = false; hit.name = d.name; g.add(hit);
    return { ...d, group: g, leaves, wheel, hit };
  });

  scene.add(new THREE.HemisphereLight(0xfff0dc, 0x202024, .1));
  const chipLight = new THREE.PointLight(0xdfe7f2, 40, 16, 1.7); chipLight.position.set(0, 1.5, 0); scene.add(chipLight);
  const sealLight = new THREE.PointLight(0xfff0d0, 0, 22, 1.6); sealLight.position.set(0, SEAL_Y - 1, 0); scene.add(sealLight);

  let pulseHead = 0;
  return {
    scene, U, TIERS, tierGroups, lift, chipTop, chipLight, sealLight, seal, sealRing, shards, pair, threads, beam, bezel, setPins, feltMat, velvetMat: velvet,
    lamp, floor, mist, dust, cards, cardFaces, chips, flyers, ghosts, doors, CHIPS,
    firePulse(now: number, win: boolean, stop: number) { const p = U.uPulses.value[pulseHead]!; p.set(now, win ? 1 : 0, stop); pulseHead = (pulseHead + 1) % 8; },
    spin(dt: number, amount: number) { const r = U.uRot.value; for (let i = 0; i < 6; i++) { r[i]! += SPIN[i]! * amount * dt; const tg = tierGroups[i]; if (tg) tg.rotation.y = -r[i]!; } },
    settleSpin(k: number) { const r = U.uRot.value; for (let i = 0; i < 6; i++) { r[i]! *= k; const tg = tierGroups[i]; if (tg) tg.rotation.y = -r[i]!; } },
    setDpr(v: number) { dustDpr.value = v; },
    /** Redraws the environment after the GPU context comes back. */
    rebake() { envRT.dispose(); envRT = bakeEnvironment(renderer); scene.environment = envRT.texture; },
    dispose() {
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Points) { const { geometry, material } = o as THREE.Mesh; geometry.dispose(); (Array.isArray(material) ? material : [material]).forEach((m) => { m.dispose(); }); }
        if (o instanceof THREE.InstancedMesh) o.dispose();
      });
      owned.geos.forEach((g) => { g.dispose(); }); owned.textures.forEach((t) => { t.dispose(); }); owned.mats.forEach((m) => { m.dispose(); }); envRT.dispose();
    },
  };
}

