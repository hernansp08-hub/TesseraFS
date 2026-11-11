// `bun.exe tesserafs.js mcp`: servidor MCP (Model Context Protocol) de la edición portable por la entrada y la salida
// estándar, para que un asistente de IA pregunte qué ocupa el disco sin ningún ejecutable propio. Es el mismo servidor
// que `tessera-cli mcp` (crates/tessera-cli/src/mcp.rs) sobre el motor Bun: las mismas herramientas e instrucciones
// (packages/protocol/src/mcp-tools.json), los mismos argumentos y los mismos campos en las respuestas. JSON-RPC 2.0, un
// mensaje por línea: la salida estándar sólo lleva mensajes; los registros van a la salida de errores.
//
// Sólo lee: nunca borra, mueve ni envía nada (save_snapshot escribe un resumen en el historial, como la app). Lo que
// cambia frente al motor Rust:
//   · Un TesseraEngine guarda un solo escaneo: cada escaneo en memoria es una instancia (las MAX_SCANS usadas más
//     recientemente, y no más de MAX_NODES elementos entre todas: el árbol de Bun ocupa unas cinco veces más que el
//     de Rust). Comparten los workers del recorrido, pero el servidor atiende las peticiones de una en una y nunca
//     recorren el disco dos a la vez.
//   · Sin diario USN (refresh.unavailable): `refresh` en la raíz de un escaneo lo vuelve a escanear entero; en una
//     carpeta de dentro, sólo esa carpeta (rescan).
//   · Los duplicados se comparan con SHA-256 (BLAKE3 en Rust).
// Mientras una herramienta trabaja se sigue leyendo la entrada, para atender notifications/cancelled.
import { readFileSync, statSync } from 'node:fs';
import { FLAG, type ChangeRow, type Engine, type EngineChoice, type NodeRow, type ScanProgress, type SearchRow, type SortKey, type VolumeInfo } from '../../../packages/protocol/src/index.ts';
import { MCP_INSTRUCTIONS, MCP_TOOLS } from '../../../packages/protocol/src/mcp.ts';
import {
  APP_VERSION, COMPARE_MAX_LIMIT, EngineError, HISTORY_KEEP, TESSERA_MAX_FILE, TesseraEngine, engineError, errorText, historyDir, listHistory,
  normalizePath, volumes, win32, type Store,
} from '../../../packages/core-bun/src/index.ts';
import { cmdOf, howKey, rulesFor, titleOf, type Key, type Risk, type Rule } from '../../../packages/ui/src/clean.ts';
import en from '../../../packages/i18n/locales/en.json';

/** Versiones del protocolo que entiende, la más reciente primero. Sólo usa herramientas, iguales en todas. */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Escaneos en memoria como mucho: cada uno guarda su árbol completo. */
export const MAX_SCANS = 4;
/**
 * Y elementos entre todos: el árbol del motor Bun ocupa unos 500 MB por cada 1,5 millones (el de Rust, unos 110), así que
 * con más se olvida el usado hace más tiempo. El último escaneo se queda siempre, aunque solo pase de aquí.
 */
export const MAX_NODES = 3_000_000;
/** Intervalo mínimo entre avisos de progreso (ms). */
const PROGRESS_EVERY = 1000;

// Errores de JSON-RPC
export const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602, INTERNAL_ERROR = -32603;

const NO_SCAN = 'No scan in memory yet: pass `path` (a folder or drive), or call `scan` first (list_volumes shows the drives).';
const ENGINES: EngineChoice[] = ['auto', 'walk', 'mft'];

type Args = Record<string, unknown>;
interface Rpc { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

/** Error de JSON-RPC (método o parámetros de la petición). */
class RpcError extends Error { constructor(readonly code: number, message: string) { super(message); } }
/** Error de una herramienta: llega al modelo como texto (`isError`), para que pueda corregirse. */
class ToolError extends Error { }
const fail = (message: string): never => { throw new ToolError(message); };

export interface McpOptions {
  /** Envía un mensaje al cliente: los avisos de progreso (las respuestas las devuelve `dispatch`). */
  send: (msg: unknown) => void;
  /** Workers del recorrido (por defecto, los del motor). */
  threads?: number;
  workerUrl?: string | URL;
  /** Registro de diagnóstico (a la salida de errores). */
  log?: (line: string) => void;
  /** Elementos en memoria entre todos los escaneos (pruebas); por defecto, MAX_NODES. */
  maxNodes?: number;
}

/** Lo que una herramienta necesita de su petición: el aviso de progreso (si el cliente lo pidió) y la cancelación. */
class Ctx {
  private last = 0;
  private count = 0;
  constructor(private send: (msg: unknown) => void, private token: unknown, readonly cancelled: () => boolean) { }

  /** `notifications/progress`, el primero en el acto y luego como mucho uno por PROGRESS_EVERY. */
  progress(message: string) {
    if (this.token === undefined) return;
    const now = performance.now();
    if (this.count > 0 && now - this.last < PROGRESS_EVERY) return;
    this.last = now; this.count++;
    this.send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: this.token, progress: this.count, message } });
  }
}

/** Un escaneo en memoria (un motor con su árbol) y, si se abrió desde un `.tessera`, ese archivo. */
interface Loaded { engine: TesseraEngine; file: string | null }
const storeOf = (l: Loaded): Store => l.engine.store ?? fail(NO_SCAN);

export class McpServer {
  /** El usado más recientemente al final. */
  readonly scans: Loaded[] = [];
  /** Id de la petición en curso, su cancelación y los motores que trabajan para ella. */
  private current: unknown = undefined;
  private cancelled = false;
  private running = new Set<TesseraEngine>();

  constructor(private opts: McpOptions) { }

  /** `notifications/cancelled`: para la petición en curso si es la que se cancela (las demás ya terminaron). */
  cancel(requestId: unknown) {
    if (this.current === undefined || requestId === undefined || requestId !== this.current) return;
    this.cancelled = true;
    for (const e of this.running) { e.cancel(); e.cancelDuplicates(); }
  }

  /** Respuesta a un mensaje o a un lote, si lleva: las notificaciones y las respuestas del cliente no. */
  async dispatch(msg: unknown): Promise<unknown> {
    if (Array.isArray(msg) && msg.length) {
      const out: unknown[] = [];
      for (const m of msg) { const r = await this.message(m); if (r !== undefined) out.push(r); }
      return out.length ? out : undefined;
    }
    return this.message(msg);
  }

  private async message(msg: unknown): Promise<unknown> {
    const m: Rpc = msg && typeof msg === 'object' && !Array.isArray(msg) ? msg : {};
    const id = m.id;
    if (typeof m.method !== 'string') {
      // Una respuesta del cliente (este servidor no le pide nada) no se contesta
      const reply = m.result === undefined && m.error === undefined;
      return id !== undefined && reply ? rpcError(id, INVALID_REQUEST, 'Invalid request: no method') : undefined;
    }
    // Notificaciones (initialized…): sin respuesta. La cancelación ya la atendió quien lee la entrada.
    if (id === undefined) return undefined;
    this.cancelled = false; this.current = id;
    let result: unknown;
    try {
      result = await this.request(m.method, m.params);
    } catch (e) {
      // Lo inesperado (fuera de una herramienta, que ya lo convierte en texto) no tumba el servidor
      if (!(e instanceof RpcError)) this.opts.log?.(`${m.method}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      const [code, message] = e instanceof RpcError ? [e.code, e.message] : [INTERNAL_ERROR, 'Internal error in TesseraFS (see the server log)'];
      return this.cancelled ? undefined : rpcError(id, code, message);
    } finally {
      this.current = undefined;
    }
    // Cancelada: el cliente ya no espera respuesta
    return this.cancelled ? undefined : { jsonrpc: '2.0', id, result };
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const p: Args = params && typeof params === 'object' && !Array.isArray(params) ? params as Args : {};
    switch (method) {
      case 'initialize': {
        const version = VERSIONS.find(v => v === p.protocolVersion) ?? VERSIONS[0];
        return {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tesserafs', title: 'TesseraFS', version: APP_VERSION },
          instructions: MCP_INSTRUCTIONS,
        };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: MCP_TOOLS };
      case 'tools/call': {
        if (typeof p.name !== 'string') throw new RpcError(INVALID_PARAMS, 'Missing tool name');
        const name = p.name;
        if (!MCP_TOOLS.some(t => t.name === name)) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
        const a = p.arguments ?? {};
        if (typeof a !== 'object' || Array.isArray(a)) throw new RpcError(INVALID_PARAMS, '`arguments` must be an object');
        const meta = p._meta && typeof p._meta === 'object' ? p._meta as Args : {};
        const ctx = new Ctx(this.opts.send, meta.progressToken, () => this.cancelled);
        try {
          return { content: [{ type: 'text', text: JSON.stringify(await this.call(name, a as Args, ctx), null, 2) }] };
        } catch (e) {
          let text: string;
          if (e instanceof ToolError) text = e.message;
          else if (e instanceof EngineError) text = engineText(e);
          else {
            this.opts.log?.(`${name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
            text = 'Internal error in TesseraFS (see the server log)';
          }
          return { content: [{ type: 'text', text }], isError: true };
        }
      }
      // Algunos clientes los piden aunque no se anuncien
      case 'resources/list': return { resources: [] };
      case 'resources/templates/list': return { resourceTemplates: [] };
      case 'prompts/list': return { prompts: [] };
      default: throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /** Ejecuta una herramienta. Los errores van al modelo como texto (`isError`), para que pueda corregirse. */
  private async call(name: string, a: Args, ctx: Ctx): Promise<unknown> {
    switch (name) {
      case 'list_volumes': return listVolumes();
      case 'scan': return this.scanTool(a, ctx);
      case 'largest': {
        const files = count(a, 'files', 20, 500), folders = count(a, 'folders', 10, 500);
        const depth = Math.max(count(a, 'depth', 1, 64), 1);
        const [l, id] = await this.at(a, ctx);
        const s = storeOf(l);
        return {
          path: s.path(id),
          scan: scanLabel(l),
          size: human(s.sz[id]),
          largestFiles: searchRows(files ? l.engine.search({ query: '', root: id, limit: files }).rows : []),
          largestFolders: searchRows(largestFolders(s, id, depth, folders)),
          folderDepth: depth,
        };
      }
      case 'list_folder': {
        const sort = optStr(a, 'sort') ?? 'size';
        const [key, desc] = Object.hasOwn(SORTS, sort) ? SORTS[sort] : fail(`Unknown sort "${sort}": use size, name, modified, files, onDisk or change`);
        const limit = count(a, 'limit', 50, 1000), offset = count(a, 'offset', 0, 0xFFFFFFFF);
        const [l, id] = await this.at(a, ctx);
        const s = storeOf(l);
        if (key === 'delta' && !s.cmp) fail('sort "change" needs a comparison: call compare_snapshot first');
        if (!s.isDir(id)) return { item: nodeRow(s, id), scan: scanLabel(l), note: 'This is a file, not a folder.' };
        const r = l.engine.children({ id, offset, limit, sort: key, desc });
        return { folder: nodeRow(s, id), scan: scanLabel(l), total: r.total, offset, items: r.rows.map(n => row(n, s.path(n.id))) };
      }
      case 'search': {
        const q = optStr(a, 'query') ?? '';
        const limit = count(a, 'limit', 50, 2000);
        const [l, id] = await this.at(a, ctx);
        const s = storeOf(l);
        const r = l.engine.search({ query: q, root: id, limit });
        if (r.error) fail(`Invalid query: ${r.error.message} [${r.error.code}]`);
        return {
          scope: s.path(id), scan: scanLabel(l), query: q, matches: r.total, totalSize: human(r.totalBytes), totalBytes: r.totalBytes,
          shown: r.rows.length, results: searchRows(r.rows),
        };
      }
      case 'file_types': {
        const limit = count(a, 'limit', 25, 1000);
        const [l, id] = await this.at(a, ctx);
        const s = storeOf(l);
        const v = l.engine.extStats(id);
        const total = Math.max(s.sz[id], 1);
        return {
          path: s.path(id), scan: scanLabel(l), size: human(s.sz[id]), typeCount: v.length,
          types: v.slice(0, limit).map(e => ({ ext: e.ext || '(none)', size: human(e.size), bytes: e.size, files: e.count, percent: Math.round(e.size * 1000 / total) / 10 })),
        };
      }
      case 'cleanup_candidates': return this.cleanupTool(a, ctx);
      case 'find_duplicates': return this.duplicatesTool(a, ctx);
      case 'broken_links': {
        const limit = count(a, 'limit', 50, 1000);
        const [l, id] = await this.at(a, ctx);
        const s = storeOf(l);
        const r = await l.engine.brokenLinks(id, limit); // scan.offline con un escaneo abierto desde archivo
        if (r.error) fail(`${r.error.message} [${r.error.code}]`);
        return { scope: s.path(id), scan: scanLabel(l), count: r.total, results: searchRows(r.rows) };
      }
      case 'history': {
        const only = optStr(a, 'path');
        const root = only === undefined ? undefined : normalizedOr(only, only);
        const list = listHistory().filter(e => root === undefined || sameRoot(e.path, root)).map(e => ({
          id: e.id, path: e.path, scannedAt: iso(e.scannedAt), size: human(e.bytes), bytes: e.bytes, files: e.files, folders: e.dirs, engine: e.engine,
        }));
        return { folder: historyDir(), count: list.length, snapshots: list };
      }
      case 'compare_snapshot': return this.compareTool(a, ctx);
      case 'size_trend': {
        const [l, id] = await this.at(a, ctx);
        const s = storeOf(l);
        const points: unknown[] = l.engine.historyTrend(id).map(p => ({ scannedAt: iso(p.scannedAt), snapshot: p.id, size: p.size === null ? null : human(p.size), bytes: p.size }));
        points.push({ scannedAt: iso(l.engine.scannedAt), snapshot: 'current scan', size: human(s.sz[id]), bytes: s.sz[id] });
        return { path: s.path(id), points, note: 'Oldest first. size null = it did not exist then (snapshots also skip files under 1 MiB).' };
      }
      case 'save_snapshot': {
        const [l] = await this.at(a, ctx);
        const e = l.engine.historySave();
        return {
          saved: { id: e.id, path: e.path, scannedAt: iso(e.scannedAt), size: human(e.bytes) },
          folder: historyDir(),
          note: `Compare later with compare_snapshot. The history keeps the ${HISTORY_KEEP} most recent snapshots of each folder.`,
        };
      }
      default: return fail(`Unknown tool: ${name}`);
    }
  }

  private newEngine() { return new TesseraEngine({ threads: this.opts.threads, workerUrl: this.opts.workerUrl, log: this.opts.log }); }

  /** Una operación larga de `e` (escaneo, rescan, duplicados) que `cancel` puede parar, aunque llegue antes de empezar. */
  private async run<T>(e: TesseraEngine, start: () => Promise<T>): Promise<T> {
    this.running.add(e);
    try {
      const p = start(); // el motor ya marca la operación en curso antes de su primer await
      if (this.cancelled) { e.cancel(); e.cancelDuplicates(); }
      return await p;
    } finally {
      this.running.delete(e);
    }
  }

  private scanWith(e: TesseraEngine, path: string, engine: EngineChoice, ctx: Ctx) {
    return this.run(e, () => e.scan({ path, engine }, p => ctx.progress(scanMessage(path, p))));
  }

  /** Escaneo y nodo del argumento `path` (ver `locate`). */
  private async at(a: Args, ctx: Ctx): Promise<[Loaded, number]> {
    const [i, id] = await this.locate(optStr(a, 'path'), ctx);
    return [this.scans[i], id];
  }

  /**
   * Índice del escaneo en memoria y nodo de `path`: el escaneo más concreto que la contiene (en empate, el usado más
   * recientemente); si ninguno, escanea `path` (o abre el `.tessera`). Sin `path`, la raíz del último escaneo usado.
   */
  private async locate(path: string | undefined, ctx: Ctx): Promise<[number, number]> {
    if (path === undefined) return this.scans.length ? [this.scans.length - 1, 0] : fail(NO_SCAN);
    if (isSavedScan(path)) return [this.openSaved(path), 0];
    const raw = unquote(path);
    const norm = normalizedOr(raw, undefined);
    // Un `.tessera` guarda las rutas del equipo donde se escaneó: se buscan tal cual
    let hit = -1, len = -1, want = '';
    for (const [i, l] of this.scans.entries()) {
      const w = l.file !== null ? raw : norm, root = l.engine.store?.rootPath;
      if (w !== undefined && root !== undefined && contains(root, w) && root.length >= len) { hit = i; len = root.length; want = w; }
    }
    if (hit >= 0) {
      const i = this.touch(hit), l = this.scans[i], s = storeOf(l);
      const id = findNode(s, want);
      if (id === null) {
        fail(`${want} is not in the scan of ${s.rootPath} (${iso(l.engine.scannedAt)}): it may be newer than the scan, or unreadable. Call \`scan\` with this path and refresh: true.`);
      }
      return [i, id!];
    }
    if (norm === undefined) return fail(`Invalid path: ${path}`);
    const e = this.newEngine();
    await this.scanWith(e, norm, 'auto', ctx);
    return [this.add({ engine: e, file: null }), 0];
  }

  /** Índice del `.tessera` `p`, abierto ahora o antes. */
  private openSaved(p: string): number {
    const file = unquote(p);
    const i = this.scans.findIndex(l => l.file === file);
    if (i >= 0) return this.touch(i);
    let data: Uint8Array;
    try {
      if (statSync(file).size > TESSERA_MAX_FILE) throw new Error(`the file is too large (more than ${TESSERA_MAX_FILE} bytes)`);
      data = readFileSync(file);
    } catch (e) {
      throw engineError('scan.openFailed', { error: errorText(e) });
    }
    const e = this.newEngine();
    e.openScan(data);
    return this.add({ engine: e, file });
  }

  /** Pasa el escaneo `i` al final (el usado más recientemente) y devuelve su índice nuevo. */
  private touch(i: number): number {
    this.scans.push(...this.scans.splice(i, 1));
    return this.scans.length - 1;
  }

  /**
   * Guarda un escaneo: sustituye a los de su misma raíz o de dentro (éste es más reciente) y olvida los usados hace más
   * tiempo si pasan de MAX_SCANS o de `maxNodes` elementos. Devuelve su índice.
   */
  private add(l: Loaded): number {
    const root = storeOf(l).rootPath;
    const keep = l.file === null
      ? (o: Loaded) => o.file !== null || !o.engine.store || !contains(root, o.engine.store.rootPath)
      : (o: Loaded) => o.file !== l.file;
    const rest = this.scans.filter(o => o !== l && keep(o));
    this.scans.splice(0, this.scans.length, ...rest, l);
    const max = this.opts.maxNodes ?? MAX_NODES, nodes = () => this.scans.reduce((t, o) => t + (o.engine.store?.n ?? 0), 0);
    let dropped = false;
    while (this.scans.length > 1 && (this.scans.length > MAX_SCANS || nodes() > max)) { this.scans.shift(); dropped = true; }
    if (dropped) Bun.gc(true); // devuelve ya la memoria de los árboles olvidados
    return this.scans.length - 1;
  }

  /**
   * `scan`: escanea, o responde desde la memoria si ya está escaneado. Con `refresh` lo pone al día: una carpeta de
   * dentro se vuelve a escanear sola (rescan); la raíz, entera (el motor Bun no tiene el diario USN).
   */
  private async scanTool(a: Args, ctx: Ctx): Promise<unknown> {
    const path = optStr(a, 'path') ?? fail('`path` is required: the drive or folder to scan, or a .tessera file');
    const refresh = boolArg(a, 'refresh');
    const ev = optStr(a, 'engine');
    const engine: EngineChoice = ev === undefined ? 'auto' : (ENGINES as string[]).includes(ev) ? ev as EngineChoice : fail(`Unknown engine: "${ev}" (use auto, walk or mft)`);
    if (isSavedScan(path)) return summary(this.scans[this.openSaved(path)], 0);
    const norm = normalizePath(unquote(path)); // error.invalidPath
    let hit = -1, len = -1;
    this.scans.forEach((l, i) => {
      const root = l.engine.store?.rootPath;
      if (l.file === null && root !== undefined && contains(root, norm) && root.length >= len) { hit = i; len = root.length; }
    });
    if (hit >= 0) {
      const i = this.touch(hit), l = this.scans[i], e = l.engine, s = storeOf(l);
      const id = findNode(s, norm);
      if (id !== null) {
        if (!refresh) {
          return summary(l, id, id !== s.rootId ? `From the scan of ${s.rootPath} in memory; refresh: true scans it again.` : 'From memory; refresh: true scans it again.');
        }
        const dir = s.isDir(id) ? id : s.row(id).parentId;
        if (dir > s.rootId) {
          const r = await this.run(e, () => e.rescan(dir, p => ctx.progress(scanMessage(norm, p))));
          return summary(l, dir, `Rescanned inside the scan of ${s.rootPath}: was ${human(r.before)}, now ${human(r.row.size)}.`);
        }
        // La raíz (o un archivo suelto en ella): sin diario USN, se vuelve a escanear entera en el mismo motor, que suelta
        // antes el árbol anterior (así no conviven dos en memoria). Si el escaneo no termina, ese escaneo se pierde.
        const root = s.rootPath;
        try {
          await this.scanWith(e, root, engine, ctx);
        } catch (err) {
          const k = this.scans.indexOf(l);
          if (!e.store && k >= 0) this.scans.splice(k, 1);
          throw err;
        }
        return summary(this.scans[this.add(l)], 0, 'Scanned again in full: the portable edition cannot update a scan from the NTFS change journal.');
      }
    }
    const e = this.newEngine();
    await this.scanWith(e, norm, engine, ctx);
    return summary(this.scans[this.add({ engine: e, file: null })], 0);
  }

  private async duplicatesTool(a: Args, ctx: Ctx): Promise<unknown> {
    const BAD = '`minSize` must be a size such as "10MB" or a byte count';
    const m = a.minSize;
    let min: number;
    if (m == null) min = 1 << 20;
    else if (typeof m === 'number') min = m >= 0 ? Math.floor(m) : fail(BAD);
    else if (typeof m === 'string') {
      const t = parseThreshold(m);
      min = t.bytes ?? fail('`minSize` must be a size such as "10MB", not a percentage');
    } else return fail(BAD);
    const limit = count(a, 'limit', 20, 500);
    const [l, id] = await this.at(a, ctx);
    const s = storeOf(l), e = l.engine;
    const r = await this.run(e, () => e.duplicates({ root: id, minSize: min, limit }, p =>
      ctx.progress(`Duplicates (${p.phase}): ${sep(p.files)}/${sep(p.totalFiles)} files, ${human(p.bytes)}/${human(p.totalBytes)}`)));
    return {
      scope: s.path(id),
      scan: scanLabel(l),
      minSize: human(min),
      groupCount: r.totalGroups,
      reclaimable: human(r.wasted),
      reclaimableBytes: r.wasted,
      groups: r.groups.map(g => ({
        size: human(g.size),
        copies: g.files.length,
        wasted: human(g.size * (g.files.length - 1)),
        files: g.files.map(f => f.mtime > 0 ? { path: f.path, modified: iso(f.mtime) } : { path: f.path }),
      })),
      filesCompared: r.candidates,
      bytesRead: human(r.readBytes),
      skipped: { hardlinks: r.skipped.hardlinks, cloudOnly: r.skipped.cloud },
      elapsedMs: r.elapsedMs,
      warnings: r.warnings.map(w => w.message),
      note: 'Identical content (SHA-256 of the whole file). Hard links and cloud-only files are not compared.',
    };
  }

  /** `cleanup_candidates`: las reglas de «Liberar espacio» sobre el escaneo en memoria (ver `candidates`). */
  private async cleanupTool(a: Args, ctx: Ctx): Promise<unknown> {
    const only = risks(a);
    const limit = count(a, 'limit', 50, 500);
    const [l, id] = await this.at(a, ctx);
    const s = storeOf(l);
    const os = isPosix(s.rootPath) ? 'linux' : 'windows';
    const cards = await candidates(l.engine, id, (rule, i, n) => ctx.progress(`Cleanup rules ${i + 1}/${n}: ${rule}`), ctx.cancelled);
    const byRisk = Object.fromEntries(RISKS.map(r => {
      const of = cards.filter(c => c.rule.risk === r), bytes = of.reduce((t, c) => t + c.size, 0);
      return [r, { label: riskLabel(r), candidates: of.length, size: human(bytes), bytes }];
    }));
    const shown = cards.filter(c => !only || only.includes(c.rule.risk));
    const scope = s.path(id);
    return {
      scope,
      scan: scanLabel(l),
      rules: os,
      byRisk,
      matches: shown.length,
      candidates: shown.slice(0, limit).map(c => cleanupCard(c, scope, os)),
      note: 'The rules of the Free up space tab in the TesseraFS app; nothing was deleted. Explain each candidate with its why, '
        + 'prefer its command or how over deleting the folder, and never suggest deleting a risk "bad" item by hand. '
        + `The user can also mark candidates in the app and send them to the ${os === 'windows' ? 'Recycle Bin' : 'Trash'}.`,
    };
  }

  private async compareTool(a: Args, ctx: Ctx): Promise<unknown> {
    const limit = count(a, 'limit', 20, COMPARE_MAX_LIMIT);
    const snapshot = optStr(a, 'snapshotId');
    const [l] = await this.at(a, ctx);
    const e = l.engine, s = storeOf(l);
    if (e.offline) throw engineError('scan.offline');
    const engine = e.result!.engine;
    // Por defecto, el más reciente hecho con el mismo motor: con otro, parte de la diferencia es del motor
    const mine = listHistory().filter(h => h.scannedAt !== e.scannedAt && sameRoot(h.path, s.rootPath));
    const id = snapshot ?? (mine.find(h => h.engine === engine) ?? mine[0])?.id ?? fail(
      `There is no snapshot of ${s.rootPath} to compare with. Save one now with save_snapshot and compare in a later session `
      + '(the TesseraFS app and its scheduled scan also save them).');
    const r = e.compare(id, limit);
    const art = new Artifacts(l, r.entry.engine);
    const mark = (o: Record<string, unknown>, path: string, change: Change) => {
      const why = art.reason(path, change);
      if (why) o.likelyArtifact = why;
      return o;
    };
    const changes = (v: ChangeRow[], change: Change) =>
      v.map(c => mark(row({ ...c, prev: c.prev ?? undefined, fresh: c.prev === null || undefined }, c.path), c.path, change));
    const warnings = art.warnings();
    return {
      root: s.rootPath,
      snapshot: { id: r.entry.id, scannedAt: iso(r.entry.scannedAt), engine: r.entry.engine },
      now: iso(e.scannedAt),
      nowEngine: engine,
      before: totals(r.before),
      after: totals(r.after),
      change: signed(r.after.bytes - r.before.bytes),
      grew: changes(r.grew, 'grew'),
      shrank: changes(r.shrank, 'shrank'),
      removed: r.removed.map(x => mark({ path: x.path, type: kind(x.isDir), size: human(x.size) }, x.path, 'removed')),
      note: 'The comparison stays active: list_folder with sort "change" shows what changed inside any folder.',
      ...(warnings.length ? { warnings } : {}),
    };
  }
}

// ---------- Comparación: lo que no es un cambio ----------

/** La lista de la comparación en la que va una fila. */
type Change = 'grew' | 'shrank' | 'removed';

/**
 * Lo que una comparación cuenta como cambio sin serlo (igual que tessera-cli). Una carpeta que este escaneo no pudo leer
 * sale vacía, así que lo que el resumen tenía dentro cuenta como reducido o eliminado. Y con motores distintos, la MFT
 * (con administrador) ve los metadatos de NTFS de la raíz ($MFT, $LogFile…) y carpetas protegidas que el recorrido sin
 * administrador no ve.
 */
class Artifacts {
  private readonly s: Store;
  private readonly now: Engine;
  /** Carpetas que este escaneo no pudo leer (scan.accessDenied). */
  private readonly denied: number;

  constructor(l: Loaded, private readonly then: Engine) {
    this.s = storeOf(l);
    this.now = l.engine.result!.engine;
    const n = Number(l.engine.result!.warnings.find(w => w.code === 'scan.accessDenied')?.params?.count ?? 0);
    this.denied = Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Por qué la fila de `path` es, probablemente, efecto de cómo se hicieron los escaneos y no un cambio en el disco. */
  reason(path: string, change: Change): string | undefined {
    const sp = isPosix(path) ? '/' : '\\';
    let p = path;
    while (p.endsWith(sp)) p = p.slice(0, -1);
    const i = p.lastIndexOf(sp);
    if (i < 0) return undefined;
    const parent = p.slice(0, i), name = p.slice(i + 1);
    if (this.now !== this.then && name.startsWith('$') && sameRoot(parent, this.s.rootPath)) {
      return 'NTFS metadata at the root of the drive: only the MFT engine counts it';
    }
    if (this.denied === 0 || change === 'grew') return undefined;
    // La carpeta (o, si ya no está, la que la contenía) está vacía ahora: lo más probable es que no se pudiera leer
    const id = findNode(this.s, change === 'removed' ? parent : path);
    return id !== null && this.s.isDir(id) && this.s.children(id).length === 0
      ? 'this scan could not read this folder (access denied): it looks empty now, but it was probably not emptied'
      : undefined;
  }

  warnings(): string[] {
    const v: string[] = [];
    if (this.now !== this.then) {
      const { now, then } = this;
      v.push(`This scan used the ${now} engine and the snapshot the ${then} engine. The MFT engine (as administrator) also counts `
        + 'protected folders (System Volume Information, Recovery, WindowsApps…) and NTFS metadata ($MFT…) that a walk without '
        + 'administrator cannot read, so part of the difference, totals included, comes from how the scans were made and not '
        + `from the disk. For an exact comparison, pass the snapshotId of a ${now} snapshot (history shows each one's engine) `
        + 'or scan the same way both times.');
    }
    if (this.denied > 0) {
      const n = this.denied;
      v.push(`This scan could not read ${n} folder${n === 1 ? '' : 's'} (access denied). Unreadable folders look empty, so whatever the snapshot `
        + 'counted inside them shows up as shrunk or removed: the rows marked likelyArtifact are probably that, not deletions.');
    }
    return v;
  }
}

// ---------- Argumentos ----------

const SORTS: Record<string, [SortKey, boolean]> = {
  size: ['size', true], name: ['name', false], modified: ['mtime', true], files: ['files', true], onDisk: ['alloc', true], change: ['delta', true],
};

function optStr(a: Args, k: string): string | undefined {
  const v = a[k];
  if (v == null) return undefined;
  if (typeof v !== 'string') return fail(`\`${k}\` must be a string`);
  return v.trim() ? v : undefined;
}

/** Entero no negativo (también en texto: algunos modelos lo mandan así), como mucho `max`. */
function count(a: Args, k: string, def: number, max: number): number {
  const v = a[k];
  if (v == null) return def;
  const n = typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v
    : typeof v === 'string' && /^\+?\d+$/.test(v.trim()) ? Number(v.trim()) : fail(`\`${k}\` must be a non-negative integer`);
  return Math.min(n, max);
}

const RISKS: Risk[] = ['ok', 'warn', 'bad'];

/** `risk`: «ok», «warn,bad» o una lista; undefined = todos. */
function risks(a: Args): Risk[] | undefined {
  const BAD = '`risk` must be ok, warn or bad, or several of them separated by commas';
  const v = a.risk;
  if (v == null) return undefined;
  const words = typeof v === 'string' ? v.split(',').map(w => w.trim().toLowerCase()).filter(Boolean)
    : Array.isArray(v) ? v.map(w => typeof w === 'string' ? w.trim().toLowerCase() : fail(BAD)) : fail(BAD);
  if (!words.length) return undefined;
  return words.map(w => (RISKS as string[]).includes(w) ? w as Risk : fail(`Unknown risk "${w}": use ok, warn or bad`));
}

function boolArg(a: Args, k: string): boolean {
  const v = a[k];
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 'false') return v === 'true';
  return fail(`\`${k}\` must be true or false`);
}

/** Número no negativo con punto o coma decimal. */
const decimal = (s: string) => /^[\d.,]+$/.test(s) ? Number(s.replace(/,/g, '.')) : NaN;

/** `10%`, `500MB`, `20 GB`, `1,5TiB`, `4096` (bytes). K/KB/KiB… = 1024 (como el Explorador). Como `parse_threshold` de tessera-cli. */
export function parseThreshold(s: string): { bytes?: number; percent?: number } {
  const t = s.trim();
  const bad = () => fail(`Umbral no válido: "${s}" (p. ej. 10%, 500MB o 20GB)`);
  if (t.endsWith('%')) {
    const v = decimal(t.slice(0, -1).trim());
    if (!Number.isFinite(v)) return bad();
    if (v > 100) fail(`Porcentaje mayor que 100: "${s}"`);
    return { percent: v };
  }
  const at = t.search(/[A-Za-z]/);
  const v = decimal((at < 0 ? t : t.slice(0, at)).trim());
  if (!Number.isFinite(v)) return bad();
  const unit = at < 0 ? '' : t.slice(at).toUpperCase();
  const mult = ({ '': 1, B: 1, K: 2 ** 10, KB: 2 ** 10, KIB: 2 ** 10, M: 2 ** 20, MB: 2 ** 20, MIB: 2 ** 20, G: 2 ** 30, GB: 2 ** 30, GIB: 2 ** 30, T: 2 ** 40, TB: 2 ** 40, TIB: 2 ** 40 } as Record<string, number>)[unit] ?? bad();
  const b = v * mult;
  if (b >= 2 ** 64) fail(`Umbral demasiado grande: "${s}"`);
  return { bytes: Math.round(b) };
}

// ---------- Rutas ----------

const isPosix = (p: string) => p.startsWith('/');
/** Sin espacios ni comillas alrededor, como llegan a veces las rutas de Windows. */
const unquote = (p: string) => p.trim().replace(/^"+|"+$/g, '');
const isSavedScan = (p: string) => { const f = unquote(p); try { return /\.tessera$/i.test(f) && statSync(f).isFile(); } catch { return false; } };
/** La ruta normalizada o, si no es válida, `or`. */
function normalizedOr<T>(p: string, or: T): string | T {
  try { return normalizePath(p); } catch { return or; }
}

/** `path` es `root` o está dentro: en Windows sin distinguir mayúsculas y con `\` o `/`. */
export function contains(root: string, path: string): boolean {
  const posix = isPosix(root), sp = posix ? '/' : '\\';
  const key = (s: string) => posix ? s : s.replace(/\//g, '\\').toLowerCase();
  let r = key(root);
  while (r.endsWith(sp)) r = r.slice(0, -1);
  const p = key(path);
  return p === r || (p.startsWith(r) && p[r.length] === sp);
}

const sameRoot = (a: string, b: string) => contains(a, b) && contains(b, a);

/** Nodo vivo en `path`: absoluta (bajo la raíz) o relativa a la raíz; en Windows sin distinguir mayúsculas y con `\` o `/`. */
export function findNode(s: Store, path: string): number | null {
  const fold = !isPosix(s.rootPath);
  const key = (x: string) => fold ? x.toLowerCase() : x;
  const seps = fold ? /[\\/]/ : /\//;
  const root = key(s.rootPath.replace(fold ? /[\\/]+$/ : /\/+$/, ''));
  const k = key(path.trim());
  const rest = k.startsWith(root) ? k.slice(root.length) : null;
  const rel = rest !== null && (!rest || seps.test(rest[0])) ? rest : k;
  let id = s.rootId;
  for (const want of rel.split(seps)) {
    if (!want || want === '.') continue;
    let next = -1;
    for (const c of s.children(id)) if (key(s.name(c)) === want) { next = c; break; }
    if (next < 0) return null;
    id = next;
  }
  return id;
}

/** Las `n` carpetas más grandes a profundidad `depth` bajo `root` (1 = sus hijas directas). */
function largestFolders(s: Store, root: number, depth: number, n: number): SearchRow[] {
  if (!n) return [];
  let level = [root];
  for (let d = 0; d < depth; d++) level = level.flatMap(id => Array.from(s.children(id))).filter(k => s.isDir(k));
  level.sort((x, y) => s.sz[y] - s.sz[x] || x - y);
  return level.slice(0, n).map(id => ({ ...s.row(id), path: s.path(id) }));
}

// ---------- Resultados ----------

const engineText = (e: EngineError) => `${e.msg.message} [${e.code}]`;

/** 1.50 GiB (base 1024, dos decimales; los bytes, enteros). */
export function human(b: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = b, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i ? `${v.toFixed(2)} ${units[i]}` : `${b} B`;
}
/** 1.234.567 */
const sep = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const signed = (d: number) => (d < 0 ? '-' : '+') + human(Math.abs(d));
/** `YYYY-MM-DDTHH:MM:SSZ` (vacío si no hay fecha). */
export const iso = (secs: number) => secs ? new Date(secs * 1000).toISOString().slice(0, 19) + 'Z' : '';
const kind = (isDir: boolean) => isDir ? 'folder' : 'file';

function scanMessage(path: string, p: ScanProgress) {
  return `Scanning ${path} (${p.phase}): ${sep(p.entries)} items, ${human(p.bytes)}`;
}

/** «C:\ scanned 2026-10-15T08:00:00Z», y de dónde viene si se abrió desde un `.tessera`. */
function scanLabel(l: Loaded): string {
  const e = l.engine, o = e.offline;
  const label = `${e.result?.rootPath ?? storeOf(l).rootPath} scanned ${iso(e.scannedAt)}`;
  return o ? `${label} (saved scan from ${o.host ?? 'another computer'}: read-only, no disk access)` : label;
}

/** Atributos que importan al explicar el espacio. */
const ATTRS: [number, string][] = [
  [FLAG.CLOUD, 'cloud'], [FLAG.COMPRESSED, 'compressed'], [FLAG.SPARSE, 'sparse'], [FLAG.HARDLINK, 'hardlink'], [FLAG.REPARSE, 'link'],
  [FLAG.HIDDEN, 'hidden'], [FLAG.SYSTEM, 'system'],
];

/**
 * Una fila: tamaño legible y en bytes, espacio en disco si difiere mucho (comprimido, en la nube, muchos archivos
 * pequeños), contenido de las carpetas, fecha, atributos y, con una comparación activa, el cambio.
 */
function row(n: NodeRow, path: string): Record<string, unknown> {
  const o: Record<string, unknown> = { path, type: kind(n.isDir), size: human(n.size), bytes: n.size };
  if (Math.abs(n.alloc - n.size) > Math.max(Math.floor(n.size / 10), 1 << 20)) o.onDisk = human(n.alloc);
  if (n.isDir) { o.files = n.files; o.folders = n.dirs; }
  if (n.mtime > 0) o.modified = iso(n.mtime);
  const attrs = ATTRS.filter(([f]) => n.flags & f).map(([, name]) => name);
  if (attrs.length) o.attributes = attrs;
  if (n.prev !== undefined) { o.before = human(n.prev); o.change = signed(n.size - n.prev); }
  else if (n.fresh) o.new = true;
  return o;
}

const nodeRow = (s: Store, id: number) => row(s.row(id), s.path(id));
const searchRows = (rows: SearchRow[]) => rows.map(r => row(r, r.path));
const totals = (t: { bytes: number; files: number; dirs: number }) => ({ size: human(t.bytes), bytes: t.bytes, files: t.files, folders: t.dirs });

function volume(v: VolumeInfo) {
  const pct = v.total > 0 ? Math.round(v.free * 1000 / v.total) / 10 : 0;
  return { path: v.path, label: v.label, fileSystem: v.fs, size: human(v.total), free: human(v.free), freeBytes: v.free, freePercent: pct };
}

function listVolumes() {
  return { volumes: volumes().map(volume), administrator: win32.isElevated() };
}

/** Lo que devuelve `scan`: totales del nodo, lo más grande dentro y, en la raíz, el volumen y los avisos. */
function summary(l: Loaded, id: number, note?: string): unknown {
  const s = storeOf(l), r = l.engine.result;
  const o: Record<string, unknown> = {
    path: s.path(id), scan: scanLabel(l), size: human(s.sz[id]), bytes: s.sz[id], onDisk: human(s.al[id]), files: s.nf[id], folders: s.nd[id],
  };
  if (id === s.rootId && r) {
    o.engine = r.engine;
    o.elapsedMs = r.elapsedMs;
    if (r.volume) o.volume = volume(r.volume);
    if (r.warnings.length) o.warnings = r.warnings.map(w => w.message);
  }
  o.largestItems = l.engine.children({ id, offset: 0, limit: 15, sort: 'size', desc: true }).rows.map(n => row(n, s.path(n.id)));
  if (note) o.note = note;
  return o;
}

// ---------- Liberar espacio ----------
// Lo que hace la pestaña «Liberar espacio» (`loadClean` en packages/ui/src/app.ts) con sus mismas reglas
// (packages/protocol/src/clean-rules.json, compiladas por packages/ui/src/clean.ts), como `candidates` en
// crates/tessera-cli/src/clean.rs: ejecuta la consulta de cada regla, la afina por nombre, ruta y atributos, confirma
// los hijos (`needs`), aplica el tamaño mínimo, agrupa y ordena. Sólo lee. Los textos son los del catálogo inglés.

/** Un candidato, como una tarjeta de la pestaña. */
interface Card {
  rule: Rule;
  path: string;
  isDir: boolean;
  /** Lo que cuenta: el espacio en disco con `useAlloc`, la suma de los archivos agrupados, el total de la lista. */
  size: number;
  title: Key;
  cmd?: string;
  /** Agrupada por carpeta: sus archivos, los más grandes primero. */
  files: SearchRow[];
  /** Tarjeta de resumen: cuántos hay y algunos. */
  total?: number;
  sample: string[];
}

/**
 * Lo que la pestaña propondría dentro de `root`: lo seguro primero y, dentro de cada riesgo, lo más grande. Entre regla y
 * regla cede el turno, para que se lea la entrada (una cancelación).
 */
async function candidates(e: TesseraEngine, root: number, progress: (rule: string, i: number, n: number) => void, cancelled: () => boolean): Promise<Card[]> {
  const s = e.store ?? fail(NO_SCAN);
  const rules = rulesFor(isPosix(s.rootPath) ? 'linux' : 'windows');
  const cards: Card[] = [];
  // Rutas que ya tienen tarjeta: la caché declarada no se repite ni se anida
  const seen: string[] = [];
  const counted = (rule: Rule, r: NodeRow) => rule.useAlloc ? r.alloc : r.size;
  for (const [i, rule] of rules.entries()) {
    await new Promise(r => setImmediate(r));
    if (cancelled()) throw engineError('error.cancelled');
    progress(rule.id, i, rules.length);
    if (rule.list) {
      // Un escaneo abierto desde un .tessera no puede mirar el disco
      if (rule.list === 'links' && e.offline) continue;
      const res = rule.list === 'links' ? await e.brokenLinks(root, 500) : e.search({ query: rule.q, root, limit: 500 });
      if (res.error || !res.total || !res.rows.length) continue;
      cards.push({
        rule, path: s.path(root), isDir: true, size: res.totalBytes, title: titleOf(rule, res.rows[0]), files: [], total: res.total,
        sample: res.rows.slice(0, 6).map(r => r.path),
      });
      continue;
    }
    const res = e.search({ query: rule.q, root, limit: 200 });
    if (res.error) continue;
    if (rule.parent) {
      // La consulta encuentra la marca (CACHEDIR.TAG); el candidato es la carpeta que la contiene
      for (const r of res.rows.slice(0, 60)) {
        const dir = r.parentId;
        if (dir < 0 || dir === root) continue;
        const d = s.row(dir), path = s.path(dir), t = { ...d, path };
        if ((rule.ok && !rule.ok(t)) || (rule.min && d.size < rule.min) || seen.some(x => contains(x, path) || contains(path, x))) continue;
        seen.push(path);
        cards.push({ rule, path, isDir: true, size: d.size, title: titleOf(rule, t), files: [], sample: [] });
      }
      continue;
    }
    let rows = res.rows.filter(r => (!rule.ok || rule.ok(r)) && (!rule.min || rule.group || counted(rule, r) >= rule.min));
    if (rule.needs) {
      const needs = rule.needs;
      rows = rows.slice(0, 40).filter(r => Array.from(s.children(r.id)).some(c => needs.includes(s.name(c).toLowerCase())));
    }
    if (rule.group) {
      // Una tarjeta por carpeta, en el orden en que aparecen (los archivos más grandes primero)
      const by = new Map<number, SearchRow[]>();
      for (const r of rows) if (r.parentId >= 0) by.set(r.parentId, [...by.get(r.parentId) ?? [], r]);
      for (const [p, list] of by) {
        const size = list.reduce((t, r) => t + r.size, 0);
        if (rule.min && size < rule.min) continue;
        const path = s.path(p);
        seen.push(path);
        cards.push({ rule, path, isDir: true, size, title: titleOf(rule, list[0]), cmd: cmdOf(rule, list[0]), files: list, sample: [] });
      }
    } else {
      for (const r of rows) {
        seen.push(r.path);
        cards.push({ rule, path: r.path, isDir: r.isDir, size: counted(rule, r), title: titleOf(rule, r), cmd: cmdOf(rule, r), files: [], sample: [] });
      }
    }
  }
  const order = { ok: 0, warn: 1, bad: 2 };
  return cards.sort((x, y) => order[x.rule.risk] - order[y.rule.risk] || y.size - x.size);
}

/** «Safe», «Review», «Don’t delete by hand»: como en la app. */
const riskLabel = (r: Risk) => text(`clean.risk.${r}`, undefined, 'windows') ?? r;

/**
 * Un candidato de `cleanup_candidates` con los textos ingleses de la app: título, riesgo, tamaño, por qué, cómo y la
 * orden. Una tarjeta de resumen (vacíos, enlaces rotos) dice cuántos hay, algunos y cómo verlos todos.
 */
function cleanupCard(c: Card, scope: string, os: string): Record<string, unknown> {
  const r = c.rule;
  const o: Record<string, unknown> = { title: text(c.title[0], c.title[1], os) ?? r.id, risk: r.risk, riskLabel: riskLabel(r.risk) };
  if (c.total !== undefined) {
    o.items = c.total;
    o.size = human(c.size);
    o.examples = c.sample;
    o.listAll = r.list === 'links'
      ? { tool: 'broken_links', arguments: { path: scope } }
      : { tool: 'search', arguments: { query: r.q, path: scope, limit: Math.min(c.total, 2000) } };
  } else {
    o.path = c.path;
    o.type = kind(c.isDir);
    o.size = human(c.size);
    o.bytes = c.size;
    if (r.useAlloc) o.sizeIs = 'space on disk: what freeing it recovers';
  }
  if (c.files.length) {
    o.fileCount = c.files.length;
    o.files = c.files.slice(0, 10).map(f => ({ path: f.path, size: human(f.size) }));
  }
  const why = text(`clean.${r.id}.why`, undefined, os);
  if (why !== undefined) o.why = why;
  const how = r.how ? text(howKey(r), undefined, os) : undefined;
  if (how !== undefined) o.how = how;
  if (c.cmd) o.command = c.cmd;
  // OneDrive: la app tiene su propio botón, que deja los archivos sólo en la nube sin borrar nada
  const button = r.action === 'freeUp' ? text('clean.freeUp', undefined, os) : undefined;
  if (button !== undefined) o.appButton = button;
  o.rule = r.id;
  return o;
}

// ---------- Textos ----------

const EN = en as Record<string, string>;

/** Texto inglés de la app con sus parámetros; `os` (windows o linux) elige lo que cambia según el sistema. */
export function text(key: string, params: Record<string, string> | undefined, os: string): string | undefined {
  if (!Object.hasOwn(EN, key)) return undefined;
  const m = EN[key];
  return icu(m, name => name === 'os' ? os : params?.[name]);
}

/**
 * Lo que usan estos textos de ICU MessageFormat: `{arg}` y `{arg, select, clave {…} other {…}}` (con otro tipo, como
 * plural, la rama `other`). Lo mismo que `icu` en crates/tessera-cli/src/clean.rs, para que las dos ediciones digan lo mismo.
 */
function icu(m: string, arg: (name: string) => string | undefined): string {
  let out = '', rest = m;
  for (let i = rest.indexOf('{'); i >= 0; i = rest.indexOf('{')) {
    out += rest.slice(0, i);
    const end = closing(rest, i);
    if (end < 0) return out + rest.slice(i);
    out += argument(rest.slice(i + 1, end), arg);
    rest = rest.slice(end + 1);
  }
  return out + rest;
}

/** Posición de la `}` que cierra la `{` de `s[open]`, o -1. */
function closing(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

function argument(inner: string, arg: (name: string) => string | undefined): string {
  const c1 = inner.indexOf(','), c2 = c1 < 0 ? -1 : inner.indexOf(',', c1 + 1);
  const value = arg((c1 < 0 ? inner : inner.slice(0, c1)).trim());
  if (c2 < 0) return value ?? `{${inner}}`;
  const branches: [string, string][] = [];
  let rest = inner.slice(c2 + 1);
  for (let i = rest.indexOf('{'); i >= 0; i = rest.indexOf('{')) {
    const end = closing(rest, i);
    if (end < 0) break;
    branches.push([rest.slice(0, i).trim(), rest.slice(i + 1, end)]);
    rest = rest.slice(end + 1);
  }
  const pick = branches.find(([k]) => k === value) ?? branches.find(([k]) => k === 'other');
  return pick ? icu(pick[1], arg) : '';
}

// ---------- Entrada y salida ----------

/**
 * Atiende a un cliente por la entrada y la salida estándar hasta que cierra la entrada. Las peticiones se atienden de una
 * en una, en orden; `notifications/cancelled` se atiende en cuanto llega (la petición en curso puede estar escaneando).
 */
export async function runMcp(opts: { threads?: number; workerUrl?: string | URL } = {}): Promise<void> {
  const log = (line: string) => process.stderr.write(`[tesserafs mcp] ${line}\n`);
  // Sin salida no hay cliente: el bucle termina cuando se cierra la entrada
  process.stdout.on?.('error', () => { });
  const send = (v: unknown) => { process.stdout.write(JSON.stringify(v) + '\n'); };
  const server = new McpServer({ send, threads: opts.threads, workerUrl: opts.workerUrl, log });
  process.stderr.write(`tesserafs ${APP_VERSION} mcp: servidor MCP en la entrada y la salida estándar (sólo lectura, edición portable)\n`);

  const queue: unknown[] = [];
  const idle = () => { };
  let ended = false, wake = idle;
  const line = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    let m: unknown;
    try { m = JSON.parse(t); } catch (e) { send(rpcError(null, PARSE_ERROR, `Parse error: ${errorText(e)}`)); return; }
    if (m && typeof m === 'object' && (m as Rpc).method === 'notifications/cancelled') {
      const p = (m as Rpc).params;
      server.cancel(p && typeof p === 'object' ? (p as Args).requestId : undefined);
      return;
    }
    queue.push(m);
    wake();
  };
  void (async () => {
    const dec = new TextDecoder(), rd = Bun.stdin.stream().getReader();
    let buf = '';
    try {
      for (let r = await rd.read(); !r.done; r = await rd.read()) {
        buf += dec.decode(r.value, { stream: true });
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      line(buf + dec.decode());
    } catch (e) {
      log(`stdin: ${errorText(e)}`);
    }
    ended = true;
    wake();
  })();

  for (; ;) {
    if (!queue.length) {
      if (ended) break;
      await new Promise<void>(r => { wake = r; });
      wake = idle;
      continue;
    }
    const r = await server.dispatch(queue.shift());
    if (r !== undefined) send(r);
  }
  await new Promise<void>(r => process.stdout.write('', () => r()));
}
