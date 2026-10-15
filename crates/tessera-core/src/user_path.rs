//! La carpeta de la app en el `PATH` del usuario (sólo Windows). El instalador lanza
//! `tesserafs-desktop.exe --add-to-path` al instalar y `--remove-from-path` al desinstalar, para que
//! `tessera-cli` (la línea de comandos y el servidor MCP), que va en la misma carpeta, se pueda usar desde
//! cualquier terminal.
//!
//! Sólo se toca `HKCU\Environment\Path`, el del usuario (nunca el del sistema), y en él sólo la entrada de la
//! carpeta del ejecutable: las demás quedan tal cual y en el mismo orden. Se hace aquí y no en el instalador
//! porque NSIS corta las cadenas a 1024 caracteres y un `PATH` más largo quedaría truncado. El valor conserva
//! su tipo (`REG_EXPAND_SZ`, con las `%VARIABLES%` sin expandir) y se avisa a Windows (`WM_SETTINGCHANGE`)
//! para que las terminales que se abran después lo vean.

/// Argumento con el que el instalador añade la carpeta ([`add`]).
pub const ADD_ARG: &str = "--add-to-path";
/// Argumento con el que el desinstalador la quita ([`remove`]).
pub const REMOVE_ARG: &str = "--remove-from-path";

/// La misma carpeta: sin distinguir mayúsculas, con o sin barra final y con o sin comillas.
fn same_dir(entry: &str, dir: &str) -> bool {
    let norm = |s: &str| s.trim().trim_matches('"').trim_end_matches(['\\', '/']).to_lowercase();
    norm(entry) == norm(dir)
}

/// `path` (entradas separadas por `;`) con `dir` al final, o `None` si ya estaba. Si `path` acababa en `;`,
/// sigue acabando así.
pub fn with_dir(path: &str, dir: &str) -> Option<String> {
    if path.split(';').any(|e| same_dir(e, dir)) {
        return None;
    }
    Some(match path {
        "" => dir.to_string(),
        p if p.ends_with(';') => format!("{p}{dir};"),
        p => format!("{p};{dir}"),
    })
}

/// `path` sin las entradas de `dir`, o `None` si no estaba.
pub fn without_dir(path: &str, dir: &str) -> Option<String> {
    let entries: Vec<&str> = path.split(';').collect();
    let kept: Vec<&str> = entries.iter().copied().filter(|e| !same_dir(e, dir)).collect();
    (kept.len() < entries.len()).then(|| kept.join(";"))
}

/// Añade la carpeta de este ejecutable al `PATH` del usuario. `Ok(false)` si ya estaba.
#[cfg(windows)]
pub fn add() -> std::io::Result<bool> {
    change(with_dir)
}

/// Quita la carpeta de este ejecutable del `PATH` del usuario. `Ok(false)` si no estaba.
#[cfg(windows)]
pub fn remove() -> std::io::Result<bool> {
    change(without_dir)
}

#[cfg(windows)]
fn change(f: fn(&str, &str) -> Option<String>) -> std::io::Result<bool> {
    let exe = std::env::current_exe()?;
    let dir = exe.parent().and_then(|d| d.to_str()).filter(|d| !d.is_empty());
    let dir = dir.ok_or_else(|| std::io::Error::other("Executable folder not found"))?;
    let changed = imp::update("Environment", "Path", |p| f(p, dir))?;
    if changed {
        imp::broadcast();
    }
    Ok(changed)
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::ptr::{null, null_mut};

    use crate::walk::wide;
    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_MORE_DATA, ERROR_SUCCESS, WIN32_ERROR};
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE,
        REG_EXPAND_SZ, REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};

    struct Key(HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    fn check(r: WIN32_ERROR) -> io::Result<()> {
        if r == ERROR_SUCCESS {
            Ok(())
        } else {
            Err(io::Error::from_raw_os_error(r as i32))
        }
    }

    fn open(subkey: &str) -> io::Result<Key> {
        let sub = wide(subkey);
        let mut h: HKEY = null_mut();
        check(unsafe {
            RegCreateKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, null(), REG_OPTION_NON_VOLATILE, KEY_QUERY_VALUE | KEY_SET_VALUE, null(), &mut h, null_mut())
        })?;
        Ok(Key(h))
    }

    /// El texto del valor tal cual (sin expandir) y su tipo; vacío y `REG_EXPAND_SZ` si no existe. Si no es
    /// texto o no es UTF-16 válido, error: mejor no tocarlo.
    fn read(key: &Key, name: &[u16]) -> io::Result<(String, REG_VALUE_TYPE)> {
        let mut kind: REG_VALUE_TYPE = 0;
        let mut buf: Vec<u16> = Vec::new();
        loop {
            // Sin búfer, la primera llamada sólo da el tamaño; si el valor creció entre medias, ERROR_MORE_DATA
            let mut cb = (buf.len() * 2) as u32;
            let data = if buf.is_empty() { null_mut() } else { buf.as_mut_ptr().cast() };
            match unsafe { RegQueryValueExW(key.0, name.as_ptr(), null(), &mut kind, data, &mut cb) } {
                ERROR_FILE_NOT_FOUND => return Ok((String::new(), REG_EXPAND_SZ)),
                ERROR_SUCCESS if !buf.is_empty() || cb == 0 => {
                    buf.truncate(cb as usize / 2);
                    break;
                }
                ERROR_SUCCESS | ERROR_MORE_DATA => buf = vec![0; (cb as usize).div_ceil(2) + 1],
                e => check(e)?,
            }
        }
        if kind != REG_SZ && kind != REG_EXPAND_SZ {
            return Err(io::Error::other("The value isn't text"));
        }
        while buf.last() == Some(&0) {
            buf.pop();
        }
        let text = String::from_utf16(&buf).map_err(|_| io::Error::other("The value isn't valid UTF-16"))?;
        Ok((text, kind))
    }

    /// Escribe el valor con su tipo; si queda vacío, lo borra.
    fn write(key: &Key, name: &[u16], value: &str, kind: REG_VALUE_TYPE) -> io::Result<()> {
        if value.is_empty() {
            return check(unsafe { RegDeleteValueW(key.0, name.as_ptr()) });
        }
        let data = wide(value);
        check(unsafe { RegSetValueExW(key.0, name.as_ptr(), 0, kind, data.as_ptr().cast(), (data.len() * 2) as u32) })
    }

    /// Cambia el valor `name` de `HKCU\<subkey>` con `f`, que da `None` si no hay nada que cambiar.
    pub(super) fn update(subkey: &str, name: &str, f: impl FnOnce(&str) -> Option<String>) -> io::Result<bool> {
        let key = open(subkey)?;
        let name = wide(name);
        let (old, kind) = read(&key, &name)?;
        let Some(new) = f(&old) else { return Ok(false) };
        write(&key, &name, &new, kind)?;
        Ok(true)
    }

    /// Avisa a las ventanas (el Explorador, sobre todo) de que cambiaron las variables de entorno.
    pub(super) fn broadcast() {
        let env = wide("Environment");
        unsafe { SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, env.as_ptr() as isize, SMTO_ABORTIFHUNG, 5000, null_mut()) };
    }

    #[cfg(test)]
    pub(super) fn get(subkey: &str, name: &str) -> io::Result<(String, REG_VALUE_TYPE)> {
        read(&open(subkey)?, &wide(name))
    }

    #[cfg(test)]
    pub(super) fn delete_key(subkey: &str) {
        use windows_sys::Win32::System::Registry::RegDeleteKeyW;
        unsafe { RegDeleteKeyW(HKEY_CURRENT_USER, wide(subkey).as_ptr()) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DIR: &str = r"C:\Users\ana\AppData\Local\TesseraFS";

    #[test]
    fn adds_once_at_the_end() {
        assert_eq!(with_dir("", DIR).as_deref(), Some(DIR));
        assert_eq!(with_dir(r"%USERPROFILE%\bin", DIR).unwrap(), format!(r"%USERPROFILE%\bin;{DIR}"));
        assert_eq!(with_dir(r"C:\a;", DIR).unwrap(), format!(r"C:\a;{DIR};"));
        // Ya está, con otras mayúsculas, barra final o comillas: no cambia nada
        assert_eq!(with_dir(&format!(r"C:\a;{}\;C:\b", DIR.to_uppercase()), DIR), None);
        assert_eq!(with_dir(&format!("\"{DIR}\""), DIR), None);
    }

    #[test]
    fn removes_only_its_entry() {
        let path = format!(r"C:\a;{DIR};%LOCALAPPDATA%\TesseraFS;{DIR}\bin;;c:\users\ana\appdata\local\tesserafs\");
        assert_eq!(without_dir(&path, DIR).unwrap(), format!(r"C:\a;%LOCALAPPDATA%\TesseraFS;{DIR}\bin;"));
        assert_eq!(without_dir(r"C:\a;C:\b", DIR), None);
        assert_eq!(without_dir("", DIR), None);
        assert_eq!(without_dir(DIR, DIR).as_deref(), Some(""));
        // Instalar y desinstalar deja el PATH como estaba
        for p in ["", r"C:\a", r"C:\a;", r"%SystemRoot%\x;;C:\b"] {
            assert_eq!(without_dir(&with_dir(p, DIR).unwrap(), DIR).unwrap(), p);
        }
    }

    /// Con un valor de prueba en HKCU, no con el PATH real: más largo que el límite de NSIS y con `%VARIABLES%`.
    #[cfg(windows)]
    #[test]
    fn registry_keeps_type_and_long_values() {
        use windows_sys::Win32::System::Registry::REG_EXPAND_SZ;
        struct Cleanup(String);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                imp::delete_key(&self.0);
            }
        }
        let sub = Cleanup(format!(r"Software\TesseraFS-test-user-path-{}", std::process::id()));
        let long = (0..150).map(|i| format!(r"%USERPROFILE%\herramienta-{i:03}\bin")).collect::<Vec<_>>().join(";");
        assert!(long.len() > 4000);

        assert!(imp::update(&sub.0, "Path", |_| Some(long.clone())).unwrap());
        assert!(imp::update(&sub.0, "Path", |p| with_dir(p, DIR)).unwrap());
        assert!(!imp::update(&sub.0, "Path", |p| with_dir(p, DIR)).unwrap());
        assert_eq!(imp::get(&sub.0, "Path").unwrap(), (format!("{long};{DIR}"), REG_EXPAND_SZ));

        assert!(imp::update(&sub.0, "Path", |p| without_dir(p, DIR)).unwrap());
        assert!(!imp::update(&sub.0, "Path", |p| without_dir(p, DIR)).unwrap());
        assert_eq!(imp::get(&sub.0, "Path").unwrap(), (long.clone(), REG_EXPAND_SZ));

        // Si sólo quedaba la carpeta, el valor se borra (como antes de instalar)
        assert!(imp::update(&sub.0, "Solo", |p| with_dir(p, DIR)).unwrap());
        assert!(imp::update(&sub.0, "Solo", |p| without_dir(p, DIR)).unwrap());
        assert_eq!(imp::get(&sub.0, "Solo").unwrap(), (String::new(), REG_EXPAND_SZ));
    }
}
