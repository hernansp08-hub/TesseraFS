// Interfaz de TesseraFS: un único estado y una selección que une el árbol, el mapa y el panel de detalle.
import {
  FLAG, decodeSlice, type ActionKind, type Backend, type ChangeRow, type CompareResult, type DupGroup, type DupProgress, type DupResult, type ExtStat,
  type HistoryEntry, type NodeRow, type RemovedRow, type ScanProgress, type ScanResult,
  type SearchRow, type SliceNode, type SortKey, type VolumeInfo,
} from '@tessera/protocol';
import { layout, raster, type Layout, type Tile } from './render';
import { AGE_BINS, CATEGORIES, REST_COLOR, ageBin, ageColor, ageName, catName, categoryById, categoryOf, extColor, rgb, setExtRanking, type ColorMode, type RGB } from './colors';
import { GB, MB, ageText, esc, fmtB, fmtD, fmtN, fmtP, fmtS } from './format';
import { SYS, baseName, can, folderHint, isSystemVolume, isUnder, joinPath, parentPath, pathKey, setSystem, trimSep, volTag } from './platform';
import { LOCALES, PSEUDO, html, i18n, msgText, onLocaleChange, preference, setPreference, systemLocale, t, tk, translateDom, type MessageKey } from './i18n';
import { cmdOf, howKey, knownIdFor, ruleMatches, rulesFor, titleOf, type Key, type Risk, type Rule } from './clean';

type TRow = { row: NodeRow; depth: number; more?: undefined } | { more: number; remaining: number; depth: number; row?: undefined };
// Los resaltados guardan datos, no textos: la etiqueta se compone al pintar, en el idioma activo
type HL = { type: 'cat'; id: string } | { type: 'ext'; ext: string } | { type: 'age'; bin: number }
  | { type: 'search'; ids: Set<number>; query: string; count: number };
interface CleanCard {
  row: NodeRow; path: string; rule: Rule; title: Key; cmd?: string; count?: number; rows?: SearchRow[];
  /** Tarjetas de resumen (rule.list): cuántos hay en total y algunos ejemplos. */
  total?: number; sample?: SearchRow[];
}
/** «¿Qué es esto?» del panel de detalle: una regla de limpieza que lo describe, o una carpeta conocida. */
type Known = { rule: Rule; title: Key; cmd?: string } | { id: string };
/** Elemento de la cesta «Para borrar». `error`: por qué no se pudo mover la última vez. */
interface Marked { row: NodeRow; path: string; error?: string }
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
  marked: new Map<number, Marked>(), basketConfirm: false, basketBusy: false,
  known: new Map<number, Known | null>(), knownPending: new Set<number>(),
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
/** `action`: un botón dentro del aviso (p. ej. «Mostrar» tras exportar). */
export function toast(msg: string, action?: { label: string; run: () => void }) {
  const el = $('toast'); el.textContent = msg;
  if (action) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'toast-act'; b.textContent = action.label;
    b.onclick = () => { action.run(); el.classList.remove('show'); }; el.append(' ', b);
  }
  el.hidden = false; requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastT); toastT = window.setTimeout(() => { el.classList.remove('show'); setTimeout(() => { el.hidden = true; }, 200); }, action ? 8000 : 4200);
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
  drawMarked();
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
// Lo marcado para borrar se tiñe de rojo; si la vista entera está dentro de una carpeta marcada, se tiñe todo
function drawMarked() {
  if (!S.marked.size || !S.L || !M) return;
  const danger = css('--bad') || '#f27d72', d = M.dpr;
  octx.save(); octx.fillStyle = danger; octx.strokeStyle = danger; octx.lineWidth = 1.5 * d;
  if (S.chain.some(c => S.marked.has(c.id))) { octx.globalAlpha = .18; octx.fillRect(0, 0, M.W, M.H); }
  else for (const id of S.marked.keys()) {
    const r = S.L.rects.get(id); if (!r) continue;
    octx.globalAlpha = .32; octx.fillRect(r[0], r[1], r[2], r[3]);
    octx.globalAlpha = .9; octx.strokeRect(r[0] + d / 2, r[1] + d / 2, Math.max(1, r[2] - d), Math.max(1, r[3] - d));
  }
  octx.restore();
}
function slicePath(n: SliceNode) {
  const names: string[] = []; for (let x: SliceNode | null = n; x && x.parent; x = x.parent) names.push(x.name);
  const base = S.pathCache.get(zoomRow()!.id) || '';
  const rel = names.reverse().join(SYS.sep); return !rel ? base : joinPath(base, rel);
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
  return `<div class="t-name"><i class="sw" style="background:${rgb(nodeColor(n.ext, n.isDir, n.mtime))}"></i><b>${esc(n.name)}${n.isDir ? SYS.sep : ''}</b></div>`
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
  const r = sliceRow(h.n);
  if ((e.ctrlKey || e.metaKey) && !h.rest) { select(r); toggleMark(r); return; }
  if (S.tab !== 'tree') setTab('tree'); locate(r, sliceAncestors(h.n));
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
  const cls = 'row' + (sel ? ' sel' : '') + (r.isDir ? ' dir' : '') + (r.flags & FLAG.HIDDEN ? ' hid' : '') + (r.flags & FLAG.HARDLINK ? ' hl' : '') + markClass(r);
  const tw = r.isDir && r.childCount ? `<span class="tw${open ? ' open' : ''}" data-tw="1"></span>` : '<span class="tw none"></span>';
  const icon = r.isDir ? FOLDER : `<i class="sw" style="background:${rgb(rowColor(r))}"></i>`;
  const items = r.isDir ? fmtN(r.files + r.dirs) : '', ind = indent(tr.depth);
  return `<div class="${cls}" role="row" data-i="${i}" aria-level="${tr.depth + 1}"${r.isDir ? ` aria-expanded="${open}"` : ''} aria-selected="${sel}">`
    + (tr.depth ? `<span class="share" style="left:${10 + ind}px;width:calc((100% - ${18 + ind}px) * ${pct.toFixed(4)})"></span>` : '')
    + `<span class="c-name" style="--ind:${ind}px">${tw}${icon}<span class="nm" data-fit="name" title="${esc(r.name)}">${esc(nameOf(r))}</span></span>`
    + `<span class="c-size num">${fmtB(r.size)}</span>${H.cmp ? `<span class="c-delta num">${deltaHTML(r)}</span>` : ''}<span class="c-pct num">${tr.depth ? fmtP(pct) : ''}</span><span class="c-alloc num">${fmtB(r.alloc)}</span>`
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
  if (e.ctrlKey || e.metaKey) toggleMark(t.row!);
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
    case ' ': toggleMark(r); break;
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
    : `<div class="actions">${can('reveal') ? `<button class="btn sm" type="button" data-act="reveal">${tx('insp.reveal')}</button>` : ''}<button class="btn sm" type="button" data-act="zoom"${canZoom ? '' : ' disabled'}>${tx('insp.zoom')}</button>`
      + `<button class="btn sm${S.marked.has(r.id) ? ' on' : ''}" type="button" data-act="mark" aria-pressed="${S.marked.has(r.id)}"${r.parentId >= 0 ? '' : ' disabled'}>${tx(S.marked.has(r.id) ? 'mark.remove' : 'mark.add')}</button>`
      + (r.isDir ? `<button class="btn sm" type="button" data-act="rescan" title="${tx('menu.rescan')}">${tx('insp.rescan')}</button>` : '')
      + (canFreeUp(r) ? `<button class="btn sm" type="button" data-act="freeUp" title="${tx('menu.freeUp.title')}">${tx('menu.freeUp')}</button>` : '')
      + (can('trash') ? `<button class="btn sm danger" type="button" data-act="trash"${r.parentId >= 0 ? '' : ' disabled'}>${tx('insp.trash')}</button>` : '') + `</div>`;
  const inMarked = markedAncestor(r);
  el.innerHTML = `<div class="insp-top"><span class="sw lg" style="background:${rgb(rowColor(r))}"></span><div class="insp-id"><div class="insp-kind">${esc(kind)}</div><h2 class="insp-name" title="${esc(r.name)}">${esc(nameOf(r))}</h2></div></div>`
    + `<div class="insp-size"><span class="big">${fmtB(r.size)}</span><span class="sub">${S.root ? tx('insp.ofScanned', { value: fmtP(r.size / (S.root.size || 1)) }) : ''}</span></div>`
    + `<div class="insp-path"><code>${path ? esc(path).split(SYS.sep).join(SYS.sep + '<wbr>') : '…'}</code><button class="icon-btn sm" type="button" data-act="copy" title="${tx('insp.copyPath')}">${ICON_COPY}</button></div>`
    + `<dl class="kv"><div><dt title="${tx('insp.onDisk.title')}">${tx('insp.onDisk')}</dt><dd>${fmtB(r.alloc)}</dd></div>`
    + `<div><dt>${tx('insp.ofFolder')}</dt><dd>${r.parentId >= 0 ? fmtP(r.size / (ps || 1)) : '—'}</dd></div>`
    + (r.isDir ? `<div><dt>${tx('insp.files')}</dt><dd>${fmtN(r.files)}</dd></div><div><dt>${tx('insp.folders')}</dt><dd>${fmtN(r.dirs)}</dd></div>`
      : `<div><dt>${tx('insp.attributes')}</dt><dd>${esc(attrs(r.flags))}</dd></div><div><dt>${tx('insp.age')}</dt><dd>${esc(ageText(r.mtime))}</dd></div>`)
    + `<div><dt>${tx('insp.modified')}</dt><dd>${fmtD(r.mtime)}</dd></div>`
    + (H.cmp && (r.fresh || r.prev != null) ? `<div><dt>${tx('insp.change')}</dt><dd>${deltaHTML(r) || tx('changes.same')}</dd></div>` : '') + `</dl>`
    + (r.flags & FLAG.HARDLINK ? `<p class="note">${tx('insp.note.hardlink')}</p>` : '')
    + (r.flags & FLAG.CLOUD && !r.isDir ? `<p class="note">${tx(r.alloc ? 'insp.cloud.local' : 'insp.cloud.online')}</p>` : '')
    // Ahorro en disco: en archivos, sólo si están comprimidos (los de la nube ya tienen su nota); en carpetas, puede ser
    // compresión o archivos sólo en línea
    + (savedOnDisk(r) && (r.isDir || r.flags & FLAG.COMPRESSED) ? `<p class="note">${tx(r.flags & FLAG.COMPRESSED ? 'insp.saved' : 'insp.saved.cloud', { saved: fmtB(r.size - r.alloc), pct: fmtP(1 - r.alloc / r.size) })}</p>` : '')
    + (inMarked ? `<p class="note marked-note">${tx('basket.alreadyIn', { name: inMarked.row.name })}</p>` : '')
    + knownHTML(r, path)
    + acts;
}
// Primero una regla de limpieza que lo describa (con su riesgo y su orden), después las carpetas conocidas.
// Se calcula una vez por elemento: alguna regla pregunta al motor por los hijos (CACHEDIR.TAG de Rust).
async function knownFor(r: NodeRow, path: string): Promise<Known | null> {
  const tg = { name: r.name, path, isDir: r.isDir, ext: r.ext, size: r.size, alloc: r.alloc, flags: r.flags };
  for (const rule of rulesFor(SYS.os)) {
    if (!ruleMatches(rule, tg)) continue;
    if (rule.needs && !(await hasChild(r.id, rule.needs).catch(() => false))) continue;
    return { rule, title: titleOf(rule, tg), cmd: cmdOf(rule, tg) };
  }
  const id = knownIdFor(path, SYS.os);
  return id ? { id } : null;
}
function knownHTML(r: NodeRow, path: string | undefined): string {
  if (!path || r.parentId < 0) return '';
  if (!S.known.has(r.id)) {
    if (!S.knownPending.has(r.id)) {
      S.knownPending.add(r.id);
      knownFor(r, path).then(k => { S.known.set(r.id, k); S.knownPending.delete(r.id); if ((S.sel || zoomRow())?.id === r.id) renderInspector(); });
    }
    return '';
  }
  const k = S.known.get(r.id); if (!k) return '';
  const head = `<div class="known-h"><b>${tx('known.heading')}</b>${'rule' in k ? `<span class="risk ${k.rule.risk}">${esc(riskName(k.rule.risk))}</span>` : ''}</div>`;
  if (!('rule' in k)) return `<div class="known">${head}<p>${esc(tk('known.' + k.id))}</p></div>`;
  return `<div class="known">${head}<p class="known-t">${esc(keyText(k.title))}</p><p>${esc(tk(`clean.${k.rule.id}.why`))}</p>`
    + (k.cmd ? `<div class="cmd"><code>${esc(k.cmd)}</code><button class="icon-btn sm" type="button" data-act="copy-cmd" title="${tx('clean.copyCommand')}">${ICON_COPY}</button></div>` : '')
    + (k.rule.how ? `<p class="how">${esc(tk(howKey(k.rule)))}</p>` : '') + `</div>`;
}
// ---------- OneDrive y compresión ----------
/** Ocupa en disco claramente menos que su tamaño (compresión o archivos sólo en la nube). */
const savedOnDisk = (r: NodeRow) => r.size >= 1024 ** 2 && r.alloc < r.size * .97;
/**
 * Hay algo de la nube descargado: un archivo o una carpeta con FLAG.CLOUD que ocupa disco. Sin «Archivos a petición»,
 * OneDrive no marca nada (todo está siempre descargado) y no se ofrece.
 */
const canFreeUp = (r: NodeRow) => can('freeUp') && r.alloc > 0 && !!(r.flags & FLAG.CLOUD);
/**
 * Deja los archivos de la nube descargados como «sólo en línea» (siguen en OneDrive y vuelven a bajar al abrirlos).
 * El proveedor los vacía en segundo plano: pasados unos segundos se vuelve a escanear la carpeta para verlo.
 */
async function freeUp(r: NodeRow) {
  try {
    const res = await B.action('freeUp', r.id);
    toast(res.code ? msgText(res) : t(res.ok ? 'toast.done' : 'toast.actionFailed'));
    if (!res.ok) return;
    const folder = r.isDir ? r : await rowOf(r.parentId).catch(() => null);
    if (folder && folder.parentId >= 0) setTimeout(() => { if (!S.scanning) rescanFolder(folder); }, 5000);
  } catch (e) { toast(t('toast.error', { error: msgText(e) })); }
}
async function doAction(kind: ActionKind, r: NodeRow) {
  try {
    const path = S.pathCache.get(r.id);
    const res = await B.action(kind, r.id);
    toast(res.code ? msgText(res) : res.message || t(res.ok ? 'toast.done' : 'toast.actionFailed'));
    if (kind === 'trash' && res.ok) { S.marked.delete(r.id); if (path) pruneDups([path]); await refreshAfterChange(r); }
  } catch (e) { toast(t('toast.error', { error: msgText(e) })); }
}
async function refreshAfterChange(r: NodeRow | null) {
  S.kids.clear(); S.rowCache.clear(); S.pathCache.clear(); S.clean = null; S.known.clear();
  S.root = remember(await B.nodeInfo(S.root!.id));
  const chain: NodeRow[] = []; for (const z of S.chain) { try { chain.push(remember(await B.nodeInfo(z.id))); } catch { break; } }
  S.chain = chain.length ? chain : [S.root];
  S.sel = S.chain[S.chain.length - 1]; if (r && r.parentId >= 0) S.sel = await rowOf(r.parentId).catch(() => S.sel!);
  // Lo marcado que ya no existe (dentro de lo borrado) sale de la cesta; lo demás se actualiza
  for (const [id, m] of S.marked) { try { m.row = remember(await B.nodeInfo(id)); } catch { S.marked.delete(id); } }
  updateCrumbs(); await rebuildTree(); await loadSlice(true); loadComposition(); renderInspector(); renderStatus(); renderBasketCount();
  if (S.tab === 'basket') renderBasket();
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
    case 'mark': toggleMark(r); break;
    case 'rescan': rescanFolder(r); break;
    case 'freeUp': freeUp(r); break;
    case 'copy-cmd': { const k = S.known.get(r.id); if (k && 'rule' in k && k.cmd) copyText(k.cmd, 'toast.commandCopied'); break; }
  }
});

// ---------- Archivos más grandes y resultados del filtro ----------
const filesBody = $('filesBody');
function fileRowHTML(i: number) {
  const r = S.files[i], sel = S.sel?.id === r.id, icon = r.isDir ? FOLDER : `<i class="sw" style="background:${rgb(rowColor(r))}"></i>`;
  return `<div class="row${sel ? ' sel' : ''}${markClass(r)}" role="row" data-i="${i}"><span class="c-name">${icon}<span class="nm" data-fit="name" title="${esc(r.name)}">${esc(r.name)}</span></span>`
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
filesBody.addEventListener('click', e => {
  const el = (e.target as HTMLElement).closest('.row') as HTMLElement; if (!el) return;
  const r = S.files[+el.dataset.i!]; select(r); if (e.ctrlKey || e.metaKey) toggleMark(r);
});
filesBody.addEventListener('keydown', e => {
  const i = S.files.findIndex(r => r.id === S.sel?.id);
  const move = (j: number) => { const r = S.files[j]; if (r) { select(r); filesVL.scrollTo(j); } };
  if (e.key === 'ArrowDown') move(Math.min(S.files.length - 1, i + 1));
  else if (e.key === 'ArrowUp') move(Math.max(0, i - 1));
  else if (e.key === ' ' && i >= 0) toggleMark(S.files[i]);
  else return;
  e.preventDefault();
});
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

// ---------- Descubrir: búsquedas preparadas y las guardadas por el usuario ----------
/** [clave del texto, consulta, sólo en Windows] */
const DISCOVER: [string, string, boolean?][] = [
  ['discover.big', 'size:>1g'], ['discover.recent', 'age:<7d size:>10m'], ['discover.oldBig', 'age:>2y size:>100m'],
  ['discover.manyFiles', 'type:dir files:>10k'], ['discover.emptyDirs', 'type:dir files:=0'], ['discover.emptyFiles', 'size:=0'],
  ['discover.links', 'type:dir attr:reparse OR attr:reparse'], ['discover.hardlinks', 'attr:hardlink'], ['discover.sparse', 'attr:sparse'],
  ['discover.hidden', 'attr:hidden,system'], ['discover.cloud', 'attr:cloud', true], ['discover.compressed', 'attr:compressed', true],
];
interface SavedSearch { name: string; q: string }
const SAVED_KEY = 'tesserafs-searches';
function savedSearches(): SavedSearch[] {
  try { const v = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); return Array.isArray(v) ? v.filter(s => s && typeof s.q === 'string') : []; } catch { return []; }
}
function storeSearches(list: SavedSearch[]) { try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch { /* sin almacenamiento: sólo esta sesión */ } }
function discoverHTML() {
  const saved = savedSearches(), cur = q.value.trim();
  return `<div class="menu-h">${tx('discover.title')}</div>`
    + DISCOVER.filter(([, , win]) => !win || SYS.os === 'windows')
      .map(([k, query]) => `<button type="button" role="menuitem" data-m="q" data-q="${esc(query)}">${tx(k as MessageKey)}<span>${esc(query)}</span></button>`).join('')
    + `<hr><div class="menu-h">${tx('discover.saved')}</div>`
    + (saved.length ? saved.map((s, i) => `<div class="menu-row"><button type="button" role="menuitem" data-m="q" data-q="${esc(s.q)}">${esc(s.name)}<span>${esc(s.q)}</span></button>`
      + `<button type="button" class="menu-x" data-m="del" data-i="${i}" title="${tx('discover.delete')}" aria-label="${tx('discover.delete')}">×</button></div>`).join('')
      : `<p class="menu-note">${tx('discover.none')}</p>`)
    + (cur ? `<form id="saveSearchForm" class="menu-form"><input id="saveSearchName" maxlength="60" placeholder="${tx('discover.name')}" aria-label="${tx('discover.name')}"><button class="btn sm" type="submit">${tx('discover.save')}</button></form>` : '');
}
$('discoverBtn').addEventListener('click', e => {
  e.preventDefault();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(discoverHTML(), r.left - 200, r.bottom + 6, 'discover');
});

// ---------- Liberar espacio: reglas explicadas ejecutadas como filtros ----------
const STORAGE_SENSE = 'start ms-settings:storagesense';
/** Pone una consulta en el filtro, la ejecuta y muestra sus resultados en Archivos. */
function setQuery(query: string) { q.value = query; closeMenus(); runQuery(); setTab('files'); q.focus({ preventScroll: true }); }
const hasChild = async (id: number, names: string[]) => {
  const res = await B.children({ id, offset: 0, limit: 200, sort: 'name', desc: false });
  return res.rows.some(c => names.includes(c.name.toLowerCase()));
};
const riskName = (r: Risk) => tk('clean.risk.' + r);
const keyText = (k: Key) => tk(k[0], k[1]);
async function loadClean() {
  if (!S.root) return;
  const cards: CleanCard[] = [], root = S.root, rootPath = S.scan?.rootPath ?? '';
  const seen: string[] = []; // rutas que ya tienen tarjeta: la caché declarada no se repite ni se anida
  for (const rule of rulesFor(SYS.os)) {
    if (rule.list) {
      const res = await (rule.list === 'links' ? B.brokenLinks(root.id, 500) : B.search({ query: rule.q, root: root.id, limit: 500 })).catch(() => null);
      if (!res || res.error || !res.total) continue;
      cards.push({ row: { ...root, size: res.totalBytes }, path: rootPath, rule, title: titleOf(rule, res.rows[0]), total: res.total,
        sample: res.rows.slice(0, 6), rows: rule.list === 'links' ? res.rows : undefined });
      continue;
    }
    const res = await B.search({ query: rule.q, root: root.id, limit: 200 }).catch(() => null); if (!res || res.error) continue;
    if (rule.parent) {
      for (const r of res.rows.slice(0, 60)) {
        const dir = await rowOf(r.parentId).catch(() => null); if (!dir || dir.parentId < 0) continue;
        const path = parentPath(r.path), t = { ...dir, path };
        if ((rule.ok && !rule.ok(t)) || (rule.min && dir.size < rule.min) || seen.some(s => isUnder(path, s) || isUnder(s, path))) continue;
        seen.push(path); cards.push({ row: dir, path, rule, title: titleOf(rule, t) });
      }
      continue;
    }
    let rows = res.rows.filter(r => (!rule.ok || rule.ok(r)) && (!rule.min || rule.group || (rule.useAlloc ? r.alloc : r.size) >= rule.min));
    if (rule.needs) { const keep: SearchRow[] = []; for (const r of rows.slice(0, 40)) if (await hasChild(r.id, rule.needs).catch(() => false)) keep.push(r); rows = keep; }
    if (rule.group) {
      const by = new Map<string, SearchRow[]>(); for (const r of rows) { const k = parentPath(r.path); by.set(k, [...(by.get(k) || []), r]); }
      for (const [, list] of by) {
        const size = list.reduce((s, r) => s + r.size, 0); if (rule.min && size < rule.min) continue;
        const parent = await rowOf(list[0].parentId).catch(() => null); if (!parent) continue;
        const path = await pathOf(parent.id).catch(() => parentPath(list[0].path));
        seen.push(path); cards.push({ row: { ...parent, size }, path, rule, title: titleOf(rule, list[0]), cmd: cmdOf(rule, list[0]), count: list.length, rows: list });
      }
    } else for (const r of rows) { seen.push(r.path); cards.push({ row: rule.useAlloc ? { ...r, size: r.alloc } : r, path: r.path, rule, title: titleOf(rule, r), cmd: cmdOf(rule, r) }); }
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
    // Windows también limpia solo: qué hace el Sensor de almacenamiento y cómo abrirlo
    + (SYS.os === 'windows' ? `<div class="cl-tip"><p>${html('clean.storageSense')}</p><div class="cmd"><code>${STORAGE_SENSE}</code><button class="icon-btn sm" type="button" data-copy-text="${STORAGE_SENSE}" title="${tx('clean.copyCommand')}">${ICON_COPY}</button></div></div>` : '')
    + (L.length ? '' : `<div class="cl-loading">${tx('clean.none')}</div>`)
    + L.map((c, i) => `<article class="cl"><div><h3>${esc(keyText(c.title))}</h3>${c.total == null ? `<code class="cl-path">${esc(c.path)}</code>` : ''}<p>${esc(tk(`clean.${c.rule.id}.why`))}${c.count ? ' ' + tx('clean.fileCount', { count: c.count }) : ''}</p>`
      + (c.sample ? `<ul class="cl-list">${c.sample.map(r => `<li><code title="${esc(r.path)}">${esc(r.path)}</code></li>`).join('')}${c.total! > c.sample.length ? `<li class="more">${tx('clean.more', { count: c.total! - c.sample.length })}</li>` : ''}</ul>` : '')
      + (c.cmd ? `<div class="cmd"><code>${esc(c.cmd)}</code><button class="icon-btn sm" type="button" data-copy="${i}" title="${tx('clean.copyCommand')}">${ICON_COPY}</button></div>` : '')
      + (c.rule.how ? `<p class="how">${esc(tk(howKey(c.rule)))}</p>` : '')
      + `</div><div class="cl-side"><span class="cl-size">${c.total != null ? tx('clean.itemCount', { count: c.total }) : fmtB(c.row.size)}</span><span class="risk ${c.rule.risk}">${esc(riskName(c.rule.risk))}</span>`
      + (c.rule.list === 'query' ? `<button class="btn sm" type="button" data-view="${i}">${tx('clean.viewAll')}</button>`
        : c.rule.list ? '' : `<button class="btn sm" type="button" data-loc="${i}">${tx('clean.locate')}</button>`)
      // Lo que gestiona Windows no se marca; en las tarjetas agrupadas se marcan los archivos, no su carpeta
      + (c.rule.action === 'freeUp' ? `<button class="btn sm primary" type="button" data-free="${i}">${tx('clean.freeUp')}</button>`
        : c.rule.risk === 'bad' || c.rule.list === 'query' ? '' : `<button class="btn sm${cardMarked(c) ? ' on' : ''}" type="button" data-mark="${i}" aria-pressed="${cardMarked(c)}">${tx(cardMarked(c) ? 'mark.remove' : c.rule.list ? 'clean.markAll' : c.rows ? 'clean.markFiles' : 'clean.mark')}</button>`)
      + `</div></article>`).join('');
}
$('cleanBody').addEventListener('click', async e => {
  const t = e.target as HTMLElement, cp = t.closest('[data-copy]') as HTMLElement;
  if (cp) { copyText(S.clean![+cp.dataset.copy!].cmd!, 'toast.commandCopied'); return; }
  const ct = t.closest('[data-copy-text]') as HTMLElement;
  if (ct) { copyText(ct.dataset.copyText!, 'toast.commandCopied'); return; }
  const vw = t.closest('[data-view]') as HTMLElement;
  if (vw) { setQuery(S.clean![+vw.dataset.view!].rule.q); return; }
  const mk = t.closest('[data-mark]') as HTMLElement;
  if (mk) {
    const c = S.clean![+mk.dataset.mark!], rows: NodeRow[] = c.rows || [c.row], on = cardMarked(c);
    for (const r of rows) if (S.marked.has(r.id) === on) await toggleMark(r, true);
    afterMarksChanged(); renderClean(); return;
  }
  const fr = t.closest('[data-free]') as HTMLElement;
  if (fr) { freeUp(S.clean![+fr.dataset.free!].row); return; }
  const lb = t.closest('[data-loc]') as HTMLElement; if (!lb) return;
  const r = S.clean![+lb.dataset.loc!].row; setTab('tree'); await locate(r); zoomToRow(r);
});

// ---------- Pestañas ----------
export function setTab(t: string) {
  S.tab = t;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String((b as HTMLElement).dataset.tab === t));
  for (const v of ['tree', 'files', 'clean', 'dups', 'changes', 'basket']) $('view-' + v).hidden = v !== t;
  if (t === 'tree') treeVL.paint();
  if (t === 'files') loadFiles();
  if (t === 'clean') renderClean();
  if (t === 'basket') renderBasket();
  if (t === 'dups') renderDups();
  if (t === 'changes') renderChanges();
}

// ---------- Duplicados ----------
// El motor compara tamaños, luego los primeros 64 KiB y por último el contenido completo de los candidatos.
// Desde aquí se marcan las copias para la cesta «Para borrar»; nada se borra sin pasar por ella.
const DUP_SIZES = [100 * 1024, 1024 ** 2, 10 * 1024 ** 2, 100 * 1024 ** 2], DUP_PAGE = 40;
const D = { result: null as DupResult | null, running: false, progress: null as DupProgress | null, all: false, min: 1024 ** 2, shown: DUP_PAGE };
const ICON_BOX = '<svg class="i" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>';
const ICON_CHECKED = '<svg class="i" viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2"/><path d="m5.5 8 1.8 1.8L10.8 6"/></svg>';
function resetDups() { D.result = null; D.progress = null; D.shown = DUP_PAGE; $('dupsCount').textContent = ''; }
function dupProgressHTML() {
  const p = D.progress, frac = !p ? 0 : p.totalBytes ? p.bytes / p.totalBytes : p.totalFiles ? p.files / p.totalFiles : 0;
  const phase = !p || p.phase === 'done' ? 'size' : p.phase;
  return `<div class="dp-phase"><b>${tx(('dups.phase.' + phase) as MessageKey)}</b><span>${esc(i18n.percent(Math.min(1, frac), 0))}</span></div>`
    + `<div class="scan-track"><i style="transform:scaleX(${Math.min(1, frac)})"></i></div>`
    + (p ? `<small>${tx('dups.progress.files', { files: p.files, totalFiles: p.totalFiles })}${p.totalBytes ? ' · ' + tx('dups.progress.bytes', { bytes: fmtB(p.bytes), totalBytes: fmtB(p.totalBytes) }) : ''}</small>` : '');
}
function dupGroupHTML(g: DupGroup) {
  const f0 = g.files[0], all = g.files.every(f => S.marked.has(f.id) || !!markedAncestor(f));
  return `<section class="dp-group${all ? ' warn' : ''}"><header><i class="sw" style="background:${rgb(rowColor(f0))}"></i><b title="${esc(f0.name)}">${esc(f0.name)}</b>`
    + `<span>${tx('dups.group', { count: g.files.length, size: fmtB(g.size), wasted: fmtB((g.files.length - 1) * g.size) })}</span></header>`
    + (all ? `<p class="dp-warn">${tx('dups.allMarked')}</p>` : '')
    + g.files.map(f => {
      const on = S.marked.has(f.id);
      return `<div class="dp-file${markClass(f)}${S.sel?.id === f.id ? ' sel' : ''}" data-id="${f.id}">`
        + `<button class="icon-btn sm dp-mk" type="button" data-dp="mk" aria-pressed="${on}" title="${tx(on ? 'mark.remove' : 'mark.add')}" aria-label="${tx(on ? 'mark.remove' : 'mark.add')}">${on ? ICON_CHECKED : ICON_BOX}</button>`
        + `<span class="dp-name"><span class="nm">${esc(f.name)}</span><code title="${esc(f.path)}">${esc(parentPath(f.path))}</code></span><span class="num">${fmtD(f.mtime)}</span></div>`;
    }).join('') + `</section>`;
}
function renderDups() {
  const el = $('dupsBody');
  if (!S.root) { el.innerHTML = `<div class="cl-loading">${tx('dups.noScan')}</div>`; return; }
  const z = zoomRow() || S.root, whole = z.id === S.root.id, all = D.all || whole;
  const controls = `<div class="dp-controls"><p class="dp-intro">${tx('dups.intro')}</p><div class="dp-row">`
    + `<span class="seg" role="group" aria-label="${tx('dups.scope')}"><button type="button" data-dp="scope" data-v="map" aria-pressed="${!all}"${whole ? ' disabled' : ''}>${tx('dups.scope.map', { name: nameOf(z) })}</button>`
    + `<button type="button" data-dp="scope" data-v="all" aria-pressed="${all}">${tx('dups.scope.all')}</button></span>`
    + `<label class="dp-min">${tx('dups.minSize')} <select data-dp="min"${D.running ? ' disabled' : ''}>${DUP_SIZES.map(s => `<option value="${s}"${s === D.min ? ' selected' : ''}>≥ ${esc(fmtB(s))}</option>`).join('')}</select></label>`
    + (D.running ? `<button class="btn sm" type="button" data-dp="cancel">${tx('header.cancel')}</button>`
      : `<button class="btn sm primary" type="button" data-dp="run"${S.scanning ? ' disabled' : ''}>${tx(D.result ? 'dups.searchAgain' : 'dups.search')}</button>`)
    + `</div></div>`;
  if (D.running) { el.innerHTML = controls + `<div class="dp-prog" id="dpProg">${dupProgressHTML()}</div>`; return; }
  const r = D.result; if (!r) { el.innerHTML = controls; return; }
  const skipped = r.skipped.hardlinks || r.skipped.cloud ? `<p class="note">${tx('dups.skipped', { hardlinks: r.skipped.hardlinks, cloud: r.skipped.cloud })}</p>` : '';
  const warns = r.warnings.map(w => `<p class="note">${esc(msgText(w))}</p>`).join('');
  if (!r.groups.length) { el.innerHTML = controls + `<div class="cl-loading">${tx('dups.none', { size: fmtB(D.min) })}</div>` + skipped + warns; return; }
  el.innerHTML = controls
    + `<div class="dp-sum"><div class="bk-sum"><b>${fmtB(r.wasted)}</b><span>${tx('dups.summary', { groups: r.totalGroups })}</span>`
    + `<small>${tx('dups.stats', { candidates: r.candidates, read: fmtB(r.readBytes), time: fmtS(r.elapsedMs) })}</small></div>`
    + `<div class="bk-acts"><button class="btn sm" type="button" data-dp="hl">${tx('dups.highlight')}</button><button class="btn sm danger" type="button" data-dp="mark">${tx('dups.markCopies')}</button></div></div>`
    + skipped + warns + (r.totalGroups > r.groups.length ? `<p class="note">${tx('dups.shown', { count: r.groups.length })}</p>` : '')
    + r.groups.slice(0, D.shown).map(dupGroupHTML).join('')
    + (r.groups.length > D.shown ? `<button class="btn sm dp-more" type="button" data-dp="more">${tx('dups.more', { count: Math.min(DUP_PAGE, r.groups.length - D.shown) })}</button>` : '');
}
async function runDups() {
  if (!S.root || D.running || S.scanning) return;
  const z = zoomRow() || S.root, root = D.all ? S.root.id : z.id;
  D.running = true; D.progress = null; renderDups();
  try {
    const r = await B.duplicates({ root, minSize: D.min, limit: 1000 }, p => {
      D.progress = p; const el = document.getElementById('dpProg'); if (el) el.innerHTML = dupProgressHTML();
    });
    for (const g of r.groups) for (const f of g.files) { remember(f); S.pathCache.set(f.id, f.path); }
    D.result = r; D.shown = DUP_PAGE; $('dupsCount').textContent = r.totalGroups ? fmtN(r.totalGroups) : '';
  } catch (e) {
    if ((e as { code?: string }).code !== 'error.cancelled') toast(t('toast.error', { error: msgText(e) }));
  } finally { D.running = false; if (S.tab === 'dups') renderDups(); }
}
/** Marca todas las copias menos una por grupo: se conserva la más antigua (a igualdad, la de ruta más corta). */
async function markCopies() {
  if (!D.result) return; let n = 0, bytes = 0;
  for (const g of D.result.groups) {
    const keep = [...g.files].sort((a, b) => a.mtime - b.mtime || a.path.length - b.path.length)[0];
    if (S.marked.has(keep.id)) await toggleMark(keep, true); // nunca se marcan todas las copias de un grupo
    for (const f of g.files) if (f.id !== keep.id && !S.marked.has(f.id)) {
      await toggleMark(f, true); if (S.marked.has(f.id)) { n++; bytes += f.size; }
    }
  }
  afterMarksChanged(); renderDups();
  toast(t('dups.marked', { count: n, size: fmtB(bytes) }));
}
/** Tras mover cosas a la papelera: quita de los resultados lo que estaba en esas rutas. */
function pruneDups(paths: string[]) {
  const r = D.result; if (!r || !paths.length) return;
  const dead = (p: string) => paths.some(g => isUnder(p, g));
  const waste = (gs: DupGroup[]) => gs.reduce((s, g) => s + (g.files.length - 1) * g.size, 0), before = waste(r.groups), n0 = r.groups.length;
  r.groups = r.groups.map(g => ({ ...g, files: g.files.filter(f => !dead(f.path)) })).filter(g => g.files.length > 1);
  r.wasted = Math.max(0, r.wasted - (before - waste(r.groups))); r.totalGroups = Math.max(0, r.totalGroups - (n0 - r.groups.length));
  $('dupsCount').textContent = r.totalGroups ? fmtN(r.totalGroups) : '';
  if (S.tab === 'dups') renderDups();
}
const dupFile = (id: number) => { for (const g of D.result?.groups || []) for (const f of g.files) if (f.id === id) return f; return null; };
$('dupsBody').addEventListener('click', async e => {
  const el = e.target as HTMLElement, b = el.closest('[data-dp]') as HTMLElement, row = el.closest('.dp-file') as HTMLElement;
  const f = row ? dupFile(+row.dataset.id!) : null;
  switch (b?.dataset.dp) {
    case 'run': runDups(); return;
    case 'cancel': B.cancelDuplicates().catch(err => toast(msgText(err))); return;
    case 'scope': D.all = b.dataset.v === 'all'; renderDups(); return;
    case 'more': D.shown += DUP_PAGE; renderDups(); return;
    case 'mark': markCopies(); return;
    case 'hl': {
      const ids = new Set<number>(); for (const g of D.result?.groups || []) for (const x of g.files) ids.add(x.id);
      setHL({ type: 'search', ids, query: '', count: ids.size }); return;
    }
    case 'mk': if (f) { await toggleMark(f); renderDups(); } return;
  }
  if (f) { select(f); if (e.ctrlKey || e.metaKey) { await toggleMark(f); } renderDups(); }
});
$('dupsBody').addEventListener('dblclick', e => {
  const row = (e.target as HTMLElement).closest('.dp-file') as HTMLElement, f = row ? dupFile(+row.dataset.id!) : null;
  if (f && !(e.target as HTMLElement).closest('[data-dp]')) { setTab('tree'); locate(f); }
});
$('dupsBody').addEventListener('change', e => {
  const s = (e.target as HTMLElement).closest('[data-dp="min"]') as HTMLSelectElement; if (s) D.min = +s.value;
});

// ---------- Historial y cambios ----------
// Tras cada escaneo se guarda un resumen (si está activado). «Comparar» activa la comparación en el motor: las filas
// traen prev/fresh, el árbol muestra la columna Δ y se puede ordenar por cambio. Un escaneo nuevo la quita.
const HIST_KEY = 'tesserafs-history';
const H = { entries: [] as HistoryEntry[], loaded: false, savedId: '', cmp: null as CompareResult | null, busy: false, confirmClear: false };
function autoHistory() { try { return localStorage.getItem(HIST_KEY) !== 'off'; } catch { return true; } }
const signedB = (d: number) => (d > 0 ? '+' : d < 0 ? '−' : '') + fmtB(Math.abs(d));
const signedN = (d: number) => (d > 0 ? '+' : d < 0 ? '−' : '') + fmtN(Math.abs(d));
function deltaHTML(r: NodeRow) {
  if (r.fresh) return `<span class="delta up">${tx('changes.new')}</span>`;
  const d = r.prev != null ? r.size - r.prev : 0; if (!d) return '';
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${esc(signedB(d))}</span>`;
}
const asRow = (r: ChangeRow): NodeRow => ({ ...r, prev: r.prev ?? undefined, fresh: r.prev === null ? true : undefined });
async function saveHistory() {
  try { const e = await B.historySave(); H.savedId = e.id; H.loaded = false; if (S.tab === 'changes') renderChanges(); }
  catch (e) { toast(msgText(e)); }
}
function resetChanges() {
  H.cmp = null; H.loaded = false; H.savedId = ''; H.confirmClear = false; $('treeTbl').classList.remove('cmp');
  if (S.sort.key === 'delta') { S.sort = { key: 'size', desc: true }; updateSortHead(); }
}
/** Las filas en caché no traen prev/fresh: al activar o quitar la comparación se vuelven a pedir. */
async function reloadRows() {
  S.kids.clear(); S.rowCache.clear();
  if (S.root) S.root = remember(await B.nodeInfo(S.root.id));
  S.chain = await Promise.all(S.chain.map(z => B.nodeInfo(z.id).then(remember).catch(() => z)));
  if (S.sel) { const id = S.sel.id; S.sel = await B.nodeInfo(id).then(remember).catch(() => S.sel); }
  await rebuildTree(); renderInspector(); renderStatus();
}
async function runCompare(id: string) {
  if (H.busy) return; H.busy = true; renderChanges();
  try {
    const c = await B.compare(id, 100);
    for (const r of [...c.grew, ...c.shrank]) S.pathCache.set(r.id, r.path);
    H.cmp = c; $('treeTbl').classList.add('cmp'); await reloadRows();
  } catch (e) { toast(t('toast.error', { error: msgText(e) })); }
  finally { H.busy = false; renderChanges(); }
}
async function stopCompare() {
  await B.compareClear().catch(() => { }); H.cmp = null; $('treeTbl').classList.remove('cmp');
  if (S.sort.key === 'delta') { S.sort = { key: 'size', desc: true }; updateSortHead(); }
  await reloadRows(); if (S.tab === 'changes') renderChanges();
}
function changeRowHTML(r: ChangeRow) {
  const icon = r.isDir ? FOLDER : `<i class="sw" style="background:${rgb(rowColor(asRow(r)))}"></i>`, d = r.size - (r.prev ?? 0);
  return `<div class="ch-row${S.sel?.id === r.id ? ' sel' : ''}" data-id="${r.id}">${icon}<span class="dp-name"><span class="nm">${esc(r.name)}${r.prev === null ? ` <span class="badge">${tx('changes.new')}</span>` : ''}</span><code title="${esc(r.path)}">${esc(parentPath(r.path))}</code></span>`
    + `<span class="num ch-was">${r.prev === null ? '' : esc(fmtB(r.prev)) + ' → '}${esc(fmtB(r.size))}</span><span class="num delta ${d >= 0 ? 'up' : 'down'}">${esc(signedB(d))}</span></div>`;
}
function removedRowHTML(r: RemovedRow) {
  const i = r.path.lastIndexOf(SYS.sep), icon = r.isDir ? FOLDER : `<i class="sw" style="background:${rgb(REST_COLOR)}"></i>`;
  return `<div class="ch-row gone">${icon}<span class="dp-name"><span class="nm">${esc(r.path.slice(i + 1))}</span><code title="${esc(r.path)}">${esc(parentPath(r.path))}</code></span>`
    + `<span class="num ch-was">${esc(fmtB(r.size))}</span><span class="num delta down">${esc(signedB(-r.size))}</span></div>`;
}
async function renderChanges() {
  const el = $('changesBody');
  if (!S.root || !S.scan) { el.innerHTML = `<div class="cl-loading">${tx('changes.noScan')}</div>`; return; }
  if (!H.loaded) { H.loaded = true; H.entries = await B.historyList().catch(() => []); }
  const root = pathKey(S.scan.rootPath), mine = H.entries.filter(e => pathKey(e.path) === root && e.id !== H.savedId), c = H.cmp;
  let h = `<p class="dp-intro">${tx('changes.intro')}</p>`;
  if (c) {
    const d = c.after.bytes - c.before.bytes;
    h += `<div class="dp-sum"><div class="bk-sum"><b class="delta ${d >= 0 ? 'up' : 'down'}">${esc(signedB(d))}</b><span>${tx('changes.since', { when: i18n.relative(c.entry.scannedAt), date: i18n.dateTime(c.entry.scannedAt) })}</span>`
      + `<small>${tx('changes.totals', { before: fmtB(c.before.bytes), after: fmtB(c.after.bytes), files: signedN(c.after.files - c.before.files) })}</small></div>`
      + `<div class="bk-acts"><button class="btn sm" type="button" data-ch="hl"${c.grew.length ? '' : ' disabled'}>${tx('changes.highlight')}</button><button class="btn sm" type="button" data-ch="stop">${tx('changes.stop')}</button></div></div>`
      + `<h3 class="ch-h">${tx('changes.grew')}</h3>` + (c.grew.length ? `<div class="ch-list">${c.grew.map(changeRowHTML).join('')}</div>` : `<p class="note">${tx('changes.nothing')}</p>`)
      + (c.shrank.length ? `<h3 class="ch-h">${tx('changes.shrank')}</h3><div class="ch-list">${c.shrank.map(changeRowHTML).join('')}</div>` : '')
      + (c.removed.length ? `<h3 class="ch-h">${tx('changes.removed')}</h3><div class="ch-list">${c.removed.map(removedRowHTML).join('')}</div>` : '');
  }
  h += `<h3 class="ch-h">${tx('changes.history')}</h3>`;
  h += mine.length ? `<div class="ch-list">` + mine.map(e => {
    const d = S.root!.size - e.bytes, on = c?.entry.id === e.id;
    return `<div class="ch-entry${on ? ' on' : ''}" data-entry="${esc(e.id)}"><span class="dp-name"><b>${esc(i18n.relative(e.scannedAt))}</b><code>${esc(i18n.dateTime(e.scannedAt))} · ${esc(fmtB(e.bytes))}</code></span>`
      + `<span class="num delta ${d >= 0 ? 'up' : 'down'}" title="${tx('changes.vsNow')}">${esc(signedB(d))}</span>`
      + `<button class="btn sm${on ? ' on' : ''}" type="button" data-ch="cmp"${H.busy ? ' disabled' : ''}>${tx(on ? 'changes.comparing' : 'changes.compare')}</button>`
      + `<button class="icon-btn sm" type="button" data-ch="del" title="${tx('changes.delete')}" aria-label="${tx('changes.delete')}">${ICON_X}</button></div>`;
  }).join('') + `</div>` : `<div class="cl-loading">${tx(H.savedId ? 'changes.firstSaved' : 'changes.none')}</div>`;
  h += `<div class="ch-foot"><label><input type="checkbox" data-ch="auto"${autoHistory() ? ' checked' : ''}> ${tx('changes.auto')}</label>`
    + (H.savedId ? '' : `<button class="btn sm" type="button" data-ch="save">${tx('changes.saveNow')}</button>`)
    + (H.confirmClear
      ? `<span class="ch-confirm">${tx('changes.clearConfirm', { count: H.entries.length })} <button class="btn sm" type="button" data-ch="clearNo">${tx('insp.cancel')}</button> <button class="btn sm danger solid" type="button" data-ch="clearYes">${tx('changes.clear')}</button></span>`
      : `<button class="btn sm danger" type="button" data-ch="clear"${H.entries.length ? '' : ' disabled'}>${tx('changes.clear')}</button>`)
    + `</div><p class="note">${tx('changes.where')}</p>`;
  el.innerHTML = h;
}
const changeRow = (id: number) => H.cmp ? [...H.cmp.grew, ...H.cmp.shrank].find(r => r.id === id) ?? null : null;
$('changesBody').addEventListener('click', async e => {
  const el = e.target as HTMLElement, b = el.closest('[data-ch]') as HTMLElement, entry = (el.closest('[data-entry]') as HTMLElement | null)?.dataset.entry;
  switch (b?.dataset.ch) {
    case 'cmp': if (entry) { if (H.cmp?.entry.id === entry) await stopCompare(); else await runCompare(entry); } return;
    case 'stop': await stopCompare(); return;
    case 'del':
      if (entry) { if (H.cmp?.entry.id === entry) await stopCompare(); await B.historyDelete(entry).catch(err => toast(msgText(err))); H.loaded = false; renderChanges(); }
      return;
    case 'hl': if (H.cmp) { const ids = new Set(H.cmp.grew.map(r => r.id)); setHL({ type: 'search', ids, query: '', count: ids.size }); } return;
    case 'save': await saveHistory(); renderChanges(); return;
    case 'clear': H.confirmClear = true; renderChanges(); return;
    case 'clearNo': H.confirmClear = false; renderChanges(); return;
    case 'clearYes': {
      H.confirmClear = false; if (H.cmp) await stopCompare();
      const n = await B.historyClear().catch(err => { toast(msgText(err)); return 0; });
      H.loaded = false; H.savedId = ''; toast(t('changes.cleared', { count: n })); renderChanges(); return;
    }
    case 'auto': return; // lo gestiona «change»
  }
  const row = el.closest('.ch-row') as HTMLElement | null, r = row ? changeRow(+row.dataset.id!) : null;
  if (r) { select(asRow(r)); renderChanges(); }
});
$('changesBody').addEventListener('dblclick', e => {
  const row = (e.target as HTMLElement).closest('.ch-row') as HTMLElement | null, r = row ? changeRow(+row.dataset.id!) : null;
  if (r) { setTab('tree'); locate(asRow(r)); }
});
$('changesBody').addEventListener('change', e => {
  const c = (e.target as HTMLElement).closest('[data-ch="auto"]') as HTMLInputElement | null; if (!c) return;
  try { localStorage.setItem(HIST_KEY, c.checked ? 'on' : 'off'); } catch { }
  if (c.checked && !H.savedId && S.root) saveHistory(); else renderChanges();
});

// ---------- Exportar: CSV, JSON, informe HTML y mapa PNG (a Descargas\TesseraFS) ----------
const stamp = () => { const d = new Date(), p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
const isoDate = (s: number) => s ? new Date(s * 1000).toISOString().slice(0, 19).replace('T', ' ') : '';
const VIEW_KEY: Record<string, MessageKey> = {
  tree: 'export.view.tree', files: 'export.view.files', clean: 'export.view.clean', dups: 'export.view.dups', changes: 'export.view.changes', basket: 'export.view.basket',
};
async function saveExport(name: string, data: string, base64 = false) {
  try {
    const r = await B.exportFile(name, data, base64);
    toast(t('export.saved', { name: r.path }), B.kind === 'demo' ? undefined : {
      label: t('export.show'), run: () => { B.revealExport(r.path).then(x => { if (!x.ok) toast(msgText(x)); }).catch(err => toast(msgText(err))); },
    });
  } catch (e) { toast(t('toast.error', { error: msgText(e) })); }
}
interface Table { name: string; cols: string[]; rows: (string | number)[][]; items: unknown }
/** CSV para Excel: UTF-8 con BOM y «;» si el idioma usa coma decimal. Tamaños en bytes y fechas ISO. */
function csv(tb: Table) {
  const sep = i18n.percent(.5).includes(',') || i18n.number(1.5).includes(',') ? ';' : ',';
  const cell = (v: string | number) => { const s = String(v); return /[";,\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return '\ufeff' + [tb.cols, ...tb.rows].map(r => r.map(cell).join(sep)).join('\r\n') + '\r\n';
}
async function currentTable(): Promise<Table | null> {
  const kind = (r: NodeRow) => t(r.isDir ? 'export.kind.dir' : 'export.kind.file');
  const base = [t('export.col.path'), t('tree.col.name'), t('export.col.kind'), t('export.col.bytes'), t('export.col.alloc'), t('tree.col.modified')];
  const line = (r: NodeRow, path: string) => [path, r.name, kind(r), r.size, r.alloc, isoDate(r.mtime)];
  switch (S.tab) {
    case 'tree': {
      const z = zoomRow(); if (!z) return null;
      const [res, zp] = await Promise.all([B.children({ id: z.id, offset: 0, limit: 10000, sort: 'size', desc: true }), pathOf(z.id)]);
      const rows = res.rows.map(r => ({ ...r, path: joinPath(zp, r.name) }));
      return { name: 'folder', cols: [...base, t('insp.files'), t('insp.folders')], rows: rows.map(r => [...line(r, r.path), r.files, r.dirs]), items: rows };
    }
    case 'files': return { name: 'files', cols: base, rows: S.files.map(r => line(r, r.path)), items: S.files };
    case 'clean': {
      if (!S.clean) await loadClean(); const L = S.clean || [];
      return { name: 'cleanup', cols: [t('export.col.title'), t('export.col.risk'), t('export.col.path'), t('export.col.bytes'), t('export.col.command')],
        rows: L.map(c => [keyText(c.title), riskName(c.rule.risk), c.path, c.row.size, c.cmd || '']),
        items: L.map(c => ({ rule: c.rule.id, title: keyText(c.title), risk: c.rule.risk, path: c.path, size: c.row.size, command: c.cmd ?? null, files: c.count ?? null })) };
    }
    case 'dups': {
      const r = D.result; if (!r) return null; const rows: (string | number)[][] = [];
      r.groups.forEach((g, i) => g.files.forEach(f => rows.push([i + 1, f.path, g.size, isoDate(f.mtime), g.hash])));
      return { name: 'duplicates', cols: [t('export.col.group'), t('export.col.path'), t('export.col.bytes'), t('tree.col.modified'), 'hash'], rows, items: r };
    }
    case 'changes': {
      const c = H.cmp; if (!c) return null; const rows: (string | number)[][] = [];
      const ch = (k: string, r: ChangeRow) => rows.push([k, r.path, r.prev ?? '', r.size, r.size - (r.prev ?? 0)]);
      c.grew.forEach(r => ch(t('export.change.grew'), r)); c.shrank.forEach(r => ch(t('export.change.shrank'), r));
      c.removed.forEach(r => rows.push([t('export.change.removed'), r.path, r.size, 0, -r.size]));
      return { name: 'changes', cols: [t('export.col.change'), t('export.col.path'), t('export.col.before'), t('export.col.after'), t('export.col.delta')], rows, items: c };
    }
    case 'basket': {
      const L = [...S.marked.values()];
      return { name: 'to-delete', cols: base, rows: L.map(m => line(m.row, m.path)), items: L.map(m => ({ ...m.row, path: m.path })) };
    }
  }
  return null;
}
const REPORT_CSS = `:root{color-scheme:light}body{margin:0;padding:32px clamp(16px,4vw,48px);font:14px/1.5 system-ui,"Segoe UI",sans-serif;color:#1d2125;background:#f6f7f8}
main{max-width:1000px;margin:auto}h1{margin:0;font-size:26px}h2{margin:32px 0 10px;font-size:18px}.meta{color:#5d666d;margin:4px 0 20px}
.kpi{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.kpi div{padding:12px 14px;background:#fff;border:1px solid #dde2e6;border-radius:10px}
.kpi b{display:block;font-size:20px}.kpi span{color:#5d666d;font-size:12px}figure{margin:16px 0;background:#fff;border:1px solid #dde2e6;border-radius:10px;padding:8px}
figure img{width:100%;display:block;border-radius:6px}figcaption{color:#5d666d;font-size:12px;padding:6px 4px 0}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #dde2e6;border-radius:10px;overflow:hidden}th,td{padding:7px 10px;border-bottom:1px solid #eef1f3;text-align:left;vertical-align:top}
th{font-size:12px;color:#5d666d;font-weight:600;background:#fafbfc}td.n{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}td small{display:block;color:#7b848b;word-break:break-all}
.bar{display:inline-block;width:90px;height:6px;border-radius:3px;background:#e8ecef;vertical-align:middle;margin-left:8px;overflow:hidden}.bar i{display:block;height:100%}
.sw{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}.up{color:#b4471f}.down{color:#1b7f47}
.risk{font-size:11px;padding:1px 6px;border-radius:9px;background:#eef1f3}.risk.ok{color:#1b7f47}.risk.warn{color:#8a5a00}.risk.bad{color:#b42318}
footer{margin:36px 0 0;color:#7b848b;font-size:12px}@media print{body{background:#fff;padding:0}figure,table,.kpi div{break-inside:avoid}}`;
async function buildReport(): Promise<string> {
  const root = S.root!, scan = S.scan!, z = zoomRow() || root;
  const [kids, top, ext] = await Promise.all([
    B.children({ id: root.id, offset: 0, limit: 15, sort: 'size', desc: true }), B.search({ query: '', root: root.id, limit: 25 }), B.extStats(root.id),
  ]);
  if (!S.clean) await loadClean().catch(() => { });
  const pct = (x: number) => esc(fmtP(x)), total = root.size || 1;
  const bar = (f: number, color: string) => `<span class="bar"><i style="width:${(Math.min(1, f) * 100).toFixed(1)}%;background:${color}"></i></span>`;
  const table = (head: string[], rows: string[][]) => `<table><thead><tr>${head.map((h, i) => `<th${i ? ' style="text-align:right"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const cats = new Map<string, { size: number; count: number }>();
  for (const e of ext) { const c = categoryOf(e.ext); const g = cats.get(c.id) || { size: 0, count: 0 }; g.size += e.size; g.count += e.count; cats.set(c.id, g); }
  const v = scan.volume;
  let h = `<h1>${tx('report.title')}</h1><p class="meta">${tx('report.meta', { path: scan.rootPath, engine: t(scan.engine === 'mft' ? 'header.engine.mft' : 'header.engine.walk'), time: fmtS(scan.elapsedMs), date: i18n.dateTime(Date.now() / 1000) })}</p>`
    + `<div class="kpi"><div><b>${esc(fmtB(root.size))}</b><span>${tx('tree.col.size')}</span></div><div><b>${esc(fmtN(root.files))}</b><span>${tx('insp.files')}</span></div>`
    + `<div><b>${esc(fmtN(root.dirs))}</b><span>${tx('insp.folders')}</span></div>`
    + (v && v.total ? `<div><b>${esc(fmtB(v.free))}</b><span>${tx('report.free', { total: fmtB(v.total) })}</span></div>` : '') + `</div>`
    + (S.slice ? `<figure><img alt="" src="${mapC.toDataURL('image/png')}"><figcaption>${tx('report.map', { folder: S.pathCache.get(z.id) || nameOf(z) })}</figcaption></figure>` : '')
    + `<h2>${tx('comp.title.category')}</h2>` + table([t('report.category'), t('insp.files'), t('tree.col.size'), '%'],
      [...cats.entries()].sort((a, b) => b[1].size - a[1].size).map(([id, g]) => { const c = categoryById(id);
        return [`<span class="sw" style="background:${rgb(c.color)}"></span>${esc(catName(c))}`, esc(fmtN(g.count)), esc(fmtB(g.size)), pct(g.size / total) + bar(g.size / total, rgb(c.color))]; }))
    + `<h2>${tx('report.topFolders')}</h2>` + table([t('tree.col.name'), t('tree.col.size'), '%'],
      kids.rows.map(r => [`${esc(r.name)}${r.isDir ? SYS.sep : ''}`, esc(fmtB(r.size)), pct(r.size / total) + bar(r.size / total, '#5a7fd6')]))
    + `<h2>${tx('report.topFiles')}</h2>` + table([t('tree.col.name'), t('tree.col.size'), t('tree.col.modified')],
      top.rows.map(r => [`${esc(r.name)}<small>${esc(parentPath(r.path))}</small>`, esc(fmtB(r.size)), esc(fmtD(r.mtime))]));
  if (S.clean?.length) {
    const sum = (k: Risk) => S.clean!.filter(c => c.rule.risk === k).reduce((s, c) => s + c.row.size, 0);
    h += `<h2>${tx('tab.clean')}</h2><div class="kpi">${(['ok', 'warn', 'bad'] as Risk[]).map(k => `<div><b>${esc(fmtB(sum(k)))}</b><span class="risk ${k}">${esc(riskName(k))}</span></div>`).join('')}</div><br>`
      + table([t('export.col.title'), t('tree.col.size'), t('export.col.risk')],
        S.clean.slice(0, 12).map(c => [`${esc(keyText(c.title))}<small>${esc(c.path)}</small>`, esc(fmtB(c.row.size)), `<span class="risk ${c.rule.risk}">${esc(riskName(c.rule.risk))}</span>`]));
  }
  if (D.result?.groups.length) {
    const r = D.result;
    h += `<h2>${tx('tab.dups')}</h2><p>${tx('report.dups', { wasted: fmtB(r.wasted), groups: r.totalGroups })}</p>`
      + table([t('tree.col.name'), t('export.col.copies'), t('dups.recoverable')],
        r.groups.slice(0, 12).map(g => [`${esc(g.files[0].name)}<small>${g.files.map(f => esc(parentPath(f.path))).join('<br>')}</small>`, esc(fmtN(g.files.length)), esc(fmtB((g.files.length - 1) * g.size))]));
  }
  if (H.cmp) {
    const c = H.cmp, d = c.after.bytes - c.before.bytes;
    h += `<h2>${tx('report.changes', { date: i18n.dateTime(c.entry.scannedAt) })}</h2><p><b class="${d >= 0 ? 'up' : 'down'}">${esc(signedB(d))}</b> · ${tx('changes.totals', { before: fmtB(c.before.bytes), after: fmtB(c.after.bytes), files: signedN(c.after.files - c.before.files) })}</p>`
      + table([t('tree.col.name'), t('export.col.before'), t('export.col.after'), 'Δ'],
        [...c.grew.slice(0, 12).map(r => [`${esc(r.name)}<small>${esc(parentPath(r.path))}</small>`, r.prev === null ? esc(t('changes.new')) : esc(fmtB(r.prev)), esc(fmtB(r.size)), `<span class="up">${esc(signedB(r.size - (r.prev ?? 0)))}</span>`]),
         ...c.removed.slice(0, 6).map(r => [`${esc(r.path)}`, esc(fmtB(r.size)), '—', `<span class="down">${esc(signedB(-r.size))}</span>`])]);
  }
  h += `<footer>${tx('report.footer', { version: VERSION })}</footer>`;
  return `<!doctype html><html lang="${esc(document.documentElement.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${tx('report.title')} · ${esc(scan.rootPath)}</title><style>${REPORT_CSS}</style></head><body><main>${h}</main></body></html>`;
}
async function runExport(kind: string) {
  if (!S.root) return;
  if (kind === 'png') return saveExport(`TesseraFS-map-${stamp()}.png`, mapC.toDataURL('image/png').split(',')[1], true);
  if (kind === 'report') { toast(t('export.building')); return saveExport(`TesseraFS-report-${stamp()}.html`, await buildReport()); }
  const tb = await currentTable(); if (!tb) return;
  if (kind === 'csv') return saveExport(`TesseraFS-${tb.name}-${stamp()}.csv`, csv(tb));
  return saveExport(`TesseraFS-${tb.name}-${stamp()}.json`,
    JSON.stringify({ app: 'TesseraFS', version: VERSION, exportedAt: new Date().toISOString(), root: S.scan?.rootPath ?? null, view: S.tab, items: tb.items }, null, 2));
}
$('exportBtn').addEventListener('click', e => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect(), has = !!S.root && !S.scanning;
  const listOk = has && (S.tab !== 'dups' || !!D.result) && (S.tab !== 'changes' || !!H.cmp);
  openMenu(`<div class="menu-h">${tx('export.menu')}</div>`
    + `<button type="button" role="menuitem" data-m="report"${has ? '' : ' disabled'}>${tx('export.report')}<span>HTML</span></button>`
    + `<button type="button" role="menuitem" data-m="png"${has && S.slice ? '' : ' disabled'}>${tx('export.png')}<span>PNG</span></button><hr>`
    + `<div class="menu-h">${tx('export.list', { view: tk(VIEW_KEY[S.tab] ?? 'export.view.tree') })}</div>`
    + `<button type="button" role="menuitem" data-m="csv"${listOk ? '' : ' disabled'}>${tx('export.csv')}<span>CSV</span></button>`
    + `<button type="button" role="menuitem" data-m="json"${listOk ? '' : ' disabled'}>${tx('export.json')}<span>JSON</span></button>`,
    r.left, r.bottom + 6, 'export');
});

// ---------- Cesta «Para borrar» ----------
// Se marca con Ctrl+clic (mapa y listas), Espacio (listas), el panel de detalle, el menú o las tarjetas de limpieza.
// No se cuenta dos veces: marcar una carpeta quita lo marcado dentro de ella, y lo que ya está dentro de una carpeta marcada no se añade.
/** `p` está dentro de la carpeta `dir` (no es ella misma). */
const inside = (p: string, dir: string) => pathKey(p) !== pathKey(dir) && isUnder(p, dir);
function markedAncestor(r: NodeRow): Marked | null {
  const p = S.pathCache.get(r.id);
  if (p) { for (const m of S.marked.values()) if (m.row.isDir && m.row.id !== r.id && inside(p, m.path)) return m; return null; }
  for (let id = r.parentId; id >= 0; id = S.rowCache.get(id)?.parentId ?? -1) { const m = S.marked.get(id); if (m) return m; }
  return null;
}
const markClass = (r: NodeRow) => S.marked.has(r.id) ? ' marked' : S.marked.size && markedAncestor(r) ? ' marked-in' : '';
const cardMarked = (c: CleanCard) => (c.rows || [c.row]).every(r => S.marked.has(r.id));
/** `quiet`: sin repintar ni avisos (marcado por lotes desde una tarjeta). */
async function toggleMark(r: NodeRow, quiet = false) {
  if (r.parentId < 0) return; // la raíz del escaneo no se borra
  if (S.marked.has(r.id)) { S.marked.delete(r.id); if (!quiet) afterMarksChanged(); return; }
  const path = await pathOf(r.id).catch(() => ''); if (!path) return;
  for (const m of S.marked.values()) if (m.row.isDir && inside(path, m.path)) { if (!quiet) toast(t('basket.alreadyIn', { name: m.row.name })); return; }
  if (r.isDir) for (const [id, m] of S.marked) if (inside(m.path, path)) S.marked.delete(id);
  S.marked.set(r.id, { row: remember(r), path });
  S.basketConfirm = false;
  if (!quiet) afterMarksChanged();
}
function afterMarksChanged() {
  renderBasketCount(); treeVL.paint(); filesVL.paint(); drawOverlay(); renderInspector();
  if (S.tab === 'basket') renderBasket();
}
const markedBytes = () => [...S.marked.values()].reduce((s, m) => s + m.row.size, 0);
function renderBasketCount() {
  const n = S.marked.size, chip = $('basketChip');
  $('basketCount').textContent = n ? fmtN(n) : '';
  chip.hidden = !n; if (n) chip.textContent = t('basket.chip', { count: n, size: fmtB(markedBytes()) });
}
const ICON_X = '<svg class="i" viewBox="0 0 16 16"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
function renderBasket() {
  const el = $('basketBody'), list = [...S.marked.values()].sort((a, b) => b.row.size - a.row.size);
  if (!list.length) { el.innerHTML = `<div class="cl-loading">${html('basket.empty')}</div>`; return; }
  const total = markedBytes(), n = list.length;
  const acts = S.basketConfirm
    ? `<div class="confirm"><p>${tx('basket.confirm', { count: n, size: fmtB(total) })}</p><div><button class="btn sm" type="button" data-bk="cancel">${tx('insp.cancel')}</button><button class="btn sm danger solid" type="button" data-bk="go">${tx('insp.trashConfirm')}</button></div></div>`
    : `<div class="bk-acts"><button class="btn sm" type="button" data-bk="clear"${S.basketBusy ? ' disabled' : ''}>${tx('basket.clear')}</button><button class="btn sm danger solid" type="button" data-bk="trash"${S.basketBusy ? ' disabled' : ''}>${tx('basket.trashAll')}</button></div>`;
  el.innerHTML = `<div class="bk-head"><div class="bk-sum"><b>${fmtB(total)}</b><span>${tx('basket.total', { count: n })}</span></div>${acts}</div>`
    + `<div class="bk-list">` + list.map(m => {
      const icon = m.row.isDir ? FOLDER : `<i class="sw" style="background:${rgb(rowColor(m.row))}"></i>`;
      return `<div class="bk-row${m.error ? ' err' : ''}${S.sel?.id === m.row.id ? ' sel' : ''}" data-id="${m.row.id}">${icon}`
        + `<span class="bk-name"><b title="${esc(m.path)}">${esc(m.row.name)}</b><code>${esc(parentPath(m.path))}</code>${m.error ? `<small class="bk-err">${esc(m.error)}</small>` : ''}</span>`
        + `<span class="num">${fmtB(m.row.size)}</span><button class="icon-btn sm" type="button" data-bk="rm" title="${tx('basket.remove')}" aria-label="${tx('basket.remove')}"${S.basketBusy ? ' disabled' : ''}>${ICON_X}</button></div>`;
    }).join('') + `</div>`;
}
/** Mueve todo lo marcado a la Papelera, de uno en uno para informar de cada fallo, y refresca el árbol una sola vez. */
async function trashMarked() {
  const list = [...S.marked.values()].sort((a, b) => b.row.size - a.row.size); if (!list.length) return;
  S.basketConfirm = false; S.basketBusy = true; renderBasket();
  let moved = 0, failed = 0, bytes = 0;
  const movedPaths: string[] = [];
  for (const [i, m] of list.entries()) {
    toast(t('basket.progress', { done: i + 1, total: list.length }));
    try {
      const res = await B.action('trash', m.row.id);
      if (res.ok) { moved++; bytes += m.row.size; S.marked.delete(m.row.id); movedPaths.push(m.path); }
      else { failed++; m.error = res.code ? msgText(res) : res.message || t('toast.actionFailed'); }
    } catch (e) { failed++; m.error = msgText(e); }
  }
  S.basketBusy = false;
  if (moved) { pruneDups(movedPaths); await refreshAfterChange(null); }
  toast(failed ? t('basket.partial', { moved, failed }) : t('basket.done', { count: moved, size: fmtB(bytes) }));
  afterMarksChanged();
}
$('basketBody').addEventListener('click', e => {
  const t = e.target as HTMLElement, b = t.closest('[data-bk]') as HTMLElement;
  const row = t.closest('.bk-row') as HTMLElement, m = row ? S.marked.get(+row.dataset.id!) : undefined;
  switch (b?.dataset.bk) {
    case 'rm': if (m) { S.marked.delete(m.row.id); afterMarksChanged(); } return;
    case 'clear': S.marked.clear(); S.basketConfirm = false; afterMarksChanged(); return;
    case 'trash': S.basketConfirm = true; renderBasket(); ($('basketBody').querySelector('[data-bk="go"]') as HTMLElement)?.focus(); return;
    case 'cancel': S.basketConfirm = false; renderBasket(); return;
    case 'go': trashMarked(); return;
  }
  if (m) select(m.row);
});
$('basketBody').addEventListener('dblclick', e => {
  const row = (e.target as HTMLElement).closest('.bk-row') as HTMLElement, m = row ? S.marked.get(+row.dataset.id!) : undefined;
  if (m && !(e.target as HTMLElement).closest('[data-bk]')) { setTab('tree'); locate(m.row); }
});
$('basketChip').addEventListener('click', () => setTab('basket'));
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
    + (can('reveal') ? `<button type="button" role="menuitem" data-m="reveal">${tx('menu.reveal')}</button>` : '')
    + `<button type="button" role="menuitem" data-m="copy">${tx('menu.copyPath')}</button>`
    + `<button type="button" role="menuitem" data-m="zoom">${tx('menu.zoom')}</button>`
    + `<button type="button" role="menuitem" data-m="tree">${tx('menu.locate')}</button><hr>`
    + (r.parentId >= 0 ? `<button type="button" role="menuitem" data-m="mark">${tx(S.marked.has(r.id) ? 'mark.remove' : 'mark.add')}<span>${tx('key.space')}</span></button>` : '')
    + (r.isDir ? `<button type="button" role="menuitem" data-m="rescan">${tx('menu.rescan')}<span>${r.parentId < 0 || (zoomRow()?.id === r.id) ? tx('key.f5') : ''}</span></button>` : '')
    + (canFreeUp(r) ? `<button type="button" role="menuitem" data-m="freeUp">${tx('menu.freeUp')}</button>` : '')
    + (can('properties') ? `<button type="button" role="menuitem" data-m="properties">${tx('menu.properties')}</button>` : '')
    + (can('trash') ? `<button type="button" role="menuitem" data-m="trash" class="danger">${tx('menu.trash')}<span>${tx('key.delete')}</span></button>` : ''), x, y, 'node', r.id);
}
function volLabel(v: VolumeInfo) { return `${trimSep(v.path)} ${v.label || t('header.drive.local')}`; }
$('volBtn').addEventListener('click', e => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMenu(`<div class="menu-h">${tx('menu.drives')}</div>`
    + S.vols.map((v, i) => `<button type="button" role="menuitem" data-m="vol" data-v="${i}"${S.vol === v ? ' class="on"' : ''}>${esc(volLabel(v))}<span>${esc(v.fs)} · ${fmtB(v.total)}</span></button>`).join('')
    + `<hr><div class="menu-h">${tx('menu.analyzeFolder')}</div><form id="folderForm"><input id="folderIn" placeholder="${esc(folderHint())}" value="${esc(S.target)}" aria-label="${tx('menu.folderPath')}"><button class="btn sm" type="submit">${tx('menu.analyze')}</button></form>`,
    r.left, r.bottom + 6, 'vol');
});
menu.addEventListener('submit', e => {
  e.preventDefault();
  if ((e.target as HTMLElement).id === 'saveSearchForm') {
    const query = q.value.trim(), name = ($('saveSearchName') as HTMLInputElement).value.trim() || query; if (!query) return;
    storeSearches([...savedSearches().filter(s => s.q !== query), { name, q: query }]);
    closeMenus(); toast(t('toast.searchSaved', { name })); return;
  }
  const v = ($('folderIn') as HTMLInputElement).value.trim(); if (!v) return;
  closeMenus(); analyzeFolder(v);
});
menu.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest('button[data-m]') as HTMLElement; if (!b) return;
  const m = b.dataset.m!, kind = menu.dataset.kind; closeMenus();
  if (kind === 'vol') { if (m === 'vol') { S.vol = S.vols[+b.dataset.v!]; S.target = S.vol.path; renderVolume(); startScan(); } return; }
  if (kind === 'lang') { setPreference(b.dataset.v!); return; }
  if (kind === 'export') { runExport(m); return; }
  if (kind === 'discover') {
    if (m === 'q') setQuery(b.dataset.q!);
    else if (m === 'del') storeSearches(savedSearches().filter((_, i) => i !== +b.dataset.i!));
    return;
  }
  rowOf(+menu.dataset.id!).then(r => {
    switch (m) {
      case 'open': case 'reveal': case 'properties': doAction(m, r); break;
      case 'copy': pathOf(r.id).then(p => copyText(p, 'toast.pathCopied')); break;
      case 'zoom': zoomToRow(r); break;
      case 'tree': setTab('tree'); locate(r); break;
      case 'rescan': rescanFolder(r); break;
      case 'freeUp': freeUp(r); break;
      case 'trash': select(r); S.confirmTrash = true; renderInspector(); break;
      case 'mark': toggleMark(r); break;
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
  const v = S.vol, folder = !v || pathKey(S.target) !== pathKey(v.path);
  $('volLetter').textContent = v ? volTag(v) : '—';
  $('volName').textContent = folder ? baseName(S.target) : (v!.label || t('header.drive.local'));
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
  return pathKey(S.target) === pathKey(v.path) ? v.total - v.free : 0;
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
  if (S.scanning) return;
  if (D.running) { toast(t('engine.error.dupBusy')); return; } S.scanning = true; closeMenus(); tip.hidden = true;
  // Durante el escaneo el botón principal pasa a Cancelar
  const btn = $('scanBtn') as HTMLButtonElement; btn.disabled = false; btn.classList.add('cancel'); btn.querySelector('span')!.textContent = t('header.cancel');
  $('scanBar').hidden = !expectedBytes(); ($('scanBar').firstElementChild as HTMLElement).style.transform = 'scaleX(0)';
  scanCard = null; showProgress({ phase: 'starting', entries: 0, bytes: 0, elapsedMs: 0 });
  try {
    const res = await B.scan({ path: S.target, engine: 'auto' }, showProgress);
    S.scan = res; S.kids.clear(); S.rowCache.clear(); S.pathCache.clear(); S.clean = null; S.marked.clear(); S.basketConfirm = false; renderBasketCount(); S.known.clear(); resetDups(); resetChanges(); S.hl = null; $('hlChip').hidden = true; S.query = ''; q.value = '';
    S.root = remember(await B.nodeInfo(res.rootId)); S.pathCache.set(res.rootId, res.rootPath);
    S.chain = [S.root]; S.expanded = new Set([S.root.id]); S.slice = null;
    if (res.volume) { S.vol = S.vols.find(v => v.path === res.volume!.path) || res.volume; }
    const ext = await B.extStats(S.root.id); setExtRanking(ext.map(e => e.ext)); S.ext = ext;
    $('enginePill').hidden = false; renderScanSummary(); renderRefreshBtn();
    renderVolume(); updateCrumbs(); renderComposition();
    await rebuildTree(); await loadSlice(true);
    fadeMapState(); wrap.classList.remove('reveal'); void wrap.offsetWidth; wrap.classList.add('reveal');
    const big = await B.search({ query: '', root: S.root.id, limit: 1 });
    if (big.rows[0]) { S.pathCache.set(big.rows[0].id, big.rows[0].path); await locate(remember(big.rows[0])); } else select(S.root);
    $('cleanCount').textContent = ''; if (S.tab === 'clean') renderClean(); if (S.tab === 'files') loadFiles();
    if (res.warnings.length && B.kind !== 'demo') toast(res.warnings.map(msgText).join(' · '));
    applyHash();
    if (autoHistory()) saveHistory();
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
  S.scan = null; S.root = null; S.chain = []; S.slice = null; S.sel = null; S.hl = null; S.clean = null; S.files = []; S.ext = []; resetChanges();
  S.kids.clear(); S.rowCache.clear(); S.pathCache.clear(); S.expanded.clear();
  $('enginePill').hidden = true; $('scanTxt').textContent = ''; $('refreshBtn').hidden = true; $('hlChip').hidden = true; $('cleanCount').textContent = ''; $('filesCount').textContent = '';
  await rebuildTree(); renderMap(); updateCrumbs(); renderComposition(); renderInspector(); renderStatus(); filesVL.setCount(0);
  if (S.tab === 'clean') renderClean();
  showDrives();
}
// Pantalla inicial: todas las unidades con su uso, y una carpeta concreta
function drivesHTML() {
  const cards = S.vols.map((v, i) => {
    const used = v.total ? (v.total - v.free) / v.total : 0;
    return `<button class="drive-card${S.vol === v ? ' on' : ''}" type="button" data-vol="${i}">`
      + `<span class="dc-letter">${esc(volTag(v))}</span>`
      + `<span class="dc-body"><span class="dc-name"><b>${esc(v.label || t('header.drive.local'))}</b><small>${esc(v.fs)}${v.total ? ' · ' + esc(i18n.percent(used, 0)) : ''}</small></span>`
      + `<span class="meter"><i class="used" style="width:${(used * 100).toFixed(1)}%;background:${used > .85 ? 'var(--warn)' : 'var(--accent)'}"></i></span>`
      + (v.total ? `<small>${tx('header.drive.free', { free: fmtB(v.free), total: fmtB(v.total) })}</small>` : '') + `</span></button>`;
  }).join('');
  return `<h2>${tx('state.choose.title')}</h2><p>${tx('state.choose.body')}</p>`
    + (cards ? `<div class="drive-grid">${cards}</div>` : `<p class="note">${tx('drives.empty')}</p>`)
    + `<form class="drive-folder" data-form="folder"><input name="path" placeholder="${esc(folderHint())}" value="${esc(S.target)}" aria-label="${tx('menu.folderPath')}" spellcheck="false"><button class="btn sm" type="submit">${tx('menu.analyze')}</button></form>`;
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
// ---------- Volver a escanear una carpeta y actualizar (diario USN) ----------
// Mientras dura, la app se comporta como durante un escaneo (S.scanning) pero sin tapar el mapa: el progreso va en la cabecera.
async function partial<R extends { before: number; elapsedMs: number }>(label: (p: ScanProgress) => string,
  run: (onProgress: (p: ScanProgress) => void) => Promise<R>, done: (r: R) => string, sel: NodeRow | null) {
  if (!S.root || S.scanning || D.running) return;
  S.scanning = true; closeMenus(); tip.hidden = true;
  const btn = $('scanBtn') as HTMLButtonElement; btn.classList.add('cancel'); btn.querySelector('span')!.textContent = t('header.cancel');
  const hadCmp = !!H.cmp;
  try {
    const r = await run(p => { $('scanTxt').textContent = label(p); });
    resetDups(); if (hadCmp) resetChanges();
    await refreshAfterChange(sel);
    toast(done(r) + (hadCmp ? ' · ' + t('update.compareOff') : ''));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'refresh.journalReset') { toast(msgText(e)); S.scanning = false; btn.classList.remove('cancel'); btn.querySelector('span')!.textContent = t('header.scan'); renderScanSummary(); startScan(); return; }
    toast(code === 'error.cancelled' ? t('update.cancelled') : t('toast.error', { error: msgText(e) }));
  } finally {
    if (S.scanning) { S.scanning = false; btn.classList.remove('cancel'); btn.querySelector('span')!.textContent = t('header.scan'); renderScanSummary(); renderStatus(); }
  }
}
/** Vuelve a escanear una carpeta; la raíz se escanea entera. */
function rescanFolder(r: NodeRow) {
  if (!r.isDir) return;
  if (r.parentId < 0) { startScan(); return; }
  const name = nameOf(r);
  partial(p => t('update.rescanProgress', { name, count: p.entries }), cb => B.rescan(r.id, cb),
    res => t('update.rescanDone', { name, delta: signedB(res.row.size - res.before), time: fmtS(res.elapsedMs) }), r);
}
/** Lo que haya cambiado desde el escaneo, según el diario USN (escritorio con administrador). */
function refreshChanges() {
  partial(p => t('update.refreshProgress', { count: p.entries }), cb => B.refresh(cb),
    res => t('update.refreshDone', { folders: res.folders, delta: signedB(res.after - res.before), time: fmtS(res.elapsedMs) }), null);
}
/** F5: lo más rápido disponible: el diario USN, la carpeta del mapa o un escaneo completo. */
function quickUpdate() {
  if (S.scanning || D.running) return;
  if (!S.root) { startScan(); return; }
  if (S.scan?.canRefresh) { refreshChanges(); return; }
  const z = zoomRow(); if (z && z.parentId >= 0) rescanFolder(z); else startScan();
}
function renderRefreshBtn() { $('refreshBtn').hidden = !S.scan?.canRefresh; }
$('refreshBtn').addEventListener('click', () => refreshChanges());
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
  if (has('duplicates', 'duplicados')) setTab('dups');
  if (has('changes', 'cambios')) setTab('changes');
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
// F5 actualiza en lugar de recargar la página (la portable es una ventana de Edge)
document.addEventListener('keydown', e => { if (e.key === 'F5' && !e.ctrlKey) { e.preventDefault(); quickUpdate(); } });
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
  renderBasketCount(); if (S.tab === 'basket') renderBasket();
  if (S.tab === 'dups') renderDups();
  if (S.tab === 'changes') renderChanges();
}
export async function startApp(backend: Backend) {
  B = backend;
  try { setSystem(await B.system()); } catch { /* motor sin `system`: se supone Windows */ }
  document.documentElement.dataset.os = SYS.os;
  translateDom(); onLocaleChange(relocalize);
  renderEdition(); applyTheme(); updateSortHead(); renderInspector(); renderComposition();
  try { S.vols = await B.volumes(); } catch (e) { toast(t('toast.volumesFailed', { error: msgText(e) })); }
  S.vol = S.vols.find(isSystemVolume) || S.vols[0] || null; if (S.vol) S.target = S.vol.path;
  // «Analizar con TesseraFS» del Explorador o `tesserafs-desktop <ruta>`: esa carpeta, en su unidad
  const launch = SYS.launchPath;
  if (launch) {
    S.target = launch;
    S.vol = S.vols.filter(v => isUnder(launch, v.path)).sort((a, b) => b.path.length - a.path.length)[0] || S.vol;
  }
  renderVolume();
  B.elevation().then(el => {
    const btn = $('elevBtn'); btn.hidden = el.elevated || !el.canElevate;
    btn.onclick = async () => {
      mapState(() => `<h2>${tx('state.elevating.title')}</h2><p>${tx('state.elevating.body')}</p>`);
      try { await B.relaunchElevated(); } catch (e) { mapState(null); toast(msgText(e)); }
    };
  }).catch(() => { });
  if (B.kind === 'demo' || launch) startScan();
  else showDrives();
}
