// Motores reales: Tauri (Rust en el mismo proceso) y HTTP local (edición portable con Bun).
import type {
  ActionKind, ActionResult, Backend, ChildrenRequest, ChildrenResponse, CompareResult, DupProgress, DupRequest, DupResult, ElevationInfo,
  ExportResult, ExtStat, HistoryEntry, NodeRow, RefreshResult, RescanResult, ScanProgress, ScanRequest, ScanResult, SearchRequest,
  ScheduleConfig, ScheduleInfo, SearchResponse, SystemInfo, TrendPoint, VolumeInfo,
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
  duplicates(req: DupRequest, onProgress: (p: DupProgress) => void) {
    const ch = new this.core.Channel<DupProgress>(); ch.onmessage = onProgress;
    return this.call<DupResult>('duplicates', { root: req.root, minSize: req.minSize, limit: req.limit, onProgress: ch });
  }
  cancelDuplicates() { return this.call<boolean>('cancel_duplicates'); }
  historySave() { return this.call<HistoryEntry>('history_save'); }
  historyList() { return this.call<HistoryEntry[]>('history_list'); }
  historyDelete(id: string) { return this.call<boolean>('history_delete', { id }); }
  historyClear() { return this.call<number>('history_clear'); }
  compare(id: string, limit: number) { return this.call<CompareResult>('compare', { id, limit }); }
  compareClear() { return this.call<void>('compare_clear'); }
  exportFile(name: string, data: string, base64: boolean) { return this.call<ExportResult>('export_file', { name, data, base64 }); }
  revealExport(path: string) { return this.call<ActionResult>('reveal_export', { path }); }
  rescan(id: number, onProgress: (p: ScanProgress) => void) {
    const ch = new this.core.Channel<ScanProgress>(); ch.onmessage = onProgress;
    return this.call<RescanResult>('rescan', { id, onProgress: ch });
  }
  refresh(onProgress: (p: ScanProgress) => void) {
    const ch = new this.core.Channel<ScanProgress>(); ch.onmessage = onProgress;
    return this.call<RefreshResult>('refresh', { onProgress: ch });
  }
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
  system() { return this.call<SystemInfo>('system'); }
  brokenLinks(root: number, limit: number) { return this.call<SearchResponse>('broken_links', { root, limit }); }
  historyTrend(id: number) { return this.call<TrendPoint[]>('history_trend', { id }); }
  scheduleGet() { return this.call<ScheduleInfo>('schedule_get'); }
  scheduleSet(cfg: ScheduleConfig | null) { return this.call<ScheduleInfo>('schedule_set', { cfg }); }
  saveScan() { return this.call<ExportResult>('save_scan'); }
  // El archivo va como cuerpo binario de la llamada (InvokeBody::Raw en Rust), sin pasar por JSON
  openScan(data: ArrayBuffer) {
    const invoke = this.core.invoke as unknown as (cmd: string, body: Uint8Array) => Promise<ScanResult>;
    return invoke('open_scan', new Uint8Array(data)).catch(e => { throw engineFailure(e); });
  }
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
  /**
   * Escucha los eventos SSE de /api/events mientras dura `run`. EventSource no admite cabeceras, así que se lee
   * como flujo con fetch. El progreso del escaneo llega sin nombre (`message`); el de los duplicados, como `dup`.
   */
  private async withEvents<T>(name: string, onData: (d: unknown) => void, run: () => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    this.req('/api/events', { signal: ctrl.signal }).then(async r => {
      const rd = r.body!.getReader(), dec = new TextDecoder(); let buf = '';
      for (; ;) {
        const { value, done } = await rd.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const ev = buf.slice(0, i).split('\n'); buf = buf.slice(i + 2);
          const type = ev.find(l => l.startsWith('event:'))?.slice(6).trim() || 'message';
          const data = ev.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
          if (type === name && data) { try { onData(JSON.parse(data)); } catch { } }
        }
      }
    }).catch(() => { });
    try { return await run(); } finally { setTimeout(() => ctrl.abort(), 300); }
  }
  scan(req: ScanRequest, onProgress: (p: ScanProgress) => void) {
    return this.withEvents('message', d => { if ((d as ScanProgress)?.phase) onProgress(d as ScanProgress); }, () => this.post<ScanResult>('/api/scan', req));
  }
  cancelScan() { return this.post<boolean>('/api/cancel', {}); }
  duplicates(req: DupRequest, onProgress: (p: DupProgress) => void) {
    return this.withEvents('dup', d => { if ((d as DupProgress)?.phase) onProgress(d as DupProgress); }, () => this.post<DupResult>('/api/duplicates', req));
  }
  cancelDuplicates() { return this.post<boolean>('/api/duplicates/cancel', {}); }
  historySave() { return this.post<HistoryEntry>('/api/history/save', {}); }
  historyList() { return this.get<HistoryEntry[]>('/api/history'); }
  historyDelete(id: string) { return this.post<boolean>('/api/history/delete', { id }); }
  historyClear() { return this.post<number>('/api/history/clear', {}); }
  compare(id: string, limit: number) { return this.post<CompareResult>('/api/compare', { id, limit }); }
  async compareClear() { await this.post('/api/compare/clear', {}); }
  exportFile(name: string, data: string, base64: boolean) { return this.post<ExportResult>('/api/export', { name, data, base64 }); }
  revealExport(path: string) { return this.post<ActionResult>('/api/export/reveal', { path }); }
  rescan(id: number, onProgress: (p: ScanProgress) => void) {
    return this.withEvents('message', d => { if ((d as ScanProgress)?.phase) onProgress(d as ScanProgress); }, () => this.post<RescanResult>('/api/rescan', { id }));
  }
  refresh(onProgress: (p: ScanProgress) => void) {
    return this.withEvents('message', d => { if ((d as ScanProgress)?.phase) onProgress(d as ScanProgress); }, () => this.post<RefreshResult>('/api/refresh', {}));
  }
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
  system() { return this.get<SystemInfo>('/api/system'); }
  brokenLinks(root: number, limit: number) { return this.post<SearchResponse>('/api/broken-links', { root, limit }); }
  historyTrend(id: number) { return this.get<TrendPoint[]>('/api/history/trend?' + this.qs({ id })); }
  scheduleGet() { return this.get<ScheduleInfo>('/api/schedule'); }
  scheduleSet(cfg: ScheduleConfig | null) { return this.post<ScheduleInfo>('/api/schedule', { cfg }); }
  saveScan() { return this.post<ExportResult>('/api/scan/save', {}); }
  openScan(data: ArrayBuffer) {
    return this.req('/api/scan/open', { method: 'POST', body: data, headers: { 'Content-Type': 'application/octet-stream' } }).then(r => r.json() as Promise<ScanResult>);
  }
}
