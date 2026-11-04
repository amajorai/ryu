//! Node init, sidecar install and status, support diagnostics and active engine/model selection: `node_init` through `restore_cleared_version_record`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/api/node/init",
    tag = "Nodes",
    summary = "Initialize or fetch this node's token",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn node_init() -> (StatusCode, Json<serde_json::Value>) {
    node_init_at(&crate::paths::secret_path("core.token"))
}

pub(in crate::server) fn node_init_at(
    token_path: &std::path::Path,
) -> (StatusCode, Json<serde_json::Value>) {
    use std::io::Write;

    if let Some(parent) = token_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            );
        }
        // Restrict ~/.ryu to owner-only so tokens/keys stored inside are not
        // world-readable on multi-user systems.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }

    let token = format!("ryu_{}", uuid::Uuid::new_v4().simple());
    // The value is returned once below and never read back, so only its
    // sealed envelope (`enc:v1:`, master key) is persisted. Fails closed.
    let sealed = match ryu_crypto::seal_str(&token) {
        Ok(sealed) => sealed,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    json!({ "success": false, "error": format!("cannot seal node identity: {error}") }),
                ),
            );
        }
    };

    // Use create_new(true) for an atomic "create-or-fail" open — no TOCTOU race.
    // Set 0o600 so the token file is owner-read/write only.
    let mut open_opts = std::fs::OpenOptions::new();
    open_opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open_opts.mode(0o600);
    }
    let result = open_opts
        .open(token_path)
        .and_then(|mut f| f.write_all(sealed.as_bytes()));

    match result {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "success": true, "token": token })),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (
            StatusCode::CONFLICT,
            Json(json!({ "success": false, "error": "already_initialized" })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    get,
    path = "/api/setup/list",
    tag = "Sidecars",
    summary = "List installed sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_installed(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::sidecar::download_manager::VersionStore;

    // Merge persistent VersionStore with the in-session SetupManager cache.
    let store = VersionStore::load();
    let mut known: std::collections::HashSet<String> = store.versions.keys().cloned().collect();
    for name in state.setup.list_installed().await {
        known.insert(name);
    }

    // For sidecars that ship a binary into ~/.ryu/bin/, verify it exists on
    // disk so the UI always reflects reality even after manual deletions.
    let installed: Vec<String> = known
        .into_iter()
        .filter(|name| binary_installed_on_disk(name))
        .collect();

    Json(json!({ "installed": installed }))
}

/// Query for `POST /api/setup/{name}/install`.
#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct InstallSidecarQuery {
    /// Re-download even when the entry is already installed.
    ///
    /// This is what an "Update" press sends. A plain install is idempotent by
    /// design (it backs the auto-install-on-first-use path), so without this the
    /// update and the install are indistinguishable and the update silently
    /// no-ops.
    #[serde(default)]
    pub(in crate::server) force: bool,
    /// Expected release-train version for the desktop-owned Island companion.
    /// Other sidecars ignore it and use their own pinned/upstream version.
    pub(in crate::server) version: Option<String>,
    /// Wait for the Island bundle to finish installing. The normal sidecar
    /// endpoint remains fire-and-forget; Desktop uses this only for the
    /// companion path so it can launch a fully materialized bundle later.
    #[serde(default)]
    pub(in crate::server) wait: bool,
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

/// Every sidecar whose files a forced reinstall of `name` replaces.
///
/// The llama.cpp family runs from ONE install directory, which the installer
/// wipes and re-extracts; a running embed or rerank server would lock it on
/// Windows or have its libraries deleted under it on Unix, so all of them stop
/// for the update, not just the one named.
pub(in crate::server) fn sidecars_sharing_install(name: &str) -> Vec<&'static str> {
    const LLAMACPP_FAMILY: &[&str] = &[
        "llamacpp",
        "llamacpp-embed",
        "llamacpp-rerank",
        "llamacpp-classify",
        "llamacpp-speech",
        "llamacpp-guard",
        "outetts",
    ];
    if matches!(name, "llamacpp" | "llamacpp-embed") {
        return LLAMACPP_FAMILY.to_vec();
    }
    crate::catalog::registry::static_registry()
        .into_iter()
        .map(|entry| entry.name)
        .chain(LLAMACPP_FAMILY.iter().copied())
        .find(|known| *known == name)
        .into_iter()
        .collect()
}

/// The `versions.json` keys a forced reinstall of catalog entry `name` must
/// clear so its installer re-downloads.
///
/// Most entries record under their own name. These do not: their installers'
/// fast paths key on per-artifact records, so clearing only `name` removed
/// nothing and "Update" reported success having done nothing at all.
pub(in crate::server) fn forced_update_version_keys(name: &str) -> Vec<String> {
    use crate::sidecar::providers::{outetts, parakeet, ryutts};
    let owned: &[&str] = match name {
        "parakeet" => &[parakeet::downloader::MODEL_STORE_KEY],
        "outetts" => &[
            outetts::downloader::MODEL_STORE_KEY,
            outetts::downloader::VOCODER_STORE_KEY,
        ],
        "ryutts" => &[
            ryutts::kokoro::MODEL_STORE_KEY,
            ryutts::kokoro::VOICES_STORE_KEY,
        ],
        // The embedding engine IS the llama.cpp binary.
        "llamacpp-embed" => &["llamacpp"],
        _ => &[],
    };
    std::iter::once(name)
        .chain(owned.iter().copied())
        .map(str::to_owned)
        .collect()
}

/// Put back a version record a forced reinstall cleared, when that reinstall
/// failed and wrote no record of its own. A record the downloader DID write (a
/// partial success that recorded a new version) is left alone.
pub(in crate::server) fn restore_cleared_version_record(
    name: &str,
    version: &str,
    checksum: Option<&str>,
) {
    use crate::sidecar::download_manager::VersionStore;
    if VersionStore::load().versions.contains_key(name) {
        return;
    }
    let restored = match checksum {
        Some(checksum) => VersionStore::record_persisted(name, version, checksum),
        None => VersionStore::set_version_persisted(name, version),
    };
    if let Err(error) = restored {
        tracing::warn!("could not restore the version record for '{name}': {error}");
    }
}
