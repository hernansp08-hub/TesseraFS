// Color de las teselas: por categoría (por defecto), por extensión o por antigüedad.
// Todos los tonos comparten luminosidad perceptual (OKLCH) para que el relieve no se confunda con el color.
// Los nombres visibles salen del catálogo de idiomas: cat.<id> y age.<tramo>.
import { tk } from './i18n';

export type RGB = [number, number, number];
export type ColorMode = 'category' | 'ext' | 'age';

export function oklch(L: number, C: number, h: number): RGB {
  const a = C * Math.cos(h * Math.PI / 180), b = C * Math.sin(h * Math.PI / 180);
  const l = (L + .3963377774 * a + .2158037573 * b) ** 3, m = (L - .1055613458 * a - .0638541728 * b) ** 3, s = (L - .0894841775 * a - 1.2914855480 * b) ** 3;
  const f = (x: number) => { x = Math.max(0, Math.min(1, x)); return Math.round(255 * (x <= .0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - .055)); };
  return [f(4.0767416621 * l - 3.3077115913 * m + .2309699292 * s), f(-1.2684380046 * l + 2.6097574011 * m - .3413193965 * s), f(-.0041960863 * l - .7034186147 * m + 1.7076147010 * s)];
}
export const rgb = (c: RGB) => `rgb(${c[0]},${c[1]},${c[2]})`;

export interface Category { id: string; hue: number; color: RGB; exts: string[] }
const CAT_DEF: [string, number, string][] = [
  ['video', 28, 'mp4 mkv avi mov wmv webm m4v mpg mpeg ts3 flv'],
  ['image', 342, 'jpg jpeg png gif bmp webp heic heif raw cr2 nef arw dng psd svg tif tiff ico avif'],
  ['audio', 305, 'mp3 wav flac aac ogg m4a wma opus bank fsb wem'],
  ['docs', 88, 'pdf doc docx xls xlsx ppt pptx odt ods odp txt rtf csv epub md one msg pst ost'],
  ['code', 145, 'js mjs cjs ts tsx jsx py rs go java kt c cc cpp h hpp cs swift rb php lua json xml yml yaml toml ini cfg css scss html htm map abap sql sh ps1 bat cmd pyi vue svelte'],
  ['build', 178, 'o obj lib a rlib rmeta pdb pyc pyd class jar wasm node d ilk exp ipdb iobj nupkg'],
  ['apps', 252, 'exe dll msi msp msu cab sys mui cat inf appx msix appxbundle ocx drv efi manifest com scr cpl'],
  ['archive', 58, 'zip 7z rar gz tgz bz2 xz zst tar iso img vhd vhdx vmdk wim esd ppkg pack dmg qcow2'],
  ['games', 205, 'pak assets ress resource cok bsa ba2 vpk upk uasset ubulk utoc ucas unity3d bundle forge big'],
  ['data', 280, 'gguf safetensors onnx pt pth ckpt npy npz parquet arrow db sqlite sqlite3 ldb mdb accdb bf nnue dat h5 hdf5 feather'],
];
export const OTHER: Category = { id: 'other', hue: 250, color: oklch(.66, .012, 250), exts: [] };
export const CATEGORIES: Category[] = CAT_DEF.map(([id, hue, exts]) => ({ id, hue, color: oklch(.72, .135, hue), exts: exts.split(' ') }));
const EXT2CAT = new Map<string, Category>();
for (const c of CATEGORIES) for (const e of c.exts) EXT2CAT.set(e, c);
export const categoryOf = (ext: string): Category => EXT2CAT.get(ext) || OTHER;
export const categoryById = (id: string) => CATEGORIES.find(c => c.id === id) || OTHER;
export const catName = (c: Category) => tk('cat.' + c.id);

// Modo extensión: las 16 extensiones con más bytes reciben tono propio; el resto, gris
const EXT_HUES = [48, 255, 140, 330, 95, 200, 295, 18, 170, 232, 66, 118, 352, 275, 185, 82];
const EXT_PAL = EXT_HUES.map(h => oklch(.72, .145, h));
let extColors = new Map<string, RGB>();
export function setExtRanking(exts: string[]) { extColors = new Map(exts.slice(0, EXT_PAL.length).map((e, i) => [e, EXT_PAL[i]])); }
export const extColor = (ext: string): RGB => extColors.get(ext) || OTHER.color;

// Modo antigüedad: de reciente (ámbar) a antiguo (azul), en cinco tramos
export const AGE_BINS = [{ max: 31 * 86400 }, { max: 182 * 86400 }, { max: 365 * 86400 }, { max: 3 * 365 * 86400 }, { max: Infinity }];
export const ageName = (i: number) => tk('age.' + i);
const AGE_COL = [oklch(.74, .15, 62), oklch(.72, .12, 120), oklch(.7, .1, 180), oklch(.66, .11, 235), oklch(.6, .1, 270)];
export const ageBin = (mtime: number, now: number) => { const d = now - mtime; let i = 0; while (d > AGE_BINS[i].max) i++; return i; };
export const ageColor = (i: number) => AGE_COL[i];

export const REST_COLOR: RGB = oklch(.5, .01, 250);
