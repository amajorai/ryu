use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Mutex;

use super::binaries::{resolved_installed_path, CLI, CORE, GATEWAY};
use super::installer_script::{
    bundled_install_script, installer_scratch_dir, write_installer_script,
    DESKTOP_INSTALLER_START_CORE,
};
use super::stack::{
    default_runtime_root, release_tag_for_version, stack_digests, validate_release_stack,
};
use crate::win_process::NoWindow;

static ENV_LOCK: Mutex<()> = Mutex::new(());

struct EnvRestore {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvRestore {
    fn set(key: &'static str, value: &std::path::Path) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvRestore {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.take() {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[test]
fn desktop_executes_the_canonical_script_bundled_with_the_signed_app() {
    let script = std::str::from_utf8(bundled_install_script()).expect("installer is UTF-8");
    assert!(script.contains("RYU_INSTALL_EVENT:"));
    assert!(script.contains("RYU_START_CORE"));
    assert!(script.len() > 1_000, "a truncated installer must not ship");
}

#[test]
fn desktop_installer_leaves_core_startup_to_the_process_manager() {
    assert_eq!(DESKTOP_INSTALLER_START_CORE, "0");
}

#[test]
fn release_sources_are_pinned_and_rolling_builds_require_version_validation() {
    assert_eq!(release_tag_for_version("0.4.1").unwrap(), "v0.4.1");
    assert_eq!(
        release_tag_for_version("0.4.1-canary.123").unwrap(),
        "v0.4.1-canary.123"
    );
    assert_eq!(
        release_tag_for_version("0.4.1-nightly.123").unwrap(),
        "v0.4.1-nightly.123"
    );
    assert!(release_tag_for_version("../../foreign").is_err());
}

#[test]
fn preparation_uses_the_profile_of_the_target_build() {
    let home = PathBuf::from("home");
    assert_eq!(
        default_runtime_root(home.clone(), "0.4.1"),
        home.join(".ryu/bin")
    );
    assert_eq!(
        default_runtime_root(home.clone(), "0.4.1-canary.123"),
        home.join(".ryu-canary/bin")
    );
    assert_eq!(
        default_runtime_root(home.clone(), "0.4.1-nightly.123"),
        home.join(".ryu-nightly/bin")
    );
}

#[tokio::test]
async fn executable_validation_rejects_partial_and_mixed_sets_before_activation() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("fixture.rs");
    std::fs::write(&source, r#"fn main() {
        let exe = std::env::current_exe().unwrap();
        let name = exe.file_name().unwrap().to_string_lossy();
        let version = std::fs::read_to_string(exe.with_file_name(format!("{name}.reported-version"))).unwrap();
        println!("{name} {}", version.trim());
    }"#).unwrap();
    let fixture = root.path().join(if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    });
    let compiler = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let built = std::process::Command::new(compiler)
        .arg(&source)
        .arg("--crate-name")
        .arg("update_fixture")
        .arg("-o")
        .arg(&fixture)
        .no_window()
        .output()
        .unwrap();
    assert!(
        built.status.success(),
        "{}",
        String::from_utf8_lossy(&built.stderr)
    );
    let store = ryu_runtime_install::RuntimeGenerations::new(root.path().join("runtime"));
    let old = store.stage().unwrap();
    let old = store.activate(old).unwrap();
    let candidate = store.stage().unwrap();
    for spec in [&CORE, &GATEWAY, &CLI] {
        let name = if cfg!(windows) {
            format!("{}.exe", spec.bin_name)
        } else {
            spec.bin_name.to_owned()
        };
        std::fs::copy(&fixture, candidate.path().join(&name)).unwrap();
        std::fs::write(candidate.path().join(format!("{name}.version")), "0.4.1").unwrap();
        std::fs::write(
            candidate.path().join(format!("{name}.reported-version")),
            "0.4.1",
        )
        .unwrap();
    }
    validate_release_stack(candidate.path(), "0.4.1")
        .await
        .unwrap();
    let trusted = stack_digests(candidate.path()).unwrap();
    let gateway = if cfg!(windows) {
        "ryu-gateway.exe"
    } else {
        "ryu-gateway"
    };
    let gateway_path = candidate.path().join(gateway);
    std::fs::write(
        candidate.path().join(format!("{gateway}.reported-version")),
        "0.4.0",
    )
    .unwrap();
    assert!(validate_release_stack(candidate.path(), "0.4.1")
        .await
        .is_err());
    assert_eq!(store.active_dir().unwrap(), old);
    // Byte corruption must fail the cache check even if its version marker
    // and executable's reported version remain unchanged.
    let original = std::fs::read(&gateway_path).unwrap();
    let mut changed = original.clone();
    changed.push(0);
    std::fs::write(&gateway_path, changed).unwrap();
    assert_ne!(stack_digests(candidate.path()).unwrap(), trusted);
    std::fs::write(&gateway_path, original).unwrap();
    std::fs::remove_file(candidate.path().join(format!("{gateway}.version"))).unwrap();
    assert!(validate_release_stack(candidate.path(), "0.4.1")
        .await
        .is_err());
    assert_eq!(store.active_dir().unwrap(), old);
}

#[test]
fn explicit_core_override_is_the_path_returned_to_the_caller() {
    let _lock = ENV_LOCK.lock().expect("environment lock");
    let directory = tempfile::tempdir().expect("temporary directory");
    let override_path = directory.path().join(if cfg!(windows) {
        "custom-core.exe"
    } else {
        "custom-core"
    });
    std::fs::write(&override_path, b"test executable").expect("override file");
    let _restore = EnvRestore::set(CORE.env_var, &override_path);

    assert_eq!(
        resolved_installed_path(&CORE, "does-not-matter"),
        Some(override_path)
    );
}

#[test]
fn island_installs_into_its_own_folder_under_the_managed_bin_directory() {
    let path = super::island::island_install_path().expect("island install path");
    let folder = path.parent().expect("island folder");
    assert_eq!(
        folder.file_name().and_then(|name| name.to_str()),
        Some("island")
    );
    let expected = if cfg!(target_os = "windows") {
        "ryu-island.exe"
    } else if cfg!(target_os = "macos") {
        "Ryu Island.app"
    } else {
        "ryu-island.AppImage"
    };
    assert_eq!(
        path.file_name().and_then(|name| name.to_str()),
        Some(expected)
    );
}

#[test]
fn the_installer_script_is_written_into_the_folder_ryu_owns() {
    let root = tempfile::tempdir().unwrap();
    let scratch = root.path().join("tmp").join("desktop-installer");
    let unix = write_installer_script(&scratch, b"echo ok\n", false).unwrap();
    assert_eq!(unix.parent(), Some(scratch.as_path()));
    assert_eq!(unix.extension().and_then(|ext| ext.to_str()), Some("sh"));
    assert_eq!(std::fs::read(&unix).unwrap(), b"echo ok\n");
    let windows = write_installer_script(&scratch, b"Write-Host ok", true).unwrap();
    assert_eq!(windows.parent(), Some(scratch.as_path()));
    assert_eq!(
        windows.extension().and_then(|ext| ext.to_str()),
        Some("ps1")
    );
    assert_eq!(
        std::fs::read(&windows).unwrap(),
        b"\xef\xbb\xbfWrite-Host ok"
    );
    let removed = unix.to_path_buf();
    drop(unix);
    assert!(!removed.exists(), "the script is removed once the run ends");
}

#[test]
fn the_installer_scratch_folder_is_under_the_data_dir_not_the_system_temp() {
    let scratch = installer_scratch_dir();
    assert_eq!(
        scratch,
        ryu_sidecar_runtime::layout::tmp_dir_for(
            &crate::profile::ryu_home_dir(),
            "desktop-installer"
        )
    );
    assert!(
        scratch.starts_with(crate::profile::ryu_home_dir()),
        "{}",
        scratch.display()
    );
    assert_ne!(scratch.parent(), Some(std::env::temp_dir().as_path()));
}

/// Strip `//` comments so a mention in prose cannot trip or satisfy a guard.
fn code_only(source: &str) -> String {
    source
        .lines()
        .map(|line| line.split("//").next().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The deleted `download_release_binary`/`install_sidecar` pair fetched
/// `releases/latest/download/<asset>` and wrote it straight into `~/.ryu/bin`
/// with no checksum. Every runtime binary now arrives through the bundled
/// installer and is pinned by `release_digests` before it runs; keep an
/// unverified downloader from coming back anywhere in the desktop.
#[test]
fn desktop_sources_carry_no_unverified_release_downloader() {
    // Built from parts so this guard does not match itself.
    let forbidden = [
        concat!("releases/latest", "/download"),
        concat!("fn download_release", "_binary"),
        concat!("fn install", "_sidecar"),
    ];
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut pending = vec![root.clone()];
    let mut scanned = 0_usize;
    let mut offenders = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).expect("read desktop source directory") {
            let path = entry.expect("desktop source entry").path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
                continue;
            }
            let code = code_only(&std::fs::read_to_string(&path).expect("read desktop source"));
            scanned += 1;
            for needle in forbidden {
                if code.contains(needle) {
                    offenders.push(format!("{} contains {needle}", path.display()));
                }
            }
        }
    }
    assert!(scanned > 50, "scanned only {scanned} desktop source files");
    assert!(
        offenders.is_empty(),
        "unverified release downloader: {offenders:?}"
    );
}

#[test]
fn staged_binaries_are_pinned_before_any_of_them_runs() {
    let code = code_only(include_str!("stack.rs"));
    let body = code
        .split("async fn prepare_release_stack_locked")
        .nth(1)
        .expect("stack.rs prepares the release stack");
    let installed = body
        .find("run_unified_installer(")
        .expect("the stack runs the bundled installer");
    let pinned = body
        .find("verify_staged_runtime(")
        .expect("the staged stack is pinned to its release digests");
    let executed = body
        .find("validate_release_stack(staged.path()")
        .expect("the staged stack is version-checked");
    assert!(installed < pinned && pinned < executed);
    let script = code_only(include_str!("installer_script.rs"));
    assert!(
        !script.contains(concat!(".tempfile", "()")),
        "the installer script must not be staged in the system temp directory"
    );
}
