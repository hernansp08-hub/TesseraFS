//! Papelera de freedesktop en Linux, de principio a fin y sin tocar la papelera del usuario: el proceso
//! de esta prueba (un binario aparte, porque cambia el entorno) apunta `XDG_DATA_HOME` a una carpeta
//! temporal que está en el mismo sistema de archivos que lo que se envía, así que todo va a
//! `<temporal>/Trash` y se borra al terminar.
#![cfg(all(unix, not(target_os = "macos")))]

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use tessera_core::{scan, ActionKind, EngineChoice, ScanOptions, Tree};

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn find(t: &Tree, path: &Path) -> u32 {
    let want = path.to_string_lossy();
    (0..t.len() as u32).find(|&i| t.live(i) && t.path(i) == want).unwrap_or_else(|| panic!("no está {want}"))
}

#[test]
fn trash_moves_to_a_temporary_trash() {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let p = std::env::temp_dir().join(format!("tessera-trash-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&p).unwrap();
    let d = TempDir(p.canonicalize().unwrap());
    let data = d.0.join("datos");
    std::fs::create_dir_all(&data).unwrap();
    // Única prueba de este binario: nadie más lee el entorno a la vez
    std::env::set_var("XDG_DATA_HOME", &data);
    let files = d.0.join("archivos");
    std::fs::create_dir_all(files.join("carpeta/sub")).unwrap();
    std::fs::write(files.join("borrame.bin"), vec![1u8; 5000]).unwrap();
    std::fs::write(files.join("queda.txt"), b"x").unwrap();
    std::fs::write(files.join("carpeta/sub/dentro.txt"), b"hola").unwrap();

    let cancel = AtomicBool::new(false);
    let mut s = scan(&d.0.to_string_lossy(), EngineChoice::Walk, &ScanOptions::default(), &|_| {}, &cancel).unwrap();
    let before = s.tree.size(0);
    let trash = data.join("Trash");

    // Un archivo
    let id = find(&s.tree, &files.join("borrame.bin"));
    let r = tessera_core::action(&mut s.tree, ActionKind::Trash, id);
    assert!(r.ok, "{:?}", r.message);
    assert_eq!(r.code.as_deref(), Some("action.trashed"));
    assert!(!files.join("borrame.bin").exists());
    assert_eq!(std::fs::read(trash.join("files/borrame.bin")).unwrap().len(), 5000);
    let info = std::fs::read_to_string(trash.join("info/borrame.bin.trashinfo")).unwrap();
    assert!(info.starts_with("[Trash Info]") && info.contains("Path="), "{info}");
    assert!(!s.tree.live(id));
    assert_eq!(s.tree.size(0), before - 5000);

    // Una carpeta entera
    let id = find(&s.tree, &files.join("carpeta"));
    let r = tessera_core::action(&mut s.tree, ActionKind::Trash, id);
    assert!(r.ok, "{:?}", r.message);
    assert_eq!(std::fs::read(trash.join("files/carpeta/sub/dentro.txt")).unwrap(), b"hola");
    assert!(!files.join("carpeta").exists());

    // La carpeta que contiene la propia papelera no se envía (ni se copia nada)
    let id = find(&s.tree, &data);
    let r = tessera_core::action(&mut s.tree, ActionKind::Trash, id);
    assert_eq!((r.ok, r.code.as_deref()), (false, Some("action.failed")));
    assert!(trash.join("files/borrame.bin").exists() && s.tree.live(id));
    assert!(files.join("queda.txt").exists());
}
