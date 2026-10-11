// Evolución del historial: ajuste, proyección y gráfico.
import { describe, expect, test } from 'bun:test';
import { daysToFill, fitTrend, niceTicks, trendSVG } from '../src/trend';

const DAY = 86400, GB = 1024 ** 3, t0 = 1_790_000_000;

describe('tendencia', () => {
  test('crecimiento constante: 1 GB al día', () => {
    const pts = [0, 5, 10, 20].map(d => ({ t: t0 + d * DAY, y: 100 * GB + d * GB }));
    const fit = fitTrend(pts)!;
    expect(fit.perDay / GB).toBeCloseTo(1, 6);
    expect(fit.days).toBe(20);
    expect(fit.at(t0 + 30 * DAY) / GB).toBeCloseTo(130, 6);
    expect(daysToFill(fit.perDay, 15 * GB)).toBeCloseTo(15, 6);
  });

  test('sin datos suficientes no hay estimación', () => {
    expect(fitTrend([{ t: t0, y: 1 }, { t: t0 + 9 * DAY, y: 2 }])).toBeNull();               // 2 puntos
    expect(fitTrend([0, 1, 2].map(h => ({ t: t0 + h * 3600, y: h })))).toBeNull();            // menos de 2 días
  });

  test('si se reduce no se llena nunca', () => {
    const fit = fitTrend([0, 3, 6].map(d => ({ t: t0 + d * DAY, y: (50 - d) * GB })))!;
    expect(fit.perDay).toBeLessThan(0);
    expect(daysToFill(fit.perDay, GB)).toBeNull();
  });

  test('usa sólo los puntos más recientes', () => {
    // Al principio creció 10 GB/día; en los 10 últimos puntos, 1 GB/día
    const pts = [...[0, 1, 2].map(d => ({ t: t0 + d * DAY, y: d * 10 * GB })), ...Array.from({ length: 10 }, (_, i) => ({ t: t0 + (10 + i) * DAY, y: (100 + i) * GB }))];
    expect(fitTrend(pts)!.perDay / GB).toBeCloseTo(1, 6);
  });

  test('marcas redondas del eje', () => {
    expect(niceTicks(0, 100)).toEqual([0, 50, 100]); // paso 25 → se redondea a 50
    const t = niceTicks(103, 187);
    expect(t[0]).toBeLessThanOrEqual(103);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(187);
    expect(t.every((v, i) => !i || v > t[i - 1])).toBe(true);
  });

  test('el gráfico tiene un punto con área de contacto por dato y la proyección si se pide', () => {
    const pts = [0, 5, 10].map(d => ({ t: t0 + d * DAY, y: (100 + d) * GB }));
    const svg = trendSVG(pts, { width: 400, height: 140, fmtY: v => (v / GB).toFixed(0), fmtX: () => 'x', fit: fitTrend(pts), until: t0 + 40 * DAY, label: 'estimación' });
    expect(svg.match(/class="thit"/g)!.length).toBe(3);
    expect(svg).toContain('class="tp"');
    expect(svg).toContain('estimación');
    expect(trendSVG(pts, { width: 200, height: 40, fmtY: String, fmtX: String, spark: true })).not.toContain('class="tl"');
  });
});
