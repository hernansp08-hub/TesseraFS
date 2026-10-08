"""Pure-Python NTFS FILE-record parsing microbenchmark on synthetic, structurally valid 1 KiB records.
Mimics what an MFT-based disk-usage scanner must extract per record: in-use flag, dir flag, parent FRN,
long file name (Win32 namespace), $DATA real/allocated size.  Applies update-sequence fixups."""
import os, random, struct, sys, time
from multiprocessing import Pool

REC = 1024
N = int(sys.argv[1]) if len(sys.argv) > 1 else 100_000

def build_record(idx, rnd):
    is_dir = rnd.random() < 0.12
    name = "".join(rnd.choice("abcdefghijklmnopqrstuvwxyz0123456789_ ") for _ in range(rnd.randint(5, 40))) + ".dat"
    b = bytearray(REC)
    usn = rnd.randint(1, 0xFFFE)
    # $STANDARD_INFORMATION (resident, 72 byte value)
    si_val = struct.pack("<4QI", 1, 2, 3, 4, 0x20) + bytes(36)
    si = struct.pack("<IIBBHHHIHBB", 0x10, 24 + 72, 0, 0, 0, 0, 0, 72, 24, 0, 0) + si_val
    # $FILE_NAME (resident)
    nm = name.encode("utf-16-le")
    fn_val = struct.pack("<Q4QQQIIBB", (5 << 48) | rnd.randint(5, 900_000), 1, 2, 3, 4, 4096, 1234, 0x20, 0, len(name), 1) + nm
    fn_len = (24 + len(fn_val) + 7) & ~7
    fn = struct.pack("<IIBBHHHIHBB", 0x30, fn_len, 0, 0, 0, 0, 1, len(fn_val), 24, 1, 0) + fn_val
    fn += bytes(fn_len - len(fn))
    attrs = si + fn
    if not is_dir:
        real = rnd.randint(0, 50_000_000)
        alloc = (real + 4095) & ~4095
        runlist = bytes([0x31, 0x10, 0x00, 0x10, 0x20, 0x00])  # tiny fake run list
        da_len = (64 + len(runlist) + 7) & ~7
        da = struct.pack("<IIBBHHHQQHHIQQQ", 0x80, da_len, 1, 0, 0, 0, 2, 0, alloc // 4096, 64, 0, 0, alloc, real, real) + runlist
        da += bytes(da_len - len(da))
        attrs += da
    attrs += struct.pack("<II", 0xFFFFFFFF, 0)
    flags = 0x01 | (0x02 if is_dir else 0)
    hdr = struct.pack("<4sHHQHHHHIIQHHI", b"FILE", 0x30, 3, 0, 1, 1, 0x38, flags, 0x38 + len(attrs), REC, 0, 3, 0, idx)
    b[0:len(hdr)] = hdr
    b[0x38:0x38 + len(attrs)] = attrs
    # update sequence array: save sector tails, write USN into them
    tails = b[510:512] + b[1022:1024]
    b[0x30:0x36] = struct.pack("<H", usn) + tails
    b[510:512] = struct.pack("<H", usn)
    b[1022:1024] = struct.pack("<H", usn)
    return bytes(b)

HDR = struct.Struct("<4sHH8xHHHHII")  # sig, usa_ofs, usa_cnt, seq, links, attr_ofs, flags, used, alloc
AH = struct.Struct("<IIBBH")          # type, length, nonres, name_len, name_off
U16 = struct.Struct("<H"); U32 = struct.Struct("<I"); Q = struct.Struct("<Q")
RES = struct.Struct("<IH")            # value length, value offset (at +0x10)
NRSZ = struct.Struct("<QQ")           # allocated, real (at +0x28)

def parse_buffer(buf):
    parents = []; names = []; sizes = []; allocs = []; dirs = []
    mv = memoryview(buf)
    for off in range(0, len(buf), REC):
        rec = bytearray(mv[off:off + REC])
        sig, usa_ofs, usa_cnt, seq, links, aofs, flags, used, alloc_ = HDR.unpack_from(rec, 0)
        if sig != b"FILE" or not (flags & 1):
            continue
        usn = rec[usa_ofs:usa_ofs + 2]
        for i in range(1, usa_cnt):
            end = i * 512
            if rec[end - 2:end] != usn:
                break
            rec[end - 2:end] = rec[usa_ofs + 2 * i:usa_ofs + 2 * i + 2]
        parent = None; name = None; size = 0; asz = 0
        p = aofs
        while p < used:
            atype, alen, nonres, nlen, noff = AH.unpack_from(rec, p)
            if atype == 0xFFFFFFFF or alen == 0:
                break
            if atype == 0x30 and not nonres:
                vlen, voff = RES.unpack_from(rec, p + 0x10)
                v = p + voff
                ns = rec[v + 65]
                if ns != 2 or name is None:   # skip DOS 8.3 name when a long name exists
                    parent = Q.unpack_from(rec, v)[0] & 0xFFFFFFFFFFFF
                    name = rec[v + 66:v + 66 + 2 * rec[v + 64]].decode("utf-16-le")
            elif atype == 0x80 and nlen == 0:
                if nonres:
                    asz, size = NRSZ.unpack_from(rec, p + 0x28)
                else:
                    size = RES.unpack_from(rec, p + 0x10)[0]; asz = size
            p += alen
        parents.append(parent); names.append(name); sizes.append(size); allocs.append(asz); dirs.append(flags & 2)
    return parents, names, sizes, allocs, dirs

def parse_chunk(args):
    buf = args
    r = parse_buffer(buf)
    return len(r[0]), r

if __name__ == "__main__":
    rnd = random.Random(42)
    t0 = time.perf_counter()
    buf = b"".join(build_record(i, rnd) for i in range(N))
    print(f"built {N:,} synthetic records ({len(buf)/1e6:.0f} MB) in {time.perf_counter()-t0:.1f}s", flush=True)
    # sanity
    p, n, s, a, d = parse_buffer(buf[:REC * 3]); print("sample:", list(zip(p, n, s, d)), flush=True)
    for rep in range(2):
        t0 = time.perf_counter(); r = parse_buffer(buf); dt = time.perf_counter() - t0
        print(f"single-process pure Python: {N:,} recs in {dt:.2f}s -> {N/dt:,.0f} rec/s; extrapolated 1.5M = {1.5e6/(N/dt):.1f}s", flush=True)
    chunk = REC * 10_000
    chunks = [buf[i:i + chunk] for i in range(0, len(buf), chunk)]
    for procs in (4, 8, 16):
        t0 = time.perf_counter()
        with Pool(procs) as pool:
            out = pool.map(parse_chunk, chunks)
        dt = time.perf_counter() - t0
        tot = sum(o[0] for o in out)
        print(f"multiprocessing Pool({procs}) incl. spawn+pickle: {tot:,} recs in {dt:.2f}s -> {tot/dt:,.0f} rec/s; 1.5M ~ {1.5e6/(tot/dt):.1f}s", flush=True)
