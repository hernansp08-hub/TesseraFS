// Árbol en estructura de arreglos (SoA). Los nombres viven en un único búfer UTF-16, sin decodificar.
// Invariante: el padre siempre tiene un id menor que sus hijos (lo garantizan walk, mft y graft).
import { FLAG, compileQuery, type ExtStat, type NodeRow, type QueryTarget, type SearchResponse, type SearchRow, type SliceSource, type SortKey } from '../../protocol/src/index.ts';
import { ATTR, REPARSE_TAG_WOF, isCloudTag, isNameSurrogate } from './win32.ts';

export const NONE = 0xFFFFFFFF;
const td16 = new TextDecoder('utf-16le');

/** Banderas del contrato a partir de atributos Win32 y la etiqueta de reparse. */
export function flagsFromAttrs(attrs: number, tag: number, isDir: boolean): number {
  let f = isDir ? FLAG.DIR : 0;
  if (attrs & ATTR.HIDDEN) f |= FLAG.HIDDEN;
  if (attrs & ATTR.SYSTEM) f |= FLAG.SYSTEM;
  if ((attrs & ATTR.COMPRESSED) || (tag >>> 0) === REPARSE_TAG_WOF) f |= FLAG.COMPRESSED;
  if (attrs & ATTR.SPARSE) f |= FLAG.SPARSE;
  if ((attrs & ATTR.REPARSE) && isNameSurrogate(tag)) f |= FLAG.REPARSE;
  if (isCloudTag(tag) || (attrs & (ATTR.RECALL_ON_DATA_ACCESS | ATTR.RECALL_ON_OPEN | ATTR.OFFLINE))) f |= FLAG.CLOUD;
  return f;
}

function grow<A extends Uint8Array | Uint16Array | Uint32Array | Int32Array | Float64Array>(a: A, cap: number): A {
  const b = new (a.constructor as new (n: number) => A)(cap);
  b.set(a.subarray(0, Math.min(a.length, cap)) as never);
  return b;
}

/**
 * Comparación activa con un resumen del historial (ver history.ts): `prev` = tamaño anterior y `st` = estado
 * por id (1 = emparejado, se conoce `prev`; 2 = nuevo; 0 = desconocido).
 */
export interface CompareState { prev: Float64Array; st: Uint8Array }
export const CMP_MATCHED = 1, CMP_FRESH = 2;

/**
 * Bit interno de `fl` (fuera de las banderas del contrato, que son el byte bajo): nodo muerto, porque se envió a la
 * papelera o porque su carpeta se volvió a escanear. Su id deja de valer; sus columnas siguen ocupando sitio.
 */
export const DEAD = 0x8000;

export class Store implements SliceSource {
  n = 0;
  par: Uint32Array; sz: Float64Array; al: Float64Array; nf: Uint32Array; nd: Uint32Array;
  mt: Uint32Array; ex: Uint16Array; fl: Uint16Array; nOff: Uint32Array; nLen: Uint16Array;
  /** Clave de archivo (nº de registro NTFS) sólo durante el escaneo, para detectar enlaces duros. */
  key: Float64Array | null = null;
  names: Uint16Array; namesLen = 0;
  extList: string[] = [];
  private extMap = new Map<string, number>();
  private extFast = new Map<number, number>();
  // hijos (CSR) tras finalize(): kids[kidStart[i] .. kidStart[i]+kidCount[i]) ordenados por tamaño desc
  kidStart = new Uint32Array(0); kidCount = new Uint32Array(0); kids = new Uint32Array(0);
  readonly rootId = 0;
  rootPath = '';
  version = 0; // cambia al borrar nodos (invalida cachés)
  /** Comparación activa: las filas llevan `prev`/`fresh` y `childRows` admite el orden 'delta'. */
  cmp: CompareState | null = null;
  private extCache = new Map<number, ExtStat[]>();
  private orderCache = new Map<string, Uint32Array>();

  constructor(cap = 1 << 16, trackKeys = false) {
    this.par = new Uint32Array(cap); this.sz = new Float64Array(cap); this.al = new Float64Array(cap);
    this.nf = new Uint32Array(cap); this.nd = new Uint32Array(cap); this.mt = new Uint32Array(cap);
    this.ex = new Uint16Array(cap); this.fl = new Uint16Array(cap); this.nOff = new Uint32Array(cap); this.nLen = new Uint16Array(cap);
    this.names = new Uint16Array(cap * 16);
    if (trackKeys) this.key = new Float64Array(cap);
  }

  get cap() { return this.par.length; }

  /** Capacidad para `extra` nodos más: duplicando (escaneo) o justa (`exact`, injerto en un árbol ya recortado). */
  ensure(extra: number, exact = false) {
    const need = this.n + extra;
    if (need <= this.cap) return;
    let c = Math.max(1, this.cap); if (exact) c = need; else while (c < need) c *= 2;
    this.par = grow(this.par, c); this.sz = grow(this.sz, c); this.al = grow(this.al, c);
    this.nf = grow(this.nf, c); this.nd = grow(this.nd, c); this.mt = grow(this.mt, c);
    this.ex = grow(this.ex, c); this.fl = grow(this.fl, c); this.nOff = grow(this.nOff, c); this.nLen = grow(this.nLen, c);
    if (this.key) this.key = grow(this.key, c);
  }
  ensureNames(extra: number, exact = false) {
    const need = this.namesLen + extra;
    if (need <= this.names.length) return;
    let c = Math.max(1, this.names.length); if (exact) c = need; else while (c < need) c *= 2;
    this.names = grow(this.names, c);
  }

  /** Id de extensión a partir de unidades UTF-16 del nombre. 0xFFFF para carpetas. */
  extOf(u: Uint16Array, off: number, len: number): number {
    let dot = -1;
    for (let i = off + len - 1; i > off; i--) if (u[i] === 46) { dot = i; break; }
    if (dot < 0) return this.extId('');
    const el = off + len - dot - 1;
    if (el <= 6) { // clave numérica sin crear cadenas (ASCII corto)
      let k = 0, ascii = true;
      for (let i = dot + 1, m = 1; i < off + len; i++, m *= 128) {
        let c = u[i]; if (c >= 128) { ascii = false; break; }
        if (c >= 65 && c <= 90) c += 32;
        k += c * m;
      }
      if (ascii) {
        k = k * 8 + el;
        const hit = this.extFast.get(k);
        if (hit !== undefined) return hit;
        const id = this.extId(String.fromCharCode.apply(null, u.subarray(dot + 1, off + len) as unknown as number[]).toLowerCase());
        this.extFast.set(k, id);
        return id;
      }
    }
    return this.extId(String.fromCharCode.apply(null, u.subarray(dot + 1, off + len) as unknown as number[]).toLowerCase());
  }
  extId(e: string): number {
    let id = this.extMap.get(e);
    if (id === undefined) {
      id = this.extList.length;
      if (id >= 0xFFFE) id = this.extMap.get('')! ?? 0; // límite del formato; prácticamente inalcanzable
      else { this.extList.push(e); this.extMap.set(e, id); }
    }
    return id;
  }

  /** Añade un nodo copiando su nombre (unidades UTF-16). Devuelve el id. */
  add(parent: number, u: Uint16Array, off: number, len: number, isDir: boolean, size: number, alloc: number, mtime: number, flags: number): number {
    this.ensure(1); this.ensureNames(len);
    const id = this.n++;
    this.par[id] = parent; this.sz[id] = size; this.al[id] = alloc; this.mt[id] = mtime;
    this.fl[id] = flags | (isDir ? FLAG.DIR : 0);
    this.ex[id] = isDir ? 0xFFFF : this.extOf(u, off, len);
    this.nOff[id] = this.namesLen; this.nLen[id] = len;
    this.names.set(u.subarray(off, off + len), this.namesLen); this.namesLen += len;
    return id;
  }
  addRoot(path: string, mtime = 0, flags = 0): number {
    const u = new Uint16Array(path.length);
    for (let i = 0; i < path.length; i++) u[i] = path.charCodeAt(i);
    this.rootPath = path;
    return this.add(NONE, u, 0, u.length, true, 0, 0, mtime, flags);
  }

  // ---------- cierre del escaneo ----------
  /** Enlaces duros por clave de archivo: la primera aparición (id menor) conserva el tamaño. */
  dedupHardlinks(): number {
    const key = this.key; if (!key) return 0;
    const n = this.n;
    let m = 0;
    for (let i = 0; i < n; i++) if (key[i] > 0) m++;
    const sorted = new Float64Array(m);
    for (let i = 0, j = 0; i < n; i++) if (key[i] > 0) sorted[j++] = key[i];
    sorted.sort();
    const dup = new Set<number>();
    for (let i = 1; i < m; i++) if (sorted[i] === sorted[i - 1]) dup.add(sorted[i]);
    let copies = 0;
    if (dup.size) {
      const seen = new Set<number>();
      for (let i = 0; i < n; i++) {
        const k = key[i];
        if (k > 0 && dup.has(k)) {
          if (seen.has(k)) { this.sz[i] = 0; this.al[i] = 0; this.fl[i] |= FLAG.HARDLINK; copies++; }
          else seen.add(k);
        }
      }
    }
    this.key = null;
    return copies;
  }

  /** Agrega tamaños hacia arriba, construye las listas de hijos (tamaño desc) y recorta memoria. */
  finalize() {
    const n = this.n, par = this.par, sz = this.sz, al = this.al, nf = this.nf, nd = this.nd, fl = this.fl;
    nf.fill(0, 0, n); nd.fill(0, 0, n);
    for (let i = n - 1; i > 0; i--) {
      const p = par[i]; if (p === NONE) continue;
      sz[p] += sz[i]; al[p] += al[i];
      if (fl[i] & FLAG.DIR) { nd[p] += nd[i] + 1; nf[p] += nf[i]; } else nf[p] += 1;
    }
    const start = new Uint32Array(n + 1), count = new Uint32Array(n);
    for (let i = 1; i < n; i++) { const p = par[i]; if (p !== NONE) count[p]++; }
    for (let i = 0, s = 0; i < n; i++) { start[i] = s; s += count[i]; start[n] = s; }
    const kids = new Uint32Array(start[n]), fill = new Uint32Array(n);
    for (let i = 1; i < n; i++) { const p = par[i]; if (p !== NONE) kids[start[p] + fill[p]++] = i; }
    const bySize = (a: number, b: number) => sz[b] - sz[a] || a - b;
    for (let i = 0; i < n; i++) if (count[i] > 1) kids.subarray(start[i], start[i] + count[i]).sort(bySize);
    this.kidStart = start.subarray(0, n); this.kidCount = count; this.kids = kids;
    this.trim();
  }
  private trim() {
    const n = this.n;
    this.par = this.par.slice(0, n); this.sz = this.sz.slice(0, n); this.al = this.al.slice(0, n);
    this.nf = this.nf.slice(0, n); this.nd = this.nd.slice(0, n); this.mt = this.mt.slice(0, n);
    this.ex = this.ex.slice(0, n); this.fl = this.fl.slice(0, n); this.nOff = this.nOff.slice(0, n); this.nLen = this.nLen.slice(0, n);
    this.names = this.names.slice(0, this.namesLen);
    this.extFast.clear();
  }

  /** Memoria aproximada de las columnas (bytes). */
  bytesUsed(): number {
    return this.n * (4 + 8 + 8 + 4 + 4 + 4 + 2 + 2 + 4 + 2 + 4 + 4) + this.kids.byteLength + this.names.byteLength;
  }

  // ---------- SliceSource ----------
  isDir(id: number) { return (this.fl[id] & FLAG.DIR) !== 0; }
  name(id: number) {
    const o = this.nOff[id], l = this.nLen[id];
    return String.fromCharCode.apply(null, this.names.subarray(o, o + l) as unknown as number[]);
  }
  ext(id: number) { const e = this.ex[id]; return e === 0xFFFF ? '' : this.extList[e]; }
  size(id: number) { return this.sz[id]; }
  alloc(id: number) { return this.al[id]; }
  files(id: number) { return this.nf[id]; }
  dirs(id: number) { return this.nd[id]; }
  mtime(id: number) { return this.mt[id]; }
  flags(id: number) { return this.fl[id] & 0xFF; }
  children(id: number) { const s = this.kidStart[id]; return this.kids.subarray(s, s + this.kidCount[id]); }

  /** El id existe y sigue en el árbol (no está muerto). */
  has(id: number) { return Number.isInteger(id) && id >= 0 && id < this.n && !(this.fl[id] & DEAD); }

  // ---------- consultas ----------
  path(id: number): string {
    const parts: string[] = [];
    let i = id;
    while (i !== this.rootId && i !== NONE) { parts.push(this.name(i)); i = this.par[i]; }
    if (!parts.length) return this.rootPath;
    parts.reverse();
    return this.rootPath + (this.rootPath.endsWith('\\') ? '' : '\\') + parts.join('\\');
  }

  row(id: number): NodeRow {
    const r: NodeRow = {
      id, parentId: id === this.rootId || this.par[id] === NONE ? -1 : this.par[id], name: this.name(id), isDir: this.isDir(id),
      size: this.sz[id], alloc: this.al[id], files: this.nf[id], dirs: this.nd[id], mtime: this.mt[id], ext: this.ext(id),
      flags: this.fl[id] & 0xFF, childCount: this.kidCount[id] ?? 0,
    };
    const c = this.cmp;
    if (c) {
      const st = c.st[id];
      if (st & CMP_MATCHED) r.prev = c.prev[id];
      else if (st & CMP_FRESH) r.fresh = true;
    }
    return r;
  }

  /** Activa (o quita, con null) una comparación. */
  setCompare(c: CompareState | null) {
    this.cmp = c;
    this.orderCache.clear();
  }

  /** Crecimiento desde el escaneo comparado: size − prev; lo nuevo cuenta entero; lo desconocido (o sin comparación), 0. */
  delta(id: number): number {
    const c = this.cmp;
    if (!c) return 0;
    const st = c.st[id];
    return st & CMP_MATCHED ? this.sz[id] - c.prev[id] : st & CMP_FRESH ? this.sz[id] : 0;
  }

  /** Hijos paginados y ordenados; empata por nombre. */
  childRows(id: number, offset: number, limit: number, sort: SortKey, desc: boolean): { total: number; rows: NodeRow[] } {
    const kids = this.children(id), total = kids.length;
    const ck = `${this.version}:${id}:${sort}:${desc}`;
    let order = this.orderCache.get(ck);
    if (!order) {
      const ids = Array.from(kids);
      const nm = new Map<number, string>();
      const lname = (i: number) => { let s = nm.get(i); if (s === undefined) { s = this.name(i).toLowerCase(); nm.set(i, s); } return s; };
      const byName = (a: number, b: number) => { const x = lname(a), y = lname(b); return x < y ? -1 : x > y ? 1 : a - b; };
      const col: ArrayLike<number> | null = sort === 'size' ? this.sz : sort === 'alloc' ? this.al : sort === 'files' ? this.nf : sort === 'mtime' ? this.mt : null;
      // 'delta' se calcula al vuelo (los tamaños cambian al borrar); sin comparación, todo 0 → por nombre
      const val = sort === 'delta' ? (i: number) => this.delta(i) : col ? (i: number) => col[i] : null;
      const s = desc ? -1 : 1;
      ids.sort(val ? (a, b) => (val(a) - val(b)) * s || byName(a, b) : (a, b) => byName(a, b) * s);
      order = Uint32Array.from(ids);
      if (this.orderCache.size > 16) this.orderCache.clear();
      this.orderCache.set(ck, order);
    }
    const o = Math.max(0, offset | 0), l = Math.max(0, limit | 0);
    const rows: NodeRow[] = [];
    for (let i = o; i < Math.min(total, o + l); i++) rows.push(this.row(order[i]));
    return { total, rows };
  }

  /** Recorre el subárbol en preorden (incluida la raíz). */
  forEach(root: number, fn: (id: number) => void) {
    const stack = [root];
    while (stack.length) {
      const id = stack.pop()!;
      fn(id);
      const s = this.kidStart[id], c = this.kidCount[id];
      for (let k = s + c - 1; k >= s; k--) stack.push(this.kids[k]);
    }
  }

  extStats(root: number): ExtStat[] {
    const key = this.version * 1e10 + root;
    const hit = this.extCache.get(key);
    if (hit) return hit;
    const E = this.extList.length, size = new Float64Array(E), alloc = new Float64Array(E), count = new Uint32Array(E);
    this.forEach(root, id => {
      const e = this.ex[id];
      if (e !== 0xFFFF) { size[e] += this.sz[id]; alloc[e] += this.al[id]; count[e]++; }
    });
    const out: ExtStat[] = [];
    for (let e = 0; e < E; e++) if (count[e]) out.push({ ext: this.extList[e], size: size[e], alloc: alloc[e], count: count[e] });
    out.sort((a, b) => b.size - a.size || b.count - a.count);
    if (this.extCache.size > 8) this.extCache.clear();
    this.extCache.set(key, out);
    return out;
  }

  search(query: string, root: number, limit: number): SearchResponse {
    const q = compileQuery(query);
    if (q.error) return { total: 0, totalBytes: 0, rows: [], error: q.error };
    const s = this;
    let cur = 0, nameId = -1, nameStr = '';
    const t: QueryTarget = {
      get name() { if (nameId !== cur) { nameId = cur; nameStr = s.name(cur); } return nameStr; },
      get ext() { return s.ext(cur); },
      get isDir() { return (s.fl[cur] & FLAG.DIR) !== 0; },
      get size() { return s.sz[cur]; },
      get alloc() { return s.al[cur]; },
      get mtime() { return s.mt[cur]; },
      get flags() { return s.fl[cur] & 0xFF; }, // attr: (sin el bit interno DEAD)
      path: () => s.path(cur),
    };
    // montículo mínimo de tamaño `limit` con los mayores
    const k = Math.max(0, Math.min(limit | 0, 100000));
    const heap: number[] = [];
    const less = (a: number, b: number) => s.sz[a] < s.sz[b] || (s.sz[a] === s.sz[b] && a > b);
    const up = (i: number) => { while (i > 0) { const p = (i - 1) >> 1; if (!less(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
    const down = (i: number) => {
      for (; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m;
      }
    };
    let total = 0, totalBytes = 0;
    const fl = this.fl, wantDirs = q.wantsDirs, wantFiles = q.wantsFiles;
    this.forEach(root, id => {
      if (id === root) return;
      const dir = (fl[id] & FLAG.DIR) !== 0;
      if (dir ? !wantDirs : !wantFiles) return;
      cur = id;
      if (!q.match(t)) return;
      total++; totalBytes += s.sz[id];
      if (k === 0) return;
      if (heap.length < k) { heap.push(id); up(heap.length - 1); }
      else if (less(heap[0], id)) { heap[0] = id; down(0); }
    });
    heap.sort((a, b) => s.sz[b] - s.sz[a] || a - b);
    const rows: SearchRow[] = heap.map(id => ({ ...this.row(id), path: this.path(id) }));
    return { total, totalBytes, rows };
  }

  /** Quita un nodo del árbol (tras mandarlo a la papelera) y corrige los totales de sus ancestros. */
  remove(id: number): boolean {
    if (!this.has(id) || id === this.rootId) return false;
    const p = this.par[id];
    if (p === NONE) return false;
    const s = this.kidStart[p], c = this.kidCount[p];
    let at = -1;
    for (let k = s; k < s + c; k++) if (this.kids[k] === id) { at = k; break; }
    if (at < 0) return false; // ya quitado
    this.kids.copyWithin(at, at + 1, s + c); this.kidCount[p] = c - 1;
    const dsz = this.sz[id], dal = this.al[id], dir = this.isDir(id);
    const dfiles = dir ? this.nf[id] : 1, ddirs = dir ? this.nd[id] + 1 : 0;
    this.forEach(id, x => { this.fl[x] |= DEAD; }); // sus ids dejan de valer (como en el motor Rust)
    this.adjustUp(p, -dsz, -dal, -dfiles, -ddirs);
    this.version++;
    this.extCache.clear(); this.orderCache.clear();
    return true;
  }

  /** Suma las diferencias a `a` y a sus antepasados y los recoloca entre sus hermanos. */
  private adjustUp(a: number, dsz: number, dal: number, dfiles: number, ddirs: number) {
    for (; a !== NONE; a = this.par[a]) {
      this.sz[a] += dsz; this.al[a] += dal; this.nf[a] += dfiles; this.nd[a] += ddirs;
      if (a === this.rootId) break;
      this.reorder(a);
    }
  }

  /** Recoloca `a` entre sus hermanos tras cambiar su tamaño: tamaño desc y, a igualdad, id asc (como finalize). */
  private reorder(a: number) {
    const p = this.par[a];
    if (p === NONE) return;
    const kids = this.kids, sz = this.sz, s = this.kidStart[p], e = s + this.kidCount[p];
    let k = s;
    while (k < e && kids[k] !== a) k++;
    if (k === e) return;
    const first = (x: number, y: number) => sz[x] > sz[y] || (sz[x] === sz[y] && x < y);
    while (k > s && first(a, kids[k - 1])) { kids[k] = kids[k - 1]; kids[--k] = a; }
    while (k + 1 < e && first(kids[k + 1], a)) { kids[k] = kids[k + 1]; kids[++k] = a; }
  }

  /**
   * Sustituye el contenido de la carpeta `id` por el de `sub`, un almacén ya cerrado (finalize) cuya raíz es esa
   * misma carpeta vuelta a recorrer. La carpeta conserva su id; todo lo que colgaba de ella queda muerto; los nodos
   * nuevos se añaden al final con ids nuevos (así el padre sigue teniendo un id menor que sus hijos). La carpeta y
   * sus antepasados se corrigen por diferencia; se invalidan las cachés y se quita la comparación (sus columnas
   * son del tamaño anterior del árbol). Lo muerto no se recupera: sigue ocupando memoria hasta el próximo escaneo.
   * Devuelve el tamaño que tenía la carpeta.
   */
  graft(id: number, sub: Store): number {
    const before = this.sz[id];
    // 1) lo antiguo muere
    const s0 = this.kidStart[id], c0 = this.kidCount[id];
    for (let k = s0; k < s0 + c0; k++) this.forEach(this.kids[k], x => { this.fl[x] |= DEAD; });
    // 2) columnas: el nodo j ≥ 1 de `sub` pasa a ser base + j − 1; su raíz (j = 0) es `id`
    const m = sub.n - 1, base = this.n;
    const skip = sub.nLen[0]; // el nombre de la raíz de `sub` (su ruta) va primero y no se copia
    const nNames = sub.namesLen - skip;
    this.ensure(m, true); this.ensureNames(nNames, true);
    const nb = this.namesLen - skip;
    this.names.set(sub.names.subarray(skip, sub.namesLen), this.namesLen); this.namesLen += nNames;
    const exts = sub.extList.map(e => this.extId(e));
    for (let j = 1; j <= m; j++) {
      const i = base + j - 1, p = sub.par[j], e = sub.ex[j];
      this.par[i] = p === 0 ? id : base + p - 1;
      this.sz[i] = sub.sz[j]; this.al[i] = sub.al[j]; this.nf[i] = sub.nf[j]; this.nd[i] = sub.nd[j];
      this.mt[i] = sub.mt[j]; this.fl[i] = sub.fl[j]; this.ex[i] = e === 0xFFFF ? 0xFFFF : exts[e];
      this.nOff[i] = nb + sub.nOff[j]; this.nLen[i] = sub.nLen[j];
    }
    this.n += m;
    // 3) hijos (CSR): las listas de `sub` (ya ordenadas por tamaño) van al final de `kids`; la carpeta apunta a la
    // de la raíz de `sub`. Las listas de lo muerto quedan como hueco.
    const K = this.kids.length, sk = sub.kids;
    const kids = new Uint32Array(K + sk.length);
    kids.set(this.kids);
    for (let k = 0; k < sk.length; k++) kids[K + k] = base + sk[k] - 1;
    const ks = new Uint32Array(this.n), kc = new Uint32Array(this.n);
    ks.set(this.kidStart.subarray(0, base)); kc.set(this.kidCount.subarray(0, base));
    for (let j = 1; j <= m; j++) { ks[base + j - 1] = K + sub.kidStart[j]; kc[base + j - 1] = sub.kidCount[j]; }
    ks[id] = K + sub.kidStart[0]; kc[id] = sub.kidCount[0];
    this.kids = kids; this.kidStart = ks; this.kidCount = kc;
    // 4) la carpeta toma los valores nuevos (también fecha y atributos); sus antepasados, la diferencia
    const dsz = sub.sz[0] - this.sz[id], dal = sub.al[0] - this.al[id], dfiles = sub.nf[0] - this.nf[id], ddirs = sub.nd[0] - this.nd[id];
    this.mt[id] = sub.mt[0]; this.fl[id] = (sub.fl[0] & ~DEAD) | FLAG.DIR;
    this.adjustUp(id, dsz, dal, dfiles, ddirs);
    // 5) cachés y comparación
    this.version++;
    this.extCache.clear(); this.setCompare(null);
    return before;
  }

  /** Decodifica muchos nombres de golpe (pruebas y depuración). */
  allNames(): string[] {
    const out: string[] = [];
    for (let i = 0; i < this.n; i++) out.push(td16.decode(this.names.subarray(this.nOff[i], this.nOff[i] + this.nLen[i])));
    return out;
  }
}
