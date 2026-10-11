//! Nombres de archivo. Windows usa UTF-16 que puede traer suplentes sueltos, así que el
//! almacén guarda WTF-8 (UTF-8 generalizado): se puede volver al UTF-16 exacto para las
//! acciones y se convierte a UTF-8 válido (con U+FFFD) para la interfaz.

use std::borrow::Cow;
use std::cmp::Ordering;

/// Añade `s` (UTF-16, quizá mal formado) a `out` en WTF-8.
pub fn push_utf16(out: &mut Vec<u8>, s: &[u16]) {
    if s.iter().all(|&c| c < 0x80) {
        out.extend(s.iter().map(|&c| c as u8));
        return;
    }
    let mut i = 0;
    while i < s.len() {
        let c = s[i] as u32;
        i += 1;
        let cp = if (0xD800..0xDC00).contains(&c) && i < s.len() && (0xDC00..0xE000).contains(&(s[i] as u32)) {
            let lo = s[i] as u32;
            i += 1;
            0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00)
        } else {
            c
        };
        push_cp(out, cp);
    }
}

fn push_cp(out: &mut Vec<u8>, cp: u32) {
    match cp {
        0..=0x7F => out.push(cp as u8),
        0x80..=0x7FF => out.extend_from_slice(&[0xC0 | (cp >> 6) as u8, 0x80 | (cp & 0x3F) as u8]),
        0x800..=0xFFFF => out.extend_from_slice(&[
            0xE0 | (cp >> 12) as u8,
            0x80 | ((cp >> 6) & 0x3F) as u8,
            0x80 | (cp & 0x3F) as u8,
        ]),
        _ => out.extend_from_slice(&[
            0xF0 | (cp >> 18) as u8,
            0x80 | ((cp >> 12) & 0x3F) as u8,
            0x80 | ((cp >> 6) & 0x3F) as u8,
            0x80 | (cp & 0x3F) as u8,
        ]),
    }
}

/// Recorre los puntos de código de un WTF-8 bien formado (lo produce `push_utf16`).
pub(crate) fn code_points(b: &[u8]) -> impl Iterator<Item = u32> + '_ {
    let mut i = 0;
    std::iter::from_fn(move || {
        if i >= b.len() {
            return None;
        }
        let c = b[i] as u32;
        let (cp, n) = if c < 0x80 {
            (c, 1)
        } else if c < 0xE0 {
            (((c & 0x1F) << 6) | (b.get(i + 1).copied().unwrap_or(0) as u32 & 0x3F), 2)
        } else if c < 0xF0 {
            let b1 = b.get(i + 1).copied().unwrap_or(0) as u32 & 0x3F;
            let b2 = b.get(i + 2).copied().unwrap_or(0) as u32 & 0x3F;
            (((c & 0x0F) << 12) | (b1 << 6) | b2, 3)
        } else {
            let b1 = b.get(i + 1).copied().unwrap_or(0) as u32 & 0x3F;
            let b2 = b.get(i + 2).copied().unwrap_or(0) as u32 & 0x3F;
            let b3 = b.get(i + 3).copied().unwrap_or(0) as u32 & 0x3F;
            (((c & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3, 4)
        };
        i += n;
        Some(cp)
    })
}

/// WTF-8 → UTF-16 exacto (para llamar a la API de Windows).
pub fn push_wide(out: &mut Vec<u16>, b: &[u8]) {
    for cp in code_points(b) {
        if cp >= 0x10000 {
            let v = cp - 0x10000;
            out.push(0xD800 + (v >> 10) as u16);
            out.push(0xDC00 + (v & 0x3FF) as u16);
        } else {
            out.push(cp as u16);
        }
    }
}

/// WTF-8 → UTF-8 válido; los suplentes sueltos pasan a U+FFFD (igual que `TextEncoder`).
pub fn lossy(b: &[u8]) -> Cow<'_, str> {
    match std::str::from_utf8(b) {
        Ok(s) => Cow::Borrowed(s),
        Err(_) => Cow::Owned(
            code_points(b)
                .map(|cp| char::from_u32(cp).unwrap_or('\u{FFFD}'))
                .collect(),
        ),
    }
}

/// Extensión de un nombre: lo que sigue al último punto, en minúsculas ("" si no hay punto).
pub fn ext_of(name: &[u8]) -> Cow<'_, str> {
    match memchr::memrchr(b'.', name) {
        None => Cow::Borrowed(""),
        Some(p) => {
            let e = &name[p + 1..];
            if e.iter().all(|c| c.is_ascii() && !c.is_ascii_uppercase()) {
                lossy(e)
            } else if e.is_ascii() {
                Cow::Owned(String::from_utf8(e.to_ascii_lowercase()).unwrap_or_default())
            } else {
                Cow::Owned(lossy(e).to_lowercase())
            }
        }
    }
}

/// Comparación sin distinguir mayúsculas (desempate estable por bytes).
pub fn cmp_ci(a: &[u8], b: &[u8]) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        let n = a.len().min(b.len());
        for i in 0..n {
            let (x, y) = (a[i].to_ascii_lowercase(), b[i].to_ascii_lowercase());
            if x != y {
                return x.cmp(&y);
            }
        }
        return a.len().cmp(&b.len()).then_with(|| a.cmp(b));
    }
    let (sa, sb) = (lossy(a), lossy(b));
    let ia = sa.chars().flat_map(char::to_lowercase);
    let ib = sb.chars().flat_map(char::to_lowercase);
    ia.cmp(ib).then_with(|| a.cmp(b))
}

/// Minúsculas como `String.prototype.toLowerCase` (ruta rápida para ASCII).
pub fn lower_into(out: &mut String, s: &str) {
    if s.is_ascii() {
        out.extend(s.bytes().map(|c| c.to_ascii_lowercase() as char));
    } else {
        out.push_str(&s.to_lowercase());
    }
}

/// Ruta POSIX (Linux): empieza por `/`, usa `/` como separador y distingue mayúsculas. Las de Windows
/// ("C:\\…", "\\\\srv\\…") usan `\\` y no las distinguen. Cada árbol, resumen o carpeta de exportación
/// sigue el estilo de su propia ruta, así que el mismo código sirve en las dos plataformas.
pub fn is_posix(path: &str) -> bool {
    path.starts_with('/')
}

/// Separador de las rutas del estilo de `path`: `/` o `\\`.
pub fn sep_of(path: &str) -> char {
    if is_posix(path) {
        '/'
    } else {
        '\\'
    }
}

/// Clave para comparar rutas del estilo de `path`: en minúsculas en Windows, tal cual en Linux.
pub fn path_key(path: &str) -> Cow<'_, str> {
    if is_posix(path) {
        Cow::Borrowed(path)
    } else {
        let mut o = String::with_capacity(path.len());
        lower_into(&mut o, path);
        Cow::Owned(o)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_lone_surrogate() {
        let w: Vec<u16> = vec![0x61, 0xD800, 0x62, 0xD83D, 0xDE00];
        let mut b = Vec::new();
        push_utf16(&mut b, &w);
        let mut back = Vec::new();
        push_wide(&mut back, &b);
        assert_eq!(back, w);
        assert_eq!(lossy(&b), "a\u{FFFD}b😀");
    }

    #[test]
    fn ext_rules() {
        assert_eq!(ext_of(b"a.TXT"), "txt");
        assert_eq!(ext_of(b"archive.tar.gz"), "gz");
        assert_eq!(ext_of(b"README"), "");
        assert_eq!(ext_of(b".gitignore"), "gitignore");
        assert_eq!(ext_of("FOTO.ÑÁ".as_bytes()), "ñá");
    }

    #[test]
    fn ci_order() {
        assert_eq!(cmp_ci(b"abc", b"ABD"), Ordering::Less);
        assert_eq!(cmp_ci(b"B", b"a"), Ordering::Greater);
        assert_eq!(cmp_ci("Ñu".as_bytes(), "ña".as_bytes()), Ordering::Greater);
    }

    #[test]
    fn path_styles() {
        assert_eq!((sep_of("C:\\"), sep_of("\\\\srv\\x"), sep_of("/"), sep_of("/home/Ana")), ('\\', '\\', '/', '/'));
        assert_eq!(path_key("C:\\Users\\Ña"), "c:\\users\\ña");
        assert_eq!(path_key("/home/Ana"), "/home/Ana");
        assert!(is_posix("/") && !is_posix("C:\\") && !is_posix(""));
    }
}
