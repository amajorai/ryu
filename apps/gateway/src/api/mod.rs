pub mod audit;
pub mod budget;
pub mod chat;
pub mod config;
pub mod evals;
pub mod evaluators;
pub mod firewall;
pub mod governance;
pub mod health;
pub mod metrics;
pub mod models;
pub mod multimodal;
pub mod sandbox;
pub mod tools;

use axum::{
    http::HeaderValue,
    response::Response,
    routing::{any, get, post},
    Router,
};

use crate::policy_alert::{PolicyAlert, POLICY_ALERT_HEADER};
use crate::state::SharedState;

/// Ok-path policy-alert stamp. Reads the [`PolicyAlert`] that a handler stashed
/// on the RESPONSE extensions and writes it as `x-ryu-policy-alert`. Conditional:
/// when the extension is absent it leaves the response untouched, so it NEVER
/// clobbers the error-path header that `GatewayError::into_response` already wrote
/// (the F1 failure mode — the error path converts below this layer).
async fn stamp_policy_alert(mut response: Response) -> Response {
    if let Some(alert) = response.extensions().get::<PolicyAlert>().cloned() {
        if let Ok(v) = HeaderValue::from_str(&alert.to_header()) {
            response.headers_mut().insert(POLICY_ALERT_HEADER, v);
        }
    }
    response
}

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
        // Community savings — public, ungated anonymous aggregate (opt-in beacon
        // source). Mirrors /metrics registration; NO admin gate.
        .route("/v1/savings", get(metrics::community_savings))
        .route("/savings", get(metrics::community_savings))
        // Local-engine admission-queue depth (Layer 2 observability)
        .route("/v1/concurrency", get(metrics::get_concurrency))
        // Evals — rolling scores + dataset runner
        .route("/v1/evals", get(evals::get_evals))
        .route("/v1/evals/run", post(evals::run_evals))
        // Unified evaluator catalog (P0): the full shared taxonomy for the
        // desktop catalog UI. Read-only over static seed data; ungated like
        // /v1/evals and /v1/firewall/check.
        .route("/v1/evaluators", get(evaluators::get_evaluators))
        // Marketplace governance (#468): grant validation + manifest signing.
        // Read-only computations over caller data; no secret exposed (pubkey only),
        // so not behind the master-key admin gate config/audit use.
        .route("/v1/grants/validate", post(governance::validate_grants))
        .route("/v1/manifests/sign", post(governance::sign_manifest))
        .route("/v1/manifests/verify", post(governance::verify_manifest))
        .route("/v1/manifests/pubkey", get(governance::get_pubkey))
        // Live per-scope budget spend (read-only; same admin gate as config/audit).
        // Exposes the in-memory per-user/agent/session token counters the budget
        // stage tracks so the desktop can render live spend (P2 #1).
        .route("/v1/budget/spend", get(budget::get_spend))
        // Audit log (local query; master-key only)
        .route("/v1/audit", get(audit::query_audit))
        // Exec audit ingest + pre-run budget gate (M6 / #192)
        .route("/v1/exec/audit", post(audit::ingest_exec_audit))
        .route("/v1/exec/budget/check", post(audit::check_exec_budget))
        // Sandbox metering + billing rail (M6 sandboxes). Core posts one tick
        // per run per heartbeat; the gateway accrues the marked-up cost, debits
        // the org wallet, and returns a continue/warn/kill verdict. Auth =
        // trusted-forwarder / master key, like exec-audit.
        .route("/sandbox/tick", post(sandbox::sandbox_tick))
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
        // Ok-path policy-alert header writer. Runs on every governed response;
        // a no-op unless a handler stashed a `PolicyAlert` on the response
        // extensions. The error-path header is written directly by
        // `GatewayError::into_response`, so this layer must stay conditional.
        .layer(axum::middleware::map_response(stamp_policy_alert))
        .with_state(state)
}

#[cfg(test)]
mod stamp_tests {
    use super::*;
    use crate::config::AlertTier;

    /// F1-twin guard: the Ok-path writer stamps the header when a handler stashed
    /// a `PolicyAlert` on the response extensions.
    #[tokio::test]
    async fn stamps_header_when_extension_present() {
        let alert =
            PolicyAlert::budget("user", "u1", "notify", AlertTier::Fanout, 10, 10, "org1");
        let mut resp = Response::new(axum::body::Body::empty());
        resp.extensions_mut().insert(alert.clone());
        let stamped = stamp_policy_alert(resp).await;
        let header = stamped
            .headers()
            .get(POLICY_ALERT_HEADER)
            .expect("ok-path response must carry the policy-alert header");
        let decoded =
            PolicyAlert::from_header(header.to_str().unwrap()).expect("header should decode");
        assert_eq!(decoded, alert);
    }

    /// The layer must be a no-op (no header) when no alert was stashed, so it can
    /// never clobber the error-path header on responses that carry no extension.
    #[tokio::test]
    async fn no_header_when_extension_absent() {
        let resp = Response::new(axum::body::Body::empty());
        let stamped = stamp_policy_alert(resp).await;
        assert!(stamped.headers().get(POLICY_ALERT_HEADER).is_none());
    }
}
