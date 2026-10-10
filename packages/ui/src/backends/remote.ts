// Motores reales: Tauri (Rust en el mismo proceso) y HTTP local (edición portable con Bun).
import type {
  ActionKind, ActionResult, Backend, ChildrenRequest, ChildrenResponse, ElevationInfo, ExtStat, NodeRow, ScanProgress,
  ScanRequest, ScanResult, SearchRequest, SearchResponse, VolumeInfo,
} from '@tessera/protocol';
import { engineFailure, isEngineMessage } from './errors';

declare global {
  interface Window {
    __TAURI__?: { core: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>; Channel: new <T>() => { onmessage: (m: T) => void } } };
    __TESSERA__?: { backend: 'http'; token: string };
  }
}

export class TauriBackend implements Backend {
  readonly kind = 'tauri' as const;
  private core = window.__TAURI__!.core;
  // Los comandos devuelven Err(EngineMessage): la promesa se rechaza con ese objeto y aquí se convierte en Error
  private call<T>(cmd: string, args?: Record<string, unknown>) { return this.core.invoke<T>(cmd, args).catch(e => { throw engineFailure(e); }); }
  volumes() { return this.call<VolumeInfo[]>('volumes'); }
  scan(req: ScanRequest, onProgress: (p: ScanProgress) => void) {
    const ch = new this.core.Channel<ScanProgress>(); ch.onmessage = onProgress;
    return this.call<ScanResult>('scan', { path: req.path, engine: req.engine, onProgress: ch });
  }
  cancelScan() { return this.call<boolean>('cancel_scan'); }
  async slice(root: number, minBytes: number, maxNodes: number) {
    const r = await this.call<ArrayBuffer | number[]>('slice', { root, minBytes, maxNodes });
    return r instanceof ArrayBuffer ? r : new Uint8Array(r).buffer;
  }
  children(r: ChildrenRequest) { return this.call<ChildrenResponse>('children', { ...r }); }
  search(r: SearchRequest) { return this.call<SearchResponse>('search', { ...r }); }
  extStats(root: number) { return this.call<ExtStat[]>('ext_stats', { root }); }
  nodePath(id: number) { return this.call<string>('node_path', { id }); }
  nodeInfo(id: number) { return this.call<NodeRow>('node_info', { id }); }
  action(kind: ActionKind, id: number) { return this.call<ActionResult>('action', { kind, id }); }
  elevation() { return this.call<ElevationInfo>('elevation'); }
  relaunchElevated() { return this.call<void>('relaunch_elevated'); }
}

export class HttpBackend implements Backend {
  readonly kind = 'http' as const;
  constructor(private token: string) { }
  private async req(path: string, init: RequestInit = {}) {
    const r = await fetch(path, { ...init, headers: { 'X-Tessera-Token': this.token, 'Content-Type': 'application/json', ...(init.headers || {}) } });
    // Los errores de la API llegan como EngineMessage en JSON; 401/403 y rutas desconocidas, como texto
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      let msg: unknown; try { msg = JSON.parse(body); } catch { }
      throw isEngineMessage(msg) ? engineFailure(msg) : new Error(`${r.status} ${body || r.statusText}`);
    }
    return r;
  }
  private get<T>(path: string) { return this.req(path).then(r => r.json() as Promise<T>); }
  private post<T>(path: string, body: unknown) { return this.req(path, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json() as Promise<T>); }
  private qs(o: Record<string, string | number | boolean>) { return new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString(); }

  volumes() { return this.get<VolumeInfo[]>('/api/volumes'); }
  async scan(req: ScanRequest, onProgress: (p: ScanProgress) => void) {
    // EventSource no admite cabeceras: el progreso se lee como flujo con fetch
    const ctrl = new AbortController();
    this.req('/api/events', { signal: ctrl.signal }).then(async r => {
      const rd = r.body!.getReader(), dec = new TextDecoder(); let buf = '';
      for (; ;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = ev.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
          if (data) { try { const p = JSON.parse(data); if (p && p.phase) onProgress(p); } catch { } }
        }
      }
    }).catch(() => { });
    try { return await this.post<ScanResult>('/api/scan', req); } finally { setTimeout(() => ctrl.abort(), 300); }
  }
  cancelScan() { return this.post<boolean>('/api/cancel', {}); }
  async slice(root: number, minBytes: number, maxNodes: number) {
    return (await this.req('/api/slice?' + this.qs({ root, min: minBytes, max: maxNodes }))).arrayBuffer();
  }
  children(r: ChildrenRequest) { return this.get<ChildrenResponse>('/api/children?' + this.qs({ ...r })); }
  search(r: SearchRequest) { return this.get<SearchResponse>('/api/search?' + this.qs({ q: r.query, root: r.root, limit: r.limit })); }
  extStats(root: number) { return this.get<ExtStat[]>('/api/ext?' + this.qs({ root })); }
  nodePath(id: number) { return this.get<string>('/api/path?' + this.qs({ id })); }
  nodeInfo(id: number) { return this.get<NodeRow>('/api/node?' + this.qs({ id })); }
  action(kind: ActionKind, id: number) { return this.post<ActionResult>('/api/action', { kind, id }); }
  elevation() { return this.get<ElevationInfo>('/api/elevation'); }
  async relaunchElevated() { await this.post('/api/relaunch-elevated', {}); }
}
