//! Core-side typed HTTP client for the out-of-process `ryu-finetune` sidecar.
//!
//! Fine-tuning used to live in an in-process surface (`server/finetune.rs`) that
//! read Core's `ryu_finetune::FinetuneStore` field on `ServerState` and drove the
//! Python `unsloth` worker directly. Fine-tuning is now an out-of-process app
//! (`com.ryu.finetune`): the `ryu-finetune` sidecar owns `finetune.db`, gates local
//! training on the GPU, drives the Python worker over `RYU_UNSLOTH_URL`, and serves
//! `/api/finetune/*` — which Core exposes verbatim through the generic ext-proxy
//! `public_mount`. Core's remaining reverse-coupling is the plugin-host bridge
//! (`host.finetune_*`, how the sandboxed `com.ryu.finetune` companion drives runs):
//! it reaches the sidecar over loopback HTTP through this client instead of touching
//! an in-process store, so the sidecar is the single owner of `finetune.db`.
//!
//! Security mirrors the ext-proxy hop exactly: loopback target on the sidecar's
//! declared port ([`crate::profile::port`]-shifted for dev profiles), with the
//! per-plugin minted bearer ([`crate::sidecar::ext_proxy::ext_token`]) the sidecar
//! was spawned with — nothing hardcoded.

use axum::{
    body::Body,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use crate::sidecar::ext_proxy::{ext_token, node_token};

/// The built-in Fine-tuning app id (matches the `finetune.plugin.json` fixture id
/// and `plugins::builtins`).
const FINETUNE_PLUGIN_ID: &str = "com.ryu.finetune";
/// Fallback loopback port if the manifest is somehow absent — matches the
/// `finetune.plugin.json` fixture `port` (7990; distinct from clips 7992, quests
/// 7991, browser 7993, teams 7994, research 7995, mail 7996, dashboards 7997, and
/// the Python unsloth worker 8086). Core injects this as `RYU_FINETUNE_PORT` at spawn.
const FINETUNE_FALLBACK_PORT: u16 = 7990;

/// Resolve the `ryu-finetune` sidecar's loopback port from the loaded manifests,
/// profile-shifted the same way the ext-proxy forwards ([`crate::profile::port`]),
/// so dev/custom profiles hit the same shifted port the sidecar was told to bind.
/// Falls back to the fixture default when the manifest is missing.
pub fn sidecar_port(manifests: &[crate::plugin_manifest::PluginManifest]) -> u16 {
    let raw = manifests
        .iter()
        .find(|m| m.id == FINETUNE_PLUGIN_ID)
        .and_then(|m| m.sidecars.iter().find(|s| s.name == "ryu-finetune"))
        .map(|s| s.port)
        .unwrap_or(FINETUNE_FALLBACK_PORT);
    crate::profile::port(raw)
}

/// Typed loopback client for the `ryu-finetune` sidecar. Cheap to clone (holds only
/// the resolved port); the bearer is minted per call so it always tracks the current
/// node token.
#[derive(Clone)]
pub struct FinetuneClient {
    port: u16,
}

impl FinetuneClient {
    /// Build a client bound to the sidecar's resolved loopback port.
    pub fn new(port: u16) -> Self {
        Self { port }
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/api/finetune", self.port)
    }

    /// The per-plugin minted bearer the sidecar was spawned with — the same value
    /// the ext-proxy stamps on its hop, so a hand-rolled local request without it is
    /// rejected fail-closed.
    fn bearer(&self) -> String {
        ext_token(node_token().as_deref(), FINETUNE_PLUGIN_ID)
    }

    /// Issue a GET and return the parsed JSON body, mapping any transport error or
    /// non-2xx status to an `Err(String)` carrying the sidecar's error text — the
    /// shape the plugin-host bridge expects.
    async fn get_json(&self, path: &str) -> Result<Value, String> {
        let resp = reqwest::Client::new()
            .get(format!("{}{path}", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await
            .map_err(|e| format!("finetune sidecar not reachable: {e}"))?;
        Self::decode(resp).await
    }

    /// Issue a POST with a JSON body and return the parsed JSON body (same error
    /// mapping as [`Self::get_json`]).
    async fn post_json(&self, path: &str, body: Value) -> Result<Value, String> {
        let resp = reqwest::Client::new()
            .post(format!("{}{path}", self.base_url()))
            .bearer_auth(self.bearer())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("finetune sidecar not reachable: {e}"))?;
        Self::decode(resp).await
    }

    /// Issue a DELETE and return the parsed JSON body (same error mapping).
    async fn delete_json(&self, path: &str) -> Result<Value, String> {
        let resp = reqwest::Client::new()
            .delete(format!("{}{path}", self.base_url()))
            .bearer_auth(self.bearer())
            .send()
            .await
            .map_err(|e| format!("finetune sidecar not reachable: {e}"))?;
        Self::decode(resp).await
    }

    /// Turn a response into `Ok(body)` on 2xx or `Err(error_text)` otherwise,
    /// preferring the sidecar's `{"error": ...}` field when present.
    async fn decode(resp: reqwest::Response) -> Result<Value, String> {
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        let msg = body
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("finetune sidecar returned {status}"));
        Err(msg)
    }

    /// `GET /capability` — local-training capability verdict (GPU gate).
    pub async fn capability(&self) -> Result<Value, String> {
        self.get_json("/capability").await
    }

    /// `GET /list` — the durable job list.
    pub async fn list(&self) -> Result<Value, String> {
        self.get_json("/list").await
    }

    /// `GET /adapters` — installed merged-adapter GGUFs.
    pub async fn adapters(&self) -> Result<Value, String> {
        self.get_json("/adapters").await
    }

    /// `POST /start` — start a fine-tune job (local GPU or remote node).
    pub async fn start(&self, body: Value) -> Result<Value, String> {
        self.post_json("/start", body).await
    }

    /// `POST /merge` — merge a trained adapter into a base model + register the GGUF.
    pub async fn merge(&self, body: Value) -> Result<Value, String> {
        self.post_json("/merge", body).await
    }

    /// `GET /:id` — one job's durable record.
    pub async fn get(&self, id: &str) -> Result<Value, String> {
        self.get_json(&format!("/{id}")).await
    }

    /// `DELETE /:id` — cancel a running/pending job.
    pub async fn cancel(&self, id: &str) -> Result<Value, String> {
        self.delete_json(&format!("/{id}")).await
    }

    /// `GET /:id/stream` — proxy the sidecar's `text/event-stream` progress frames
    /// through verbatim as an axum response. Used by the plugin-host streaming
    /// bridge (`finetune.stream`) and the equivalent HTTP surface. The sidecar owns
    /// the local-vs-remote source decision, so this is a straight passthrough.
    pub async fn stream(&self, id: &str) -> Response {
        let url = format!("{}/{id}/stream", self.base_url());
        let resp = reqwest::Client::new()
            .get(&url)
            .bearer_auth(self.bearer())
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .header(header::CACHE_CONTROL, "no-cache")
                .body(Body::from_stream(r.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response()),
            Ok(r) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("finetune stream returned {}", r.status()) })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("finetune source not reachable: {e}") })),
            )
                .into_response(),
        }
    }
}
