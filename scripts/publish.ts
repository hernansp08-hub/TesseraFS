// Sumas, notas y publicación de una versión a partir de lo que haya en dist/release/vX.Y.Z (de uno o varios sistemas).
// En GitHub Actions, el trabajo «Publicar» junta ahí los paquetes de Windows y de Linux y ejecuta este script.
// Uso: bun scripts/publish.ts [--dry-run]     (sin --dry-run crea o actualiza la release en GitHub)
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

const ROOT = join(import.meta.dir, '..');

/** Paquetes que se publican, en el orden de la tabla de descargas, con su descripción. */
const ASSETS: [RegExp, (f: string) => string][] = [
  [/-instalador-win-x64\.exe$/, () => 'Windows, lo recomendado: instalador. Acceso en el menú Inicio, se desinstala desde Configuración y actualiza encima de la versión anterior. No pide administrador.'],
  [/-escritorio-win-x64\.zip$/, () => 'Windows: un único `tesserafs-desktop.exe` (y `tessera-cli.exe`), el más rápido'],
  [/-portable-win-x64\.zip$/, () => 'Windows de empresa: sólo ejecuta programas firmados (`bun.exe` y Edge). Abre `TesseraFS.cmd`.'],
  [/-linux-x86_64\.AppImage$/, f => `Linux, cualquier distribución reciente: \`chmod +x ${f}\` y ábrelo. No instala nada.`],
  [/-linux-amd64\.deb$/, f => `Ubuntu, Debian, Mint, Pop!_OS…: \`sudo apt install ./${f}\``],
  [/-cli-linux-x64\.tar\.gz$/, () => 'Línea de comandos para Linux (servidores, tareas programadas): `tessera-cli`'],
];
const kindOf = (f: string) => ASSETS.findIndex(([re]) => re.test(f));

function die(m: string): never { console.error('✗ ' + m); process.exit(1); }
function run(cmd: string[]) {
  console.log(`$ ${cmd.join(' ')}`);
  if (Bun.spawnSync(cmd, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' }).exitCode !== 0) die(`Falló: ${cmd.join(' ')}`);
}
const out = (cmd: string[]) => Bun.spawnSync(cmd, { cwd: ROOT }).stdout.toString().trim();
const mb = (f: string) => (readFileSync(f).length / 1048576).toFixed(1) + ' MB';

/** Escribe SHA256SUMS.txt y NOTAS.md para los paquetes de `dir`; devuelve sus rutas (paquetes, sumas). */
export function sumsAndNotes(dir: string, version: string): string[] {
  const files = readdirSync(dir).filter(f => kindOf(f) >= 0).sort((a, b) => kindOf(a) - kindOf(b) || a.localeCompare(b));
  if (!files.length) die(`No hay paquetes en ${dir}`);
  const sums = files.map(f => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`);
  writeFileSync(join(dir, 'SHA256SUMS.txt'), sums.join('\n') + '\n');

  const cl = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
  const start = cl.indexOf(`## [${version}]`);
  const section = start < 0 ? '' : cl.slice(cl.indexOf('\n', start) + 1, (cl.indexOf('\n## [', start + 1) + 1 || cl.length)).trim();
  const win = files.some(f => /\.(zip|exe)$/.test(f)), linux = files.some(f => /\.(AppImage|deb)$/.test(f));
  const notes = [
    '## Descargas', '',
    '| Archivo | Para |', '|---|---|',
    ...files.map(f => `| \`${f}\` (${mb(join(dir, f))}) | ${ASSETS[kindOf(f)][1](f)} |`),
    '', 'Comprueba las descargas con `SHA256SUMS.txt`.', '',
    ...(win ? ['> [!NOTE]', '> Windows: el instalador se instala sólo para tu usuario, sin pedir administrador; los zips no se instalan (descomprime y ejecuta). Aún no están firmados: SmartScreen puede pedir confirmación (Más información › Ejecutar de todas formas).', ''] : []),
    ...(linux ? ['> [!NOTE]', '> Linux: x86_64 con WebKitGTK 4.1 (Ubuntu 22.04 o posterior, Debian 12, Fedora 37…). Guía: docs/usuario/linux.md.', ''] : []),
    '## Cambios', '', section || '- Ver CHANGELOG.md', '',
    '## Code signing policy', '',
    'Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/). '
      + 'Roles, privacy policy and details: [README › Code signing policy](https://github.com/hernansp08-hub/TesseraFS#code-signing-policy).', '',
  ].join('\n');
  writeFileSync(join(dir, 'NOTAS.md'), notes);
  console.log(`\n✓ v${version}: ${files.length} paquetes en ${dir}`);
  for (const f of files) console.log(`  ${f}  ${mb(join(dir, f))}`);
  return [...files.map(f => join(dir, f)), join(dir, 'SHA256SUMS.txt')];
}

/** Crea la release de GitHub o, si ya existe (al relanzar el flujo), reemplaza sus archivos y notas. */
export function publishRelease(dir: string, version: string, files: string[]) {
  const tag = `v${version}`;
  if (!out(['git', 'tag', '--list', tag])) die(`No existe la etiqueta ${tag}: ejecuta antes "bun run release"`);
  if (!out(['git', 'ls-remote', '--tags', 'origin', tag])) die(`La etiqueta ${tag} no está en GitHub: ejecuta "git push --follow-tags"`);
  const notesFile = join(dir, 'NOTAS.md');
  if (Bun.spawnSync(['gh', 'release', 'view', tag], { cwd: ROOT }).exitCode === 0) {
    run(['gh', 'release', 'upload', tag, ...files, '--clobber']);
    run(['gh', 'release', 'edit', tag, '--title', `TesseraFS ${version}`, '--notes-file', notesFile]);
  } else {
    const cmd = ['gh', 'release', 'create', tag, ...files, '--title', `TesseraFS ${version}`, '--notes-file', notesFile, '--verify-tag'];
    if (version.includes('-')) cmd.push('--prerelease');
    run(cmd);
  }
}

if (import.meta.main) {
  const version: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const dir = join(ROOT, 'dist', 'release', `v${version}`);
  const files = sumsAndNotes(dir, version);
  if (!process.argv.includes('--dry-run')) publishRelease(dir, version, files);
}
