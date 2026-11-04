use super::*;
use crate::sidecar::download_manager::sha256_sibling_url;

// `RELEASE_URL_ENV` is process-global and `cargo test` runs test fns in
// parallel, so every test that touches it takes this lock (the same shape
// `super`'s test module uses for its own env vars).
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

struct EnvGuard {
    prev: Option<String>,
}
impl EnvGuard {
    fn set(val: &str) -> Self {
        let prev = std::env::var(RELEASE_URL_ENV).ok();
        std::env::set_var(RELEASE_URL_ENV, val);
        Self { prev }
    }
    fn clear() -> Self {
        let prev = std::env::var(RELEASE_URL_ENV).ok();
        std::env::remove_var(RELEASE_URL_ENV);
        Self { prev }
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.prev {
            Some(v) => std::env::set_var(RELEASE_URL_ENV, v),
            None => std::env::remove_var(RELEASE_URL_ENV),
        }
    }
}

#[test]
fn goarch_maps_rust_arch_names_to_upstream_go_names() {
    // The published filenames use GOARCH, not Rust's `target_arch`. `x86_64` →
    // `amd64` is the one everybody gets wrong, and the symptom is a 404 that
    // reads like an outage rather than like a naming bug.
    assert_eq!(goarch_of("x86_64"), Some("amd64"));
    assert_eq!(goarch_of("aarch64"), Some("arm64"));
    assert_eq!(goarch_of("x86"), Some("386"));
    assert_eq!(goarch_of("arm"), Some("arm"));
    assert_eq!(goarch_of("riscv64"), Some("riscv64"));
    // An architecture the upstream index does not list must be `None` so
    // `archive_url` refuses instead of synthesizing a URL that 404s. Note the
    // Rust spellings are NOT passed through verbatim — that is the whole point.
    assert_eq!(goarch_of("powerpc64"), None);
    assert_eq!(goarch_of("amd64"), None, "a GOARCH name is not a Rust arch");
    // And the host's own arch resolves through the same table.
    assert_eq!(goarch(), goarch_of(std::env::consts::ARCH));
}

#[test]
fn artifact_name_carries_the_pin_and_the_go_arch() {
    assert_eq!(
        artifact_name("arm64"),
        format!("tailscale_{TAILSCALE_TARGET_VERSION}_arm64.tgz")
    );
    // A `.tgz`, because the archive leg EXTRACTS binaries out of it. The macOS
    // `.zip` is a GUI app bundle and is deliberately not what we fetch.
    assert!(artifact_name("amd64").ends_with(".tgz"));
}

#[test]
fn archive_url_defaults_to_the_pinned_upstream_asset() {
    let _lock = lock_env();
    let _g = EnvGuard::clear();
    let Some(arch) = goarch() else {
        // No published build for this architecture — `archive_url` must refuse
        // rather than synthesize a URL that cannot exist.
        assert!(archive_url().is_err());
        return;
    };
    let (url, is_override) = archive_url().expect("a url");
    assert!(!is_override);
    assert_eq!(
        url,
        format!(
            "https://pkgs.tailscale.com/stable/tailscale_{TAILSCALE_TARGET_VERSION}_{arch}.tgz"
        ),
        "got: {url}"
    );
}

#[test]
fn the_pinned_asset_and_its_digest_come_from_one_constant() {
    // THE trap this module is built around: a version-pinned asset next to a
    // digest resolved some other way produces a checksum mismatch that never
    // self-heals (the `/resolve/main/`-beside-a-frozen-SHA scar). Assert that
    // the digest URL is literally the asset URL plus `.sha256`, so the two
    // cannot be derived from different versions.
    let _lock = lock_env();
    let _g = EnvGuard::clear();
    let Ok((url, _)) = archive_url() else {
        return;
    };
    assert!(url.contains(TAILSCALE_TARGET_VERSION), "got: {url}");
    let digest = sha256_sibling_url(&url);
    assert_eq!(digest, format!("{url}.sha256"));
    assert!(digest.contains(TAILSCALE_TARGET_VERSION), "got: {digest}");
}

#[test]
fn archive_url_uses_the_env_override_verbatim_and_trimmed() {
    // The override carries a FULL URL, not a base to append an asset name to —
    // the same contract as `RYU_GHOST_RELEASE_URL`.
    let _lock = lock_env();
    let _g = EnvGuard::set("  https://mirror.test/ts.tgz  ");
    let (url, is_override) = archive_url().expect("a url");
    assert_eq!(url, "https://mirror.test/ts.tgz");
    assert!(
        is_override,
        "the override must be flagged: it is the ONLY leg \
                          allowed to download without a verified checksum"
    );
}

#[test]
fn blank_override_falls_back_to_the_pinned_default() {
    // A blank value is "unset", not "an empty URL" — otherwise
    // `RYU_TAILSCALE_RELEASE_URL=` in an env file would make the mesh
    // uninstallable.
    let _lock = lock_env();
    let _g = EnvGuard::set("   ");
    assert!(url_override().is_none());
    if goarch().is_some() {
        let (url, is_override) = archive_url().expect("a url");
        assert!(!is_override);
        assert!(
            url.starts_with("https://pkgs.tailscale.com/stable/"),
            "got: {url}"
        );
    }
}

#[test]
fn an_override_makes_every_platform_installable() {
    // Including Windows, which uses the Ryu release-owned userspace assets.
    // desktop's offer-vs-advise branch, so it must answer true exactly when a
    // route exists.
    let _lock = lock_env();
    let _g = EnvGuard::set("https://mirror.test/ts.tgz");
    assert!(can_install());
}

#[test]
fn clean_host_release_assets_cover_supported_non_linux_targets() {
    assert_eq!(ryu_platform_for("macos", "aarch64"), Some("macos-arm64"));
    assert_eq!(ryu_platform_for("macos", "x86_64"), Some("macos-x86_64"));
    assert_eq!(
        ryu_platform_for("windows", "x86_64"),
        Some("windows-x86_64")
    );
    assert_eq!(
        ryu_platform_for("windows", "aarch64"),
        Some("windows-aarch64")
    );
    assert_eq!(ryu_platform_for("linux", "x86_64"), None);
}

#[test]
fn mesh_assets_come_from_this_cores_own_release_first() {
    if super::super::env_bin(RYU_RELEASE_BASE_ENV).is_some() {
        return; // an operator override is used alone
    }
    assert_eq!(
        ryu_release_bases(),
        vec![
            crate::update::own_release_download_base(),
            DEFAULT_RYU_RELEASE_BASE.to_owned(),
        ]
    );
    assert!(
        crate::update::own_release_download_base().ends_with(&format!(
            "/releases/download/v{}",
            crate::update::current_version()
        ))
    );
}

#[test]
fn clean_host_release_asset_names_keep_windows_extensions() {
    assert_eq!(
        ryu_asset_url("tailscaled", "macos-arm64"),
        format!("{DEFAULT_RYU_RELEASE_BASE}/tailscaled-{TAILSCALE_TARGET_VERSION}-macos-arm64")
    );
    assert_eq!(
        ryu_asset_url("tailscale", "windows-x86_64"),
        format!(
            "{DEFAULT_RYU_RELEASE_BASE}/tailscale-{TAILSCALE_TARGET_VERSION}-windows-x86_64.exe"
        )
    );
}

#[test]
fn managed_paths_live_under_the_profile_bin_dir() {
    // Profile-awareness comes from `bin_dir()` → `crate::paths::ryu_dir()`, so a
    // `RYU_PROFILE=dev` Core installs into `~/.ryu-dev/bin`. Never
    // `dirs::home_dir()` directly.
    let daemon = managed_path(DAEMON_BIN);
    assert_eq!(daemon.parent().unwrap(), bin_dir());
    assert!(daemon.ends_with(exe_name(DAEMON_BIN)));
    assert_eq!(managed_path(CLI_BIN).parent().unwrap(), bin_dir());
}

#[test]
fn the_two_binary_names_cannot_cross_match() {
    // `extract_binary_with_libs` matches on exact basename (plus `.exe`), which
    // is what lets one archive yield both binaries with two passes. A prefix
    // match would extract `tailscaled` as `tailscale` and the mesh would spawn
    // the CLI as its daemon.
    assert_ne!(DAEMON_BIN, CLI_BIN);
    assert!(DAEMON_BIN.starts_with(CLI_BIN), "the trap this guards");
}
