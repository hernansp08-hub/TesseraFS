//! Escaneo programado (sólo la edición de escritorio). El sistema lanza `<exe> --scheduled-scan` a la hora
//! pedida —Programador de tareas en Windows, temporizador de systemd del usuario en Linux— y la app, sin
//! ventana, escanea la carpeta (motor `auto`), guarda un resumen en el historial (con su retención) y, si el
//! espacio libre de su unidad baja del porcentaje pedido, avisa con una notificación del sistema.
//!
//! En la carpeta de datos ([`sys::data_dir`]):
//! - `schedule.json`: el [`ScheduleConfig`] tal cual (camelCase). La tarea sólo lleva `--scheduled-scan`
//!   (una línea de órdenes corta y sin problemas de comillas): la configuración se lee en cada ejecución.
//! - `schedule-last.json`: el [`ScheduleRun`] de la última ejecución.
//!
//! Las órdenes de `schtasks` y las unidades de systemd se construyen con funciones puras (con pruebas); sólo
//! [`set`] y [`get`] ejecutan `schtasks` o `systemctl`. La notificación la pone quien llama ([`Notify`]): así
//! las pruebas no muestran ninguna.

use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use crate::history::History;
use crate::msg;
use crate::scan::{self, ScanOptions};
use crate::sys;
use crate::types::{EngineChoice, EngineMessage, ScheduleConfig, ScheduleEvery, ScheduleInfo, ScheduleRun, VolumeInfo};

/// Argumento con el que el sistema lanza el escaneo programado.
pub const ARG: &str = "--scheduled-scan";
/// Argumento con el que el instalador vuelve a crear la tarea ([`restore`]).
pub const RESTORE_ARG: &str = "--restore-schedule";
/// Tarea del Programador de tareas, en la carpeta raíz: cualquier usuario puede crear tareas ahí sin
/// administrador, y al quitarla no queda una carpeta vacía.
pub const TASK_NAME: &str = "TesseraFS scheduled scan";
/// Unidades de systemd del usuario (en `$XDG_CONFIG_HOME/systemd/user`).
pub const SERVICE: &str = "tesserafs-scan.service";
pub const TIMER: &str = "tesserafs-scan.timer";

const CONFIG_FILE: &str = "schedule.json";
const LAST_FILE: &str = "schedule-last.json";

/// Textos de reserva del aviso (en inglés), si la programación no trae los de la interfaz.
const DEFAULT_TITLE: &str = "TesseraFS: low disk space";
const DEFAULT_BODY: &str = "{drive} has {free} free ({pct} %). Open TesseraFS to see what takes up space.";

/// Muestra una notificación del sistema (título, texto). El error, en inglés, sólo se registra.
pub type Notify<'a> = &'a dyn Fn(&str, &str) -> Result<(), String>;

fn now() -> u64 {
    crate::query::now_secs() as u64
}

/// Se pidió el escaneo programado: `--scheduled-scan` en cualquier posición.
pub fn requested<S: AsRef<OsStr>>(args: impl IntoIterator<Item = S>) -> bool {
    has_arg(args, ARG)
}

/// `arg` está, tal cual, entre los argumentos.
pub fn has_arg<S: AsRef<OsStr>>(args: impl IntoIterator<Item = S>, arg: &str) -> bool {
    args.into_iter().any(|a| a.as_ref() == OsStr::new(arg))
}

// ---------- Validación ----------

/// «HH:MM» (o «H:MM») → (hora, minuto).
fn parse_time(t: &str) -> Option<(u8, u8)> {
    let (h, m) = t.trim().split_once(':')?;
    let digits = |s: &str, max: usize| !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit());
    if !(digits(h, 2) && digits(m, 2) && m.len() == 2) {
        return None;
    }
    let (h, m) = (h.parse::<u8>().ok()?, m.parse::<u8>().ok()?);
    (h < 24 && m < 60).then_some((h, m))
}

/// Lee una programación del JSON de la interfaz (`schedule.invalid` si no tiene la forma del contrato).
pub fn from_json(v: serde_json::Value) -> Result<ScheduleConfig, EngineMessage> {
    serde_json::from_value(v).map_err(|e| msg::schedule_invalid(&e.to_string()))
}

/// Comprueba y normaliza una programación (`schedule.invalid`): hora «HH:MM» (con dos cifras), día 0–6 en
/// la semanal (y ninguno en la diaria), porcentaje 0–99 y una carpeta que existe (con la ruta normalizada
/// como la de un escaneo: «c:» → «C:\»).
pub fn validate(mut cfg: ScheduleConfig) -> Result<ScheduleConfig, EngineMessage> {
    let invalid = msg::schedule_invalid;
    let (h, m) = parse_time(&cfg.time).ok_or_else(|| invalid(&format!("the time must be HH:MM, not \"{}\"", cfg.time)))?;
    cfg.time = format!("{h:02}:{m:02}");
    match (cfg.every, cfg.weekday) {
        (ScheduleEvery::Daily, _) => cfg.weekday = None,
        (ScheduleEvery::Weekly, Some(d)) if d <= 6 => {}
        (ScheduleEvery::Weekly, Some(d)) => return Err(invalid(&format!("the weekday must be from 0 (Sunday) to 6 (Saturday), not {d}"))),
        (ScheduleEvery::Weekly, None) => return Err(invalid("a weekly schedule needs a weekday")),
    }
    if cfg.min_free_pct > 99 {
        return Err(invalid(&format!("the free space percentage must be from 0 to 99, not {}", cfg.min_free_pct)));
    }
    let path = scan::normalize_path(&cfg.path).map_err(|e| invalid(&e.message))?;
    sys::check_folder(&path).map_err(|e| invalid(&e.message))?;
    cfg.path = path;
    Ok(cfg)
}

// ---------- Aviso de poco espacio ----------

/// Avisar: hay umbral (`pct` > 0) y el espacio libre es menos del `pct` % del total.
pub fn should_alert(free: u64, total: u64, pct: u32) -> bool {
    pct > 0 && total > 0 && u128::from(free) * 100 < u128::from(pct) * u128::from(total)
}

/// Porcentaje libre entero, redondeado hacia abajo (si avisa, siempre es menor que el umbral).
pub fn free_pct(free: u64, total: u64) -> u64 {
    if total == 0 {
        0
    } else {
        (u128::from(free.min(total)) * 100 / u128::from(total)) as u64
    }
}

/// Tamaño corto para el aviso, sin catálogos: un decimal y unidad («12.3 GB»; KB = 1024 bytes).
pub fn short_size(bytes: u64) -> String {
    msg::human_bytes(bytes)
}

/// Tamaño con los formatos del idioma de la interfaz (`sizes`: KB, MB, GB y TB con `{int}` y `{frac}`, ver
/// [`ScheduleMessages`](crate::types::ScheduleMessages)), con un decimal (KB sin decimales, si su formato
/// no lleva `{frac}`), como en la interfaz. Sin ellos, menos de 1 KB o si no son cuatro, [`short_size`].
pub fn localized_size(bytes: u64, sizes: Option<&[String]>) -> String {
    let Some(sizes) = sizes.filter(|s| s.len() == 4) else { return short_size(bytes) };
    let i = match bytes {
        b if b >= 1 << 40 => 3,
        b if b >= 1 << 30 => 2,
        b if b >= 1 << 20 => 1,
        b if b >= 1 << 10 => 0,
        _ => return short_size(bytes),
    };
    let (pattern, base, b) = (&sizes[i], 1u128 << (10 * (i + 1)), u128::from(bytes));
    if pattern.contains("{frac}") {
        let tenths = (b * 10 + base / 2) / base;
        pattern.replace("{int}", &(tenths / 10).to_string()).replace("{frac}", &(tenths % 10).to_string())
    } else {
        pattern.replace("{int}", &((b + base / 2) / base).to_string())
    }
}

/// La unidad para el aviso: «C:» en Windows (como la interfaz) y el punto de montaje en Linux («/», «/home»).
pub fn drive_label(root: &str) -> String {
    let b = root.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        return root[..2].to_ascii_uppercase();
    }
    match root.trim_end_matches(['\\', '/']) {
        "" if root.starts_with('/') => "/".to_string(),
        t => t.to_string(),
    }
}

/// Sustituye `{drive}`, `{free}` (el tamaño ya escrito) y `{pct}` en una sola pasada: lo sustituido no se
/// vuelve a mirar y el resto del texto, otras llaves incluidas, queda igual.
pub fn fill(template: &str, drive: &str, free: &str, pct: u64) -> String {
    let values = [("{drive}", drive.to_string()), ("{free}", free.to_string()), ("{pct}", pct.to_string())];
    let mut out = String::with_capacity(template.len() + 16);
    let mut rest = template;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        match values.iter().find(|(k, _)| rest.starts_with(k)) {
            Some((k, v)) => {
                out.push_str(v);
                rest = &rest[k.len()..];
            }
            None => {
                out.push('{');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Título y texto del aviso: los de la programación (o los de reserva, en inglés, si faltan o están
/// vacíos) con los huecos rellenos.
pub fn alert_texts(cfg: &ScheduleConfig, drive: &str, free: u64, total: u64) -> (String, String) {
    fn pick<'a>(s: Option<&'a str>, default: &'static str) -> &'a str {
        s.filter(|s| !s.trim().is_empty()).unwrap_or(default)
    }
    let title = pick(cfg.messages.as_ref().map(|m| m.title.as_str()), DEFAULT_TITLE);
    let body = pick(cfg.messages.as_ref().map(|m| m.body.as_str()), DEFAULT_BODY);
    let pct = free_pct(free, total);
    let free = localized_size(free, cfg.messages.as_ref().and_then(|m| m.sizes.as_deref()));
    (fill(title, drive, &free, pct), fill(body, drive, &free, pct))
}

// ---------- Ejecución ----------

/// Volumen de `path` (la raíz se calcula por la ruta, aunque la carpeta ya no exista).
fn volume_of(path: &str) -> Option<VolumeInfo> {
    let p = scan::normalize_path(path).ok()?;
    let root = sys::volume_root_of(&p).unwrap_or(p);
    sys::volume_info(&root)
}

/// Ejecuta el escaneo programado `cfg`: escanea `cfg.path` (motor `auto`), guarda el resumen en el
/// historial de `history_dir` (con su retención), mira el espacio libre de su unidad —también si el
/// escaneo falla— y, si baja del umbral, avisa con `notify`. Escribe el resultado en
/// `<data_dir>/schedule-last.json` y lo devuelve. Un aviso que no se puede mostrar no es un error de la
/// ejecución: queda `alerted: false` y se registra en la salida de errores (en Linux, el diario de systemd).
pub fn run_scheduled(cfg: &ScheduleConfig, data_dir: &Path, history_dir: &Path, notify: Notify) -> ScheduleRun {
    let mut run = ScheduleRun::default();
    let mut error = None;
    let cancel = AtomicBool::new(false);
    match scan::scan(&cfg.path, EngineChoice::Auto, &ScanOptions::default(), &|_| {}, &cancel) {
        Ok(s) => {
            run.bytes = Some(s.result.bytes);
            if let Err(e) = History::at(history_dir).save(&s) {
                error = Some(e);
            }
        }
        Err(e) => error = Some(e),
    }
    if let Some(v) = volume_of(&cfg.path) {
        let alerted = should_alert(v.free, v.total, cfg.min_free_pct) && {
            let (title, body) = alert_texts(cfg, &drive_label(&v.path), v.free, v.total);
            match notify(&title, &body) {
                Ok(()) => true,
                Err(e) => {
                    eprintln!("TesseraFS: couldn't show the low disk space notification: {e}");
                    false
                }
            }
        };
        (run.free, run.total, run.alerted) = (Some(v.free), Some(v.total), Some(alerted));
    }
    run.ok = error.is_none();
    run.error = error;
    run.at = now();
    save_last(data_dir, &run);
    run
}

/// [`run_scheduled`] con la programación de `<data_dir>/schedule.json`. Sin ella (o si no se puede leer),
/// la ejecución falla con `schedule.invalid`, que también queda en `schedule-last.json`.
pub fn run_from(data_dir: &Path, history_dir: &Path, notify: Notify) -> ScheduleRun {
    let cfg = match read_config(data_dir) {
        Ok(Some(cfg)) => cfg,
        Ok(None) => return failed_run(data_dir, msg::schedule_invalid("there is no scheduled scan (schedule.json not found)")),
        Err(e) => return failed_run(data_dir, e),
    };
    run_scheduled(&cfg, data_dir, history_dir, notify)
}

/// Lo que hace `--scheduled-scan`: [`run_from`] con la carpeta de datos ([`sys::data_dir`]) y el historial
/// ([`History::open`]) de siempre, o los de `TESSERA_DATA_DIR` y `TESSERA_HISTORY_DIR`.
pub fn scheduled_scan(notify: Notify) -> ScheduleRun {
    match sys::data_dir().and_then(|d| Ok((d, History::open()?.dir().to_path_buf()))) {
        Ok((data, history)) => run_from(&data, &history, notify),
        Err(e) => ScheduleRun { at: now(), ok: false, error: Some(e), ..ScheduleRun::default() },
    }
}

fn failed_run(data_dir: &Path, e: EngineMessage) -> ScheduleRun {
    let run = ScheduleRun { at: now(), ok: false, error: Some(e), ..ScheduleRun::default() };
    save_last(data_dir, &run);
    run
}

fn save_last(data_dir: &Path, run: &ScheduleRun) {
    if let Err(e) = write_json(&data_dir.join(LAST_FILE), run) {
        eprintln!("TesseraFS: couldn't write {LAST_FILE}: {}", sys::io_error_text(&e));
    }
}

// ---------- Archivos ----------

/// Escribe `value` como JSON legible en `path` (creando la carpeta): primero en `<path>.tmp` y luego lo
/// renombra, así nunca queda a medias.
fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(io::Error::from)?)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// La programación guardada: `None` si no hay; `schedule.invalid` si el archivo no se puede leer.
pub fn read_config(data_dir: &Path) -> Result<Option<ScheduleConfig>, EngineMessage> {
    match fs::read(data_dir.join(CONFIG_FILE)) {
        Ok(b) => serde_json::from_slice(&b).map(Some).map_err(|e| msg::schedule_invalid(&format!("{CONFIG_FILE}: {e}"))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(msg::schedule_invalid(&format!("{CONFIG_FILE}: {}", sys::io_error_text(&e)))),
    }
}

/// La última ejecución, si la hay y se puede leer.
pub fn read_last(data_dir: &Path) -> Option<ScheduleRun> {
    serde_json::from_slice(&fs::read(data_dir.join(LAST_FILE)).ok()?).ok()
}

/// [`ScheduleInfo`] de la carpeta de datos: la programación sólo si el sistema la tiene (`installed`: si el
/// usuario quitó la tarea o el temporizador por su cuenta, null) y la última ejecución, si se sabe.
pub fn info(data_dir: &Path, supported: bool, installed: bool) -> ScheduleInfo {
    let schedule = if supported && installed { read_config(data_dir).ok().flatten() } else { None };
    ScheduleInfo { supported, schedule, last_run: read_last(data_dir) }
}

// ---------- Crear, cambiar y quitar ----------

/// Estado del escaneo programado (`scheduleGet`). Sólo consulta: `schtasks /Query` o `systemctl is-enabled`.
pub fn get() -> Result<ScheduleInfo, EngineMessage> {
    let data = sys::data_dir()?;
    let supported = os::supported();
    Ok(info(&data, supported, supported && os::installed()))
}

/// Crea o sustituye el escaneo programado (`None`: lo quita) (`scheduleSet`). Es configuración persistente
/// del sistema: sólo cuando el usuario lo pide. `schedule.unsupported` si el sistema no programa escaneos,
/// `schedule.invalid` si `cfg` no vale ([`validate`]) y `schedule.failed` si schtasks o systemctl fallan
/// (entonces `schedule.json` vuelve a ser el de antes).
pub fn set(cfg: Option<ScheduleConfig>) -> Result<ScheduleInfo, EngineMessage> {
    if !os::supported() {
        return Err(msg::schedule_unsupported());
    }
    let cfg = cfg.map(validate).transpose()?;
    let file = sys::data_dir()?.join(CONFIG_FILE);
    let failed = |e: String| msg::schedule_failed(&e);
    match cfg {
        Some(cfg) => {
            let exe = os::exe().map_err(failed)?;
            let before = fs::read(&file).ok();
            write_json(&file, &cfg).map_err(|e| failed(sys::io_error_text(&e)))?;
            if let Err(e) = os::install(&cfg, &exe) {
                match before {
                    Some(b) => {
                        let _ = fs::write(&file, b);
                    }
                    // No había ninguna: se quita también lo que se llegó a crear
                    None => {
                        let _ = fs::remove_file(&file);
                        let _ = os::uninstall();
                    }
                }
                return Err(failed(e));
            }
        }
        None => {
            os::uninstall().map_err(failed)?;
            if let Err(e) = fs::remove_file(&file) {
                if e.kind() != io::ErrorKind::NotFound {
                    return Err(failed(sys::io_error_text(&e)));
                }
            }
        }
    }
    get()
}

/// `--restore-schedule`, desde el instalador de Windows: al actualizar, el instalador desinstala antes la
/// versión anterior y esa desinstalación quita la tarea, pero `schedule.json` queda (como el historial).
/// Si lo hay, vuelve a crear la tarea con este ejecutable; `false` si no había nada que crear.
pub fn restore() -> Result<bool, EngineMessage> {
    if !os::supported() {
        return Ok(false);
    }
    let Some(cfg) = read_config(&sys::data_dir()?)? else { return Ok(false) };
    let failed = |e: String| msg::schedule_failed(&e);
    os::install(&cfg, &os::exe().map_err(failed)?).map_err(failed)?;
    Ok(true)
}

// ---------- Órdenes y unidades (funciones puras) ----------

/// Días del XML de las tareas, de domingo (0) a sábado (6).
const TASK_DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/// Días de `OnCalendar=` de systemd.
const SYSTEMD_DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

fn weekday(cfg: &ScheduleConfig) -> usize {
    usize::from(cfg.weekday.unwrap_or(0).min(6))
}

fn strings<const N: usize>(a: [&str; N]) -> Vec<String> {
    a.map(String::from).into()
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Primer arranque de la tarea (`StartBoundary`, hora local): hoy a `cfg.time` si todavía no ha llegado y,
/// si no, mañana (así crear la tarea no cuenta como un arranque perdido). `now` = (año, mes, día, hora,
/// minuto) de ahora y `tomorrow` = (año, mes, día) de mañana.
pub fn start_boundary(cfg: &ScheduleConfig, now: (i64, u32, u32, u32, u32), tomorrow: (i64, u32, u32)) -> String {
    let (h, m) = parse_time(&cfg.time).unwrap_or((0, 0));
    let (y, mo, d) = if (u32::from(h), u32::from(m)) > (now.3, now.4) { (now.0, now.1, now.2) } else { tomorrow };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:00")
}

/// XML de la tarea (esquema 1.2) para `schtasks /Create /XML`: del usuario actual, sólo con la sesión
/// iniciada y sin administrador (`InteractiveToken`, `LeastPrivilege`), que lanza `"<exe>" --scheduled-scan`
/// cada día o cada semana desde `start` ([`start_boundary`]). A diferencia de `/SC`, también con el portátil
/// a batería y, si el equipo estaba apagado a esa hora, en cuanto se pueda (`StartWhenAvailable`, como
/// `Persistent=true` en systemd).
pub fn task_xml(cfg: &ScheduleConfig, exe: &str, start: &str) -> String {
    let day = format!("          <{} />", TASK_DAYS[weekday(cfg)]);
    let schedule = match cfg.every {
        ScheduleEvery::Daily => ["      <ScheduleByDay>", "        <DaysInterval>1</DaysInterval>", "      </ScheduleByDay>"].join("\r\n"),
        ScheduleEvery::Weekly => {
            ["      <ScheduleByWeek>", "        <DaysOfWeek>", &day, "        </DaysOfWeek>", "        <WeeksInterval>1</WeeksInterval>", "      </ScheduleByWeek>"].join("\r\n")
        }
    };
    [
        r#"<?xml version="1.0" encoding="UTF-16"?>"#,
        r#"<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">"#,
        "  <RegistrationInfo>",
        &format!("    <Description>{}</Description>", UNIT_HEADER.trim_start_matches("# ")),
        "  </RegistrationInfo>",
        "  <Triggers>",
        "    <CalendarTrigger>",
        &format!("      <StartBoundary>{start}</StartBoundary>"),
        &schedule,
        "    </CalendarTrigger>",
        "  </Triggers>",
        "  <Principals>",
        r#"    <Principal id="Author">"#,
        "      <LogonType>InteractiveToken</LogonType>",
        "      <RunLevel>LeastPrivilege</RunLevel>",
        "    </Principal>",
        "  </Principals>",
        "  <Settings>",
        "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
        "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
        "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
        "    <StartWhenAvailable>true</StartWhenAvailable>",
        "    <ExecutionTimeLimit>PT8H</ExecutionTimeLimit>",
        "  </Settings>",
        r#"  <Actions Context="Author">"#,
        "    <Exec>",
        &format!("      <Command>\"{}\"</Command>", xml_escape(exe)),
        &format!("      <Arguments>{ARG}</Arguments>"),
        "    </Exec>",
        "  </Actions>",
        "</Task>",
        "",
    ]
    .join("\r\n")
}

/// `schtasks /Create`: crea o sustituye (`/F`) la tarea con el XML de [`task_xml`] guardado en `xml_file`.
pub fn schtasks_create_args(xml_file: &str) -> Vec<String> {
    strings(["/Create", "/F", "/TN", TASK_NAME, "/XML", xml_file])
}

/// `schtasks /Query`: termina con 0 si la tarea existe.
pub fn schtasks_query_args() -> Vec<String> {
    strings(["/Query", "/TN", TASK_NAME])
}

/// `schtasks /Delete` sin preguntar.
pub fn schtasks_delete_args() -> Vec<String> {
    strings(["/Delete", "/F", "/TN", TASK_NAME])
}

/// Un argumento entre comillas para `ExecStart=` de systemd: `\` y `"` escapados, `%` (especificadores) y
/// `$` (variables) duplicados y los saltos de línea como `\n`.
pub fn systemd_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str(r"\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str(r"\n"),
            '%' => out.push_str("%%"),
            '$' => out.push_str("$$"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

const UNIT_HEADER: &str = "# Created by TesseraFS: change or remove the scheduled scan from the app";

/// `tesserafs-scan.service`: el escaneo, una vez (`oneshot`) y con prioridad baja.
pub fn systemd_service(exe: &str) -> String {
    let exec = format!("ExecStart={} {ARG}", systemd_quote(exe));
    [UNIT_HEADER, "[Unit]", "Description=TesseraFS scheduled scan", "", "[Service]", "Type=oneshot", &exec, "Nice=10", ""].join("\n")
}

/// `OnCalendar=` de systemd: «*-*-* HH:MM:00» cada día o «Sun *-*-* HH:MM:00» cada semana (hora local).
pub fn on_calendar(cfg: &ScheduleConfig) -> String {
    let at = format!("*-*-* {}:00", cfg.time);
    match cfg.every {
        ScheduleEvery::Daily => at,
        ScheduleEvery::Weekly => format!("{} {at}", SYSTEMD_DAYS[weekday(cfg)]),
    }
}

/// `tesserafs-scan.timer`: lanza el servicio a esa hora; con `Persistent=true`, si el equipo estaba apagado,
/// en cuanto se enciende.
pub fn systemd_timer(cfg: &ScheduleConfig) -> String {
    let when = format!("OnCalendar={}", on_calendar(cfg));
    [UNIT_HEADER, "[Unit]", "Description=TesseraFS scheduled scan", "", "[Timer]", &when, "Persistent=true", "", "[Install]", "WantedBy=timers.target", ""]
        .join("\n")
}

// ---------- Órdenes del sistema ----------

/// Salida de una orden en una línea (sin saltos ni espacios repetidos), hasta 300 caracteres.
fn summary(raw: &[u8]) -> Option<String> {
    let line = decode(raw).split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    Some(if line.chars().count() > 300 { line.chars().take(299).chain(['…']).collect() } else { line })
}

/// Texto de la salida de una orden: UTF-8 o, si no lo es, la página de códigos OEM de la consola
/// (la que usan schtasks y las demás órdenes de Windows).
#[cfg(windows)]
fn decode(raw: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP};
    if let Ok(s) = std::str::from_utf8(raw) {
        return s.to_string();
    }
    let len = i32::try_from(raw.len()).unwrap_or(i32::MAX);
    let n = unsafe { MultiByteToWideChar(CP_OEMCP, 0, raw.as_ptr(), len, std::ptr::null_mut(), 0) };
    if n <= 0 {
        return String::from_utf8_lossy(raw).into_owned();
    }
    let mut w = vec![0u16; n as usize];
    let n = unsafe { MultiByteToWideChar(CP_OEMCP, 0, raw.as_ptr(), len, w.as_mut_ptr(), n) };
    String::from_utf16_lossy(&w[..n.max(0) as usize])
}

#[cfg(not(windows))]
fn decode(raw: &[u8]) -> String {
    String::from_utf8_lossy(raw).into_owned()
}

/// Ejecuta una orden del sistema y espera; el error es su salida resumida (o cómo terminó).
#[cfg(any(windows, unix))]
fn run_tool(name: &str, mut cmd: std::process::Command) -> Result<(), String> {
    let out = cmd.stdin(std::process::Stdio::null()).output().map_err(|e| format!("{name}: {}", sys::io_error_text(&e)))?;
    if out.status.success() {
        return Ok(());
    }
    Err(summary(&out.stderr).or_else(|| summary(&out.stdout)).unwrap_or_else(|| format!("{name} failed ({})", out.status)))
}

/// El ejecutable de la app como texto.
#[cfg(any(windows, unix))]
fn current_exe() -> Result<String, String> {
    let exe = std::env::current_exe().map_err(|e| sys::io_error_text(&e))?;
    exe.into_os_string().into_string().map_err(|_| "the program path isn't valid Unicode".to_string())
}

/// Windows: Programador de tareas con `schtasks.exe` (del usuario actual, sin administrador).
#[cfg(windows)]
mod os {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::path::PathBuf;
    use std::process::Command;

    /// Sin ventana de consola: la app es del subsistema «windows» y schtasks abriría una.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn schtasks(args: &[String]) -> Result<(), String> {
        let exe = std::env::var_os("SystemRoot")
            .map(|r| PathBuf::from(r).join("System32").join("schtasks.exe"))
            .filter(|p| p.is_file())
            .unwrap_or_else(|| PathBuf::from("schtasks.exe"));
        let mut cmd = Command::new(exe);
        cmd.args(args).creation_flags(CREATE_NO_WINDOW);
        run_tool("schtasks", cmd)
    }

    pub fn supported() -> bool {
        true
    }

    pub fn exe() -> Result<String, String> {
        current_exe()
    }

    pub fn installed() -> bool {
        schtasks(&schtasks_query_args()).is_ok()
    }

    /// Crea o sustituye la tarea desde un XML temporal (UTF-16 con BOM, como lo pide schtasks).
    pub fn install(cfg: &ScheduleConfig, exe: &str) -> Result<(), String> {
        let now = now();
        let today = crate::saved::local_time(now).ok_or("couldn't read the local time")?;
        let (y, m, d, _, _) = crate::saved::local_time(now + 86_400).ok_or("couldn't read the local time")?;
        let xml = task_xml(cfg, exe, &start_boundary(cfg, today, (y, m, d)));
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend(xml.encode_utf16().flat_map(u16::to_le_bytes));
        let file = std::env::temp_dir().join(format!("tesserafs-task-{}.xml", std::process::id()));
        fs::write(&file, bytes).map_err(|e| sys::io_error_text(&e))?;
        let r = schtasks(&schtasks_create_args(&file.to_string_lossy()));
        let _ = fs::remove_file(&file);
        r
    }

    pub fn uninstall() -> Result<(), String> {
        if installed() {
            schtasks(&schtasks_delete_args())
        } else {
            Ok(())
        }
    }
}

/// Linux (y otros Unix con systemd): temporizador de systemd del usuario con `systemctl --user`.
#[cfg(unix)]
mod os {
    use super::*;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    fn systemctl(args: &[&str]) -> Result<(), String> {
        let mut cmd = Command::new("systemctl");
        cmd.arg("--user").args(args);
        run_tool("systemctl", cmd)
    }

    /// systemd del usuario en marcha (no en WSL sin systemd ni en la mayoría de los contenedores).
    pub fn supported() -> bool {
        Command::new("systemctl")
            .args(["--user", "show-environment"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }

    /// La AppImage si la app se lanzó desde ella (`APPIMAGE`: el ejecutable de dentro cambia en cada
    /// montaje); si no, el ejecutable.
    pub fn exe() -> Result<String, String> {
        match std::env::var_os("APPIMAGE").filter(|a| !a.is_empty()) {
            Some(a) => a.into_string().map_err(|_| "the AppImage path isn't valid Unicode".to_string()),
            None => current_exe(),
        }
    }

    /// `$XDG_CONFIG_HOME/systemd/user` (o `~/.config/systemd/user`).
    fn unit_dir() -> Result<PathBuf, String> {
        let config = match std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from) {
            Some(p) if p.is_absolute() => p,
            _ => PathBuf::from(std::env::var_os("HOME").filter(|h| !h.is_empty()).ok_or("HOME is not set")?).join(".config"),
        };
        Ok(config.join("systemd").join("user"))
    }

    pub fn installed() -> bool {
        systemctl(&["is-enabled", "--quiet", TIMER]).is_ok()
    }

    pub fn install(cfg: &ScheduleConfig, exe: &str) -> Result<(), String> {
        let dir = unit_dir()?;
        let io = |e: io::Error| sys::io_error_text(&e);
        fs::create_dir_all(&dir).map_err(io)?;
        fs::write(dir.join(SERVICE), systemd_service(exe)).map_err(io)?;
        fs::write(dir.join(TIMER), systemd_timer(cfg)).map_err(io)?;
        systemctl(&["daemon-reload"])?;
        systemctl(&["enable", TIMER])?;
        // `restart` y no `start`: si ya estaba en marcha, así toma la hora nueva
        systemctl(&["restart", TIMER])
    }

    pub fn uninstall() -> Result<(), String> {
        let dir = unit_dir()?;
        if dir.join(TIMER).exists() {
            systemctl(&["disable", "--now", TIMER])?;
        }
        for f in [TIMER, SERVICE] {
            if let Err(e) = fs::remove_file(dir.join(f)) {
                if e.kind() != io::ErrorKind::NotFound {
                    return Err(sys::io_error_text(&e));
                }
            }
        }
        systemctl(&["daemon-reload"])
    }
}

/// Otras plataformas: no se programan escaneos.
#[cfg(not(any(windows, unix)))]
mod os {
    use super::*;
    pub fn supported() -> bool {
        false
    }
    pub fn exe() -> Result<String, String> {
        Err(msg::schedule_unsupported().message)
    }
    pub fn installed() -> bool {
        false
    }
    pub fn install(_cfg: &ScheduleConfig, _exe: &str) -> Result<(), String> {
        Err(msg::schedule_unsupported().message)
    }
    pub fn uninstall() -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Param, ScheduleMessages};

    fn cfg(every: ScheduleEvery, time: &str, weekday: Option<u8>) -> ScheduleConfig {
        ScheduleConfig { path: String::new(), every, time: time.into(), weekday, min_free_pct: 10, messages: None }
    }

    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
            let p = std::env::temp_dir().join(format!("tessera-sched-{tag}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
        fn path(&self) -> String {
            self.0.to_str().unwrap().to_string()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn invalid_error(r: Result<ScheduleConfig, EngineMessage>) -> String {
        let e = r.unwrap_err();
        assert_eq!(e.code, "schedule.invalid", "{e:?}");
        e.get("error").unwrap().to_string()
    }

    #[test]
    fn arg_detection() {
        assert!(requested(["--scheduled-scan"]));
        assert!(requested(["C:\\", "--scheduled-scan"]));
        assert!(!requested(["--scheduled-scan=1", "--scheduled"]));
        assert!(!requested(Vec::<String>::new()));
        assert!(!requested([r"C:\--scheduled-scan"]));
    }

    #[test]
    fn times() {
        assert_eq!(parse_time("09:05"), Some((9, 5)));
        assert_eq!(parse_time("9:05"), Some((9, 5)));
        assert_eq!(parse_time("23:59"), Some((23, 59)));
        assert_eq!(parse_time("00:00"), Some((0, 0)));
        for bad in ["24:00", "12:60", "1200", "12:5", "123:00", ":30", "12:", "a1:00", "12:00:00", "-1:00", "+1:00", ""] {
            assert_eq!(parse_time(bad), None, "{bad}");
        }
    }

    #[test]
    fn validation() {
        let dir = TempDir::new("valid");
        let ok = validate(ScheduleConfig { path: format!("{}{}", dir.path(), std::path::MAIN_SEPARATOR), ..cfg(ScheduleEvery::Daily, "7:30", Some(3)) }).unwrap();
        // Hora con dos cifras, sin día en la diaria y la ruta como la de un escaneo (sin barra final)
        assert_eq!((ok.time.as_str(), ok.weekday, ok.path.as_str()), ("07:30", None, dir.path().as_str()));
        let weekly = validate(ScheduleConfig { path: dir.path(), ..cfg(ScheduleEvery::Weekly, "22:00", Some(6)) }).unwrap();
        assert_eq!(weekly.weekday, Some(6));
        let with = |c: ScheduleConfig| validate(ScheduleConfig { path: dir.path(), ..c });
        assert!(invalid_error(with(cfg(ScheduleEvery::Daily, "25:00", None))).contains("HH:MM"));
        assert!(invalid_error(with(cfg(ScheduleEvery::Weekly, "10:00", Some(7)))).contains("from 0 (Sunday) to 6"));
        assert!(invalid_error(with(cfg(ScheduleEvery::Weekly, "10:00", None))).contains("needs a weekday"));
        assert!(invalid_error(with(ScheduleConfig { min_free_pct: 100, ..cfg(ScheduleEvery::Daily, "10:00", None) })).contains("from 0 to 99"));
        assert!(with(ScheduleConfig { min_free_pct: 99, ..cfg(ScheduleEvery::Daily, "10:00", None) }).is_ok());
        assert!(with(ScheduleConfig { min_free_pct: 0, ..cfg(ScheduleEvery::Daily, "10:00", None) }).is_ok());
        // Carpeta: que exista y que sea una carpeta
        let missing = dir.0.join("no-existe");
        let e = invalid_error(validate(ScheduleConfig { path: missing.to_str().unwrap().into(), ..cfg(ScheduleEvery::Daily, "10:00", None) }));
        assert!(e.starts_with("Could not open"), "{e}");
        let file = dir.0.join("archivo.txt");
        fs::write(&file, b"x").unwrap();
        let e = invalid_error(validate(ScheduleConfig { path: file.to_str().unwrap().into(), ..cfg(ScheduleEvery::Daily, "10:00", None) }));
        assert!(e.starts_with("Not a folder"), "{e}");
        assert!(invalid_error(validate(cfg(ScheduleEvery::Daily, "10:00", None))).starts_with("Invalid path"));
    }

    #[test]
    fn json_from_the_interface() {
        let c = from_json(serde_json::json!({
            "path": "C:\\", "every": "weekly", "time": "10:00", "weekday": 0, "minFreePct": 10.0,
            "messages": { "title": "Poco espacio", "body": "{drive}: {free} ({pct} %)" },
        }))
        .unwrap();
        assert_eq!((c.every, c.weekday, c.min_free_pct), (ScheduleEvery::Weekly, Some(0), 10));
        assert_eq!(c.messages.as_ref().unwrap().title, "Poco espacio");
        // Sin día ni textos: no aparecen en el JSON (schedule.json y la respuesta a la interfaz)
        let d = from_json(serde_json::json!({ "path": "/srv", "every": "daily", "time": "08:15", "minFreePct": 0 })).unwrap();
        assert_eq!(serde_json::to_value(&d).unwrap(), serde_json::json!({ "path": "/srv", "every": "daily", "time": "08:15", "minFreePct": 0 }));
        assert_eq!(serde_json::to_value(&c).unwrap()["minFreePct"], 10);
        for bad in [
            serde_json::json!({ "path": "/", "every": "monthly", "time": "08:15", "minFreePct": 0 }),
            serde_json::json!({ "path": "/", "every": "daily", "time": "08:15", "minFreePct": 10.5 }),
            serde_json::json!({ "path": "/", "every": "daily", "time": "08:15", "minFreePct": -1 }),
            serde_json::json!({ "path": "/", "every": "weekly", "time": "08:15", "weekday": 300, "minFreePct": 1 }),
            serde_json::json!({ "path": "/", "every": "daily", "time": "08:15" }),
            serde_json::json!("x"),
        ] {
            let e = from_json(bad.clone()).unwrap_err();
            assert_eq!(e.code, "schedule.invalid", "{bad}");
        }
        let e = from_json(serde_json::json!({ "path": "/", "every": "daily", "time": "08:15", "minFreePct": 10.5 })).unwrap_err();
        assert!(e.message.contains("whole number"), "{}", e.message);
    }

    #[test]
    fn info_and_run_json() {
        let run = ScheduleRun { at: 1_791_700_000, ok: true, bytes: Some(5), free: Some(6), total: Some(7), alerted: Some(false), error: None };
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            serde_json::json!({ "at": 1_791_700_000u64, "ok": true, "bytes": 5, "free": 6, "total": 7, "alerted": false })
        );
        let failed = ScheduleRun { at: 1, ok: false, error: Some(msg::schedule_invalid("x")), ..ScheduleRun::default() };
        assert_eq!(
            serde_json::to_value(&failed).unwrap(),
            serde_json::json!({ "at": 1, "ok": false, "error": { "code": "schedule.invalid", "params": { "error": "x" }, "message": "Invalid schedule: x" } })
        );
        assert_eq!(serde_json::from_value::<ScheduleRun>(serde_json::to_value(&failed).unwrap()).unwrap(), failed);
        // Sin programación: `schedule: null` y sin `lastRun`
        let none = ScheduleInfo { supported: false, schedule: None, last_run: None };
        assert_eq!(serde_json::to_value(&none).unwrap(), serde_json::json!({ "supported": false, "schedule": null }));

        let dir = TempDir::new("info");
        assert_eq!(info(&dir.0, true, true), ScheduleInfo { supported: true, schedule: None, last_run: None });
        let c = ScheduleConfig { path: dir.path(), ..cfg(ScheduleEvery::Daily, "10:00", None) };
        write_json(&dir.0.join(CONFIG_FILE), &c).unwrap();
        write_json(&dir.0.join(LAST_FILE), &run).unwrap();
        assert!(!dir.0.join("schedule.json.tmp").exists());
        assert_eq!(read_config(&dir.0).unwrap(), Some(c.clone()));
        let v = serde_json::to_value(info(&dir.0, true, true)).unwrap();
        assert_eq!(v["schedule"]["path"], dir.path());
        assert_eq!(v["lastRun"]["bytes"], 5);
        // La tarea o el temporizador ya no están (o el sistema no programa): sin programación, con la última ejecución
        assert_eq!(info(&dir.0, true, false), ScheduleInfo { supported: true, schedule: None, last_run: Some(run.clone()) });
        assert_eq!(info(&dir.0, false, true).schedule, None);
        // Un schedule.json roto: schedule.invalid al ejecutar, null al consultar
        fs::write(dir.0.join(CONFIG_FILE), b"{roto").unwrap();
        assert_eq!(read_config(&dir.0).unwrap_err().code, "schedule.invalid");
        assert_eq!(info(&dir.0, true, true).schedule, None);
    }

    #[test]
    fn alert_rule() {
        assert!(should_alert(9, 100, 10));
        assert!(!should_alert(10, 100, 10), "justo en el umbral no avisa");
        assert!(!should_alert(0, 100, 0), "0 = no avisar nunca");
        assert!(!should_alert(0, 0, 50), "sin total no se sabe");
        assert!(should_alert(u64::MAX / 100, u64::MAX, 2), "sin desbordar");
        assert!(!should_alert(u64::MAX, u64::MAX, 99));
        assert_eq!(free_pct(96, 1000), 9, "hacia abajo");
        assert_eq!(free_pct(5, 0), 0);
        assert_eq!(free_pct(u64::MAX, u64::MAX), 100);
        assert_eq!(free_pct(7, 5), 100);
    }

    #[test]
    fn texts() {
        assert_eq!(short_size(0), "0 bytes");
        assert_eq!(short_size(1536), "1.5 KB");
        assert_eq!(short_size(13_207_024_435), "12.3 GB");
        assert_eq!(drive_label(r"C:\"), "C:");
        assert_eq!(drive_label(r"d:\"), "D:");
        assert_eq!(drive_label(r"\\srv\datos\"), r"\\srv\datos");
        assert_eq!(drive_label("/"), "/");
        assert_eq!(drive_label("/home/"), "/home");
        assert_eq!(drive_label("/mnt/c"), "/mnt/c");
        // Una sola pasada: lo sustituido no se vuelve a mirar; otras llaves quedan igual
        assert_eq!(fill("{drive} {free} {pct}% {x} {", "{pct}", "{drive}", 7), "{pct} {drive} 7% {x} {");
        assert_eq!(fill("", "C:", "0 bytes", 0), "");
        assert_eq!(fill("{pct}{pct}", "C:", "", 42), "4242");
        // Tamaños con los formatos del idioma de la interfaz (los de `i18n.sizePatterns()` en francés)
        let fr: Vec<String> = ["{int}\u{a0}Ko", "{int},{frac}\u{a0}Mo", "{int},{frac}\u{a0}Go", "{int},{frac}\u{a0}To"].map(String::from).into();
        assert_eq!(localized_size(13_207_024_435, Some(&fr)), "12,3\u{a0}Go");
        assert_eq!(localized_size(1 << 30, Some(&fr)), "1,0\u{a0}Go");
        assert_eq!(localized_size(1536, Some(&fr)), "2\u{a0}Ko", "KB sin decimales, redondeado");
        assert_eq!(localized_size(5 << 40, Some(&fr)), "5,0\u{a0}To");
        assert_eq!(localized_size((1 << 30) - 1, Some(&fr)), "1024,0\u{a0}Mo");
        assert_eq!(localized_size(500, Some(&fr)), "500 bytes", "menos de 1 KB: el formato corto");
        assert_eq!(localized_size(1 << 30, Some(&fr[..3])), "1.0 GB", "si no son cuatro, el formato corto");
        assert_eq!(localized_size(1 << 30, None), "1.0 GB");
        // Textos de la interfaz, o los de reserva en inglés
        let mut c = cfg(ScheduleEvery::Daily, "10:00", None);
        let (t, b) = alert_texts(&c, "C:", 13_207_024_435, 107_374_182_400);
        assert_eq!(t, "TesseraFS: low disk space");
        assert_eq!(b, "C: has 12.3 GB free (12 %). Open TesseraFS to see what takes up space.");
        c.messages = Some(ScheduleMessages { title: "Poco espacio en {drive}".into(), body: "Quedan {free} ({pct} %)".into(), sizes: None });
        assert_eq!(alert_texts(&c, "/", 1 << 30, 10 << 30), ("Poco espacio en /".to_string(), "Quedan 1.0 GB (10 %)".to_string()));
        c.messages.as_mut().unwrap().sizes = Some(["{int} KB", "{int},{frac} MB", "{int},{frac} GB", "{int},{frac} TB"].map(String::from).into());
        assert_eq!(alert_texts(&c, "C:", 19_586_392_064, 434_560_299_008).1, "Quedan 18,2 GB (4 %)");
        c.messages = Some(ScheduleMessages { title: " ".into(), body: "{drive}".into(), sizes: None });
        assert_eq!(alert_texts(&c, "D:", 1, 2), ("TesseraFS: low disk space".to_string(), "D:".to_string()));
    }

    #[test]
    fn schtasks_arguments() {
        let xml = r"C:\Users\Ana María\AppData\Local\Temp\tesserafs-task-42.xml";
        assert_eq!(schtasks_create_args(xml), ["/Create", "/F", "/TN", "TesseraFS scheduled scan", "/XML", xml]);
        assert_eq!(schtasks_query_args(), ["/Query", "/TN", "TesseraFS scheduled scan"]);
        assert_eq!(schtasks_delete_args(), ["/Delete", "/F", "/TN", "TesseraFS scheduled scan"]);
        assert!(has_arg(["x", "--restore-schedule"], RESTORE_ARG) && !requested(["--restore-schedule"]));
    }

    #[test]
    fn first_start() {
        let at = |t: &str| cfg(ScheduleEvery::Daily, t, None);
        // Hoy si la hora todavía no ha llegado; si ya pasó (o es ahora mismo), mañana
        assert_eq!(start_boundary(&at("10:00"), (2026, 10, 11, 9, 59), (2026, 10, 12)), "2026-10-11T10:00:00");
        assert_eq!(start_boundary(&at("10:00"), (2026, 10, 11, 10, 0), (2026, 10, 12)), "2026-10-12T10:00:00");
        assert_eq!(start_boundary(&at("09:05"), (2026, 12, 31, 23, 0), (2027, 1, 1)), "2027-01-01T09:05:00");
        assert_eq!(start_boundary(&at("23:59"), (2026, 2, 3, 0, 0), (2026, 2, 4)), "2026-02-03T23:59:00");
    }

    #[test]
    fn task_definition() {
        let exe = r"C:\Users\Tom & Ana\AppData\Local\TesseraFS\tesserafs-desktop.exe";
        let daily = task_xml(&cfg(ScheduleEvery::Daily, "09:30", None), exe, "2026-10-12T09:30:00");
        assert!(daily.starts_with("<?xml version=\"1.0\" encoding=\"UTF-16\"?>\r\n<Task version=\"1.2\""), "{daily}");
        assert!(daily.ends_with("</Task>\r\n") && !daily.replace("\r\n", "").contains('\n'));
        for part in [
            "<StartBoundary>2026-10-12T09:30:00</StartBoundary>\r\n      <ScheduleByDay>\r\n        <DaysInterval>1</DaysInterval>",
            "<LogonType>InteractiveToken</LogonType>",
            "<RunLevel>LeastPrivilege</RunLevel>",
            "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
            "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
            "<StartWhenAvailable>true</StartWhenAvailable>",
            r#"<Command>"C:\Users\Tom &amp; Ana\AppData\Local\TesseraFS\tesserafs-desktop.exe"</Command>"#,
            "<Arguments>--scheduled-scan</Arguments>",
            "<Description>Created by TesseraFS: change or remove the scheduled scan from the app</Description>",
        ] {
            assert!(daily.contains(part), "{part}\n{daily}");
        }
        assert!(!daily.contains("<UserId>") && !daily.contains("ScheduleByWeek"));
        let days: Vec<bool> = (0..7)
            .map(|d| task_xml(&cfg(ScheduleEvery::Weekly, "10:00", Some(d)), "x", "s").contains(&format!("<DaysOfWeek>\r\n          <{} />", TASK_DAYS[usize::from(d)])))
            .collect();
        assert_eq!(days, [true; 7]);
        assert!(task_xml(&cfg(ScheduleEvery::Weekly, "10:00", Some(1)), "x", "s").contains("<Monday />\r\n        </DaysOfWeek>\r\n        <WeeksInterval>1</WeeksInterval>"));
    }

    #[test]
    fn systemd_units() {
        assert_eq!(systemd_quote("/usr/bin/tesserafs-desktop"), r#""/usr/bin/tesserafs-desktop""#);
        assert_eq!(systemd_quote(r#"/home/ana/Mis apps/50% $HOME "x" \y"#), r#""/home/ana/Mis apps/50%% $$HOME \"x\" \\y""#);
        assert_eq!(systemd_quote("a\nb"), r#""a\nb""#);
        assert_eq!(
            systemd_service("/home/ana/Apps/TesseraFS.AppImage"),
            "# Created by TesseraFS: change or remove the scheduled scan from the app\n\
             [Unit]\n\
             Description=TesseraFS scheduled scan\n\
             \n\
             [Service]\n\
             Type=oneshot\n\
             ExecStart=\"/home/ana/Apps/TesseraFS.AppImage\" --scheduled-scan\n\
             Nice=10\n"
        );
        assert_eq!(
            systemd_timer(&cfg(ScheduleEvery::Daily, "09:30", None)),
            "# Created by TesseraFS: change or remove the scheduled scan from the app\n\
             [Unit]\n\
             Description=TesseraFS scheduled scan\n\
             \n\
             [Timer]\n\
             OnCalendar=*-*-* 09:30:00\n\
             Persistent=true\n\
             \n\
             [Install]\n\
             WantedBy=timers.target\n"
        );
        assert_eq!(on_calendar(&cfg(ScheduleEvery::Weekly, "21:05", Some(0))), "Sun *-*-* 21:05:00");
        assert_eq!(on_calendar(&cfg(ScheduleEvery::Weekly, "21:05", Some(6))), "Sat *-*-* 21:05:00");
        assert!(systemd_timer(&cfg(ScheduleEvery::Weekly, "07:00", Some(3))).contains("\nOnCalendar=Wed *-*-* 07:00:00\n"));
    }

    #[test]
    fn tool_output() {
        assert_eq!(summary(b""), None);
        assert_eq!(summary(b" \r\n \n"), None);
        assert_eq!(summary(b"ERROR: Access is denied.\r\n\r\n  Second line\r\n").as_deref(), Some("ERROR: Access is denied. Second line"));
        let long = "x".repeat(400);
        let s = summary(long.as_bytes()).unwrap();
        assert_eq!((s.chars().count(), s.ends_with('…')), (300, true));
        assert_eq!(summary("ERROR: Acceso denegado.".as_bytes()).as_deref(), Some("ERROR: Acceso denegado."));
        // Página de códigos OEM (850/437): «ó» es 0xA2
        #[cfg(windows)]
        {
            let oem = summary(b"ERROR: El sistema no puede encontrar el archivo especificado. Acci\xA2n").unwrap();
            assert!(oem.starts_with("ERROR: El sistema") && !oem.contains('\u{FFFD}'), "{oem}");
        }
        assert_eq!(msg::schedule_failed("boom").get("error"), Some(&Param::Str("boom".into())));
        assert_eq!(msg::schedule_failed("boom").message, "Couldn't change the scheduled scan: boom");
        assert_eq!(msg::schedule_unsupported().code, "schedule.unsupported");
        assert!(msg::schedule_unsupported().params.is_none());
    }
}
