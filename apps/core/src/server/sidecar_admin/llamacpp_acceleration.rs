//! Node init, sidecar install and status, support diagnostics and active engine/model selection: `apply_llamacpp_variant` through `SetActiveModelBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Persist `requested` (`auto` or a variant name) as the llama.cpp acceleration
/// choice and make the machine match it: install that build if it isn't the one
/// on disk, and restart the engine if it is currently resident.
///
/// Refuses an accelerated build this node cannot run — that is the "don't
/// install the GPU version on GPU-less hardware" gate, enforced here rather than
/// only in the UI so an API caller cannot route around it.
pub(in crate::server) async fn apply_llamacpp_variant(
    state: &ServerState,
    requested: &str,
) -> anyhow::Result<()> {
    use crate::sidecar::providers::llamacpp::{variant, LlamaCppDownloader};

    let device = variant::device();
    if let Some(v) = variant::LlamaVariant::parse(requested) {
        if !v.available_on(device) {
            anyhow::bail!(
                "{} is not available on this computer: {}",
                v.label(),
                v.unavailable_reason(device)
                    .unwrap_or("unsupported hardware")
            );
        }
    } else if !requested.eq_ignore_ascii_case(variant::AUTO) {
        anyhow::bail!("unknown llama.cpp acceleration '{requested}'");
    }

    state
        .preferences
        .set(variant::VARIANT_PREF, requested)
        .await
        .map_err(|e| anyhow::anyhow!("could not save the acceleration choice: {e}"))?;

    let resolved = variant::LlamaVariant::resolve(Some(requested), device);
    if variant::installed_variant() == Some(resolved) {
        return Ok(());
    }

    // The build on disk is the wrong one. Stop the engine before replacing its
    // directory — the install wipes it, and unlinking a running server's backend
    // libraries is how you get a process that is alive but cannot serve.
    let was_resident = state.manager.active_local_engine().await.as_deref() == Some("llamacpp");
    if was_resident {
        if let Err(e) = state.manager.stop_sidecar("llamacpp").await {
            tracing::warn!("could not stop llama.cpp before swapping its build: {e}");
        }
    }
    LlamaCppDownloader::new()
        .ensure_variant_installed(&state.downloads, resolved)
        .await?;
    // The installer writes `versions.json`, but the manager's in-memory
    // installed set is only seeded at boot — without this, choosing a build on a
    // node that never had llama.cpp installs it and then refuses to make it
    // resident ("llamacpp is not installed") until Core restarts.
    state.manager.mark_installed("llamacpp").await;
    if was_resident {
        state.manager.start_sidecar("llamacpp").await?;
    }
    Ok(())
}

/// Report which llama.cpp build is selected, which one is installed, what this
/// machine's hardware supports, and every option with a plain-language reason
/// when it is unavailable.
///
/// The shape is deliberately "answer, then options": `resolved` is what will
/// actually run, so a client can show one sentence ("Using your graphics card")
/// without the user needing to know what CUDA or Vulkan is.
#[utoipa::path(
    get,
    path = "/api/engine/llamacpp/acceleration",
    tag = "Engines",
    summary = "Get the llama.cpp acceleration (CPU vs GPU build)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_llamacpp_acceleration(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::model_catalog::device::has_usable_gpu;
    use crate::sidecar::providers::llamacpp::variant::{self, LlamaVariant, AUTO, VARIANT_PREF};

    let device = variant::device();
    let selected = state
        .preferences
        .get(VARIANT_PREF)
        .await
        .ok()
        .flatten()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| AUTO.to_string());
    let resolved = LlamaVariant::resolve(Some(&selected), device);

    let options: Vec<_> = LlamaVariant::ALL
        .iter()
        .map(|v| {
            json!({
                "id": v.as_str(),
                "label": v.label(),
                "description": v.description(),
                "available": v.available_on(device),
                "unavailable_reason": v.unavailable_reason(device),
            })
        })
        .collect();

    Json(json!({
        "selected": selected,
        "resolved": resolved.as_str(),
        "resolved_label": resolved.label(),
        "installed": crate::sidecar::providers::llamacpp::variant::installed_variant()
            .map(|v| v.as_str()),
        "has_gpu": has_usable_gpu(device),
        "gpu_name": device.gpu_name.clone(),
        "vram": device.vram_human.clone(),
        "options": options,
    }))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetLlamacppAccelerationBody {
    /// `auto` (the default) or a variant id from the `options` list.
    pub(in crate::server) variant: String,
}

/// Choose the llama.cpp build. `auto` re-detects the hardware; an explicit id
/// pins it. Installing the new build happens here, synchronously, so the caller
/// knows whether the choice actually took.
#[utoipa::path(
    post,
    path = "/api/engine/llamacpp/acceleration",
    tag = "Engines",
    summary = "Choose the llama.cpp acceleration (CPU vs GPU build)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_llamacpp_acceleration(
    State(state): State<ServerState>,
    Json(body): Json<SetLlamacppAccelerationBody>,
) -> (StatusCode, Json<serde_json::Value>) {
    match apply_llamacpp_variant(&state, &body.variant).await {
        Ok(()) => {
            let installed = crate::sidecar::providers::llamacpp::variant::installed_variant();
            (
                StatusCode::OK,
                Json(json!({
                    "success": true,
                    "selected": body.variant,
                    "installed": installed.map(|v| v.as_str()),
                })),
            )
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "success": false, "error": e.to_string() })),
        ),
    }
}

/// Report the default sandbox backend, plus every known backend with its live
/// availability (detected on this node) and platform support. Mirrors
/// `GET /api/engine/active`, but a sandbox backend is a *default* (per-call
/// overridable), not an exclusive resident slot, so there is no "running" field.
#[utoipa::path(
    get,
    path = "/api/sandbox/backend",
    tag = "Sandboxes",
    summary = "Get the default sandbox backend and available backends",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_sandbox_backend(
    State(_state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::sidecar::sandbox;

    let active = sandbox::configured_backend().as_str().to_owned();
    let mut available = Vec::new();
    for name in sandbox::KNOWN_BACKENDS {
        available.push(json!({
            "name": name,
            "display_name": sandbox::backend_display_name(name),
            "detected": sandbox::detect_backend(name).await,
            "supported": crate::catalog::registry::supported_on_node(name),
        }));
    }
    Json(json!({
        "active": active,
        "available": available,
    }))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetSandboxBackendBody {
    pub(in crate::server) name: String,
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

/// Set the default sandbox backend. Persists to `~/.ryu/sandbox-backend.json`
/// (read by `configured_backend()`); the change takes effect on the next
/// `sandbox_exec` call that omits an explicit `backend`. An unknown/empty name
/// is rejected.
#[utoipa::path(
    post,
    path = "/api/sandbox/backend",
    tag = "Sandboxes",
    summary = "Set or preview the default sandbox backend",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_sandbox_backend(
    State(_state): State<ServerState>,
    Json(body): Json<SetSandboxBackendBody>,
) -> Json<serde_json::Value> {
    use crate::sidecar::sandbox::{self, SandboxBackend, SandboxBackendStore};

    let name = body.name.trim();
    // Validate it parses to a backend we can actually build/run.
    match SandboxBackend::from_name(name) {
        Ok(_) if sandbox::KNOWN_BACKENDS.contains(&name) => {}
        _ => {
            return Json(json!({
                "success": false,
                "error": format!("unknown sandbox backend '{name}'"),
            }));
        }
    }
    if body.dry_run {
        let active = sandbox::configured_backend().as_str().to_owned();
        return Json(json!({
            "success": true,
            "dryRun": true,
            "action": "set",
            "active": active,
            "requested": name,
            "alreadyActive": active == name,
            "detected": sandbox::detect_backend(name).await,
            "supported": crate::catalog::registry::supported_on_node(name),
            "wouldPersist": true,
            "writes": ["sandbox-backend.json"]
        }));
    }
    match SandboxBackendStore::save(Some(name)) {
        Ok(()) => Json(json!({ "success": true, "active": name })),
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}

/// `GET /api/models/active` — the GGUF the local chat engine is serving.
///
/// Reports the user-selected active model override (the local stem persisted in
/// preferences and its originating Hugging Face repo when known) plus the
/// registry default it falls back to. `active` is the default when no override
/// is set, so a client always learns the effective served model.
#[utoipa::path(
    get,
    path = "/api/models/active",
    tag = "Models",
    summary = "Get the active served local chat model",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_active_model(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::model_catalog::installed;

    // The pref is a structured {engine, format, ref}; legacy bare stems parse as
    // GGUF. Surface the parsed shape so clients learn the engine + format, not a
    // raw JSON blob.
    let raw = state
        .preferences
        .get(installed::ACTIVE_MODEL_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let active = installed::parse_active_pref(&raw);

    let registry = crate::registry::ModelRegistry::from_env();
    let default_id = registry.local_chat_model.id.clone();

    let (active_ref, engine, format) = match &active {
        Some(a) => (a.r#ref.clone(), Some(a.engine.clone()), a.format.as_str()),
        None => (default_id.clone(), None, "gguf"),
    };
    // For a GGUF selection the ref is a stem whose origin repo we can resolve;
    // for a snapshot the ref *is* the repo id.
    let repo_id = active.as_ref().and_then(|a| match a.format {
        crate::model_format::ModelFormat::Gguf => installed::repo_for_stem(&a.r#ref),
        _ => Some(a.r#ref.clone()),
    });

    Json(json!({
        "active": active_ref,
        "engine": engine,
        "format": format,
        "ref": active.as_ref().map(|a| a.r#ref.clone()),
        "repo_id": repo_id,
        "default": default_id,
    }))
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetActiveModelBody {
    /// Either a local stem or the Hugging Face `repo_id` of an installed model
    /// (the form carried by a `ryu://models/...` deep link).
    pub(in crate::server) id: String,
    /// Optional explicit engine override (e.g. `"ollama"` instead of the picker's
    /// default `"llamacpp"` for a GGUF model). When omitted, the engine is
    /// derived from the model's format via `pick_engine`.
    #[serde(default)]
    pub(in crate::server) engine: Option<String>,
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}
