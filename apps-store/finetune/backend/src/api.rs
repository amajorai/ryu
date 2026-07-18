//! Fine-tuning HTTP surface (`/api/finetune/*`) — Unsloth integration.
//!
//! Relocated out of Core (`apps/core/src/server/finetune.rs`) into this crate so
//! it can run BOTH in-process (Core merges [`routes`] into its router) and
//! out-of-process (the `ryu-finetune` control-plane sidecar in `main.rs` serves
//! the same router). It owns *what runs* (a fine-tune job on this node's GPU or a
//! remote Ryu Cloud GPU node) and the durable job record; the actual training
//! happens in the out-of-process Python worker (`apps-store/finetune/sidecar`),
//! which this surface reaches over one HTTP contract at [`FinetuneCtx::unsloth_url`]
//! (`RYU_UNSLOTH_URL`, default `http://127.0.0.1:8086`).
//!
//! The router is built with its own state ([`FinetuneCtx`]) inside this crate so it
//! returns a state-less, mergeable `Router<()>`. The routes are declared relative
//! to `/api/finetune` (the host nests this service at that prefix), while the
//! OpenAPI annotations keep the full external paths — mirroring `ryu-teams` and
//! `ryu-research`.

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use ryu_model_catalog::device::DeviceInfo;
use ryu_model_catalog::installed::{self, InstalledModel};
use ryu_model_format::ModelFormat;

use crate::adapters::{self, InstalledAdapter};
use crate::store::{FinetuneJob, FinetuneStore};

/// Default base URL of the Python Unsloth training worker (overridable via
/// `RYU_UNSLOTH_URL`). The `com.ryu.finetune` app's manifest binds the worker on
/// this same loopback port (`8086`).
pub const DEFAULT_UNSLOTH_URL: &str = "http://127.0.0.1:8086";

/// Router state for the fine-tuning HTTP surface: the durable [`FinetuneStore`],
/// an un-timed HTTP client (the adapter→GGUF merge is long-running, so no short
/// timeout), and the base URL of the Python training worker. Cheap to clone
/// (`Arc`s inside). This replaces Core's `ServerState` — the finetune handlers
/// touched only `state.finetune` + `state.client`, so this three-field state is a
/// faithful, decoupled substitute.
#[derive(Clone)]
pub struct FinetuneCtx {
    pub store: FinetuneStore,
    pub client: reqwest::Client,
    pub unsloth_url: String,
}

impl FinetuneCtx {
    /// Build a context. `unsloth_url` falls back to [`DEFAULT_UNSLOTH_URL`] when
    /// empty; the trailing slash is trimmed so `worker("/finetune")` composes
    /// cleanly.
    pub fn new(store: FinetuneStore, client: reqwest::Client, unsloth_url: impl Into<String>) -> Self {
        let mut url = unsloth_url.into();
        if url.trim().is_empty() {
            url = DEFAULT_UNSLOTH_URL.to_string();
        }
        let url = url.trim().trim_end_matches('/').to_string();
        Self {
            store,
            client,
            unsloth_url: url,
        }
    }

    /// Absolute URL of a Python worker endpoint (`path` starts with `/`).
    fn worker(&self, path: &str) -> String {
        format!("{}{path}", self.unsloth_url)
    }
}

/// Build the `/api/finetune/*` router with its own state baked in, returning a
/// state-less `Router<()>` the host nests at `/api/finetune`.
pub fn routes(ctx: FinetuneCtx) -> Router<()> {
    Router::new()
        .route("/capability", get(capability))
        .route("/start", post(start))
        .route("/list", get(list))
        .route("/adapters", get(list_adapters))
        .route("/merge", post(merge))
        .route("/:id", get(get_job).delete(cancel))
        .route("/:id/stream", get(stream))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the fine-tuning surface, merged into Core's spec
/// when the `finetune` feature is enabled.
pub fn openapi() -> utoipa::openapi::OpenApi {
    <FinetuneApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(capability, start, list, get_job, cancel, list_adapters, merge, stream))]
struct FinetuneApiDoc;

// ── Worker (Python Unsloth) HTTP proxy helpers ──────────────────────────────
// These replace Core's `sidecar::providers::unsloth::*` — the surface now targets
// `ctx.unsloth_url` directly instead of Core's hardcoded provider base URL.

/// Fetch the worker's hardware probe (`GET /health`). Used by `/api/finetune/capability`.
async fn worker_health(ctx: &FinetuneCtx) -> anyhow::Result<Value> {
    let url = ctx.worker("/health");
    let resp = ctx.client.get(&url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("unsloth /health returned {}", resp.status());
    }
    Ok(resp.json::<Value>().await?)
}

/// Start a fine-tune job on the worker (`POST /finetune`).
async fn worker_start(ctx: &FinetuneCtx, body: &Value) -> anyhow::Result<Value> {
    let url = ctx.worker("/finetune");
    let resp = ctx.client.post(&url).json(body).send().await?;
    let status = resp.status();
    let json = resp.json::<Value>().await?;
    if !status.is_success() {
        let err = json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        anyhow::bail!("unsloth /finetune failed ({status}): {err}");
    }
    Ok(json)
}

/// All in-process job snapshots from the worker (`GET /finetune`).
async fn worker_list(ctx: &FinetuneCtx) -> anyhow::Result<Value> {
    let url = ctx.worker("/finetune");
    let resp = ctx.client.get(&url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("unsloth /finetune returned {}", resp.status());
    }
    Ok(resp.json::<Value>().await?)
}

/// One job snapshot from the worker (`GET /finetune/{id}`).
async fn worker_get(ctx: &FinetuneCtx, id: &str) -> anyhow::Result<Value> {
    let url = ctx.worker(&format!("/finetune/{id}"));
    let resp = ctx.client.get(&url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("unsloth /finetune/{id} returned {}", resp.status());
    }
    Ok(resp.json::<Value>().await?)
}

/// Cancel a worker job (`DELETE /finetune/{id}`).
async fn worker_cancel(ctx: &FinetuneCtx, id: &str) -> anyhow::Result<Value> {
    let url = ctx.worker(&format!("/finetune/{id}"));
    let resp = ctx.client.delete(&url).send().await?;
    if !resp.status().is_success() {
        anyhow::bail!("unsloth cancel returned {}", resp.status());
    }
    Ok(resp.json::<Value>().await?)
}

/// Merge a trained adapter into a GGUF on the worker (`POST /finetune/merge`).
async fn worker_merge(ctx: &FinetuneCtx, body: &Value) -> anyhow::Result<Value> {
    let url = ctx.worker("/finetune/merge");
    let resp = ctx.client.post(&url).json(body).send().await?;
    let status = resp.status();
    let json = resp.json::<Value>().await?;
    if !status.is_success() {
        let err = json
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        anyhow::bail!("unsloth /merge failed ({status}): {err}");
    }
    Ok(json)
}

/// URL of the worker's SSE progress stream for a job.
fn worker_stream_url(ctx: &FinetuneCtx, id: &str) -> String {
    ctx.worker(&format!("/finetune/{id}/stream"))
}

// ── GPU gate ────────────────────────────────────────────────────────────────

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

// ── Handlers ────────────────────────────────────────────────────────────────

/// `GET /api/finetune/capability` — what this node can train, for the desktop's
/// gating UI. Combines the device probe (authoritative for the *local* gate) with
/// the worker's `/health` (authoritative for CUDA-capability + whether the
/// training deps are installed), when the worker is reachable.
#[utoipa::path(
    get,
    path = "/api/finetune/capability",
    tag = "Finetune",
    summary = "what this node can train, for the desktop's gating UI",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn capability(State(ctx): State<FinetuneCtx>) -> impl IntoResponse {
    Json(capability_value(&ctx).await)
}

/// Shared capability probe value.
pub async fn capability_value(ctx: &FinetuneCtx) -> Value {
    let dev = DeviceInfo::detect();
    let (can_local, reason) = local_capability(&dev);
    let sidecar = worker_health(ctx).await.ok();
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

/// `POST /api/finetune/start` — start a fine-tune job. Gates local training on the
/// GPU, proxies the request to the worker, and records the job. Body is forwarded
/// verbatim to the worker plus an optional `target` (`local` | `remote`).
#[utoipa::path(
    post,
    path = "/api/finetune/start",
    tag = "Finetune",
    summary = "start a fine-tune job (local GPU or remote node)",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn start(State(ctx): State<FinetuneCtx>, Json(body): Json<Value>) -> Response {
    match dispatch(&ctx, body).await {
        Ok(resp) => (StatusCode::OK, Json(resp)).into_response(),
        Err((code, err)) => (code, Json(err)).into_response(),
    }
}

/// Start a fine-tune job (local or remote), returning the worker/remote response
/// JSON on success or a `(status, error-json)` on failure.
pub async fn dispatch(ctx: &FinetuneCtx, body: Value) -> Result<Value, (StatusCode, Value)> {
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
        return dispatch_remote(ctx, &body, base_model).await;
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

    match worker_start(ctx, &body).await {
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
            if let Err(e) = ctx.store.record(&job).await {
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
    ctx: &FinetuneCtx,
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
    let mut req = ctx.client.post(&endpoint).json(&fwd);
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
            if let Err(e) = ctx.store.record(&job).await {
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
async fn remote_of(ctx: &FinetuneCtx, id: &str) -> Option<(String, Option<String>)> {
    match ctx.store.get(id).await {
        Ok(Some(job)) if job.target == "remote" => job.remote_url.map(|u| (u, job.remote_token)),
        _ => None,
    }
}

/// Mirror a worker snapshot's mutable fields back into the persisted record so the
/// store stays current (and terminal jobs survive a Core/worker restart).
async fn persist_from_snapshot(ctx: &FinetuneCtx, id: &str, snap: &Value) {
    let job_state = snap.get("state").and_then(Value::as_str).unwrap_or("");
    if job_state.is_empty() {
        return;
    }
    let output_ref = snap.get("output_dir").and_then(Value::as_str);
    let error = snap.get("error").and_then(Value::as_str);
    let now = chrono::Utc::now().to_rfc3339();
    if let Err(e) = ctx
        .store
        .update_state(id, job_state, output_ref, error, &now)
        .await
    {
        tracing::warn!("syncing finetune job {id} failed: {e:#}");
    }

    // On success, index the produced adapter (Unit 3). Idempotent on stem.
    if job_state == "succeeded" {
        if let Some(out) = output_ref {
            if let Ok(Some(job)) = ctx.store.get(id).await {
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
/// from the worker when reachable (so running jobs show live state), then returns
/// the persisted records.
#[utoipa::path(
    get,
    path = "/api/finetune/list",
    tag = "Finetune",
    summary = "the durable job list (overlaid with live worker state)",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list(State(ctx): State<FinetuneCtx>) -> impl IntoResponse {
    match list_value(&ctx).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response(),
    }
}

/// Shared job-list logic (`{ jobs: [...] }`). Overlays live worker snapshots onto
/// the durable store.
pub async fn list_value(ctx: &FinetuneCtx) -> Result<Value, String> {
    if let Ok(Value::Array(snaps)) = worker_list(ctx).await {
        for snap in &snaps {
            if let Some(id) = snap.get("id").and_then(Value::as_str) {
                persist_from_snapshot(ctx, id, snap).await;
            }
        }
    }
    ctx.store
        .list()
        .await
        .map(|jobs| json!({ "jobs": jobs }))
        .map_err(|e| format!("{e:#}"))
}

/// `GET /api/finetune/:id` — one job. Prefers the worker's live snapshot (and
/// persists it); falls back to the stored record when the worker is unreachable.
#[utoipa::path(
    get,
    path = "/api/finetune/{id}",
    tag = "Finetune",
    summary = "one job (live worker snapshot, else stored record)",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_job(State(ctx): State<FinetuneCtx>, Path(id): Path<String>) -> Response {
    match get_value(&ctx, &id).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err((code, body)) => (code, Json(body)).into_response(),
    }
}

/// Shared single-job snapshot. Prefers the worker's (or remote node's) live
/// snapshot, persisting it; falls back to the stored record.
pub async fn get_value(ctx: &FinetuneCtx, id: &str) -> Result<Value, (StatusCode, Value)> {
    if let Some((base, token)) = remote_of(ctx, id).await {
        // Remote job: proxy the snapshot from the remote node's Core.
        let mut req = ctx.client.get(format!("{base}/api/finetune/{id}"));
        if let Some(t) = &token {
            req = req.bearer_auth(t);
        }
        if let Ok(resp) = req.send().await {
            if resp.status().is_success() {
                if let Ok(snap) = resp.json::<Value>().await {
                    persist_from_snapshot(ctx, id, &snap).await;
                    return Ok(snap);
                }
            }
        }
        // Remote unreachable — fall through to the stored record below.
    } else if let Ok(snap) = worker_get(ctx, id).await {
        persist_from_snapshot(ctx, id, &snap).await;
        return Ok(snap);
    }
    match ctx.store.get(id).await {
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

/// `DELETE /api/finetune/:id` — cooperative cancel. Proxies to the worker and
/// marks the stored record cancelled.
#[utoipa::path(
    delete,
    path = "/api/finetune/{id}",
    tag = "Finetune",
    summary = "cooperative cancel (proxied to the worker/remote node)",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn cancel(State(ctx): State<FinetuneCtx>, Path(id): Path<String>) -> Response {
    match cancel_value(&ctx, &id).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err((code, body)) => (code, Json(body)).into_response(),
    }
}

/// Shared cooperative-cancel. Proxies to the worker (or remote node) and marks the
/// stored record cancelled.
pub async fn cancel_value(ctx: &FinetuneCtx, id: &str) -> Result<Value, (StatusCode, Value)> {
    if let Some((base, token)) = remote_of(ctx, id).await {
        let mut req = ctx.client.delete(format!("{base}/api/finetune/{id}"));
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
                let _ = ctx
                    .store
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
    match worker_cancel(ctx, id).await {
        Ok(resp) => {
            let now = chrono::Utc::now().to_rfc3339();
            let _ = ctx
                .store
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
    summary = "the installed trained adapters, with provenance",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_adapters() -> impl IntoResponse {
    Json(json!({ "adapters": adapters::load_present() }))
}

/// `POST /api/finetune/merge` — merge a trained adapter into a GGUF (Unit 4), then
/// register it as an installed model so it is selectable as the active chat model
/// via the existing `POST /api/models/active` (llama.cpp) path. Body:
/// `{ adapter_name | adapter_path, output_name?, base_model_id?, quantization_method? }`.
#[utoipa::path(
    post,
    path = "/api/finetune/merge",
    tag = "Finetune",
    summary = "merge a trained adapter into a GGUF + register it",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn merge(State(ctx): State<FinetuneCtx>, Json(body): Json<Value>) -> Response {
    match merge_value(&ctx, body).await {
        Ok(v) => (StatusCode::OK, Json(v)).into_response(),
        Err((code, body)) => (code, Json(body)).into_response(),
    }
}

/// Shared adapter→GGUF merge. Registers the merged GGUF as an installed model on
/// success (idempotent, into the shared `${RYU_DIR}/installed-models.json`).
pub async fn merge_value(ctx: &FinetuneCtx, body: Value) -> Result<Value, (StatusCode, Value)> {
    if body.get("adapter_name").and_then(Value::as_str).is_none()
        && body.get("adapter_path").and_then(Value::as_str).is_none()
    {
        return Err((
            StatusCode::BAD_REQUEST,
            json!({ "error": "need `adapter_name` or `adapter_path`" }),
        ));
    }

    match worker_merge(ctx, &body).await {
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

/// `GET /api/finetune/:id/stream` — proxy the worker's SSE progress stream straight
/// through as `text/event-stream` (no re-parsing of frames).
#[utoipa::path(
    get,
    path = "/api/finetune/{id}/stream",
    tag = "Finetune",
    summary = "proxy the worker's SSE progress stream",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn stream(State(ctx): State<FinetuneCtx>, Path(id): Path<String>) -> Response {
    stream_response(&ctx, &id).await
}

/// Shared SSE proxy for a job's progress stream. Streams the worker's (or remote
/// node's) `text/event-stream` frames through verbatim.
pub async fn stream_response(ctx: &FinetuneCtx, id: &str) -> Response {
    // Remote jobs stream from the remote node's Core; local jobs from the worker.
    let (url, token) = match remote_of(ctx, id).await {
        Some((base, token)) => (format!("{base}/api/finetune/{id}/stream"), token),
        None => (worker_stream_url(ctx, id), None),
    };
    let mut req = ctx.client.get(&url);
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
