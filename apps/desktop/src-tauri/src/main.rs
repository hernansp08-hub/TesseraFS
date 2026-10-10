// TesseraFS, edición de escritorio: Tauri 2 + tessera-core en el mismo proceso.
// Los comandos siguen la tabla del contrato en docs/ARQUITECTURA.md. Los errores son
// `EngineMessage` (código + parámetros + texto en inglés) que la interfaz traduce.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, RwLock};

use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State, WebviewWindowBuilder};
use tessera_core::{
    msg, ops, slice, sys, ActionKind, ActionResult, ChildrenResponse, ElevationInfo, EngineChoice, EngineMessage, ExtStat, NodeRow, Scan,
    ScanOptions, ScanProgress, ScanResult, SearchResponse, SortKey, VolumeInfo,
};

type Res<T> = Result<T, EngineMessage>;

/// Estado compartido: el último escaneo y su generación (cambia con cada escaneo nuevo).
#[derive(Default)]
struct AppState {
    scan: RwLock<Option<Scan>>,
    generation: AtomicU64,
    busy: AtomicBool,
    cancel: AtomicBool,
}

type St<'a> = State<'a, Arc<AppState>>;

fn poisoned<T>(_: T) -> EngineMessage {
    msg::internal("State lock poisoned")
}

fn join_error(e: tauri::Error) -> EngineMessage {
    msg::internal(&e.to_string())
}

/// Ejecuta `f` con el escaneo actual en un hilo de trabajo (no bloquea la ventana).
async fn with_scan<T: Send + 'static>(st: &St<'_>, f: impl FnOnce(&Scan) -> Res<T> + Send + 'static) -> Res<T> {
    let st = st.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let g = st.scan.read().map_err(poisoned)?;
        let s = g.as_ref().ok_or_else(msg::no_scan)?;
        f(s)
    })
    .await
    .map_err(join_error)?
}

fn check(s: &Scan, id: u32) -> Res<()> {
    if s.tree.live(id) {
        Ok(())
    } else {
        Err(msg::invalid_node(id))
    }
}

#[tauri::command]
async fn volumes() -> Res<Vec<VolumeInfo>> {
    tauri::async_runtime::spawn_blocking(sys::volumes).await.map_err(join_error)
}

#[tauri::command]
async fn scan(st: St<'_>, path: String, engine: Option<EngineChoice>, on_progress: Channel<ScanProgress>) -> Res<ScanResult> {
    let st = st.inner().clone();
    if st.busy.swap(true, SeqCst) {
        return Err(msg::scan_busy());
    }
    // Se limpia antes de lanzar el trabajo: una cancelación que llegue justo después no se pierde
    st.cancel.store(false, SeqCst);
    let job = st.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        let cb = move |p: ScanProgress| {
            let _ = on_progress.send(p);
        };
        let s = tessera_core::scan(&path, engine.unwrap_or_default(), &ScanOptions::default(), &cb, &job.cancel)?;
        let res = s.result.clone();
        *job.scan.write().map_err(poisoned)? = Some(s);
        job.generation.fetch_add(1, SeqCst);
        Ok::<_, EngineMessage>(res)
    })
    .await
    .map_err(join_error);
    st.busy.store(false, SeqCst);
    r?
}

/// Pide parar el escaneo en curso; el comando `scan` pendiente termina con `error.cancelled`.
/// El escaneo anterior, si lo había, sigue cargado.
#[tauri::command]
fn cancel_scan(st: St<'_>) -> bool {
    let busy = st.busy.load(SeqCst);
    if busy {
        st.cancel.store(true, SeqCst);
    }
    busy
}

#[tauri::command]
async fn slice(st: St<'_>, root: u32, min_bytes: f64, max_nodes: u32) -> Res<Response> {
    with_scan(&st, move |s| {
        check(s, root)?;
        Ok(Response::new(slice::encode_slice(&s.tree, root, min_bytes, max_nodes)))
    })
    .await
}

#[tauri::command]
async fn children(st: St<'_>, id: u32, offset: u32, limit: u32, sort: Option<SortKey>, desc: Option<bool>) -> Res<ChildrenResponse> {
    with_scan(&st, move |s| ops::children(&s.tree, id, offset, limit, sort.unwrap_or_default(), desc.unwrap_or(true))).await
}

/// Los errores de sintaxis (`query.*`) y un nodo no válido viajan en `SearchResponse.error`.
#[tauri::command]
async fn search(st: St<'_>, query: String, root: u32, limit: u32) -> Res<SearchResponse> {
    with_scan(&st, move |s| Ok(ops::search(&s.tree, &query, root, limit))).await
}

#[tauri::command]
async fn ext_stats(st: St<'_>, root: u32) -> Res<Vec<ExtStat>> {
    with_scan(&st, move |s| ops::ext_stats(&s.tree, root)).await
}

#[tauri::command]
async fn node_path(st: St<'_>, id: u32) -> Res<String> {
    with_scan(&st, move |s| {
        check(s, id)?;
        Ok(s.tree.path(id))
    })
    .await
}

#[tauri::command]
async fn node_info(st: St<'_>, id: u32) -> Res<NodeRow> {
    with_scan(&st, move |s| {
        check(s, id)?;
        Ok(s.tree.row(id))
    })
    .await
}

/// `kind` llega como texto para responder `action.unknown` en vez de un error de deserialización.
#[tauri::command]
async fn action(st: St<'_>, kind: String, id: u32) -> Res<ActionResult> {
    let kind: ActionKind = match kind.parse() {
        Ok(k) => k,
        Err(k) => return Ok(ActionResult::fail(msg::unknown_action(&k))),
    };
    let st = st.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Ruta exacta bajo lectura; la acción del Shell corre sin bloquear el árbol
        let (path, generation) = {
            let g = st.scan.read().map_err(poisoned)?;
            let Some(s) = g.as_ref() else { return Ok(ActionResult::fail(msg::no_scan())) };
            if !s.tree.live(id) {
                return Ok(ActionResult::fail(msg::invalid_node(id)));
            }
            if id == 0 && kind == ActionKind::Trash {
                return Ok(ActionResult::fail(msg::trash_root()));
            }
            (s.tree.path_wide(id), st.generation.load(SeqCst))
        };
        if let Err(e) = tessera_core::run_action(kind, &path) {
            return Ok(ActionResult::fail(e));
        }
        if kind == ActionKind::Trash {
            let mut g = st.scan.write().map_err(poisoned)?;
            if let Some(s) = g.as_mut() {
                if st.generation.load(SeqCst) == generation {
                    let _ = s.tree.remove(id);
                }
            }
        }
        Ok(tessera_core::action_done(kind))
    })
    .await
    .map_err(join_error)?
}

#[tauri::command]
fn elevation() -> ElevationInfo {
    sys::elevation()
}

#[tauri::command]
async fn relaunch_elevated(app: AppHandle) -> Res<()> {
    tauri::async_runtime::spawn_blocking(|| sys::relaunch_elevated("")).await.map_err(join_error)??;
    app.exit(0);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(Arc::new(AppState::default()))
        .setup(|app| {
            // La ventana se crea aquí para separar los datos de WebView2 del proceso elevado:
            // un mismo directorio no se puede compartir entre niveles de integridad distintos.
            let cfg = app.config().app.windows.first().cloned().ok_or("Missing window configuration")?;
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
            cancel_scan,
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
        .expect("error while starting TesseraFS");
}
