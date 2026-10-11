//! Exportación de archivos (CSV, JSON, informes…) a Descargas\TesseraFS (en Linux, la carpeta de
//! descargas de XDG + `/TesseraFS`), o a `TESSERA_EXPORT_DIR`.

use std::borrow::Cow;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use base64::Engine as _;

use crate::msg;
use crate::names;
use crate::sys;
use crate::types::{ActionResult, EngineMessage, ExportResult};

/// Longitud máxima del nombre (en unidades UTF-16, como `String.length`).
pub const MAX_NAME: usize = 200;

/// `TESSERA_EXPORT_DIR` si está definida; si no, la carpeta de Descargas del usuario + `TesseraFS`.
pub fn export_dir() -> Result<PathBuf, EngineMessage> {
    let dir = match std::env::var_os("TESSERA_EXPORT_DIR").filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => sys::downloads_dir().ok_or_else(|| msg::export_failed("Downloads folder not found"))?.join("TesseraFS"),
    };
    std::path::absolute(&dir).map_err(|e| msg::export_failed(&sys::io_error_text(&e)))
}

/// Nombre de dispositivo de Windows, con o sin extensión (`nul`, `CON.csv`, `com1.txt`…).
fn is_device(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_lowercase();
    let numbered = |p: &str| stem.strip_prefix(p).is_some_and(|n| matches!(n, "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"));
    matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") || numbered("com") || numbered("lpt")
}

/// Nombre de archivo sin rutas: no vacío, hasta [`MAX_NAME`], sin `\ / : * ? " < > |` ni
/// caracteres de control, distinto de `.` y `..`. Como en el motor Bun, tampoco se admiten nombres
/// de dispositivo ni terminados en punto o espacio (Windows los retoca).
pub fn valid_name(name: &str) -> bool {
    let len = name.encode_utf16().count();
    (1..=MAX_NAME).contains(&len)
        && name != "."
        && name != ".."
        && !name.ends_with(['.', ' '])
        && !is_device(name)
        && !name.chars().any(|c| c < ' ' || c == '\u{7f}' || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

/// Base64 estándar con o sin relleno.
const B64: base64::engine::GeneralPurpose = base64::engine::GeneralPurpose::new(
    &base64::alphabet::STANDARD,
    base64::engine::GeneralPurposeConfig::new()
        .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

/// `informe.csv` → (`informe`, `.csv`); sin punto (o sólo al principio) no hay extensión.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(p) if p > 0 => name.split_at(p),
        _ => (name, ""),
    }
}

/// Guarda `data` (texto, o base64 si `base64`) en la carpeta de exportación. Si el nombre ya existe,
/// añade ` (2)`, ` (3)`… antes de la extensión.
pub fn export_file(name: &str, data: &str, base64: bool) -> Result<ExportResult, EngineMessage> {
    if !valid_name(name) {
        return Err(msg::export_invalid_name(name));
    }
    let bytes: Cow<[u8]> = if base64 {
        let clean: String = data.chars().filter(|c| !c.is_ascii_whitespace()).collect();
        let b = B64.decode(clean).map_err(|e| msg::export_failed(&format!("Invalid base64 data: {e}")))?;
        Cow::Owned(b)
    } else {
        Cow::Borrowed(data.as_bytes())
    };
    let fail = |e: io::Error| msg::export_failed(&sys::io_error_text(&e));
    let dir = export_dir()?;
    fs::create_dir_all(&dir).map_err(fail)?;
    let (stem, ext) = split_ext(name);
    for n in 1..=10_000u32 {
        let path = dir.join(if n == 1 { name.to_string() } else { format!("{stem} ({n}){ext}") });
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                if let Err(e) = f.write_all(&bytes).and_then(|()| f.flush()) {
                    drop(f);
                    let _ = fs::remove_file(&path);
                    return Err(fail(e));
                }
                return Ok(ExportResult { path: path.to_string_lossy().into_owned() });
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(fail(e)),
        }
    }
    Err(msg::export_failed("Too many files with the same name"))
}

/// `path` está dentro de `dir` (con separador; en Windows sin distinguir mayúsculas, en Linux
/// distinguiéndolas) y no lleva `..` (que `std::path::absolute` deja en las rutas `\\?\` y en las de Linux).
fn inside(dir: &Path, path: &Path) -> bool {
    let (dir, path) = (dir.to_string_lossy(), path.to_string_lossy());
    if path.split(['\\', '/']).any(|c| c == "..") {
        return false;
    }
    if names::is_posix(&dir) {
        let d = dir.trim_end_matches('/');
        return path.strip_prefix(d).is_some_and(|rest| rest.len() > 1 && rest.starts_with('/'));
    }
    let (mut d, mut p) = (String::new(), String::new());
    names::lower_into(&mut d, &dir);
    names::lower_into(&mut p, &path);
    let d = d.replace('/', "\\");
    let d = d.trim_end_matches('\\');
    p.replace('/', "\\").strip_prefix(d).is_some_and(|rest| rest.len() > 1 && rest.starts_with('\\'))
}

/// Abre el Explorador con un archivo exportado seleccionado (como la acción `reveal`). Sólo para
/// archivos que existen dentro de la carpeta de exportación; si no, `export.notFound`.
pub fn reveal_export(path: &str) -> Result<ActionResult, EngineMessage> {
    let not_found = || msg::export_not_found(path);
    let dir = export_dir().map_err(|_| not_found())?;
    let raw = Path::new(path);
    if path.trim().is_empty() || path.contains('\0') || !raw.is_absolute() {
        return Err(not_found());
    }
    // Resuelve `.` y `..` antes de comprobar que está dentro
    let abs = std::path::absolute(raw).map_err(|_| not_found())?;
    if !inside(&dir, &abs) || !abs.is_file() {
        return Err(not_found());
    }
    #[cfg(windows)]
    let target: Vec<u16> = abs.to_string_lossy().encode_utf16().collect();
    #[cfg(not(windows))]
    let target = abs;
    Ok(match sys::reveal(&target) {
        Ok(()) => ActionResult::done(),
        Err(e) => ActionResult::fail(e),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_paths() {
        assert!(valid_name("informe.csv"));
        assert!(valid_name("árbol 😀.json"));
        assert!(valid_name(&"a".repeat(200)));
        assert!(!valid_name(&"a".repeat(201)));
        // 100 emojis = 200 unidades UTF-16; 101 = 202
        assert!(valid_name(&"😀".repeat(100)));
        assert!(!valid_name(&"😀".repeat(101)));
        for bad in ["", ".", "..", "a/b", "a\\b", "c:x", "a*", "a?", "a\"b", "<a>", "a|b", "a\nb", "a\u{7}", "a\u{7f}", "a.", "a ", "NUL", "con.csv", "Com1.txt", "lpt³", "aux.tar.gz"] {
            assert!(!valid_name(bad), "{bad:?}");
        }
        for good in ["a\u{85}b", "console.csv", "com10.txt", "lpt.txt", ".csv", "nul-1.csv"] {
            assert!(valid_name(good), "{good:?}");
        }
        assert_eq!(split_ext("informe.csv"), ("informe", ".csv"));
        assert_eq!(split_ext("a.tar.gz"), ("a.tar", ".gz"));
        assert_eq!(split_ext(".gitignore"), (".gitignore", ""));
        assert_eq!(split_ext("README"), ("README", ""));
        let dir = Path::new(r"C:\Users\x\Downloads\TesseraFS");
        assert!(inside(dir, Path::new(r"c:\users\X\downloads\tesserafs\a.csv")));
        assert!(inside(dir, Path::new(r"C:\Users\x\Downloads\TesseraFS\sub\a.csv")));
        assert!(!inside(dir, Path::new(r"C:\Users\x\Downloads\TesseraFS")));
        assert!(!inside(dir, Path::new(r"C:\Users\x\Downloads\TesseraFS\")));
        assert!(!inside(dir, Path::new(r"C:\Users\x\Downloads\TesseraFS2\a.csv")));
        assert!(!inside(dir, Path::new(r"C:\Users\x\Downloads\TesseraFS\..\a.csv")));
        assert!(!inside(dir, Path::new(r"C:\Windows\notepad.exe")));
        // Linux: distingue mayúsculas y sólo `/` separa
        let dir = Path::new("/home/ana/Descargas/TesseraFS");
        assert!(inside(dir, Path::new("/home/ana/Descargas/TesseraFS/a.csv")));
        assert!(inside(dir, Path::new("/home/ana/Descargas/TesseraFS/sub/a.csv")));
        assert!(inside(Path::new("/home/ana/Descargas/TesseraFS/"), Path::new("/home/ana/Descargas/TesseraFS/a.csv")));
        assert!(!inside(dir, Path::new("/home/ana/descargas/tesserafs/a.csv")));
        assert!(!inside(dir, Path::new("/home/ana/Descargas/TesseraFS")));
        assert!(!inside(dir, Path::new("/home/ana/Descargas/TesseraFS/")));
        assert!(!inside(dir, Path::new("/home/ana/Descargas/TesseraFS2/a.csv")));
        assert!(!inside(dir, Path::new("/home/ana/Descargas/TesseraFS/../a.csv")));
        assert!(!inside(dir, Path::new("/etc/passwd")));
    }
}
