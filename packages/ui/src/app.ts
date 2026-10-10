// Interfaz de TesseraFS: un único estado y una selección que une el árbol, el mapa y el panel de detalle.
import {
  FLAG, decodeSlice, type ActionKind, type Backend, type ExtStat, type NodeRow, type ScanProgress, type ScanResult,
  type SearchRow, type SliceNode, type SortKey, type VolumeInfo,
} from '@tessera/protocol';
import { layout, raster, type Layout, type Tile } from './render';
import { AGE_BINS, CATEGORIES, REST_COLOR, ageBin, ageColor, ageName, catName, categoryById, categoryOf, extColor, rgb, setExtRanking, type ColorMode, type RGB } from './colors';
import { GB, MB, ageText, esc, fmtB, fmtD, fmtN, fmtP, fmtS } from './format';
import { LOCALES, PSEUDO, html, i18n, msgText, onLocaleChange, preference, setPreference, systemLocale, t, tk, translateDom, type MessageKey } from './i18n';

type TRow = { row: NodeRow; depth: number; more?: undefined } | { more: number; remaining: number; depth: number; row?: undefined };
// Los resaltados guardan datos, no textos: la etiqueta se compone al pintar, en el idioma activo
type HL = { type: 'cat'; id: string } | { type: 'ext'; ext: string } | { type: 'age'; bin: number }
  | { type: 'search'; ids: Set<number>; query: string; count: number };
type Risk = 'ok' | 'warn' | 'bad';
interface CleanCard { row: NodeRow; path: string; rule: Rule; name: string; count?: number }
/** Texto traducido y escapado para insertarlo en HTML. */
const tx = (key: MessageKey, params?: Parameters<typeof t>[1]) => esc(t(key, params));

declare const __TESSERA_VERSION__: string; // la inyecta build.ts desde package.json
const VERSION = typeof __TESSERA_VERSION__ === 'string' ? __TESSERA_VERSION__ : 'dev';
let B: Backend;
const $ = (id: string) => document.getElementById(id)!;
const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const PAGE = 500;

const S = {
  vols: [] as VolumeInfo[], vol: null as VolumeInfo | null, target: 'C:\\',
  scan: null as ScanResult | null, scanning: false,
  root: null as NodeRow | null,
  chain: [] as NodeRow[],
  slice: null as { nodes: SliceNode[]; byId: Map<number, SliceNode>; root: SliceNode; key: string } | null,
  L: null as Layout | null,
  sel: null as NodeRow | null,
  hover: null as number | null,
  expanded: new Set<number>(), kids: new Map<number, { rows: NodeRow[]; total: number }>(),
  sort: { key: 'size' as SortKey, desc: true },
  rows: [] as TRow[],
  tab: 'tree', color: 'category' as ColorMode, style: 'mosaic' as 'mosaic' | 'relief', labels: true,
  hl: null as HL | null, compOpen: null as string | null,
  query: '', files: [] as SearchRow[], filesTotal: 0, filesBytes: 0,
  ext: [] as ExtStat[], clean: null as CleanCard[] | null, confirmTrash: false,
  rowCache: new Map<number, NodeRow>(), pathCache: new Map<number, string>(),
};
const zoomRow = () => S.chain[S.chain.length - 1] || null;
const remember = (r: NodeRow) => { S.rowCache.set(r.id, r); return r; };
async function rowOf(id: number) { return S.rowCache.get(id) || remember(await B.nodeInfo(id)); }
async function pathOf(id: number) {
  let p = S.pathCache.get(id); if (p == null) { p = await B.nodePath(id); S.pathCache.set(id, p); } return p;
}
const nameOf = (r: NodeRow) => r.parentId < 0 ? (S.scan?.rootPath || r.name) : r.name;
function hexToRgb(h: string): RGB { const m = h.replace('#', ''); const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function isLight() { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'light' : matchMedia('(prefers-color-scheme: light)').matches; }
function nodeColor(ext: string, isDir: boolean, mtime: number): RGB {
  if (S.color === 'age') return ageColor(ageBin(mtime, Date.now() / 1000));
  if (isDir) return REST_COLOR;
  return S.color === 'ext' ? extColor(ext) : categoryOf(ext).color;
}
const rowColor = (r: NodeRow) => nodeColor(r.ext, r.isDir, r.mtime);

// ---------- Avisos ----------
let toastT = 0;
export function toast(msg: string) {
  const t = $('toast'); t.textContent = msg; t.hidden = false; requestAnimationFrame(() => t.classList.add('show'));
  clearTimeout(toastT); toastT = window.setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 200); }, 4200);
}
function copyText(text: string, ok: MessageKey = 'toast.copied') {
  const fail = () => toast(t('toast.copyFailed', { text }));
  try { navigator.clipboard.writeText(text).then(() => toast(t(ok, { text })), fail); } catch { fail(); }
}

// ---------- Lista virtual ----------
class VList {
  n = 0; spacer = document.createElement('div'); layer = document.createElement('div');
  constructor(public sc: HTMLElement, public rowH: number, public render: (i: number) => string, public after?: (layer: HTMLElement) => void) {
    this.spacer.className = 'vspacer'; this.layer.className = 'vlayer'; this.spacer.appendChild(this.layer); sc.appendChild(this.spacer);
    sc.addEventListener('scroll', () => this.paint(), { passive: true });
    new ResizeObserver(() => this.paint()).observe(sc);
  }
  setCount(n: number) { this.n = n; this.spacer.style.height = n * this.rowH + 'px'; this.paint(); }
  paint() {
    const st = this.sc.scrollTop, vh = this.sc.clientHeight || 500;
    const a = Math.max(0, Math.floor(st / this.rowH) - 6), b = Math.min(this.n, Math.ceil((st + vh) / this.rowH) + 6);
    let h = ''; for (let i = a; i < b; i++) h += this.render(i);
    this.layer.style.transform = `translateY(${a * this.rowH}px)`; this.layer.innerHTML = h;
    this.after?.(this.layer);
  }
  scrollTo(i: number) {
    if (i < 0) return; const rh = this.rowH, top = i * rh, st = this.sc.scrollTop, vh = this.sc.clientHeight;
    if (top < st || top + rh > st + vh) this.sc.scrollTop = Math.max(0, top - vh / 2 + rh / 2);
    this.paint();
  }
}

// ---------- Mapa ----------
const wrap = $('mapWrap'), mapC = $('map') as HTMLCanvasElement, ovC = $('overlay') as HTMLCanvasElement, snap = $('snap') as HTMLCanvasElement, tip = $('tip');
const mctx = mapC.getContext('2d')!, octx = ovC.getContext('2d')!;
let M: { W: number; H: number; dpr: number; cw: number; ch: number } | null = null, IMG: ImageData | null = null, IDS: Int32Array | null = null;

async function loadSlice(force = false) {
  const z = zoomRow(); if (!z) return;
  const cw = wrap.clientWidth, ch = wrap.clientHeight; if (cw < 4 || ch < 4) return;
  const minBytes = Math.max(1, z.size * 1.5 / (cw * ch)), key = z.id + ':' + Math.round(Math.log2(minBytes) * 2);
  if (!force && S.slice && S.slice.key === key) { renderMap(); return; }
  const buf = await B.slice(z.id, minBytes, 150000);
  if (zoomRow() !== z) return;
  const { nodes } = decodeSlice(buf);
  S.slice = { nodes, byId: new Map(nodes.map(n => [n.id, n])), root: nodes[0], key };
  renderMap();
}
function tileColor(t: Tile): RGB { return t.rest ? REST_COLOR : nodeColor(t.n.ext, t.n.isDir, t.n.mtime); }
function dimFn(): ((t: Tile) => boolean) | null {
  const h = S.hl; if (!h) return null;
  if (h.type === 'cat') return t => t.rest || t.n.isDir || categoryOf(t.n.ext).id !== h.id;
  if (h.type === 'ext') return t => t.rest || t.n.isDir || t.n.ext !== h.ext;
  if (h.type === 'age') return t => t.rest || ageBin(t.n.mtime, Date.now() / 1000) !== h.bin;
  return t => t.rest || !h.ids.has(t.n.id);
}
/** `lowRes`: pinta a 1 píxel por píxel CSS para seguir el arrastre de un divisor sin tirones. */
export function renderMap(lowRes = false) {
  if (!S.slice) { M = null; mctx.clearRect(0, 0, mapC.width, mapC.height); octx.clearRect(0, 0, ovC.width, ovC.height); return; }
  const cw = wrap.clientWidth, ch = wrap.clientHeight; if (cw < 4 || ch < 4) return;
  const dpr = lowRes ? 1 : Math.min(2, window.devicePixelRatio || 1), W = Math.round(cw * dpr), H = Math.round(ch * dpr);
  for (const c of [mapC, ovC]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const mosaic = S.style === 'mosaic';
  S.L = layout(S.slice.root, W, H, { mosaic, headers: S.labels, dpr });
  if (!IMG || IMG.width !== W || IMG.height !== H) { IMG = mctx.createImageData(W, H); IDS = new Int32Array(W * H); }
  raster(S.L, W, H, new Uint32Array(IMG.data.buffer), IDS!, { mosaic, dpr, light: isLight(), grout: hexToRgb(css('--grout') || '#0c0f11'), color: tileColor, dim: dimFn() });
  mctx.putImageData(IMG, 0, 0);
  M = { W, H, dpr, cw, ch };
  if (S.labels) { drawHeads(); drawTileLabels(); }
  drawOverlay();
}
function fitText(ctx: CanvasRenderingContext2D, s: string, maxW: number) {
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1; }
  return lo > 1 ? s.slice(0, lo) + '…' : '';
}
function drawHeads() {
  const d = M!.dpr, bg = css('--tile-head'), fg = css('--tile-head-fg'), muted = css('--muted'), font = css('--f-ui');
  mctx.save(); mctx.textBaseline = 'middle';
  for (const h of S.L!.heads) {
    const x = Math.round(h.x), y = Math.round(h.y), w = Math.round(h.x + h.w) - x, hh = Math.round(h.y + h.h) - y;
    mctx.fillStyle = bg; mctx.fillRect(x, y, w, hh);
    const size = fmtB(h.n.size); mctx.font = `500 ${10.5 * d}px ${font}`; const sw = mctx.measureText(size).width;
    mctx.font = `${h.depth === 1 ? 600 : 500} ${11.5 * d}px ${font}`;
    const name = fitText(mctx, h.n.name, w - sw - 18 * d);
    mctx.fillStyle = fg; mctx.fillText(name, x + 6 * d, y + hh / 2);
    if (w > sw + 40 * d) { mctx.font = `500 ${10.5 * d}px ${font}`; mctx.fillStyle = muted; mctx.fillText(size, x + w - sw - 6 * d, y + hh / 2); }
  }
  mctx.restore();
}
function drawTileLabels() {
  const d = M!.dpr, font = css('--f-ui');
  mctx.save(); mctx.textAlign = 'center'; mctx.textBaseline = 'middle';
  mctx.shadowColor = 'rgba(0,0,0,.55)'; mctx.shadowBlur = 3 * d;
  for (const t of S.L!.tiles) {
    if (t.rest || t.w < 96 * d || t.h < 38 * d) continue;
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    mctx.font = `600 ${12 * d}px ${font}`; mctx.fillStyle = '#fff';
    const name = fitText(mctx, t.n.name, t.w - 14 * d); if (!name) continue;
    mctx.fillText(name, cx, cy - 7 * d);
    mctx.font = `500 ${11 * d}px ${font}`; mctx.fillStyle = 'rgba(255,255,255,.86)'; mctx.fillText(fmtB(t.n.size), cx, cy + 8 * d);
  }
  mctx.restore();
}
function rectFor(id: number): [number, number, number, number] | null {
  if (!S.L) return null;
  for (let x: NodeRow | undefined | null = S.rowCache.get(id), cur = id; ;) {
    const r = S.L.rects.get(cur); if (r) return r;
    const sn = S.slice?.byId.get(cur); const pid = sn?.parent ? sn.parent.id : x ? x.parentId : -1;
    if (pid < 0) return null; cur = pid; x = S.rowCache.get(pid);
  }
}
function box(r: number[], col: string, lw: number, halo: boolean, dash?: number[]) {
  const x0 = Math.round(r[0]), y0 = Math.round(r[1]), w = Math.max(1, Math.round(r[0] + r[2]) - x0), h = Math.max(1, Math.round(r[1] + r[3]) - y0);
  const x = x0 + lw / 2, y = y0 + lw / 2, ww = Math.max(1, w - lw), hh = Math.max(1, h - lw);
  if (halo) { octx.setLineDash([]); octx.strokeStyle = 'rgba(0,0,0,.6)'; octx.lineWidth = lw + 2 * M!.dpr; octx.strokeRect(x, y, ww, hh); }
  octx.setLineDash(dash || []); octx.strokeStyle = col; octx.lineWidth = lw; octx.strokeRect(x, y, ww, hh); octx.setLineDash([]);
}
function hoverNode(): { n: SliceNode; rest: boolean; head: boolean } | null {
  if (S.hover == null || !S.L) return null;
  if (S.hover >= 0) { const t = S.L.tiles[S.hover]; return t ? { n: t.n, rest: t.rest, head: false } : null; }
  const h = S.L.heads[-2 - S.hover]; return h ? { n: h.n, rest: false, head: true } : null;
}
export function drawOverlay() {
  if (!M) return; const d = M.dpr; octx.clearRect(0, 0, M.W, M.H);
  const z = zoomRow();
  if (S.sel && z && S.sel.id !== z.id) { const r = rectFor(S.sel.id); if (r) box(r, css('--accent'), 3 * d, true); }
  const h = hoverNode();
  if (h && !S.scanning) {
    if (h.head || h.rest) { const r = S.L!.rects.get(h.n.id); if (r) box(r, '#ffffff', 1.5 * d, true); }
    else {
      if (h.n.parent && h.n.parent.id !== z?.id) { const pr = S.L!.rects.get(h.n.parent.id); if (pr) box(pr, 'rgba(255,255,255,.9)', d, false, [4 * d, 3 * d]); }
      const r = S.L!.rects.get(h.n.id); if (r) box(r, '#ffffff', 1.5 * d, true);
    }
  }
}
function slicePath(n: SliceNode) {
  const names: string[] = []; for (let x: SliceNode | null = n; x && x.parent; x = x.parent) names.push(x.name);
  const base = S.pathCache.get(zoomRow()!.id) || '';
  const rel = names.reverse().join('\\'); return !rel ? base : base.endsWith('\\') ? base + rel : base + '\\' + rel;
}
function sliceRow(n: SliceNode): NodeRow {
  return remember({ id: n.id, parentId: n.parent ? n.parent.id : zoomRow()!.parentId, name: n.name, isDir: n.isDir, size: n.size, alloc: n.alloc,
    files: n.files, dirs: n.dirs, mtime: n.mtime, ext: n.ext, flags: n.flags, childCount: n.childCount });
}
function tipHTML(h: { n: SliceNode; rest: boolean; head: boolean }) {
  const base = zoomRow()!.size || 1, n = h.n;
  if (h.rest) return `<div class="t-name"><i class="sw" style="background:${rgb(REST_COLOR)}"></i><b>${tx('tip.small', { count: n.restCount })}</b></div>`
    + `<div class="t-path">${esc(slicePath(n))}</div><div class="t-grid"><span>${tx('tip.totalSize')}</span><b>${fmtB(n.restSize)}</b><span>${tx('tip.ofMap')}</span><b>${fmtP(n.restSize / base)}</b></div>`
    + `<div class="t-hint">${tx('tip.small.hint')}</div>`;
  const c = n.isDir ? null : categoryOf(n.ext);
  return `<div class="t-name"><i class="sw" style="background:${rgb(nodeColor(n.ext, n.isDir, n.mtime))}"></i><b>${esc(n.name)}${n.isDir ? '\\' : ''}</b></div>`
    + `<div class="t-path">${esc(n.parent ? slicePath(n.parent) : slicePath(n))}</div>`
    + `<div class="t-grid"><span>${tx('tip.size')}</span><b>${fmtB(n.size)}</b><span>${tx('tip.ofMap')}</span><b>${fmtP(n.size / base)}</b>`
    + (n.isDir ? `<span>${tx('tip.contents')}</span><b>${tx('tip.files', { count: n.files })}</b>` : `<span>${tx('tip.type')}</span><b>${esc(catName(c!))}${n.ext ? ' · .' + esc(n.ext) : ''}</b>`)
    + `<span>${tx('tip.modified')}</span><b>${esc(ageText(n.mtime))}</b></div>`
    + `<div class="t-hint">${tx('tip.hint')}</div>`;
}
function hitAt(e: MouseEvent): number | null {
  if (!M || !IDS) return null; const rc = ovC.getBoundingClientRect();
  const x = Math.floor((e.clientX - rc.left) * M.dpr), y = Math.floor((e.clientY - rc.top) * M.dpr);
  if (x < 0 || y < 0 || x >= M.W || y >= M.H) return null;
  const v = IDS[y * M.W + x]; return v === -1 ? null : v;
}
let tipKey = '';
ovC.addEventListener('pointermove', e => {
  if (S.scanning || e.pointerType === 'touch') return;
  const v = hitAt(e); if (v !== S.hover) { S.hover = v; drawOverlay(); }
  const h = hoverNode(); if (!h) { tip.hidden = true; tipKey = ''; return; }
  const key = (h.rest ? 'r' : h.head ? 'h' : 't') + h.n.id; if (key !== tipKey) { tip.innerHTML = tipHTML(h); tipKey = key; }
  tip.hidden = false;
  const rc = ovC.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top, tw = tip.offsetWidth, th = tip.offsetHeight;
  let l = x + 16, t = y + 16; if (l + tw > M!.cw - 6) l = x - tw - 16; if (l < 6) l = 6; if (t + th > M!.ch - 6) t = y - th - 16; if (t < 6) t = 6;
  tip.style.transform = `translate(${l}px,${t}px)`;
});
ovC.addEventListener('pointerleave', () => { S.hover = null; tipKey = ''; tip.hidden = true; drawOverlay(); });
ovC.addEventListener('click', e => {
  if (S.scanning) return; S.hover = hitAt(e); const h = hoverNode(); if (!h) return;
  const r = sliceRow(h.n); if (S.tab !== 'tree') setTab('tree'); locate(r, sliceAncestors(h.n));
});
ovC.addEventListener('dblclick', e => {
  if (S.scanning) return; S.hover = hitAt(e); const h = hoverNode(); if (!h) return;
  const target = h.n.isDir ? h.n : h.n.parent; if (target) zoomInto(target);
});
ovC.addEventListener('contextmenu', e => {
  if (S.scanning) return; S.hover = hitAt(e); const h = hoverNode(); if (!h) return;
  e.preventDefault(); const r = sliceRow(h.n); select(r); nodeMenu(r, e.clientX, e.clientY);
});
function sliceAncestors(n: SliceNode) {
  const ids: number[] = S.chain.map(r => r.id);
  const rel: number[] = []; for (let x = n.parent; x && x.parent; x = x.parent) rel.push(x.id);
  for (const p of rel.reverse()) { sliceRow(S.slice!.byId.get(p)!); ids.push(p); }
  return ids;
}

// ---------- Ampliar y reducir con transición ----------
function showSnap() {
  snap.width = mapC.width; snap.height = mapC.height; snap.getContext('2d')!.drawImage(mapC, 0, 0);
  snap.style.transition = 'none'; snap.style.transform = 'none'; snap.style.opacity = '1'; snap.hidden = false; snap.getBoundingClientRect();
}
function hideSnap() { snap.hidden = true; snap.style.transition = 'none'; snap.style.transform = 'none'; snap.style.opacity = '1'; }
const EASE = 'cubic-bezier(.2,.7,.2,1)';
function zoomInto(n: SliceNode) {
  if (!n.isDir) return; const z = zoomRow(); if (!z || n.id === z.id) return;
  const chain = [...S.chain]; const rel: SliceNode[] = []; for (let x: SliceNode | null = n; x && x.parent; x = x.parent) rel.push(x);
  for (const x of rel.reverse()) chain.push(sliceRow(x));
  setZoom(chain, S.L?.rects.get(n.id) || null);
}
export async function setZoom(chain: NodeRow[], fromRect: [number, number, number, number] | null = null) {
  const old = zoomRow(), next = chain[chain.length - 1]; if (!next || (old && next.id === old.id)) return;
  const outward = !!old && chain.length < S.chain.length && S.chain[chain.length - 1]?.id === next.id;
  S.chain = chain; S.hover = null; tip.hidden = true; S.slice = null;
  pathOf(next.id).then(updateCrumbs); updateCrumbs(); loadComposition(); if (S.tab === 'files' && !S.query) loadFiles();
  renderInspector(); renderStatus();
  const anim = !!M && !REDUCED;
  if (anim && fromRect) {
    const d = M!.dpr, rx = fromRect[0] / d, ry = fromRect[1] / d, sx = M!.cw / (fromRect[2] / d), sy = M!.ch / (fromRect[3] / d);
    showSnap(); snap.style.transition = `transform 260ms ${EASE}`; snap.style.transform = `translate(${-rx * sx}px,${-ry * sy}px) scale(${sx},${sy})`;
    await Promise.all([sleep(270), loadSlice(true)]);
    snap.style.transition = 'opacity 140ms'; snap.style.opacity = '0'; setTimeout(hideSnap, 150);
  } else if (anim && outward && old) {
    showSnap(); await loadSlice(true); const r = S.L?.rects.get(old.id);
    if (!r) { hideSnap(); return; }
    const d = M!.dpr; snap.style.transition = `transform 260ms ${EASE}, opacity 260ms ease-in`;
    snap.style.transform = `translate(${r[0] / d}px,${r[1] / d}px) scale(${r[2] / d / M!.cw},${r[3] / d / M!.ch})`; snap.style.opacity = '0';
    setTimeout(hideSnap, 280);
  } else await loadSlice(true);
}
async function zoomToRow(r: NodeRow) {
  const target = r.isDir ? r : await rowOf(r.parentId);
  const chain: NodeRow[] = []; for (let x: NodeRow | null = target; x; x = x.parentId >= 0 ? await rowOf(x.parentId) : null) chain.unshift(x);
  const fromRect = S.L?.rects.get(target.id) || null;
  await setZoom(chain, fromRect);
}
function updateCrumbs() {
  const el = $('crumbs');
  el.innerHTML = S.chain.map((n, i) => `${i ? '<span class="sep">›</span>' : ''}<button class="crumb${i === S.chain.length - 1 ? ' cur' : ''}" type="button" data-i="${i}">${esc(nameOf(n))}</button>`).join('')
    + (zoomRow() ? `<span class="crumb-size">${fmtB(zoomRow()!.size)}</span>` : '');
  el.scrollLeft = el.scrollWidth; ($('upBtn') as HTMLButtonElement).disabled = S.chain.length < 2;
}
$('crumbs').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('.crumb') as HTMLElement; if (b) setZoom(S.chain.slice(0, +b.dataset.i! + 1)); });
$('upBtn').addEventListener('click', () => { if (S.chain.length > 1) setZoom(S.chain.slice(0, -1)); });

// ---------- Composición (categorías, extensiones o antigüedad) ----------
async function loadComposition() {
  const z = zoomRow(); if (!z) return;
  S.ext = await B.extStats(z.id); if (zoomRow() === z) renderComposition();
}
function compRow(key: string, name: string, sub: string, color: RGB, size: number, total: number, max: number, count: number, on: boolean, extra = '') {
  return `<button class="ext${on ? ' on' : ''}" type="button" data-k="${esc(key)}" aria-pressed="${on}" title="${tx('comp.files', { count })}">`
    + `<i class="sw" style="background:${rgb(color)}"></i><span class="ext-n"><b>${esc(name)}</b><span>${esc(sub)}</span></span>`
    + `<span class="num ext-p">${fmtP(size / total)}</span><span class="num">${fmtB(size)}</span>`
    + `<span class="ext-bar"><b style="width:${(size / (max || 1) * 100).toFixed(1)}%;background:${rgb(color)}"></b></span></button>${extra}`;
}
export function renderComposition() {
  const z = zoomRow(); if (!z) { $('extList').innerHTML = ''; return; }
  const total = z.size || 1, list = $('extList'); $('extScope').textContent = t('comp.scope', { name: nameOf(z) });
  const extName = (e: ExtStat) => e.ext ? '.' + e.ext : t('comp.noExtLong');
  if (S.color === 'category') {
    $('compTitle').textContent = t('comp.title.category');
    const groups = new Map<string, { size: number; count: number; exts: ExtStat[] }>();
    for (const e of S.ext) { const c = categoryOf(e.ext); let g = groups.get(c.id); if (!g) groups.set(c.id, g = { size: 0, count: 0, exts: [] }); g.size += e.size; g.count += e.count; g.exts.push(e); }
    const gs = [...groups.entries()].sort((a, b) => b[1].size - a[1].size), max = gs[0]?.[1].size || 1;
    list.innerHTML = gs.map(([id, g]) => {
      const c = categoryById(id), on = S.hl?.type === 'cat' && S.hl.id === id;
      const sub = g.exts.slice(0, 3).map(e => e.ext ? '.' + e.ext : t('comp.noExt')).join(' ');
      const open = S.compOpen === id ? `<div class="comp-sub">${g.exts.slice(0, 8).map(e => compRow('e:' + e.ext, extName(e), t('comp.files', { count: e.count }), c.color, e.size, total, g.size, e.count, S.hl?.type === 'ext' && S.hl.ext === e.ext)).join('')}</div>` : '';
      return compRow('c:' + id, catName(c), sub, c.color, g.size, total, max, g.count, on, open);
    }).join('');
  } else if (S.color === 'ext') {
    $('compTitle').textContent = t('comp.title.ext');
    const top = S.ext.slice(0, 18), max = top[0]?.size || 1, rest = S.ext.slice(18);
    list.innerHTML = top.map(e => compRow('e:' + e.ext, extName(e), catName(categoryOf(e.ext)), extColor(e.ext), e.size, total, max, e.count, S.hl?.type === 'ext' && S.hl.ext === e.ext)).join('')
      + (rest.length ? `<div class="ext-more">${tx('comp.moreExts', { count: rest.length, bytes: fmtB(rest.reduce((s, e) => s + e.size, 0)) })}</div>` : '');
  } else {
    $('compTitle').textContent = t('comp.title.age');
    const bins = AGE_BINS.map(() => ({ size: 0, count: 0 })), now = Date.now() / 1000;
    for (const t of S.L?.tiles || []) if (!t.rest && !t.n.isDir) { const b = bins[ageBin(t.n.mtime, now)]; b.size += t.n.size; b.count++; }
    const max = Math.max(...bins.map(b => b.size), 1), sum = bins.reduce((s, b) => s + b.size, 0) || 1;
    list.innerHTML = bins.map((b, i) => compRow('a:' + i, ageName(i), t('comp.byModified'), ageColor(i), b.size, sum, max, b.count, S.hl?.type === 'age' && S.hl.bin === i)).join('')
      + `<div class="legend-note">${tx('comp.ageNote')}</div>`;
  }
}
$('extList').addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('.ext') as HTMLElement; if (!b) return;
  const k = b.dataset.k!, kind = k[0], v = k.slice(2);
  if (kind === 'c') {
    const same = S.hl?.type === 'cat' && S.hl.id === v;
    S.compOpen = same ? null : v; setHL(same ? null : { type: 'cat', id: v });
  } else if (kind === 'e') {
    const same = S.hl?.type === 'ext' && S.hl.ext === v; setHL(same ? null : { type: 'ext', ext: v });
  } else { const bin = +v, same = S.hl?.type === 'age' && S.hl.bin === bin; setHL(same ? null : { type: 'age', bin }); }
});
function hlText(h: HL) {
  if (h.type === 'search') return t('map.results', { count: h.count });
  const label = h.type === 'cat' ? catName(categoryById(h.id)) : h.type === 'ext' ? (h.ext ? '.' + h.ext : t('hl.noExtension')) : ageName(h.bin);
  return t('map.highlight', { label });
}
export function setHL(h: HL | null) {
  const dropSearch = S.hl?.type === 'search' && (!h || h.type !== 'search');
  if (dropSearch) { ($('q') as HTMLInputElement).value = ''; S.query = ''; }
  S.hl = h; $('hlChip').hidden = !h;
  if (dropSearch && S.tab === 'files') loadFiles();
  if (h) $('hlTxt').textContent = hlText(h);
  renderMap(); renderComposition();
}
$('hlClear').addEventListener('click', () => { setHL(null); if (S.tab === 'files') loadFiles(); });
function setColorMode(m: ColorMode) {
  S.color = m; for (const b of $('colorSeg').querySelectorAll('button')) b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.color === m));
  if (S.hl && S.hl.type !== 'search') S.hl = null, $('hlChip').hidden = true;
  renderMap(); renderComposition(); treeVL.paint(); filesVL.paint();
}
$('colorSeg').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button') as HTMLElement; if (b) setColorMode(b.dataset.color as ColorMode); });
$('styleSeg').addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button') as HTMLElement; if (!b) return; S.style = b.dataset.style as 'mosaic' | 'relief';
  for (const x of $('styleSeg').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b)); renderMap();
});
$('labelsBtn').addEventListener('click', e => { S.labels = !S.labels; (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(S.labels)); renderMap(); });

// ---------- Árbol de carpetas (filas pedidas al motor por páginas) ----------
const treeBody = $('treeBody');
const FOLDER = '<svg class="fold" viewBox="0 0 16 16"><path d="M1.5 3.5h4.2l1.5 1.5h7.3v8h-13z"/></svg>';
function parentSize(r: NodeRow) { const p = S.rowCache.get(r.parentId); return p ? p.size : r.size; }
// Sangría adaptativa: los niveles profundos ceden menos espacio para que el nombre siga legible
const indent = (d: number) => d <= 4 ? d * 14 : 56 + (d - 4) * 7;
// Recorte por el medio: conserva el final y la extensión ("VT_Did…mo.cok", "C:\Program…\Game")
const fitCtx = document.createElement('canvas').getContext('2d')!;
function middleFit(s: string, max: number, keepExt: boolean) {
  const dot = s.lastIndexOf('.'), tail = keepExt && dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
  const base = tail ? s.slice(0, -tail.length) : s, headShare = keepExt ? .6 : .4;
  const make = (k: number) => { const h = Math.ceil(k * headShare); return base.slice(0, h) + '…' + base.slice(base.length - (k - h)) + tail; };
  let lo = 0, hi = base.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fitCtx.measureText(make(mid)).width <= max) lo = mid; else hi = mid - 1; }
  return make(lo);
}
function fitTexts(layer: HTMLElement) {
  let font = '';
  for (const el of layer.querySelectorAll<HTMLElement>('[data-fit]')) {
    const full = el.dataset.full ?? (el.dataset.full = el.textContent || '');
    if (el.textContent !== full) el.textContent = full;
    const avail = el.clientWidth; if (!avail || el.scrollWidth <= avail + 1) continue;
    const f = getComputedStyle(el).font; if (f !== font) { fitCtx.font = font = f; }
    const fit = middleFit(full, avail - 2, el.dataset.fit === 'name');
    // Con menos de 4 caracteres visibles el recorte central no aporta: se deja el recorte normal del CSS
    if (fit.replace(/[….]/g, '').length >= 4) el.textContent = fit;
  }
}
function rowHTML(i: number) {
  const tr = S.rows[i];
  if (tr.more) return `<div class="row more-row" role="row" data-i="${i}"><span class="c-name" style="--ind:${indent(tr.depth)}px"><span class="tw none"></span>${tx('tree.more', { count: Math.min(PAGE, tr.remaining), remaining: tr.remaining })}</span></div>`;
  const r = tr.row!, ps = parentSize(r), pct = ps > 0 ? r.size / ps : 0, open = r.isDir && S.expanded.has(r.id), sel = S.sel?.id === r.id;
  const cls = 'row' + (sel ? ' sel' : '') + (r.isDir ? ' dir' : '') + (r.flags & FLAG.HIDDEN ? ' hid' : '') + (r.flags & FLAG.HARDLINK ? ' hl' : '');
  const tw = r.isDir && r.childCount ? `<span class="tw${open ? ' open' : ''}" data-tw="1"></span>` : '<span class="tw none"></span>';
  const icon = r.isDir ? FOLDER : `<i class="sw" style="background:${rgb(rowColor(r))}"></i>`;
  const items = r.isDir ? fmtN(r.files + r.dirs) : '', ind = indent(tr.depth);
  return `<div class="${cls}" role="row" data-i="${i}" aria-level="${tr.depth + 1}"${r.isDir ? ` aria-expanded="${open}"` : ''} aria-selected="${sel}">`
    + (tr.depth ? `<span class="share" style="left:${10 + ind}px;width:calc((100% - ${18 + ind}px) * ${pct.toFixed(4)})"></span>` : '')
    + `<span class="c-name" style="--ind:${ind}px">${tw}${icon}<span class="nm" data-fit="name" title="${esc(r.name)}">${esc(nameOf(r))}</span></span>`
    + `<span class="c-size num">${fmtB(r.size)}</span><span class="c-pct num">${tr.depth ? fmtP(pct) : ''}</span><span class="c-alloc num">${fmtB(r.alloc)}</span>`
    + `<span class="c-items num">${items}</span><span class="c-mod num">${fmtD(r.mtime)}</span></div>`;
}
const treeVL = new VList(treeBody, 26, rowHTML, fitTexts);
async function ensureKids(id: number, more = false) {
  const have = S.kids.get(id);
  if (have && !more) return have;
  const res = await B.children({ id, offset: have ? have.rows.length : 0, limit: PAGE, sort: S.sort.key, desc: S.sort.desc });
  res.rows.forEach(remember);
  const merged = { rows: have ? have.rows.concat(res.rows) : res.rows, total: res.total }; S.kids.set(id, merged); return merged;
}
export async function rebuildTree() {
  if (!S.root) { S.rows = []; treeVL.setCount(0); return; }
  const rows: TRow[] = [];
  const walk = async (r: NodeRow, depth: number) => {
    rows.push({ row: r, depth });
    if (r.isDir && S.expanded.has(r.id)) {
      const k = await ensureKids(r.id);
      for (const c of k.rows) await walk(c, depth + 1);
      if (k.total > k.rows.length) rows.push({ more: r.id, remaining: k.total - k.rows.length, depth: depth + 1 });
    }
  };
  await walk(S.root, 0); S.rows = rows; treeVL.setCount(rows.length);
}
const rowIndex = (id: number) => S.rows.findIndex(t => t.row?.id === id);
async function toggle(r: NodeRow, force?: boolean) {
  const open = force ?? !S.expanded.has(r.id);
  if (open) S.expanded.add(r.id); else S.expanded.delete(r.id);
  await rebuildTree();
}
/** Expande los antepasados, carga las páginas necesarias y deja la fila a la vista y seleccionada. */
async function locate(r: NodeRow, ancestors?: number[]) {
  if (!ancestors) { ancestors = []; for (let p = r.parentId; p >= 0; p = (await rowOf(p)).parentId) ancestors.unshift(p); }
  for (const a of ancestors) S.expanded.add(a);
  await rebuildTree();
  for (let tries = 0; rowIndex(r.id) < 0 && tries < 20; tries++) {
    const par = S.kids.get(r.parentId); if (!par || par.total <= par.rows.length) break;
    await ensureKids(r.parentId, true); await rebuildTree();
  }
  select(r); treeVL.scrollTo(rowIndex(r.id));
}
function updateSortHead() {
  for (const b of $('treeHead').querySelectorAll('[data-sort]')) {
    const on = (b as HTMLElement).dataset.sort === S.sort.key; b.classList.toggle('on', on); b.classList.toggle('asc', on && !S.sort.desc);
  }
}
$('treeHead').addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('[data-sort]') as HTMLElement; if (!b) return; const k = b.dataset.sort as SortKey;
  S.sort = S.sort.key === k ? { key: k, desc: !S.sort.desc } : { key: k, desc: k !== 'name' };
  updateSortHead(); S.kids.clear(); rebuildTree();
});
const rowAt = (e: Event) => { const el = (e.target as HTMLElement).closest('.row') as HTMLElement; return el ? S.rows[+el.dataset.i!] : null; };
treeBody.addEventListener('click', async e => {
  const t = rowAt(e); if (!t) return;
  if (t.more) { await ensureKids(t.more, true); await rebuildTree(); return; }
  if ((e.target as HTMLElement).closest('[data-tw]')) { toggle(t.row!); return; }
  select(t.row!);
});
treeBody.addEventListener('dblclick', e => { const t = rowAt(e); if (!t?.row || (e.target as HTMLElement).closest('[data-tw]')) return; if (t.row.isDir) toggle(t.row, true); zoomToRow(t.row); });
treeBody.addEventListener('contextmenu', e => { const t = rowAt(e); if (!t?.row) return; e.preventDefault(); select(t.row); nodeMenu(t.row, (e as MouseEvent).clientX, (e as MouseEvent).clientY); });
treeBody.addEventListener('keydown', async e => {
  const i = Math.max(0, S.rows.findIndex(t => t.row && t.row.id === S.sel?.id)), r = S.rows[i]?.row; if (!r) return;
  const move = (j: number) => { const t = S.rows[j]; if (t?.row) { select(t.row); treeVL.scrollTo(j); } };
  switch (e.key) {
    case 'ArrowDown': move(Math.min(S.rows.length - 1, i + 1)); break;
    case 'ArrowUp': move(Math.max(0, i - 1)); break;
    case 'ArrowRight': if (r.isDir) { if (!S.expanded.has(r.id)) await toggle(r, true); else move(i + 1); } break;
    case 'ArrowLeft': if (r.isDir && S.expanded.has(r.id) && r.parentId >= 0) await toggle(r, false); else if (r.parentId >= 0) move(rowIndex(r.parentId)); break;
    case 'Enter': zoomToRow(r); break;
    default: return;
  }
  e.preventDefault();
});

// ---------- Selección y panel de detalle ----------
export function select(r: NodeRow) {
  S.sel = remember(r); S.confirmTrash = false;
  treeVL.paint(); filesVL.paint(); renderInspector(); drawOverlay(); renderStatus();
  pathOf(r.id).then(() => { if (S.sel?.id === r.id) renderInspector(); }).catch(() => { });
}
function attrs(f: number) {
  const a = ([f & FLAG.HIDDEN && 'attr.hidden', f & FLAG.SYSTEM && 'attr.system', f & FLAG.COMPRESSED && 'attr.compressed', f & FLAG.SPARSE && 'attr.sparse',
    f & FLAG.HARDLINK && 'attr.hardlink', f & FLAG.REPARSE && 'attr.reparse', f & FLAG.CLOUD && 'attr.cloud'].filter(Boolean) as MessageKey[]).map(k => t(k));
  return a.length ? a.join(' · ') : t('attr.normal');
}
const ICON_COPY = '<svg class="i" viewBox="0 0 16 16"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>';
export function renderInspector() {
  const el = $('insp'), r = S.sel || zoomRow();
  if (!r) { el.innerHTML = `<p class="note">${tx('insp.empty')}</p>`; return; }
  const ps = parentSize(r), path = S.pathCache.get(r.id), c = r.isDir ? null : categoryOf(r.ext);
  const kind = r.isDir ? t(r.parentId < 0 ? 'insp.kind.root' : 'insp.kind.folder') : catName(c!) + (r.ext ? ' · .' + r.ext : '');
  const canZoom = r.id !== zoomRow()?.id;
  const acts = S.confirmTrash
    ? `<div class="confirm"><p>${tx('insp.confirmTrash', { name: r.name, size: fmtB(r.size) })}</p><div><button class="btn sm" type="button" data-act="cancel">${tx('insp.cancel')}</button><button class="btn sm danger solid" type="button" data-act="trash-ok">${tx('insp.trashConfirm')}</button></div></div>`
    : `<div class="actions"><button class="btn sm" type="button" data-act="reveal">${tx('insp.reveal')}</button><button class="btn sm" type="button" data-act="zoom"${canZoom ? '' : ' disabled'}>${tx('insp.zoom')}</button><button class="btn sm danger" type="button" data-act="trash"${r.parentId >= 0 ? '' : ' disabled'}>${tx('insp.trash')}</button></div>`;
  el.innerHTML = `<div class="insp-top"><span class="sw lg" style="background:${rgb(rowColor(r))}"></span><div class="insp-id"><div class="insp-kind">${esc(kind)}</div><h2 class="insp-name" title="${esc(r.name)}">${esc(nameOf(r))}</h2></div></div>`
    + `<div class="insp-size"><span class="big">${fmtB(r.size)}</span><span class="sub">${S.root ? tx('insp.ofScanned', { value: fmtP(r.size / (S.root.size || 1)) }) : ''}</span></div>`
    + `<div class="insp-path"><code>${path ? esc(path).replace(/\\/g, '\\<wbr>') : '…'}</code><button class="icon-btn sm" type="button" data-act="copy" title="${tx('insp.copyPath')}">${ICON_COPY}</button></div>`
    + `<dl class="kv"><div><dt title="${tx('insp.onDisk.title')}">${tx('insp.onDisk')}</dt><dd>${fmtB(r.alloc)}</dd></div>`
    + `<div><dt>${tx('insp.ofFolder')}</dt><dd>${r.parentId >= 0 ? fmtP(r.size / (ps || 1)) : '—'}</dd></div>`
    + (r.isDir ? `<div><dt>${tx('insp.files')}</dt><dd>${fmtN(r.files)}</dd></div><div><dt>${tx('insp.folders')}</dt><dd>${fmtN(r.dirs)}</dd></div>`
      : `<div><dt>${tx('insp.attributes')}</dt><dd>${esc(attrs(r.flags))}</dd></div><div><dt>${tx('insp.age')}</dt><dd>${esc(ageText(r.mtime))}</dd></div>`)
    + `<div><dt>${tx('insp.modified')}</dt><dd>${fmtD(r.mtime)}</dd></div></dl>`
    + (r.flags & FLAG.HARDLINK ? `<p class="note">${tx('insp.note.hardlink')}</p>` : '')
    + (r.flags & FLAG.CLOUD ? `<p class="note">${tx('insp.note.cloud')}</p>` : '')
    + acts;
}
async function doAction(kind: ActionKind, r: NodeRow) {
  try {
    const res = await B.action(kind, r.id);
    toast(res.code ? msgText(res) : res.message || t(res.ok ? 'toast.done' : 'toast.actionFailed'));
    if (kind === 'trash' && res.ok) await refreshAfterChange(r);
  } catch (e) { toast(t('toast.error', { error: msgText(e) })); }
}
async function refreshAfterChange(r: NodeRow) {
  S.kids.clear(); S.rowCache.clear(); S.pathCache.clear(); S.clean = null;
  S.root = remember(await B.nodeInfo(S.root!.id));
  const chain: NodeRow[] = []; for (const z of S.chain) { try { chain.push(remember(await B.nodeInfo(z.id))); } catch { break; } }
  S.chain = chain.length ? chain : [S.root];
  S.sel = S.chain[S.chain.length - 1]; if (r.parentId >= 0) S.sel = await rowOf(r.parentId).catch(() => S.sel!);
  updateCrumbs(); await rebuildTree(); await loadSlice(true); loadComposition(); renderInspector(); renderStatus();
}
$('insp').addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('[data-act]') as HTMLElement; if (!b) return; const r = S.sel || zoomRow(); if (!r) return;
  switch (b.dataset.act) {
    case 'copy': pathOf(r.id).then(p => copyText(p, 'toast.pathCopied')); break;
    case 'reveal': doAction('reveal', r); break;
    case 'zoom': zoomToRow(r); break;
    case 'trash': S.confirmTrash = true; renderInspector(); ($('insp').querySelector('[data-act="trash-ok"]') as HTMLElement).focus(); break;
    case 'cancel': S.confirmTrash = false; renderInspector(); break;
    case 'trash-ok': S.confirmTrash = false; renderInspector(); doAction('trash', r); break;
  }
});

// ---------- Archivos más grandes y resultados del filtro ----------
const filesBody = $('filesBody');
const parentPath = (p: string) => { const i = p.lastIndexOf('\\'); return i > 2 ? p.slice(0, i) : p.slice(0, 3); };
function fileRowHTML(i: number) {
  const r = S.files[i], sel = S.sel?.id === r.id, icon = r.isDir ? FOLDER : `<i class="sw" style="background:${rgb(rowColor(r))}"></i>`;
  return `<div class="row${sel ? ' sel' : ''}" role="row" data-i="${i}"><span class="c-name">${icon}<span class="nm" data-fit="name" title="${esc(r.name)}">${esc(r.name)}</span></span>`
    + `<span class="c-path" data-fit="path" title="${esc(r.path)}">${esc(parentPath(r.path))}</span><span class="c-size num">${fmtB(r.size)}</span><span class="c-mod num">${fmtD(r.mtime)}</span></div>`;
}
const filesVL = new VList(filesBody, 26, fileRowHTML, fitTexts);
async function loadFiles() {
  const z = zoomRow(); if (!z || !S.root) return;
  const searching = !!S.query, root = searching ? S.root.id : z.id;
  const res = await B.search({ query: S.query, root, limit: 2000 });
  if (res.error) { $('filesMeta').innerHTML = html('files.invalidFilter', { error: msgText(res.error) }); S.files = []; filesVL.setCount(0); return; }
  for (const r of res.rows) { remember(r); S.pathCache.set(r.id, r.path); }
  S.files = res.rows; S.filesTotal = res.total; S.filesBytes = res.totalBytes;
  $('filesMeta').innerHTML = (searching ? html('files.matches', { count: res.total, query: S.query, bytes: fmtB(res.totalBytes) })
    : html('files.largest', { folder: nameOf(z), count: res.total, bytes: fmtB(res.totalBytes) }))
    + (res.total > res.rows.length ? ' · ' + tx('files.shown', { count: res.rows.length }) : '');
  $('filesCount').textContent = searching ? fmtN(res.total) : '';
  filesVL.setCount(S.files.length);
}
filesBody.addEventListener('click', e => { const el = (e.target as HTMLElement).closest('.row') as HTMLElement; if (el) select(S.files[+el.dataset.i!]); });
filesBody.addEventListener('dblclick', e => { const el = (e.target as HTMLElement).closest('.row') as HTMLElement; if (!el) return; const r = S.files[+el.dataset.i!]; setTab('tree'); locate(r); });
filesBody.addEventListener('contextmenu', e => { const el = (e.target as HTMLElement).closest('.row') as HTMLElement; if (!el) return; e.preventDefault(); const r = S.files[+el.dataset.i!]; select(r); nodeMenu(r, (e as MouseEvent).clientX, (e as MouseEvent).clientY); });
let qT = 0; const q = $('q') as HTMLInputElement;
async function runQuery() {
  S.query = q.value.trim();
  if (!S.query) { if (S.hl?.type === 'search') setHL(null); if (S.tab === 'files') loadFiles(); return; }
  setTab('files'); await loadFiles();
  if (S.query) setHL({ type: 'search', ids: new Set(S.files.map(r => r.id)), query: S.query, count: S.filesTotal });
}
q.addEventListener('input', () => { clearTimeout(qT); qT = window.setTimeout(runQuery, 220); });
const qHelp = $('qHelp'), qHelpBtn = $('qHelpBtn');
qHelpBtn.addEventListener('click', e => { e.preventDefault(); qHelp.hidden = !qHelp.hidden; qHelpBtn.setAttribute('aria-expanded', String(!qHelp.hidden)); });
qHelp.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('[data-q]') as HTMLElement; if (!b) return; q.value = b.dataset.q!; qHelp.hidden = true; runQuery(); });

// ---------- Liberar espacio: reglas explicadas ejecutadas como filtros ----------
// Cada regla tiene un id: sus textos son clean.<id>.title, clean.<id>.why y, si `how`, clean.<id>.how.
// `title` sólo cuando el título depende del elemento (el nombre del juego, el archivo de sistema).
interface Rule {
  id: string; q: string; risk: Risk; title?: (name: string) => string; cmd?: string; how?: boolean;
  ok?: (r: SearchRow) => boolean; verify?: (r: SearchRow) => Promise<boolean>; group?: boolean; min?: number;
}
// Carpetas que pertenecen a programas instalados: sus dependencias no se regeneran solas
const INSTALLED = /\\(Program Files( \(x86\))?|AppData|ProgramData|\.cache|\.vscode[^\\]*|\.cursor|Windows)\\|\\resources\\app\\|\\extensions\\/i;
const hasChild = async (r: SearchRow, names: string[]) => {
  const res = await B.children({ id: r.id, offset: 0, limit: 200, sort: 'name', desc: false });
  return res.rows.some(c => names.includes(c.name.toLowerCase()));
};
const RULES: Rule[] = [
  { id: 'rustTarget', q: 'type:dir name:target', risk: 'ok', cmd: 'cargo clean',
    ok: r => r.name.toLowerCase() === 'target' && !INSTALLED.test(r.path), verify: r => hasChild(r, ['cachedir.tag', '.rustc_info.json']), min: 50 * MB },
  { id: 'nodeModules', q: 'type:dir name:node_modules', risk: 'ok', cmd: 'bun install',
    ok: r => r.name === 'node_modules' && (r.path.match(/\\node_modules(?=\\|$)/gi) || []).length === 1 && !INSTALLED.test(r.path), min: 20 * MB },
  { id: 'venv', q: 'type:dir name:.venv', risk: 'ok', cmd: 'uv sync', ok: r => r.name === '.venv' && !INSTALLED.test(r.path), min: 20 * MB },
  { id: 'temp', q: 'type:dir name:Temp', risk: 'ok', how: true, ok: r => /\\AppData\\Local\\Temp$|^[A-Z]:\\Windows\\Temp$/i.test(r.path), min: 50 * MB },
  { id: 'windowsUpdate', q: 'type:dir name:SoftwareDistribution', risk: 'ok', how: true, ok: r => /^[A-Z]:\\Windows\\SoftwareDistribution$/i.test(r.path), min: 100 * MB },
  { id: 'windowsOld', q: 'type:dir name:Windows.old', risk: 'ok', how: true, ok: r => /^[A-Z]:\\Windows\.old$/i.test(r.path) },
  { id: 'recycleBin', q: 'type:dir name:$Recycle.Bin', risk: 'ok', how: true, ok: r => /^[A-Z]:\\\$Recycle\.Bin$/i.test(r.path), min: 10 * MB },
  { id: 'aiModels', q: 'ext:gguf,safetensors,ckpt,onnx', risk: 'warn', group: true, min: 500 * MB },
  { id: 'virtualDisks', q: 'ext:vhdx,vhd', risk: 'warn', cmd: 'wsl --manage <distro> --set-sparse true', min: 500 * MB },
  { id: 'game', q: 'type:dir path:steamapps', risk: 'warn', title: name => t('clean.game.title', { name }), ok: r => /\\steamapps\\common\\[^\\]+$/i.test(r.path), min: 1 * GB },
  { id: 'downloads', q: 'path:Downloads ext:msi,exe,iso,zip,7z size:>100m', risk: 'warn', group: true, min: 200 * MB },
  { id: 'restorePoints', q: 'type:dir name:"System Volume Information"', risk: 'warn', cmd: 'vssadmin list shadowstorage', ok: r => /^[A-Z]:\\System Volume Information$/i.test(r.path), min: 100 * MB },
  { id: 'systemFile', q: 'pagefile.sys OR hiberfil.sys OR swapfile.sys', risk: 'bad', ok: r => /^[A-Z]:\\[^\\]+\.sys$/i.test(r.path),
    title: name => t(name.toLowerCase() === 'hiberfil.sys' ? 'clean.hiberfil.title' : name.toLowerCase() === 'swapfile.sys' ? 'clean.swapfile.title' : 'clean.pagefile.title') },
  { id: 'winsxs', q: 'type:dir name:WinSxS', risk: 'bad', cmd: 'DISM /Online /Cleanup-Image /StartComponentCleanup', ok: r => /^[A-Z]:\\Windows\\WinSxS$/i.test(r.path) },
  { id: 'installer', q: 'type:dir name:Installer', risk: 'bad', ok: r => /^[A-Z]:\\Windows\\Installer$/i.test(r.path) },
];
const riskName = (r: Risk) => tk('clean.risk.' + r);
const cardTitle = (c: CleanCard) => c.rule.title ? c.rule.title(c.name) : tk(`clean.${c.rule.id}.title`);
async function loadClean() {
  if (!S.root) return;
  const cards: CleanCard[] = [];
  for (const rule of RULES) {
    const res = await B.search({ query: rule.q, root: S.root.id, limit: 200 }).catch(() => null); if (!res || res.error) continue;
    let rows = res.rows.filter(r => (!rule.ok || rule.ok(r)) && (!rule.min || rule.group || r.size >= rule.min));
    if (rule.verify) { const keep: SearchRow[] = []; for (const r of rows.slice(0, 40)) if (await rule.verify(r).catch(() => false)) keep.push(r); rows = keep; }
    if (rule.group) {
      const by = new Map<string, SearchRow[]>(); for (const r of rows) { const k = parentPath(r.path); by.set(k, [...(by.get(k) || []), r]); }
      for (const [, list] of by) {
        const size = list.reduce((s, r) => s + r.size, 0); if (rule.min && size < rule.min) continue;
        const parent = await rowOf(list[0].parentId).catch(() => null); if (!parent) continue;
        const path = await pathOf(parent.id).catch(() => parentPath(list[0].path));
        cards.push({ row: { ...parent, size }, path, rule, name: list[0].name, count: list.length });
      }
    } else for (const r of rows) cards.push({ row: r, path: r.path, rule, name: r.name });
  }
  const order = { ok: 0, warn: 1, bad: 2 }; cards.sort((a, b) => order[a.rule.risk] - order[b.rule.risk] || b.row.size - a.row.size);
  S.clean = cards; $('cleanCount').textContent = String(cards.length);
}
async function renderClean() {
  const el = $('cleanBody');
  if (!S.root) { el.innerHTML = `<div class="cl-loading">${tx('clean.noScan')}</div>`; return; }
  if (!S.clean) { el.innerHTML = `<div class="cl-loading">${tx('clean.searching')}</div>`; await loadClean(); }
  const L = S.clean!, sum = (k: Risk) => L.filter(c => c.rule.risk === k).reduce((s, c) => s + c.row.size, 0);
  el.innerHTML = `<div class="clean-sum">`
    + (['ok', 'warn', 'bad'] as Risk[]).map(k => `<div><span class="risk ${k}">${esc(riskName(k))}</span><b>${fmtB(sum(k))}</b><small>${esc(tk('clean.sum.' + k))}</small></div>`).join('')
    + `</div>`
    + (L.length ? '' : `<div class="cl-loading">${tx('clean.none')}</div>`)
    + L.map((c, i) => `<article class="cl"><div><h3>${esc(cardTitle(c))}</h3><code class="cl-path">${esc(c.path)}</code><p>${esc(tk(`clean.${c.rule.id}.why`))}${c.count ? ' ' + tx('clean.fileCount', { count: c.count }) : ''}</p>`
      + (c.rule.cmd ? `<div class="cmd"><code>${esc(c.rule.cmd)}</code><button class="icon-btn sm" type="button" data-copy="${i}" title="${tx('clean.copyCommand')}">${ICON_COPY}</button></div>` : '')
      + (c.rule.how ? `<p class="how">${esc(tk(`clean.${c.rule.id}.how`))}</p>` : '')
      + `</div><div class="cl-side"><span class="cl-size">${fmtB(c.row.size)}</span><span class="risk ${c.rule.risk}">${esc(riskName(c.rule.risk))}</span><button class="btn sm" type="button" data-loc="${i}">${tx('clean.locate')}</button></div></article>`).join('');
}
$('cleanBody').addEventListener('click', async e => {
  const t = e.target as HTMLElement, cp = t.closest('[data-copy]') as HTMLElement;
  if (cp) { copyText(S.clean![+cp.dataset.copy!].rule.cmd!, 'toast.commandCopied'); return; }
  const lb = t.closest('[data-loc]') as HTMLElement; if (!lb) return;
  const r = S.clean![+lb.dataset.loc!].row; setTab('tree'); await locate(r); zoomToRow(r);
});

// ---------- Pestañas ----------
export function setTab(t: string) {
  S.tab = t;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === t));
  for (const v of ['tree', 'files', 'clean']) $('view-' + v).hidden = v !== t;
  if (t === 'tree') treeVL.paint();
  if (t === 'files') loadFiles();
  if (t === 'clean') renderClean();
}
document.querySelector('.tabs')!.addEventListener('click', e => { const b = (e.target as HTMLElement).closest('.tab') as HTMLElement; if (b) setTab(b.dataset.tab!); });

// ---------- Menús, unidades, tema y guía ----------
const menu = $('menu');
function openMenu(html: string, x: number, y: number, kind: string, id = -1) {
  menu.innerHTML = html; menu.dataset.kind = kind; menu.dataset.id = String(id); menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px'; menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  (menu.querySelector('input, button') as HTMLElement)?.focus({ preventScroll: true });
}
function nodeMenu(r: NodeRow, x: number, y: number) {
  openMenu(`<div class="menu-h">${esc(S.pathCache.get(r.id) || r.name)}</div>`
    + `<button type="button" role="menuitem" data-m="open">${tx(r.isDir ? 'menu.openFolder' : 'menu.open')}</button>`
    + `<button type="button" role="menuitem" data-m="reveal">${tx('menu.reveal')}</button>`
    + `<button type="button" role="menuitem" data-m="copy">${tx('menu.copyPath')}</button>`
    + `<button type="button" role="menuitem" data-m="zoom">${tx('menu.zoom')}</button>`
    + `<button type="button" role="menuitem" data-m="tree">${tx('menu.locate')}</button><hr>`
    + `<button type="button" role="menuitem" data-m="properties">${tx('menu.properties')}</button>`
    + `<button type="button" role="menuitem" data-m="trash" class="danger">${tx('menu.trash')}<span>${tx('key.delete')}</span></button>`, x, y, 'node', r.id);
}
function volLabel(v: VolumeInfo) { return `${v.path.replace(/\\$/, '')} ${v.label || t('header.drive.local')}`; }
$('volBtn').addEventListener('click', e => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(`<div class="menu-h">${tx('menu.drives')}</div>`
    + S.vols.map((v, i) => `<button type="button" role="menuitem" data-m="vol" data-v="${i}"${S.vol === v ? ' class="on"' : ''}>${esc(volLabel(v))}<span>${esc(v.fs)} · ${fmtB(v.total)}</span></button>`).join('')
    + `<hr><div class="menu-h">${tx('menu.analyzeFolder')}</div><form id="folderForm"><input id="folderIn" placeholder="C:\\Users\\…" value="${esc(S.target)}" aria-label="${tx('menu.folderPath')}"><button class="btn sm" type="submit">${tx('menu.analyze')}</button></form>`,
    r.left, r.bottom + 6, 'vol');
});
menu.addEventListener('submit', e => {
  e.preventDefault(); const v = ($('folderIn') as HTMLInputElement).value.trim(); if (!v) return;
  closeMenus(); analyzeFolder(v);
});
menu.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button[data-m]') as HTMLElement; if (!b) return;
  const m = b.dataset.m!, kind = menu.dataset.kind; closeMenus();
  if (kind === 'vol') { if (m === 'vol') { S.vol = S.vols[+b.dataset.v!]; S.target = S.vol.path; renderVolume(); startScan(); } return; }
  if (kind === 'lang') { setPreference(b.dataset.v!); return; }
  rowOf(+menu.dataset.id!).then(r => {
    switch (m) {
      case 'open': case 'reveal': case 'properties': doAction(m, r); break;
      case 'copy': pathOf(r.id).then(p => copyText(p, 'toast.pathCopied')); break;
      case 'zoom': zoomToRow(r); break;
      case 'tree': setTab('tree'); locate(r); break;
      case 'trash': select(r); S.confirmTrash = true; renderInspector(); break;
    }
  });
});
const notes = $('notes'), scrim = $('scrim');
function closeMenus() {
  menu.hidden = true; qHelp.hidden = true; qHelpBtn.setAttribute('aria-expanded', 'false');
  if (!notes.hidden) { notes.hidden = true; scrim.hidden = true; $('notesBtn').focus(); }
}
$('notesBtn').addEventListener('click', () => { notes.hidden = false; scrim.hidden = false; $('notesClose').focus(); });
$('notesClose').addEventListener('click', closeMenus);
scrim.addEventListener('click', closeMenus);
document.addEventListener('pointerdown', e => {
  const t = e.target as Node;
  if (!menu.hidden && !menu.contains(t)) menu.hidden = true;
  if (!qHelp.hidden && !qHelp.contains(t) && !qHelpBtn.contains(t)) { qHelp.hidden = true; qHelpBtn.setAttribute('aria-expanded', 'false'); }
});
const THEMES = ['system', 'dark', 'light'] as const;
const THEME_ICON = {
  system: '<svg class="i" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="8.5" rx="1"/><path d="M6 14h4"/></svg>',
  dark: '<svg class="i" viewBox="0 0 16 16"><path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z"/></svg>',
  light: '<svg class="i" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3"/><path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>',
};
let themeIdx = -1; try { const t = localStorage.getItem('tesserafs-theme'); if (t) themeIdx = THEMES.indexOf(t as never); } catch { }
function applyTheme() {
  const th = THEMES[Math.max(0, themeIdx)];
  if (themeIdx >= 0) { if (th === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', th); }
  $('themeBtn').innerHTML = THEME_ICON[th]; $('themeBtn').title = t('header.theme', { mode: th });
}
$('themeBtn').addEventListener('click', () => {
  themeIdx = (Math.max(0, themeIdx) + 1) % 3; applyTheme();
  try { localStorage.setItem('tesserafs-theme', THEMES[themeIdx]); } catch { }
  renderMap();
});
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => renderMap());
// Idioma: automático (el del sistema) o uno fijo. Los nombres van siempre en su propio idioma y con su atributo lang.
$('langBtn').addEventListener('click', e => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect(), cur = preference();
  const sys = LOCALES.find(l => l.code === systemLocale())!;
  const item = (code: string, label: string, lang?: string) =>
    `<button type="button" role="menuitemradio" aria-checked="${cur === code}" data-m="lang" data-v="${code}"${cur === code ? ' class="on"' : ''}${lang ? ` lang="${lang}"` : ''}>${esc(label)}</button>`;
  openMenu(`<div class="menu-h">${tx('language.heading')}</div>`
    + item('auto', t('language.auto', { name: sys.name }))
    + LOCALES.map(l => item(l.code, l.name, l.code)).join('')
    + (cur === PSEUDO ? item(PSEUDO, t('language.pseudo')) : ''),
    r.left, r.bottom + 6, 'lang');
});
new MutationObserver(() => renderMap()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ---------- Unidad, escaneo y barra de estado ----------
function renderVolume() {
  const v = S.vol, folder = !v || S.target.replace(/\\$/, '').toUpperCase() !== v.path.replace(/\\$/, '').toUpperCase();
  $('volLetter').textContent = v ? v.path.slice(0, 2) : '—';
  $('volName').textContent = folder ? S.target.split('\\').filter(Boolean).pop() || S.target : (v!.label || t('header.drive.local'));
  if (v && v.total) {
    const used = (v.total - v.free) / v.total;
    $('volPct').textContent = ' ' + i18n.percent(used, 0); ($('volMeter') as HTMLElement).style.width = (used * 100).toFixed(1) + '%';
    $('volSub').textContent = t('header.drive.free', { free: fmtB(v.free), total: fmtB(v.total) });
    ($('volMeter') as HTMLElement).style.background = used > .85 ? 'var(--warn)' : 'var(--accent)';
  } else { $('volPct').textContent = ''; $('volSub').textContent = S.target; }
}
// Los avisos sobre el mapa se guardan como función para volver a componerlos si cambia el idioma
let mapStateFn: (() => string) | null = null;
function mapState(render: (() => string) | null) {
  const el = $('mapState'); scanCard = null; mapStateFn = render; el.classList.remove('fade', 'drives'); el.hidden = !render;
  if (render) el.innerHTML = `<div class="box">${render()}</div>`;
}
function fadeMapState() { const el = $('mapState'); scanCard = null; mapStateFn = null; el.classList.add('fade'); setTimeout(() => { el.hidden = true; el.classList.remove('fade'); }, 260); }
const phaseKey = (p: string) => i18n.has('phase.' + p) ? 'phase.' + p : '';

// Tarjeta de progreso: se construye una vez y sólo cambian sus textos, así nada se mueve de sitio.
// Con una unidad completa el progreso es real (bytes leídos frente al espacio usado) y el mosaico se llena en orden disperso.
const MOSAIC = 96;
const MOSAIC_ORDER = (() => { const a = [...Array(MOSAIC).keys()]; let s = 7; for (let i = a.length - 1; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; })();
let scanCard: { phase: HTMLElement; pct: HTMLElement; bar: HTMLElement; entries: HTMLElement; bytes: HTMLElement; time: HTMLElement; path: HTMLElement; tiles: HTMLElement[]; lit: number; expected: number } | null = null;
function expectedBytes() {
  const v = S.vol; if (!v || !v.total) return 0;
  return S.target.replace(/\\$/, '').toUpperCase() === v.path.replace(/\\$/, '').toUpperCase() ? v.total - v.free : 0;
}
function openScanCard() {
  const el = $('mapState'), cols = CATEGORIES.map(c => rgb(c.color)), expected = expectedBytes();
  let tiles = ''; for (let i = 0; i < MOSAIC; i++) tiles += `<i style="--c:${cols[(i * 7 + (i >> 4) * 3) % cols.length]};--i:${i}"></i>`;
  el.classList.remove('fade', 'drives'); el.hidden = false; mapStateFn = null;
  // data-i18n en los rótulos: si cambia el idioma durante el escaneo, translateDom los actualiza sin rehacer la tarjeta
  el.innerHTML = `<div class="scan-card${expected ? '' : ' indet'}" role="status">`
    + `<div class="scan-mosaic" aria-hidden="true">${tiles}</div>`
    + `<div class="scan-title"><h2 data-i18n="phase.starting">${tx('phase.starting')}</h2><span class="scan-pct"></span></div>`
    + `<div class="scan-track"><i></i></div>`
    + `<dl class="scan-nums"><div><dt data-i18n="scan.items">${tx('scan.items')}</dt><dd>${fmtN(0)}</dd></div><div><dt data-i18n="scan.read">${tx('scan.read')}</dt><dd>${fmtB(0)}</dd></div><div><dt data-i18n="scan.time">${tx('scan.time')}</dt><dd>${fmtS(0)}</dd></div></dl>`
    + `<p class="scan-path">${esc(S.target)}</p>`
    + `<button class="btn sm ghost scan-cancel" type="button" data-i18n="header.cancel" data-i18n-title="scan.cancel.title" title="${tx('scan.cancel.title')}">${tx('header.cancel')}</button></div>`;
  const q1 = (s: string) => el.querySelector(s) as HTMLElement, dd = el.querySelectorAll('.scan-nums dd');
  scanCard = { phase: q1('.scan-title h2'), pct: q1('.scan-pct'), bar: q1('.scan-track i'), entries: dd[0] as HTMLElement, bytes: dd[1] as HTMLElement,
    time: dd[2] as HTMLElement, path: q1('.scan-path'), tiles: [...el.querySelectorAll('.scan-mosaic i')] as HTMLElement[], lit: 0, expected };
}
const shortPath = (p: string, max = 62) => p.length <= max ? p : p.slice(0, 3) + '…' + p.slice(-(max - 4));
function showProgress(p: ScanProgress) {
  if (!scanCard) openScanCard();
  const c = scanCard!, late = p.phase === 'link' || p.phase === 'aggregate' || p.phase === 'done';
  // El motor manda `fraction` cuando conoce el total (MFT); si no, se estima con los bytes frente al espacio usado
  if (p.fraction != null && !c.expected) { c.expected = 1; $('mapState').querySelector('.scan-card')?.classList.remove('indet'); $('scanBar').hidden = false; }
  const frac = p.fraction != null ? Math.min(1, p.fraction) : c.expected ? (late ? 1 : Math.min(.99, p.bytes / c.expected)) : 0;
  const pk = phaseKey(p.phase);
  if (pk) { c.phase.dataset.i18n = pk; c.phase.textContent = tk(pk); } else { delete c.phase.dataset.i18n; c.phase.textContent = p.phase; }
  c.entries.textContent = fmtN(p.entries); c.bytes.textContent = fmtB(p.bytes); c.time.textContent = fmtS(p.elapsedMs);
  if (p.detail) c.path.textContent = shortPath(p.detail);
  if (c.expected) {
    const pct = i18n.percent(Math.floor(frac * 100) / 100, 0);
    c.pct.textContent = pct; c.bar.style.transform = `scaleX(${frac})`;
    ($('scanBar').firstElementChild as HTMLElement).style.transform = `scaleX(${frac})`;
    const lit = Math.round(frac * MOSAIC); for (let i = c.lit; i < lit; i++) c.tiles[MOSAIC_ORDER[i]].classList.add('on'); c.lit = Math.max(c.lit, lit);
    $('scanTxt').textContent = t('header.scanProgress', { value: pct });
  } else $('scanTxt').textContent = t('header.scanProgress', { value: fmtN(p.entries) });
}
export async function startScan() {
  if (S.scanning) return; S.scanning = true; closeMenus(); tip.hidden = true;
  // Durante el escaneo el botón principal pasa a Cancelar
  const btn = $('scanBtn') as HTMLButtonElement; btn.disabled = false; btn.classList.add('cancel'); btn.querySelector('span')!.textContent = t('header.cancel');
  $('scanBar').hidden = !expectedBytes(); ($('scanBar').firstElementChild as HTMLElement).style.transform = 'scaleX(0)';
  scanCard = null; showProgress({ phase: 'starting', entries: 0, bytes: 0, elapsedMs: 0 });
  try {
    const res = await B.scan({ path: S.target, engine: 'auto' }, showProgress);
    S.scan = res; S.kids.clear(); S.rowCache.clear(); S.pathCache.clear(); S.clean = null; S.hl = null; $('hlChip').hidden = true; S.query = ''; q.value = '';
    S.root = remember(await B.nodeInfo(res.rootId)); S.pathCache.set(res.rootId, res.rootPath);
    S.chain = [S.root]; S.expanded = new Set([S.root.id]); S.slice = null;
    if (res.volume) { S.vol = S.vols.find(v => v.path === res.volume!.path) || res.volume; }
    const ext = await B.extStats(S.root.id); setExtRanking(ext.map(e => e.ext)); S.ext = ext;
    $('enginePill').hidden = false; renderScanSummary();
    renderVolume(); updateCrumbs(); renderComposition();
    await rebuildTree(); await loadSlice(true);
    fadeMapState(); wrap.classList.remove('reveal'); void wrap.offsetWidth; wrap.classList.add('reveal');
    const big = await B.search({ query: '', root: S.root.id, limit: 1 });
    if (big.rows[0]) { S.pathCache.set(big.rows[0].id, big.rows[0].path); await locate(remember(big.rows[0])); } else select(S.root);
    $('cleanCount').textContent = ''; if (S.tab === 'clean') renderClean(); if (S.tab === 'files') loadFiles();
    if (res.warnings.length && B.kind !== 'demo') toast(res.warnings.map(msgText).join(' · '));
    applyHash();
  } catch (e) {
    if ((e as { code?: string }).code === 'error.cancelled') await afterCancel();
    else mapState(() => `<h2>${tx('state.error.title')}</h2><p>${esc(msgText(e))}</p>`);
  } finally {
    S.scanning = false; btn.disabled = false; btn.classList.remove('cancel'); btn.querySelector('span')!.textContent = t('header.scan'); $('scanBar').hidden = true; renderStatus();
  }
}
async function cancelScan() {
  if (!S.scanning) return;
  const btn = $('scanBtn') as HTMLButtonElement; btn.disabled = true;
  try { await B.cancelScan(); } catch (e) { btn.disabled = false; toast(msgText(e)); }
}
/** Tras cancelar: si el motor conserva el escaneo anterior se vuelve a él; si no, a la pantalla de unidades. */
async function afterCancel() {
  const kept = S.root ? await B.nodeInfo(S.root.id).then(() => true, () => false) : false;
  if (kept) { fadeMapState(); renderScanSummary(); toast(t('toast.scanCancelled')); return; }
  S.scan = null; S.root = null; S.chain = []; S.slice = null; S.sel = null; S.hl = null; S.clean = null; S.files = []; S.ext = [];
  S.kids.clear(); S.rowCache.clear(); S.pathCache.clear(); S.expanded.clear();
  $('enginePill').hidden = true; $('scanTxt').textContent = ''; $('hlChip').hidden = true; $('cleanCount').textContent = ''; $('filesCount').textContent = '';
  await rebuildTree(); renderMap(); updateCrumbs(); renderComposition(); renderInspector(); renderStatus(); filesVL.setCount(0);
  if (S.tab === 'clean') renderClean();
  showDrives();
}
// Pantalla inicial: todas las unidades con su uso, y una carpeta concreta
function drivesHTML() {
  const cards = S.vols.map((v, i) => {
    const used = v.total ? (v.total - v.free) / v.total : 0;
    return `<button class="drive-card${S.vol === v ? ' on' : ''}" type="button" data-vol="${i}">`
      + `<span class="dc-letter">${esc(v.path.replace(/\\$/, ''))}</span>`
      + `<span class="dc-body"><span class="dc-name"><b>${esc(v.label || t('header.drive.local'))}</b><small>${esc(v.fs)}${v.total ? ' · ' + esc(i18n.percent(used, 0)) : ''}</small></span>`
      + `<span class="meter"><i class="used" style="width:${(used * 100).toFixed(1)}%;background:${used > .85 ? 'var(--warn)' : 'var(--accent)'}"></i></span>`
      + (v.total ? `<small>${tx('header.drive.free', { free: fmtB(v.free), total: fmtB(v.total) })}</small>` : '') + `</span></button>`;
  }).join('');
  return `<h2>${tx('state.choose.title')}</h2><p>${tx('state.choose.body')}</p>`
    + (cards ? `<div class="drive-grid">${cards}</div>` : `<p class="note">${tx('drives.empty')}</p>`)
    + `<form class="drive-folder" data-form="folder"><input name="path" placeholder="C:\\Users\\…" value="${esc(S.target)}" aria-label="${tx('menu.folderPath')}" spellcheck="false"><button class="btn sm" type="submit">${tx('menu.analyze')}</button></form>`;
}
function showDrives() { mapState(drivesHTML); $('mapState').classList.add('drives'); }
function analyzeFolder(v: string) {
  S.target = v; S.vol = S.vols.find(x => v.toUpperCase().startsWith(x.path.toUpperCase())) || null; renderVolume(); startScan();
}
$('mapState').addEventListener('click', e => {
  const t = e.target as HTMLElement;
  if (t.closest('.scan-cancel')) { cancelScan(); return; }
  const card = t.closest('[data-vol]') as HTMLElement;
  if (card) { S.vol = S.vols[+card.dataset.vol!]; S.target = S.vol.path; renderVolume(); startScan(); }
});
$('mapState').addEventListener('submit', e => {
  const f = (e.target as HTMLElement).closest('[data-form="folder"]') as HTMLFormElement; if (!f) return;
  e.preventDefault(); const v = (f.elements.namedItem('path') as HTMLInputElement).value.trim(); if (v) analyzeFolder(v);
});
function renderScanSummary() {
  const res = S.scan; if (!res) return;
  $('enginePill').textContent = t(res.engine === 'mft' ? 'header.engine.mft' : 'header.engine.walk');
  $('scanTxt').textContent = t('header.scanDone', { time: fmtS(res.elapsedMs), count: res.entries });
}
$('scanBtn').addEventListener('click', () => S.scanning ? cancelScan() : startScan());
// Enlaces directos a una vista, en inglés o en español: #files, #clean, #extension, #age, #relief, #guide
// (#archivos, #limpieza, #antiguedad, #relieve, #guia). #pseudo activa la pseudolocalización.
function applyHash() {
  const h = location.hash.slice(1).toLowerCase().split(/[,+]/), has = (...k: string[]) => k.some(x => h.includes(x));
  if (has('files', 'archivos')) setTab('files');
  if (has('clean', 'limpieza')) setTab('clean');
  if (has('extension')) setColorMode('ext');
  if (has('age', 'antiguedad')) setColorMode('age');
  if (has('relief', 'relieve')) ($('styleSeg').querySelector('[data-style="relief"]') as HTMLElement).click();
  if (has('guide', 'guia')) $('notesBtn').click();
}
export function renderStatus() {
  const r = S.sel || zoomRow(), z = zoomRow();
  $('st1').innerHTML = !r ? '' : r.isDir ? html('status.selectedFolder', { name: nameOf(r), size: fmtB(r.size), count: r.files })
    : html('status.selected', { name: nameOf(r), size: fmtB(r.size) });
  $('st2').innerHTML = z ? html('status.map', { path: S.pathCache.get(z.id) || nameOf(z), size: fmtB(z.size) }) : '';
}

// ---------- Teclado y tamaño ----------
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'f')) { e.preventDefault(); q.focus(); q.select(); return; }
  if (e.key === 'Escape') {
    if (!menu.hidden || !qHelp.hidden || !notes.hidden) { closeMenus(); return; }
    if (S.scanning) { cancelScan(); return; }
    if (S.confirmTrash) { S.confirmTrash = false; renderInspector(); return; }
    if (S.hl) { setHL(null); if (S.tab === 'files') loadFiles(); return; }
  }
  const tag = (document.activeElement as HTMLElement)?.tagName || '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag) || S.scanning) return;
  if (e.key === '1') setColorMode('category'); else if (e.key === '2') setColorMode('ext'); else if (e.key === '3') setColorMode('age');
  if (e.key === 'Backspace' && S.chain.length > 1) { e.preventDefault(); setZoom(S.chain.slice(0, -1)); }
  if (e.key === 'Delete' && S.sel && S.sel.parentId >= 0) { S.confirmTrash = true; renderInspector(); }
});
let rzT = 0, rzFrame = 0, dragging = false;
new ResizeObserver(() => {
  if (dragging) { if (!rzFrame) rzFrame = requestAnimationFrame(() => { rzFrame = 0; renderMap(true); }); return; }
  clearTimeout(rzT); rzT = window.setTimeout(() => { if (!S.scanning) loadSlice(); }, 90);
}).observe(wrap);

// ---------- Divisores: arrastrar, flechas (Mayús = paso largo), doble clic o Inicio para restablecer ----------
const work = document.querySelector('.work') as HTMLElement;
const LAYOUT_KEY = 'tesserafs-layout', LAYOUT_PROPS = ['--w-tree', '--w-rail', '--h-rail'];
try { const o = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'); for (const k of LAYOUT_PROPS) if (o[k]) work.style.setProperty(k, o[k]); } catch { }
function saveLayout() {
  try { const o: Record<string, string> = {}; for (const k of LAYOUT_PROPS) { const v = work.style.getPropertyValue(k); if (v) o[k] = v; } localStorage.setItem(LAYOUT_KEY, JSON.stringify(o)); } catch { }
}
const box2 = (sel: string) => (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
function splitter(id: string, prop: string, axis: 'x' | 'y', sign: 1 | -1, size: () => number, fromPointer: (r: DOMRect, e: PointerEvent) => number, limits: (r: DOMRect) => [number, number]) {
  const el = $(id);
  const apply = (v: number) => { const [lo, hi] = limits(work.getBoundingClientRect()); work.style.setProperty(prop, Math.round(Math.max(lo, Math.min(hi, v))) + 'px'); };
  const finish = () => { if (!el.classList.contains('drag')) return; el.classList.remove('drag'); document.body.classList.remove('resizing'); dragging = false; saveLayout(); renderMap(); loadSlice(); };
  el.addEventListener('pointerdown', e => { e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('drag'); document.body.classList.add('resizing'); document.body.dataset.axis = axis; dragging = true; });
  el.addEventListener('pointermove', e => { if (el.hasPointerCapture(e.pointerId)) apply(fromPointer(work.getBoundingClientRect(), e)); });
  el.addEventListener('pointerup', finish); el.addEventListener('lostpointercapture', finish);
  el.addEventListener('dblclick', () => { work.style.removeProperty(prop); saveLayout(); });
  el.addEventListener('keydown', e => {
    const step = e.shiftKey ? 64 : 16, keys = axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    if (e.key === 'Home') { work.style.removeProperty(prop); saveLayout(); e.preventDefault(); return; }
    const d = e.key === keys[1] ? step : e.key === keys[0] ? -step : 0; if (!d) return;
    e.preventDefault(); apply(size() + d * sign); saveLayout();
  });
}
const railBeside = () => getComputedStyle($('split2')).display !== 'none';
splitter('split1', '--w-tree', 'x', 1, () => box2('.tree-pane').width, (r, e) => e.clientX - r.left - 5,
  r => [240, r.width - 20 - 380 - (railBeside() ? box2('.rail').width : 0)]);
splitter('split2', '--w-rail', 'x', -1, () => box2('.rail').width, (r, e) => r.right - e.clientX - 5,
  r => [220, Math.min(560, r.width - 20 - 380 - box2('.tree-pane').width)]);
splitter('split3', '--h-rail', 'y', -1, () => box2('.rail').height, (r, e) => r.bottom - e.clientY - 5, r => [140, r.height - 10 - 240]);

// ---------- Arranque ----------
const EDITION: Record<Backend['kind'], [MessageKey, MessageKey]> = {
  demo: ['app.edition.demo', 'app.footer.demo'], tauri: ['app.edition.desktop', 'app.footer.local'], http: ['app.edition.portable', 'app.footer.local'],
};
function renderEdition() {
  const [tag, foot] = EDITION[B.kind];
  $('editionTag').textContent = t(tag); $('editionTag').title = B.kind === 'demo' ? t('app.edition.title') : '';
  $('st3').textContent = `${t(foot)} · v${VERSION}`;
}
/** Vuelve a pintar todo lo que tiene texto o cifras al cambiar de idioma; el estado (selección, zoom, filtros) se conserva. */
function relocalize() {
  menu.hidden = true; tip.hidden = true; tipKey = '';
  applyTheme(); renderEdition(); renderVolume(); if (!S.scanning) renderScanSummary(); updateCrumbs(); renderComposition(); renderInspector(); renderStatus();
  if (S.hl) $('hlTxt').textContent = hlText(S.hl);
  if (S.scanning) $('scanBtn').querySelector('span')!.textContent = t('header.cancel');
  if (mapStateFn) $('mapState').innerHTML = `<div class="box">${mapStateFn()}</div>`;
  treeVL.paint(); filesVL.paint(); renderMap();
  if (S.tab === 'files') loadFiles();
  if (S.tab === 'clean') renderClean();
}
export async function startApp(backend: Backend) {
  B = backend;
  translateDom(); onLocaleChange(relocalize);
  renderEdition(); applyTheme(); updateSortHead(); renderInspector(); renderComposition();
  try { S.vols = await B.volumes(); } catch (e) { toast(t('toast.volumesFailed', { error: msgText(e) })); }
  S.vol = S.vols.find(v => /^C:/i.test(v.path)) || S.vols[0] || null; if (S.vol) S.target = S.vol.path;
  renderVolume();
  B.elevation().then(el => {
    const btn = $('elevBtn'); btn.hidden = el.elevated || !el.canElevate;
    btn.onclick = async () => {
      mapState(() => `<h2>${tx('state.elevating.title')}</h2><p>${tx('state.elevating.body')}</p>`);
      try { await B.relaunchElevated(); } catch (e) { mapState(null); toast(msgText(e)); }
    };
  }).catch(() => { });
  if (B.kind === 'demo') startScan();
  else showDrives();
}
