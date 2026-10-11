//! Carpeta pedida al abrir la app (`SystemInfo.launchPath`): «Analizar con TesseraFS» del menú del
//! Explorador lanza `tesserafs-desktop.exe "C:\carpeta"` (o `"C:\"` para una unidad); en Linux,
//! `tesserafs-desktop /ruta`. La interfaz la escanea al arrancar en vez de mostrar las unidades.

use std::ffi::OsStr;

/// Quita las comillas sueltas de un argumento. En Windows, `"C:\"` llega como `C:"` (la barra invertida
/// escapa la comilla) y `"C:\dir\" --x` como un único `C:\dir" --x`: se queda lo que hay antes de la
/// primera comilla (las rutas de Windows no pueden llevarlas). En el resto, sólo las de los extremos.
fn strip_quotes(arg: &str, windows: bool) -> &str {
    let s = arg.trim();
    if windows {
        let s = s.trim_start_matches('"');
        s.split('"').next().unwrap_or_default().trim()
    } else {
        s.trim_matches('"').trim()
    }
}

/// El primer argumento posicional (no empieza por `-`), normalizado como la ruta de un escaneo
/// ([`crate::scan::normalize_path`]: absoluta, `C:` → `C:\`, sin barra final salvo en la raíz).
/// No mira el disco; `None` si no hay ninguno o no es una ruta.
pub fn launch_arg<S: AsRef<OsStr>>(args: impl IntoIterator<Item = S>) -> Option<String> {
    let arg = args.into_iter().find(|a| !a.as_ref().to_string_lossy().trim_start().starts_with('-'))?;
    // Una ruta que no es Unicode válido (Linux) no se puede escanear con su nombre exacto: se ignora
    let s = strip_quotes(arg.as_ref().to_str()?, cfg!(windows));
    if s.is_empty() {
        return None;
    }
    crate::scan::normalize_path(s).ok()
}

/// [`launch_arg`] si existe y es una carpeta (o una unidad); si no, se ignora.
pub fn launch_path<S: AsRef<OsStr>>(args: impl IntoIterator<Item = S>) -> Option<String> {
    launch_arg(args).filter(|p| std::fs::metadata(p).is_ok_and(|m| m.is_dir()))
}

/// Un argumento entre comillas para la línea de órdenes de Windows (reglas de `CommandLineToArgvW`):
/// las barras invertidas antes de una comilla o del final se duplican, así `C:\` llega entero.
pub fn quote_arg(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    let mut slashes = 0;
    for c in s.chars() {
        match c {
            '\\' => slashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', slashes * 2 + 1));
                out.push('"');
                slashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', slashes));
                out.push(c);
                slashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', slashes * 2));
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stray_quotes() {
        assert_eq!(strip_quotes(r#"C:""#, true), "C:");
        assert_eq!(strip_quotes(r#" "C:\Program Files\" --debug"#, true), r"C:\Program Files\");
        assert_eq!(strip_quotes(r#"C:\Program Files" --debug"#, true), r"C:\Program Files");
        assert_eq!(strip_quotes(r#""D:\datos""#, true), r"D:\datos");
        assert_eq!(strip_quotes(r#"""#, true), "");
        assert_eq!(strip_quotes(r#""/srv/Mis datos/""#, false), "/srv/Mis datos/");
        assert_eq!(strip_quotes(r#"/home/a"b"#, false), r#"/home/a"b"#);
    }

    #[test]
    fn quoting() {
        assert_eq!(quote_arg(r"C:\"), r#""C:\\""#);
        assert_eq!(quote_arg(r"C:\Program Files"), r#""C:\Program Files""#);
        assert_eq!(quote_arg(r"\\srv\share\"), r#""\\srv\share\\""#);
        assert_eq!(quote_arg(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote_arg(""), r#""""#);
    }

    #[test]
    fn no_positional() {
        assert_eq!(launch_arg(Vec::<String>::new()), None);
        assert_eq!(launch_arg(["--debug", "-x"]), None);
        assert_eq!(launch_arg(["", "/tmp"]), None, "sólo cuenta el primer posicional");
        assert_eq!(launch_arg(["  "]), None);
        assert_eq!(launch_arg([r#"""#]), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_args() {
        assert_eq!(launch_arg([r#"C:""#]).as_deref(), Some(r"C:\"), "\"C:\\\" llega como C:\"");
        assert_eq!(launch_arg(["c:"]).as_deref(), Some(r"C:\"));
        assert_eq!(launch_arg(["d:\\"]).as_deref(), Some(r"D:\"));
        assert_eq!(launch_arg([r"C:\carpeta\"]).as_deref(), Some(r"C:\carpeta"));
        assert_eq!(launch_arg([r#"C:\Program Files" --debug"#]).as_deref(), Some(r"C:\Program Files"));
        assert_eq!(launch_arg(["--flag", "C:/Users/Ana/"]).as_deref(), Some(r"C:\Users\Ana"));
        assert_eq!(launch_arg([r"\\srv\share\x\"]).as_deref(), Some(r"\\srv\share\x"));
        // Relativa: respecto a la carpeta actual
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(launch_arg(["."]).as_deref(), Some(cwd.to_str().unwrap()));
        assert!(launch_path([r"C:\"]).is_some());
        assert!(launch_path([r#"C:""#]).is_some());
    }

    #[cfg(not(windows))]
    #[test]
    fn posix_args() {
        assert_eq!(launch_arg(["/"]).as_deref(), Some("/"));
        assert_eq!(launch_arg(["/home/ana/"]).as_deref(), Some("/home/ana"));
        assert_eq!(launch_arg(["--x", "\"/srv/Mis datos/\""]).as_deref(), Some("/srv/Mis datos"));
        assert_eq!(launch_arg(["/a/./b//c/.."]).as_deref(), Some("/a/b"));
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(launch_arg(["."]).as_deref(), Some(cwd.to_str().unwrap()));
        assert!(launch_path(["/"]).is_some());
    }

    #[test]
    fn only_existing_folders() {
        let base = std::env::temp_dir().join(format!("tessera-launch-{}", std::process::id()));
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("archivo.txt");
        std::fs::write(&file, b"x").unwrap();
        let dir = base.to_str().unwrap().to_string();
        assert_eq!(launch_path([format!("{dir}{}", std::path::MAIN_SEPARATOR)]).as_deref(), Some(dir.as_str()));
        assert_eq!(launch_path([file.to_str().unwrap()]), None, "un archivo no");
        assert_eq!(launch_path([base.join("no-existe").to_str().unwrap()]), None);
        let _ = std::fs::remove_dir_all(&base);
    }
}
