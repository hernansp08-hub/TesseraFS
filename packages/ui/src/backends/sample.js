// Datos de ejemplo deterministas para la edición demo (sin acceso al disco).
const KB = 1024, MB = KB * 1024, GB = MB * 1024;
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let R = mulberry32(20261007);
const rint = (a, b) => a + Math.floor(R() * (b - a + 1));
const pick = a => a[Math.floor(R() * a.length)];
function lognorm(med, sig) { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return med * Math.exp(sig * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)); }
const T1 = Date.UTC(2026, 9, 7, 9, 30) / 1000, T0 = Date.UTC(2023, 8, 1) / 1000;
const rtime = (bias = 1.8) => Math.floor(T1 - Math.pow(R(), bias) * (T1 - T0));
const hex = n => { let s = ''; for (let i = 0; i < n; i++) s += '0123456789abcdef'[Math.floor(R() * 16)]; return s; };

const N = [];
function extOf(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i + 1).toLowerCase() : ''; }
function mk(parent, name, isDir, size, mtime) {
  const n = { id: N.length, name, parent, isDir, size: size || 0, alloc: 0, ualloc: 0, files: 0, dirs: 0, mtime: mtime || 0,
    ext: isDir ? '' : extOf(name), kids: isDir ? [] : null, mk: null, names: isDir ? new Set() : null,
    depth: parent ? parent.depth + 1 : 0, big: null, comp: false, hl: false, hidden: false };
  N.push(n);
  if (parent) { parent.kids.push(n); parent.names.add(name.toLowerCase()); }
  return n;
}
function uniq(p, base) { let nm = base, k = 2; while (p.names.has(nm.toLowerCase())) nm = base.replace(/(\.[^.]+)?$/, m => '-' + (k++) + m); return nm; }
const dir = (p, name) => mk(p, p ? uniq(p, name) : name, true);
const file = (p, name, size, mt) => mk(p, uniq(p, name), false, Math.max(0, Math.round(size)), mt || rtime());

const SYL = ['core','base','net','ui','gfx','sys','api','io','data','text','win','shell','media','audio','render','input','font','crypto','zip','sql','http','json','xml','log','util','task','sync','cache','mesh','tex','anim','phys','script','web','view','edit','print','scan','game','sound','map','geo','user','auth','store','time','mem','gpu'];
const stems = {
  sys: () => pick(['api-ms-win-', '', '', 'Microsoft.', 'win', '', 'd3d', '', 'nt', '']) + pick(SYL) + (R() < .5 ? pick(SYL) : '') + (R() < .35 ? String(rint(10, 64)) : ''),
  game: () => pick(['data','level','asset','sound','texture','shader','pak','chunk','world','ui']) + '_' + String(rint(0, 999)).padStart(3, '0'),
  dev: () => 'lib' + pick(SYL) + (R() < .6 ? '_' + pick(SYL) : '') + '-' + hex(16),
  rs: () => pick(SYL) + (R() < .4 ? '_' + pick(SYL) : ''),
  web: () => pick(['index','main','chunk','vendor','utils','types','helpers','core','runtime','parser','compiler','server','client','react','lodash','esbuild','tsc']) + (R() < .4 ? '.' + pick(['min','esm','cjs','d','prod']) : '') + (R() < .5 ? '-' + hex(6) : ''),
  user: () => pick(['IMG_','VID_','Factura ','Informe ','Captura ','Presupuesto ','Setup-','backup-','Foto ','Nota ']) + rint(1000, 9999),
  cache: () => R() < .5 ? hex(R() < .5 ? 16 : 32) : 'f_' + hex(6),
  app: () => pick(SYL) + (R() < .5 ? pick(SYL) : '') + (R() < .3 ? pick(['64','32','_x64','Host','Service','Helper','Core','UI']) : ''),
};
// Perfiles: e = [extensión, peso, mediana, sigma]; d = nombres de carpeta
const P = {
  sys: { s: 'sys', e: [['dll',40,1.4*MB,1.4],['exe',7,1.6*MB,1.5],['mui',8,180*KB,1.1],['sys',4,500*KB,1.3],['dat',3,5*MB,1.8],['',3,900*KB,2],['cat',4,100*KB,1],['manifest',4,60*KB,1],['png',4,250*KB,1.2],['xml',3,120*KB,1.2]],
    d: ['x64','drivers','DriverStore','FileRepository','en-US','es-ES','catroot','wbem','spool','Tasks','config','LogFiles','WindowsPowerShell','Speech','IME','migration','Microsoft','Boot','InputMethod','oobe','Sysprep','downlevel','CodeIntegrity','winevt','GroupPolicy'] },
  sxs: { s: 'sys', e: null, d: () => pick(['amd64','wow64','x86','msil']) + '_microsoft-windows-' + pick(SYL) + (R() < .5 ? '-' + pick(SYL) : '') + '_31bf3856ad364e35_10.0.26100.' + rint(1, 6899) + '_none_' + hex(16) },
  game: { s: 'game', e: [['pak',8,200*MB,1],['assets',10,40*MB,1.6],['ress',6,120*MB,1.2],['bin',5,10*MB,1.8],['dll',6,6*MB,1.3],['bank',3,30*MB,1.2],['json',3,120*KB,1.4],['png',3,2*MB,1.2]],
    d: ['Content','Data','StreamingAssets','Managed','Plugins','Audio','Maps','Textures','Shaders','Mods','Localization','x64','Binaries','Win64','Movies','Cache'] },
  dev: { s: 'dev', e: [['rlib',10,7*MB,1.5],['rmeta',6,1.2*MB,1.4],['pdb',4,28*MB,1.3],['lib',3,18*MB,1.4],['exe',2,14*MB,1.2],['d',5,6*KB,1],['',7,1.8*MB,2],['o',7,900*KB,1.6],['dll',2,9*MB,1.2]],
    d: ['deps','build','incremental','.fingerprint','examples','x86_64-pc-windows-msvc','out','tmp'] },
  rs: { s: 'rs', e: [['rs',20,40*KB,1],['toml',2,2*KB,1],['md',1,8*KB,1],['json',1,6*KB,1]], d: ['src','tests','benches','crates','core','ui','scanner','parser'] },
  web: { s: 'web', e: [['js',30,60*KB,1.5],['ts',8,24*KB,1.3],['json',8,10*KB,1.5],['map',8,120*KB,1.4],['md',4,9*KB,1.2],['node',1,7*MB,1.1],['wasm',1,4*MB,1.2],['css',3,22*KB,1.4]],
    d: ['node_modules','dist','lib','src','esm','cjs','types','build','@types','@babel','react-dom','typescript','esbuild','vite','rollup','lodash','zod','@tauri-apps','three','@esbuild','prettier','eslint'] },
  user: { s: 'user', e: [['jpg',10,3.2*MB,1.1],['png',5,1.3*MB,1.4],['pdf',6,1.8*MB,1.5],['mp4',3,240*MB,1.2],['zip',4,55*MB,1.7],['docx',4,500*KB,1.2],['xlsx',3,350*KB,1.3],['msi',1.5,90*MB,1],['exe',2,75*MB,1.2],['mp3',2,6*MB,.7]],
    d: ['Proyectos','Fotos 2025','Fotos 2026','Facturas','Capturas','Instaladores','Copias','Trabajo','Viajes','Clientes','Plantillas','Personal'] },
  cache: { s: 'cache', e: [['',30,1.6*MB,2],['bin',6,7*MB,1.8],['db',3,35*MB,1.4],['log',4,3*MB,1.5],['tmp',6,5*MB,1.8],['json',3,40*KB,1.4],['ldb',4,2*MB,1]],
    d: ['Cache','Code Cache','GPUCache','Temp','CrashDumps','Packages','Default','Service Worker','CacheStorage','IndexedDB','D3DSCache','NVIDIA','pip','cargo','npm-cache','bun','logs','blob_storage'] },
  app: { s: 'app', e: [['dll',30,5*MB,1.6],['exe',6,11*MB,1.4],['pak',4,28*MB,1.2],['dat',4,9*MB,1.6],['json',4,30*KB,1.3],['png',6,180*KB,1.4],['cab',2,55*MB,1.2],['bin',3,18*MB,1.6],['msi',.6,110*MB,1]],
    d: ['bin','lib','resources','plugins','locales','x64','root','Office16','shared','runtimes','tools','modules','Updates','assets','extensions','drivers'] },
  inst: { s: 'cache', e: [['msi',3,38*MB,1.2],['msp',3,28*MB,1.2],['cab',1,45*MB,1]], d: ['$PatchCache$','Managed','SourceHash'] },
  drv: { s: 'app', e: [['sys',3,2*MB,1.4],['inf',3,40*KB,1],['cat',2,30*KB,1],['dll',3,4*MB,1.4],['exe',1,28*MB,1.2],['bin',1,9*MB,1.3]], d: ['Audio','Chipset','Graphics','LAN','WLAN','Bluetooth','Camera','Touchpad','BIOS','Thunderbolt'] },
  git: { s: 'cache', e: [['pack',3,280*MB,1.2],['idx',3,7*MB,1.2],['',20,18*KB,1.5],['rev',2,1*MB,1]], d: ['objects','pack','refs','logs','hooks','info','lfs'] },
  py: { s: 'web', e: [['pyd',4,2*MB,1.5],['py',22,14*KB,1.4],['dll',2,6*MB,1.4],['pyc',20,11*KB,1.3],['pyi',4,9*KB,1.2]], d: ['Lib','site-packages','numpy','torch','scipy','pandas','__pycache__','Scripts','include','_core','linalg'] },
  abap: { s: 'app', e: [['abap',10,38*KB,1.3],['xml',6,18*KB,1.3],['json',2,9*KB,1],['zip',1,70*MB,1.2],['jar',1,28*MB,1]], d: ['src','zcl','reports','ddic','classes','interfaces','tests','export','transports'] },
  nnue: { s: 'cache', e: [['nnue',1,68*MB,.25]], d: ['old','candidates'] },
  fonts: { s: 'app', e: [['ttf',3,900*KB,1],['otf',1,500*KB,1]], d: ['Deleted'] },
};
P.sxs.e = P.sys.e;

function meanOf(prof) {
  if (prof._m) return prof._m;
  const tw = prof.e.reduce((s, x) => s + x[1], 0); let m = 0;
  for (const x of prof.e) m += x[1] / tw * x[2] * Math.exp(x[3] * x[3] / 2);
  return prof._m = m;
}
function files(p, bytes, prof) {
  const tw = prof.e.reduce((s, x) => s + x[1], 0); let left = bytes, c = 0;
  while (left > 0.5) {
    let r = R() * tw, e = prof.e[0];
    for (const x of prof.e) { if ((r -= x[1]) <= 0) { e = x; break; } }
    let sz = Math.min(lognorm(e[2], e[3]), e[2] * 60);
    if (sz >= left || c >= 140 || left - sz < 4 * KB) sz = left;
    file(p, (stems[prof.s] || stems.app)() + (e[0] ? '.' + e[0] : ''), sz);
    left -= sz; c++;
  }
}
function fill(p, bytes, prof, depth) {
  if (bytes <= 0) return;
  const cap = 90 * meanOf(prof);
  const split = (depth > 0 && bytes > 48 * MB) || bytes > cap * 1.6;
  const fb = split ? Math.min(bytes * (0.12 + R() * 0.33), cap) : bytes;
  files(p, fb, prof);
  if (!split) return;
  const rest = bytes - fb, k = 2 + Math.floor(R() * (depth > 2 ? 5 : 4));
  const w = []; let sw = 0;
  for (let i = 0; i < k; i++) { const x = Math.pow(R(), 2.4) + 0.03; w.push(x); sw += x; }
  for (let i = 0; i < k; i++) {
    let nm;
    for (let t = 0; t < 5; t++) { nm = typeof prof.d === 'function' ? prof.d() : pick(prof.d); if (!p.names.has(nm.toLowerCase())) break; }
    fill(dir(p, nm), rest * w[i] / sw, prof, depth - 1);
  }
}
function F(p, name, gb, prof, depth) { const d = dir(p, name); fill(d, gb * GB, prof, depth); return d; }

// Unidad de ejemplo: estructura plausible de un equipo de desarrollo con juegos y modelos de IA (tamaños en GB)
function build() {
  N.length = 0; R = mulberry32(20261007);
  const root = dir(null, 'C:');
  const pfx = dir(root, 'Program Files (x86)');
  const steam = dir(pfx, 'Steam'), sapps = dir(steam, 'steamapps'), common = dir(sapps, 'common');
  const cs2 = dir(common, 'Cities Skylines II'), c2d = dir(cs2, 'Cities2_Data'), content = dir(c2d, 'Content'), game = dir(content, 'Game');
  file(game, 'VT.cok', 52.1 * GB, T1 - 3 * 86400);
  [4.1, 3.2, 2.6, 2.2, 1.9, 1.6, 1.4, 1.2, .9].forEach((g, i) => file(game, `VT_${String(i + 1).padStart(2, '0')}.cok`, g * GB));
  fill(c2d, 1.3 * GB, P.game, 3); fill(cs2, .3 * GB, P.app, 2);
  F(common, 'Hades II', 8.4, P.game, 4); F(common, 'Hollow Knight', 6.1, P.game, 3); F(common, 'Stardew Valley', .6, P.game, 3);
  F(common, 'Steamworks Shared', .9, P.app, 3); F(common, 'Balatro', .1, P.game, 2);
  F(sapps, 'shadercache', .2, P.cache, 2); fill(steam, 1.4 * GB, P.app, 3);
  F(pfx, 'Windows Kits', 4.8, P.app, 4); F(pfx, 'Microsoft Visual Studio', 3.9, P.app, 4); F(pfx, 'Microsoft', 2.6, P.app, 4);
  F(pfx, 'Epic Games', 2.2, P.app, 3); F(pfx, 'NVIDIA Corporation', .7, P.app, 3);

  const users = dir(root, 'Users'), me = dir(users, 'usuario'), appd = dir(me, 'AppData'), local = dir(appd, 'Local');
  const models = dir(dir(local, 'lm-studio'), 'models');
  [['qwen3-14b-instruct-q4_k_m', 4.9], ['gemma-3-12b-it-q4_k_m', 4.1], ['mistral-small-24b-q3_k_l', 3.8], ['llama-3.1-8b-instruct-q8_0', 2.9],
   ['phi-4-mini-q8_0', 2.2], ['deepseek-r1-distill-7b-q4_k_m', 1.9], ['nomic-embed-text-v2-f16', 1.4], ['qwen3-1.7b-q8_0', 1.0]]
    .forEach(([n, g]) => file(models, n + '.gguf', g * GB, rtime(3)));
  F(local, 'Temp', 3.1, P.cache, 3); F(local, 'Google', 5.2, P.cache, 4); F(local, 'Microsoft', 4.6, P.cache, 4);
  file(dir(dir(local, 'Docker'), 'wsl'), 'docker_data.vhdx', 5.4 * GB, T1 - 86400);
  F(local, 'Packages', 2.2, P.cache, 4); fill(local, 1.0 * GB, P.cache, 3);
  F(appd, 'Roaming', 4.1, P.cache, 4);
  F(me, 'Downloads', 9.6, P.user, 3); F(me, 'Documents', 3.8, P.user, 3); F(me, 'Pictures', 4.2, P.user, 3);
  F(me, 'Videos', 3.1, P.user, 2); F(me, '.cargo', 1.6, P.dev, 3); F(me, '.rustup', 1.4, P.dev, 3);
  F(users, 'Public', .3, P.user, 2);

  const apps = dir(root, 'apps');
  const lam = dir(apps, 'lamina-rs'), tgt = dir(lam, 'target');
  F(tgt, 'debug', 11.3, P.dev, 4); F(tgt, 'release', 9.5, P.dev, 4);
  F(lam, '.git', 2.8, P.git, 2); F(lam, 'src', .02, P.rs, 2); F(lam, 'assets', .58, P.user, 2);
  const chess = dir(apps, 'chess-engine'), data = dir(chess, 'data'), nnue = dir(data, 'nnue');
  [2.1, 1.9, 1.7, 1.6, 1.4, 1.3, 1.2, 1.2, 1.1, 1.0, 1.0, .9, .9, .8, .7, .6, .5, .5]
    .forEach((g, i) => file(nnue, `selfplay-2026-${String(i + 1).padStart(2, '0')}.bf`, g * GB));
  fill(nnue, 1.2 * GB, P.nnue, 1); fill(data, .2 * GB, P.cache, 1);
  F(chess, 'build', 1.0, P.dev, 3); F(chess, 'src', .03, P.rs, 2); F(chess, '.git', .27, P.git, 2);
  const web = dir(apps, 'tessera-web'); F(web, 'node_modules', 2.3, P.web, 5); F(web, 'dist', .05, P.web, 2); F(web, 'src', .25, P.web, 3);
  const dash = dir(apps, 'dashboard'); F(dash, 'node_modules', 1.7, P.web, 5); F(dash, '.next', .2, P.web, 3);
  const notas = dir(apps, 'notas-ia'); F(notas, '.venv', 1.8, P.py, 5); F(notas, 'datos', .3, P.user, 2);
  F(apps, 'scripts', .3, P.web, 2); F(apps, 'abap-tools', 2.0, P.abap, 3);

  const pf = dir(root, 'Program Files');
  F(pf, 'WindowsApps', 13.0, P.app, 4); F(pf, 'Lenovo', 9.5, P.app, 4); F(pf, 'Microsoft Visual Studio', 7.9, P.app, 4);
  F(pf, 'Microsoft Office', 6.1, P.app, 4); F(pf, 'Docker', 4.2, P.app, 3); F(pf, 'Adobe', 3.8, P.app, 4);
  F(pf, 'NVIDIA Corporation', 3.4, P.app, 3); F(pf, 'Common Files', 2.1, P.app, 3); F(pf, 'dotnet', 1.6, P.app, 3);
  F(pf, 'Git', .4, P.app, 3); F(pf, 'PowerShell', .3, P.app, 2); F(pf, 'nodejs', .2, P.web, 3);

  const win = dir(root, 'Windows');
  F(win, 'WinSxS', 14.4, P.sxs, 4); F(win, 'System32', 9.6, P.sys, 4); F(win, 'Installer', 6.8, P.inst, 1);
  F(win, 'assembly', 3.1, P.sys, 3); F(win, 'SoftwareDistribution', 2.9, P.cache, 3); F(win, 'SysWOW64', 2.4, P.sys, 3);
  F(win, 'Microsoft.NET', 2.0, P.sys, 3); F(win, 'servicing', 1.8, P.sys, 3); F(win, 'SystemApps', 1.2, P.app, 3);
  F(win, 'Fonts', .9, P.fonts, 0); F(win, 'Temp', .6, P.cache, 2); F(win, 'Logs', .4, P.cache, 2); fill(win, 2.5 * GB, P.sys, 2);

  const rec = dir(root, 'Recovery');
  file(dir(rec, 'Customizations'), 'USMT.PPKG', 12.2 * GB, Date.UTC(2024, 4, 22) / 1000);
  file(dir(rec, 'WindowsRE'), 'Winre.wim', .2 * GB, Date.UTC(2025, 10, 12) / 1000);
  F(root, 'ProgramData', 6.3, P.cache, 4); F(root, 'Drivers', 5.6, P.drv, 3); F(root, 'abap', 5.6, P.abap, 4);
  file(root, 'pagefile.sys', 3.0 * GB, T1 - 3600); file(root, 'swapfile.sys', .27 * GB, T1 - 3600);
  file(root, 'DumpStack.log', 12 * KB); file(root, 'windows11-kb5066835.msu', .33 * GB);
  F(root, 'tmp', 2.2, P.cache, 3);
  const svi = dir(root, 'System Volume Information');
  [.82, .54, .33, .21].forEach(g => file(svi, `{${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}}{3808876b-c176-4e48-b7ae-04046e6cc752}`, g * GB));
  F(root, 'rust', 1.3, P.dev, 3); F(root, '$Recycle.Bin', .6, P.user, 2); F(root, 'PerfLogs', .0001, P.cache, 0);
  return root;
}
function walk(n, f) { const st = [n]; while (st.length) { const x = st.pop(); f(x); if (x.isDir) for (const k of x.kids) st.push(k); } }
const HIDDEN = new Set(['ProgramData', 'Recovery', 'System Volume Information', '$Recycle.Bin', 'AppData', '.git', 'PerfLogs', 'pagefile.sys', 'swapfile.sys', 'DumpStack.log']);
function postProcess(root) {
  const win = root.kids.find(k => k.name === 'Windows');
  walk(win.kids.find(k => k.name === 'WinSxS'), n => { if (!n.isDir) { n.comp = R() < .42; n.hl = R() < .36; } });
  walk(win.kids.find(k => k.name === 'System32'), n => { if (!n.isDir) n.comp = R() < .22; });
  for (const n of N) if (HIDDEN.has(n.name)) n.hidden = true;
}
// Agregación ascendente en una pasada: cada padre tiene id menor que sus hijos
function aggregate() {
  for (let i = N.length - 1; i >= 0; i--) {
    const n = N[i];
    if (!n.isDir) {
      n.alloc = n.size <= 700 ? 0 : Math.ceil(n.size / 4096) * 4096;
      if (n.comp) n.alloc = Math.ceil(n.alloc * .47 / 4096) * 4096;
      n.ualloc = n.hl ? 0 : n.alloc;
    }
    const p = n.parent; if (!p) continue;
    p.size += n.size; p.alloc += n.alloc; p.ualloc += n.ualloc;
    if (n.isDir) { p.dirs += 1 + n.dirs; p.files += n.files; } else p.files++;
    if (n.mtime > p.mtime) p.mtime = n.mtime;
    const b = n.isDir ? n.big : n; if (b && (!p.big || b.size > p.big.size)) p.big = b;
  }
  for (const n of N) if (n.isDir) { n.kids.sort((a, b) => b.size - a.size); n.mk = n.kids.filter(k => k.size > 0); }
}

export function buildSample() { const root = build(); postProcess(root); aggregate(); return { N, root }; }
