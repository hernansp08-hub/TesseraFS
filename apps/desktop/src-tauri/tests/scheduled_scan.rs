//! `tesserafs-desktop --scheduled-scan` de verdad: el ejecutable escanea sin crear ventana ni nada de Tauri
//! y termina con 0 (o con 1 si falla). La carpeta de datos y el historial son temporales (TESSERA_DATA_DIR y
//! TESSERA_HISTORY_DIR) y el umbral es 0, así que no hay notificación. No programa nada en el sistema.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tessera_core::{schedule, History, ScheduleConfig, ScheduleEvery};

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let p = std::env::temp_dir().join(format!("tessera-desk-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Lanza el ejecutable con `--scheduled-scan` y devuelve su código de salida. Si abriera la ventana no
/// terminaría: se espera como mucho dos minutos y se cierra.
fn scheduled_scan(data: &Path, history: &Path) -> i32 {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tesserafs-desktop"))
        .arg("--scheduled-scan")
        .env("TESSERA_DATA_DIR", data)
        .env("TESSERA_HISTORY_DIR", history)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status.code().unwrap_or(-1);
        }
        if start.elapsed() > Duration::from_secs(120) {
            let _ = child.kill();
            panic!("--scheduled-scan no terminó: ¿abrió la ventana?");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn scheduled_scan_runs_without_a_window() {
    let (folder, data, history) = (TempDir::new("scan"), TempDir::new("data"), TempDir::new("hist"));
    std::fs::write(folder.0.join("datos.bin"), vec![1u8; 3 << 20]).unwrap();

    // Sin programación: termina con 1 y lo deja escrito
    assert_eq!(scheduled_scan(&data.0, &history.0), 1);
    let last = schedule::read_last(&data.0).expect("schedule-last.json");
    assert_eq!((last.ok, last.error.map(|e| e.code)), (false, Some("schedule.invalid".to_string())));

    // Con ella: escanea la carpeta, guarda el resumen y termina con 0
    let cfg = ScheduleConfig {
        path: folder.0.to_str().unwrap().to_string(),
        every: ScheduleEvery::Weekly,
        time: "03:00".into(),
        weekday: Some(0),
        min_free_pct: 0,
        messages: None,
    };
    std::fs::write(data.0.join("schedule.json"), serde_json::to_vec_pretty(&cfg).unwrap()).unwrap();
    assert_eq!(scheduled_scan(&data.0, &history.0), 0);
    let last = schedule::read_last(&data.0).unwrap();
    assert!(last.ok && last.error.is_none(), "{last:?}");
    assert_eq!((last.bytes, last.alerted), (Some(3 << 20), Some(false)));
    assert!(last.total.unwrap() > 0);
    let saved = History::at(&history.0).list().unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].bytes, 3 << 20);
}
