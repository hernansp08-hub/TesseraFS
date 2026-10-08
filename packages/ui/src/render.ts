// Mapa de teselas: layout squarified (Bruls, Huizing y van Wijk, 2000) con cabeceras de carpeta,
// dos estilos de pintado — Mosaico (teselas con juntas) y Relieve (cushion de van Wijk y van de Wetering, 1999) —
// y un búfer de índices para saber qué hay bajo el puntero sin preguntar al motor.
import type { SliceNode } from '@tessera/protocol';
import type { RGB } from './colors';

export interface Tile { n: SliceNode; rest: boolean; x: number; y: number; w: number; h: number; a: number; b: number; c: number; d: number; depth: number }
export interface Head { n: SliceNode; x: number; y: number; w: number; h: number; depth: number }
export interface Layout { tiles: Tile[]; heads: Head[]; rects: Map<number, [number, number, number, number]>; l1: SliceNode[] }
export interface LayoutOpts { mosaic: boolean; headers: boolean; dpr: number }

const CUSH = { H: .32, F: .86, IA: .16, GAIN: 1.3 };
const LV = (() => { const x = -1, y = -1, z = 10, l = Math.hypot(x, y, z); return [x / l, y / l, z / l]; })();

interface Item { n: SliceNode; rest: boolean; size: number }
function itemsOf(n: SliceNode): Item[] {
  const items: Item[] = n.kids.filter(k => k.size > 0).map(k => ({ n: k, rest: false, size: k.size }));
  if (n.restSize > 0) { items.push({ n, rest: true, size: n.restSize }); items.sort((a, b) => b.size - a.size); }
  return items;
}

function squarify(items: Item[], x: number, y: number, w: number, h: number, cb: (it: Item, x: number, y: number, w: number, h: number) => void) {
  let total = 0; for (const it of items) total += it.size; if (total <= 0 || w <= 0 || h <= 0) return;
  const scale = w * h / total, n = items.length; let i = 0;
  while (i < n) {
    const horiz = w >= h, side = horiz ? h : w;
    let sum = 0, mn = Infinity, mx = 0, j = i, best = Infinity;
    while (j < n) {
      const ar = items[j].size * scale, s = sum + ar, lo = Math.min(mn, ar), hi = Math.max(mx, ar);
      const s2 = s * s, q = side * side, worst = Math.max(q * hi / s2, s2 / (q * lo));
      if (j > i && worst > best) break;
      best = worst; sum = s; mn = lo; mx = hi; j++;
    }
    let thick = sum / side; if (j >= n) thick = horiz ? w : h;
    if (horiz) {
      let cy = y;
      for (let t = i; t < j; t++) { const hh = t === j - 1 ? y + h - cy : items[t].size * scale / thick; cb(items[t], x, cy, thick, hh); cy += hh; }
      x += thick; w -= thick;
    } else {
      let cx = x;
      for (let t = i; t < j; t++) { const ww = t === j - 1 ? x + w - cx : items[t].size * scale / thick; cb(items[t], cx, y, ww, thick); cx += ww; }
      y += thick; h -= thick;
    }
    i = j;
  }
}

export function layout(root: SliceNode, W: number, H: number, opt: LayoutOpts): Layout {
  const out: Layout = { tiles: [], heads: [], rects: new Map(), l1: [] }, d = opt.dpr;
  const ridge = (x: number, y: number, w: number, h: number, s: number[], ht: number) => {
    const h4 = 4 * ht, wf = h4 / w, hf = h4 / h;
    return [s[0] - wf, s[1] - hf, s[2] + wf * (2 * x + w), s[3] + hf * (2 * y + h)];
  };
  const leaf = (n: SliceNode, rest: boolean, x: number, y: number, w: number, h: number, s: number[], ht: number, depth: number) => {
    const [a, b, c, dd] = ridge(x, y, w, h, s, ht);
    out.tiles.push({ n, rest, x, y, w, h, a, b, c, d: dd, depth });
  };
  (function lay(n: SliceNode, x: number, y: number, w: number, h: number, s: number[], ht: number, depth: number) {
    out.rects.set(n.id, [x, y, w, h]);
    if (depth === 1) out.l1.push(n);
    const items = n.isDir && w >= 2 && h >= 2 ? itemsOf(n) : [];
    if (!items.length) { if (depth === 0) out.tiles.push({ n, rest: false, x, y, w, h, a: 0, b: 0, c: 0, d: 0, depth }); else leaf(n, false, x, y, w, h, s, ht, depth); return; }
    const surf = depth > 0 ? ridge(x, y, w, h, s, ht) : s;
    let cx = x, cy = y, cw = w, ch = h;
    const head = depth > 0 && depth <= 3 && opt.headers && w >= 76 * d && h >= 46 * d;
    if (head) { const bh = Math.round(16 * d); out.heads.push({ n, x, y, w, h: bh, depth }); cy += bh; ch -= bh; }
    if (opt.mosaic && depth > 0) {
      const pad = (depth === 1 ? 3 : depth === 2 ? 2 : 1) * d;
      if (cw > pad * 8 && ch > pad * 8) { cx += pad; cw -= 2 * pad; ch -= pad; if (!head) { cy += pad; ch -= pad; } }
    }
    squarify(items, cx, cy, cw, ch, (it, ix, iy, iw, ih) => {
      if (it.rest) leaf(it.n, true, ix, iy, iw, ih, surf, ht * CUSH.F, depth + 1);
      else lay(it.n, ix, iy, iw, ih, surf, ht * CUSH.F, depth + 1);
    });
  })(root, 0, 0, W, H, [0, 0, 0, 0], CUSH.H, 0);
  return out;
}

export interface RasterOpts {
  mosaic: boolean; dpr: number; light: boolean; grout: RGB;
  color(t: Tile): RGB; dim: ((t: Tile) => boolean) | null;
}
/** Pinta las teselas en `px` (RGBA little-endian) y escribe en `ids` el índice de la tesela de cada píxel (-1 = junta). */
export function raster(L: Layout, W: number, H: number, px: Uint32Array, ids: Int32Array, o: RasterOpts) {
  px.fill(0xff000000 | (o.grout[2] << 16) | (o.grout[1] << 8) | o.grout[0]); ids.fill(-1);
  const [LX, LY, LZ] = LV, IA = CUSH.IA, IS = 1 - IA, G = CUSH.GAIN, gap = Math.max(1, Math.round(o.dpr));
  let nxa = new Float64Array(512);
  L.tiles.forEach((t, idx) => {
    let x0 = Math.round(t.x), x1 = Math.round(t.x + t.w), y0 = Math.round(t.y), y1 = Math.round(t.y + t.h);
    if (o.mosaic && x1 - x0 >= 4 * gap && y1 - y0 >= 4 * gap) { x1 -= gap; y1 -= gap; }
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 > W) x1 = W; if (y1 > H) y1 = H;
    const cw = x1 - x0, chh = y1 - y0; if (cw <= 0 || chh <= 0) return;
    let [r, g, b] = o.color(t);
    if (o.dim && o.dim(t)) { const l = r * .3 + g * .59 + b * .11; r = g = b = o.light ? 200 + l * .16 : l * .32; }
    if (o.mosaic) {
      const bevel = cw >= 5 && chh >= 5, hatch = t.rest;
      for (let iy = y0; iy < y1; iy++) {
        const fy = 1.07 - .15 * (iy - y0) / chh; let p = iy * W + x0;
        for (let ix = x0; ix < x1; ix++, p++) {
          let f = fy;
          if (bevel) { if (iy === y0 || ix === x0) f *= 1.2; else if (iy === y1 - 1 || ix === x1 - 1) f *= .78; }
          if (hatch && ((ix + iy) % 7) < 2) f *= 1.18;
          let R = r * f, Gc = g * f, B = b * f; if (R > 255) R = 255; if (Gc > 255) Gc = 255; if (B > 255) B = 255;
          px[p] = 0xff000000 | (B << 16) | (Gc << 8) | R; ids[p] = idx;
        }
      }
      return;
    }
    if (cw > nxa.length) nxa = new Float64Array(cw * 2);
    const a2 = 2 * t.a, b2 = 2 * t.b;
    for (let k = 0; k < cw; k++) nxa[k] = -(a2 * (x0 + k + .5) + t.c);
    for (let iy = y0; iy < y1; iy++) {
      const ny = -(b2 * (iy + .5) + t.d), nyl = ny * LY + LZ, ny2 = ny * ny + 1; let p = iy * W + x0;
      for (let k = 0; k < cw; k++, p++) {
        const nx = nxa[k]; let cs = (nx * LX + nyl) / Math.sqrt(nx * nx + ny2); if (cs > 1) cs = 1;
        let I = IS * cs; if (I < 0) I = 0; I = (I + IA) * G;
        if (t.rest && ((x0 + k + iy) % 7) < 2) I *= 1.15;
        let R = r * I, Gc = g * I, B = b * I;
        if (R > 255) { const e = (R - 255) / 2; R = 255; Gc += e; B += e; }
        else if (Gc > 255) { const e = (Gc - 255) / 2; Gc = 255; R += e; B += e; }
        else if (B > 255) { const e = (B - 255) / 2; B = 255; R += e; Gc += e; }
        if (R > 255) R = 255; if (Gc > 255) Gc = 255; if (B > 255) B = 255;
        px[p] = 0xff000000 | (B << 16) | (Gc << 8) | R; ids[p] = idx;
      }
    }
  });
  // Las cabeceras también responden al puntero: índice negativo -2 - i
  L.heads.forEach((hd, i) => {
    const x0 = Math.max(0, Math.round(hd.x)), x1 = Math.min(W, Math.round(hd.x + hd.w)), y0 = Math.max(0, Math.round(hd.y)), y1 = Math.min(H, Math.round(hd.y + hd.h));
    for (let iy = y0; iy < y1; iy++) ids.fill(-2 - i, iy * W + x0, iy * W + x1);
  });
}
