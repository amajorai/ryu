//! Vault route builders, shared JSON helpers, the model catalog and Composio integrations: `models_catalog_install` through `models_installed`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/models/catalog/install { id, file }`
///
/// Source-aware install. For an HF-compatible active model source (the default),
/// `id` is the Hub `author/name` repo and `file` the GGUF filename, downloaded
/// via the HF resolve URL. For a Ryu **model-index** active source (#461), the
/// source resolves a descriptor (download URL + sha) for `id`; Core validates
/// the descriptor URL against the SSRF guard and downloads it through the same
/// privileged [`crate::model_catalog::install_from_descriptor`] path. Either
/// way Core stays the only code that touches the disk.
#[utoipa::path(
    post,
    path = "/api/models/catalog/install",
    tag = "Models",
    summary = "Install a model file or preview the download",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 422, description = "Too large for this node's memory or free disk", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn models_catalog_install(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<ModelInstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    use crate::catalog_source::CatalogKind;

    if let Err(response) = enforce_app_lifecycle_permission_json(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_INSTALL,
    )
    .await
    {
        return response;
    }

    // Forward the caller's bearer to the marketplace install handoff (#491): a
    // PAID Ryu-Marketplace item is denied unless the buyer org holds a license.
    let buyer_token = buyer_bearer_from_headers(&headers);

    let active = state
        .catalog_sources
        .get_active(CatalogKind::Model, &state.preferences)
        .await;

    // Seam model sources (model-index or the Ryu Marketplace) install from a
    // source-supplied descriptor (arbitrary download URL), not the HF resolve
    // path.
    if active.as_ref().is_some_and(is_seam_model_source) {
        let source = active.expect("active model source present in this branch");
        let descriptor = match crate::catalog_source::with_buyer_token(
            buyer_token,
            source.install_descriptor(&state.client, &body.id),
        )
        .await
        {
            Ok(d) => d,
            Err(e) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "success": false, "error": e.to_string() })),
                );
            }
        };
        let Some(file) = descriptor.files.first().cloned() else {
            return (
                StatusCode::BAD_GATEWAY,
                Json(
                    json!({ "success": false, "error": "model index entry has no downloadable file" }),
                ),
            );
        };
        // The descriptor URL is source-supplied and becomes an outbound fetch
        // target — validate it against the SSRF guard before downloading.
        if let Err(e) = validate_remote_base_url(&file.url).await {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": format!("download URL rejected: {e}") })),
            );
        }
        if body.dry_run {
            return (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "dryRun": true,
                    "action": "install",
                    "source": source.id(),
                    "repoId": descriptor.repo_id,
                    "files": descriptor.files,
                    "writes": [],
                })),
            );
        }
        return match crate::model_catalog::install_from_descriptor(
            &descriptor.repo_id,
            &file.url,
            file.sha256.as_deref(),
            &file.dest_filename,
            &state.downloads,
        )
        .await
        {
            Ok(result) => (
                StatusCode::OK,
                Json(
                    json!({ "success": true, "result": serde_json::to_value(result).unwrap_or_default() }),
                ),
            ),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "success": false, "error": e.to_string() })),
            ),
        };
    }

    let endpoint = active_model_endpoint(&state).await;
    let format =
        crate::model_format::ModelFormat::from_wire(body.format.as_deref().unwrap_or("gguf"));

    // Refuse, before any byte is downloaded, a model this node cannot hold:
    // bigger than its memory (loading it could freeze or crash the machine) or
    // than its free disk. Fit is always this Core node's own hardware, so a
    // remote node judges installs against itself. An unknown size or unknown
    // hardware never refuses. A dry run reports the same refusal.
    if let Some(block) = crate::model_catalog::install_preflight(
        &state.client,
        &endpoint,
        &body.id,
        &body.file,
        format,
    )
    .await
    {
        let mut refusal = json!({
            "success": false,
            "error": block.message,
            "id": body.id,
            "file": body.file,
        });
        if let (Some(fields), Ok(serde_json::Value::Object(block))) =
            (refusal.as_object_mut(), serde_json::to_value(&block))
        {
            fields.extend(block);
            if body.dry_run {
                fields.insert("dryRun".to_string(), json!(true));
            }
        }
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(refusal));
    }

    if body.dry_run {
        return match crate::model_catalog::model_detail_json(
            &state.client,
            &endpoint,
            &body.id,
            format,
        )
        .await
        {
            Ok(detail) => (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "dryRun": true,
                    "action": "install",
                    "id": body.id,
                    "file": body.file,
                    "format": body.format.as_deref().unwrap_or("gguf"),
                    "detail": detail,
                    "writes": [],
                })),
            ),
            Err(error) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "success": false, "error": error.to_string() })),
            ),
        };
    }

    // Dispatch on format: GGUF is a single verified file; safetensors/MLX are a
    // multi-file repo snapshot. (Ollama is its own CLI pull, never routed here.)
    let result = if format.is_single_file() {
        crate::model_catalog::install_file(
            &state.client,
            &endpoint,
            &body.id,
            &body.file,
            &state.downloads,
        )
        .await
    } else {
        crate::model_catalog::install_snapshot(
            &state.client,
            &endpoint,
            &body.id,
            format,
            &state.downloads,
        )
        .await
    };

    match result {
        Ok(result) => (
            StatusCode::OK,
            Json(
                json!({ "success": true, "result": serde_json::to_value(result).unwrap_or_default() }),
            ),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct ModelUninstallBody {
    /// The model's repo id (used to scope cache invalidation).
    pub(in crate::server) id: String,
    /// The GGUF filename to remove (its stem is the on-disk key).
    pub(in crate::server) file: String,
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

/// `POST /api/models/catalog/uninstall { id, file }`
///
/// Delete a downloaded GGUF and clear its catalog provenance. Source-agnostic:
/// installed models live in one on-disk dir regardless of which source fetched
/// them, so this routes straight to [`crate::model_catalog::uninstall_file`]
/// (no per-source branch like install needs).
#[utoipa::path(
    post,
    path = "/api/models/catalog/uninstall",
    tag = "Models",
    summary = "Uninstall a model file or preview the removal",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_catalog_uninstall(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<ModelUninstallBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    if let Err(response) = enforce_app_lifecycle_permission_json(
        &state,
        &caller,
        crate::identity_verify::permissions::APP_UNINSTALL,
    )
    .await
    {
        return response;
    }
    if body.dry_run {
        return match crate::model_catalog::plan_uninstall_file(&body.id, &body.file) {
            Ok(plan) => (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "dryRun": true,
                    "action": "uninstall",
                    "plan": plan,
                    "writes": [],
                })),
            ),
            Err(error) => (
                StatusCode::BAD_REQUEST,
                Json(json!({ "success": false, "error": error.to_string() })),
            ),
        };
    }
    match crate::model_catalog::uninstall_file(&body.id, &body.file) {
        Ok(()) => (StatusCode::OK, Json(json!({ "success": true }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// `GET /api/models/device` — detected hardware for the fit estimate.
#[utoipa::path(
    get,
    path = "/api/models/device",
    tag = "Models",
    summary = "Detect local device RAM/VRAM for fit verdicts",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_device() -> Json<serde_json::Value> {
    let device = crate::model_catalog::device::DeviceInfo::detect();
    Json(serde_json::to_value(device).unwrap_or_default())
}

/// `GET /api/models/llmfit-estimate?repo=&context=&quant=` — on-demand hardware
/// fit + tok/s estimate for one model via the optional `llmfit` sidecar. It is
/// slow (~15s, networked) and only matches llmfit's curated catalog, so the
/// desktop calls it ONLY on an explicit "Estimate speed" click, never while
/// listing models. Always 200: the body's `installed`/`matched` flags tell the
/// UI whether to render the estimate, prompt to install llmfit, or fall back to
/// the instant native verdict.
#[utoipa::path(
    get,
    path = "/api/models/llmfit-estimate",
    tag = "Models",
    summary = "On-demand llmfit fit + tok/s estimate for one model",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_llmfit_estimate(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(repo) = params.get("repo").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `repo` query parameter" })),
        );
    };
    let context = params.get("context").and_then(|s| s.parse::<u32>().ok());
    let quant = params
        .get("quant")
        .map(String::as_str)
        .filter(|s| !s.is_empty());
    let estimate = crate::model_catalog::llmfit::estimate(repo, context, quant).await;
    (
        StatusCode::OK,
        Json(serde_json::to_value(estimate).unwrap_or_default()),
    )
}

/// `GET /api/models/installed` — the flat list of models present on disk, each
/// with its local `stem` (the servable ref), origin `repo_id`, format, size, and
/// `finetune_base` when it is a merged fine-tune. Unlike `/api/models/catalog`
/// (HF browse, keyed by repo id), this exposes every installed model by its own
/// stem — including fine-tuned GGUFs, which collapse under their base repo in the
/// catalog view. Backs the "your fine-tuned models" list and the agent model
/// picker.
#[utoipa::path(
    get,
    path = "/api/models/installed",
    tag = "Models",
    summary = "List installed models by stem (with fine-tune provenance)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn models_installed() -> Json<serde_json::Value> {
    let models = crate::model_catalog::installed::load_present();
    Json(json!({ "models": models }))
}
