// The film stock, tuned for a 50 unit shaft. Owns the HDR target, haze, bloom and the flood.
// Everything is rendered in full colour all along. Before the flood the camera may keep only black, white and gold.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const VERT = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

const NOISE = /* glsl */`
float hash31(vec3 p){ p = fract(p*.1031); p += dot(p, p.zyx+31.32); return fract((p.x+p.y)*p.z); }
float vnoise(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z); }
`;

const HAZE_FRAG = /* glsl */`
#include <packing>
varying vec2 vUv;
uniform sampler2D tDepth, tPrev, tShadowA, tShadowB, tMapB;
uniform mat4 uInvVP, uMatA, uMatB;
uniform vec3 uCam, uLamp, uLampDir, uColA, uColB;
uniform float uCosOuter, uCosInner, uHazeT, uDensity, uFrame, uHasShadow, uBlend, uFloor;
${NOISE}
float ign(vec2 p){ return fract(52.9829189*fract(dot(p,vec2(.06711056,.00583715)))); }
float density(vec3 p){
  vec3 q = p*vec3(.22,.62,.22) + vec3(uHazeT*.05,-uHazeT*.018,uHazeT*.03);
  float n = vnoise(q)*.62 + vnoise(q*2.7+7.)*.38;
  float strat = .55 + .45*sin(p.y*1.3 + vnoise(p*.14)*5.);       // haze hangs in sheets
  float h = smoothstep(46.,8.,p.y)*.6+.4;
  return uDensity * h * (.05 + smoothstep(.42,.74,n)*strat*1.5);
}
void main(){
  float d = texture2D(tDepth, vUv).x;
  vec4 clip = vec4(vUv*2.-1., d*2.-1., 1.);
  vec4 w = uInvVP*clip; vec3 end = w.xyz/w.w;
  vec3 rd = end-uCam; float len = length(rd); rd /= max(len,1e-4); len = min(len, 112.);
  float j = ign(gl_FragCoord.xy + uFrame*5.588238);
  float tr = 1.; vec3 acc = vec3(0.);
  // Window shafts: long and coarse, across the whole room.
  const int NW = 11;
  float st = len/float(NW);
  for(int i=0;i<NW;i++){
    vec3 p = uCam + rd*(float(i)+j)*st;
    float dn = density(p);
    vec4 sb = uMatB*vec4(p,1.); sb.xyz/=sb.w;
    if(sb.x>0.&&sb.x<1.&&sb.y>0.&&sb.y<1.&&sb.w>0.&&p.y>uFloor){
      float a = texture2D(tMapB, sb.xy).r;
      if(a>.01 && uHasShadow>.5) a *= step(sb.z-.002, unpackRGBAToDepth(texture2D(tShadowB,sb.xy)));
      acc += tr*uColB*a*dn*st*.042;
    }
    tr *= exp(-dn*st*.1);
  }
  // The lamp: short and fine, only where the ray crosses its column of air.
  vec2 co = uCam.xz-uLamp.xz, cd = rd.xz; float ca = dot(cd,cd), cb = dot(co,cd), cc = dot(co,co)-36., disc = cb*cb-ca*cc;
  if(disc>0. && ca>1e-5){
    float sq = sqrt(disc), t0 = max((-cb-sq)/ca,0.), t1 = min((-cb+sq)/ca,len);
    if(t1>t0){
      const int NL = 10; float sl = (t1-t0)/float(NL);
      for(int i=0;i<NL;i++){
        vec3 p = uCam + rd*(t0+(float(i)+j)*sl);
        vec3 v = p-uLamp; float dl = length(v); float c = dot(v/dl, uLampDir);
        if(c>uCosOuter){
          float a = smoothstep(uCosOuter,uCosInner,c)*4.6/(dl*dl*.06+5.);
          vec4 sc = uMatA*vec4(p,1.); sc.xyz/=sc.w;
          if(uHasShadow>.5 && sc.x>0.&&sc.x<1.&&sc.y>0.&&sc.y<1.) a *= step(sc.z-.004, unpackRGBAToDepth(texture2D(tShadowA,sc.xy)));
          acc += uColA*a*(.05*uDensity+density(p*1.4)*.2)*sl;
        }
      }
    }
  }
  vec4 cur = vec4(acc, tr);
  gl_FragColor = mix(texture2D(tPrev, vUv), cur, uBlend);
}`;

const DOWN_FRAG = /* glsl */`
varying vec2 vUv; uniform sampler2D tSrc, tHaze; uniform vec2 uTexel; uniform float uPrefilter;
void main(){
  vec3 c = texture2D(tSrc,vUv).rgb*4.;
  c += texture2D(tSrc,vUv+uTexel*vec2(-1,-1)).rgb; c += texture2D(tSrc,vUv+uTexel*vec2(1,-1)).rgb;
  c += texture2D(tSrc,vUv+uTexel*vec2(-1,1)).rgb;  c += texture2D(tSrc,vUv+uTexel*vec2(1,1)).rgb;
  c /= 8.;
  if(uPrefilter>.5){
    c = min(c, vec3(18.));
    c += texture2D(tHaze,vUv).rgb*.2;
    float b = max(c.r,max(c.g,c.b)); float k = smoothstep(1.3,3.2,b); c *= k;
  }
  gl_FragColor = vec4(c,1.);
}`;

const UP_FRAG = /* glsl */`
varying vec2 vUv; uniform sampler2D tSrc, tAdd; uniform vec2 uTexel;
void main(){
  vec3 c = texture2D(tSrc,vUv+uTexel*vec2(-2,0)).rgb + texture2D(tSrc,vUv+uTexel*vec2(2,0)).rgb
         + texture2D(tSrc,vUv+uTexel*vec2(0,-2)).rgb + texture2D(tSrc,vUv+uTexel*vec2(0,2)).rgb;
  c += (texture2D(tSrc,vUv+uTexel*vec2(-1,1)).rgb + texture2D(tSrc,vUv+uTexel*vec2(1,1)).rgb
      + texture2D(tSrc,vUv+uTexel*vec2(-1,-1)).rgb + texture2D(tSrc,vUv+uTexel*vec2(1,-1)).rgb)*2.;
  gl_FragColor = vec4(c/12. + texture2D(tAdd,vUv).rgb, 1.);
}`;

const FINAL_FRAG = /* glsl */`
varying vec2 vUv;
uniform sampler2D tScene, tDepth, tHaze, tBloom;
uniform mat4 uInvVP;
uniform vec3 uA, uB;
uniform float uR, uExposure, uTime, uCA, uFlash, uAspect, uFade; uniform vec2 uHazeTexel;
${NOISE}
vec3 aces(vec3 x){ x*=.6; return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
float grainAt(vec2 p, float t){ return fract(sin(dot(p+t, vec2(12.9898,78.233)))*43758.5453); }
void main(){
  vec2 c = vUv-.5; float r2 = dot(c*vec2(uAspect,1.),c*vec2(uAspect,1.));
  float ca = uCA*(r2*.9+.02);
  vec3 col = vec3(texture2D(tScene,vUv+c*ca).r, texture2D(tScene,vUv).g, texture2D(tScene,vUv-c*ca).b);
  vec4 hz = (texture2D(tHaze,vUv+uHazeTexel*vec2(.75,.25))+texture2D(tHaze,vUv+uHazeTexel*vec2(-.25,.75))
           + texture2D(tHaze,vUv+uHazeTexel*vec2(-.75,-.25))+texture2D(tHaze,vUv+uHazeTexel*vec2(.25,-.75)))*.25;
  col = col*hz.a + hz.rgb;
  col += texture2D(tBloom,vUv).rgb*.3;
  col *= uExposure;

  // Where the flood has reached, in the room itself rather than on the screen.
  float mask = 0., band = 0., side = 0.;
  if(uR>.001){
    if(uR>70.) mask = 1.;
    else {
      float dz = texture2D(tDepth,vUv).x;
      vec4 w = uInvVP*vec4(vUv*2.-1., dz*2.-1., 1.); vec3 p = w.xyz/w.w;
      float da = distance(p,uA), db = distance(p,uB);
      float d = min(da,db);
      side = smoothstep(-1.,1.,da-db);
      float bleed = (vnoise(p*.42)-.5)*5.2 + (vnoise(p*1.7)-.5)*1.5;
      float width = .35+uR*.09;
      float e = d + bleed*smoothstep(0.,6.,uR) - max(p.y-2.,0.)*.1;   // the colour climbs the shaft faster than it spreads
      mask = 1.-smoothstep(uR-width,uR+.12,e);
      band = smoothstep(uR-width*2.6,uR-width*.3,e)*(1.-smoothstep(uR-width*.3,uR+.2,e));
    }
  }

  float L = dot(col, vec3(.30,.59,.11));
  // Silver print: hard shoulder, deep toe, a breath of selenium.
  vec3 mono = aces(vec3(L));
  mono = mix(mono, mono*mono*(3.-2.*mono), .62);
  mono *= vec3(1.,.992,.975);
  // The one dye the house always allowed: gold survives the silver print, by hue, and nothing else does.
  float rr = max(col.r,1e-4), gr = col.g/rr, br = col.b/rr;
  float gold = smoothstep(.34,.5,gr)*smoothstep(.97,.88,gr)*smoothstep(.86,.62,br)*step(col.b,col.g);
  vec3 gilt = aces(col*vec3(1.,.97,.9));
  float gl = dot(gilt,vec3(.3,.59,.11));
  gilt = mix(mix(gl*vec3(1.2,.76,.24), vec3(1.,.9,.62), smoothstep(.6,.95,gl)), gilt, .16);
  mono = mix(mono, gilt, gold);
  // Technicolor: the same light, finally allowed its dyes.
  vec3 rich = mix(vec3(L), col, 1.16 + band*.9);
  rich = mix(rich, vec3(L), smoothstep(1.6,7.,L)*.75);
  rich = aces(max(rich,0.));
  rich = pow(rich, vec3(1.06));
  vec3 fr = mix(vec3(.8,.14,.1), vec3(.2,.9,.55), side);
  vec3 o = mix(mono, rich, mask);
  o += band*fr*(.12+smoothstep(0.,.6,L)*1.1);
  o += uFlash*vec3(1.,.97,.9);

  float vig = 1.-smoothstep(.1,.86,r2*1.25);
  o *= mix(.34,1.,vig);
  float g = grainAt(floor(gl_FragCoord.xy), fract(uTime)*47.)-.5;
  float lum = dot(o,vec3(.33));
  float gAmt = mix(.042,.024,mask)*(1.-lum*.55)*(.3+smoothstep(0.,.25,lum));
  o += g*gAmt;
  o = mix(o*12.92, 1.055*pow(max(o,vec3(.0031308)),vec3(1./2.4))-.055, step(.0031308,o));
  gl_FragColor = vec4(o*uFade,1.);
}`;

type Track = <T extends { dispose(): void }>(item: T) => T;

export function createPost(renderer: THREE.WebGLRenderer, track: Track) {
  const q = new FullScreenQuad();
  const mat = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => track(new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false }));
  const rt = (w: number, h: number, o: THREE.RenderTargetOptions = {}) => new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, ...o });

  const hazeU = {
    tDepth: { value: null as THREE.Texture | null }, tPrev: { value: null as THREE.Texture | null }, tShadowA: { value: null as THREE.Texture | null }, tShadowB: { value: null as THREE.Texture | null }, tMapB: { value: null as THREE.Texture | null },
    uInvVP: { value: new THREE.Matrix4() }, uMatA: { value: new THREE.Matrix4() }, uMatB: { value: new THREE.Matrix4() },
    uCam: { value: new THREE.Vector3() }, uLamp: { value: new THREE.Vector3() }, uLampDir: { value: new THREE.Vector3(0, -1, 0) },
    uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() },
    uCosOuter: { value: .7 }, uCosInner: { value: .75 }, uHazeT: { value: 0 }, uDensity: { value: .7 }, uFrame: { value: 0 }, uHasShadow: { value: 0 }, uBlend: { value: .3 }, uFloor: { value: 0 },
  };
  const haze = mat(HAZE_FRAG, hazeU);
  const downU = { tSrc: { value: null as THREE.Texture | null }, tHaze: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() }, uPrefilter: { value: 0 } };
  const down = mat(DOWN_FRAG, downU);
  const upU = { tSrc: { value: null as THREE.Texture | null }, tAdd: { value: null as THREE.Texture | null }, uTexel: { value: new THREE.Vector2() } };
  const up = mat(UP_FRAG, upU);
  const finalU = {
    tScene: { value: null as THREE.Texture | null }, tDepth: { value: null as THREE.Texture | null }, tHaze: { value: null as THREE.Texture | null }, tBloom: { value: null as THREE.Texture | null },
    uInvVP: { value: new THREE.Matrix4() }, uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() },
    uR: { value: 0 }, uExposure: { value: 1 }, uTime: { value: 0 }, uCA: { value: .004 }, uFlash: { value: 0 }, uAspect: { value: 1.6 }, uFade: { value: 0 }, uHazeTexel: { value: new THREE.Vector2() },
  };
  const final = mat(FINAL_FRAG, finalU);

  let scene: THREE.WebGLRenderTarget | null = null, hazeA: THREE.WebGLRenderTarget | null = null, hazeB: THREE.WebGLRenderTarget | null = null;
  let downs: THREE.WebGLRenderTarget[] = [], ups: THREE.WebGLRenderTarget[] = [], frame = 0, hazeBlank = true;
  function size(w: number, h: number, samples: number) {
    [scene, hazeA, hazeB, ...downs, ...ups].forEach((t) => { t?.dispose(); });
    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType);
    scene = rt(w, h, { depthBuffer: true, depthTexture: depth, samples });
    const hw = Math.max(2, w >> 2), hh = Math.max(2, h >> 2);
    hazeA = rt(hw, hh); hazeB = rt(hw, hh); finalU.uHazeTexel.value.set(1 / hw, 1 / hh);
    downs = []; ups = [];
    let bw = w, bh = h;
    for (let i = 0; i < 5; i++) { bw = Math.max(2, bw >> 1); bh = Math.max(2, bh >> 1); downs.push(rt(bw, bh)); if (i < 4) ups.push(rt(bw, bh)); }
    finalU.uAspect.value = w / h;
    hazeBlank = true;
  }
  function draw(m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) { q.material = m; renderer.setRenderTarget(target); q.render(renderer); }

  return {
    size, haze: { uniforms: hazeU }, final: { uniforms: finalU },
    get sceneTarget() { return scene; },
    render(camera: THREE.Camera, invVP: THREE.Matrix4) {
      if (!scene || !hazeA || !hazeB) throw new Error('Post chain drawn before it was sized');
      frame = (frame + 1) % 512;
      const hz = hazeU;
      hz.tDepth.value = scene.depthTexture; hz.tPrev.value = hazeB.texture; hz.uInvVP.value.copy(invVP);
      hz.uCam.value.copy(camera.position); hz.uFrame.value = frame;
      // New targets hold no history, and blending with it would dim the scene for several frames.
      const blend = hz.uBlend.value;
      if (hazeBlank) { hz.uBlend.value = 1; hazeBlank = false; }
      draw(haze, hazeA);
      hz.uBlend.value = blend;
      [hazeA, hazeB] = [hazeB, hazeA];

      downU.tHaze.value = hazeB.texture;
      let src = scene;
      downs.forEach((t, i) => {
        downU.tSrc.value = src.texture; downU.uPrefilter.value = i === 0 ? 1 : 0;
        downU.uTexel.value.set(1 / src.width, 1 / src.height);
        draw(down, t); src = t;
      });
      for (let i = ups.length - 1; i >= 0; i--) {
        const target = ups[i]!;
        upU.tSrc.value = src.texture; upU.tAdd.value = downs[i]!.texture;
        upU.uTexel.value.set(.5 / src.width, .5 / src.height);
        draw(up, target); src = target;
      }
      const f = finalU;
      f.tScene.value = scene.texture; f.tDepth.value = scene.depthTexture; f.tHaze.value = hazeB.texture; f.tBloom.value = src.texture;
      f.uInvVP.value.copy(invVP);
      draw(final, null);
    },
    dispose() { q.dispose(); [scene, hazeA, hazeB, ...downs, ...ups].forEach((t) => { t?.dispose(); }); },
  };
}
