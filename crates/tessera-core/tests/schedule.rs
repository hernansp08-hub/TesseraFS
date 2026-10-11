//! Pruebas del escaneo programado sin programar nada en el sistema: la ejecución (`run_scheduled`,
//! `scheduled_scan`) sobre carpetas temporales creadas aquí mismo, con la carpeta de datos y el historial
//! también temporales (TESSERA_DATA_DIR y TESSERA_HISTORY_DIR) y una notificación de prueba que sólo apunta
//! lo que se le pidió. Nunca se llama a `schedule::set`, que crearía una tarea o un temporizador de verdad.
//! Windows y Linux.

use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tessera_core::schedule::{self, run_scheduled};
use tessera_core::scan::normalize_path;
use tessera_core::{sys, History, ScheduleConfig, ScheduleEvery, ScheduleMessages};

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("tessera-sched-{tag}-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
    fn file(&self, rel: &str, len: usize) {
        let p = self.0.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, vec![7u8; len]).unwrap();
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Una carpeta con 2 MiB + 1 MiB + 10 000 bytes.
fn fixture() -> TempDir {
    let d = TempDir::new("scan");
    d.file("grande.bin", 2 << 20);
    d.file("sub/mediano.bin", 1 << 20);
    d.file("sub/notas.txt", 10_000);
    d
}
const FIXTURE_BYTES: u64 = (2 << 20) + (1 << 20) + 10_000;

fn config(path: &Path, min_free_pct: u32) -> ScheduleConfig {
    ScheduleConfig {
        path: path.to_str().unwrap().to_string(),
        every: ScheduleEvery::Daily,
        time: "10:00".into(),
        weekday: None,
        min_free_pct,
        messages: Some(ScheduleMessages { title: "Poco espacio en {drive}".into(), body: "{drive}: quedan {free} ({pct} %)".into(), sizes: None }),
    }
}

/// Notificación de prueba: apunta (título, texto) y falla si `fail`.
struct Recorder {
    calls: RefCell<Vec<(String, String)>>,
    fail: bool,
}
impl Recorder {
    fn new(fail: bool) -> Self {
        Recorder { calls: RefCell::new(Vec::new()), fail }
    }
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        self.calls.borrow_mut().push((title.to_string(), body.to_string()));
        if self.fail {
            Err("no notification service".into())
        } else {
            Ok(())
        }
    }
}

fn history_of(dir: &Path) -> Vec<tessera_core::HistoryEntry> {
    History::at(dir).list().unwrap()
}

#[test]
fn scans_saves_history_and_writes_the_last_run() {
    let (folder, data, hist) = (fixture(), TempDir::new("data"), TempDir::new("hist"));
    let rec = Recorder::new(false);
    let notify = |t: &str, b: &str| rec.notify(t, b);
    let before = tessera_core::query::now_secs() as u64;
    let run = run_scheduled(&config(&folder.0, 0), &data.0, &hist.0, &notify);
    assert!(run.ok && run.error.is_none(), "{run:?}");
    assert_eq!(run.bytes, Some(FIXTURE_BYTES));
    let (free, total) = (run.free.unwrap(), run.total.unwrap());
    assert!(total > 0 && free <= total, "{free} / {total}");
    assert!(run.at >= before && run.at <= before + 600);
    // Umbral 0: nunca avisa
    assert_eq!(run.alerted, Some(false));
    assert!(rec.calls.borrow().is_empty());
    // schedule-last.json = lo devuelto
    assert_eq!(schedule::read_last(&data.0), Some(run.clone()));
    let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(data.0.join("schedule-last.json")).unwrap()).unwrap();
    assert_eq!(raw["ok"], true);
    assert_eq!(raw["bytes"], FIXTURE_BYTES);
    assert!(raw.get("error").is_none());
    // Un resumen en el historial, de la carpeta escaneada
    let h = history_of(&hist.0);
    assert_eq!(h.len(), 1);
    assert_eq!(h[0].path, normalize_path(folder.0.to_str().unwrap()).unwrap());
    assert_eq!(h[0].bytes, FIXTURE_BYTES);
    // Otra ejecución: otro resumen (la retención es la de siempre)
    let again = run_scheduled(&config(&folder.0, 0), &data.0, &hist.0, &notify);
    assert!(again.ok);
    assert_eq!(history_of(&hist.0).len(), 2);
    assert!(!data.0.join("schedule-last.json.tmp").exists());
}

/// Umbral justo por encima del porcentaje libre actual (o `None` si el disco está casi vacío).
fn threshold_above(folder: &Path, data: &Path, hist: &Path) -> Option<u32> {
    let probe = run_scheduled(&config(folder, 0), data, hist, &|_: &str, _: &str| Ok(()));
    let pct = schedule::free_pct(probe.free?, probe.total?);
    (pct < 99).then_some(pct as u32 + 1)
}

#[test]
fn alerts_below_the_threshold() {
    let (folder, data, hist) = (fixture(), TempDir::new("data"), TempDir::new("hist"));
    let Some(pct) = threshold_above(&folder.0, &data.0, &hist.0) else {
        eprintln!("disco casi vacío: no se puede probar el aviso");
        return;
    };
    let rec = Recorder::new(false);
    let run = run_scheduled(&config(&folder.0, pct), &data.0, &hist.0, &|t: &str, b: &str| rec.notify(t, b));
    let (free, total) = (run.free.unwrap(), run.total.unwrap());
    assert!(schedule::should_alert(free, total, pct));
    assert_eq!((run.ok, run.alerted), (true, Some(true)), "{run:?}");
    let calls = rec.calls.borrow();
    assert_eq!(calls.len(), 1);
    let (title, body) = &calls[0];
    // Los huecos rellenos: unidad («C:» o el punto de montaje), tamaño corto y porcentaje entero
    assert!(title.starts_with("Poco espacio en ") && !title.contains('{'), "{title}");
    let drive = &title["Poco espacio en ".len()..];
    assert_eq!(body, &format!("{drive}: quedan {} ({} %)", schedule::short_size(free), schedule::free_pct(free, total)));
    if cfg!(windows) {
        assert!(drive.len() == 2 && drive.ends_with(':'), "{drive}");
    } else {
        assert!(drive.starts_with('/'), "{drive}");
    }
    assert_eq!(schedule::read_last(&data.0).unwrap().alerted, Some(true));
}

#[test]
fn a_notification_that_fails_is_not_a_failed_run() {
    let (folder, data, hist) = (fixture(), TempDir::new("data"), TempDir::new("hist"));
    let Some(pct) = threshold_above(&folder.0, &data.0, &hist.0) else { return };
    let rec = Recorder::new(true);
    let run = run_scheduled(&config(&folder.0, pct), &data.0, &hist.0, &|t: &str, b: &str| rec.notify(t, b));
    assert_eq!(rec.calls.borrow().len(), 1, "se intentó");
    assert_eq!((run.ok, run.alerted, run.error.is_none()), (true, Some(false), true), "{run:?}");
}

#[test]
fn a_missing_folder_fails_and_is_recorded() {
    let (base, data, hist) = (TempDir::new("gone"), TempDir::new("data"), TempDir::new("hist"));
    let gone = base.0.join("ya-no-existe");
    let rec = Recorder::new(false);
    let run = run_scheduled(&config(&gone, 0), &data.0, &hist.0, &|t: &str, b: &str| rec.notify(t, b));
    assert!(!run.ok);
    assert_eq!(run.error.as_ref().map(|e| e.code.as_str()), Some("error.cannotOpen"));
    assert_eq!(run.bytes, None);
    assert!(history_of(&hist.0).is_empty());
    let last = schedule::read_last(&data.0).unwrap();
    assert_eq!((last.ok, last.error), (false, run.error));
}

/// Las variables de entorno son del proceso: sólo esta prueba las toca.
static ENV: Mutex<()> = Mutex::new(());

/// `--scheduled-scan` de verdad (sin la ventana): la carpeta de datos y el historial salen de
/// TESSERA_DATA_DIR y TESSERA_HISTORY_DIR, y la programación de `schedule.json`.
#[test]
fn scheduled_scan_reads_the_data_folder() {
    let _lock = ENV.lock().unwrap_or_else(|e| e.into_inner());
    let (folder, data, hist) = (fixture(), TempDir::new("data"), TempDir::new("hist"));
    std::env::set_var("TESSERA_DATA_DIR", &data.0);
    std::env::set_var("TESSERA_HISTORY_DIR", &hist.0);
    assert_eq!(sys::data_dir().unwrap(), data.0);
    assert_eq!(History::open().unwrap().dir(), hist.0);
    let rec = Recorder::new(false);
    let notify = |t: &str, b: &str| rec.notify(t, b);

    // Sin schedule.json: falla con schedule.invalid y lo deja escrito
    let run = schedule::scheduled_scan(&notify);
    assert_eq!((run.ok, run.error.as_ref().map(|e| e.code.as_str())), (false, Some("schedule.invalid")));
    assert_eq!(schedule::read_last(&data.0), Some(run));

    // Con él: escanea y guarda en el historial de TESSERA_HISTORY_DIR
    std::fs::write(data.0.join("schedule.json"), serde_json::to_vec_pretty(&config(&folder.0, 0)).unwrap()).unwrap();
    let run = schedule::scheduled_scan(&notify);
    assert!(run.ok, "{run:?}");
    assert_eq!(run.bytes, Some(FIXTURE_BYTES));
    assert_eq!(history_of(&hist.0).len(), 1);
    assert_eq!(schedule::read_last(&data.0), Some(run));
    // La interfaz lo ve como la programación actual si el sistema la tiene
    let info = schedule::info(&data.0, true, true);
    assert_eq!(info.schedule, Some(config(&folder.0, 0)));
    assert!(info.last_run.unwrap().ok);
    assert!(rec.calls.borrow().is_empty());

    // Sin TESSERA_HISTORY_DIR, el historial va dentro de la carpeta de datos
    std::env::remove_var("TESSERA_HISTORY_DIR");
    assert_eq!(History::open().unwrap().dir(), data.0.join("history"));
    std::env::remove_var("TESSERA_DATA_DIR");
}
