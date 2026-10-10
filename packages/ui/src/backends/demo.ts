// Motor de demostración: árbol de ejemplo en memoria que cumple el mismo contrato que los motores reales.
import {
  FLAG, compileQuery, encodeSlice, type Backend, type ChildrenRequest, type DupGroup, type DupProgress, type DupRequest, type DupResult,
  type NodeRow, type ScanProgress, type ScanRequest, type ScanResult, type SearchRequest, type SliceSource, type VolumeInfo,
} from '@tessera/protocol';
// @ts-ignore módulo JS sin tipos
import { buildSample } from './sample.js';
import { fail } from './errors';

interface DNode {
  id: number; name: string; parent: DNode | null; isDir: boolean; size: number; alloc: number; files: number; dirs: number;
  mtime: number; ext: string; kids: DNode[] | null; mk: DNode[] | null; comp: boolean; hl: boolean; hidden: boolean; depth: number;
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

  private ensure() {
    if (this.ready) return;
    const { N, root } = buildSample(); this.N = N; this.root = root; this.ready = true;
  }
  private flags(n: DNode) {
    return (n.isDir ? FLAG.DIR : 0) | (n.hidden ? FLAG.HIDDEN : 0) | (n.hl ? FLAG.HARDLINK : 0) | (n.comp ? FLAG.COMPRESSED : 0);
  }
  private row(n: DNode): NodeRow {
    return { id: n.id, parentId: n.parent ? n.parent.id : -1, name: n.parent ? n.name : 'C:\\', isDir: n.isDir, size: n.size, alloc: n.alloc,
      files: n.files, dirs: n.dirs, mtime: n.mtime, ext: n.ext, flags: this.flags(n), childCount: n.kids ? n.kids.length : 0 };
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
    const val = (k: DNode): number | string => key === 'name' ? k.name.toLowerCase() : key === 'size' ? k.size : key === 'alloc' ? k.alloc : key === 'files' ? k.files : k.mtime;
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
