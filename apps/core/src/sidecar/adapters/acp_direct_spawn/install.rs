use std::collections::HashSet;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use super::*;
use crate::win_process::NoWindow;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InstalledBin {
    pub(super) prefix: PathBuf,
    pub(super) bin: PathBuf,
    pub(super) installed_at: u64,
}

impl InstalledBin {
    pub(super) fn is_stale(&self, now: SystemTime) -> bool {
        let now = now
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs());
        now.saturating_sub(self.installed_at) >= LATEST_REFRESH_AFTER.as_secs()
    }
}

pub(super) fn installed_bin(root: &Path, spec: &str) -> Option<InstalledBin> {
    let spec_dir = root.join(spec_key(spec));
    let stamp = std::fs::read_to_string(spec_dir.join(CURRENT_FILE)).ok()?;
    let stamp = stamp.trim();
    let installed_at = stamp.parse::<u64>().ok()?;
    let prefix = spec_dir.join(stamp);
    let bin = resolve_package_bin(&prefix, package_name(spec)?)?;
    Some(InstalledBin {
        prefix,
        bin,
        installed_at,
    })
}

/// The JavaScript entry `npx` would run for `name` under `prefix`, or `None`
/// when the bin is not plain Node JavaScript (those keep going through `npx`).
pub(super) fn resolve_package_bin(prefix: &Path, name: &str) -> Option<PathBuf> {
    let package_dir = name
        .split('/')
        .fold(prefix.join("node_modules"), |dir, part| dir.join(part));
    let manifest: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(package_dir.join("package.json")).ok()?)
            .ok()?;
    let unscoped = name.rsplit('/').next().unwrap_or(name);
    let relative = match manifest.get("bin")? {
        serde_json::Value::String(path) => path.clone(),
        serde_json::Value::Object(bins) => match bins.get(unscoped) {
            Some(path) => path.as_str()?.to_owned(),
            None if bins.len() == 1 => bins.values().next()?.as_str()?.to_owned(),
            None => return None,
        },
        _ => return None,
    };
    let relative = Path::new(&relative);
    if relative.is_absolute()
        || relative.components().any(|part| {
            !matches!(
                part,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        })
    {
        return None;
    }
    let package_dir = package_dir.canonicalize().ok()?;
    let bin = package_dir.join(relative).canonicalize().ok()?;
    if !bin.starts_with(&package_dir) {
        return None;
    }
    is_node_script(&bin).then_some(bin)
}

pub(super) fn is_node_script(path: &Path) -> bool {
    let by_extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| matches!(extension, "js" | "mjs" | "cjs"));
    if by_extension {
        return path.is_file();
    }
    let Ok(head) = std::fs::read(path).map(|bytes| bytes.into_iter().take(128).collect::<Vec<_>>())
    else {
        return false;
    };
    let head = String::from_utf8_lossy(&head);
    head.starts_with("#!")
        && head
            .lines()
            .next()
            .is_some_and(|line| line.contains("node"))
}

pub(super) fn installs_in_flight() -> &'static Mutex<HashSet<String>> {
    static IN_FLIGHT: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    IN_FLIGHT.get_or_init(|| Mutex::new(HashSet::new()))
}

pub(super) fn schedule_install(root: PathBuf, spec: String) {
    let key = spec_key(&spec);
    let claimed = installs_in_flight()
        .lock()
        .map(|mut in_flight| in_flight.insert(key.clone()))
        .unwrap_or(false);
    if !claimed {
        return;
    }
    let release_key = key.clone();
    let spawned = std::thread::Builder::new()
        .name("acp-npm-install".to_owned())
        .spawn(move || {
            match install(&root, &spec) {
                Ok(bin) => {
                    tracing::info!(%spec, bin = %bin.display(), "installed ACP agent for direct spawn");
                }
                Err(error) => {
                    tracing::warn!(%spec, %error, "ACP agent install failed; npx stays in use");
                }
            }
            if let Ok(mut in_flight) = installs_in_flight().lock() {
                in_flight.remove(&key);
            }
        });
    if spawned.is_err() {
        if let Ok(mut in_flight) = installs_in_flight().lock() {
            in_flight.remove(&release_key);
        }
    }
}

pub(super) fn npm_command() -> std::process::Command {
    // Rust spawns `.cmd` files through cmd.exe with batch-safe argument escaping.
    if cfg!(windows) {
        std::process::Command::new("npm.cmd")
    } else {
        std::process::Command::new("npm")
    }
}

/// Environment variables the installer keeps. Everything else Core inherited
/// (`RYU_TOKEN`, provider keys, cloud credentials, …) is dropped, so a
/// compromised package or dependency cannot read it while npm runs.
pub(super) const INSTALLER_ENV_ALLOWLIST: &[&str] = &[
    "PATH",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TMP",
    "TEMP",
    "TMPDIR",
    "SystemRoot",
    "SYSTEMROOT",
    "SystemDrive",
    "ComSpec",
    "COMSPEC",
    "PATHEXT",
    "WINDIR",
    "LANG",
    "LC_ALL",
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
];

pub(super) fn installer_env_allowed(name: &str) -> bool {
    INSTALLER_ENV_ALLOWLIST.contains(&name)
        || name.starts_with("NPM_CONFIG_")
        || name.starts_with("npm_config_")
}

/// Replace `command`'s environment with only the allowlisted entries of
/// `inherited` that npm needs (PATH, home/temp dirs, proxy, CA and npm
/// registry configuration).
pub(super) fn scrub_installer_env<I>(command: &mut std::process::Command, inherited: I)
where
    I: IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
{
    command.env_clear();
    for (name, value) in inherited {
        if name.to_str().is_some_and(installer_env_allowed) {
            command.env(name, value);
        }
    }
}

/// `npm install` for one spec into `prefix`, with a scrubbed environment and
/// lifecycle scripts disabled. The direct-spawn launcher only needs the
/// package's plain Node bin (see [`resolve_package_bin`]); the built-in agents'
/// bins resolve platform binaries from `optionalDependencies` at runtime, and
/// the only install script among them (`cline`'s `postinstall`, which is
/// `|| true`) is a startup cache the launcher falls back from.
pub(super) fn npm_install_command<I>(
    prefix: &Path,
    spec: &str,
    inherited: I,
) -> std::process::Command
where
    I: IntoIterator<Item = (std::ffi::OsString, std::ffi::OsString)>,
{
    let mut command = npm_command();
    scrub_installer_env(&mut command, inherited);
    command
        .arg("install")
        .arg("--prefix")
        .arg(prefix)
        .args([
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--no-save",
            "--omit=dev",
            "--loglevel=error",
        ])
        .arg(spec)
        .stdin(std::process::Stdio::null());
    command
}

pub(super) fn install(root: &Path, spec: &str) -> anyhow::Result<PathBuf> {
    let name = package_name(spec).ok_or_else(|| anyhow::anyhow!("invalid package spec"))?;
    let spec_dir = root.join(spec_key(spec));
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs());
    let prefix = spec_dir.join(stamp.to_string());
    std::fs::create_dir_all(&prefix)?;
    let output = npm_install_command(&prefix, spec, std::env::vars_os())
        .no_window()
        .output()?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&prefix);
        anyhow::bail!(
            "npm install exited with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    let Some(bin) = resolve_package_bin(&prefix, name) else {
        let _ = std::fs::remove_dir_all(&prefix);
        anyhow::bail!("{name} has no Node bin to run directly");
    };
    let previous = std::fs::read_to_string(spec_dir.join(CURRENT_FILE)).ok();
    let staged = spec_dir.join(format!("{CURRENT_FILE}.tmp"));
    std::fs::write(&staged, stamp.to_string())?;
    std::fs::rename(&staged, spec_dir.join(CURRENT_FILE))?;
    prune_old_installs(&spec_dir, stamp, previous.as_deref().map(str::trim));
    Ok(bin)
}

/// Keep the new install and the one it replaced (agents started from it may
/// still be running). Older ones are removed best-effort; a directory still in
/// use simply fails to delete and is retried after the next install.
pub(super) fn prune_old_installs(spec_dir: &Path, current: u64, previous: Option<&str>) {
    let Ok(entries) = std::fs::read_dir(spec_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let keep =
            name == current.to_string() || Some(name) == previous || name.parse::<u64>().is_err();
        if !keep && entry.path().is_dir() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
