// Every printed thing in the building: canvas textures only. Nothing is fetched.
import * as THREE from 'three';

export const DISPLAY = '"Limelight", "Bodoni Moda", Didot, Georgia, serif';
export const LABEL = '"Federo", "Bodoni Moda", Georgia, serif';
const ITALIC = '"Bodoni Moda", Didot, Georgia, serif';

function sheet(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('No 2D canvas');
  return [c, g];
}
function tex(c: HTMLCanvasElement, { srgb = true, aniso = 8, wrap = false }: { srgb?: boolean; aniso?: number; wrap?: boolean } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = aniso; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
  if (wrap) t.wrapS = THREE.RepeatWrapping;
  return t;
}
export function steppedRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number) {
  g.beginPath();
  g.moveTo(x + 2 * s, y); g.lineTo(x + w - 2 * s, y); g.lineTo(x + w - 2 * s, y + s); g.lineTo(x + w - s, y + s);
  g.lineTo(x + w - s, y + 2 * s); g.lineTo(x + w, y + 2 * s); g.lineTo(x + w, y + h - 2 * s); g.lineTo(x + w - s, y + h - 2 * s);
  g.lineTo(x + w - s, y + h - s); g.lineTo(x + w - 2 * s, y + h - s); g.lineTo(x + w - 2 * s, y + h); g.lineTo(x + 2 * s, y + h);
  g.lineTo(x + 2 * s, y + h - s); g.lineTo(x + s, y + h - s); g.lineTo(x + s, y + h - 2 * s); g.lineTo(x, y + h - 2 * s);
  g.lineTo(x, y + 2 * s); g.lineTo(x + s, y + 2 * s); g.lineTo(x + s, y + s); g.lineTo(x + 2 * s, y + s); g.closePath();
}
function fan(g: CanvasRenderingContext2D, cx: number, cy: number, r0: number, r1: number, rays: number, a0 = Math.PI, a1 = 2 * Math.PI, width = 0.42) {
  for (let i = 0; i < rays; i++) {
    const m = a0 + (a1 - a0) * (i + 0.5) / rays, half = (a1 - a0) / rays * width;
    g.beginPath(); g.moveTo(cx + Math.cos(m - half * .3) * r0, cy + Math.sin(m - half * .3) * r0);
    g.lineTo(cx + Math.cos(m - half) * r1, cy + Math.sin(m - half) * r1);
    g.arc(cx, cy, r1, m - half, m + half);
    g.lineTo(cx + Math.cos(m + half * .3) * r0, cy + Math.sin(m + half * .3) * r0); g.closePath(); g.fill();
  }
}

// Stage names cut around each balcony floor, filled with dark enamel.
export function stageNumber(label: string) {
  const [c, x] = sheet(512, 128);
  x.fillStyle = '#e2bc69'; x.textBaseline = 'middle'; x.textAlign = 'center'; x.font = `104px ${DISPLAY}`; x.fillText(label, 256, 68);
  return tex(c, { aniso: 8 });
}
export function tierEngraving(t: { label: string; name: string }) {
  const [c, x] = sheet(2048, 72);
  x.fillStyle = '#fff'; x.textBaseline = 'middle'; x.textAlign = 'center';
  const repeats = 3, w = c.width / repeats;
  for (let i = 0; i < repeats; i++) {
    x.font = `50px ${DISPLAY}`; x.fillText(t.label, w * (i + .22), 38);
    x.font = `34px ${LABEL}`; x.fillText(t.name, w * (i + .62), 38);
    x.fillRect(w * (i + .9), 35, 60, 2);
  }
  return tex(c, { aniso: 12, wrap: true });
}

// The limit, leaded into the skylight over the table.
export function sealEngraving(limitPct: string) {
  const S = 1024, [c, x] = sheet(S, S);
  x.fillStyle = '#fff'; x.strokeStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.font = `330px ${DISPLAY}`; x.fillText(limitPct, S / 2, S / 2 + 10);
  x.font = `52px ${LABEL}`; x.fillText('The classical limit', S / 2, S / 2 - 214);
  x.font = `italic 46px ${ITALIC}`; x.fillText('Three hands in four', S / 2, S / 2 + 222);
  const text = 'No plan agreed in advance passes this glass    '.repeat(2);
  x.font = `38px ${LABEL}`; x.save(); x.translate(S / 2, S / 2);
  const chars = [...text], step = Math.PI * 2 / chars.length;
  chars.forEach((ch, i) => { x.save(); x.rotate(i * step); x.translate(0, -448); x.fillText(ch, 0, 0); x.restore(); });
  x.restore();
  x.lineWidth = 3; [416, 480].forEach((r) => { x.beginPath(); x.arc(S / 2, S / 2, r, 0, Math.PI * 2); x.stroke(); });
  for (let i = 0; i < 100; i++) { const a = i / 100 * Math.PI * 2, L = i % 25 === 0 ? 30 : i % 5 === 0 ? 18 : 9;
    x.lineWidth = i === 75 ? 7 : 2; x.beginPath(); x.moveTo(S / 2 + Math.cos(a) * 396, S / 2 + Math.sin(a) * 396);
    x.lineTo(S / 2 + Math.cos(a) * (396 - L), S / 2 + Math.sin(a) * (396 - L)); x.stroke(); }
  return tex(c, { srgb: false, aniso: 12 });
}

// Emerald baize on the round table, the layout printed in gilt. Drawn twice: colour, and a metalness mask.
function drawFelt(x: CanvasRenderingContext2D, S: number, leaf: string, note: string) {
  const G = S / 2, u = S / 5.24;
  x.strokeStyle = leaf; x.fillStyle = leaf; x.textAlign = 'center'; x.textBaseline = 'middle';
  const ring = (r: number, w: number) => { x.lineWidth = w; x.beginPath(); x.arc(G, G, r * u, 0, Math.PI * 2); x.stroke(); };
  ring(2.56, 6); ring(2.5, 2); ring(1.28, 3); ring(1.22, 1.5);
  x.save(); x.globalAlpha = .82; fan(x, G, G, 1.34 * u, 1.72 * u, 60, 0, 2 * Math.PI, .3); x.restore();
  // Seats sit on the x axis, one room each. The limit runs between them.
  for (const [sx, name] of [[-1, 'You'], [1, 'Partner']] as const) {
    x.lineWidth = 3; x.beginPath(); x.arc(G + sx * 2 * u, G, .42 * u, 0, Math.PI * 2); x.stroke();
    x.font = `${.21 * u}px ${DISPLAY}`; x.fillText(name, G + sx * 1.72 * u, G + .92 * u);
    x.lineWidth = 3; steppedRect(x, G + sx * 1.4 * u - .26 * u, G - .37 * u, .52 * u, .74 * u, 4); x.stroke();
  }
  x.font = `${.18 * u}px ${DISPLAY}`; x.fillText('The Impossible Table', G, G + 2.05 * u);
  x.font = `${.105 * u}px ${LABEL}`; x.fillText('Same answer wins, unless you both draw a 1', G, G + 2.28 * u);
  x.font = `${.15 * u}px ${LABEL}`; x.fillText(note, G, G - 2.1 * u);
}
export function feltTextures(note: string) {
  const S = 2048, [a, x] = sheet(S, S), [b, y] = sheet(S, S);
  x.fillStyle = '#0c5b3e'; x.fillRect(0, 0, S, S);
  const img = x.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - .5) * 13; d[i]! += n; d[i + 1]! += n * 1.3; d[i + 2]! += n; }
  x.putImageData(img, 0, 0);
  y.fillStyle = 'rgb(0,235,0)'; y.fillRect(0, 0, S, S);    // mask: green roughness, blue metalness
  drawFelt(x, S, '#e2bc69', note); drawFelt(y, S, 'rgb(0,90,255)', note);
  return { map: tex(a, { aniso: 12 }), mask: tex(b, { srgb: false, aniso: 12 }) };
}

// Heavy-hex lattice: 8 rows of 16 joined by 7 rows of 4 bridges makes 156 qubits.
export function chipTextures() {
  const S = 1024, [a, x] = sheet(S, S), [e, g] = sheet(S, S);
  const grad = x.createLinearGradient(0, 0, S, S); grad.addColorStop(0, '#1b1b1c'); grad.addColorStop(.5, '#303031'); grad.addColorStop(1, '#141415');
  x.fillStyle = grad; x.fillRect(0, 0, S, S); g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  const m = 118, W = S - m * 2, dx = W / 15, dy = W / 14;
  x.strokeStyle = '#c9a25a'; x.lineWidth = 3; g.strokeStyle = '#2c3440'; g.lineWidth = 3;
  const dot = (px: number, py: number) => {
    x.fillStyle = '#e7c98d'; x.beginPath(); x.arc(px, py, 9, 0, 7); x.fill();
    const rad = g.createRadialGradient(px, py, 0, px, py, 15); rad.addColorStop(0, '#ffffff'); rad.addColorStop(.35, '#c9d6e6'); rad.addColorStop(1, '#00060c');
    g.fillStyle = rad; g.beginPath(); g.arc(px, py, 15, 0, 7); g.fill();
  };
  const P: [number, number][] = []; for (let r = 0; r < 8; r++) {
    const y = m + r * dy * 2; x.beginPath(); x.moveTo(m, y); x.lineTo(S - m, y); x.stroke(); g.beginPath(); g.moveTo(m, y); g.lineTo(S - m, y); g.stroke();
    for (let c = 0; c < 16; c++) P.push([m + c * dx, y]);
    if (r < 7) for (let k = 0; k < 4; k++) { const cx = m + (r % 2 ? 2 + k * 4 : k * 4 + .0) * dx + (r % 2 ? 0 : dx); const y2 = y + dy;
      x.beginPath(); x.moveTo(cx, y); x.lineTo(cx, y + dy * 2); x.stroke(); g.beginPath(); g.moveTo(cx, y); g.lineTo(cx, y + dy * 2); g.stroke(); P.push([cx, y2]); }
  }
  P.forEach(([px, py]) => dot(px, py));
  x.fillStyle = '#d9b46a'; for (let i = 0; i < 28; i++) { const p = 52 + i * (S - 104) / 27; for (const [q, r] of [[p, 28], [p, S - 28], [28, p], [S - 28, p]] as const) x.fillRect(q - 9, r - 9, 18, 18); }
  return { map: tex(a), emissive: tex(e) };
}

// Card atlas, 4 by 2. Cell 0 is the back, 1 and 2 are the question faces, the rest hang in the air later.
export const CARD_GRID = [4, 2] as const;
export const CARD_BACK = 0;
/** The atlas cell for a dealt question, 0 or 1; `null` before any hand leaves the card face down. */
export const questionCell = (question: number | null) => (question === null ? CARD_BACK : 1 + question);
export function cardAtlas() {
  const W = 256, H = 360; const [c, g] = sheet(W * 4, H * 2);
  const face = (i: number, draw: () => void) => {
    const x = (i % 4) * W, y = Math.floor(i / 4) * H;
    g.save(); g.translate(x, y); draw(); g.restore();
  };
  const paper = () => { g.fillStyle = '#ece4d0'; g.fillRect(0, 0, W, H); g.strokeStyle = '#7a6432'; g.lineWidth = 3; steppedRect(g, 12, 12, W - 24, H - 24, 7); g.stroke(); };
  face(0, () => {
    g.fillStyle = '#0b2f2a'; g.fillRect(0, 0, W, H); g.strokeStyle = '#d9b45e'; g.lineWidth = 4; steppedRect(g, 12, 12, W - 24, H - 24, 7); g.stroke();
    g.fillStyle = '#d9b45e'; fan(g, W / 2, H - 40, 18, 250, 15); fan(g, W / 2, 40, 18, 110, 9, 0, Math.PI);
  });
  const ask = (n: string) => () => {
    paper(); g.fillStyle = '#100d09'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `210px ${LABEL}`; g.fillText(n, W / 2, H / 2 + 6);
  };
  face(1, ask('0')); face(2, ask('1'));
  const suits = [['Q', '♥︎', '#7a1420'], ['A', '♠︎', '#100d09'], ['K', '♦︎', '#7a1420'], ['8', '♣︎', '#0b4a33'], ['J', '♥︎', '#7a1420']] as const;
  suits.forEach(([r, s, col], i) => face(3 + i, () => {
    paper(); g.fillStyle = col; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `78px ${DISPLAY}`; g.fillText(r, 58, 66);
    g.font = '150px Georgia, serif'; g.fillText(s, W / 2, H / 2 + 30);
    g.save(); g.translate(W, H); g.rotate(Math.PI); g.font = `78px ${DISPLAY}`; g.fillText(r, 58, 66); g.restore();
  }));
  return tex(c);
}

export function chipTexture() {
  const S = 256; const [c, g] = sheet(S, S);
  g.fillStyle = '#0c0a08'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#6e111c'; g.beginPath(); g.arc(S / 2, S / 2, 126, 0, 7); g.fill();
  g.fillStyle = '#ece4d0'; for (let i = 0; i < 8; i++) { g.beginPath(); g.arc(S / 2, S / 2, 126, i / 8 * 6.283, i / 8 * 6.283 + .32); g.lineTo(S / 2, S / 2); g.fill(); }
  g.fillStyle = '#16100c'; g.beginPath(); g.arc(S / 2, S / 2, 92, 0, 7); g.fill();
  g.strokeStyle = '#d9b45e'; g.lineWidth = 4; g.beginPath(); g.arc(S / 2, S / 2, 84, 0, 7); g.stroke();
  g.fillStyle = '#d9b45e'; fan(g, S / 2, S / 2 + 34, 6, 86, 7, Math.PI, 2 * Math.PI, .4);
  return tex(c);
}

// The dealer exists only as a shadow. Two layers so the arm can deal late.
export function dealerTextures() {
  const W = 768, H = 1152;
  const soft = (draw: (g: CanvasRenderingContext2D) => void, blur: number) => {
    const [c, g] = sheet(W, H); g.filter = `blur(${blur}px)`; g.scale(W / 1000, H / 1500); g.fillStyle = '#fff'; g.strokeStyle = '#fff'; draw(g);
    return tex(c, { srgb: false, aniso: 4 });
  };
  const body = soft((g) => {
    g.beginPath(); // the hat brim, tipped down over the eyes
    g.moveTo(205, 452); g.bezierCurveTo(330, 395, 560, 372, 820, 372);
    g.bezierCurveTo(850, 372, 860, 392, 835, 402); g.bezierCurveTo(640, 440, 430, 470, 225, 482);
    g.bezierCurveTo(196, 482, 190, 462, 205, 452); g.closePath(); g.fill();
    g.beginPath(); // the crown with its pinch
    g.moveTo(352, 432); g.bezierCurveTo(352, 330, 372, 225, 432, 192); g.bezierCurveTo(475, 170, 505, 205, 545, 196);
    g.bezierCurveTo(590, 170, 655, 172, 680, 222); g.bezierCurveTo(702, 270, 712, 340, 716, 404); g.closePath(); g.fill();
    g.beginPath(); // face in profile, looking left at the table
    g.moveTo(402, 450); g.bezierCurveTo(396, 482, 382, 498, 350, 544); g.bezierCurveTo(342, 556, 354, 566, 380, 566);
    g.bezierCurveTo(372, 582, 392, 584, 386, 600); g.bezierCurveTo(374, 610, 390, 618, 388, 628);
    g.bezierCurveTo(384, 660, 404, 690, 452, 696); g.bezierCurveTo(490, 700, 508, 716, 510, 770);
    g.lineTo(676, 770); g.bezierCurveTo(672, 700, 690, 640, 698, 590); g.bezierCurveTo(706, 520, 708, 470, 700, 420); g.closePath(); g.fill();
    g.beginPath(); // collar and overcoat
    g.moveTo(506, 742); g.lineTo(420, 830); g.bezierCurveTo(320, 860, 210, 900, 165, 990);
    g.bezierCurveTo(120, 1090, 100, 1300, 92, 1500); g.lineTo(930, 1500); g.bezierCurveTo(930, 1300, 910, 1090, 860, 980);
    g.bezierCurveTo(820, 900, 760, 860, 690, 742); g.closePath(); g.fill();
    g.lineWidth = 11; g.lineCap = 'round'; g.beginPath(); g.moveTo(372, 596); g.lineTo(262, 572); g.stroke(); // cigarette
  }, 2.5);
  const arm = soft((g) => {
    g.beginPath(); // forearm rising to a hand with one card
    g.moveTo(760, 1500); g.bezierCurveTo(660, 1320, 500, 1160, 300, 1085); g.lineTo(262, 1140);
    g.bezierCurveTo(420, 1240, 540, 1380, 560, 1500); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(322, 1072); g.bezierCurveTo(280, 1040, 240, 1050, 210, 1085); g.bezierCurveTo(205, 1110, 235, 1150, 270, 1150); g.closePath(); g.fill();
    g.save(); g.translate(205, 1060); g.rotate(-.42); g.fillRect(-50, -105, 98, 140); g.restore();
  }, 2.5);
  return { body, arm };
}

// Brass sign above a lift door: the room's name, and the stage it stops at where the floor number would be.
export function doorSign(name: string, stage: string) {
  const [c, g] = sheet(768, 192);
  g.fillStyle = '#0a0806'; g.fillRect(0, 0, 768, 192);
  g.strokeStyle = g.fillStyle = '#e2bc69'; g.lineWidth = 5; steppedRect(g, 10, 10, 748, 172, 12); g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = `62px ${DISPLAY}`; g.fillText(name, 384, 78);
  g.font = `40px ${LABEL}`; g.fillText(stage, 384, 142);
  return tex(c);
}

// What you can make out through the grille of the Cashier's Cage: a teller's wicket, green shade, stacked markers.
export function cageBackdrop() {
  const W = 512, H = 768, [c, g] = sheet(W, H);
  const v = g.createLinearGradient(0, 0, 0, H); v.addColorStop(0, '#0b0806'); v.addColorStop(.55, '#2a1f10'); v.addColorStop(1, '#070504');
  g.fillStyle = v; g.fillRect(0, 0, W, H);
  const glow = g.createRadialGradient(W / 2, H * .46, 10, W / 2, H * .46, 300); glow.addColorStop(0, 'rgba(255,226,160,.95)'); glow.addColorStop(.4, 'rgba(232,180,90,.35)'); glow.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = glow; g.fillRect(0, 0, W, H);
  g.fillStyle = '#0d4a33'; g.beginPath(); g.moveTo(W / 2 - 150, 300); g.lineTo(W / 2 - 74, 214); g.lineTo(W / 2 + 74, 214); g.lineTo(W / 2 + 150, 300); g.closePath(); g.fill();
  g.fillStyle = '#d9b45e'; g.fillRect(W / 2 - 150, 300, 300, 5); g.fillRect(W / 2 - 3, 60, 6, 156);
  g.fillStyle = '#6e111c'; for (let k = 0; k < 7; k++) for (let i = 0; i < 9; i++) g.fillRect(70 + k * 56, 548 - i * 12 - (k % 3) * 22, 46, 9);
  g.fillStyle = '#16100c'; g.fillRect(0, 556, W, 212);
  g.fillStyle = '#d9b45e'; g.fillRect(0, 556, W, 6);
  for (let i = 0; i <= 13; i++) g.fillRect(i * W / 13 - 3, 0, 6, 556);
  g.font = `38px ${LABEL}`; g.textAlign = 'center'; g.fillText('Markers redeemed', W / 2, 640);
  return tex(c);
}

// The wheel you can see still turning behind the grille at 800 mK.
export function wheelTexture() {
  const S = 1024, [c, g] = sheet(S, S), C = S / 2, n = 37;
  g.fillStyle = '#0a0806'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
    g.fillStyle = i === 0 ? '#0c5b3e' : i % 2 ? '#6e111c' : '#0b0908';
    g.beginPath(); g.arc(C, C, 500, a0, a1); g.arc(C, C, 372, a1, a0, true); g.closePath(); g.fill();
    g.fillStyle = '#e2bc69'; g.save(); g.translate(C, C); g.rotate(a0); g.fillRect(372, -2, 128, 4); g.rotate(Math.PI / n);
    g.font = `38px ${LABEL}`; g.textAlign = 'center'; g.translate(450, 0); g.rotate(Math.PI / 2); g.fillText(String(i * 7 % n), 0, 12); g.restore();
  }
  g.fillStyle = '#e2bc69'; fan(g, C, C, 80, 360, 18, 0, Math.PI * 2, .34);
  g.strokeStyle = '#e2bc69'; g.lineWidth = 8; [500, 372].forEach((r) => { g.beginPath(); g.arc(C, C, r, 0, 7); g.stroke(); });
  return tex(c, { aniso: 8 });
}
