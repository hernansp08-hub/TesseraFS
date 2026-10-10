// Empaqueta la versión actual en zips listos para publicar y, con --publish, crea la release en GitHub.
//   dist/release/vX.Y.Z/TesseraFS-X.Y.Z-escritorio-win-x64.zip   tesserafs-desktop.exe + LEEME + licencias
//   dist/release/vX.Y.Z/TesseraFS-X.Y.Z-portable-win-x64.zip     carpeta portable (bun.exe firmado + tesserafs.js) + licencias
//   dist/release/vX.Y.Z/SHA256SUMS.txt                            sumas de comprobación
//   dist/release/vX.Y.Z/NOTAS.md                                  notas de la release (del CHANGELOG)
// Uso: bun run package [--skip-build] [--publish]
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const ROOT = join(import.meta.dir, '..');
const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build'), publish = args.includes('--publish');
const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const tag = `v${version}`;
const OUT = join(ROOT, 'dist', 'release', tag);
const TAR = 'C:\\Windows\\System32\\tar.exe'; // bsdtar de Windows: crea .zip con -a

const die = (m: string): never => { console.error('✗ ' + m); process.exit(1); };
function run(cmd: string[], cwd = ROOT) {
  console.log(`$ ${cmd.join(' ')}`);
  const r = Bun.spawnSync(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) die(`Falló: ${cmd.join(' ')}`);
}
const out = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: ROOT }).stdout.toString().trim();

// ---------- 1. Compilar ----------
if (!skipBuild) {
  run(['bun', 'packages/ui/build.ts']);
  run(['bunx', 'tauri', 'build', '--no-bundle'], join(ROOT, 'apps', 'desktop'));
  run(['bun', 'apps/portable/pack.ts']);
}
const exe = join(ROOT, 'target', 'release', 'tesserafs-desktop.exe');
const portable = join(ROOT, 'apps', 'portable', 'dist', 'TesseraFS-portable');
if (!existsSync(exe)) die('No existe target/release/tesserafs-desktop.exe');
if (!existsSync(join(portable, 'tesserafs.js'))) die('No existe la carpeta portable');

// ---------- 2. Avisos de terceros ----------
function rustNotices(): string {
  const meta = JSON.parse(out(['cargo', 'metadata', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--locked']));
  const members = new Set<string>(meta.workspace_members);
  const nodes = new Map<string, { deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }>(meta.resolve.nodes.map((n: any) => [n.id, n]));
  const desktop = meta.packages.find((p: any) => p.name === 'tesserafs-desktop').id;
  // Sólo lo que acaba dentro del exe: dependencias normales alcanzables desde la app de escritorio
  const seen = new Set<string>([desktop]); const stack = [desktop];
  while (stack.length) for (const d of nodes.get(stack.pop()!)!.deps)
    if (d.dep_kinds.some(k => k.kind === null) && !seen.has(d.pkg)) { seen.add(d.pkg); stack.push(d.pkg); }
  const rows = meta.packages.filter((p: any) => seen.has(p.id) && !members.has(p.id))
    .sort((a: any, b: any) => a.name.localeCompare(b.name))
    .map((p: any) => `${p.name} ${p.version} — ${p.license || 'ver repositorio'} — ${p.repository || ''}`.trim());
  return `Bibliotecas de Rust incluidas en tesserafs-desktop.exe (${rows.length}):\n\n${rows.join('\n')}\n`;
}
const fontsNotice = 'Fuentes incrustadas en la interfaz: Bricolage Grotesque e IBM Plex Sans/Mono,\n'
  + 'SIL Open Font License 1.1. Textos completos en la carpeta licencias/.\n';
const bunNotice = 'bun.exe es el runtime de Bun (https://bun.com), copiado sin modificar y firmado por su editor.\n'
  + 'Bun se distribuye bajo licencia MIT e incluye componentes de terceros, algunos bajo LGPL (como\n'
  + 'JavaScriptCore de WebKit), enlazados estáticamente. Licencias y avisos: https://bun.com/docs/project/license\n'
  + 'Código fuente: https://github.com/oven-sh/bun y https://github.com/oven-sh/WebKit\n';

function addLicenses(dir: string, extra: string) {
  const lic = join(dir, 'licencias'); mkdirSync(lic, { recursive: true });
  for (const f of ['LICENSE-MIT', 'LICENSE-APACHE']) cpSync(join(ROOT, f), join(lic, f));
  const fonts = join(ROOT, 'packages', 'ui', 'fonts', 'licencias');
  for (const f of readdirSync(fonts)) cpSync(join(fonts, f), join(lic, f));
  writeFileSync(join(dir, 'LICENCIAS-TERCEROS.txt'),
    `TesseraFS ${version} se distribuye bajo licencia MIT o Apache-2.0, a tu elección (ver licencias/).\n\n${fontsNotice}\n${extra}`);
}

// ---------- 3. Preparar carpetas y zips ----------
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const stage = join(OUT, 'stage'); mkdirSync(stage);

const deskName = `TesseraFS-${version}-escritorio`, deskDir = join(stage, deskName);
mkdirSync(deskDir); cpSync(exe, join(deskDir, 'tesserafs-desktop.exe'));
writeFileSync(join(deskDir, 'LEEME.txt'), [
  `TesseraFS ${version} · edición de escritorio`, '',
  'Analizador de espacio en disco para Windows 10/11 x64. No necesita instalación.', '',
  'Abrir: doble clic en tesserafs-desktop.exe.',
  'Si Windows muestra "Windows protegió su PC", pulsa Más información > Ejecutar de todas formas:',
  'el ejecutable todavía no está firmado digitalmente.', '',
  'Modo rápido: el botón "Modo rápido" reinicia la app como administrador para leer la MFT de NTFS',
  '(sólo lectura). Sin administrador, la app recorre las carpetas.', '',
  'Requiere WebView2, incluido en Windows 11 y en Windows 10 actualizado.',
  'Nada sale de tu equipo. Guía completa: docs/usuario/guia.md en el repositorio.', '',
].join('\r\n'));
addLicenses(deskDir, rustNotices());

const portName = `TesseraFS-${version}-portable`, portDir = join(stage, portName);
cpSync(portable, portDir, { recursive: true });
addLicenses(portDir, bunNotice);

const zips: string[] = [];
for (const [name, label] of [[deskName, 'escritorio'], [portName, 'portable']]) {
  const zip = join(OUT, `TesseraFS-${version}-${label}-win-x64.zip`);
  run([TAR, '-a', '-c', '-f', zip, '-C', stage, name]);
  zips.push(zip);
}
rmSync(stage, { recursive: true, force: true });

// ---------- 4. Sumas y notas ----------
const sums = zips.map(z => `${createHash('sha256').update(readFileSync(z)).digest('hex')}  ${z.split(/[\\/]/).pop()}`);
writeFileSync(join(OUT, 'SHA256SUMS.txt'), sums.join('\n') + '\n');

const cl = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const start = cl.indexOf(`## [${version}]`);
const section = start < 0 ? '' : cl.slice(cl.indexOf('\n', start) + 1, (cl.indexOf('\n## [', start + 1) + 1 || cl.length)).trim();
const mb = (f: string) => (readFileSync(f).length / 1048576).toFixed(1) + ' MB';
const notes = [
  '## Descargas', '',
  '| Archivo | Para |', '|---|---|',
  `| \`${zips[0].split(/[\\/]/).pop()}\` (${mb(zips[0])}) | Tu equipo: un único \`tesserafs-desktop.exe\`, el más rápido |`,
  `| \`${zips[1].split(/[\\/]/).pop()}\` (${mb(zips[1])}) | Equipos de empresa: sólo ejecuta programas firmados (\`bun.exe\` y Edge). Abre \`TesseraFS.cmd\`. |`,
  '', 'Descomprime y ejecuta: no hay instalación. Comprueba las descargas con `SHA256SUMS.txt`.', '',
  '> [!NOTE]', '> El ejecutable de escritorio aún no está firmado: SmartScreen puede pedir confirmación (Más información › Ejecutar de todas formas).', '',
  '## Cambios', '', section || '- Ver CHANGELOG.md', '',
].join('\n');
writeFileSync(join(OUT, 'NOTAS.md'), notes);

console.log(`\n✓ ${tag} empaquetada en ${OUT}`);
for (const z of zips) console.log(`  ${z.split(/[\\/]/).pop()}  ${mb(z)}`);

// ---------- 5. Publicar ----------
if (publish) {
  if (!out(['git', 'tag', '--list', tag])) die(`No existe la etiqueta ${tag}: ejecuta antes "bun run release"`);
  if (!out(['git', 'ls-remote', '--tags', 'origin', tag])) die(`La etiqueta ${tag} no está en GitHub: ejecuta "git push --follow-tags"`);
  const files = [...zips, join(OUT, 'SHA256SUMS.txt')], notesFile = join(OUT, 'NOTAS.md');
  // Repetible: si la release ya existe (p. ej. al relanzar el flujo), se reemplazan los archivos y las notas
  if (Bun.spawnSync(['gh', 'release', 'view', tag], { cwd: ROOT }).exitCode === 0) {
    run(['gh', 'release', 'upload', tag, ...files, '--clobber']);
    run(['gh', 'release', 'edit', tag, '--title', `TesseraFS ${version}`, '--notes-file', notesFile]);
  } else {
    const cmd = ['gh', 'release', 'create', tag, ...files, '--title', `TesseraFS ${version}`, '--notes-file', notesFile, '--verify-tag'];
    if (version.includes('-')) cmd.push('--prerelease');
    run(cmd);
  }
}
