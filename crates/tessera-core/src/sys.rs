//! Integración con Windows: unidades, elevación y acciones de archivo.

use crate::msg;
use crate::types::{ElevationInfo, EngineMessage, VolumeInfo};

/// Texto del último error de Windows (sin el sufijo «(os error N)»).
pub fn last_error_text() -> String {
    io_error_text(&std::io::Error::last_os_error())
}

/// Texto de un código de error de Windows (Win32 o HRESULT).
pub fn error_text(code: i32) -> String {
    io_error_text(&std::io::Error::from_raw_os_error(code))
}

/// Texto de un error de E/S tal como lo da el sistema (FormatMessage, en el idioma de Windows).
pub fn io_error_text(e: &std::io::Error) -> String {
    let s = e.to_string();
    match s.rfind(" (os error") {
        Some(p) => s[..p].trim().to_string(),
        None => s,
    }
}

/// ERROR_CANCELLED, su HRESULT y COPYENGINE_E_USER_CANCELLED: el usuario canceló.
fn is_cancel(code: i32) -> bool {
    matches!(code as u32, 1223 | 0x8007_04C7 | 0x8027_0000)
}

/// Error de una acción del Shell: `action.cancelled` o `action.failed` con el texto del sistema.
pub fn action_error(code: i32) -> EngineMessage {
    if is_cancel(code) {
        msg::action_cancelled()
    } else {
        msg::action_failed(&error_text(code))
    }
}

/// Como [`action_error`] para un error de E/S.
pub fn action_io_error(e: &std::io::Error) -> EngineMessage {
    match e.raw_os_error() {
        Some(code) => action_error(code),
        None => msg::action_failed(&io_error_text(e)),
    }
}

/// Comprueba que `path` es una carpeta que se puede abrir (`error.notFolder`, `error.cannotOpen`).
pub fn check_folder(path: &str) -> Result<(), EngineMessage> {
    match std::fs::metadata(path) {
        Ok(m) if m.is_dir() => Ok(()),
        Ok(_) => Err(msg::not_folder(path)),
        Err(e) => Err(msg::cannot_open(path, &io_error_text(&e))),
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::walk::{wide, Handle};
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDiskFreeSpaceW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW, GetVolumePathNameW,
    };
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    use windows_sys::Win32::UI::Shell::Common::ITEMIDLIST;
    use windows_sys::Win32::UI::Shell::{
        FOLDERID_Downloads, FOLDERID_LocalAppData, SHGetKnownFolderPath, SHOpenFolderAndSelectItems, SHParseDisplayName, ShellExecuteExW,
        ShellExecuteW, SEE_MASK_INVOKEIDLIST, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    const DRIVE_UNKNOWN: u32 = 0;
    const DRIVE_NO_ROOT_DIR: u32 = 1;
    const DRIVE_REMOTE: u32 = 4;

    fn from_wide(buf: &[u16]) -> String {
        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..n])
    }

    pub fn volume_info(root: &str) -> Option<VolumeInfo> {
        let w = wide(root);
        let mut label = [0u16; 261];
        let mut fs = [0u16; 261];
        let (mut serial, mut maxc, mut fsflags) = (0u32, 0u32, 0u32);
        let ok = unsafe {
            GetVolumeInformationW(w.as_ptr(), label.as_mut_ptr(), 261, &mut serial, &mut maxc, &mut fsflags, fs.as_mut_ptr(), 261)
        };
        if ok == 0 {
            return None;
        }
        let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
        unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut avail, &mut total, &mut free) };
        let (mut spc, mut bps, mut fc, mut tc) = (0u32, 0u32, 0u32, 0u32);
        let cluster = if unsafe { GetDiskFreeSpaceW(w.as_ptr(), &mut spc, &mut bps, &mut fc, &mut tc) } != 0 {
            spc as u64 * bps as u64
        } else {
            0
        };
        Some(VolumeInfo { path: root.to_string(), label: from_wide(&label), fs: from_wide(&fs), total, free, cluster_size: cluster })
    }

    pub fn volumes() -> Vec<VolumeInfo> {
        let mask = unsafe { GetLogicalDrives() };
        (0..26u8)
            .filter(|i| mask & (1 << i) != 0)
            .filter_map(|i| {
                let root = format!("{}:\\", (b'A' + i) as char);
                let ty = unsafe { GetDriveTypeW(wide(&root).as_ptr()) };
                if ty == DRIVE_UNKNOWN || ty == DRIVE_NO_ROOT_DIR {
                    return None;
                }
                volume_info(&root)
            })
            .collect()
    }

    /// Raíz del volumen que contiene `path` ("C:\\", "\\\\srv\\recurso\\").
    pub fn volume_root_of(path: &str) -> Option<String> {
        let w = wide(path);
        let mut out = [0u16; 1024];
        if unsafe { GetVolumePathNameW(w.as_ptr(), out.as_mut_ptr(), out.len() as u32) } == 0 {
            return None;
        }
        Some(from_wide(&out))
    }

    /// Ruta de red: UNC o unidad asignada a un recurso compartido.
    pub fn is_network(root: &str) -> bool {
        root.starts_with(r"\\") || unsafe { GetDriveTypeW(wide(root).as_ptr()) } == DRIVE_REMOTE
    }

    /// Memoria del proceso: (conjunto de trabajo actual, pico, commit pico) en bytes.
    pub fn process_memory() -> Option<(u64, u64, u64)> {
        use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        let mut c: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        (unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) } != 0)
            .then_some((c.WorkingSetSize as u64, c.PeakWorkingSetSize as u64, c.PeakPagefileUsage as u64))
    }

    pub fn elevation() -> ElevationInfo {
        let mut tok: HANDLE = std::ptr::null_mut();
        let mut elevated = false;
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut tok) } != 0 {
            let tok = Handle(tok);
            let mut te = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut len = 0u32;
            let ok = unsafe {
                GetTokenInformation(tok.0, TokenElevation, &mut te as *mut _ as *mut _, std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut len)
            };
            elevated = ok != 0 && te.TokenIsElevated != 0;
        }
        ElevationInfo { elevated, can_elevate: !elevated }
    }

    /// Relanza este ejecutable con el verbo `runas` (muestra UAC). Ok si se lanzó;
    /// si no (p. ej. UAC cancelado), `elevation.failed` con el texto del sistema.
    pub fn relaunch_elevated(args: &str) -> Result<(), EngineMessage> {
        let exe = std::env::current_exe().map_err(|e| msg::elevation_failed(&super::io_error_text(&e)))?;
        let exe_w: Vec<u16> = exe.as_os_str().encode_wide_z();
        let verb = wide("runas");
        let params = wide(args);
        let mut sei: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
        sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.fMask = SEE_MASK_NOASYNC;
        sei.lpVerb = verb.as_ptr();
        sei.lpFile = exe_w.as_ptr();
        sei.lpParameters = params.as_ptr();
        sei.nShow = SW_SHOWNORMAL;
        if unsafe { ShellExecuteExW(&mut sei) } == 0 {
            return Err(msg::elevation_failed(&super::last_error_text()));
        }
        Ok(())
    }

    /// Carpeta conocida del usuario (`FOLDERID_*`), tal como la tenga configurada (puede estar movida).
    fn known_folder(id: &windows_sys::core::GUID) -> Option<std::path::PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        let mut p: *mut u16 = std::ptr::null_mut();
        let hr = unsafe { SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut p) };
        let r = (hr >= 0 && !p.is_null()).then(|| {
            let len = (0..).take_while(|&i| unsafe { *p.add(i) } != 0).count();
            std::path::PathBuf::from(std::ffi::OsString::from_wide(unsafe { std::slice::from_raw_parts(p, len) }))
        });
        unsafe { CoTaskMemFree(p as *const _) };
        r
    }

    /// Carpeta de Descargas del usuario.
    pub fn downloads_dir() -> Option<std::path::PathBuf> {
        known_folder(&FOLDERID_Downloads)
    }

    /// `%LOCALAPPDATA%`.
    pub fn local_app_data() -> Option<std::path::PathBuf> {
        known_folder(&FOLDERID_LocalAppData).or_else(|| std::env::var_os("LOCALAPPDATA").map(Into::into))
    }

    fn last_action_error() -> EngineMessage {
        super::action_io_error(&std::io::Error::last_os_error())
    }

    trait WideZ {
        fn encode_wide_z(&self) -> Vec<u16>;
    }
    impl WideZ for std::ffi::OsStr {
        fn encode_wide_z(&self) -> Vec<u16> {
            use std::os::windows::ffi::OsStrExt;
            self.encode_wide().chain(std::iter::once(0)).collect()
        }
    }

    /// Ejecuta `f` en un hilo propio con COM en modo STA (lo exige el Shell).
    fn with_com<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::spawn(move || {
            let hr = unsafe { CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
            let r = f();
            if hr >= 0 {
                unsafe { CoUninitialize() };
            }
            r
        })
        .join()
        .expect("COM thread panicked")
    }

    fn zt(path: &[u16]) -> Vec<u16> {
        path.iter().copied().chain(std::iter::once(0)).collect()
    }

    pub fn open(path: &[u16]) -> Result<(), EngineMessage> {
        let p = zt(path);
        with_com(move || {
            let verb = wide("open");
            let h = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), p.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
            if (h as isize) <= 32 {
                Err(last_action_error())
            } else {
                Ok(())
            }
        })
    }

    pub fn reveal(path: &[u16]) -> Result<(), EngineMessage> {
        let p = zt(path);
        with_com(move || {
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            let hr = unsafe { SHParseDisplayName(p.as_ptr(), std::ptr::null_mut(), &mut pidl, 0, std::ptr::null_mut()) };
            if hr < 0 {
                return Err(super::action_error(hr));
            }
            let hr = unsafe { SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0) };
            unsafe { CoTaskMemFree(pidl as *const _) };
            if hr < 0 {
                Err(super::action_error(hr))
            } else {
                Ok(())
            }
        })
    }

    pub fn properties(path: &[u16]) -> Result<(), EngineMessage> {
        let p = zt(path);
        with_com(move || {
            let verb = wide("properties");
            let mut sei: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
            sei.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
            sei.fMask = SEE_MASK_INVOKEIDLIST | SEE_MASK_NOASYNC;
            sei.lpVerb = verb.as_ptr();
            sei.lpFile = p.as_ptr();
            sei.nShow = SW_SHOWNORMAL;
            if unsafe { ShellExecuteExW(&mut sei) } == 0 {
                Err(last_action_error())
            } else {
                Ok(())
            }
        })
    }

    /// Envía a la Papelera de reciclaje (nunca borra de forma permanente).
    pub fn trash(path: &[u16]) -> Result<(), EngineMessage> {
        use std::os::windows::ffi::OsStringExt;
        let p = std::path::PathBuf::from(std::ffi::OsString::from_wide(path));
        // Si ya no existe (o no se puede consultar), el error del sistema es más claro que el del crate
        if let Err(e) = std::fs::symlink_metadata(&p) {
            return Err(super::action_io_error(&e));
        }
        trash::delete(&p).map_err(|e| match e {
            trash::Error::Os { code, .. } if super::is_cancel(code) => msg::action_cancelled(),
            trash::Error::Os { code, description } => {
                let t = super::error_text(code);
                msg::action_failed(if t.is_empty() { &description } else { &t })
            }
            // IFileOperation terminó sin moverlo (p. ej. no cabe en la papelera: con FOF_NO_UI y
            // FOF_WANTNUKEWARNING se aborta en vez de borrarlo de forma permanente)
            trash::Error::Unknown { description } if description.contains("aborted") => msg::trash_not_moved(),
            other => msg::action_failed(&other.to_string()),
        })
    }
}

#[cfg(windows)]
pub use imp::*;

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn volume_info(_root: &str) -> Option<VolumeInfo> {
        None
    }
    pub fn volumes() -> Vec<VolumeInfo> {
        Vec::new()
    }
    pub fn volume_root_of(_path: &str) -> Option<String> {
        None
    }
    pub fn is_network(root: &str) -> bool {
        root.starts_with(r"\\")
    }
    pub fn elevation() -> ElevationInfo {
        ElevationInfo { elevated: false, can_elevate: false }
    }
    /// Memoria del proceso: (conjunto de trabajo actual, pico, commit pico) en bytes.
    pub fn process_memory() -> Option<(u64, u64, u64)> {
        None
    }
    pub fn relaunch_elevated(_args: &str) -> Result<(), EngineMessage> {
        Err(msg::unsupported_platform())
    }
    pub fn downloads_dir() -> Option<std::path::PathBuf> {
        std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Downloads"))
    }
    pub fn local_app_data() -> Option<std::path::PathBuf> {
        std::env::var_os("LOCALAPPDATA").map(Into::into)
    }
    pub fn open(_p: &[u16]) -> Result<(), EngineMessage> {
        Err(msg::unsupported_platform())
    }
    pub fn reveal(_p: &[u16]) -> Result<(), EngineMessage> {
        Err(msg::unsupported_platform())
    }
    pub fn properties(_p: &[u16]) -> Result<(), EngineMessage> {
        Err(msg::unsupported_platform())
    }
    pub fn trash(_p: &[u16]) -> Result<(), EngineMessage> {
        Err(msg::unsupported_platform())
    }
}

#[cfg(not(windows))]
pub use imp::*;
