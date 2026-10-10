// Comprobación cruzada Rust ↔ TypeScript:
//  1) decodifica con decodeSlice (packages/protocol) el slice que escribió tessera-cli;
//  2) vuelve a codificar con encodeSlice sobre el volcado JSON del mismo árbol y compara byte a byte;
//  3) repite cada búsqueda con compileQuery y compara total, bytes y tamaños de las primeras filas;
//     las de ATTR_QUERIES tienen que estar entre ellas.
// Uso: bun crates/tessera-cli/tests/crosscheck.ts arbol.json slice.bin busquedas.json minBytes maxNodes
// Los archivos salen de: tessera-cli scan <carpeta> --json-out arbol.json --slice-out slice.bin --min-bytes X
//   --max-nodes N --search-out busquedas.json --search "<consulta>" … (una --search por consulta)
import { readFileSync } from 'node:fs';
import { compileQuery, decodeSlice, encodeSlice, type EngineMessage, type SliceSource } from '../../../packages/protocol/src';

/** attr: en los dos motores: alias, mayúsculas, varios valores, negación, con type:dir y un valor no válido. */
const ATTR_QUERIES = [
  'attr:hidden', 'atrib:SISTEMA,oculto', 'attr:cloud', '-attr:cloud type:dir', 'type:dir attr:reparse',
  'attr:hardlink,compressed,sparse', '-atrib:oculto ext:txt', 'attr:cloud,raro',
];

const [jsonPath, slicePath, searchPath, minArg, maxArg] = process.argv.slice(2);
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
const missing = ATTR_QUERIES.filter(a => !searches.some(s => s.query === a));
check(!missing.length, `búsquedas de attr: incluidas${missing.length ? ` (faltan: ${missing.map(m => `--search "${m}"`).join(' ')})` : ''}`);
for (const { query, response: r } of searches) {
  const q = compileQuery(query);
  if (q.error || r.error) {
    // Mismo código y, salvo en expresiones regulares (el texto del error depende del motor), mismos parámetros
    const same = q.error?.code === r.error?.code
      && (q.error?.code === 'query.invalidRegex' || JSON.stringify(q.error?.params) === JSON.stringify(r.error?.params));
    check(same, `«${query}»: error en ambos (${q.error?.code} ${JSON.stringify(q.error?.params)} | ${r.error?.code} ${JSON.stringify(r.error?.params)})`);
    continue;
  }
  const hits = N.filter(n => n.id !== 0 && q.match({ name: n.name, ext: n.ext, isDir: n.isDir, size: n.size, alloc: n.alloc, mtime: n.mtime, flags: n.flags, path: () => pathOf(n.id) }));
  const bytes = hits.reduce((s, n) => s + n.size, 0);
  hits.sort((a, b) => b.size - a.size);
  const sizesOk = r.rows.every((row, i) => row.size === hits[i].size);
  const pathsOk = r.rows.every(row => row.path === pathOf(row.id));
  check(hits.length === r.total && bytes === r.totalBytes && sizesOk && pathsOk, `«${query}»: TS ${hits.length} / Rust ${r.total} resultados, ${bytes} / ${r.totalBytes} bytes`);
}
console.log(fails ? `\n${fails} comprobaciones fallidas` : '\nTodo coincide');
process.exit(fails ? 1 : 0);
