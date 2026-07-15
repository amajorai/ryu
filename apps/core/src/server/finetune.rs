//! Fine-tuning HTTP surface (`/api/finetune/*`) — Unsloth integration.
//!
//! Core owns *what runs* and the durable job record; the Python sidecar
//! (`crate::sidecar::providers::unsloth`) does the training. These handlers gate
//! local training on the node's GPU, proxy job control to the sidecar, persist
//! each job in [`crate::finetune::FinetuneStore`], and stream live progress back.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::finetune::adapters::{self, InstalledAdapter};
use crate::finetune::FinetuneJob;
use crate::model_catalog::device::DeviceInfo;
use crate::model_catalog::installed::{self, InstalledModel};
use crate::model_format::ModelFormat;
use crate::sidecar::providers::unsloth;

use super::ServerState;

/// Whether this node can train locally, plus a human reason when it cannot.
/// Heuristic: a discrete (non-unified) GPU detected by `nvidia-smi`. Unsloth
/// training requires an NVIDIA CUDA GPU; Apple unified memory and CPU-only boxes
/// cannot train (they fall back to a remote node — Unit 5).
fn local_capability(dev: &DeviceInfo) -> (bool, String) {
    if dev.gpu_name.is_some() && !dev.unified_memory {
        return (true, String::new());
    }
    let reason = if dev.unified_memory {
        "Apple Silicon / unified memory detected — Unsloth training needs an NVIDIA CUDA GPU. \
         Use a remote GPU node instead."
            .to_string()
    } else if dev.gpu_name.is_none() {
        "No NVIDIA GPU detected — Unsloth training needs a CUDA GPU. Use a remote GPU node instead."
            .to_string()
    } else {
        "This GPU is not supported for training — use a remote GPU node instead.".to_string()
    };
    (false, reason)
}

/// `GET /api/finetune/capability` — what this node can train, for the desktop's
/// gating UI. Combines Core's device probe (authoritative for the *local* gate)
/// with the sidecar's `/health` (authoritative for CUDA-capability + whether the
/// training deps are installed), when the sidecar is reachable.
#[utoipa::path(
    get,
    path = "/api/finetune/capability",
    tag = "Finetune",
    summary = "what this node can train, for the desktop's",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn capability(State(state): State<ServerState>) -> impl IntoResponse {
    Json(capability_value(&state).await)
}

/// Shared capability probe — the value both the HTTP handler and the plugin-host
/// bridge (`host.finetune_capability`) return, so they never drift.
pub(crate) async fn capability_value(state: &ServerState) -> Value {
    let dev = DeviceInfo::detect();
    let (can_local, reason) = local_capability(&dev);
    let sidecar = unsloth::health(&state.client).await.ok();
    json!({
        "can_train_local": can_local,
        "gpu": dev.gpu_name,
        "vram_bytes": dev.vram_bytes,
        "vram_human": dev.vram_human,
        "unified_memory": dev.unified_memory,
        "os": dev.os,
        "reason": reason,
        "sidecar": sidecar,
    })
}

/// `POST /api/finetune/start` — start a fine-tune job. Gates local training on
/// the GPU, ensures the (opt-in) sidecar is running, proxies the request, and
/// records the job. Body is forwarded verbatim to the sidecar (see
/// `apps/unsloth-sidecar` for the schema) plus an optional `target`
/// (`local` | `remote`).
#[utoipa::path(
    post,
    path = "/api/finetune/start",
    tag = "Finetune",
    summary = "start a fine-tune job. Gates local training on",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn start(State(state): State<ServerState>, Json(body): Json<Value>) -> Response {
    match dispatch(&state, body).await {
        Ok(resp) => (StatusCode::OK, Json(resp)).into_response(),
        Err((code, err)) => (code, Json(err)).into_response(),
    }
}

/// Start a fine-tune job (local or remote), returning the sidecar/remote response
/// JSON on success or a `(status, error-json)` on failure. Shared by the
/// `/api/finetune/start` handler above and the continual-learning cycle
/// ([`crate::learning::run_cycle`] with `execute: true`), so both go through the
/// same GPU gate, sidecar-ensure, and job-record path.
pub(crate) async fn dispatch(
    state: &ServerState,
    body: Value,
) -> Result<Value, (StatusCode, Value)> {
    let base_model = body
        .get("base_model_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if base_model.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            json!({ "error": "missing `base_model_id`" }),
        ));
    }

    let target = body
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or("local")
        .to_string();

    if target == "remote" {
        return dispatch_remote(state, &body, base_model).await;
    }

    // Gate local training on the node's GPU.
    let dev = DeviceInfo::detect();
    let (can_local, reason) = local_capability(&dev);
    if !can_local {
        return Err((
            StatusCode::BAD_REQUEST,
            json!({ "error": reason, "can_train_local": false }),
        ));
    }

    // The Unsloth sidecar is now owned by the `com.ryu.finetune` app (a
    // manifest-declared managed sidecar), started on plugin-enable + boot-reconcile.
    // Best-effort ensure it's up before starting a job.
    if let Err(e) = ensure_sidecar(&state).await {
        tracing::warn!("could not start unsloth sidecar before finetune: {e:#}");
    }

    match unsloth::start_finetune(&state.client, &body).await {
        Ok(resp) => {
            let job_id = resp
                .get("job_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let job_state = resp
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("running")
                .to_string();
            let output_name = body
                .get("output_name")
                .and_then(Value::as_str)
                .map(str::to_string);
            let now = chrono::Utc::now().to_rfc3339();
            let job = FinetuneJob {
                id: job_id,
                base_model,
                output_name,
                state: job_state,
                target,
                remote_url: None,
                remote_token: None,
                output_ref: None,
                error: None,
                created_at: now.clone(),
                updated_at: now,
            };
            if let Err(e) = state.finetune.record(&job).await {
                tracing::warn!("recording finetune job failed: {e:#}");
            }
            Ok(resp)
        }
        Err(e) => Err((
            StatusCode::BAD_GATEWAY,
            json!({
                "error": format!("{e:#}"),
                "hint": "Install the Unsloth fine-tuning tool from the Store, or run `bun run dev:unsloth`.",
            }),
        )),
    }
}

/// Dispatch a job to a remote Ryu Cloud GPU node (Unit 5). The desktop supplies
/// the target node's connection as `body.remote = { url, token }`; we forward the
/// job to that node's Core (forcing it to train *locally* there), then record it
/// with the remote coordinates so `get`/`stream`/`cancel` proxy back to it.
async fn dispatch_remote(
    state: &ServerState,
    body: &Value,
    base_model: String,
) -> Result<Value, (StatusCode, Value)> {
    let remote = body.get("remote");
    let url = remote
        .and_then(|r| r.get("url"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_end_matches('/')
        .to_string();
    let token = remote
        .and_then(|r| r.get("token"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if url.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            json!({ "error": "remote target needs `remote.url`" }),
        ));
    }

    // Forward verbatim but force the remote to train locally (it is the GPU node)
    // and drop our remote envelope so it doesn't recurse.
    let mut fwd = body.clone();
    if let Some(obj) = fwd.as_object_mut() {
        obj.insert("target".into(), json!("local"));
        obj.remove("remote");
    }

    let endpoint = format!("{url}/api/finetune/start");
    let mut req = state.client.post(&endpoint).json(&fwd);
    if let Some(t) = &token {
        req = req.bearer_auth(t);
    }
    match req.send().await {
        Ok(resp) => {
            let status = resp.status();
            let json_body = resp.json::<Value>().await.unwrap_or_else(|_| json!({}));
            if !status.is_success() {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    json!({
                        "error": format!("remote node returned {status}"),
                        "detail": json_body,
                    }),
                ));
            }
            let job_id = json_body
                .get("job_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let job_state = json_body
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("running")
                .to_string();
            let output_name = body
                .get("output_name")
                .and_then(Value::as_str)
                .map(str::to_string);
            let now = chrono::Utc::now().to_rfc3339();
            let job = FinetuneJob {
                id: job_id,
                base_model,
                output_name,
                state: job_state,
                target: "remote".to_string(),
                remote_url: Some(url),
                remote_token: token,
                output_ref: None,
                error: None,
                created_at: now.clone(),
                updated_at: now,
            };
            if let Err(e) = state.finetune.record(&job).await {
                tracing::warn!("recording remote finetune job failed: {e:#}");
            }
            Ok(json_body)
        }
        Err(e) => Err((
            StatusCode::BAD_GATEWAY,
            json!({ "error": format!("remote node unreachable: {e}") }),
        )),
    }
}

/// If `id` is a remote job, return its `(url, token)` for proxying. `None` for a
/// local job or an unknown id.
async fn remote_of(state: &ServerState, id: &str) -> Option<(String, Option<String>)> {
    match state.finetune.get(id).await {
        Ok(Some(job)) if job.target == "remote" => job.remote_url.map(|u| (u, job.remote_token)),
        _ => None,
    }
}

/// Mirror a sidecar snapshot's mutable fields back into the persisted record so
/// the store stays current (and terminal jobs survive a Core/sidecar restart).
async fn persist_from_snapshot(state: &ServerState, id: &str, snap: &Value) {
    let job_state = snap.get("state").and_then(Value::as_str).unwrap_or("");
    if job_state.is_empty() {
        return;
    }
    let output_ref = snap.get("output_dir").and_then(Value::as_str);
    let error = snap.get("error").and_then(Value::as_str);
    let now = chrono::Utc::now().to_rfc3339();
    if let Err(e) = state
        .finetune
        .update_state(id, job_state, output_ref, error, &now)
        .await
    {
        tracing::warn!("syncing finetune job {id} failed: {e:#}");
    }

    // On success, index the produced adapter (Unit 3). Idempotent on stem.
    if job_state == "succeeded" {
        if let Some(out) = output_ref {
            if let Ok(Some(job)) = state.finetune.get(id).await {
                let stem = job.output_name.clone().unwrap_or_else(|| {
                    std::path::Path::new(out)
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| id.to_string())
                });
                if let Err(e) = adapters::record(InstalledAdapter {
                    stem,
                    base_model: job.base_model,
                    job_id: id.to_string(),
                    path: out.to_string(),
                    created_at: now.clone(),
                }) {
                    tracing::warn!("indexing adapter for job {id} failed: {e:#}");
                }
            }
        }
    }
}

/// `GET /api/finetune/list` — the durable job list. Refreshes each job's state
/// from the sidecar when reachable (so running jobs show live state), then
/// returns the persisted records.
#[utoipa::path(
    get,
    path = "/api/finetune/list",
    tag = "Finetune",
    summary = "the durable job list. Refreshes each job's state",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list(State(state): State<ServerState>) -> impl IntoResponse {
    match list_value(&state).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response(),
    }
}

/// Shared job-list logic (`{ jobs: [...] }`) for the HTTP handler and the
/// plugin-host bridge. Overlays live sidecar snapshots onto the durable store.
pub(crate) async fn list_value(state: &ServerState) -> Result<Value, String> {
    if let Ok(Value::Array(snaps)) = unsloth::list_jobs(&state.client).await {
        for snap in &snaps {
            if let Some(id) = snap.get("id").and_then(Value::as_str) {
                persist_from_snapshot(state, id, snap).await;
            }
        }
    }
    state
        .finetune
        .list()
        .await
        .map(|jobs| json!({ "jobs": jobs }))
        .map_err(|e| format!("{e:#}"))
}

/// `GET /api/finetune/:id` — one job. Prefers the sidecar's live snapshot (and
/// persists it); falls back to the stored record when the sidecar is unreachable.
#[utoipa::path(
    get,
    path = "/api/finetune/{id}",
    tag = "Finetune",
    summary = "one job. Prefers the sidecar's live snapshot (and",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    match get_value(&state, &id).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err((code, body)) => (code, Json(body)).into_response(),
    }
}

/// Shared single-job snapshot for the HTTP handler and the plugin-host bridge.
/// Prefers the sidecar's (or remote node's) live snapshot, persisting it; falls
/// back to the stored record.
pub(crate) async fn get_value(
    state: &ServerState,
    id: &str,
) -> Result<Value, (StatusCode, Value)> {
    if let Some((base, token)) = remote_of(state, id).await {
        // Remote job: proxy the snapshot from the remote node's Core.
        let mut req = state.client.get(format!("{base}/api/finetune/{id}"));
        if let Some(t) = &token {
            req = req.bearer_auth(t);
        }
        if let Ok(resp) = req.send().await {
            if resp.status().is_success() {
                if let Ok(snap) = resp.json::<Value>().await {
                    persist_from_snapshot(state, id, &snap).await;
                    return Ok(snap);
                }
            }
        }
        // Remote unreachable — fall through to the stored record below.
    } else if let Ok(snap) = unsloth::get_job(&state.client, id).await {
        persist_from_snapshot(state, id, &snap).await;
        return Ok(snap);
    }
    match state.finetune.get(id).await {
        Ok(Some(job)) => serde_json::to_value(job).map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": format!("{e:#}") }),
            )
        }),
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            json!({ "error": format!("unknown job '{id}'") }),
        )),
        Err(e) => Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "error": format!("{e:#}") }),
        )),
    }
}

/// `DELETE /api/finetune/:id` — cooperative cancel. Proxies to the sidecar and
/// marks the stored record cancelled.
#[utoipa::path(
    delete,
    path = "/api/finetune/{id}",
    tag = "Finetune",
    summary = "cooperative cancel. Proxies to the sidecar and",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn cancel(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    match cancel_value(&state, &id).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err((code, body)) => (code, Json(body)).into_response(),
    }
}

/// Shared cooperative-cancel for the HTTP handler and the plugin-host bridge.
/// Proxies to the sidecar (or remote node) and marks the stored record cancelled.
pub(crate) async fn cancel_value(
    state: &ServerState,
    id: &str,
) -> Result<Value, (StatusCode, Value)> {
    if let Some((base, token)) = remote_of(state, id).await {
        let mut req = state.client.delete(format!("{base}/api/finetune/{id}"));
        if let Some(t) = &token {
            req = req.bearer_auth(t);
        }
        return match req.send().await {
            Ok(resp) if resp.status().is_success() => {
                let body = resp
                    .json::<Value>()
                    .await
                    .unwrap_or_else(|_| json!({ "cancelling": true }));
                let now = chrono::Utc::now().to_rfc3339();
                let _ = state
                    .finetune
                    .update_state(id, "cancelled", None, None, &now)
                    .await;
                Ok(body)
            }
            Ok(resp) => Err((
                StatusCode::BAD_GATEWAY,
                json!({ "error": format!("remote node returned {}", resp.status()) }),
            )),
            Err(e) => Err((
                StatusCode::BAD_GATEWAY,
                json!({ "error": format!("remote node unreachable: {e}") }),
            )),
        };
    }
    match unsloth::cancel_job(&state.client, id).await {
        Ok(resp) => {
            let now = chrono::Utc::now().to_rfc3339();
            let _ = state
                .finetune
                .update_state(id, "cancelled", None, None, &now)
                .await;
            Ok(resp)
        }
        Err(e) => Err((
            StatusCode::BAD_GATEWAY,
            json!({ "error": format!("{e:#}") }),
        )),
    }
}

/// `GET /api/finetune/adapters` — the installed trained adapters (Unit 3), with
/// provenance (base model + producing job).
#[utoipa::path(
    get,
    path = "/api/finetune/adapters",
    tag = "Finetune",
    summary = "the installed trained adapters (Unit 3), with",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_adapters(State(_state): State<ServerState>) -> impl IntoResponse {
    Json(json!({ "adapters": adapters::load_present() }))
}

/// `POST /api/finetune/merge` — merge a trained adapter into a GGUF (Unit 4),
/// then register it as an installed model so it is selectable as the active chat
/// model via the existing `POST /api/models/active` (llama.cpp) path. Body:
/// `{ adapter_name | adapter_path, output_name?, base_model_id?, quantization_method? }`.
#[utoipa::path(
    post,
    path = "/api/finetune/merge",
    tag = "Finetune",
    summary = "merge a trained adapter into a GGUF (Unit 4),",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn merge(State(state): State<ServerState>, Json(body): Json<Value>) -> Response {
    match merge_value(&state, body).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err((code, body)) => (code, Json(body)).into_response(),
    }
}

/// Shared adapter→GGUF merge for the HTTP handler and the plugin-host bridge.
/// Registers the merged GGUF as an installed model on success.
pub(crate) async fn merge_value(
    state: &ServerState,
    body: Value,
) -> Result<Value, (StatusCode, Value)> {
    if body.get("adapter_name").and_then(Value::as_str).is_none()
        && body.get("adapter_path").and_then(Value::as_str).is_none()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            json!({ "error": "need `adapter_name` or `adapter_path`" }),
        ));
    }

    if let Err(e) = ensure_sidecar(state).await {
        tracing::warn!("could not start unsloth sidecar before merge: {e:#}");
    }

    match unsloth::merge(&state.client, &body).await {
        Ok(resp) => {
            // Register the merged GGUF so it shows up as an installed model.
            if let (Some(stem), Some(_path)) = (
                resp.get("stem").and_then(Value::as_str),
                resp.get("gguf_path").and_then(Value::as_str),
            ) {
                let base = resp
                    .get("base_model")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let model = InstalledModel {
                    repo_id: base.clone(),
                    filename: format!("{stem}.gguf"),
                    stem: stem.to_string(),
                    size_bytes: resp.get("size_bytes").and_then(Value::as_u64),
                    format: ModelFormat::Gguf,
                    mmproj: None,
                    // Provenance: this GGUF is a merged fine-tune of `base`.
                    finetune_base: Some(base),
                };
                if let Err(e) = installed::record(model) {
                    tracing::warn!("recording merged model '{stem}' failed: {e:#}");
                }
            }
            Ok(resp)
        }
        Err(e) => Err((
            StatusCode::BAD_GATEWAY,
            json!({ "error": format!("{e:#}") }),
        )),
    }
}

/// Best-effort check that the Unsloth training sidecar is reachable before a
/// job/merge. It is a manifest-declared sidecar owned by the `com.ryu.finetune`
/// app (registered under the namespaced key `<plugin_id>/unsloth`), started on
/// plugin-enable + boot-reconcile — so Core no longer starts it inline. This is a
/// warn-only health probe; if it's down, the subsequent sidecar call returns a
/// clear error with an install/dev hint.
pub(crate) async fn ensure_sidecar(state: &ServerState) -> anyhow::Result<()> {
    unsloth::health(&state.client).await.map(|_| ())
}

/// `GET /api/finetune/:id/stream` — proxy the sidecar's SSE progress stream
/// straight through as `text/event-stream` (no re-parsing of frames).
#[utoipa::path(
    get,
    path = "/api/finetune/{id}/stream",
    tag = "Finetune",
    summary = "proxy the sidecar's SSE progress stream",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn stream(State(state): State<ServerState>, Path(id): Path<String>) -> Response {
    stream_response(&state, &id).await
}

/// Shared SSE proxy for a job's progress stream — used by the HTTP handler and by
/// the plugin-host streaming bridge (`finetune.stream`). Streams the sidecar's (or
/// remote node's) `text/event-stream` frames through verbatim.
pub(crate) async fn stream_response(state: &ServerState, id: &str) -> Response {
    // Remote jobs stream from the remote node's Core; local jobs from the sidecar.
    let (url, token) = match remote_of(state, id).await {
        Some((base, token)) => (format!("{base}/api/finetune/{id}/stream"), token),
        None => (unsloth::stream_url(id), None),
    };
    let mut req = state.client.get(&url);
    if let Some(t) = &token {
        req = req.bearer_auth(t);
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Body::from_stream(resp.bytes_stream()))
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
        Ok(resp) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("finetune stream returned {}", resp.status()) })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": format!("finetune source not reachable: {e}") })),
        )
            .into_response(),
    }
}
