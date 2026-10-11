// TesseraFS, edición de escritorio: Tauri 2 + tessera-core en el mismo proceso.
// Los comandos siguen la tabla del contrato en docs/ARQUITECTURA.md. Los errores son
// `EngineMessage` (código + parámetros + texto en inglés) que la interfaz traduce.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod notify;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex, PoisonError, RwLock};

use tauri::ipc::{Channel, InvokeBody, Request, Response};
#[cfg(windows)]
use tauri::Manager;
use tauri::{AppHandle, State, WebviewWindowBuilder};
use tessera_core::{
    export, launch, links, msg, ops, saved, schedule, slice, sys, ActionKind, ActionResult, ChildrenResponse, CompareResult, DupProgress, DupResult,
    ElevationInfo, EngineChoice, EngineMessage, ExportResult, ExtStat, History, HistoryEntry, NodeRow, RefreshResult, RescanResult, Scan, ScanOptions,
    ScanProgress, ScanResult, ScheduleInfo, SearchResponse, SortKey, SystemInfo, TrendPoint, TrendQuery, VolumeInfo,
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
    /// Carpeta pedida al abrir (`SystemInfo.launchPath`, ver [`launch::launch_path`]); no cambia.
    launch_path: Option<String>,
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

/// Sistema, separador de rutas, acciones disponibles (la interfaz oculta las demás) y la carpeta
/// pedida al abrir, si la hay.
#[tauri::command]
fn system(st: St<'_>) -> SystemInfo {
    SystemInfo { launch_path: st.launch_path.clone(), ..tessera_core::system_info() }
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

/// Contenido de un `.tessera` que llega a `open_scan`: el cuerpo binario de `invoke('open_scan', bytes)`
/// o, si el WebView tuvo que usar `postMessage` en vez del protocolo `ipc:`, el mismo contenido como
/// arreglo JSON de bytes.
fn saved_bytes(body: &InvokeBody) -> Res<Vec<u8>> {
    let bad = || msg::scan_open_failed("Expected the contents of a .tessera file as binary data");
    match body {
        InvokeBody::Raw(b) => Ok(b.clone()),
        InvokeBody::Json(serde_json::Value::Array(v)) => v.iter().map(|x| x.as_u64().and_then(|n| u8::try_from(n).ok())).collect::<Option<Vec<u8>>>().ok_or_else(bad),
        InvokeBody::Json(_) => Err(bad()),
    }
}

/// Abre un escaneo guardado (`.tessera`) y lo deja cargado en lugar del actual, «sin conexión»
/// (`ScanResult.offline`): como un escaneo nuevo, con ids nuevos y sin comparación. Respeta los cerrojos
/// de un escaneo (`error.scanBusy`, `error.dupBusy`); `scan.openFailed` si el archivo no sirve (el
/// escaneo anterior sigue cargado). La interfaz llama `invoke('open_scan', bytes)` con un `Uint8Array`.
#[tauri::command]
async fn open_scan(st: St<'_>, request: Request<'_>) -> Res<ScanResult> {
    let data = saved_bytes(request.body())?;
    tree_job(&st, move |job| {
        let s = saved::open_scan(&data)?;
        drop(data);
        let res = s.result.clone();
        *job.scan.write().map_err(poisoned)? = Some(s);
        job.generation.fetch_add(1, SeqCst);
        Ok(res)
    })
    .await
}

/// Guarda el escaneo cargado completo en Descargas\TesseraFS como `<raíz> <fecha>.tessera` (ver
/// [`saved::save_scan`]). No durante un escaneo, rescan o refresh (`error.scanBusy`), como `history_save`.
#[tauri::command]
async fn save_scan(st: St<'_>) -> Res<ExportResult> {
    if st.busy.load(SeqCst) {
        return Err(msg::scan_busy());
    }
    with_scan(&st, saved::save_scan).await
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

/// Enlaces rotos bajo `root` (ver [`links`]), ordenados por ruta. El árbol se lee bajo lectura sólo para
/// tomar los candidatos y para las filas: el disco se mira sin cerrojo (las consultas, la papelera y un
/// escaneo nuevo no esperan). Un nodo no válido viaja en `SearchResponse.error`, como en `search`; si
/// mientras tanto se cargó otro escaneo, también `error.invalidNode`. Escaneo abierto desde archivo:
/// `scan.offline`.
#[tauri::command]
async fn broken_links(st: St<'_>, root: u32, limit: u32) -> Res<SearchResponse> {
    let st = st.inner().clone();
    blocking(move || {
        let (items, generation) = {
            let g = st.scan.read().map_err(poisoned)?;
            let s = g.as_ref().ok_or_else(msg::no_scan)?;
            s.check_online()?;
            match links::candidates(&s.tree, root) {
                Ok(items) => (items, st.generation.load(SeqCst)),
                Err(e) => return Ok(SearchResponse { error: Some(e), ..Default::default() }),
            }
        };
        let broken = links::check(&items);
        let g = st.scan.read().map_err(poisoned)?;
        let s = g.as_ref().ok_or_else(msg::no_scan)?;
        if st.generation.load(SeqCst) != generation {
            return Ok(SearchResponse { error: Some(msg::invalid_node(root)), ..Default::default() });
        }
        // Lo enviado a la papelera o vuelto a escanear mientras tanto ya no está vivo y no sale
        Ok(links::response(&s.tree, broken, limit))
    })
    .await
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
/// Con un escaneo abierto desde archivo, todas fallan con `scan.offline` (como `error.noScan`, en el
/// `ActionResult`).
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
            if let Err(e) = s.check_online() {
                return Ok(ActionResult::fail(e));
            }
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
    s.check_online()?;
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

/// Tamaño del nodo `id` en cada resumen de su raíz, del más antiguo al más reciente (sin el escaneo
/// actual). El árbol se lee bajo lectura sólo para tomar la ruta del nodo; los resúmenes se leen después,
/// en paralelo y sin cerrojo. `scan.offline` con un escaneo abierto desde archivo.
#[tauri::command]
async fn history_trend(st: St<'_>, id: u32) -> Res<Vec<TrendPoint>> {
    let st = st.inner().clone();
    blocking(move || {
        let q = {
            let g = st.scan.read().map_err(poisoned)?;
            TrendQuery::new(g.as_ref().ok_or_else(msg::no_scan)?, id)?
        };
        History::open()?.trend(&q)
    })
    .await
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

/// El escaneo programado y su última ejecución. Sólo consulta (`schtasks /Query`, `systemctl is-enabled`).
#[tauri::command]
async fn schedule_get() -> Res<ScheduleInfo> {
    blocking(schedule::get).await
}

/// Crea, cambia (`cfg`) o quita (`null`) el escaneo programado: tarea del Programador de tareas o
/// temporizador de systemd del usuario. `cfg` llega como JSON para responder `schedule.invalid` (y no un
/// error de deserialización) si no tiene la forma del contrato.
#[tauri::command]
async fn schedule_set(cfg: Option<serde_json::Value>) -> Res<ScheduleInfo> {
    blocking(move || schedule::set(cfg.map(schedule::from_json).transpose()?)).await
}

/// `--scheduled-scan` (lo lanza el Programador de tareas o systemd): escanea, guarda el resumen, avisa si
/// queda poco espacio y termina con 0, o con 1 si falló (el error queda en `schedule-last.json`).
fn scheduled_scan() -> i32 {
    let run = schedule::scheduled_scan(&notify::show);
    if let Some(e) = &run.error {
        eprintln!("TesseraFS: scheduled scan failed: {}", e.message);
    }
    i32::from(!run.ok)
}

/// `--restore-schedule` (lo lanza el instalador de Windows): vuelve a crear la tarea del escaneo programado
/// si hay uno guardado. Termina con 0, o con 1 si no se pudo.
fn restore_schedule() -> i32 {
    match schedule::restore() {
        Ok(_) => 0,
        Err(e) => {
            eprintln!("TesseraFS: couldn't restore the scheduled scan: {}", e.message);
            1
        }
    }
}

#[tauri::command]
fn elevation() -> ElevationInfo {
    sys::elevation()
}

/// Relanza como administrador; la ventana nueva vuelve a la carpeta pedida al abrir, si la había.
#[tauri::command]
async fn relaunch_elevated(app: AppHandle, st: St<'_>) -> Res<()> {
    let args = st.launch_path.as_deref().map(launch::quote_arg).unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || sys::relaunch_elevated(&args)).await.map_err(join_error)??;
    app.exit(0);
    Ok(())
}

fn main() {
    // Escaneo programado: sin ventana ni nada de Tauri (antes de `launch_path`, que ignora los argumentos con «-»)
    if schedule::requested(std::env::args_os().skip(1)) {
        std::process::exit(scheduled_scan());
    }
    if schedule::has_arg(std::env::args_os().skip(1), schedule::RESTORE_ARG) {
        std::process::exit(restore_schedule());
    }
    // WebKitGTK con NVIDIA o Wayland deja a veces la ventana en blanco con el renderizador DMA-BUF
    // (documentado por Tauri y WebKitGTK); se desactiva salvo que el usuario diga otra cosa.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // «Analizar con TesseraFS» (Explorador) o `tesserafs-desktop <ruta>`: sólo si es una carpeta que existe
    let launch_path = launch::launch_path(std::env::args_os().skip(1));
    tauri::Builder::default()
        .manage(Arc::new(AppState { launch_path, ..AppState::default() }))
        .setup(|app| {
            let cfg = app.config().app.windows.first().cloned().ok_or("Missing window configuration")?;
            #[cfg_attr(not(windows), allow(unused_mut))]
            let mut b = WebviewWindowBuilder::from_config(app.handle(), &cfg)?;
            // La ventana se crea aquí para separar los datos de WebView2 del proceso elevado:
            // un mismo directorio no se puede compartir entre niveles de integridad distintos.
            #[cfg(windows)]
            if sys::elevation().elevated {
                b = b.data_directory(app.path().app_local_data_dir()?.join("EBWebView-admin"));
            }
            b.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            system,
            volumes,
            scan,
            rescan,
            refresh,
            cancel_scan,
            slice,
            children,
            search,
            ext_stats,
            broken_links,
            node_path,
            node_info,
            action,
            duplicates,
            cancel_duplicates,
            history_save,
            history_list,
            history_delete,
            history_clear,
            history_trend,
            compare,
            compare_clear,
            export_file,
            save_scan,
            open_scan,
            reveal_export,
            elevation,
            relaunch_elevated,
            schedule_get,
            schedule_set
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

    #[test]
    fn open_scan_body() {
        // Binario (protocolo ipc:) o arreglo JSON de bytes (postMessage); otra cosa, scan.openFailed
        assert_eq!(saved_bytes(&InvokeBody::Raw(vec![0x1f, 0x8b, 0])).unwrap(), [0x1f, 0x8b, 0]);
        assert_eq!(saved_bytes(&InvokeBody::Json(serde_json::json!([31, 139, 255]))).unwrap(), [31, 139, 255]);
        for bad in [serde_json::json!({ "data": [1] }), serde_json::json!([1, 256]), serde_json::json!([-1]), serde_json::json!("x")] {
            assert_eq!(saved_bytes(&InvokeBody::Json(bad)).unwrap_err().code, "scan.openFailed");
        }
        // Lo que llega se abre (o no) como un escaneo guardado
        let e = saved::open_scan(&saved_bytes(&InvokeBody::Raw(b"hola".to_vec())).unwrap()).err().unwrap();
        assert_eq!((e.code.as_str(), e.get("error").map(|p| p.to_string())), ("scan.openFailed", Some("Not a gzip file".into())));
    }
}
