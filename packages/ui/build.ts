// Construye la interfaz como un único HTML autocontenido:
//   dist/index.html     documento completo (Tauri y edición portable)
//   dist-demo/demo.html sólo el contenido, para publicarlo como página de demostración
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const dir = import.meta.dir;
const version: string = JSON.parse(readFileSync(join(dir, '../../package.json'), 'utf8')).version;
const out = await Bun.build({
  entrypoints: [join(dir, 'src/main.ts')], target: 'browser', minify: true, format: 'iife',
  define: { __TESSERA_VERSION__: JSON.stringify(version) },
});
if (!out.success) { for (const l of out.logs) console.error(l); process.exit(1); }
const js = (await out.outputs[0].text()).replace(/<\/script/gi, '<\\/script');
const cssText = readFileSync(join(dir, 'src/style.css'), 'utf8');
const tpl = readFileSync(join(dir, 'index.html'), 'utf8');
// Fuentes incrustadas como data URI: la interfaz no hace ninguna petición a internet
const fonts = readFileSync(join(dir, 'fonts/fonts.css'), 'utf8')
  .replace(/url\(\.\/([^)]+)\)/g, (_, f) => `url(data:font/woff2;base64,${readFileSync(join(dir, 'fonts', f)).toString('base64')})`);
// replace con función: el JS minificado contiene secuencias como $& que String.replace interpretaría
const html = tpl.replace('/*FONTS*/', () => fonts).replace('/*STYLE*/', () => cssText).replace('/*SCRIPT*/', () => js);
if (/https?:\/\/(?!127\.0\.0\.1)[a-z]/i.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ''))) console.warn('Aviso: el HTML contiene URLs externas');
mkdirSync(join(dir, 'dist'), { recursive: true });
writeFileSync(join(dir, 'dist/index.html'), html);
// Versión de contenido: sin doctype/html/head/body (el publicador añade su propio esqueleto)
const head = html.slice(html.indexOf('<title>'), html.indexOf('</head>'));
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
mkdirSync(join(dir, 'dist-demo'), { recursive: true });
writeFileSync(join(dir, 'dist-demo/demo.html'), head + body);
console.log(`UI: ${(html.length / 1024).toFixed(0)} KB (js ${(js.length / 1024).toFixed(0)} KB)`);
