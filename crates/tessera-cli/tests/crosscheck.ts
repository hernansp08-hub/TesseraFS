// Comprobación cruzada Rust ↔ TypeScript:
//  1) decodifica con decodeSlice (packages/protocol) el slice que escribió tessera-cli;
//  2) vuelve a codificar con encodeSlice sobre el volcado JSON del mismo árbol y compara byte a byte;
//  3) repite cada búsqueda con compileQuery y compara total, bytes y tamaños de las primeras filas;
//     las de ATTR_QUERIES y FILES_QUERIES tienen que estar entre ellas;
//  4) con escaneo.tessera (el que escribió `--save`): lo abre el lector del motor Bun (decodeTessera) y compara
//     cada nodo con el volcado, el slice byte a byte con el de Rust y las búsquedas; con tessera-cli, además, la
//     vuelta: el motor Bun vuelve a escribir el .tessera, tessera-cli lo abre y su slice tiene que ser el mismo.
// Uso: bun crates/tessera-cli/tests/crosscheck.ts arbol.json slice.bin busquedas.json minBytes maxNodes [escaneo.tessera [tessera-cli]]
// Los archivos salen de: tessera-cli scan <carpeta> --json-out arbol.json --slice-out slice.bin --min-bytes X
//   --max-nodes N --search-out busquedas.json --save escaneo.tessera --search "<consulta>" … (una --search por consulta)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileQuery, decodeSlice, encodeSlice, type EngineMessage, type SliceSource } from '../../../packages/protocol/src';
import { decodeTessera, encodeTessera } from '../../../packages/core-bun/src/saved.ts';

/** attr: en los dos motores: alias, mayúsculas, varios valores, negación, con type:dir y un valor no válido. */
const ATTR_QUERIES = [
  'attr:hidden', 'atrib:SISTEMA,oculto', 'attr:cloud', '-attr:cloud type:dir', 'type:dir attr:reparse',
  'attr:hardlink,compressed,sparse', '-atrib:oculto ext:txt', 'attr:cloud,raro',
];
/** files: en los dos motores: operadores, rango con k, alias, negación, sin type:dir (sólo archivos) y un valor no válido. */
const FILES_QUERIES = [
  'type:dir files:=0', 'type:dir archivos:>100', 'type:dir files:10..1k', '-files:0 type:dir', 'type:dir files:<=2 size:>1k',
  'files:=0', 'files:zz',
];

const [jsonPath, slicePath, searchPath, minArg, maxArg, tesseraPath, cliPath] = process.argv.slice(2);
const dump = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
  rootPath: string;
  nodes: { id: number; name: string; ext: string; isDir: boolean; size: number; alloc: number; files: number; dirs: number; mtime: number; flags: number; parent: number; kids: number[] }[];
};
const N = dump.nodes;
let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK  ' : 'FALLO'} ${msg}`); if (!ok) fails++; };

// 1) Decodificar el slice de Rust
const rustBytes = new Uint8Array(readFileSync(slicePath));
const { nodes: dec, minBytes } = decodeSlice(rustBytes);
check(dec.length > 0 && dec[0].id === 0, `decodeSlice: ${dec.length} nodos, raíz «${dec[0]?.name}», minBytes ${minBytes}`);
check(dec.every(n => N[n.id].size === n.size && N[n.id].name === n.name && N[n.id].isDir === n.isDir), 'cada nodo del slice coincide con el árbol (id, nombre, tamaño, tipo)');
check(dec.every(n => !n.parent || N[n.id].parent === n.parent.id), 'padres coherentes');

// 2) Re-codificar en TS y comparar byte a byte
const src: SliceSource = {
  isDir: i => N[i].isDir, name: i => N[i].name, ext: i => N[i].ext, size: i => N[i].size, alloc: i => N[i].alloc,
  files: i => N[i].files, dirs: i => N[i].dirs, mtime: i => N[i].mtime, flags: i => N[i].flags, children: i => N[i].kids,
};
const tsBytes = encodeSlice(src, 0, Number(minArg), Number(maxArg));
let firstDiff = -1;
for (let i = 0; i < Math.max(tsBytes.length, rustBytes.length); i++) if (tsBytes[i] !== rustBytes[i]) { firstDiff = i; break; }
check(firstDiff < 0 && tsBytes.length === rustBytes.length, `encodeSlice TS == Rust (${tsBytes.length} / ${rustBytes.length} bytes${firstDiff >= 0 ? `, primera diferencia en ${firstDiff}` : ''})`);

// 3) Búsquedas
const pathOf = (id: number): string => {
  const parts: string[] = [];
  for (let a = id; a > 0; a = N[a].parent) parts.push(N[a].name);
  let p = dump.rootPath;
  for (const s of parts.reverse()) p += (p.endsWith('\\') ? '' : '\\') + s;
  return p;
};
const searches = JSON.parse(readFileSync(searchPath, 'utf8')) as { query: string; response: { total: number; totalBytes: number; rows: { id: number; size: number; path: string }[]; error?: EngineMessage } }[];
const missing = [...ATTR_QUERIES, ...FILES_QUERIES].filter(a => !searches.some(s => s.query === a));
check(!missing.length, `búsquedas de attr: y files: incluidas${missing.length ? ` (faltan: ${missing.map(m => `--search "${m}"`).join(' ')})` : ''}`);
for (const { query, response: r } of searches) {
  const q = compileQuery(query);
  if (q.error || r.error) {
    // Mismo código y, salvo en expresiones regulares (el texto del error depende del motor), mismos parámetros
    const same = q.error?.code === r.error?.code
      && (q.error?.code === 'query.invalidRegex' || JSON.stringify(q.error?.params) === JSON.stringify(r.error?.params));
    check(same, `«${query}»: error en ambos (${q.error?.code} ${JSON.stringify(q.error?.params)} | ${r.error?.code} ${JSON.stringify(r.error?.params)})`);
    continue;
  }
  const hits = N.filter(n => n.id !== 0 && q.match({ name: n.name, ext: n.ext, isDir: n.isDir, size: n.size, alloc: n.alloc, mtime: n.mtime, flags: n.flags, files: n.files, path: () => pathOf(n.id) }));
  const bytes = hits.reduce((s, n) => s + n.size, 0);
  hits.sort((a, b) => b.size - a.size);
  const sizesOk = r.rows.every((row, i) => row.size === hits[i]?.size);
  const pathsOk = r.rows.every(row => row.path === pathOf(row.id));
  check(hits.length === r.total && bytes === r.totalBytes && sizesOk && pathsOk, `«${query}»: TS ${hits.length} / Rust ${r.total} resultados, ${bytes} / ${r.totalBytes} bytes`);
}

// 4) Escaneo guardado (.tessera) que escribió Rust, abierto por el motor Bun
if (tesseraPath) {
  const t0 = performance.now();
  const f = decodeTessera(new Uint8Array(readFileSync(tesseraPath)));
  const st = f.store;
  check(f.path === dump.rootPath && st.n === N.length && f.scannedAt > 0 && (f.engine === 'walk' || f.engine === 'mft'),
    `.tessera abierto por Bun: ${st.n} nodos (${N.length} en Rust), raíz «${f.path}», ${f.engine}, equipo ${f.host ?? '?'}, TesseraFS ${f.app ?? '?'} (${Math.round(performance.now() - t0)} ms)`);
  // Cada nodo, por ruta: tipo, tamaños, totales, fecha, flags y extensión
  const byPath = new Map<string, number>();
  for (const n of N) byPath.set(pathOf(n.id), n.id);
  let bad = 0, firstBad = '';
  for (let id = 0; id < st.n; id++) {
    const p = st.path(id), d = N[byPath.get(p) ?? -1];
    const r = st.row(id);
    const same = d && r.isDir === d.isDir && r.size === d.size && r.alloc === d.alloc && r.files === d.files && r.dirs === d.dirs
      && r.mtime === d.mtime && r.flags === (d.flags & 0xFF) && r.ext === d.ext && st.children(id).length === d.kids.length;
    if (!same) { bad++; firstBad ||= `${p}: Bun ${JSON.stringify(r)} | Rust ${JSON.stringify(d)}`; }
  }
  check(!bad, `cada nodo del .tessera coincide con el árbol de Rust (ruta, tipo, tamaños, totales, fecha, flags, extensión)${bad ? ` — ${bad} distintos, p. ej. ${firstBad}` : ''}`);
  const bunSlice = encodeSlice(st, 0, Number(minArg), Number(maxArg));
  const diff = (a: Uint8Array, b: Uint8Array) => { for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return i; return -1; };
  // Cada motor numera los nodos a su manera (Rust por niveles, Bun en el orden del archivo): el slice tiene que ser
  // el mismo byte a byte salvo el id de cada registro (los padres van por posición en el slice, no por id)
  const withoutIds = (s: Uint8Array) => {
    const c = s.slice(), dv = new DataView(c.buffer);
    const count = dv.getUint32(8, true), recStart = 32 + Math.ceil(dv.getUint32(20, true) / 8) * 8;
    for (let i = 0; i < count; i++) dv.setUint32(recStart + i * 64, 0, true);
    return c;
  };
  const d1 = diff(withoutIds(bunSlice), withoutIds(rustBytes));
  check(d1 < 0, `slice del .tessera en Bun == slice de Rust salvo los ids (${bunSlice.length} / ${rustBytes.length} bytes${d1 >= 0 ? `, primera diferencia en ${d1}` : ''})`);
  for (const { query, response: r } of searches) {
    if (r.error) continue;
    const b = st.search(query, 0, r.rows.length || 1);
    check(b.total === r.total && b.totalBytes === r.totalBytes, `«${query}» sobre el .tessera en Bun: ${b.total} / Rust ${r.total} resultados, ${b.totalBytes} / ${r.totalBytes} bytes`);
  }
  // Vuelta: lo que escribe el motor Bun lo abre tessera-cli con el mismo slice
  if (cliPath) {
    const dir = mkdtempSync(join(tmpdir(), 'tessera-crosscheck-'));
    try {
      const back = join(dir, 'bun.tessera'), out = join(dir, 'slice.bin');
      writeFileSync(back, encodeTessera(st, { app: f.app, host: f.host, scannedAt: f.scannedAt, engine: f.engine, volume: f.volume }));
      const p = Bun.spawnSync([cliPath, 'scan', back, '--top', '0', '--slice-out', out, '--min-bytes', String(minArg), '--max-nodes', String(maxArg)]);
      const text = p.stdout.toString();
      check(p.exitCode === 0 && /Origen:\s+\.tessera escaneado/.test(text), `tessera-cli abre el .tessera que escribió Bun (código ${p.exitCode}${p.exitCode ? `: ${p.stderr.toString().trim()}` : ''})`);
      if (p.exitCode === 0) {
        const again = new Uint8Array(readFileSync(out));
        const d2 = diff(again, rustBytes);
        check(d2 < 0, `slice de tessera-cli sobre el .tessera de Bun == slice original (${again.length} / ${rustBytes.length} bytes${d2 >= 0 ? `, primera diferencia en ${d2}` : ''})`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
console.log(fails ? `\n${fails} comprobaciones fallidas` : '\nTodo coincide');
process.exit(fails ? 1 : 0);
