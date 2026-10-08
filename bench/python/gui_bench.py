"""Treemap rendering cost in PySide6 (offscreen QImage) + pure-Python squarified layout cost."""
import sys, time, random
import numpy as np
from PySide6.QtCore import QRectF, QRect, Qt, qVersion
from PySide6.QtGui import QImage, QPainter, QColor, QBrush, QPen, QGuiApplication
import PySide6

app = QGuiApplication(sys.argv[:1] + ["-platform", "offscreen"])
print("PySide6", PySide6.__version__, "Qt", qVersion(), flush=True)

# ---------- squarified treemap layout (Bruls et al.), pure Python ----------
def worst(row, w, total_row):
    s2 = total_row * total_row
    w2 = w * w
    return max(w2 * max(row) / s2, s2 / (w2 * min(row)))

def squarify(values, x, y, dx, dy, out):
    """values sorted desc, already normalised so sum(values) == dx*dy"""
    i = 0; n = len(values)
    while i < n:
        w = min(dx, dy)
        row = [values[i]]; srow = values[i]; i += 1
        while i < n:
            v = values[i]
            nrow_s = srow + v
            if worst(row + [v], w, nrow_s) <= worst(row, w, srow):
                row.append(v); srow = nrow_s; i += 1
            else:
                break
        # lay out row
        if dx >= dy:  # vertical strip on the left
            rw = srow / dy; yy = y
            for v in row:
                h = v / rw; out.append((x, yy, rw, h)); yy += h
            x += rw; dx -= rw
        else:
            rh = srow / dx; xx = x
            for v in row:
                ww = v / rh; out.append((xx, y, ww, rh)); xx += ww
            y += rh; dy -= rh
    return out

rng = np.random.default_rng(0)
W, H = 1920, 1080
for n in (10_000, 100_000, 1_000_000):
    vals = np.sort(rng.lognormal(9, 2.5, n))[::-1]
    vals = (vals * (W * H / vals.sum())).tolist()
    t0 = time.perf_counter(); rects = squarify(vals, 0.0, 0.0, float(W), float(H), []); dt = time.perf_counter() - t0
    print(f"squarify pure Python, flat list n={n:>9,}: {dt:.2f}s  ({len(rects):,} rects)", flush=True)

# visible-pixel culling: how many rects are >= 1px^2 at 1920x1080 for 1M lognormal items
big = sum(1 for r in rects if r[2] >= 1 and r[3] >= 1)
print(f"of 1M rects, {big:,} are >=1px in both dims at {W}x{H} (rest are sub-pixel)", flush=True)

# ---------- QPainter rendering ----------
img = QImage(W, H, QImage.Format_ARGB32_Premultiplied)
cols = [QColor.fromHsv(h, 180, 230) for h in range(0, 360, 10)]
for n in (10_000, 100_000, 1_000_000):
    sub = rects[:n]
    qr = [QRectF(*r) for r in sub]
    img.fill(Qt.white)
    p = QPainter(img); p.setPen(Qt.NoPen)
    t0 = time.perf_counter()
    for k, r in enumerate(qr):
        p.fillRect(r, cols[k % 36])
    p.end(); dt1 = time.perf_counter() - t0
    img.fill(Qt.white)
    p = QPainter(img); p.setPen(QPen(Qt.black, 0)); p.setBrush(QBrush(cols[3]))
    t0 = time.perf_counter()
    p.drawRects(qr)                     # single batched call
    p.end(); dt2 = time.perf_counter() - t0
    print(f"QPainter n={n:>9,}: per-rect fillRect loop from Python {dt1*1000:8.0f} ms | one drawRects(list) call {dt2*1000:8.0f} ms", flush=True)

# numpy -> QImage directly (rasterise integer rects into an RGBA buffer, vectorised per rect row would still loop);
# cheapest approach: draw into numpy via per-rect slicing for large rects only
arr = np.zeros((H, W), dtype=np.uint32)
t0 = time.perf_counter()
cnt = 0
for (x, y, w, h) in rects:
    if w >= 1 and h >= 1:
        xi, yi = int(x), int(y)
        arr[yi:yi + int(h), xi:xi + int(w)] = 0xFF000000 | (cnt * 2654435761 & 0xFFFFFF); cnt += 1
print(f"numpy slice-fill of {cnt:,} visible rects: {(time.perf_counter()-t0)*1000:.0f} ms", flush=True)
