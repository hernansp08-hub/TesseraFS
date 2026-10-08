
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const rt = typeof Bun !== "undefined" ? "Bun " + Bun.version : "Node " + process.version;
const NREC = 262144, TOTAL = 1_500_000, RS = 1024;
function build() {
  const buf = new Uint8Array(new SharedArrayBuffer(NREC * RS));
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


function parseRange(u8, start, end, decode) {
  const dv = new DataView(u8.buffer); const td = new TextDecoder("utf-16le");
  let chk = 0, names = decode ? [] : null;
  for (let i = start; i < end; i++) {
    const b = (i % NREC) * RS;
    if (dv.getUint32(b, true) !== 0x454c4946) continue;
    const usaOff = dv.getUint16(b + 4, true), usaCnt = dv.getUint16(b + 6, true), usn = dv.getUint16(b + usaOff, true);
    for (let s = 1; s < usaCnt; s++) if (dv.getUint16(b + s * 512 - 2, true) !== usn) break;
    if (!(dv.getUint16(b + 0x16, true) & 1)) continue;
    let a = b + dv.getUint16(b + 0x14, true); const lim = b + RS;
    while (a + 8 <= lim) {
      const type = dv.getUint32(a, true); if (type === 0xffffffff) break;
      const len = dv.getUint32(a + 4, true); if (!len) break;
      if (type === 0x30) { const c = a + dv.getUint16(a + 0x14, true); chk += dv.getUint32(c, true); const nl = u8[c + 0x40]; if (decode) names.push(td.decode(u8.subarray(c + 0x42, c + 0x42 + nl * 2))); }
      else if (type === 0x80 && u8[a + 8] === 1) chk += Number(dv.getBigUint64(a + 0x30, true));
      a += len;
    }
  }
  return chk;
}
if (isMainThread) {
  (async () => {
    const buf = build();
    for (const W of [1, 4, 8]) {
      const workers = [];
      for (let w = 0; w < W; w++) workers.push(new Worker(__filename, { workerData: { sab: buf.buffer } }));
      await Promise.all(workers.map(w => new Promise(r => w.once("message", r)))); // ready
      for (const decode of [false, true]) {
        const best = [];
        for (let rep = 0; rep < 3; rep++) {
          const t = performance.now();
          await Promise.all(workers.map((w, k) => new Promise(r => { w.once("message", r); const per = Math.ceil(TOTAL / W); w.postMessage({ start: k * per, end: Math.min(TOTAL, (k + 1) * per), decode }); })));
          best.push(performance.now() - t);
        }
        console.log(`${rt} workers=${W} decodeNames=${decode}: best ${Math.min(...best).toFixed(0)} ms (runs ${best.map(x => x.toFixed(0)).join("/")})`);
      }
      for (const w of workers) await w.terminate();
    }
  })();
} else {
  const u8 = new Uint8Array(workerData.sab);
  parentPort.postMessage("ready");
  parentPort.on("message", m => parentPort.postMessage(parseRange(u8, m.start, m.end, m.decode)));
}
