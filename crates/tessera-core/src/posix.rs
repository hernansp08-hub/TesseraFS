//! Piezas de Linux que no dependen de llamadas propias del sistema, para probarlas en cualquier
//! plataforma con textos sintéticos: `/proc/self/mountinfo` (puntos de montaje, volúmenes y
//! pseudo-sistemas de archivos), `user-dirs.dirs` y carpetas de XDG, URIs `file://`, la memoria de
//! `/proc/self/status` y la normalización de rutas POSIX.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

/// Un montaje de `/proc/self/mountinfo`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mount {
    /// `major:minor` del sistema de archivos: el mismo en todos sus montajes (enlazados o repetidos, y
    /// en btrfs también en los de cada subvolumen).
    pub dev: (u32, u32),
    /// Carpeta del sistema de archivos que se monta: `/`, el subvolumen de btrfs (`/@home`) o la carpeta
    /// de un montaje enlazado (`bind`).
    pub root: Vec<u8>,
    /// Punto de montaje en bytes exactos (ya sin los escapes `\040`…).
    pub point: Vec<u8>,
    /// Tipo: `ext4`, `btrfs`, `nfs4`, `9p`…
    pub fs: String,
    /// Origen: `/dev/sda2`, `srv:/export`, `C:\`, `rpool/home`…
    pub source: String,
}

impl Mount {
    /// Punto de montaje como texto (U+FFFD si no es UTF-8).
    pub fn path(&self) -> String {
        String::from_utf8_lossy(&self.point).into_owned()
    }
}

/// Deshace los escapes octales del kernel (`\040` espacio, `\011` tabulador, `\012` salto, `\134` `\`).
fn unescape(s: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s[i] == b'\\' && i + 4 <= s.len() && s[i + 1..i + 4].iter().all(|c| (b'0'..=b'7').contains(c)) {
            let v = u32::from(s[i + 1] - b'0') * 64 + u32::from(s[i + 2] - b'0') * 8 + u32::from(s[i + 3] - b'0');
            if let Ok(b) = u8::try_from(v) {
                out.push(b);
                i += 4;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

fn lossy(b: &[u8]) -> String {
    String::from_utf8_lossy(&unescape(b)).into_owned()
}

/// Montajes de un `mountinfo`, en su orden (en un mismo punto, el último es el visible). Las líneas
/// mal formadas se ignoran.
pub fn parse_mountinfo(text: &[u8]) -> Vec<Mount> {
    text.split(|&b| b == b'\n').filter_map(parse_line).collect()
}

/// `36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue`
fn parse_line(line: &[u8]) -> Option<Mount> {
    let mut f = line.split(|&b| b == b' ');
    let (_id, _parent, dev, root, point) = (f.next()?, f.next()?, f.next()?, f.next()?, f.next()?);
    // Opciones del montaje y campos opcionales hasta el separador «-»
    f.by_ref().find(|x| *x == b"-")?;
    let fs = f.next()?;
    let source = f.next().unwrap_or_default();
    let (major, minor) = std::str::from_utf8(dev).ok()?.split_once(':')?;
    let point = unescape(point);
    if point.first() != Some(&b'/') || fs.is_empty() {
        return None;
    }
    Some(Mount { dev: (major.parse().ok()?, minor.parse().ok()?), root: unescape(root), point, fs: lossy(fs), source: lossy(source) })
}

/// `path` es `dir` o está dentro (`/` lo contiene todo).
pub fn is_under(path: &[u8], dir: &[u8]) -> bool {
    if dir == b"/" {
        return path.first() == Some(&b'/');
    }
    path.starts_with(dir) && (path.len() == dir.len() || path[dir.len()] == b'/')
}

/// El montaje que contiene `path` (ruta real, sin enlaces simbólicos): el de punto más largo y, entre
/// varios en el mismo punto, el último (el visible).
pub fn mount_of<'a>(mounts: &'a [Mount], path: &[u8]) -> Option<&'a Mount> {
    let mut best: Option<&Mount> = None;
    for m in mounts {
        if is_under(path, &m.point) && best.is_none_or(|b| m.point.len() >= b.point.len()) {
            best = Some(m);
        }
    }
    best
}

/// El montaje visible de cada punto, en el orden de la primera aparición del punto.
fn visible(mounts: &[Mount]) -> Vec<&Mount> {
    let mut v: Vec<&Mount> = Vec::new();
    for m in mounts {
        match v.iter_mut().find(|x| x.point == m.point) {
            Some(x) => *x = m,
            None => v.push(m),
        }
    }
    v
}

/// Montajes con el punto estrictamente dentro de `root` (ruta real): los que el recorrido no cruza.
pub fn mounts_under<'a>(mounts: &'a [Mount], root: &[u8]) -> Vec<&'a Mount> {
    visible(mounts).into_iter().filter(|m| m.point != root && is_under(&m.point, root)).collect()
}

/// Pseudo-sistemas de archivos: no se recorren y tampoco se avisa de ellos (`scan.otherMounts`).
const PSEUDO: [&str; 23] = [
    "proc",
    "sysfs",
    "devtmpfs",
    "devpts",
    "tmpfs",
    "securityfs",
    "debugfs",
    "tracefs",
    "pstore",
    "bpf",
    "mqueue",
    "hugetlbfs",
    "fusectl",
    "configfs",
    "autofs",
    "binfmt_misc",
    "efivarfs",
    "ramfs",
    "nsfs",
    "rpc_pipefs",
    "selinuxfs",
    "fuse.gvfsd-fuse",
    "fuse.portal",
];

/// Pseudo-sistema de archivos (proc, sysfs, tmpfs, cgroup*…), overlay de contenedores bajo
/// `/var/lib/docker` o squashfs de snap.
pub fn is_pseudo(m: &Mount) -> bool {
    let fs = m.fs.as_str();
    PSEUDO.contains(&fs)
        || fs.starts_with("cgroup")
        || (fs == "overlay" && is_under(&m.point, b"/var/lib/docker"))
        || (fs == "squashfs" && (is_under(&m.point, b"/snap") || m.source.contains("/snapd/")))
}

/// Sistemas de archivos que se ofrecen como volúmenes (discos, memorias USB y recursos de red).
const REAL: [&str; 23] = [
    "ext2", "ext3", "ext4", "btrfs", "xfs", "f2fs", "zfs", "vfat", "exfat", "ntfs", "ntfs3", "fuseblk", "nfs", "nfs4", "cifs", "smb3", "9p",
    "virtiofs", "bcachefs", "jfs", "reiserfs", "msdos", "hfsplus",
];

/// Sistemas de archivos de red (en WSL, `9p` son las unidades de Windows: `/mnt/c`…).
pub fn is_network_fs(fs: &str) -> bool {
    matches!(fs, "nfs" | "nfs4" | "cifs" | "smb3" | "9p")
}

/// Montajes internos de WSL (controladores y bibliotecas de Windows, WSLg): no son volúmenes del usuario.
fn wsl_internal(point: &[u8]) -> bool {
    is_under(point, b"/usr/lib/wsl") || is_under(point, b"/mnt/wsl") || is_under(point, b"/mnt/wslg")
}

/// Los montajes que se ofrecen como volúmenes: sólo sistemas de archivos reales, el visible de cada
/// punto y sin repetir: si el mismo dispositivo se monta varias veces (la misma carpeta o una de dentro,
/// como los montajes enlazados), se queda el punto de montaje más corto. Los subvolúmenes de btrfs
/// (`/@` en `/` y `/@home` en `/home`) comparten dispositivo pero no contenido: salen los dos. `/`
/// primero y luego por ruta.
pub fn volume_mounts(mounts: &[Mount]) -> Vec<&Mount> {
    let mut cands: Vec<&Mount> = visible(mounts).into_iter().filter(|m| REAL.contains(&m.fs.as_str()) && !wsl_internal(&m.point)).collect();
    // Primero las carpetas más altas del sistema de archivos y, entre las iguales, el punto más corto
    cands.sort_by(|a, b| (a.root.len(), a.point.len(), &a.point).cmp(&(b.root.len(), b.point.len(), &b.point)));
    let mut v: Vec<&Mount> = Vec::new();
    for m in cands {
        if !v.iter().any(|x| x.dev == m.dev && is_under(&m.root, &x.root)) {
            v.push(m);
        }
    }
    v.sort_by(|a, b| (a.point != b"/").cmp(&(b.point != b"/")).then_with(|| a.point.cmp(&b.point)));
    v
}

/// Etiqueta de reserva de un volumen sin etiqueta: el tipo en los de red, el nombre del dispositivo
/// (`sda2`, `nvme0n1p3`, `vg-root`) o, sin `/dev/`, el origen (ZFS: `rpool/home`).
pub fn fallback_label(m: &Mount) -> String {
    if is_network_fs(&m.fs) {
        return m.fs.clone();
    }
    match m.source.strip_prefix("/dev/") {
        Some(d) => d.rsplit('/').next().unwrap_or(d).to_string(),
        None if !m.source.is_empty() && m.source != "none" => m.source.clone(),
        None => m.fs.clone(),
    }
}

/// Nombre de `/dev/disk/by-label` → etiqueta (udev escribe `\x20` en lugar del espacio, `\x2f` en lugar de `/`…).
pub fn udev_label(name: &str) -> String {
    let b = name.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && b.get(i + 1) == Some(&b'x') && i + 4 <= b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 2..i + 4]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 4;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Carpeta de una variable de `user-dirs.dirs` (`XDG_DOWNLOAD_DIR="$HOME/Descargas"` o una ruta
/// absoluta); manda la última asignación. `None` si no está, no es válida o es la propia carpeta
/// personal (así se desactiva).
pub fn user_dir(text: &str, key: &str, home: &Path) -> Option<PathBuf> {
    let mut found = None;
    for line in text.lines().map(str::trim).filter(|l| !l.starts_with('#')) {
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == key {
                found = Some(v.trim());
            }
        }
    }
    let v = found?;
    let v = v.strip_prefix('"').and_then(|x| x.strip_suffix('"')).unwrap_or(v);
    // Escapes de la shell: \" \\ \$ \`
    let mut s = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(c) = chars.next() {
        s.push(if c == '\\' { chars.next().unwrap_or('\\') } else { c });
    }
    let p = match s.strip_prefix("$HOME").or_else(|| s.strip_prefix("${HOME}")) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            let rest = rest.trim_matches('/');
            if rest.is_empty() {
                return None;
            }
            home.join(rest)
        }
        Some(_) => return None,
        None if s.starts_with('/') => PathBuf::from(s.trim_end_matches('/')),
        None => return None,
    };
    (p != home).then_some(p)
}

/// Carpeta base de XDG: `var` (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`…) si es absoluta; si no, `home` + `default`.
pub fn xdg_base(var: Option<std::ffi::OsString>, home: &Path, default: &str) -> PathBuf {
    match var.map(PathBuf::from) {
        Some(p) if p.has_root() => p,
        _ => home.join(default),
    }
}

/// Carpeta de descargas: `XDG_DOWNLOAD_DIR` de `<config_home>/user-dirs.dirs` o, si no, `~/Downloads`.
pub fn download_dir(home: &Path, config_home: &Path) -> PathBuf {
    std::fs::read_to_string(config_home.join("user-dirs.dirs"))
        .ok()
        .and_then(|t| user_dir(&t, "XDG_DOWNLOAD_DIR", home))
        .unwrap_or_else(|| home.join("Downloads"))
}

/// URI `file://` de una ruta absoluta (bytes exactos), con percent-encoding de todo salvo
/// `A-Z a-z 0-9 - . _ ~ /`.
pub fn file_uri(path: &[u8]) -> String {
    let mut s = String::with_capacity(path.len() + 7);
    s.push_str("file://");
    for &b in path {
        if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
            s.push(b as char);
        } else {
            let _ = write!(s, "%{b:02X}");
        }
    }
    s
}

/// Memoria del proceso según `/proc/self/status`: (residente actual `VmRSS`, pico residente `VmHWM`,
/// pico de memoria virtual `VmPeak`), en bytes.
pub fn status_memory(text: &str) -> Option<(u64, u64, u64)> {
    let kb = |key: &str| -> Option<u64> {
        let line = text.lines().find(|l| l.starts_with(key))?;
        line[key.len()..].trim().trim_end_matches("kB").trim().parse::<u64>().ok().map(|v| v * 1024)
    };
    Some((kb("VmRSS:")?, kb("VmHWM:")?, kb("VmPeak:")?))
}

/// Normaliza una ruta absoluta POSIX sin tocar el disco: sin `.`, sin barras repetidas ni finales y con
/// `..` resuelto como texto (igual que `GetFullPathNameW` en Windows); `/..` es `/`.
pub fn lexical(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for c in path.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            x => parts.push(x),
        }
    }
    format!("/{}", parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// mountinfo de una instalación típica (Ubuntu con btrfs, USB, NFS, snap, Docker) más el de WSL.
    const MOUNTINFO: &str = "\
22 1 0:21 /@ / rw,relatime shared:1 - btrfs /dev/nvme0n1p3 rw,ssd,subvol=/@
23 22 0:5 / /dev rw,nosuid shared:2 - devtmpfs udev rw,size=8000000k
24 23 0:22 / /dev/pts rw,nosuid shared:3 - devpts devpts rw,gid=5
25 22 0:23 / /proc rw,nosuid shared:12 - proc proc rw
26 22 0:24 / /sys rw,nosuid shared:7 - sysfs sysfs rw
27 26 0:25 / /sys/fs/cgroup rw shared:9 - cgroup2 cgroup2 rw
28 22 0:26 / /run rw,nosuid shared:5 - tmpfs tmpfs rw,mode=755
29 22 0:21 /@home /home rw,relatime shared:30 - btrfs /dev/nvme0n1p3 rw,ssd,subvol=/@home
30 22 259:1 / /boot/efi rw,relatime shared:31 - vfat /dev/nvme0n1p1 rw,fmask=0077
31 22 7:3 / /snap/core22/1380 ro,nodev shared:32 - squashfs /dev/loop3 ro
32 28 8:17 / /media/ana/Mi\\040USB rw,nosuid shared:40 - exfat /dev/sdb1 rw
33 22 0:50 / /mnt/nas rw,relatime shared:41 - nfs4 nas.local:/export rw,vers=4.2
34 22 0:60 / /var/lib/docker/overlay2/abc/merged rw shared:50 - overlay overlay rw,lowerdir=/x
35 22 0:21 /@home/ana/compartida /srv/compartida rw shared:30 - btrfs /dev/nvme0n1p3 rw,subvol=/@home
36 22 0:70 / /srv/datos rw - ext4 /dev/mapper/vg-datos rw
37 22 0:71 / /srv/datos rw - xfs /dev/sdc1 rw
38 22 0:72 / /tank rw - zfs tank/datos rw
39 22 0:73 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\
40 22 0:74 / /usr/lib/wsl/drivers ro - 9p drivers ro,aname=drivers
41 22 0:75 / /mnt/wslg/distro ro - ext4 /dev/sdd rw
mal formada
42 22 0:76 / sin-barra rw - ext4 /dev/sde rw
";

    fn mounts() -> Vec<Mount> {
        parse_mountinfo(MOUNTINFO.as_bytes())
    }

    fn points(v: &[&Mount]) -> Vec<String> {
        v.iter().map(|m| m.path()).collect()
    }

    #[test]
    fn parses_mountinfo() {
        let ms = mounts();
        assert_eq!(ms.len(), 20, "sin la línea mal formada ni la de punto relativo");
        assert_eq!(ms[0], Mount { dev: (0, 21), root: b"/@".to_vec(), point: b"/".to_vec(), fs: "btrfs".into(), source: "/dev/nvme0n1p3".into() });
        assert_eq!(ms.iter().find(|m| m.point == b"/srv/compartida").unwrap().root, b"/@home/ana/compartida");
        // Escapes octales: espacio y barra invertida
        let usb = ms.iter().find(|m| m.fs == "exfat").unwrap();
        assert_eq!((usb.path().as_str(), usb.dev), ("/media/ana/Mi USB", (8, 17)));
        assert_eq!(ms.iter().find(|m| m.point == b"/mnt/c").unwrap().source, "C:\\");
        assert_eq!(unescape(b"a\\134b\\011\\12\\999"), b"a\\b\t\\12\\999");
    }

    #[test]
    fn volumes_from_mountinfo() {
        let ms = mounts();
        // Reales; /home es otro subvolumen del btrfs de / (sale), /srv/compartida es una carpeta de /home
        // montada otra vez (no sale); /srv/datos está montado dos veces (el visible es el xfs); sin snap,
        // Docker, pseudo-sistemas ni los internos de WSL
        let v = volume_mounts(&ms);
        assert_eq!(points(&v), ["/", "/boot/efi", "/home", "/media/ana/Mi USB", "/mnt/c", "/mnt/nas", "/srv/datos", "/tank"]);
        assert_eq!(v[6].fs, "xfs");
        let labels: Vec<String> = v.iter().map(|m| fallback_label(m)).collect();
        assert_eq!(labels, ["nvme0n1p3", "nvme0n1p1", "nvme0n1p3", "sdb1", "9p", "nfs4", "sdc1", "tank/datos"]);
        // El mismo sistema de archivos montado entero dos veces: el punto más corto
        let twice = "1 0 8:1 / /mnt/datos rw - ext4 /dev/sda1 rw\n2 0 8:1 / /datos rw - ext4 /dev/sda1 rw\n3 0 8:1 /sub /a rw - ext4 /dev/sda1 rw\n";
        assert_eq!(points(&volume_mounts(&parse_mountinfo(twice.as_bytes()))), ["/datos"]);
        // Con el subvolumen raíz de btrfs montado en /, /home es una carpeta suya: no sale aparte
        let top = "1 0 0:30 / / rw - btrfs /dev/sda2 rw,subvolid=5\n2 1 0:30 /@home /home rw - btrfs /dev/sda2 rw\n";
        assert_eq!(points(&volume_mounts(&parse_mountinfo(top.as_bytes()))), ["/"]);
        let lvm = ms.iter().find(|m| m.fs == "ext4" && m.point == b"/srv/datos").unwrap();
        assert_eq!(fallback_label(lvm), "vg-datos");
        assert_eq!(udev_label("Mi\\x20USB"), "Mi USB");
        assert_eq!(udev_label("a\\x2fb\\xZZ"), "a/b\\xZZ");
        assert!(is_network_fs("nfs4") && is_network_fs("9p") && !is_network_fs("ext4"));
        assert!(volume_mounts(&[]).is_empty());
    }

    #[test]
    fn mount_lookup_and_pseudo() {
        let ms = mounts();
        let of = |p: &str| mount_of(&ms, p.as_bytes()).map(|m| m.path());
        assert_eq!(of("/home/ana/x").as_deref(), Some("/home"));
        assert_eq!(of("/homeless").as_deref(), Some("/"));
        assert_eq!(of("/").as_deref(), Some("/"));
        assert_eq!(mount_of(&ms, b"/srv/datos/a").map(|m| m.fs.as_str()), Some("xfs"), "el visible de los dos");
        assert_eq!(of("/media/ana/Mi USB/foto.jpg").as_deref(), Some("/media/ana/Mi USB"));
        assert_eq!(of("relativa"), None);
        // Lo que no cruza un escaneo de / y de /srv
        let under = |root: &str| points(&mounts_under(&ms, root.as_bytes()));
        let all = under("/");
        assert_eq!(all.len(), 18, "19 puntos distintos menos la raíz");
        assert!(!all.contains(&"/".to_string()));
        assert_eq!(under("/srv"), ["/srv/compartida", "/srv/datos"]);
        assert!(under("/srv/datos").is_empty(), "la propia raíz no cuenta");
        assert!(under("/home/ana").is_empty());
        // Pseudo-sistemas: no se avisa de ellos
        let pseudo: Vec<String> = ms.iter().filter(|m| is_pseudo(m)).map(Mount::path).collect();
        assert_eq!(pseudo, ["/dev", "/dev/pts", "/proc", "/sys", "/sys/fs/cgroup", "/run", "/snap/core22/1380", "/var/lib/docker/overlay2/abc/merged"]);
        assert!(is_under(b"/a/b", b"/a") && is_under(b"/a", b"/a") && !is_under(b"/ab", b"/a") && is_under(b"/x", b"/"));
    }

    #[test]
    fn xdg_dirs_with_a_temporary_home() {
        let home = std::env::temp_dir().join(format!("tessera-xdg-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(home.join(".config")).unwrap();
        struct Clean(PathBuf);
        impl Drop for Clean {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _clean = Clean(home.clone());
        let config = xdg_base(None, &home, ".config");
        assert_eq!(config, home.join(".config"));
        // Sin user-dirs.dirs: ~/Downloads
        assert_eq!(download_dir(&home, &config), home.join("Downloads"));
        std::fs::write(
            config.join("user-dirs.dirs"),
            "# This file is written by xdg-user-dirs-update\nXDG_DESKTOP_DIR=\"$HOME/Escritorio\"\nXDG_DOWNLOAD_DIR=\"$HOME/Descargas\"\n",
        )
        .unwrap();
        assert_eq!(download_dir(&home, &config), home.join("Descargas"));
        // XDG_CONFIG_HOME en otra carpeta
        let other = home.join("otra-config");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("user-dirs.dirs"), "XDG_DOWNLOAD_DIR=\"/datos/Bajadas\"\n").unwrap();
        let config = xdg_base(Some(other.clone().into_os_string()), &home, ".config");
        assert_eq!(download_dir(&home, &config), PathBuf::from("/datos/Bajadas"));
        // Variables relativas: se ignoran
        assert_eq!(xdg_base(Some("relativa".into()), &home, ".local/share"), home.join(".local/share"));
        assert_eq!(xdg_base(Some("/x/datos".into()), &home, ".local/share"), PathBuf::from("/x/datos"));

        let h = Path::new("/home/ana");
        let get = |t: &str| user_dir(t, "XDG_DOWNLOAD_DIR", h);
        assert_eq!(get("XDG_DOWNLOAD_DIR=\"$HOME/Mis descargas/\""), Some(h.join("Mis descargas")));
        assert_eq!(get("XDG_DOWNLOAD_DIR=\"${HOME}/D\"\nXDG_DOWNLOAD_DIR=\"$HOME/E\""), Some(h.join("E")), "manda la última");
        assert_eq!(get("XDG_DOWNLOAD_DIR=\"$HOME/Comillas \\\"x\\\"\""), Some(h.join("Comillas \"x\"")));
        assert_eq!(get("XDG_DOWNLOAD_DIR=$HOME/SinComillas"), Some(h.join("SinComillas")));
        for none in ["", "# XDG_DOWNLOAD_DIR=\"$HOME/D\"", "XDG_DOWNLOAD_DIR=\"$HOME/\"", "XDG_DOWNLOAD_DIR=\"$HOME\"", "XDG_DOWNLOAD_DIR=\"$HOMEx/D\"", "XDG_DOWNLOAD_DIR=\"relativa\"", "XDG_DESKTOP_DIR=\"$HOME/D\""] {
            assert_eq!(get(none), None, "{none:?}");
        }
    }

    #[test]
    fn uris_memory_and_paths() {
        assert_eq!(file_uri(b"/home/ana/Mis fotos/a#1?.jpg"), "file:///home/ana/Mis%20fotos/a%231%3F.jpg");
        assert_eq!(file_uri("/ñ/'x'%".as_bytes()), "file:///%C3%B1/%27x%27%25");
        assert_eq!(file_uri(b"/a-b_c.d~e"), "file:///a-b_c.d~e");
        let status = "Name:\ttessera\nVmPeak:\t  900000 kB\nVmSize:\t  800000 kB\nVmHWM:\t   50000 kB\nVmRSS:\t   40000 kB\n";
        assert_eq!(status_memory(status), Some((40_000 * 1024, 50_000 * 1024, 900_000 * 1024)));
        assert_eq!(status_memory("Name: x\n"), None);
        assert_eq!(lexical("/home//ana/./docs/"), "/home/ana/docs");
        assert_eq!(lexical("/home/ana/../bob"), "/home/bob");
        assert_eq!(lexical("/.."), "/");
        assert_eq!(lexical("/"), "/");
    }
}
