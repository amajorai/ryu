//! App catalog browse, install-from-URL and hot reload: `install_app_bundle` through `PluginCatalogInstallBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/plugins/install-bundle` — install a plugin from a LOCAL bundle
/// (`{ ...manifest, ui_code? }`, the SDK `ryu pack` output). Unlike
/// [`install_app_from_url`] this carries the plugin's bundled sandboxed-UI code
/// alongside the manifest, storing it on the record so
/// [`plugin_ui_bundle`] can serve it for an enabled plugin.
///
/// Trusted, local path: the bundle is provided directly by the caller (the
/// desktop over the token'd Core API), so there is no SSRF surface. The manifest
/// id is still validated before being used as a filesystem path component, and a
/// duplicate id is rejected (never clobber an installed plugin). A trusted
/// standalone host may include `update: true` to replace an existing same-id
/// carriage while preserving its enabled state and approved grants.
#[utoipa::path(
    post,
    path = "/api/plugins/install-bundle",
    tag = "Plugins",
    summary = "Install a plugin from an uploaded bundle",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn install_app_bundle(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<serde_json::Value>,
) -> axum::response::Response {
    let bundle_update = body
        .get("update")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    // An update keeps the app's enabled state and approved grants while swapping
    // its unsigned code, so it also needs install and enable authority.
    for permission in app_bundle_guard::bundle_lifecycle_permissions(bundle_update) {
        if let Err(response) = enforce_app_lifecycle_permission(&state, &caller, permission).await {
            return response;
        }
    }

    // Split the bundle: `ui_code` is carriage, the rest is the manifest.
    let ui_code = body
        .get("ui_code")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let mut manifest_value = body.clone();
    if let Some(obj) = manifest_value.as_object_mut() {
        obj.remove("ui_code");
        obj.remove("update");
    }

    let manifest: crate::plugin_manifest::PluginManifest =
        match serde_json::from_value(manifest_value.clone()) {
            Ok(m) => m,
            Err(e) => {
                return json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    format!("Invalid manifest JSON: {e}"),
                );
            }
        };

    // A bundle must be SELF-CONTAINED: `ryu pack` inlines every `code_file` into
    // `code`, so one surviving here means the bundle was hand-assembled or built by
    // a stale packer, and the hook body it names is not in the bundle at all.
    if let Err(e) = manifest.validate_code_sources() {
        return json_error(StatusCode::UNPROCESSABLE_ENTITY, e);
    }

    // Corruption self-check (advisory, NOT a trust boundary): a LOCAL bundle
    // carries no gateway signature, so this is not the marketplace integrity gate.
    // But `ryu pack` writes `ui_code_sha256` into the manifest, so if present it
    // must match the bundled code — a mismatch means a corrupted/edited bundle and
    // installing it would silently run code the manifest does not describe.
    if let Some(declared) = manifest
        .ui_code_sha256
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        match ui_code.as_deref() {
            Some(code) => {
                use sha2::{Digest, Sha256};
                let actual = hex::encode(Sha256::digest(code.as_bytes()));
                if actual != declared.to_ascii_lowercase() {
                    return json_error(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        format!(
                            "bundle ui_code hash mismatch (manifest declares {declared}, code hashes to {actual}); refusing corrupted bundle"
                        ),
                    );
                }
            }
            None => {
                return json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "bundle manifest declares ui_code_sha256 but carries no ui_code".to_owned(),
                );
            }
        }
    }

    // Backend self-check (advisory, mirrors the ui_code_sha256 gate above): the
    // node backend bundle rides INLINE in the manifest (unlike `ui_code`), so
    // `ryu pack` writes `backend_sha256` over it. If present it must match the
    // carried `backend_code` — a mismatch means a corrupted/edited local bundle
    // whose backend would run code the manifest does not describe. The SPAWN-time
    // fail-closed check (`manifest_sidecar::prepare_node_backend`) still stands;
    // this simply refuses the corruption at the install door for a clear error.
    if let Some(declared) = manifest
        .backend_sha256
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        match manifest.backend_code.as_deref() {
            Some(code) => {
                use sha2::{Digest, Sha256};
                let actual = hex::encode(Sha256::digest(code.as_bytes()));
                if actual != declared.to_ascii_lowercase() {
                    return json_error(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        format!(
                            "bundle backend_code hash mismatch (manifest declares {declared}, code hashes to {actual}); refusing corrupted bundle"
                        ),
                    );
                }
            }
            None => {
                return json_error(
                    StatusCode::UNPROCESSABLE_ENTITY,
                    "bundle manifest declares backend_sha256 but carries no backend_code"
                        .to_owned(),
                );
            }
        }
    }

    let app_name = manifest.name.clone();
    let app_version = manifest.version.clone();
    if bundle_update {
        return match update_installed_plugin_bundle(&state, manifest, ui_code).await {
            Ok(body) => {
                crate::events::publish_system_notification(
                    "App updated",
                    format!("{app_name} {app_version} is updated and ready."),
                    "success",
                );
                Json(body).into_response()
            }
            Err((status, msg)) => json_error(status, msg),
        };
    }
    match persist_installed_plugin(&state, manifest, ui_code, None).await {
        Ok(body) => {
            crate::events::publish_system_notification(
                "App installed",
                format!("{app_name} {app_version} is installed and ready to enable."),
                "success",
            );
            Json(body).into_response()
        }
        Err((status, msg)) => json_error(status, msg),
    }
}

/// Maximum size of a plugin's bundled sandboxed-UI code (32 MiB). Enforced at both
/// the install boundary here and the marketplace integrity gate
/// (`catalog_source::sources`), so a pathological bundle is refused before storage.
pub(in crate::server) const MAX_UI_CODE_BYTES: usize = 32 * 1024 * 1024;

/// Maximum JSON request body for a local plugin bundle. This is intentionally
/// larger than [`MAX_UI_CODE_BYTES`] to leave room for the manifest and its
/// optional inline backend while keeping the limit scoped to the carriage route.
pub(in crate::server) const MAX_PLUGIN_BUNDLE_BYTES: usize = 40 * 1024 * 1024;

/// Maximum JSON envelope for one app host-bridge call. App-owned files use the
/// durable `storage:kv` bridge in the current Companion contract, so the wire
/// envelope includes base64 overhead in addition to the file bytes. Keep this
/// bounded and scoped to the bridge instead of changing Axum's global default.
pub(in crate::server) const MAX_PLUGIN_HOST_BODY_BYTES: usize = 64 * 1024 * 1024;
/// Streaming agent calls carry text/task envelopes, not binary storage files;
/// keep their request budget separate from the unary bridge's 64 MiB storage cap.
pub(in crate::server) const MAX_PLUGIN_HOST_STREAM_BODY_BYTES: usize = 1024 * 1024;

/// Maximum size of a plugin's inline node-backend bundle (`backend_code`, 4 MiB).
/// The backend analogue of [`MAX_UI_CODE_BYTES`]; enforced in the shared install
/// sink ([`persist_installed_plugin`]) so a pathological backend is refused before
/// storage on every install path (local bundle + marketplace catalog).
pub(in crate::server) const MAX_BACKEND_CODE_BYTES: usize = 4 * 1024 * 1024;

/// `{ id }` body for [`install_plugin_from_catalog`].
#[derive(serde::Deserialize)]
pub(in crate::server) struct PluginCatalogInstallBody {
    pub(in crate::server) id: String,
    /// The release train to install from — `stable` (the default), or a prerelease
    /// channel the listing actually publishes (`beta`, `rc`, `nightly`, `canary`,
    /// … — whatever the first identifier of its published prerelease versions
    /// spells). Absent means stable.
    ///
    /// The chosen channel is PERSISTED on the lifecycle record, so the update path
    /// keeps re-resolving on the same train instead of pulling the install back to
    /// stable on its next check.
    #[serde(default)]
    pub(in crate::server) channel: Option<String>,
    /// Exact historical release tag selected from the Versions tab. This is
    /// mutually exclusive with `channel` and is resolved only by the trusted
    /// Marketplace source.
    #[serde(default)]
    pub(in crate::server) version: Option<String>,
}
