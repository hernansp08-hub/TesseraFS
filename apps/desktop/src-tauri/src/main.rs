// TesseraFS, edición de escritorio: Tauri 2 + tessera-core en el mismo proceso.
// Los comandos siguen la tabla del contrato en docs/ARQUITECTURA.md.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, RwLock};

use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State, WebviewWindowBuilder};
use tessera_core::{
    ops, slice, sys, ActionKind, ActionResult, ChildrenResponse, ElevationInfo, EngineChoice, ExtStat, NodeRow, Scan, ScanOptions,
    ScanProgress, ScanResult, SearchResponse, SortKey, VolumeInfo,
};

const SIN_ESCANEO: &str = "No hay ningún escaneo cargado";

/// Estado compartido: el último escaneo y su generación (cambia con cada escaneo nuevo).
#[derive(Default)]
struct AppState {
    scan: RwLock<Option<Scan>>,
    generation: AtomicU64,
    busy: AtomicBool,
    cancel: AtomicBool,
}

type St<'a> = State<'a, Arc<AppState>>;

/// Ejecuta `f` con el escaneo actual en un hilo de trabajo (no bloquea la ventana).
async fn with_scan<T: Send + 'static>(st: &St<'_>, f: impl FnOnce(&Scan) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let st = st.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let g = st.scan.read().map_err(|_| "Estado bloqueado".to_string())?;
        let s = g.as_ref().ok_or(SIN_ESCANEO)?;
        f(s)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn check(s: &Scan, id: u32) -> Result<(), String> {
    if s.tree.live(id) {
        Ok(())
    } else {
        Err(format!("Id no válido: {id}"))
    }
}

#[tauri::command]
async fn volumes() -> Result<Vec<VolumeInfo>, String> {
    tauri::async_runtime::spawn_blocking(sys::volumes).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn scan(st: St<'_>, path: String, engine: Option<EngineChoice>, on_progress: Channel<ScanProgress>) -> Result<ScanResult, String> {
    let st = st.inner().clone();
    if st.busy.swap(true, SeqCst) {
        return Err("Ya hay un escaneo en curso".into());
    }
    let job = st.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        job.cancel.store(false, SeqCst);
        let cb = move |p: ScanProgress| {
            let _ = on_progress.send(p);
        };
        let s = tessera_core::scan(&path, engine.unwrap_or_default(), &ScanOptions::default(), &cb, &job.cancel)?;
        let res = s.result.clone();
        *job.scan.write().map_err(|_| "Estado bloqueado".to_string())? = Some(s);
        job.generation.fetch_add(1, SeqCst);
        Ok::<_, String>(res)
    })
    .await
    .map_err(|e| e.to_string());
    st.busy.store(false, SeqCst);
    r?
}

#[tauri::command]
async fn slice(st: St<'_>, root: u32, min_bytes: f64, max_nodes: u32) -> Result<Response, String> {
    with_scan(&st, move |s| {
        check(s, root)?;
        Ok(Response::new(slice::encode_slice(&s.tree, root, min_bytes, max_nodes)))
    })
    .await
}

#[tauri::command]
async fn children(st: St<'_>, id: u32, offset: u32, limit: u32, sort: Option<SortKey>, desc: Option<bool>) -> Result<ChildrenResponse, String> {
    with_scan(&st, move |s| ops::children(&s.tree, id, offset, limit, sort.unwrap_or_default(), desc.unwrap_or(true))).await
}

#[tauri::command]
async fn search(st: St<'_>, query: String, root: u32, limit: u32) -> Result<SearchResponse, String> {
    with_scan(&st, move |s| Ok(ops::search(&s.tree, &query, root, limit))).await
}

#[tauri::command]
async fn ext_stats(st: St<'_>, root: u32) -> Result<Vec<ExtStat>, String> {
    with_scan(&st, move |s| ops::ext_stats(&s.tree, root)).await
}

#[tauri::command]
async fn node_path(st: St<'_>, id: u32) -> Result<String, String> {
    with_scan(&st, move |s| {
        check(s, id)?;
        Ok(s.tree.path(id))
    })
    .await
}

#[tauri::command]
async fn node_info(st: St<'_>, id: u32) -> Result<NodeRow, String> {
    with_scan(&st, move |s| {
        check(s, id)?;
        Ok(s.tree.row(id))
    })
    .await
}

#[tauri::command]
async fn action(st: St<'_>, kind: ActionKind, id: u32) -> Result<ActionResult, String> {
    let st = st.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let fail = |m: String| ActionResult { ok: false, message: Some(m) };
        // Ruta exacta bajo lectura; la acción del Shell corre sin bloquear el árbol
        let (path, generation) = {
            let g = st.scan.read().map_err(|_| "Estado bloqueado".to_string())?;
            let Some(s) = g.as_ref() else { return Ok(fail(SIN_ESCANEO.into())) };
            if !s.tree.live(id) {
                return Ok(fail(format!("Id no válido: {id}")));
            }
            if id == 0 && kind == ActionKind::Trash {
                return Ok(fail("No se puede enviar la raíz del escaneo a la papelera".into()));
            }
            (s.tree.path_wide(id), st.generation.load(SeqCst))
        };
        if let Err(e) = tessera_core::run_action(kind, &path) {
            return Ok(fail(e));
        }
        if kind != ActionKind::Trash {
            return Ok(ActionResult { ok: true, message: None });
        }
        let mut g = st.scan.write().map_err(|_| "Estado bloqueado".to_string())?;
        if let Some(s) = g.as_mut() {
            if st.generation.load(SeqCst) == generation {
                let _ = s.tree.remove(id);
            }
        }
        Ok(ActionResult { ok: true, message: Some("Movido a la papelera".into()) })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn elevation() -> ElevationInfo {
    sys::elevation()
}

#[tauri::command]
async fn relaunch_elevated(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| sys::relaunch_elevated("")).await.map_err(|e| e.to_string())??;
    app.exit(0);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(AppState::default()))
        .setup(|app| {
            // La ventana se crea aquí para separar los datos de WebView2 del proceso elevado:
            // un mismo directorio no se puede compartir entre niveles de integridad distintos.
            let cfg = app.config().app.windows.first().cloned().ok_or("Falta la configuración de la ventana")?;
            let mut b = WebviewWindowBuilder::from_config(app.handle(), &cfg)?;
            if sys::elevation().elevated {
                b = b.data_directory(app.path().app_local_data_dir()?.join("EBWebView-admin"));
            }
            b.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            volumes,
            scan,
            slice,
            children,
            search,
            ext_stats,
            node_path,
            node_info,
            action,
            elevation,
            relaunch_elevated
        ])
        .run(tauri::generate_context!())
        .expect("error al iniciar TesseraFS");
}
