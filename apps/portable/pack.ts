// Empaqueta la edición portable en dist/TesseraFS-portable:
//   bun.exe (copia firmada) + tesserafs.js (bundle minificado con la interfaz incrustada) + lanzadores + README multilingüe.
// Uso: bun apps/portable/pack.ts [--no-check]
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readmeText } from '../../packages/i18n/src/readme';

const here = import.meta.dir;
const out = join(here, 'dist', 'TesseraFS-portable');
const uiHtml = join(here, '..', '..', 'packages', 'ui', 'dist', 'index.html');
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');

if (!existsSync(uiHtml)) console.warn(`AVISO: no existe ${uiHtml}; se incrustará una página mínima (ejecuta "bun run ui:build").`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1) bundle (la macro de ui-macro.ts incrusta la interfaz al empaquetar)
const t0 = performance.now();
const r = await Bun.build({
  entrypoints: [join(here, 'src', 'main.ts')],
  outdir: out, naming: 'tesserafs.js', target: 'bun', minify: true, sourcemap: 'none',
});
if (!r.success) { for (const l of r.logs) console.error(l); process.exit(1); }
console.log(`tesserafs.js: ${(statSync(join(out, 'tesserafs.js')).size / 1024).toFixed(0)} KiB en ${(performance.now() - t0).toFixed(0)} ms`);

// 2) bun.exe: copia exacta del ejecutable firmado que está corriendo
const bunExe = process.execPath;
copyFileSync(bunExe, join(out, 'bun.exe'));

// 3) lanzadores y README (todos los idiomas de la interfaz, claves readme.* de packages/i18n)
writeFileSync(join(out, 'TesseraFS.cmd'), crlf(`@echo off
rem Lanzador de TesseraFS portable: bun.exe ejecuta tesserafs.js; la ventana es Microsoft Edge.
start "" /min "%~dp0bun.exe" "%~dp0tesserafs.js" %*
`));
writeFileSync(join(out, 'TesseraFS.vbs'), crlf(`' Lanzador opcional sin consola. Microsoft está retirando VBScript y muchas empresas lo bloquean:
' si no funciona, usa TesseraFS.cmd.
Set fso = CreateObject("Scripting.FileSystemObject")
d = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & d & "\\bun.exe"" """ & d & "\\tesserafs.js""", 0, False
`));
const version: string = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).version;
writeFileSync(join(out, 'README.txt'), readmeText('portable', version));

// 4) firma de bun.exe
const ps = Bun.spawnSync(['powershell.exe', '-NoProfile', '-Command',
  `$s = Get-AuthenticodeSignature -LiteralPath '${join(out, 'bun.exe').replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`]);
const [status, subject] = ps.stdout.toString().trim().split('|');
console.log(`bun.exe: firma ${status} (${subject ?? '?'})`);
if (status !== 'Valid') { console.error('ERROR: bun.exe no tiene una firma válida'); process.exit(1); }

// 5) contenido y tamaño
let total = 0;
for (const f of readdirSync(out)) { const s = statSync(join(out, f)).size; total += s; console.log(`  ${f.padEnd(16)} ${(s / 2 ** 20).toFixed(2).padStart(8)} MiB`); }
console.log(`Total: ${(total / 2 ** 20).toFixed(1)} MiB en ${out}`);

// 6) comprobación rápida: arranca el bundle sin ventana y consulta la API
if (!process.argv.includes('--no-check')) {
  const p = Bun.spawn([join(out, 'bun.exe'), join(out, 'tesserafs.js'), '--no-window'], { stdout: 'pipe', stderr: 'pipe', cwd: out });
  let text = '';
  const dec = new TextDecoder(), rd = p.stdout.getReader();
  const deadline = Date.now() + 15000;
  while (!/TESSERA \{/.test(text) && Date.now() < deadline) {
    const { value, done } = await rd.read(); if (done) break;
    text += dec.decode(value);
  }
  try {
    const m = text.match(/TESSERA (\{.*\})/);
    if (!m) throw new Error('el bundle no arrancó:\n' + text + (await new Response(p.stderr).text()));
    const { url, token } = JSON.parse(m[1]);
    const page = await (await fetch(url)).text();
    const vols = await (await fetch(url + 'api/volumes', { headers: { 'X-Tessera-Token': token } })).json();
    const denied = (await fetch(url + 'api/volumes')).status;
    console.log(`Comprobación: página ${page.length} B (token inyectado: ${page.includes(token)}), ${vols.length} unidad(es), sin token → ${denied}`);
  } finally {
    p.kill();
  }
}
