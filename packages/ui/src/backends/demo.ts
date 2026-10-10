// Motor de demostración: árbol de ejemplo en memoria que cumple el mismo contrato que los motores reales.
import {
  FLAG, compileQuery, encodeSlice, type Backend, type ChildrenRequest, type NodeRow, type ScanProgress, type ScanRequest,
  type ScanResult, type SearchRequest, type SliceSource, type VolumeInfo,
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
    const t0 = performance.now(); this.ensure();
    const total = this.N.length, dur = 2600;
    await new Promise<void>(res => {
      const step = () => {
        const el = performance.now() - t0, p = Math.min(1, el / dur);
        onProgress({ phase: p < .72 ? 'mft-read' : p < .9 ? 'link' : 'aggregate', entries: Math.round(Math.min(1, p / .72) * total), bytes: this.root.size * p, elapsedMs: el });
        if (p < 1) setTimeout(step, 60); else res();
      };
      step();
    });
    const el = performance.now() - t0;
    onProgress({ phase: 'done', entries: total, bytes: this.root.size, elapsedMs: el });
    return { rootId: 0, rootPath: 'C:\\', engine: 'mft', entries: total, files: this.root.files, dirs: this.root.dirs, bytes: this.root.size,
      elapsedMs: el, volume: VOLUME, warnings: [{ code: 'scan.demoData', message: 'Sample data: no disk was read.' }] };
  }

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
