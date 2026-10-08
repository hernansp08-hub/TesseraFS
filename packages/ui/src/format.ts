// Formato de cifras y textos (es-ES). Tamaños en base 1024 con etiquetas GB/MB/KB.
export const KB = 1024, MB = KB * 1024, GB = MB * 1024, TB = GB * 1024;

const nf1 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
let nf0: Intl.NumberFormat;
try { nf0 = new Intl.NumberFormat('es-ES', { useGrouping: 'always' } as Intl.NumberFormatOptions); nf0.format(1234); }
catch { nf0 = new Intl.NumberFormat('de-DE'); }

export const fmtB = (b: number) => b >= TB ? nf1.format(b / TB) + ' TB' : b >= GB ? nf1.format(b / GB) + ' GB' : b >= MB ? nf1.format(b / MB) + ' MB'
  : b >= KB ? nf0.format(Math.round(b / KB)) + ' KB' : nf0.format(Math.round(b)) + ' B';
export const fmtN = (n: number) => nf0.format(n);
export const fmtP = (x: number) => nf1.format((isFinite(x) ? x : 0) * 100) + ' %';
export const fmtS = (ms: number) => nf1.format(ms / 1000) + ' s';
export const fmtD = (t: number) => {
  if (!t) return '—';
  const d = new Date(t * 1000);
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
};
export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export const joinPath = (base: string, name: string) => base.endsWith('\\') ? base + name : base + '\\' + name;

export function ageText(mtime: number, now = Date.now() / 1000) {
  const d = (now - mtime) / 86400;
  if (d < 1) return 'hoy';
  if (d < 31) return `hace ${Math.round(d)} d`;
  if (d < 365) return `hace ${Math.round(d / 30)} meses`;
  const y = d / 365; return y < 1.5 ? 'hace 1 año' : `hace ${Math.round(y)} años`;
}
