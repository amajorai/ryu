pub mod audit;
pub mod chat;
pub mod config;
pub mod evals;
pub mod firewall;
pub mod governance;
pub mod health;
pub mod metrics;
pub mod models;
pub mod multimodal;
pub mod tools;

use axum::{
    routing::{any, get, post},
    Router,
};

use crate::state::SharedState;

pub fn router(state: SharedState) -> Router {
    Router::new()
        // OpenAI-compatible chat endpoint
        .route("/v1/chat/completions", post(chat::chat_completions))
        // Cursor alias (#7). Cursor's "Override OpenAI Base URL" already emits the
        // OpenAI `/v1/chat/completions` shape, so this is a labelled alias to the
        // same governed pipeline — point Cursor at `<gateway>/v1/cursor`. Leaves a
        // seam for full Cursor-protocol translation if ever needed.
        .route("/v1/cursor/chat/completions", post(chat::chat_completions))
        // OpenAI-compatible multimodal endpoints (routed through the same pipeline)
        .route(
            "/v1/images/generations",
            post(multimodal::image_generations),
        )
        .route("/v1/audio/speech", post(multimodal::audio_speech))
        .route(
            "/v1/audio/transcriptions",
            post(multimodal::audio_transcriptions),
        )
        // Video generation (job-based: submit + poll)
        .route(
            "/v1/videos/generations",
            post(multimodal::video_generations),
        )
        .route(
            "/v1/videos/generations/:id",
            get(multimodal::video_job_status),
        )
        // Modality registry
        .route("/v1/modalities", get(multimodal::list_modalities))
        .route("/v1/models", get(models::list_models))
        // Tools (Composio action registry)
        .route("/v1/tools/composio", get(tools::list_composio_tools))
        // Metrics
        .route("/metrics", get(metrics::get_metrics))
        .route("/v1/metrics", get(metrics::get_metrics))
        // Local-engine admission-queue depth (Layer 2 observability)
        .route("/v1/concurrency", get(metrics::get_concurrency))
        // Evals — rolling scores + dataset runner
        .route("/v1/evals", get(evals::get_evals))
        .route("/v1/evals/run", post(evals::run_evals))
        // Marketplace governance (#468): grant validation + manifest signing.
        // Read-only computations over caller data; no secret exposed (pubkey only),
        // so not behind the master-key admin gate config/audit use.
        .route("/v1/grants/validate", post(governance::validate_grants))
        .route("/v1/manifests/sign", post(governance::sign_manifest))
        .route("/v1/manifests/verify", post(governance::verify_manifest))
        .route("/v1/manifests/pubkey", get(governance::get_pubkey))
        // Audit log (local query; master-key only)
        .route("/v1/audit", get(audit::query_audit))
        // Exec audit ingest + pre-run budget gate (M6 / #192)
        .route("/v1/exec/audit", post(audit::ingest_exec_audit))
        .route("/v1/exec/budget/check", post(audit::check_exec_budget))
        // Unified tool gateway: governance front for direct tool/code execution (#475)
        .route("/v1/exec/tool", post(crate::tools::exec::exec_tool))
        // Pre-exec command governance (COMMAND-SCAN): hardline blocklist + risk
        // patterns under manual/smart/off. Core posts { backend, command,
        // session_id, agent } and maps the { decision, reason, findings } verdict.
        .route("/v1/exec/scan", post(crate::tools::exec::exec_scan))
        // Config (runtime-mutable; master-key only)
        .route(
            "/v1/config",
            get(config::get_config).put(config::put_config),
        )
        // Firewall guardrail check (read-only over caller text; ungated like
        // governance). Called by Core's workflow Guardrails node.
        .route("/v1/firewall/check", post(firewall::firewall_check))
        // Transparent passthrough proxy for native-format subscription agents
        // (Claude Code → Anthropic). Loopback-only; forwards the caller's OWN
        // subscription auth unchanged while applying request-side DLP + audit.
        // Pointed at via `ANTHROPIC_BASE_URL=<gateway>/passthrough/anthropic`.
        .route(
            "/passthrough/anthropic/*path",
            any(crate::passthrough::anthropic),
        )
        // Codex (ChatGPT-login subscription) → OpenAI Responses backend. Same
        // loopback-only, subscription-preserving passthrough; forwards the
        // caller's OAuth bearer AND ChatGPT-Account-ID header unchanged.
        // Pointed at via an isolated CODEX_HOME provider base_url.
        .route(
            "/passthrough/openai-responses/*path",
            any(crate::passthrough::codex),
        )
        // Health / meta
        .route("/health", get(health::health))
        .route("/v1/health", get(health::health))
        .with_state(state)
}
