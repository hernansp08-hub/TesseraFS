import os, sys, time, threading, queue

ROOT = sys.argv[1] if len(sys.argv) > 1 else "C:\\"


def scan_dir(d, out_dirs):
    nf = nd = err = 0
    tot = 0
    try:
        with os.scandir(d) as it:
            for e in it:
                try:
                    if e.is_junction() or e.is_symlink():
                        nf += 1
                        continue
                    if e.is_dir(follow_symlinks=False):
                        nd += 1
                        out_dirs.append(e.path)
                    else:
                        nf += 1
                        tot += e.stat(follow_symlinks=False).st_size
                except OSError:
                    err += 1
    except OSError:
        err += 1
    return nf, nd, tot, err


def walk_serial(root):
    stack = [root]
    NF = ND = TOT = ERR = 0
    while stack:
        d = stack.pop()
        nf, nd, tot, err = scan_dir(d, stack)
        NF += nf; ND += nd; TOT += tot; ERR += err
    return NF, ND, TOT, ERR


def walk_threads(root, nthreads):
    q = queue.Queue()
    q.put(root)
    lock = threading.Lock()
    res = [0, 0, 0, 0]
    pending = [1]
    done = threading.Event()

    def worker():
        while True:
            d = q.get()
            if d is None:
                return
            sub = []
            nf, nd, tot, err = scan_dir(d, sub)
            with lock:
                res[0] += nf; res[1] += nd; res[2] += tot; res[3] += err
                pending[0] += len(sub) - 1
                if pending[0] == 0:
                    done.set()
            for s in sub:
                q.put(s)

    ts = [threading.Thread(target=worker, daemon=True) for _ in range(nthreads)]
    for t in ts:
        t.start()
    done.wait()
    for _ in ts:
        q.put(None)
    for t in ts:
        t.join()
    return tuple(res)


def report(label, t0, r):
    dt = time.perf_counter() - t0
    n = r[0] + r[1]
    print(f"{label:28s} entries={n:>9,} (files={r[0]:,} dirs={r[1]:,}) bytes={r[2]/1e9:.1f}GB err={r[3]:,} "
          f"time={dt:7.2f}s rate={n/dt:>10,.0f} entries/s", flush=True)


print(sys.version, "GIL enabled:", getattr(sys, "_is_gil_enabled", lambda: True)(), "root:", ROOT, flush=True)
t0 = time.perf_counter(); r = walk_serial(ROOT); report("serial pass1 (cold-ish)", t0, r)
t0 = time.perf_counter(); r = walk_serial(ROOT); report("serial pass2 (warm)", t0, r)
for n in (2, 4, 8, 16):
    t0 = time.perf_counter(); r = walk_threads(ROOT, n); report(f"threads={n} (warm, GIL)", t0, r)
