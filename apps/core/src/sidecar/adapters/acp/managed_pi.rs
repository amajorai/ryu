use super::*;

/// On Windows, `npx` is a `.cmd` batch file that `Command::new` can't spawn directly.
/// Wrapping with `cmd /c` ensures the shell resolves it correctly.
#[cfg(target_os = "windows")]
pub(super) fn npx_cmd(cmd: &str) -> String {
    format!("cmd /c {cmd}")
}

#[cfg(not(target_os = "windows"))]
pub(super) fn npx_cmd(cmd: &str) -> String {
    cmd.to_owned()
}

#[cfg(target_os = "windows")]
pub(super) fn pi_acp_cmd() -> String {
    // pi-acp defaults to pi.cmd on Windows, but bun installs pi.exe.
    "cmd /c set PI_ACP_PI_COMMAND=pi.exe&& npx -y pi-acp".to_owned()
}

#[cfg(not(target_os = "windows"))]
pub(super) fn pi_acp_cmd() -> String {
    "npx -y pi-acp".to_owned()
}

/// Directory holding Ryu's OWN managed Pi install — a private package-manager
/// prefix (`~/.ryu/pi`), completely separate from any Pi the user has on their
/// PATH. The two-Pi split is deliberate: the `acp:pi` agent runs the *user's*
/// own Pi (default PATH lookup, `pi_acp_cmd`), while the flagship `ryu` agent
/// runs *this* customized Pi as its engine base.
pub fn managed_pi_dir() -> PathBuf {
    let root = crate::paths::runtime_dir("pi");
    ryu_runtime_install::RuntimeGenerations::new(root.clone())
        .active_dir()
        .unwrap_or_else(|error| {
            tracing::error!(%error, "managed Pi generation is invalid; refusing legacy fallback");
            root.join("invalid-generation")
        })
}

/// Path to the managed Pi shim produced by installing
/// `@earendil-works/pi-coding-agent` into [`managed_pi_dir`]. Package managers
/// place bin shims under `node_modules/.bin/`, and these shims are NOT
/// relocatable (a bun/npm shim resolves its package + deps relative to that
/// tree). So `PI_ACP_PI_COMMAND` must point at the shim in place here, never at
/// a copy dropped into `bin/`.
///
/// **Windows uses the `.cmd` shim, not `.exe`** (deliberate). pi-acp spawns
/// `PI_ACP_PI_COMMAND` with `child_process.spawn`, and only uses a shell for
/// commands ending in `.cmd`/`.bat`; a bare `.exe` is spawned with `shell:false`,
/// which fails to launch the bun trampoline shim in Core's process context
/// (ENOENT — observed; Core's own `std::process::Command` spawns the same `.exe`
/// fine, so it is specific to pi-acp's Node spawn path). Pointing at the `.cmd`
/// forces pi-acp's `shell:true` path (the one it documents as the Windows
/// default), which launches reliably. [`ensure_ryu_managed_pi`] guarantees a
/// `.cmd` shim exists next to the bun `.exe`.
pub fn managed_pi_binary() -> PathBuf {
    managed_pi_dir()
        .join("node_modules")
        .join(".bin")
        .join(if cfg!(target_os = "windows") {
            "pi.cmd"
        } else {
            "pi"
        })
}

/// The npm package that IS the managed Pi engine (the flagship `ryu` agent's
/// runtime). Update checks compare the installed copy under [`managed_pi_dir`]
/// against this package's `latest` on the npm registry.
pub const PI_ENGINE_NPM: &str = "@earendil-works/pi-coding-agent";

/// Read the installed version of the managed Pi engine from its `package.json`
/// under [`managed_pi_dir`]. `None` when it isn't installed yet.
pub fn read_managed_pi_version() -> Option<String> {
    let pkg_json = managed_pi_dir()
        .join("node_modules")
        .join("@earendil-works")
        .join("pi-coding-agent")
        .join("package.json");
    let raw = std::fs::read_to_string(pkg_json).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

/// Verify the complete dependency tree before publishing a new managed runtime.
fn managed_pi_ready_at(dir: &std::path::Path) -> bool {
    let modules = dir.join("node_modules");
    modules.join("@earendil-works/pi-ai/package.json").is_file()
        && modules
            .join("@earendil-works/pi-coding-agent/package.json")
            .is_file()
        && modules
            .join(".bin")
            .join(if cfg!(windows) { "pi.cmd" } else { "pi" })
            .is_file()
}

/// Ensure the existing private Pi runtime, shared by onboarding and OAuth.
pub async fn ensure_managed_pi() -> anyhow::Result<()> {
    install_managed_pi(false).await
}

/// Move the managed Pi engine and its pi-acp bridge to their newest releases.
pub async fn update_managed_pi() -> anyhow::Result<()> {
    install_managed_pi(true).await
}

fn ensure_managed_pi_manifest_at(dir: &std::path::Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    // A fresh private prefix must not resolve a parent workspace's manifest.
    let manifest = dir.join("package.json");
    if !manifest.exists() {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&manifest)?;
        file.write_all(br#"{"name":"ryu-managed-pi","private":true,"type":"module"}"#)?;
    }
    Ok(())
}

async fn install_managed_pi(update: bool) -> anyhow::Result<()> {
    crate::required_update_runtime::ensure_managed_pi(update).await
}

#[cfg(test)]
mod managed_pi_readiness_tests {
    use super::*;
    #[test]
    fn private_manifest_is_idempotent_and_does_not_touch_a_parent_project() {
        let parent = std::env::temp_dir().join(format!("ryu-pi-prefix-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&parent).unwrap();
        let original = r#"{"name":"parent-project","dependencies":{"keep":"1"}}"#;
        std::fs::write(parent.join("package.json"), original).unwrap();
        let prefix = parent.join("private/pi");
        ensure_managed_pi_manifest_at(&prefix).unwrap();
        let first = std::fs::read_to_string(prefix.join("package.json")).unwrap();
        ensure_managed_pi_manifest_at(&prefix).unwrap();
        assert_eq!(
            std::fs::read_to_string(prefix.join("package.json")).unwrap(),
            first
        );
        assert_eq!(
            std::fs::read_to_string(parent.join("package.json")).unwrap(),
            original
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&first).unwrap()["private"],
            true
        );
        assert!(parent
            .canonicalize()
            .unwrap()
            .starts_with(std::env::temp_dir().canonicalize().unwrap()));
        std::fs::remove_dir_all(parent).unwrap();
    }

    #[test]
    fn an_incomplete_install_cannot_be_used_for_oauth() {
        let root = std::env::temp_dir().join(format!("ryu-pi-ready-{}", uuid::Uuid::new_v4()));
        let modules = root.join("node_modules");
        std::fs::create_dir_all(modules.join("@earendil-works/pi-ai")).unwrap();
        assert!(!managed_pi_ready_at(&root));
        std::fs::write(modules.join("@earendil-works/pi-ai/package.json"), "{}").unwrap();
        assert!(!managed_pi_ready_at(&root));
        std::fs::create_dir_all(modules.join("@earendil-works/pi-coding-agent")).unwrap();
        std::fs::write(
            modules.join("@earendil-works/pi-coding-agent/package.json"),
            "{}",
        )
        .unwrap();
        std::fs::create_dir_all(modules.join(".bin")).unwrap();
        std::fs::write(
            modules
                .join(".bin")
                .join(if cfg!(windows) { "pi.cmd" } else { "pi" }),
            "",
        )
        .unwrap();
        assert!(managed_pi_ready_at(&root));
        assert!(root
            .canonicalize()
            .unwrap()
            .starts_with(std::env::temp_dir().canonicalize().unwrap()));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
