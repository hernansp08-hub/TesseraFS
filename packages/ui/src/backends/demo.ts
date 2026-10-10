// Motor de demostración: árbol de ejemplo en memoria que cumple el mismo contrato que los motores reales.
import {
  FLAG, compileQuery, encodeSlice, type Backend, type ChangeRow, type ChildrenRequest, type CompareResult, type DupGroup, type DupProgress,
  type DupRequest, type DupResult, type HistoryEntry, type NodeRow, type RemovedRow, type ScanProgress, type ScanRequest, type ScanResult,
  type SearchRequest, type SearchRow, type SliceSource, type VolumeInfo,
} from '@tessera/protocol';
// @ts-ignore módulo JS sin tipos
import { buildSample } from './sample.js';
import { fail } from './errors';

interface DNode {
  id: number; name: string; parent: DNode | null; isDir: boolean; size: number; alloc: number; files: number; dirs: number;
  mtime: number; ext: string; kids: DNode[] | null; mk: DNode[] | null; comp: boolean; hl: boolean; hidden: boolean; depth: number; copy?: boolean;
}

const GB = 1024 ** 3;
const VOLUME: VolumeInfo = { path: 'C:\\', label: 'Windows-SSD', fs: 'NTFS', total: 434560299008, free: 47590404096, clusterSize: 4096 };

export class DemoBackend implements Backend {
  readonly kind = 'demo' as const;
  private N: DNode[] = [];
  private root!: DNode;
  private ready = false;
  private scanning = false;
  private cancelled = false;
  private dupRunning = false;
  private dupCancelled = false;
  /** Historial en memoria: un resumen simulado de hace 30 días y los que se guarden en esta sesión. */
  private snaps: { entry: HistoryEntry; prev: Map<number, number>; fresh: Set<number>; removed: RemovedRow[] }[] = [];
  private cmp: { prev: Map<number, number>; fresh: Set<number> } | null = null;

  private ensure() {
    if (this.ready) return;
    const { N, root } = buildSample(); this.N = N; this.root = root; this.ready = true;
  }
  private flags(n: DNode) {
    return (n.isDir ? FLAG.DIR : 0) | (n.hidden ? FLAG.HIDDEN : 0) | (n.hl ? FLAG.HARDLINK : 0) | (n.comp ? FLAG.COMPRESSED : 0);
  }
  private row(n: DNode): NodeRow {
    const r: NodeRow = { id: n.id, parentId: n.parent ? n.parent.id : -1, name: n.parent ? n.name : 'C:\\', isDir: n.isDir, size: n.size, alloc: n.alloc,
      files: n.files, dirs: n.dirs, mtime: n.mtime, ext: n.ext, flags: this.flags(n), childCount: n.kids ? n.kids.length : 0 };
    if (this.cmp) { if (this.cmp.fresh.has(n.id)) r.fresh = true; else if (this.cmp.prev.has(n.id)) r.prev = this.cmp.prev.get(n.id); }
    return r;
  }
  private delta(n: DNode) {
    const c = this.cmp; if (!c) return 0;
    return c.fresh.has(n.id) ? n.size : c.prev.has(n.id) ? n.size - c.prev.get(n.id)! : 0;
  }
  private path(n: DNode) {
    if (!n.parent) return 'C:\\';
    const a: string[] = []; for (let x: DNode | null = n; x && x.parent; x = x.parent) a.push(x.name);
    return 'C:\\' + a.reverse().join('\\');
  }
  private node(id: number) { this.ensure(); const n = this.N[id]; if (!n) throw fail('error.invalidNode', `Unknown node id: ${id}`, { id }); return n; }

  async volumes() { return [VOLUME]; }

  async scan(_req: ScanRequest, onProgress: (p: ScanProgress) => void): Promise<ScanResult> {
    if (this.scanning) throw fail('error.scanBusy', 'A scan is already in progress');
    const t0 = performance.now(); this.ensure();
    const total = this.N.length, dur = 2600;
    this.scanning = true; this.cancelled = false;
    try {
      await new Promise<void>((res, rej) => {
        const step = () => {
          if (this.cancelled) { rej(fail('error.cancelled', 'Scan cancelled')); return; }
          const el = performance.now() - t0, p = Math.min(1, el / dur);
          onProgress({ phase: p < .72 ? 'mft-read' : p < .9 ? 'link' : 'aggregate', entries: Math.round(Math.min(1, p / .72) * total), bytes: this.root.size * p, elapsedMs: el });
          if (p < 1) setTimeout(step, 60); else res();
        };
        step();
      });
    } finally { this.scanning = false; }
    const el = performance.now() - t0;
    onProgress({ phase: 'done', entries: total, bytes: this.root.size, elapsedMs: el });
    return { rootId: 0, rootPath: 'C:\\', engine: 'mft', entries: total, files: this.root.files, dirs: this.root.dirs, bytes: this.root.size,
      elapsedMs: el, volume: VOLUME, warnings: [{ code: 'scan.demoData', message: 'Sample data: no disk was read.' }] };
  }

  async cancelScan() { if (!this.scanning) return false; this.cancelled = true; return true; }

  async slice(root: number, minBytes: number, maxNodes: number) {
    const N = this.N; this.node(root);
    const src: SliceSource = {
      isDir: i => N[i].isDir, name: i => N[i].parent ? N[i].name : 'C:\\', ext: i => N[i].ext, size: i => N[i].size, alloc: i => N[i].alloc,
      files: i => N[i].files, dirs: i => N[i].dirs, mtime: i => N[i].mtime, flags: i => this.flags(N[i]),
      children: i => (N[i].mk || []).map(k => k.id),
    };
    const u8 = encodeSlice(src, root, minBytes, maxNodes);
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
  }

  async children(r: ChildrenRequest) {
    const n = this.node(r.id); const kids = (n.kids || []).slice();
    const key = r.sort, dir = r.desc ? -1 : 1;
    const val = (k: DNode): number | string => key === 'name' ? k.name.toLowerCase() : key === 'size' ? k.size : key === 'alloc' ? k.alloc : key === 'files' ? k.files : key === 'delta' ? this.delta(k) : k.mtime;
    kids.sort((a, b) => { const va = val(a), vb = val(b); return (va < vb ? -1 : va > vb ? 1 : 0) * dir || a.name.localeCompare(b.name); });
    return { total: kids.length, rows: kids.slice(r.offset, r.offset + r.limit).map(k => this.row(k)) };
  }

  async search(r: SearchRequest) {
    const q = compileQuery(r.query);
    if (q.error) return { total: 0, totalBytes: 0, rows: [], error: q.error };
    const hits: DNode[] = []; let bytes = 0;
    const st = [this.node(r.root)];
    while (st.length) {
      const n = st.pop()!;
      if (n.kids) for (const k of n.kids) st.push(k);
      const t = { name: n.name, ext: n.ext, isDir: n.isDir, size: n.size, alloc: n.alloc, mtime: n.mtime, path: () => this.path(n) };
      if (n.parent && q.match(t)) { hits.push(n); bytes += n.size; }
    }
    hits.sort((a, b) => b.size - a.size);
    return { total: hits.length, totalBytes: bytes, rows: hits.slice(0, r.limit).map(n => ({ ...this.row(n), path: this.path(n) })) };
  }

  async extStats(root: number) {
    const m = new Map<string, { ext: string; size: number; alloc: number; count: number }>();
    const st = [this.node(root)];
    while (st.length) {
      const n = st.pop()!;
      if (n.kids) { for (const k of n.kids) st.push(k); continue; }
      let e = m.get(n.ext); if (!e) m.set(n.ext, e = { ext: n.ext, size: 0, alloc: 0, count: 0 });
      e.size += n.size; e.alloc += n.alloc; e.count++;
    }
    return [...m.values()].sort((a, b) => b.size - a.size);
  }

  // Duplicados simulados: mismo tamaño y mismo nombre (sin « (1)»). Las tres pasadas sólo se fingen, con su progreso.
  async duplicates(r: DupRequest, onProgress: (p: DupProgress) => void): Promise<DupResult> {
    if (this.scanning) throw fail('error.scanBusy', 'A scan is already in progress');
    if (this.dupRunning) throw fail('error.dupBusy', 'A duplicate search is already in progress');
    const t0 = performance.now(), min = Math.max(1, r.minSize), files: DNode[] = [];
    let hardlinks = 0;
    const st = [this.node(r.root)];
    while (st.length) {
      const n = st.pop()!;
      if (n.kids) { for (const k of n.kids) st.push(k); continue; }
      if (n.size < min) continue;
      if (n.hl) { hardlinks++; continue; }
      files.push(n);
    }
    const key = (n: DNode) => n.size + '|' + n.name.toLowerCase().replace(/ \(\d+\)(?=\.[^.]+$|$)/, '');
    const bySize = new Map<number, DNode[]>(); for (const n of files) bySize.set(n.size, [...(bySize.get(n.size) || []), n]);
    const cands = [...bySize.values()].filter(g => g.length > 1).flat();
    const byKey = new Map<string, DNode[]>(); for (const n of cands) byKey.set(key(n), [...(byKey.get(key(n)) || []), n]);
    const found = [...byKey.values()].filter(g => g.length > 1);
    const fullBytes = found.flat().reduce((s, n) => s + n.size, 0), prefixBytes = cands.reduce((s, n) => s + Math.min(n.size, 65536), 0);
    this.dupRunning = true; this.dupCancelled = false;
    try {
      const steps: [DupProgress['phase'], number, number, number][] = [['size', cands.length, 0, 250], ['prefix', cands.length, prefixBytes, 450], ['full', found.flat().length, fullBytes, 1100]];
      for (const [phase, total, bytes, dur] of steps) {
        const s0 = performance.now();
        for (let p = 0; p < 1;) {
          if (this.dupCancelled) throw fail('error.cancelled', 'Operation cancelled');
          p = Math.min(1, (performance.now() - s0) / dur);
          onProgress({ phase, files: Math.round(total * p), totalFiles: total, bytes: Math.round(bytes * p), totalBytes: bytes, elapsedMs: performance.now() - t0 });
          await new Promise(res => setTimeout(res, 60));
        }
      }
    } finally { this.dupRunning = false; }
    const groups: DupGroup[] = found.map(g => ({
      size: g[0].size, hash: (g[0].size * 2654435761 % 2 ** 32).toString(16).padStart(8, '0').repeat(8),
      files: g.map(n => ({ ...this.row(n), path: this.path(n) })).sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase())),
    })).sort((a, b) => (b.files.length - 1) * b.size - (a.files.length - 1) * a.size || b.size - a.size);
    const elapsedMs = performance.now() - t0;
    onProgress({ phase: 'done', files: 0, totalFiles: 0, bytes: 0, totalBytes: 0, elapsedMs });
    return {
      groups: groups.slice(0, Math.max(1, Math.min(5000, r.limit))), totalGroups: groups.length,
      wasted: groups.reduce((s, g) => s + (g.files.length - 1) * g.size, 0), candidates: cands.length,
      readBytes: prefixBytes + fullBytes, skipped: { hardlinks, cloud: 0 }, elapsedMs, warnings: [],
    };
  }
  async cancelDuplicates() { if (!this.dupRunning) return false; this.dupCancelled = true; return true; }

  // ---------- Historial simulado ----------
  private entry(id: string, at: number, bytes: number, files: number, dirs: number): HistoryEntry {
    return { id, path: 'C:\\', scannedAt: Math.round(at), engine: 'mft', bytes, files, dirs, nodes: 0, fileBytes: 0 };
  }
  /** Hace 30 días: sin las copias recientes, sin un modelo y un juego nuevos, con menos disco de Docker y más temporales, y con dos cosas que ya no están. */
  private pastSnapshot() {
    this.ensure();
    const N = this.N, GB = 1024 ** 3, fresh = new Set<number>(), prev = new Map<number, number>();
    const at = (p: string) => N.find(n => this.path(n).toLowerCase() === p.toLowerCase());
    const mark = (n: DNode | undefined) => { if (!n) return; const st = [n]; while (st.length) { const x = st.pop()!; fresh.add(x.id); if (x.kids) st.push(...x.kids); } };
    for (const n of N) if (n.copy) mark(n);
    mark(at('C:\\Users\\usuario\\AppData\\Local\\lm-studio\\models\\qwen3-14b-instruct-q4_k_m.gguf'));
    mark(at('C:\\Program Files (x86)\\Steam\\steamapps\\common\\Hades II'));
    const scale = (p: string, f: number) => { const d = at(p); if (!d) return; const st = [d]; while (st.length) { const x = st.pop()!; if (x.kids) st.push(...x.kids); else prev.set(x.id, Math.round(x.size * f)); } };
    scale('C:\\apps\\lamina-rs\\target\\debug', .55);
    scale('C:\\Users\\usuario\\AppData\\Local\\Temp', 1.8);
    const vhdx = at('C:\\Users\\usuario\\AppData\\Local\\Docker\\wsl\\docker_data.vhdx'); if (vhdx) prev.set(vhdx.id, Math.round(vhdx.size - 2.1 * GB));
    const removed: RemovedRow[] = [
      { path: 'C:\\Users\\usuario\\Downloads\\ubuntu-24.04.2-desktop-amd64.iso', isDir: false, size: Math.round(5.9 * GB) },
      { path: 'C:\\Users\\usuario\\Videos\\Grabaciones', isDir: true, size: Math.round(3.2 * GB) },
    ];
    const extra = new Map<number, number>();
    for (const r of removed) { const p = at(r.path.slice(0, r.path.lastIndexOf('\\'))); if (p) extra.set(p.id, (extra.get(p.id) || 0) + r.size); }
    // Carpetas: suma de lo que ya existía más lo que se borró dentro (los hijos tienen id mayor que su padre)
    for (let i = N.length - 1; i >= 0; i--) {
      const n = N[i]; if (fresh.has(n.id)) continue;
      if (!n.kids) { if (!prev.has(n.id)) prev.set(n.id, n.size); continue; }
      let s = extra.get(n.id) || 0; for (const k of n.kids) if (!fresh.has(k.id)) s += prev.get(k.id)!; prev.set(n.id, s);
    }
    let files = 0, dirs = 0; for (const n of N) if (n.parent && !fresh.has(n.id)) n.isDir ? dirs++ : files++;
    const entry = this.entry('20260907T093000Z-demo', Date.now() / 1000 - 30 * 86400, prev.get(this.root.id)!, files + 2, dirs + 1);
    return { entry, prev, fresh, removed };
  }
  private seeded = false;
  private ensureSnaps() { if (!this.seeded) { this.seeded = true; this.snaps.push(this.pastSnapshot()); } }
  async historySave() {
    this.ensureSnaps(); const r = this.root, prev = new Map(this.N.map(n => [n.id, n.size] as [number, number]));
    const e = this.entry(new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z-demo', Date.now() / 1000, r.size, r.files, r.dirs);
    if (this.snaps.some(s => s.entry.id === e.id)) e.id += '-2';
    this.snaps.push({ entry: e, prev, fresh: new Set(), removed: [] });
    return e;
  }
  async historyList() { this.ensureSnaps(); return this.snaps.map(s => s.entry).sort((a, b) => b.scannedAt - a.scannedAt); }
  async historyDelete(id: string) { const i = this.snaps.findIndex(s => s.entry.id === id); if (i >= 0) this.snaps.splice(i, 1); return i >= 0; }
  async historyClear() { this.ensureSnaps(); const n = this.snaps.length; this.snaps = []; this.cmp = null; return n; }
  async compare(id: string, limit: number): Promise<CompareResult> {
    this.ensureSnaps();
    const s = this.snaps.find(x => x.entry.id === id); if (!s) throw fail('history.notFound', `Snapshot not found: ${id}`, { id });
    this.cmp = { prev: s.prev, fresh: s.fresh };
    const lim = Math.max(1, Math.min(1000, limit)), d = (n: DNode) => this.delta(n);
    const pick = (sign: 1 | -1) => this.N.filter(n => n.parent && sign * d(n) > 0 && (!n.kids || n.kids.every(k => sign * d(k) < .75 * sign * d(n))))
      .sort((a, b) => sign * (d(b) - d(a)) || this.path(a).localeCompare(this.path(b))).slice(0, lim)
      .map((n): ChangeRow => ({ ...(this.row(n) as SearchRow), path: this.path(n), prev: s.fresh.has(n.id) ? null : s.prev.get(n.id) ?? null }));
    const r = this.root;
    return {
      entry: s.entry, before: { bytes: s.entry.bytes, files: s.entry.files, dirs: s.entry.dirs }, after: { bytes: r.size, files: r.files, dirs: r.dirs },
      grew: pick(1), shrank: pick(-1), removed: [...s.removed].sort((a, b) => b.size - a.size).slice(0, lim),
    };
  }
  async compareClear() { this.cmp = null; }
  // ---------- Exportar: en la demo, descarga del navegador ----------
  async exportFile(name: string, data: string, base64: boolean) {
    const bytes = base64 ? Uint8Array.from(atob(data), c => c.charCodeAt(0)) : new TextEncoder().encode(data);
    const url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { path: name };
  }
  async revealExport() { return { ok: false, code: 'demo.unavailable', message: 'Action not available in the demo.' }; }

  async nodePath(id: number) { return this.path(this.node(id)); }
  async nodeInfo(id: number) { return this.row(this.node(id)); }

  // Sin efectos: devuelve el código de lo que haría la app real (engine.demo.* en los catálogos)
  async action(kind: string, id: number) {
    const n = this.node(id);
    const msg: Record<string, string> = {
      open: `Demo: the app would open "${n.name}" with its default program.`,
      reveal: 'Demo: the app would open Explorer with the item selected.',
      properties: 'Demo: the app would open the Windows Properties dialog.',
      trash: `Demo: nothing was moved. The app would send "${n.name}" to the Recycle Bin.`,
    };
    if (!msg[kind]) return { ok: false, code: 'demo.unavailable', message: 'Action not available in the demo.' };
    return { ok: kind !== 'trash', code: 'demo.' + kind, params: { name: n.name }, message: msg[kind] };
  }
  async elevation() { return { elevated: false, canElevate: false }; }
  async relaunchElevated() { }
  sampleSize() { this.ensure(); return this.root.size / GB; }
}
