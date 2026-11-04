//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations: `models_updates` through `system_info_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/models/updates` — which installed GGUF models have a newer file
/// upstream. Detection is a cheap, retroactive **file-size compare**: the model
/// author re-uploading a quant changes the file's byte size, so an installed
/// model whose on-disk `size_bytes` differs from the Hub's current size for the
/// same filename is stale. This avoids re-hashing multi-GB files on every check
/// and never false-positives on a README edit (unlike a repo `lastModified`
/// timestamp). The per-repo detail lookup is cached (see `model_detail_json`).
///
/// Snapshot (safetensors/MLX) models are skipped for now — they are multi-file
/// repos with no single `size_bytes` to compare.
#[utoipa::path(
    get,
    path = "/api/models/updates",
    tag = "Models",
    summary = "Installed GGUF models with a newer file available upstream",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_updates(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::model_format::ModelFormat;

    let installed = crate::model_catalog::installed::load_present();
    let endpoint = active_model_endpoint(&state).await;
    // One detail fetch per distinct repo, reused across its files.
    let mut detail_by_repo: std::collections::HashMap<String, Option<serde_json::Value>> =
        std::collections::HashMap::new();
    let mut updates = Vec::new();

    for m in installed {
        if !matches!(m.format, ModelFormat::Gguf) {
            continue;
        }
        let Some(installed_size) = m.size_bytes else {
            continue;
        };
        if !detail_by_repo.contains_key(&m.repo_id) {
            let detail = crate::model_catalog::model_detail_json(
                &state.client,
                &endpoint,
                &m.repo_id,
                ModelFormat::Gguf,
            )
            .await
            .ok();
            detail_by_repo.insert(m.repo_id.clone(), detail);
        }
        let Some(Some(detail)) = detail_by_repo.get(&m.repo_id) else {
            continue;
        };
        let Some(files) = detail.get("files").and_then(|f| f.as_array()) else {
            continue;
        };
        let latest = files.iter().find(|f| {
            f.get("filename").and_then(serde_json::Value::as_str) == Some(m.filename.as_str())
        });
        let Some(latest_size) = latest
            .and_then(|f| f.get("size_bytes"))
            .and_then(serde_json::Value::as_u64)
        else {
            continue;
        };
        if latest_size != installed_size {
            updates.push(json!({
                "stem": m.stem,
                "repo_id": m.repo_id,
                "filename": m.filename,
                "name": m.repo_id,
                "installed_size": installed_size,
                "latest_size": latest_size,
            }));
        }
    }

    Json(json!({ "updates": updates }))
}

/// `GET /api/models/engines` — the format → engine capability map for THIS node,
/// with per-engine `supported` flags and the currently resident engine. The
/// desktop renders compatibility annotations + the format facet from this
/// without guessing; the verdict is authoritative because it is computed on the
/// (possibly remote) Core node.
#[utoipa::path(
    get,
    path = "/api/models/engines",
    tag = "Models",
    summary = "Format → engine capability map + node support",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_engines(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::model_format::{engines_for_format, format_supported_on_node, ModelFormat};

    let supported = crate::catalog::registry::supported_on_node;
    let formats: Vec<serde_json::Value> = ModelFormat::ALL
        .iter()
        .map(|fmt| {
            let engines: Vec<serde_json::Value> = engines_for_format(*fmt)
                .into_iter()
                .map(|e| json!({ "name": e, "supported": supported(e) }))
                .collect();
            json!({
                "format": fmt.as_str(),
                "supported": format_supported_on_node(*fmt, supported),
                "engines": engines,
            })
        })
        .collect();

    Json(json!({
        "formats": formats,
        "resident": state.manager.active_local_engine().await,
    }))
}

/// `GET /api/system/info` — live CPU/RAM/disk/GPU snapshot for this node.
#[utoipa::path(
    get,
    path = "/api/system/info",
    tag = "Health",
    summary = "Live CPU/RAM/disk/GPU snapshot for this node",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn system_info_handler() -> Json<serde_json::Value> {
    // Detection spawns subprocesses (nvidia-smi) and enumerates disks, so keep it
    // off the async worker thread.
    match tokio::task::spawn_blocking(crate::system_info::SystemInfo::detect).await {
        Ok(info) => Json(serde_json::to_value(info).unwrap_or_default()),
        Err(_) => Json(serde_json::json!({})),
    }
}
