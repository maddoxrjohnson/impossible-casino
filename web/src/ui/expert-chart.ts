// Draws an expert sheet: inline SVG charts in ink and gold on the marker's paper, legends with their sources, and plain tables.
import type { ExpertChart, ExpertLine, ExpertSeries, ExpertShape, ExpertSheet, ExpertTone } from './expert';

const NS = 'http://www.w3.org/2000/svg';
const TONE: Record<ExpertTone, string> = { ink: '#17120b', gold: '#935f00', grey: '#66625a' };
const DASH: Record<ExpertLine, string> = { solid: '', dash: '6 4', dot: '1.5 3.5', long: '12 4' };
/** The paper behind the marks, for the ring that keeps a dot legible where it crosses a line. */
const PAPER = '#e9e0c9';

type Attrs = Record<string, string | number>;
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs, parent?: Element, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  if (text != null) e.textContent = text;
  parent?.appendChild(e);
  return e;
}
function html<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function shapeAt(shape: ExpertShape, x: number, y: number, r: number, attrs: Attrs, parent: Element): void {
  if (shape === 'circle') svg('circle', { cx: x, cy: y, r, ...attrs }, parent);
  else if (shape === 'square') svg('rect', { x: x - r * 0.9, y: y - r * 0.9, width: r * 1.8, height: r * 1.8, ...attrs }, parent);
  else if (shape === 'diamond') svg('path', { d: `M${x} ${y - r * 1.25}L${x + r * 1.25} ${y}L${x} ${y + r * 1.25}L${x - r * 1.25} ${y}Z`, ...attrs }, parent);
  else svg('path', { d: `M${x} ${y - r * 1.2}L${x + r * 1.1} ${y + r * 0.8}L${x - r * 1.1} ${y + r * 0.8}Z`, ...attrs }, parent);
}

/** A short sample of a series' mark, for its legend row. */
function key(s: { tone: ExpertTone; line: ExpertLine | null; shape: ExpertShape | null; bars?: boolean }): SVGSVGElement {
  const k = svg('svg', { viewBox: '0 0 28 12', width: 28, height: 12, 'aria-hidden': 'true', class: 'dc-ex-key' });
  const colour = TONE[s.tone];
  if (s.bars) svg('rect', { x: 10, y: 1, width: 8, height: 11, fill: colour, opacity: 0.55 }, k);
  if (s.line) svg('line', { x1: 1, y1: 6, x2: 27, y2: 6, stroke: colour, 'stroke-width': 2, 'stroke-dasharray': DASH[s.line], 'stroke-linecap': s.line === 'dot' ? 'round' : 'butt' }, k);
  if (s.shape) shapeAt(s.shape, 14, 6, 3.6, { fill: colour, stroke: PAPER, 'stroke-width': 1.5 }, k);
  return k;
}

/** One chart at the width it will show at, so its text stays at its real size on a phone and on a desktop. */
export function expertChart(chart: ExpertChart, width: number): HTMLElement {
  const figure = html('figure', 'dc-ex-fig');
  figure.append(html('figcaption', 'dc-ex-cap', chart.title));
  const W = Math.round(Math.max(280, Math.min(760, width)));
  const H = Math.round(Math.max(250, Math.min(300, W * 0.56)));
  const m = { l: 40, r: 10, t: 24, b: 38 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const sx = (x: number) => m.l + ((x - chart.x.min) / (chart.x.max - chart.x.min)) * pw;
  const sy = (y: number) => m.t + (1 - (y - chart.y.min) / (chart.y.max - chart.y.min)) * ph;
  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'dc-ex-chart', role: 'img', 'aria-label': `${chart.title}. ${chart.y.label} against ${chart.x.label.toLowerCase()}. ${chart.alt ?? 'The values are in the tables below.'}` });

  // Recessive grid and ticks.
  const grid = svg('g', { class: 'dc-ex-grid' }, root);
  for (const t of chart.y.ticks) {
    svg('line', { x1: m.l, x2: W - m.r, y1: sy(t.value), y2: sy(t.value) }, grid);
    svg('text', { x: m.l - 6, y: sy(t.value) + 4, 'text-anchor': 'end', class: 'dc-ex-tick' }, root, t.label);
  }
  for (const t of chart.x.ticks) svg('text', { x: sx(t.value), y: H - m.b + 15, 'text-anchor': 'middle', class: 'dc-ex-tick' }, root, t.label);
  svg('line', { x1: m.l, x2: W - m.r, y1: m.t + ph, y2: m.t + ph, class: 'dc-ex-axis' }, root);
  svg('text', { x: m.l + pw / 2, y: H - 5, 'text-anchor': 'middle', class: 'dc-ex-alabel' }, root, chart.x.label);
  svg('text', { x: 4, y: 12, class: 'dc-ex-alabel' }, root, chart.y.label);

  // Bars first, so lines and dots sit over them.
  const ordered = [...chart.series].sort((a, b) => Number(!!b.bars) - Number(!!a.bars));
  for (const s of ordered) drawSeries(root, s, sx, sy, m.t + ph);

  // Top to bottom, a label that would touch the one above drops under its own line.
  let lastLabel = -Infinity;
  for (const r of [...chart.rules].sort((a, b) => b.y - a.y)) {
    const y = sy(r.y);
    svg('line', { x1: m.l, x2: W - m.r, y1: y, y2: y, stroke: TONE[r.tone], 'stroke-width': 1.25, 'stroke-dasharray': DASH[r.line] }, root);
    const at = y - 4 - lastLabel < 13 ? y + 13 : y - 4;
    svg('text', { x: W - m.r - 2, y: at, 'text-anchor': 'end', class: 'dc-ex-rule' }, root, r.label);
    lastLabel = at;
  }

  if (chart.marker) {
    const x = sx(chart.marker.x);
    svg('line', { x1: x, x2: x, y1: m.t - 4, y2: m.t + ph, class: 'dc-ex-marker' }, root);
    const anchor = x > W - 90 ? 'end' : x < m.l + 60 ? 'start' : 'middle';
    svg('text', { x: anchor === 'start' ? x + 4 : anchor === 'end' ? x - 4 : x, y: m.t - 8, 'text-anchor': anchor, class: 'dc-ex-mlabel' }, root, chart.marker.label);
  }
  figure.append(root);

  const legend = html('ul', 'dc-ex-legend');
  for (const s of chart.series) legend.append(legendRow(key(s), s.label, s.source));
  for (const r of chart.rules) legend.append(legendRow(key({ tone: r.tone, line: r.line, shape: null }), r.label, r.source));
  figure.append(legend);
  for (const n of chart.note) figure.append(html('p', 'dc-ex-note', n));
  return figure;
}

function legendRow(k: SVGSVGElement, label: string, source: string): HTMLLIElement {
  const li = html('li');
  const text = html('span');
  text.append(html('b', '', label), html('small', '', source));
  li.append(k, text);
  return li;
}

function drawSeries(root: SVGSVGElement, s: ExpertSeries, sx: (x: number) => number, sy: (y: number) => number, base: number): void {
  const colour = TONE[s.tone];
  // The narrowest gap between neighbouring points, in pixels: the width a bar or a hover target can take.
  let step = 24;
  for (let i = 1; i < s.points.length; i += 1) step = Math.min(step, Math.abs(sx(s.points[i]!.x) - sx(s.points[i - 1]!.x)));
  const g = svg('g', { class: 'dc-ex-series' }, root);
  if (s.bars) {
    const w = Math.max(2, Math.min(24, step * 0.62));
    for (const p of s.points) {
      if (p.y <= 0) continue;
      const top = sy(p.y);
      svg('rect', { x: sx(p.x) - w / 2, y: top, width: w, height: Math.max(0.5, base - top), fill: colour, opacity: 0.55 }, g);
    }
  }
  if (s.line && s.points.length > 1) {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join('');
    svg('path', { d, fill: 'none', stroke: colour, 'stroke-width': 2, 'stroke-dasharray': DASH[s.line], 'stroke-linejoin': 'round', 'stroke-linecap': s.line === 'dot' ? 'round' : 'butt' }, g);
  }
  for (const p of s.points) {
    if (p.lo !== undefined && p.hi !== undefined) {
      const x = sx(p.x), y0 = sy(p.lo), y1 = sy(p.hi);
      svg('path', { d: `M${x} ${y0}V${y1}M${x - 3.5} ${y0}H${x + 3.5}M${x - 3.5} ${y1}H${x + 3.5}`, stroke: colour, 'stroke-width': 1.25, fill: 'none' }, g);
    }
    if (s.shape) shapeAt(s.shape, sx(p.x), sy(p.y), 4, { fill: colour, stroke: PAPER, 'stroke-width': 2 }, g);
    // A hover target wider than the mark, carrying the value.
    const hit = svg('rect', { x: sx(p.x) - Math.max(6, step / 2), y: s.bars ? sy(Math.max(p.y, 0)) - 12 : sy(p.y) - 12, width: Math.max(12, step), height: s.bars ? base - sy(Math.max(p.y, 0)) + 12 : 24, class: 'dc-ex-hit' }, g);
    svg('title', {}, hit, p.tip);
  }
}

/** The whole sheet's body: maths, charts, tables and sources. */
export function expertBody(sheet: ExpertSheet, width: number): DocumentFragment {
  const out = document.createDocumentFragment();
  const maths = html('div', 'dc-ex-maths');
  for (const line of sheet.maths) maths.append(html('p', '', line));
  out.append(maths);
  for (const chart of sheet.charts) out.append(expertChart(chart, width));
  for (const t of sheet.tables) {
    const wrap = html('div', 'dc-ex-table');
    const table = html('table');
    table.append(html('caption', '', t.title));
    const head = html('tr');
    for (const h of t.head) { const th = html('th', '', h); th.scope = 'col'; head.append(th); }
    table.append(html('thead'), html('tbody'));
    table.tHead?.append(head);
    for (const row of t.rows) {
      const tr = html('tr');
      row.forEach((cell, i) => {
        if (i === 0) { const th = html('th', '', cell); th.scope = 'row'; tr.append(th); } else tr.append(html('td', '', cell));
      });
      table.tBodies[0]?.append(tr);
    }
    wrap.append(table);
    if (t.note) wrap.append(html('p', 'dc-ex-note', t.note));
    out.append(wrap);
  }
  const sources = html('ul', 'dc-ex-sources');
  for (const s of sheet.sources) sources.append(html('li', '', s));
  out.append(sources);
  return out;
}
