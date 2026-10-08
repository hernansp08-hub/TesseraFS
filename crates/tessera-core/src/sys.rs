//! Integración con Windows: unidades, elevación y acciones de archivo.

use crate::types::{ElevationInfo, VolumeInfo};

/// Texto del último error de Windows (sin el sufijo «(os error N)»).
pub fn last_error_text() -> String {
    clean_io(std::io::Error::last_os_error())
}

/// Texto de un código de error de Windows (Win32 o HRESULT).
pub fn error_text(code: i32) -> String {
    clean_io(std::io::Error::from_raw_os_error(code))
}

fn clean_io(e: std::io::Error) -> String {
    let s = e.to_string();
    match s.rfind(" (os error") {
        Some(p) => s[..p].trim().to_string(),
        None => s,
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
        SHOpenFolderAndSelectItems, SHParseDisplayName, ShellExecuteExW, ShellExecuteW, SEE_MASK_INVOKEIDLIST, SEE_MASK_NOASYNC,
        SHELLEXECUTEINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    const DRIVE_UNKNOWN: u32 = 0;
    const DRIVE_NO_ROOT_DIR: u32 = 1;

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

    /// Relanza este ejecutable con el verbo `runas` (muestra UAC). Ok si se lanzó.
    pub fn relaunch_elevated(args: &str) -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
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
            return Err(super::last_error_text());
        }
        Ok(())
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
        .expect("hilo COM")
    }

    fn zt(path: &[u16]) -> Vec<u16> {
        path.iter().copied().chain(std::iter::once(0)).collect()
    }

    pub fn open(path: &[u16]) -> Result<(), String> {
        let p = zt(path);
        with_com(move || {
            let verb = wide("open");
            let h = unsafe { ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), p.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL) };
            if (h as isize) <= 32 {
                Err(super::last_error_text())
            } else {
                Ok(())
            }
        })
    }

    pub fn reveal(path: &[u16]) -> Result<(), String> {
        let p = zt(path);
        with_com(move || {
            let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
            let hr = unsafe { SHParseDisplayName(p.as_ptr(), std::ptr::null_mut(), &mut pidl, 0, std::ptr::null_mut()) };
            if hr < 0 {
                return Err(super::error_text(hr));
            }
            let hr = unsafe { SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0) };
            unsafe { CoTaskMemFree(pidl as *const _) };
            if hr < 0 {
                Err(super::error_text(hr))
            } else {
                Ok(())
            }
        })
    }

    pub fn properties(path: &[u16]) -> Result<(), String> {
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
                Err(super::last_error_text())
            } else {
                Ok(())
            }
        })
    }

    /// Envía a la Papelera de reciclaje (nunca borra de forma permanente).
    pub fn trash(path: &[u16]) -> Result<(), String> {
        use std::os::windows::ffi::OsStringExt;
        let p = std::path::PathBuf::from(std::ffi::OsString::from_wide(path));
        trash::delete(&p).map_err(|e| match e {
            trash::Error::Os { code, description } => {
                let t = super::error_text(code);
                if t.is_empty() {
                    description
                } else {
                    t
                }
            }
            other => other.to_string(),
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
    /// Memoria del proceso: (conjunto de trabajo actual, pico, commit pico) en bytes.
    pub fn process_memory() -> Option<(u64, u64, u64)> {
        use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
        let mut c: PROCESS_MEMORY_COUNTERS = unsafe { std::mem::zeroed() };
        c.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        (unsafe { K32GetProcessMemoryInfo(GetCurrentProcess(), &mut c, c.cb) } != 0)
            .then_some((c.WorkingSetSize as u64, c.PeakWorkingSetSize as u64, c.PeakPagefileUsage as u64))
    }

    pub fn elevation() -> ElevationInfo {
        ElevationInfo { elevated: false, can_elevate: false }
    }
    pub fn process_memory() -> Option<(u64, u64, u64)> {
        None
    }
    pub fn relaunch_elevated(_args: &str) -> Result<(), String> {
        Err("Sólo disponible en Windows".into())
    }
    pub fn open(_p: &[u16]) -> Result<(), String> {
        Err("Sólo disponible en Windows".into())
    }
    pub fn reveal(_p: &[u16]) -> Result<(), String> {
        Err("Sólo disponible en Windows".into())
    }
    pub fn properties(_p: &[u16]) -> Result<(), String> {
        Err("Sólo disponible en Windows".into())
    }
    pub fn trash(_p: &[u16]) -> Result<(), String> {
        Err("Sólo disponible en Windows".into())
    }
}

#[cfg(not(windows))]
pub use imp::*;
