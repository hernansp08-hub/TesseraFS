// Synthetic MFT-record parsing benchmark: runs on both Bun and Node.
// Builds NREC 1 KiB FILE records (fixups, $STANDARD_INFORMATION, $FILE_NAME, $DATA non-resident),
// then parses TOTAL records (re-using the buffer) the way an MFT scanner would.
const rt = typeof Bun !== "undefined" ? "Bun " + Bun.version : "Node " + process.version;
const NREC = 262144; // 256 MiB buffer
const TOTAL = 1_500_000; // records to parse per pass (~1.43 GiB of record data)
const RS = 1024;

function build() {
  const buf = new Uint8Array(NREC * RS);
  const dv = new DataView(buf.buffer);
  const names = ["document", "IMG_20240101_123456", "a", "node_modules", "readme", "System32", "x64-release-build-output"];
  for (let r = 0; r < NREC; r++) {
    const b = r * RS;
    buf[b] = 0x46; buf[b + 1] = 0x49; buf[b + 2] = 0x4c; buf[b + 3] = 0x45; // FILE
    dv.setUint16(b + 4, 0x30, true); // USA offset
    dv.setUint16(b + 6, 3, true); // USA count (1 + 2 sectors)
    dv.setUint16(b + 0x14, 0x38, true); // first attribute offset
    dv.setUint16(b + 0x16, (r % 5 === 0 ? 3 : 1), true); // flags: in-use (+dir every 5th)
    dv.setUint32(b + 0x2c, r, true); // record number
    const usn = (r & 0xffff) | 1;
    dv.setUint16(b + 0x30, usn, true);
    let a = b + 0x38;
    // $STANDARD_INFORMATION resident, len 0x60
    dv.setUint32(a, 0x10, true); dv.setUint32(a + 4, 0x60, true); buf[a + 8] = 0; dv.setUint32(a + 0x10, 0x48, true); dv.setUint16(a + 0x14, 0x18, true);
    dv.setBigUint64(a + 0x18 + 8, BigInt(133500000000000000 + r), true); // modified time
    a += 0x60;
    // $FILE_NAME resident
    const nm = names[r % names.length] + (r % 97) + ".dat";
    const fnLen = 0x42 + nm.length * 2;
    const attrLen = (0x18 + fnLen + 7) & ~7;
    dv.setUint32(a, 0x30, true); dv.setUint32(a + 4, attrLen, true); buf[a + 8] = 0; dv.setUint32(a + 0x10, fnLen, true); dv.setUint16(a + 0x14, 0x18, true);
    const c = a + 0x18;
    dv.setUint32(c, (r * 7) % NREC, true); dv.setUint16(c + 4, 0, true); dv.setUint16(c + 6, 1, true); // parent ref (48-bit) + seq
    dv.setBigUint64(c + 0x28, BigInt(r * 4096), true); // alloc size
    dv.setBigUint64(c + 0x30, BigInt(r * 1000), true); // real size
    buf[c + 0x40] = nm.length; buf[c + 0x41] = 1; // name length, Win32 namespace
    for (let i = 0; i < nm.length; i++) dv.setUint16(c + 0x42 + i * 2, nm.charCodeAt(i), true);
    a += attrLen;
    // $DATA non-resident
    dv.setUint32(a, 0x80, true); dv.setUint32(a + 4, 0x48, true); buf[a + 8] = 1;
    dv.setBigUint64(a + 0x28, BigInt(r * 4096 + 4096), true); // allocated
    dv.setBigUint64(a + 0x30, BigInt(r * 1234 + 77), true); // real size
    a += 0x48;
    dv.setUint32(a, 0xffffffff, true); // end marker
    dv.setUint32(b + 0x18, a + 8 - b, true); // bytes in use
    // fixups: stash original sector-end bytes into USA, write USN at sector ends
    for (let s = 1; s <= 2; s++) {
      const end = b + s * 512 - 2;
      dv.setUint16(b + 0x30 + s * 2, dv.getUint16(end, true), true);
      dv.setUint16(end, usn, true);
    }
  }
  return buf;
}

const buf = build();
const dv = new DataView(buf.buffer);
const u8 = buf;
const td = new TextDecoder("utf-16le");

// Outputs (struct-of-arrays) as a real scanner would keep them
const parent = new Uint32Array(TOTAL);
const size = new Float64Array(TOTAL);
const isDir = new Uint8Array(TOTAL);
const nameOff = new Uint32Array(TOTAL);
const nameLen = new Uint8Array(TOTAL);

function parse(decodeNames, fixupCopy) {
  let names = decodeNames ? new Array(TOTAL) : null;
  let bad = 0, chk = 0;
  const scratch = new Uint8Array(RS);
  const sdv = new DataView(scratch.buffer);
  for (let i = 0; i < TOTAL; i++) {
    let b = (i % NREC) * RS;
    let d = dv, q = u8;
    if (fixupCopy) { scratch.set(u8.subarray(b, b + RS)); d = sdv; q = scratch; b = 0; }
    if (d.getUint32(b, true) !== 0x454c4946) { bad++; continue; }
    const usaOff = d.getUint16(b + 4, true), usaCnt = d.getUint16(b + 6, true);
    const usn = d.getUint16(b + usaOff, true);
    for (let s = 1; s < usaCnt; s++) {
      const end = b + s * 512 - 2;
      if (d.getUint16(end, true) !== usn) { bad++; break; }
      if (fixupCopy) d.setUint16(end, d.getUint16(b + usaOff + s * 2, true), true);
    }
    const flags = d.getUint16(b + 0x16, true);
    if (!(flags & 1)) continue;
    isDir[i] = (flags & 2) ? 1 : 0;
    let a = b + d.getUint16(b + 0x14, true);
    const lim = b + RS;
    while (a + 8 <= lim) {
      const type = d.getUint32(a, true);
      if (type === 0xffffffff) break;
      const len = d.getUint32(a + 4, true);
      if (len === 0) break;
      if (type === 0x30) {
        const c = a + d.getUint16(a + 0x14, true);
        parent[i] = d.getUint32(c, true) + d.getUint16(c + 4, true) * 4294967296;
        const nl = q[c + 0x40];
        nameLen[i] = nl; nameOff[i] = c + 0x42;
        if (decodeNames) names[i] = td.decode(q.subarray(c + 0x42, c + 0x42 + nl * 2));
      } else if (type === 0x80) {
        if (q[a + 8] === 1) size[i] = Number(d.getBigUint64(a + 0x30, true));
        else size[i] = d.getUint32(a + 0x10, true);
      }
      a += len;
    }
    chk += size[i];
  }
  return { bad, chk, n: names ? names.length : 0 };
}

console.log(rt, `records/pass=${TOTAL} (${(TOTAL * RS / 2 ** 30).toFixed(2)} GiB)`);
for (const [label, dec, fix] of [["no-names", false, false], ["no-names+fixup-copy", false, true], ["decode-names(TextDecoder)", true, false]]) {
  for (let rep = 0; rep < 3; rep++) {
    const t = performance.now();
    const r = parse(dec, fix);
    const dt = performance.now() - t;
    console.log(`${label} run${rep}: ${dt.toFixed(0)} ms  (${(TOTAL / dt / 1000).toFixed(2)} M rec/s, ${((TOTAL * RS) / 2 ** 20 / (dt / 1000)).toFixed(0)} MiB/s) bad=${r.bad}`);
  }
}
