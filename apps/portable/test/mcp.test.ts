// Servidor MCP de la portable (src/mcp.ts) en proceso, como las pruebas de crates/tessera-cli/src/mcp.rs: el protocolo, cada
// herramienta sobre carpetas que crea la prueba (TESSERA_TEST_DIR o %TEMP%), el historial en la carpeta de la prueba
// (TESSERA_HISTORY_DIR), los avisos de progreso, la cancelación y lo propio del motor Bun (un escaneo por motor, sin diario USN).
import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MCP_TOOLS } from '../../../packages/protocol/src/mcp.ts';
import { encodeTessera } from '../../../packages/core-bun/src/index.ts';
import { INVALID_PARAMS, INVALID_REQUEST, MAX_SCANS, METHOD_NOT_FOUND, McpServer, contains, findNode, human, parseThreshold, text } from '../src/mcp.ts';

const base = path.resolve(process.env.TESSERA_TEST_DIR ?? os.tmpdir(), `tessera-mcp-${process.pid}`);
// Las reglas de limpieza tratan lo que está en AppData (donde está %TEMP%) como programas instalados: esa prueba va en target/
const cleanBase = path.resolve(import.meta.dir, '..', '..', '..', 'target', `mcp-tests-bun-${process.pid}`);
const savedEnv = process.env.TESSERA_HISTORY_DIR;
process.env.TESSERA_HISTORY_DIR = path.join(base, 'history');
const MiB = 1 << 20;

afterAll(() => {
  if (savedEnv === undefined) delete process.env.TESSERA_HISTORY_DIR; else process.env.TESSERA_HISTORY_DIR = savedEnv;
  for (const d of [base, cleanBase]) try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* el sistema limpiará %TEMP% */ }
});

const put = (p: string, data: Uint8Array | string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); };
/** Un archivo de `mib` MiB sin escribirlos. */
const big = (p: string, mib: number) => { put(p, ''); fs.truncateSync(p, mib * MiB); };

/** datos/ → grande.bin 3 MiB, copia/grande.bin 3 MiB (duplicado), sub/x.txt, notas.md */
function sample(tag: string): string {
  const d = path.join(base, tag, 'datos');
  const grande = new Uint8Array(3 * MiB).fill(7);
  put(path.join(d, 'grande.bin'), grande);
  put(path.join(d, 'copia', 'grande.bin'), grande);
  put(path.join(d, 'sub', 'x.txt'), 'hola');
  put(path.join(d, 'notas.md'), '# notas');
  return d;
}

type Sent = { method: string; params: { progressToken: unknown; progress: number; message: string } };
function server() {
  const sent: Sent[] = [];
  return { s: new McpServer({ send: m => sent.push(m as Sent), threads: 0 }), sent };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const rpc = async (s: McpServer, id: unknown, method: string, params: unknown = {}): Promise<Any> => s.dispatch({ jsonrpc: '2.0', id, method, params });
/** [texto JSON de la herramienta ya analizado, isError] */
async function call(s: McpServer, name: string, args: unknown = {}, meta?: unknown): Promise<[Any, boolean]> {
  const r = await rpc(s, 9, 'tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
  const t: string = r?.result?.content?.[0]?.text;
  if (typeof t !== 'string') throw new Error(JSON.stringify(r));
  let v: unknown = t;
  try { v = JSON.parse(t); } catch { /* texto de error */ }
  return [v, r.result.isError === true];
}

test('protocolo: initialize, ping, tools/list, errores y lotes', async () => {
  const { s } = server();
  let r = await rpc(s, 1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  expect(r.result.protocolVersion).toBe('2025-06-18');
  expect(r.result.serverInfo.name).toBe('tesserafs');
  expect(r.result.capabilities.tools).toEqual({ listChanged: false });
  expect(r.result.instructions).toContain('cleanup_candidates');
  // Una versión desconocida recibe la más reciente
  r = await rpc(s, 2, 'initialize', { protocolVersion: '1999-01-01' });
  expect(r.result.protocolVersion).toBe('2025-11-25');
  expect(await s.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
  expect((await rpc(s, 3, 'ping')).result).toEqual({});
  const tools = (await rpc(s, 4, 'tools/list')).result.tools as Any[];
  expect(tools.length).toBe(13);
  expect(tools).toEqual(MCP_TOOLS);
  expect(JSON.stringify(tools)).not.toMatch(/\$ref|\$defs/);
  for (const t of tools) {
    expect(t.inputSchema.type).toBe('object');
    expect(t.description.length).toBeGreaterThan(20);
    expect(t.annotations.readOnlyHint).toBe(t.name !== 'save_snapshot');
    expect(t.annotations.title).toBe(t.title);
  }
  expect(tools.find(t => t.name === 'largest').inputSchema.properties.path.description).toStartWith('Absolute path');
  expect((await rpc(s, 5, 'nada/raro')).error.code).toBe(METHOD_NOT_FOUND);
  expect((await rpc(s, 6, 'tools/call', { name: 'borrar_todo' })).error.code).toBe(INVALID_PARAMS);
  expect((await rpc(s, 6, 'tools/call', {})).error.message).toBe('Missing tool name');
  expect((await rpc(s, 6, 'tools/call', { name: 'largest', arguments: [1] })).error.code).toBe(INVALID_PARAMS);
  // Lote: sólo responden las peticiones
  const batch = await s.dispatch([{ jsonrpc: '2.0', id: 7, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]) as Any[];
  expect(batch.length).toBe(1);
  // Las respuestas del cliente no se contestan; una petición sin método, sí
  expect(await s.dispatch({ jsonrpc: '2.0', id: 8, result: {} })).toBeUndefined();
  expect((await s.dispatch({ jsonrpc: '2.0', id: 8 }) as Any).error.code).toBe(INVALID_REQUEST);
  // Sin escaneo y sin ruta: error de herramienta, no de protocolo
  const [v, err] = await call(s, 'largest');
  expect(err).toBe(true);
  expect(v).toStartWith('No scan in memory');
  const [vols, verr] = await call(s, 'list_volumes');
  expect(verr).toBe(false);
  expect(typeof vols.administrator).toBe('boolean');
  expect(vols.volumes.some((x: Any) => x.path === 'C:\\' && x.freeBytes > 0)).toBe(true);
});

test('herramientas sobre una carpeta: escanear, desde la memoria, listar, buscar, tipos, duplicados y rescan', async () => {
  const root = sample('tools');
  const { s, sent } = server();
  let [v, err] = await call(s, 'scan', { path: root }, { progressToken: 'p1' });
  expect(err).toBe(false);
  expect([v.files, v.folders, v.bytes]).toEqual([4, 2, 6 * MiB + 11]);
  expect(v.largestItems[0].type).toBe('folder');
  expect(v.engine).toBe('walk');
  expect(v.scan).toMatch(/^.+ scanned \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  // Progreso: el primero en el acto, con el token del cliente
  expect(sent[0].method).toBe('notifications/progress');
  expect(sent[0].params).toMatchObject({ progressToken: 'p1', progress: 1 });
  expect(sent[0].params.message).toStartWith(`Scanning ${root}`);
  // Desde la memoria
  [v] = await call(s, 'scan', { path: root });
  expect(v.note).toStartWith('From memory');
  [v] = await call(s, 'largest', { files: 2, folders: 5 });
  expect(v.largestFiles.length).toBe(2);
  expect(v.largestFiles[0].size).toBe('3.00 MiB');
  expect(v.largestFolders.length).toBe(2);
  // Una carpeta de dentro, con barras de cualquier tipo
  const sub = root.replaceAll('\\', '/') + '/sub';
  [v, err] = await call(s, 'list_folder', { path: sub });
  expect(err).toBe(false);
  expect(v.total).toBe(1);
  expect(v.items[0].path).toEndWith('x.txt');
  [v] = await call(s, 'list_folder', { sort: 'name', limit: '2' });
  expect([v.total, v.items.length]).toEqual([4, 2]);
  [v, err] = await call(s, 'list_folder', { sort: 'change' });
  expect(err && v.includes('compare_snapshot')).toBe(true);
  for (const sort of ['tamaño', 'toString']) {
    [v, err] = await call(s, 'list_folder', { sort });
    expect(err && v.startsWith('Unknown sort')).toBe(true);
  }
  [v] = await call(s, 'list_folder', { path: path.join(root, 'notas.md') });
  expect(v.note).toBe('This is a file, not a folder.');
  // Búsqueda
  [v] = await call(s, 'search', { query: 'ext:bin size:>1m' });
  expect([v.matches, v.totalBytes, v.shown]).toEqual([2, 6 * MiB, 2]);
  [v] = await call(s, 'search', { query: 'type:dir', path: sub });
  expect(v.matches).toBe(0);
  [v, err] = await call(s, 'search', { query: 'size:>abc' });
  expect(err && v.startsWith('Invalid query')).toBe(true);
  [v] = await call(s, 'file_types');
  expect([v.types[0].ext, v.typeCount, v.types[0].percent]).toEqual(['bin', 3, 100]);
  // Duplicados
  [v, err] = await call(s, 'find_duplicates', { minSize: '1MB' });
  expect(err).toBe(false);
  expect([v.groupCount, v.reclaimableBytes, v.groups[0].files.length, v.groups[0].copies]).toEqual([1, 3 * MiB, 2, 2]);
  expect(v.note).toContain('SHA-256');
  [v, err] = await call(s, 'find_duplicates', { minSize: '10%' });
  expect(err && v.includes('not a percentage')).toBe(true);
  [, err] = await call(s, 'find_duplicates', { minSize: -1 });
  expect(err).toBe(true);
  [v] = await call(s, 'broken_links');
  expect(v.count).toBe(0);
  // Argumentos mal formados
  [v, err] = await call(s, 'largest', { files: -1 });
  expect(err && v.includes('non-negative integer')).toBe(true);
  [v, err] = await call(s, 'scan', { path: root, refresh: 'sí' });
  expect(err && v.includes('true or false')).toBe(true);
  // Lo que no está en el escaneo
  [v, err] = await call(s, 'list_folder', { path: path.join(root, 'no-existe') });
  expect(err && v.includes('refresh: true')).toBe(true);
  // Un archivo creado después: refresh vuelve a escanear su carpeta dentro del escaneo
  put(path.join(root, 'sub', 'nuevo.txt'), new Uint8Array(1000));
  [v, err] = await call(s, 'scan', { path: sub, refresh: true });
  expect(err).toBe(false);
  expect(v.note).toStartWith('Rescanned inside the scan of');
  [v] = await call(s, 'list_folder', { path: sub });
  expect(v.total).toBe(2);
  expect(s.scans.length).toBe(1); // sigue siendo el mismo escaneo
  // Un archivo suelto en la raíz, o la raíz misma: sin diario USN, se vuelve a escanear entera (y en el mismo motor)
  const engine = s.scans[0].engine;
  put(path.join(root, 'otro.bin'), new Uint8Array(5));
  [v, err] = await call(s, 'scan', { path: path.join(root, 'notas.md'), refresh: true });
  expect(err).toBe(false);
  expect(v.note).toStartWith('Scanned again in full');
  expect([v.path, v.files]).toEqual([root, 6]);
  expect(s.scans.length).toBe(1);
  expect(s.scans[0].engine).toBe(engine);
});

test('historial: guardar, comparar, ordenar por cambio y evolución', async () => {
  const root = sample('history');
  const { s } = server();
  await call(s, 'scan', { path: root });
  let [v, err] = await call(s, 'compare_snapshot');
  expect(err && v.startsWith('There is no snapshot')).toBe(true);
  [v, err] = await call(s, 'save_snapshot');
  expect(err).toBe(false);
  expect(v.folder).toBe(path.join(base, 'history'));
  expect(v.note).toContain('20 most recent');
  [v] = await call(s, 'history', { path: root });
  expect(v.count).toBe(1);
  expect(v.snapshots[0]).toMatchObject({ path: root, bytes: 6 * MiB + 11, files: 4, folders: 2 });
  [v] = await call(s, 'history', { path: path.join(base, 'otra') });
  expect(v.count).toBe(0);
  // Otro escaneo (más tarde) con un archivo nuevo
  put(path.join(root, 'sub', 'nuevo.bin'), new Uint8Array(2 * MiB).fill(2));
  await Bun.sleep(1100);
  [v, err] = await call(s, 'scan', { path: root, refresh: true });
  expect(err).toBe(false);
  [v, err] = await call(s, 'compare_snapshot');
  expect(err).toBe(false);
  expect(v.change).toBe('+2.00 MiB');
  expect([v.before.files, v.after.files]).toEqual([4, 5]);
  // Lo que explica el cambio: el archivo nuevo, no su carpeta
  expect(v.grew[0].path).toEndWith('nuevo.bin');
  expect(v.grew[0].new).toBe(true);
  [v] = await call(s, 'list_folder', { sort: 'change', limit: 1 });
  expect(v.items[0].change).toBe('+2.00 MiB');
  expect(v.items[0].before).toBe('4 B');
  [v, err] = await call(s, 'size_trend', { path: path.join(root, 'sub') });
  expect(err).toBe(false);
  expect(v.points.length).toBe(2);
  expect(v.points[1]).toMatchObject({ snapshot: 'current scan', bytes: 2 * MiB + 4 });
  [v, err] = await call(s, 'compare_snapshot', { snapshotId: 'no-existe' });
  expect(err && v.includes('[history.notFound]')).toBe(true);
});

test('comparar: otro motor (metadatos de NTFS) y carpetas que no se pudieron leer no son cambios, como en tessera-cli', async () => {
  const root = sample('artifacts');
  big(path.join(root, '$MFT'), 2);
  const { s } = server();
  const cur = () => s.scans.find(l => l.engine.store?.rootPath === root)!.engine;
  // A: recorrido; B, más reciente: como si fuera de la MFT
  await call(s, 'scan', { path: root });
  const [a] = await call(s, 'save_snapshot');
  await Bun.sleep(1100);
  await call(s, 'scan', { path: root, refresh: true });
  cur().result!.engine = 'mft';
  const [b] = await call(s, 'save_snapshot');
  let [v, err] = await call(s, 'history', { path: root });
  expect(v.snapshots.map((x: Any) => x.engine)).toEqual(['mft', 'walk']);
  // Ahora: sin $MFT y con «copia» vacía
  fs.rmSync(path.join(root, '$MFT'));
  fs.rmSync(path.join(root, 'copia', 'grande.bin'));
  await Bun.sleep(1100);
  await call(s, 'scan', { path: root, refresh: true });
  const gone = (v: Any, name: string) => v.removed.find((r: Any) => r.path.endsWith(name));
  // Por defecto, el del mismo motor (A, aunque B sea más reciente): todo es un cambio real
  [v, err] = await call(s, 'compare_snapshot');
  expect(err).toBe(false);
  expect(v.snapshot).toMatchObject({ id: a.saved.id, engine: 'walk' });
  expect(v.warnings).toBeUndefined();
  expect(gone(v, '$MFT').likelyArtifact).toBeUndefined();
  // Con B (otro motor): $MFT de la raíz es un metadato de NTFS y se avisa
  [v] = await call(s, 'compare_snapshot', { snapshotId: b.saved.id });
  expect(gone(v, '$MFT').likelyArtifact).toStartWith('NTFS metadata');
  expect(v.warnings[0]).toStartWith('This scan used the walk engine and the snapshot the mft engine');
  expect(gone(v, 'grande.bin').likelyArtifact).toBeUndefined();
  // Con accesos denegados, una carpeta vacía ahora probablemente no se pudo leer
  cur().result!.warnings.push({ code: 'scan.accessDenied', params: { count: 1 }, message: '1 folder could not be read (access denied)' });
  [v] = await call(s, 'compare_snapshot');
  expect(gone(v, 'grande.bin').likelyArtifact).toContain('access denied');
  expect(v.shrank[0].path).toEndWith('copia');
  expect(typeof v.shrank[0].likelyArtifact).toBe('string');
  expect(gone(v, '$MFT').likelyArtifact).toBeUndefined();
  expect(v.warnings[0]).toStartWith('This scan could not read 1 folder (access denied)');
});

test('cleanup_candidates: las reglas de la app, en el mismo orden que tessera-cli mcp', async () => {
  const p = path.join(cleanBase, 'proj');
  const tag = 'Signature: 8a477f597d28d172789f06886806bc55\n';
  big(path.join(p, 'web/node_modules/pkg/index.js'), 21);
  big(path.join(p, 'web/node_modules/x/node_modules/big.bin'), 21); // anidada: ya cuenta en la de fuera
  big(path.join(p, 'api/.venv/lib.bin'), 21);
  put(path.join(p, 'small/node_modules/a.js'), 'x'); // menos del mínimo
  big(path.join(p, 'lamina/target/debug/app.rlib'), 51);
  put(path.join(p, 'lamina/target/CACHEDIR.TAG'), tag);
  big(path.join(p, 'otro/target/out.bin'), 51); // sin CACHEDIR.TAG ni .rustc_info.json: no es de Cargo
  big(path.join(p, 'restic/e4b1/pack.bin'), 60);
  put(path.join(p, 'restic/e4b1/CACHEDIR.TAG'), tag);
  fs.mkdirSync(path.join(p, 'vacia'), { recursive: true });
  put(path.join(p, 'notas/vacio.txt'), '');

  const { s, sent } = server();
  let [v, err] = await call(s, 'cleanup_candidates', { path: p }, { progressToken: 7 });
  expect(err).toBe(false);
  const c = v.candidates as Any[];
  // Lo seguro primero y, dentro, lo más grande. La caché declarada de target/ ya tiene tarjeta: no se repite
  expect(c.map(x => x.rule)).toEqual(['cacheTag', 'rustTarget', 'nodeModules', 'venv', 'emptyFolders', 'emptyFiles']);
  const at = (i: number) => c[i].path.replaceAll('\\', '/');
  expect(at(0)).toEndWith('proj/restic/e4b1');
  expect(at(1)).toEndWith('proj/lamina/target');
  expect(at(2)).toEndWith('proj/web/node_modules');
  expect(c[0].title).toBe('Declared cache: restic › e4b1');
  expect([c[1].title, c[1].command]).toEqual(['Rust build output', 'cargo clean']);
  const nm = c[2];
  expect([nm.risk, nm.riskLabel, nm.type, nm.title, nm.command]).toEqual(['ok', 'Safe', 'folder', 'Node dependencies', 'bun install']);
  expect(nm.why).toBe('They’re reinstalled from the project’s package.json and lockfile.');
  expect(nm.bytes).toBe(42 * MiB);
  expect(c[3].command).toBe('uv sync');
  // Tarjetas de resumen: cuántos hay, algunos y con qué verlos todos
  const empty = c[4];
  expect([empty.risk, empty.items]).toEqual(['warn', 1]);
  expect(empty.examples[0]).toEndWith('vacia');
  expect(empty.listAll.tool).toBe('search');
  expect(empty.listAll.arguments.query).toStartWith('type:dir files:=0 ');
  expect(c[5].examples[0]).toEndWith('vacio.txt');
  expect(JSON.stringify(v)).not.toMatch(/otro|small/);
  expect([v.byRisk.ok.candidates, v.byRisk.warn.candidates]).toEqual([4, 2]);
  expect(v.byRisk.bad.label).toBe('Don’t delete by hand');
  expect(v.rules).toBe('windows');
  expect(v.note).toContain('Recycle Bin');
  // El primer aviso fue el del escaneo; con el escaneo ya en memoria, el de la primera regla
  expect(sent[0].params.message).toStartWith('Scanning ');
  [v] = await call(s, 'cleanup_candidates', { risk: 'warn' }, { progressToken: 8 });
  expect(sent.find(m => m.params.progressToken === 8)!.params.message).toStartWith('Cleanup rules 1/');

  // Filtro por riesgo y límite; byRisk sigue contando todo
  expect(v.matches).toBe(2);
  expect(v.candidates.every((x: Any) => x.risk === 'warn')).toBe(true);
  expect(v.byRisk.ok.candidates).toBe(4);
  [v] = await call(s, 'cleanup_candidates', { risk: 'OK, bad', limit: 1 });
  expect([v.matches, v.candidates.length]).toEqual([4, 1]);
  [v] = await call(s, 'cleanup_candidates', { risk: ['warn'] });
  expect(v.matches).toBe(2);
  [v, err] = await call(s, 'cleanup_candidates', { risk: 'peligroso' });
  expect(err && v.includes('Unknown risk')).toBe(true);
  [, err] = await call(s, 'cleanup_candidates', { risk: 3 });
  expect(err).toBe(true);

  // Dentro de una carpeta: sólo lo que hay dentro, nunca la propia carpeta
  [v] = await call(s, 'cleanup_candidates', { path: path.join(p, 'web') });
  expect(v.candidates.map((x: Any) => x.rule)).toEqual(['nodeModules']);
  [v] = await call(s, 'cleanup_candidates', { path: path.join(p, 'web', 'node_modules') });
  expect(v.matches).toBe(0);
  // Sólo lee
  expect(fs.existsSync(path.join(p, 'web/node_modules/pkg/index.js')) && fs.existsSync(path.join(p, 'vacia'))).toBe(true);
});

test('varios escaneos en memoria: uno por motor, el más concreto y el más reciente', async () => {
  const ra = sample('cache-a'), rb = sample('cache-b');
  const { s } = server();
  await call(s, 'scan', { path: path.join(ra, 'sub') });
  await call(s, 'scan', { path: rb });
  // El escaneo de la carpeta de fuera sustituye al de dentro
  await call(s, 'scan', { path: ra });
  expect(s.scans.length).toBe(2);
  expect(s.scans[0].engine).not.toBe(s.scans[1].engine);
  // Sin ruta: el usado más recientemente
  let [v] = await call(s, 'largest', { files: 1, folders: 0 });
  expect(v.path).toBe(ra);
  await call(s, 'largest', { path: rb });
  [v] = await call(s, 'largest');
  expect(v.path).toBe(rb);
  // Dentro de un escaneo, sin volver a escanear (con / y otras mayúsculas)
  [v] = await call(s, 'list_folder', { path: ra.toUpperCase().replaceAll('\\', '/') + '/SUB' });
  expect(v.folder.path).toBe(path.join(ra, 'sub'));
  expect(s.scans.length).toBe(2);
  let err: boolean;
  [v, err] = await call(s, 'scan');
  expect(err && v.includes('required')).toBe(true);
  [v, err] = await call(s, 'scan', { path: rb, engine: 'rápido' });
  expect(err && v.includes('Unknown engine')).toBe(true);
  [v, err] = await call(s, 'scan', { path: 'carpeta/relativa' });
  expect(err && v.includes('[error.invalidPath]')).toBe(true);
  [v, err] = await call(s, 'largest', { path: 'relativa' });
  expect([v, err]).toEqual(['Invalid path: relativa', true]);
  // Como mucho MAX_SCANS: se olvida el usado hace más tiempo (rb; ra se usó después)
  const more = ['m1', 'm2', 'm3'].map(sample);
  for (const r of more) await call(s, 'scan', { path: r });
  expect(s.scans.length).toBe(MAX_SCANS);
  expect(s.scans.map(l => l.engine.store!.rootPath)).toEqual([ra, ...more]);
  // Y como mucho maxNodes elementos entre todos (cada muestra tiene 7): el último se queda aunque solo pase de ahí
  const t = new McpServer({ send: () => { }, threads: 0, maxNodes: 10 });
  await call(t, 'scan', { path: ra });
  await call(t, 'scan', { path: rb });
  expect(t.scans.map(l => l.engine.store!.rootPath)).toEqual([rb]);
  const u = new McpServer({ send: () => { }, threads: 0, maxNodes: 3 });
  [v] = await call(u, 'scan', { path: ra });
  expect([u.scans.length, v.files]).toEqual([1, 4]);
});

test('cancelación: notifications/cancelled para un escaneo y una búsqueda de duplicados, y el servidor sigue', async () => {
  const root = sample('cancel');
  for (let i = 0; i < 200; i++) put(path.join(root, 'muchas', `d${i}`, 'f.bin'), new Uint8Array(10 + i));
  const { s } = server();
  // Un escaneo nuevo: sin respuesta y sin escaneo en memoria
  let p = s.dispatch({ jsonrpc: '2.0', id: 'scan-1', method: 'tools/call', params: { name: 'scan', arguments: { path: root } } });
  s.cancel('other');
  s.cancel('scan-1');
  expect(await p).toBeUndefined();
  expect(s.scans.length).toBe(0);
  expect((await rpc(s, 2, 'ping')).result).toEqual({});
  // Duplicados sobre el escaneo en memoria: se cancela y el escaneo sigue
  await call(s, 'scan', { path: root });
  p = s.dispatch({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_duplicates', arguments: { minSize: 1 } } });
  s.cancel(3);
  expect(await p).toBeUndefined();
  const [v, err] = await call(s, 'find_duplicates', { minSize: 1 });
  expect(err).toBe(false);
  expect(v.groupCount).toBeGreaterThan(0);
  // Una cancelación que llega tarde no afecta a la siguiente petición
  s.cancel(3);
  expect((await rpc(s, 4, 'tools/call', { name: 'largest' })).result.isError).toBeUndefined();
  // Volver a escanear la raíz suelta antes el árbol anterior: cancelado, ese escaneo ya no está en memoria
  p = s.dispatch({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'scan', arguments: { path: root, refresh: true } } });
  s.cancel(5);
  expect(await p).toBeUndefined();
  expect(s.scans.length).toBe(0);
  expect((await call(s, 'largest'))[0]).toStartWith('No scan in memory');
});

test('escaneo guardado (.tessera): se abre sin conexión, con sus rutas y sin tocar el disco', async () => {
  const root = sample('saved');
  const { s } = server();
  await call(s, 'scan', { path: root });
  const e = s.scans[0].engine;
  const file = path.join(base, 'saved', 'datos.tessera');
  fs.writeFileSync(file, encodeTessera(e.store!, { app: '0.0.1', host: 'OTRO-PC', scannedAt: 1_760_000_000, engine: 'walk', volume: null }));
  const t = server().s;
  let [v, err] = await call(t, 'scan', { path: `"${file}"` });
  expect(err).toBe(false);
  expect(v.scan).toBe(`${root} scanned 2025-10-09T08:53:20Z (saved scan from OTRO-PC: read-only, no disk access)`);
  expect(v.files).toBe(4);
  // Sus rutas se buscan tal cual (no se escanea el disco)
  [v, err] = await call(t, 'list_folder', { path: path.join(root, 'sub') });
  expect(err).toBe(false);
  expect(v.total).toBe(1);
  expect(t.scans.length).toBe(1);
  [v, err] = await call(t, 'find_duplicates');
  expect(err && v.includes('[scan.offline]')).toBe(true);
  [v, err] = await call(t, 'compare_snapshot');
  expect(err && v.includes('[scan.offline]')).toBe(true);
  [v, err] = await call(t, 'cleanup_candidates');
  expect(err).toBe(false);
  // Volver a abrirlo no lo lee otra vez
  [v] = await call(t, 'scan', { path: file });
  expect(t.scans.length).toBe(1);
  fs.writeFileSync(path.join(base, 'saved', 'roto.tessera'), 'no es un escaneo');
  [v, err] = await call(t, 'scan', { path: path.join(base, 'saved', 'roto.tessera') });
  expect(err && v.includes('[scan.openFailed]')).toBe(true);
});

test('rutas, tamaños, umbrales y textos como tessera-cli', () => {
  expect(contains('C:\\', 'c:\\Users') && contains('C:\\Users', 'c:/users/ana') && contains('C:\\Users', 'C:\\USERS')).toBe(true);
  expect(contains('C:\\Users', 'C:\\Users2') || contains('C:\\Users', 'D:\\Users')).toBe(false);
  expect(contains('/', '/home') && contains('/srv', '/srv/a')).toBe(true);
  expect(contains('/srv', '/srvx') || contains('/srv', '/SRV')).toBe(false);
  expect([human(0), human(1023), human(1024), human(3 * MiB), human(1.5 * 2 ** 40)]).toEqual(['0 B', '1023 B', '1.00 KiB', '3.00 MiB', '1.50 TiB']);
  expect(parseThreshold('10MB')).toEqual({ bytes: 10 * MiB });
  expect(parseThreshold('1,5 GiB')).toEqual({ bytes: 1.5 * 2 ** 30 });
  expect(parseThreshold('4096')).toEqual({ bytes: 4096 });
  expect(parseThreshold('12.5 %')).toEqual({ percent: 12.5 });
  expect(() => parseThreshold('10 megas')).toThrow('Umbral no válido');
  expect(() => parseThreshold('120%')).toThrow('mayor que 100');
  expect(text('clean.packageCaches.title', { name: 'npm' }, 'windows')).toBe('npm package cache');
  expect(text('clean.brokenLinks.why', undefined, 'windows')).toContain('Recycle Bin');
  expect(text('clean.brokenLinks.why', undefined, 'linux')).toContain('to the Trash');
  expect(text('clean.no.existe', undefined, 'windows')).toBeUndefined();
  expect(findNode).toBeFunction();
});
