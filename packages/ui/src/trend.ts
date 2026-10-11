// Evolución en el historial: ajuste lineal, «cuándo se llenaría» y el gráfico (SVG) que lo dibuja.
// Sin dependencias de la interfaz, para probarlo (test/trend.test.ts).

/** Un punto: fecha (segundos Unix) y tamaño en bytes. */
export interface Pt { t: number; y: number }
export interface Fit {
  /** Bytes por día (negativo si se reduce). */
  perDay: number;
  /** Días que abarcan los puntos usados. */
  days: number;
  at(t: number): number;
}
const DAY = 86400;

/**
 * Recta de mínimos cuadrados con los `max` puntos más recientes. Sin estimación (null) con menos de 3 puntos o si
 * abarcan menos de 2 días: con tan pocos datos, una tendencia engañaría.
 */
export function fitTrend(pts: Pt[], max = 10): Fit | null {
  const p = [...pts].sort((a, b) => a.t - b.t).slice(-max);
  if (p.length < 3 || p[p.length - 1].t - p[0].t < 2 * DAY) return null;
  const n = p.length, mt = p.reduce((s, q) => s + q.t, 0) / n, my = p.reduce((s, q) => s + q.y, 0) / n;
  let sxy = 0, sxx = 0;
  for (const q of p) { sxy += (q.t - mt) * (q.y - my); sxx += (q.t - mt) ** 2; }
  const slope = sxx ? sxy / sxx : 0; // bytes por segundo
  return { perDay: slope * DAY, days: (p[n - 1].t - p[0].t) / DAY, at: t => my + slope * (t - mt) };
}

/** Días hasta agotar `free` bytes al ritmo `perDay`; null si no crece. */
export const daysToFill = (perDay: number, free: number) => perDay > 0 && free > 0 ? free / perDay : null;

/** Marcas «redondas» del eje (1, 2 o 5 × 10^k) que cubren [min, max]. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) { const v = max || 1; return [v * .9, v, v * 1.1]; }
  const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw)), r = raw / mag;
  const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step * 1e-9; v += step) out.push(v);
  if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
  return out;
}

export interface ChartOptions {
  width: number; height: number;
  fmtY(bytes: number): string;
  fmtX(t: number): string;
  /** Proyección: se prolonga la recta hasta `until` (segundos Unix) con trazo discontinuo y la etiqueta `label`. */
  fit?: Fit | null; until?: number; label?: string;
  /** Sin ejes ni etiquetas: sólo la línea (para el panel de detalle). */
  spark?: boolean;
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/**
 * Gráfico de una sola serie: rejilla tenue, línea de 2 px, puntos de 8 px con aro del color de fondo y, si hay
 * ajuste, la proyección discontinua. Cada punto lleva un área de contacto mayor con `data-i` para el tooltip.
 * Colores con las variables de la interfaz: se adapta solo al tema claro y oscuro.
 */
export function trendSVG(pts: Pt[], o: ChartOptions): string {
  const p = [...pts].sort((a, b) => a.t - b.t);
  if (!p.length) return '';
  const L = o.spark ? 4 : 58, R = o.spark ? 6 : (o.fit && o.until ? 70 : 14), T = 8, B = o.spark ? 6 : 22;
  const t0 = p[0].t, t1 = Math.max(o.fit && o.until ? o.until : p[p.length - 1].t, t0 + DAY);
  const ys = p.map(q => q.y); if (o.fit && o.until) ys.push(o.fit.at(o.until));
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const y0 = o.spark ? Math.min(...ys) : ticks[0], y1 = o.spark ? Math.max(...ys) : ticks[ticks.length - 1];
  const X = (t: number) => L + (t - t0) / (t1 - t0) * (o.width - L - R);
  const Y = (v: number) => y1 === y0 ? (o.height - B + T) / 2 : T + (1 - (v - y0) / (y1 - y0)) * (o.height - T - B);
  const f = (n: number) => n.toFixed(1);
  let s = `<svg class="trend-svg" viewBox="0 0 ${o.width} ${o.height}" width="${o.width}" height="${o.height}" role="img">`;
  if (!o.spark) {
    for (const v of ticks) s += `<line class="tg" x1="${L}" x2="${o.width - R}" y1="${f(Y(v))}" y2="${f(Y(v))}"/><text class="tl" x="${L - 6}" y="${f(Y(v) + 3.5)}" text-anchor="end">${esc(o.fmtY(v))}</text>`;
    s += `<text class="tl" x="${L}" y="${o.height - 6}">${esc(o.fmtX(p[0].t))}</text>`;
    if (p.length > 1) s += `<text class="tl" x="${f(X(p[p.length - 1].t))}" y="${o.height - 6}" text-anchor="middle">${esc(o.fmtX(p[p.length - 1].t))}</text>`;
  }
  if (o.fit && o.until) {
    const a = p[p.length - 1];
    s += `<line class="tp" x1="${f(X(a.t))}" y1="${f(Y(a.y))}" x2="${f(X(o.until))}" y2="${f(Y(o.fit.at(o.until)))}"/>`;
    if (o.label && !o.spark) s += `<text class="tl" x="${f(X(o.until) + 4)}" y="${f(Y(o.fit.at(o.until)) + 3.5)}">${esc(o.label)}</text>`;
  }
  s += `<path class="tline" d="${p.map((q, i) => `${i ? 'L' : 'M'}${f(X(q.t))},${f(Y(q.y))}`).join('')}"/>`;
  p.forEach((q, i) => {
    s += `<circle class="tdot" cx="${f(X(q.t))}" cy="${f(Y(q.y))}" r="4"/>`
      + `<circle class="thit" data-i="${i}" cx="${f(X(q.t))}" cy="${f(Y(q.y))}" r="11"/>`;
  });
  return s + '</svg>';
}
