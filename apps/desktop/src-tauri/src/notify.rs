//! Notificación del sistema del escaneo programado (ver `tessera_core::schedule`): un aviso (toast) de
//! Windows o `notify-send` en Linux. Sólo la usa `--scheduled-scan`; las pruebas nunca la llaman.

/// Identificador de la app (`identifier` de tauri.conf.json). El instalador NSIS se lo pone como
/// AppUserModelID a los accesos directos que crea (`SetLnkAppUserModelId` en installer.nsi), y Windows sólo
/// muestra los avisos de una app de escritorio si hay en el menú Inicio un acceso directo con ese id.
#[cfg(any(windows, test))]
pub const APP_ID: &str = "dev.tesserafs.app";

/// AppUserModelID de Windows PowerShell, que siempre tiene su acceso directo: la reserva sin el instalador
/// (zip, Scoop, compilación propia). El aviso sale entonces con el nombre y el icono de PowerShell.
#[cfg(any(windows, test))]
pub const POWERSHELL_APP_ID: &str = r"{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe";

/// AppUserModelID del aviso: el de la app si la instaló el instalador NSIS (que deja `uninstall.exe` junto
/// al ejecutable y crea el acceso directo con el id); si no, el de PowerShell.
#[cfg(any(windows, test))]
pub fn toast_app_id(nsis_installed: bool) -> &'static str {
    if nsis_installed {
        APP_ID
    } else {
        POWERSHELL_APP_ID
    }
}

#[cfg(any(windows, test))]
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

/// XML del aviso con la plantilla genérica: título y texto, escapados.
#[cfg(any(windows, test))]
pub fn toast_xml(title: &str, body: &str) -> String {
    format!(
        r#"<toast><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual></toast>"#,
        xml_escape(title),
        xml_escape(body)
    )
}

/// Muestra el aviso con el id de la app si está instalada con el instalador y, si falla, con el de PowerShell.
#[cfg(windows)]
pub fn show(title: &str, body: &str) -> Result<(), String> {
    let installed = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.join("uninstall.exe").is_file())).unwrap_or(false);
    let xml = toast_xml(title, body);
    let first = toast_app_id(installed);
    match toast(first, &xml) {
        Err(e) if first != POWERSHELL_APP_ID => toast(POWERSHELL_APP_ID, &xml).map_err(|e2| format!("{e}; {e2}")),
        r => r,
    }
}

#[cfg(windows)]
fn toast(app_id: &str, xml: &str) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    let show = || -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?.Show(&toast)
    };
    show().map_err(|e| format!("toast ({app_id}): {e}"))
}

/// Argumentos de `notify-send`: nombre e icono de la app y, tras `--`, el título y el texto (así no se leen
/// como opciones aunque empiecen por `-`).
#[cfg(any(not(windows), test))]
pub fn notify_send_args(title: &str, body: &str) -> Vec<String> {
    ["--app-name=TesseraFS", "--icon=tesserafs-desktop", "--", title, body].map(String::from).into()
}

/// Linux: `notify-send` (libnotify) si está; si no, no hay aviso (el error sólo se registra).
#[cfg(not(windows))]
pub fn show(title: &str, body: &str) -> Result<(), String> {
    use std::process::{Command, Stdio};
    let status = Command::new("notify-send")
        .args(notify_send_args(title, body))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("notify-send: {}", tessera_core::sys::io_error_text(&e)))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("notify-send failed ({status})"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_content() {
        assert_eq!(
            toast_xml("Poco espacio en C:", "C: tiene 12.3 GB libres (4 %) <ver> & \"más\" 'ya'"),
            concat!(
                r#"<toast><visual><binding template="ToastGeneric"><text>Poco espacio en C:</text>"#,
                r#"<text>C: tiene 12.3 GB libres (4 %) &lt;ver&gt; &amp; &quot;más&quot; &apos;ya&apos;</text></binding></visual></toast>"#
            )
        );
        assert_eq!(toast_app_id(true), "dev.tesserafs.app");
        assert_eq!(toast_app_id(false), POWERSHELL_APP_ID);
    }

    #[test]
    fn notify_send_arguments() {
        assert_eq!(
            notify_send_args("-Poco espacio", "/ tiene 1.0 GB libres (3 %)"),
            ["--app-name=TesseraFS", "--icon=tesserafs-desktop", "--", "-Poco espacio", "/ tiene 1.0 GB libres (3 %)"]
        );
    }

    /// El identificador del aviso es el de tauri.conf.json (el que el instalador pone en el acceso directo).
    #[test]
    fn app_id_matches_the_tauri_identifier() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], APP_ID);
    }
}
