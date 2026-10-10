// TesseraFS, edición de escritorio: Tauri 2 + tessera-core en el mismo proceso.
// Los comandos siguen la tabla del contrato en docs/ARQUITECTURA.md. Los errores son
// `EngineMessage` (código + parámetros + texto en inglés) que la interfaz traduce.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use tauri::ipc::{Channel, Response};
use tauri::{AppHandle, Manager, State, WebviewWindowBuilder};
use tessera_core::{
    export, msg, ops, slice, sys, ActionKind, ActionResult, ChildrenResponse, CompareResult, DupProgress, DupResult, ElevationInfo, EngineChoice,
    EngineMessage, ExportResult, ExtStat, History, HistoryEntry, NodeRow, RefreshResult, RescanResult, Scan, ScanOptions, ScanProgress, ScanResult,
    SearchResponse, SortKey, VolumeInfo,
};

type Res<T> = Result<T, EngineMessage>;

/// Estado compartido: el último escaneo y su generación (cambia con cada escaneo nuevo).
/// Un escaneo (o un rescan / refresh, que comparten `busy` y `cancel`) y una búsqueda de duplicados
/// no pueden coincidir.
#[derive(Default)]
struct AppState {
    scan: RwLock<Option<Scan>>,
    generation: AtomicU64,
    busy: AtomicBool,
    cancel: AtomicBool,
    dup_busy: AtomicBool,
    dup_cancel: AtomicBool,
    /// Enviados a la papelera durante una búsqueda de duplicados, (generación, id): la búsqueda
    /// tiene el árbol bajo lectura y esperar la escritura bloquearía el resto de lecturas.
    /// Este cerrojo también ordena los cambios de `dup_busy`.
    dup_trashed: Mutex<Vec<(u64, u32)>>,
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

/// Ejecuta `f` en un hilo de trabajo (E/S de disco sin bloquear la ventana).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(join_error)?
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

/// Empieza un trabajo que sustituye o cambia el árbol (escaneo, rescan, refresh): uno a la vez
/// (`error.scanBusy`) y nunca durante una búsqueda de duplicados, que lee el árbol (`error.dupBusy`).
fn begin_tree_job(st: &AppState) -> Res<()> {
    if st.busy.swap(true, SeqCst) {
        return Err(msg::scan_busy());
    }
    if st.dup_busy.load(SeqCst) {
        st.busy.store(false, SeqCst);
        return Err(msg::dup_busy());
    }
    // Se limpia antes de lanzar el trabajo: una cancelación que llegue justo después no se pierde
    st.cancel.store(false, SeqCst);
    Ok(())
}

/// Ejecuta `f` como trabajo del árbol en un hilo de trabajo y libera `busy` al terminar.
async fn tree_job<T: Send + 'static>(st: &St<'_>, f: impl FnOnce(&AppState) -> Res<T> + Send + 'static) -> Res<T> {
    let st = st.inner().clone();
    begin_tree_job(&st)?;
    let job = st.clone();
    let r = tauri::async_runtime::spawn_blocking(move || f(&job)).await.map_err(join_error);
    st.busy.store(false, SeqCst);
    r?
}

#[tauri::command]
async fn scan(st: St<'_>, path: String, engine: Option<EngineChoice>, on_progress: Channel<ScanProgress>) -> Res<ScanResult> {
    tree_job(&st, move |job| {
        let cb = move |p: ScanProgress| {
            let _ = on_progress.send(p);
        };
        let s = tessera_core::scan(&path, engine.unwrap_or_default(), &ScanOptions::default(), &cb, &job.cancel)?;
        let res = s.result.clone();
        *job.scan.write().map_err(poisoned)? = Some(s);
        job.generation.fetch_add(1, SeqCst);
        Ok(res)
    })
    .await
}

/// Vuelve a escanear una carpeta (no la raíz) y la sustituye en el árbol. El disco se lee sin
/// cerrojo (las consultas siguen respondiendo) y el injerto se hace bajo escritura; `cancel_scan`
/// lo para y el árbol queda como estaba.
#[tauri::command]
async fn rescan(st: St<'_>, id: u32, on_progress: Channel<ScanProgress>) -> Res<RescanResult> {
    tree_job(&st, move |job| {
        let cb = move |p: ScanProgress| {
            let _ = on_progress.send(p);
        };
        tessera_core::rescan_shared(&job.scan, id, &ScanOptions::default(), &cb, &job.cancel)
    })
    .await
}

/// Actualiza con el diario USN (`refresh.unavailable` sin `ScanResult.canRefresh`,
/// `refresh.journalReset` si hace falta un escaneo completo). Mismo cerrojo y cancelación que `rescan`.
#[tauri::command]
async fn refresh(st: St<'_>, on_progress: Channel<ScanProgress>) -> Res<RefreshResult> {
    tree_job(&st, move |job| {
        let cb = move |p: ScanProgress| {
            let _ = on_progress.send(p);
        };
        tessera_core::refresh_shared(&job.scan, &ScanOptions::default(), &cb, &job.cancel)
    })
    .await
}

/// Pide parar el escaneo (o el rescan / refresh) en curso; el comando pendiente termina con
/// `error.cancelled`. El escaneo anterior, si lo había, sigue cargado y sin cambios.
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
        // Ruta exacta (o, en freeUp, los elementos de la nube) bajo lectura; la acción corre sin bloquear el árbol
        let (target, generation) = {
            let g = st.scan.read().map_err(poisoned)?;
            let Some(s) = g.as_ref() else { return Ok(ActionResult::fail(msg::no_scan())) };
            match tessera_core::action_target(&s.tree, kind, id) {
                Ok(t) => (t, st.generation.load(SeqCst)),
                Err(e) => return Ok(ActionResult::fail(e)),
            }
        };
        let r = tessera_core::run_action(kind, &target);
        // freeUp no cambia el árbol: el proveedor vacía los archivos más tarde y la interfaz vuelve a escanear
        if r.ok && kind == ActionKind::Trash {
            // Con el cerrojo tomado no puede empezar una búsqueda de duplicados mientras se espera la escritura
            let mut later = st.dup_trashed.lock().map_err(poisoned)?;
            if st.dup_busy.load(SeqCst) {
                later.push((generation, id));
            } else {
                let mut g = st.scan.write().map_err(poisoned)?;
                if let Some(s) = g.as_mut() {
                    if st.generation.load(SeqCst) == generation {
                        let _ = s.tree.remove(id);
                    }
                }
            }
        }
        Ok(r)
    })
    .await
    .map_err(join_error)?
}

/// Busca duplicados bajo `root` con el escaneo actual (bajo lectura durante toda la búsqueda).
#[tauri::command]
async fn duplicates(st: St<'_>, root: u32, min_size: f64, limit: u32, on_progress: Channel<DupProgress>) -> Res<DupResult> {
    let st = st.inner().clone();
    begin_duplicates(&st)?;
    let job = st.clone();
    let r = tauri::async_runtime::spawn_blocking(move || {
        // `as` satura: negativos y NaN → 0
        let r = run_duplicates(&job, root, min_size as u64, limit, on_progress);
        end_duplicates(&job);
        r
    })
    .await;
    if r.is_err() {
        // El hilo terminó con pánico antes de cerrar la búsqueda
        end_duplicates(&st);
    }
    r.map_err(join_error)?
}

/// Empieza una búsqueda de duplicados: una a la vez (`error.dupBusy`) y nunca durante un escaneo,
/// rescan o refresh (`error.scanBusy`).
fn begin_duplicates(st: &AppState) -> Res<()> {
    {
        let _order = st.dup_trashed.lock().map_err(poisoned)?;
        if st.dup_busy.swap(true, SeqCst) {
            return Err(msg::dup_busy());
        }
    }
    if st.busy.load(SeqCst) {
        st.dup_busy.store(false, SeqCst);
        return Err(msg::scan_busy());
    }
    st.dup_cancel.store(false, SeqCst);
    Ok(())
}

fn run_duplicates(st: &AppState, root: u32, min_size: u64, limit: u32, on_progress: Channel<DupProgress>) -> Res<DupResult> {
    let g = st.scan.read().map_err(poisoned)?;
    let s = g.as_ref().ok_or_else(msg::no_scan)?;
    check(s, root)?;
    let cb = move |p: DupProgress| {
        let _ = on_progress.send(p);
    };
    tessera_core::duplicates(&s.tree, root, min_size, limit, &cb, &st.dup_cancel)
}

/// Cierra la búsqueda (ya sin la lectura del árbol) y quita lo enviado a la papelera mientras duraba.
fn end_duplicates(st: &AppState) {
    let trashed = {
        let mut later = st.dup_trashed.lock().unwrap_or_else(PoisonError::into_inner);
        st.dup_busy.store(false, SeqCst);
        std::mem::take(&mut *later)
    };
    if trashed.is_empty() {
        return;
    }
    if let Ok(mut g) = st.scan.write() {
        if let Some(s) = g.as_mut() {
            let current = st.generation.load(SeqCst);
            for (generation, id) in trashed {
                if generation == current {
                    let _ = s.tree.remove(id);
                }
            }
        }
    }
}

/// Pide parar la búsqueda de duplicados; el comando `duplicates` pendiente termina con `error.cancelled`.
#[tauri::command]
fn cancel_duplicates(st: St<'_>) -> bool {
    let busy = st.dup_busy.load(SeqCst);
    if busy {
        st.dup_cancel.store(true, SeqCst);
    }
    busy
}

/// Guarda el escaneo cargado en el historial. Se permite durante una búsqueda de duplicados
/// (los dos leen el árbol); no durante un escaneo.
#[tauri::command]
async fn history_save(st: St<'_>) -> Res<HistoryEntry> {
    if st.busy.load(SeqCst) {
        return Err(msg::scan_busy());
    }
    with_scan(&st, |s| History::open()?.save(s)).await
}

#[tauri::command]
async fn history_list() -> Res<Vec<HistoryEntry>> {
    blocking(|| History::open()?.list()).await
}

#[tauri::command]
async fn history_delete(id: String) -> Res<bool> {
    blocking(move || History::open()?.delete(&id)).await
}

#[tauri::command]
async fn history_clear() -> Res<u64> {
    blocking(|| History::open()?.clear()).await
}

/// Compara con un resumen y deja la comparación activa en el árbol. La comparación se cambia con
/// el árbol bajo lectura (cerrojo propio), así que no espera a una búsqueda de duplicados.
#[tauri::command]
async fn compare(st: St<'_>, id: String, limit: u32) -> Res<CompareResult> {
    if st.busy.load(SeqCst) {
        return Err(msg::scan_busy());
    }
    with_scan(&st, move |s| History::open()?.compare(s, &id, limit)).await
}

#[tauri::command]
async fn compare_clear(st: St<'_>) -> Res<()> {
    let st = st.inner().clone();
    blocking(move || {
        if let Some(s) = st.scan.read().map_err(poisoned)?.as_ref() {
            s.tree.set_comparison(None);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn export_file(name: String, data: String, base64: Option<bool>) -> Res<ExportResult> {
    blocking(move || export::export_file(&name, &data, base64.unwrap_or(false))).await
}

#[tauri::command]
async fn reveal_export(path: String) -> Res<ActionResult> {
    blocking(move || export::reveal_export(&path)).await
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
            rescan,
            refresh,
            cancel_scan,
            slice,
            children,
            search,
            ext_stats,
            node_path,
            node_info,
            action,
            duplicates,
            cancel_duplicates,
            history_save,
            history_list,
            history_delete,
            history_clear,
            compare,
            compare_clear,
            export_file,
            reveal_export,
            elevation,
            relaunch_elevated
        ])
        .run(tauri::generate_context!())
        .expect("error while starting TesseraFS");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_jobs_and_duplicates_exclude_each_other() {
        let st = AppState::default();
        // Un escaneo, rescan o refresh a la vez; limpia la cancelación pendiente
        st.cancel.store(true, SeqCst);
        begin_tree_job(&st).unwrap();
        assert!(!st.cancel.load(SeqCst));
        assert_eq!(begin_tree_job(&st).unwrap_err().code, "error.scanBusy");
        // Durante el trabajo no empieza una búsqueda de duplicados (y no se queda marcada)
        assert_eq!(begin_duplicates(&st).unwrap_err().code, "error.scanBusy");
        assert!(!st.dup_busy.load(SeqCst));
        st.busy.store(false, SeqCst);
        // Durante la búsqueda no empieza un trabajo del árbol (y `busy` vuelve a quedar libre)
        begin_duplicates(&st).unwrap();
        assert_eq!(begin_duplicates(&st).unwrap_err().code, "error.dupBusy");
        assert_eq!(begin_tree_job(&st).unwrap_err().code, "error.dupBusy");
        assert!(!st.busy.load(SeqCst));
        end_duplicates(&st);
        begin_tree_job(&st).unwrap();
    }
}
