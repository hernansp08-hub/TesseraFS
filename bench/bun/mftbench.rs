use std::time::Instant;
const NREC: usize = 262144; const TOTAL: usize = 1_500_000; const RS: usize = 1024;
fn w16(b: &mut [u8], o: usize, v: u16) { b[o..o+2].copy_from_slice(&v.to_le_bytes()); }
fn w32(b: &mut [u8], o: usize, v: u32) { b[o..o+4].copy_from_slice(&v.to_le_bytes()); }
fn w64(b: &mut [u8], o: usize, v: u64) { b[o..o+8].copy_from_slice(&v.to_le_bytes()); }
fn r16(b: &[u8], o: usize) -> u16 { u16::from_le_bytes([b[o], b[o+1]]) }
fn r32(b: &[u8], o: usize) -> u32 { u32::from_le_bytes(b[o..o+4].try_into().unwrap()) }
fn r64(b: &[u8], o: usize) -> u64 { u64::from_le_bytes(b[o..o+8].try_into().unwrap()) }
fn build() -> Vec<u8> {
    let mut buf = vec![0u8; NREC * RS];
    let names = ["document", "IMG_20240101_123456", "a", "node_modules", "readme", "System32", "x64-release-build-output"];
    for r in 0..NREC {
        let b = r * RS; buf[b..b+4].copy_from_slice(b"FILE");
        w16(&mut buf, b+4, 0x30); w16(&mut buf, b+6, 3); w16(&mut buf, b+0x14, 0x38); w16(&mut buf, b+0x16, if r % 5 == 0 {3} else {1}); w32(&mut buf, b+0x2c, r as u32);
        let usn = ((r & 0xffff) | 1) as u16; w16(&mut buf, b+0x30, usn);
        let mut a = b + 0x38;
        w32(&mut buf, a, 0x10); w32(&mut buf, a+4, 0x60); w32(&mut buf, a+0x10, 0x48); w16(&mut buf, a+0x14, 0x18); w64(&mut buf, a+0x20, 133500000000000000 + r as u64); a += 0x60;
        let nm = format!("{}{}.dat", names[r % names.len()], r % 97); let fnl = 0x42 + nm.len()*2; let al = (0x18 + fnl + 7) & !7;
        w32(&mut buf, a, 0x30); w32(&mut buf, a+4, al as u32); w32(&mut buf, a+0x10, fnl as u32); w16(&mut buf, a+0x14, 0x18);
        let c = a + 0x18; w32(&mut buf, c, ((r*7) % NREC) as u32); w16(&mut buf, c+6, 1); w64(&mut buf, c+0x28, (r*4096) as u64); w64(&mut buf, c+0x30, (r*1000) as u64);
        buf[c+0x40] = nm.len() as u8; buf[c+0x41] = 1; for (i, ch) in nm.bytes().enumerate() { w16(&mut buf, c+0x42+i*2, ch as u16); }
        a += al;
        w32(&mut buf, a, 0x80); w32(&mut buf, a+4, 0x48); buf[a+8] = 1; w64(&mut buf, a+0x28, (r*4096+4096) as u64); w64(&mut buf, a+0x30, (r*1234+77) as u64); a += 0x48;
        w32(&mut buf, a, 0xffffffff); w32(&mut buf, b+0x18, (a + 8 - b) as u32);
        for s in 1..=2 { let end = b + s*512 - 2; let v = r16(&buf, end); w16(&mut buf, b+0x30+s*2, v); w16(&mut buf, end, usn); }
    }
    buf
}
fn parse(buf: &[u8], decode: bool, parent: &mut [u64], size: &mut [u64], names: &mut Vec<String>) -> u64 {
    let mut chk = 0u64;
    for i in 0..TOTAL {
        let b = (i % NREC) * RS; let d = &buf[b..b+RS];
        if r32(d, 0) != 0x454c4946 { continue; }
        let uo = r16(d, 4) as usize; let uc = r16(d, 6) as usize; let usn = r16(d, uo);
        for s in 1..uc { if r16(d, s*512-2) != usn { break; } }
        if r16(d, 0x16) & 1 == 0 { continue; }
        let mut a = r16(d, 0x14) as usize;
        while a + 8 <= RS {
            let t = r32(d, a); if t == 0xffffffff { break; } let len = r32(d, a+4) as usize; if len == 0 { break; }
            if t == 0x30 { let c = a + r16(d, a+0x14) as usize; parent[i] = r32(d, c) as u64 | ((r16(d, c+4) as u64) << 32); let nl = d[c+0x40] as usize;
                if decode { let u: Vec<u16> = (0..nl).map(|k| r16(d, c+0x42+k*2)).collect(); names.push(String::from_utf16_lossy(&u)); } }
            else if t == 0x80 { size[i] = if d[a+8] == 1 { r64(d, a+0x30) } else { r32(d, a+0x10) as u64 }; }
            a += len;
        }
        chk = chk.wrapping_add(size[i]);
    }
    chk
}
fn main() {
    let buf = build(); let mut parent = vec![0u64; TOTAL]; let mut size = vec![0u64; TOTAL];
    for decode in [false, true] { for rep in 0..3 {
        let mut names = Vec::with_capacity(if decode {TOTAL} else {0});
        let t = Instant::now(); let c = parse(&buf, decode, &mut parent, &mut size, &mut names); let ms = t.elapsed().as_secs_f64()*1000.0;
        println!("Rust decodeNames={} run{}: {:.0} ms ({:.2} M rec/s) chk={} n={}", decode, rep, ms, TOTAL as f64 / ms / 1000.0, c % 1000, names.len());
    } }
}
