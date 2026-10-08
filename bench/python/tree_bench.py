"""Memory and aggregation cost of a 1.5M-node file tree: Python objects vs numpy struct-of-arrays."""
import gc, sys, time, tracemalloc, random
import numpy as np

N = int(sys.argv[1]) if len(sys.argv) > 1 else 1_500_000
rng = np.random.default_rng(1)

# ---- synthetic tree in BFS/topological order: parent[i] < i ; ~12% directories
is_dir = rng.random(N) < 0.12
is_dir[0] = True
dir_idx = np.flatnonzero(is_dir)
parent = np.empty(N, dtype=np.int32); parent[0] = -1
# choose each node's parent among directories with smaller index (skewed toward recent ones)
pos = np.searchsorted(dir_idx, np.arange(N), side="left")  # number of dirs before i
pos[0] = 1
pick = (pos * rng.random(N) ** 0.3).astype(np.int64)
pick = np.minimum(pick, np.maximum(pos - 1, 0))
parent[1:] = dir_idx[pick[1:]]
size = np.where(is_dir, 0, rng.lognormal(9, 2.5, N)).astype(np.int64)
names = [f"file_{i:07d}_{'x' * (i % 23)}.bin" for i in range(N)]  # 15-37 chars

def mb(x): return f"{x/2**20:,.0f} MB"

# ---- (a) Python objects with __slots__
class Node:
    __slots__ = ("name", "parent", "size", "children", "is_dir")
    def __init__(self, name, parent, size, is_dir):
        self.name = name; self.parent = parent; self.size = size; self.is_dir = is_dir
        self.children = [] if is_dir else None

par_l = parent.tolist(); size_l = size.tolist(); dir_l = is_dir.tolist()
gc.collect(); tracemalloc.start()
t0 = time.perf_counter()
nodes = [None] * N
for i in range(N):
    p = par_l[i]
    nd = Node(names[i], nodes[p] if p >= 0 else None, size_l[i], dir_l[i])
    nodes[i] = nd
    if p >= 0:
        nodes[p].children.append(nd)
t_build = time.perf_counter() - t0
cur, peak = tracemalloc.get_traced_memory(); tracemalloc.stop()
print(f"[py __slots__ objects] build {t_build:.2f}s, traced mem {mb(cur)} (~{cur/N:.0f} B/node, names excluded: names pre-allocated)")
t0 = time.perf_counter()
for i in range(N - 1, 0, -1):
    nd = nodes[i]
    nd.parent.size += nd.size
t_agg = time.perf_counter() - t0
print(f"[py __slots__ objects] bottom-up size aggregation {t_agg:.2f}s; root={nodes[0].size:,}")
root_obj = nodes[0].size
del nodes; gc.collect()

# ---- (b) dict per node
gc.collect(); tracemalloc.start()
t0 = time.perf_counter()
dn = [None] * N
for i in range(N):
    p = par_l[i]
    d = {"name": names[i], "parent": p, "size": size_l[i], "is_dir": dir_l[i], "children": [] if dir_l[i] else None}
    dn[i] = d
    if p >= 0:
        dn[p]["children"].append(i)
t_build = time.perf_counter() - t0
cur, peak = tracemalloc.get_traced_memory(); tracemalloc.stop()
print(f"[py dict nodes]        build {t_build:.2f}s, traced mem {mb(cur)} (~{cur/N:.0f} B/node, names excluded)")
del dn; gc.collect()

# ---- names cost as Python str list vs packed blob
tracemalloc.start()
names2 = [f"file_{i:07d}_{'x' * (i % 23)}.bin" for i in range(N)]
cur, _ = tracemalloc.get_traced_memory(); tracemalloc.stop()
print(f"[names] list of {N:,} Python str: {mb(cur)} (~{cur/N:.0f} B/name)")
t0 = time.perf_counter()
enc = [s.encode("utf-8") for s in names2]
blob = b"".join(enc)
offs = np.zeros(N + 1, dtype=np.int64); offs[1:] = np.cumsum([len(e) for e in enc])
print(f"[names] packed UTF-8 blob + int64 offsets: {mb(len(blob) + offs.nbytes)} (~{(len(blob)+offs.nbytes)/N:.0f} B/name), pack time {time.perf_counter()-t0:.2f}s")
del names2, enc

# ---- (c) numpy struct-of-arrays
soa_bytes = parent.nbytes + size.nbytes + is_dir.nbytes
print(f"[numpy SoA] parent(int32)+size(int64)+flag(bool) = {mb(soa_bytes)} (~{soa_bytes/N:.0f} B/node, excl. names)")
# pure-Python loop over numpy-backed lists (common mistake) vs vectorised level-by-level
agg = size.copy()
t0 = time.perf_counter()
depth = np.zeros(N, dtype=np.int32)
# depth via repeated vectorised passes (parent[i] < i so iterate until stable)
for _ in range(64):
    nd_ = np.where(parent >= 0, depth[np.maximum(parent, 0)] + 1, 0)
    if np.array_equal(nd_, depth): break
    depth = nd_
t_depth = time.perf_counter() - t0
t0 = time.perf_counter()
maxd = int(depth.max())
order = np.argsort(depth, kind="stable")
bounds = np.searchsorted(depth[order], np.arange(maxd + 2))
for dlev in range(maxd, 0, -1):
    idx = order[bounds[dlev]:bounds[dlev + 1]]
    agg += np.bincount(parent[idx], weights=agg[idx], minlength=N).astype(np.int64)
t_np = time.perf_counter() - t0
print(f"[numpy SoA] depth calc {t_depth:.2f}s (maxdepth={maxd}); level-wise bincount aggregation {t_np:.3f}s; root={int(agg[0]):,} (match={int(agg[0])==root_obj}) [float64 weights: exact only < 2^53]")
# exact integer variant with np.add.at
agg2 = size.copy()
t0 = time.perf_counter()
for dlev in range(maxd, 0, -1):
    idx = order[bounds[dlev]:bounds[dlev + 1]]
    np.add.at(agg2, parent[idx], agg2[idx])
print(f"[numpy SoA] level-wise np.add.at (exact int64) {time.perf_counter()-t0:.3f}s; root match={int(agg2[0])==root_obj}")
# plain Python loop on Python lists
agg3 = size.tolist()
t0 = time.perf_counter()
for i in range(N - 1, 0, -1):
    agg3[par_l[i]] += agg3[i]
print(f"[python list loop] reverse-order aggregation {time.perf_counter()-t0:.2f}s; root match={agg3[0]==root_obj}")
# children grouping + sort-by-size for treemap (CSR)
t0 = time.perf_counter()
o = np.lexsort((-agg2[1:], parent[1:])) + 1
child_start = np.searchsorted(parent[o], np.arange(N + 1))
print(f"[numpy SoA] CSR children index sorted by size desc: {time.perf_counter()-t0:.2f}s")
