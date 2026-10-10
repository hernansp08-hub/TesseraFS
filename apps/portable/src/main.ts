// Edición portable: servidor HTTP local (sólo 127.0.0.1, token aleatorio) + ventana de Microsoft Edge
// en modo app. Sin binarios propios: sólo bun.exe (firmado) y este script.
//   --no-window   sólo servidor; imprime URL y token (pruebas)
//   --debug       deja la consola visible y registra en ella
//   --threads=N   workers del recorrido (0 = un solo hilo)
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionKind, DupProgress, EngineChoice, ScanProgress, SortKey } from '../../../packages/protocol/src/index.ts';
import { TesseraEngine, defaultThreads, errorResponse, msg, runElevated, setWalkWorkerUrl, win32 } from '../../../packages/core-bun/src/index.ts';
import { embeddedUi } from './ui-macro.ts' with { type: 'macro' };

// en un objeto para que el minificador no copie la cadena en cada uso
const ASSETS: { ui: string } = { ui: embeddedUi() };

// sólo para desarrolladores (la interfaz no se construyó): en inglés, sin catálogo
const PLACEHOLDER = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>TesseraFS</title>
<style>body{font:14px system-ui;margin:24px;background:#111;color:#ddd}pre{background:#1b1b1b;padding:12px;border-radius:6px}</style></head>
<body><h1>TesseraFS</h1><p>The UI was not built before packaging (<code>bun run ui:build</code>). Drives:</p><pre id="o">…</pre>
<script>fetch('/api/volumes',{headers:{'X-Tessera-Token':window.__TESSERA__.token}}).then(r=>r.json()).then(j=>{o.textContent=JSON.stringify(j,null,2)},e=>{o.textContent=String(e)})</script>
</body></html>`;

// Mantiene abierta una conexión SSE mientras la página viva: si la ventana se cierra, el servidor lo nota.
const KEEPALIVE = `(function(t){function go(){fetch("/api/events?keepalive=1",{headers:{"X-Tessera-Token":t},cache:"no-store"}).then(function(r){if(!r.ok||!r.body)throw 0;var rd=r.body.getReader();(function pump(){rd.read().then(function(x){x.done?later():pump()},later)})()}).catch(later)}function later(){setTimeout(go,1500)}go()})`;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});
// errores de la API: estado 4xx/5xx con un EngineMessage como cuerpo JSON (ver docs/ARQUITECTURA.md)
const fail = errorResponse;
const num = (v: string | null, def: number) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? n : def; };
const SORTS: SortKey[] = ['size', 'alloc', 'name', 'files', 'mtime', 'delta'];
const ACTIONS: ActionKind[] = ['open', 'reveal', 'properties', 'trash', 'freeUp'];
const ENGINES: EngineChoice[] = ['auto', 'mft', 'walk'];

if (Bun.isMainThread) await main();

async function main() {
  const args = process.argv.slice(2);
  const has = (f: string) => args.includes(f);
  const noWindow = has('--no-window'), debug = has('--debug');
  const threadsArg = args.find(a => a.startsWith('--threads='));
  const threads = threadsArg ? Math.max(0, Number(threadsArg.slice(10)) | 0) : defaultThreads();
  const log = (...m: unknown[]) => { if (debug || noWindow) console.log('[tesserafs]', ...m); };

  // en el bundle, este mismo archivo hace de worker del recorrido
  if (import.meta.path.endsWith('.js')) setWalkWorkerUrl(import.meta.url);

  // consola: se oculta si es nuestra; con Windows Terminal se relanza sin consola
  if (!debug && !noWindow) {
    const kind = win32.consoleKind();
    if (kind === 'conhost') win32.hideConsole();
    else if (kind === 'other' && !has('--hidden-child')) {
      Bun.spawn([process.execPath, Bun.main, ...args, '--hidden-child'], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true, detached: true }).unref();
      process.exit(0);
    }
  }

  const engine = new TesseraEngine({ threads, log });
  const token = randomBytes(24).toString('base64url');
  const tokenBuf = Buffer.from(token);
  const okToken = (t: string | null) => { if (!t) return false; const b = Buffer.from(t); return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf); };

  // ---------- SSE ----------
  const enc = new TextEncoder();
  type Client = { send(b: Uint8Array): void };
  const clients = new Set<Client>();
  let hadClient = false, lastGone = Date.now();
  // el progreso del escaneo va sin nombre; el de los duplicados, con `event: dup`
  const broadcast = (p: ScanProgress | DupProgress, event?: 'dup') => {
    if (!clients.size) return;
    const b = enc.encode(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(p)}\n\n`);
    for (const c of clients) c.send(b);
  };
  const scanEvent = (p: ScanProgress) => broadcast(p);
  const dupEvent = (p: DupProgress) => broadcast(p, 'dup');
  setInterval(() => { const b = enc.encode(': ping\n\n'); for (const c of clients) c.send(b); }, 5000);

  function events(req: Request): Response {
    let client: Client;
    const drop = () => { if (clients.delete(client) && !clients.size) lastGone = Date.now(); };
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        client = { send(b) { try { ctrl.enqueue(b); } catch { drop(); } } };
        clients.add(client); hadClient = true;
        ctrl.enqueue(enc.encode('retry: 2000\n: connected\n\n'));
      },
      cancel() { drop(); },
    });
    req.signal.addEventListener('abort', drop);
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' } });
  }

  // ---------- página ----------
  const pageHtml = (() => {
    const html = ASSETS.ui || PLACEHOLDER;
    const boot = `<script>window.__TESSERA__={backend:"http",token:${JSON.stringify(token)}};${KEEPALIVE}(${JSON.stringify(token)})</script>`;
    const i = html.search(/<script[\s>]/i);
    const out = i >= 0 ? html.slice(0, i) + boot + html.slice(i) : html.replace(/<\/head>/i, m => boot + m);
    return out;
  })();
  function page(): Response {
    return new Response(pageHtml, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      },
    });
  }

  let edge: ReturnType<typeof Bun.spawn> | null = null;
  let shuttingDown = false;
  function shutdown(reason: string, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('cerrando:', reason);
    if (edge && edge.exitCode === null) killTree(edge.pid);
    try { server.stop(true); } catch { /* da igual */ }
    process.exit(code);
  }

  // ---------- API ----------
  async function api(req: Request, url: URL): Promise<Response> {
    const q = url.searchParams, m = req.method;
    switch (`${m} ${url.pathname}`) {
      case 'GET /api/volumes': return json(engine.volumes());
      case 'GET /api/events': server.timeout(req, 0); return events(req);
      case 'POST /api/scan': {
        server.timeout(req, 0);
        const body = await req.json().catch(() => null) as { path?: unknown; engine?: unknown } | null;
        if (!body || typeof body.path !== 'string') return fail(msg('error.invalidPath', { path: String(body?.path ?? '') }));
        const eng = (ENGINES as unknown[]).includes(body.engine) ? body.engine as EngineChoice : 'auto';
        let peak = process.memoryUsage().rss;
        const sampler = (debug || noWindow) ? setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50) : null;
        try {
          const r = await engine.scan({ path: body.path, engine: eng }, scanEvent);
          const mb = (b: number) => Math.round(b / 2 ** 20);
          log(`scan ${r.rootPath}: ${r.entries} entries in ${r.elapsedMs} ms (${r.engine}); RSS ${mb(process.memoryUsage().rss)} MB, peak ${mb(Math.max(peak, process.memoryUsage().rss))} MB`
            + (r.warnings.length ? `; warnings: ${r.warnings.map(w => w.code).join(', ')}` : ''));
          return json(r);
        } catch (e) {
          log(`scan ${body.path} failed:`, e instanceof Error ? e.message : e);
          return fail(e); // EngineError → 400/409; cualquier otro → 500 error.internal
        } finally { if (sampler) clearInterval(sampler); }
      }
      case 'POST /api/cancel': return json(engine.cancel()); // también un rescan
      case 'POST /api/rescan': {
        server.timeout(req, 0);
        const b = await req.json().catch(() => null) as { id?: unknown } | null;
        if (!b || typeof b.id !== 'number') return fail(msg('error.invalidNode', { id: String(b?.id ?? '') }), 400);
        try {
          // mismo canal SSE (sin nombre) que el escaneo
          const r = await engine.rescan(b.id, scanEvent);
          log(`rescan ${b.id}: ${r.entries} entries in ${r.elapsedMs} ms; ${r.before} -> ${r.row.size} bytes`
            + (r.warnings.length ? `; warnings: ${r.warnings.map(w => w.code).join(', ')}` : ''));
          return json(r);
        } catch (e) {
          log(`rescan ${b.id} failed:`, e instanceof Error ? e.message : e);
          return fail(e);
        }
      }
      // sólo el motor Rust (escritorio con administrador) lee el diario USN: aquí siempre 409 refresh.unavailable
      case 'POST /api/refresh': return json(await engine.refresh(scanEvent));
      case 'POST /api/duplicates': {
        server.timeout(req, 0); // lee archivos: puede tardar minutos
        const b = await req.json().catch(() => null) as { root?: unknown; minSize?: unknown; limit?: unknown } | null;
        if (!b || typeof b.root !== 'number') return fail(msg('error.invalidNode', { id: String(b?.root ?? '') }), 400);
        const n = (v: unknown) => typeof v === 'number' ? v : NaN; // NaN → valor por defecto del motor
        try {
          const r = await engine.duplicates({ root: b.root, minSize: n(b.minSize), limit: n(b.limit) }, dupEvent);
          const mb = (x: number) => Math.round(x / 2 ** 20);
          log(`duplicates ${b.root}: ${r.totalGroups} groups, ${mb(r.wasted)} MB wasted; ${r.candidates} candidates, ${mb(r.readBytes)} MB read in ${r.elapsedMs} ms`
            + (r.warnings.length ? `; warnings: ${r.warnings.map(w => w.code).join(', ')}` : ''));
          return json(r);
        } catch (e) {
          log(`duplicates ${b.root} failed:`, e instanceof Error ? e.message : e);
          return fail(e);
        }
      }
      case 'POST /api/duplicates/cancel': return json(engine.cancelDuplicates());
      // historial y comparación: guardar y comparar → error.scanBusy durante un escaneo (no durante los duplicados)
      case 'POST /api/history/save': {
        const e = engine.historySave();
        log(`history: saved ${e.id} (${e.nodes} nodes, ${e.fileBytes} bytes)`);
        return json(e);
      }
      case 'GET /api/history': return json(engine.historyList());
      case 'POST /api/history/delete': {
        const b = await req.json().catch(() => null) as { id?: unknown } | null;
        if (!b || typeof b.id !== 'string') return fail(msg('history.notFound', { id: String(b?.id ?? '') }));
        return json(engine.historyDelete(b.id));
      }
      case 'POST /api/history/clear': return json(engine.historyClear());
      case 'POST /api/compare': {
        const b = await req.json().catch(() => null) as { id?: unknown; limit?: unknown } | null;
        if (!b || typeof b.id !== 'string') return fail(msg('history.notFound', { id: String(b?.id ?? '') }));
        return json(engine.compare(b.id, typeof b.limit === 'number' ? b.limit : NaN)); // NaN → límite por defecto
      }
      case 'POST /api/compare/clear': engine.compareClear(); return json(null);
      case 'POST /api/export': {
        server.timeout(req, 0); // cuerpo de hasta 64 MiB
        const b = await req.json().catch(() => null) as { name?: unknown; data?: unknown; base64?: unknown } | null;
        if (!b || typeof b.name !== 'string') return fail(msg('export.invalidName', { name: String(b?.name ?? '') }));
        if (typeof b.data !== 'string') return fail(msg('export.failed', { error: 'data must be a string' }), 400);
        const r = engine.exportFile(b.name, b.data, b.base64 === true);
        log(`export: ${r.path}`);
        return json(r);
      }
      case 'POST /api/export/reveal': {
        const b = await req.json().catch(() => null) as { path?: unknown } | null;
        if (!b || typeof b.path !== 'string') return fail(msg('export.notFound', { path: String(b?.path ?? '') }));
        return json(engine.revealExport(b.path));
      }
      case 'GET /api/slice': {
        const bytes = engine.slice(num(q.get('root'), -1), num(q.get('min'), 0), num(q.get('max'), 20000));
        return new Response(bytes as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } });
      }
      case 'GET /api/children': {
        const sort = (SORTS as string[]).includes(q.get('sort') ?? '') ? q.get('sort') as SortKey : 'size';
        const d = q.get('desc');
        return json(engine.children({ id: num(q.get('id'), -1), offset: num(q.get('offset'), 0), limit: Math.min(num(q.get('limit'), 200), 10000), sort, desc: d === null ? true : d === 'true' || d === '1' }));
      }
      case 'GET /api/search':
        return json(engine.search({ query: q.get('q') ?? '', root: num(q.get('root'), engine.result?.rootId ?? 0), limit: Math.min(num(q.get('limit'), 500), 100000) }));
      case 'GET /api/ext': return json(engine.extStats(num(q.get('root'), engine.result?.rootId ?? 0)));
      case 'GET /api/path': return json(engine.nodePath(num(q.get('id'), -1)));
      case 'GET /api/node': return json(engine.nodeInfo(num(q.get('id'), -1)));
      case 'POST /api/action': {
        const b = await req.json().catch(() => null) as { kind?: unknown; id?: unknown } | null;
        if (!b || !(ACTIONS as unknown[]).includes(b.kind)) return fail(msg('action.unknown', { kind: String(b?.kind ?? '') }));
        if (typeof b.id !== 'number') return fail(msg('error.invalidNode', { id: String(b.id ?? '') }), 400);
        return json(engine.action(b.kind as ActionKind, b.id));
      }
      case 'GET /api/elevation': return json(engine.elevation());
      case 'POST /api/relaunch-elevated': {
        if (engine.elevated) return fail(msg('elevation.failed', { error: 'already running as administrator' }), 409);
        const params = [Bun.main, ...args.filter(a => a !== '--hidden-child')].map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
        const err = runElevated(process.execPath, params, process.cwd(), debug ? 1 : 0);
        // 1223 = el usuario canceló el UAC; el texto de FormatMessage ya llega en el idioma de Windows
        if (err) return fail(msg('elevation.failed', { error: win32.winErrorText(err) }), err === 1223 ? 409 : 500);
        // la instancia elevada abre su propia ventana (con otro perfil de Edge); esta se retira
        setTimeout(() => shutdown('relanzado como administrador'), 400);
        return json({ ok: true });
      }
      default: return fail(msg('error.internal', { error: `unknown API route: ${m} ${url.pathname}` }), 404);
    }
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.TESSERA_PORT) || 0,
    idleTimeout: 60,
    maxRequestBodySize: 64 * 2 ** 20, // exportación: un informe HTML con una imagen incrustada ocupa varios MB
    development: false,
    async fetch(req) {
      const url = new URL(req.url);
      // anti DNS-rebinding: sólo se atiende al propio origen
      const host = req.headers.get('host');
      if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return new Response('Host not allowed', { status: 403 });
      if (url.pathname.startsWith('/api/')) {
        if (!okToken(req.headers.get('x-tessera-token'))) return new Response('Missing or invalid token', { status: 401 });
        // EngineError → su estado (400/404/409); cualquier otro fallo → 500 error.internal
        try { return await api(req, url); } catch (e) { return fail(e); }
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return page();
      if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 });
      return new Response('Not found', { status: 404 });
    },
    error(e) { return fail(e); },
  });

  const appUrl = `http://127.0.0.1:${server.port}/`;
  log(`motor: ${threads} workers · ${engine.elevated ? 'administrador (MFT)' : 'sin administrador (recorrido)'}`);
  if (noWindow) {
    console.log(`URL: ${appUrl}`);
    console.log(`Token: ${token}`);
    console.log(`TESSERA ${JSON.stringify({ url: appUrl, token, pid: process.pid })}`);
    return;
  }

  // ---------- ventana ----------
  const startedAt = Date.now();
  const edgePath = findEdge();
  if (edgePath) {
    const profile = join(process.env.LOCALAPPDATA || tmpdir(), 'TesseraFS', engine.elevated ? 'edge-profile-admin' : 'edge-profile');
    mkdirSync(profile, { recursive: true });
    edge = Bun.spawn([
      edgePath, `--app=${appUrl}`, `--user-data-dir=${profile}`, '--window-size=1440,900',
      '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions',
      '--disable-component-update', '--edge-skip-compat-layer-relaunch', // sin este, Edge se relanza y perdemos su pid
    ], { stdio: ['ignore', 'ignore', 'ignore'] });
    log(`Edge ${edgePath} pid ${edge.pid}, perfil ${profile}`);
    const spawnedAt = Date.now(), edgePid = edge.pid;
    edge.exited.then(code => {
      // si Edge delegó en un proceso que ya usaba el perfil, sale enseguida: entonces manda la conexión SSE
      if (Date.now() - spawnedAt > 5000) shutdown(`Edge cerrado (código ${code})`);
      else log('Edge delegó la ventana en otro proceso; se vigila la conexión de la página');
    });
    // Edge puede seguir vivo en segundo plano tras cerrar la ventana: se vigila la propia ventana
    let seen = false;
    setInterval(() => {
      if (edge?.exitCode !== null) return;
      const vis = win32.hasVisibleWindow(edgePid);
      if (vis) seen = true;
      else if (seen) shutdown('ventana de Edge cerrada');
    }, 1000);
  } else {
    log('Edge no encontrado: se abre el navegador predeterminado');
    win32.shell32().ShellExecuteW(0n, win32.wstr('open'), win32.wstr(appUrl), null, null, 1);
  }

  // vigilancia: sin página conectada más de 10 s → fin
  setInterval(() => {
    if (clients.size) return;
    const now = Date.now();
    if (hadClient && now - lastGone > 10_000) shutdown('ventana cerrada');
    else if (!hadClient && now - startedAt > 120_000) shutdown('la ventana no llegó a conectarse', 1);
  }, 2000);
}

function findEdge(): string | null {
  const key = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe';
  const cands = [
    win32.regString('HKLM', key, null), win32.regString('HKCU', key, null),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe') : null,
  ];
  for (const c of cands) if (c && existsSync(c)) return c.replace(/^"|"$/g, '');
  return null;
}

/** Cierra el proceso de Edge que lanzamos (perfil propio) y sus hijos; no toca otras ventanas de Edge. */
function killTree(pid: number) {
  try { Bun.spawnSync(['taskkill.exe', '/PID', String(pid), '/T', '/F'], { stdio: ['ignore', 'ignore', 'ignore'] }); } catch { /* ya cerrado */ }
}
