mod audio_wire;
pub mod audit;
pub mod batches;
pub mod budget;
pub mod channel_pairing;
pub mod chat;
pub mod compat;
pub mod config;
pub mod doctor;
pub mod egress_posture;
pub mod embeddings;
pub mod evals;
pub mod evaluators;
pub mod firewall;
pub mod governance;
pub mod health;
pub mod http_conventions;
pub mod metrics;
pub mod models;
pub mod multimodal;
pub mod phone_calls;
pub mod providers;
pub mod responses;
mod responses_hosted;
mod responses_stream;
pub mod sandbox;
pub mod security_contact;
pub mod tools;
pub mod traffic;
pub mod voice_calls;
pub mod web;

#[cfg(test)]
mod custody_gate_tests;
#[cfg(test)]
mod route_inventory_test;

use axum::{
    http::HeaderValue,
    response::{IntoResponse, Redirect, Response},
    routing::{any, get, post},
    Json, Router,
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

/// Operational state shares the config/audit management authorization boundary.
async fn authorize_observability(
    axum::extract::State(state): axum::extract::State<SharedState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Result<Response, crate::error::GatewayError> {
    let raw_key = request
        .headers()
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let ctx = crate::pipeline::authenticate(&state, crate::pipeline::AuthInputs::with_key(raw_key))
        .await?;
    let peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|peer| peer.0)
        .unwrap_or_else(|| std::net::SocketAddr::from(([0, 0, 0, 0], 0)));
    config::require_local_admin(
        &state,
        &peer,
        ctx.is_master_key,
        request.headers(),
        "Gateway observability",
    )?;
    Ok(next.run(request).await)
}

pub fn router(state: SharedState) -> Router {
    Router::new()
        // A person opening the service root: the operator's dashboard when one
        // is configured, otherwise a neutral description of this Gateway. The
        // API routes below stay available to programmatic callers.
        .route("/", get(gateway_home))
        // OpenAI-compatible chat endpoint
        .route("/v1/chat/completions", post(chat::chat_completions))
        // OpenAI Responses create, translated into the same governed inference
        // pipeline. The explicit limit keeps large input arrays bounded.
        .route(
            "/v1/responses",
            post(responses::create_response)
                .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024)),
        )
        // ACP subprocesses use this agent-scoped alias so the Gateway can bind
        // OpenRouter usage and budget counters to the originating agent.
        .route(
            "/v1/agents/:agent_id/chat/completions",
            post(chat::agent_chat_completions),
        )
        .route(
            "/v1/agents/:agent_id/:agent_proof/chat/completions",
            post(chat::agent_chat_completions_with_proof),
        )
        .route("/v1/embeddings", post(embeddings::embeddings))
        .route("/v1/rerank", post(embeddings::rerank))
        // Anthropic Messages inbound (protocol-compat): lets Claude Code and other
        // Anthropic-dialect clients point their base_url here and get the governed
        // pipeline. Also reachable at /v1/messages with any client.
        .route("/v1/messages", post(compat::anthropic_messages))
        // Google Gemini inbound (protocol-compat): generateContent + streaming.
        // The model + operation suffix share ONE path segment
        // (`gemini-2.0-flash:generateContent`), so a single `:spec` capture
        // dispatches on the `:streamGenerateContent` suffix in the handler.
        .route("/v1beta/models/:spec", post(compat::gemini_generate))
        // Cursor alias (#7). Cursor's "Override OpenAI Base URL" already emits the
        // OpenAI `/v1/chat/completions` shape, so this is a labelled alias to the
        // same governed pipeline — point Cursor at `<gateway>/v1/cursor`. Leaves a
        // seam for full Cursor-protocol translation if ever needed.
        .route("/v1/cursor/chat/completions", post(chat::chat_completions))
        // OpenAI-compatible multimodal endpoints (routed through the same pipeline)
        .route(
            "/v1/images/generations",
            post(multimodal::image_generations).layer(axum::extract::DefaultBodyLimit::max(
                multimodal::MAX_IMAGE_GENERATION_BODY_BYTES,
            )),
        )
        .route("/v1/audio/speech", post(multimodal::audio_speech))
        .route(
            "/v1/audio/transcriptions",
            post(multimodal::audio_transcriptions).layer(axum::extract::DefaultBodyLimit::max(
                audio_wire::MAX_AUDIO_MULTIPART_BYTES,
            )),
        )
        // Video generation (job-based: submit + poll). Reference media travels
        // inline, so the submit carries an explicit limit instead of axum's 2 MiB.
        .route(
            "/v1/videos/generations",
            post(multimodal::video_generations).layer(axum::extract::DefaultBodyLimit::max(
                multimodal::MAX_MEDIA_JOB_BODY_BYTES,
            )),
        )
        .route(
            "/v1/videos/generations/:id",
            get(multimodal::video_job_status),
        )
        // Audio generation: music and sound effects (job-based: submit + poll).
        .route(
            "/v1/audio/generations",
            post(multimodal::audio_generations).layer(axum::extract::DefaultBodyLimit::max(
                multimodal::MAX_MEDIA_JOB_BODY_BYTES,
            )),
        )
        .route(
            "/v1/audio/generations/:id",
            get(multimodal::audio_job_status),
        )
        // Modality registry
        .route("/v1/modalities", get(multimodal::list_modalities))
        .route("/v1/models", get(models::list_models))
        // OpenRouter asynchronous inference batches (master-key only; direct
        // provider jobs remain separate from the normal per-request pipeline).
        .route(
            "/v1/batches",
            get(batches::list_batches)
                .post(batches::create_batch)
                .layer(axum::extract::DefaultBodyLimit::max(
                    batches::MAX_BATCH_BODY_BYTES,
                )),
        )
        .route(
            "/v1/batches/:id",
            get(batches::get_batch).delete(batches::delete_batch),
        )
        .route(
            "/v1/web/search",
            post(web::search).layer(axum::extract::DefaultBodyLimit::max(8192)),
        )
        .route(
            "/v1/web/fetch",
            post(web::fetch).layer(axum::extract::DefaultBodyLimit::max(8192)),
        )
        .route("/v1/web/capabilities", get(web::capabilities))
        // Tools (Composio action registry)
        .route("/v1/tools/composio", get(tools::list_composio_tools))
        // Metrics
        .route(
            "/metrics",
            get(metrics::get_metrics).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                authorize_observability,
            )),
        )
        .route(
            "/v1/metrics",
            get(metrics::get_metrics).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                authorize_observability,
            )),
        )
        // Live request traffic (SSE). Admin-gated like /v1/audit; feeds the
        // desktop's live-traffic dashboard through Core's proxy.
        .route("/v1/traffic", get(traffic::live_traffic))
        // Community savings — public, ungated anonymous aggregate (opt-out beacon
        // source). Mirrors /metrics registration; NO admin gate.
        .route("/v1/savings", get(metrics::community_savings))
        .route("/savings", get(metrics::community_savings))
        // Local-engine admission-queue depth (Layer 2 observability)
        .route(
            "/v1/concurrency",
            get(metrics::get_concurrency).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                authorize_observability,
            )),
        )
        // Evals — rolling scores + dataset runner
        .route(
            "/v1/evals",
            get(evals::get_evals).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                authorize_observability,
            )),
        )
        .route(
            "/v1/evals/online",
            get(evals::get_online_evals).layer(axum::middleware::from_fn_with_state(
                state.clone(),
                authorize_observability,
            )),
        )
        .route(
            "/v1/evals/score",
            post(evals::score_online).layer(axum::extract::DefaultBodyLimit::max(
                evals::MAX_ONLINE_SCORE_REQUEST_BYTES,
            )),
        )
        .route(
            "/v1/evals/run",
            post(evals::run_evals).layer(axum::extract::DefaultBodyLimit::max(
                evals::MAX_EVAL_REQUEST_BYTES,
            )),
        )
        // Public static evaluator taxonomy; live scores are admin-gated above.
        .route("/v1/evaluators", get(evaluators::get_evaluators))
        // Marketplace governance (#468): grant validation + manifest signing.
        // Read-only computations over caller data; no secret exposed (pubkey only),
        // so not behind the master-key admin gate config/audit use.
        .route("/v1/grants/validate", post(governance::validate_grants))
        .route("/v1/manifests/sign", post(governance::sign_manifest))
        .route("/v1/manifests/verify", post(governance::verify_manifest))
        .route("/v1/manifests/pubkey", get(governance::get_pubkey))
        // Live per-scope budget spend (read-only; same admin gate as config/audit).
        // Exposes the in-memory per-user/agent/session charged-spend counters the budget
        // stage tracks so the desktop can render live spend (P2 #1).
        .route("/v1/budget/spend", get(budget::get_spend))
        // Core's ACP/MCP bridge posts successful Composio action counts here;
        // the endpoint is master/trusted-forwarder or bearer-proof authenticated
        // and shares the normal tool-loop debit helper so charges are not
        // double-counted.
        .route("/v1/budget/charge", post(budget::charge_tool))
        // Core-hosted apps use this provider-neutral seam. Provider credentials
        // stay in Gateway/vault and the route owns provider-cost wallet debits.
        .route("/v1/providers", get(providers::list_providers))
        .route("/v1/providers/status", post(providers::provider_status))
        .route("/v1/providers/call", post(providers::provider_call))
        // Remaining Ryu $ wallet balance as of the last metered call. Backs
        // Core's dollar-threshold model fallback ("under $5, use the cheap
        // model"), which has no other way to see an org-level billing figure.
        .route("/v1/wallet", get(budget::get_wallet))
        // Audit log (local query; master-key only)
        .route("/v1/audit", get(audit::query_audit))
        .route("/v1/audit/usage", get(audit::query_audit_usage))
        .route("/v1/audit/prune", post(audit::prune_audit))
        // Gateway control activity ingest (admin-authenticated; no payloads).
        .route("/v1/audit/control", post(audit::record_control_change))
        // Exec audit ingest + pre-run budget gate (M6 / #192)
        .route("/v1/exec/audit", post(audit::ingest_exec_audit))
        .route("/v1/exec/budget/check", post(audit::check_exec_budget))
        // Sandbox metering + billing rail (M6 sandboxes). Core posts one tick
        // per run per heartbeat; the gateway accrues the marked-up cost, debits
        // the org wallet, and returns a continue/warn/kill verdict. Auth =
        // trusted-forwarder / master key, like exec-audit.
        .route("/sandbox/tick", post(sandbox::sandbox_tick))
        // The hourly rate a sandbox shape would be ticked at (Core's Box
        // credit pre-flight). Same auth as the tick.
        .route("/sandbox/quote", post(sandbox::sandbox_quote))
        // Idempotent completion transition: Core releases a run's accrual (and
        // sticky kill) state once it will never tick that run again.
        .route("/sandbox/complete", post(sandbox::sandbox_complete))
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
        .route(
            "/v1/config/providers/apply",
            post(config::apply_provider_revision).layer(axum::extract::DefaultBodyLimit::max(2048)),
        )
        // Read-only local configuration/security/performance doctor. Core adds
        // its own approval and agent-routing coverage findings in its proxy.
        .route("/v1/doctor", get(doctor::get_doctor))
        // Explicit, idempotent protective fixes. The request supports dry-run
        // so CLI/desktop callers can preview the exact settings before writing.
        .route("/v1/doctor/fix", post(doctor::fix_doctor))
        // Read-only report of flagged egress features (multi-key rotation,
        // account pools, proxy pools, subscription transports). Detection only.
        .route(
            "/v1/egress/posture",
            get(egress_posture::get_egress_posture),
        )
        // Hazard screener status (admin): breakers, probes, models and the
        // active floor's qualification state. Names ids only, never URLs.
        .route(
            "/v1/screening/status",
            get(crate::screening::status::get_screening_status),
        )
        // Authenticated guardrail scan and attributed audit writer. Core's
        // workflow Guardrails node forwards its Gateway credential.
        .route("/v1/firewall/check", post(firewall::firewall_check))
        // Subscription passthrough exists only off the hosted fleet.
        .merge(passthrough_routes(state.custody))
        // Health / meta
        .route("/health", get(health::health))
        .route(
            "/.well-known/security.txt",
            get(security_contact::security_txt),
        )
        .route("/v1/health", get(health::health))
        .route("/v1/auth/status", get(health::auth_status))
        .route("/v1/auth/readiness", get(health::readiness))
        // Control-plane enforcement push (spec 05.5): drops cached
        // resolutions a suspension, ban or lift names. Authenticated inside
        // the handler with the fleet's internal secret, never a bearer.
        .route(
            "/internal/enforcement/invalidate",
            post(crate::standing::invalidate).layer(axum::extract::DefaultBodyLimit::max(
                crate::standing::MAX_PUSH_BYTES,
            )),
        )
        // Twilio PSTN voice bridge. These provider callbacks authenticate inside
        // the handlers because they arrive from outside the normal Gateway API
        // bearer-auth boundary.
        .route("/voice/twilio/answer", post(voice_calls::twilio_answer))
        .route(
            "/voice/twilio/outbound/:intent_id",
            post(voice_calls::twilio_outbound_answer),
        )
        .route(
            "/voice/twilio/status/:intent_id",
            post(voice_calls::twilio_status),
        )
        .route("/voice/twilio/stream", get(voice_calls::twilio_stream))
        .route(
            "/v1/channels/pairing/approve",
            post(channel_pairing::approve),
        )
        .route(
            "/v1/phone-calls",
            get(phone_calls::list_calls).post(phone_calls::start_call),
        )
        .route(
            "/v1/phone-calls/numbers/available",
            get(phone_calls::available_numbers),
        )
        .route(
            "/v1/phone-calls/numbers",
            post(phone_calls::purchase_number),
        )
        .route(
            "/v1/phone-calls/caller-id-verifications",
            post(phone_calls::verify_caller_id),
        )
        .route(
            "/v1/phone-calls/:call_sid/control",
            post(phone_calls::control_call),
        )
        .route(
            "/v1/phone-calls/:call_sid/handoff",
            post(phone_calls::handoff_call),
        )
        .route(
            "/v1/phone-calls/:call_sid/hangup",
            post(phone_calls::hangup_call),
        )
        // Ok-path policy-alert header writer. Runs on every governed response;
        // a no-op unless a handler stashed a `PolicyAlert` on the response
        // extensions. The error-path header is written directly by
        // `GatewayError::into_response`, so this layer must stay conditional.
        .layer(axum::middleware::map_response(stamp_policy_alert))
        // Builder tags (`x-ryu-tags`, Treg parity C6): parsed once for every
        // route, refused when malformed, attached to org limits and debits.
        .layer(axum::middleware::from_fn(
            crate::org_limits::scope_spend_tags,
        ))
        // Tenant end user (`x-ryu-end-user`): parsed once for every route,
        // refused when malformed, hashed at authentication and never stored raw.
        .layer(axum::middleware::from_fn(crate::identity::scope_end_user))
        // Route template for the live traffic feed: in scope for every audit
        // row a handler writes (`crate::traffic::current_route`).
        .layer(axum::middleware::from_fn(crate::traffic::scope_route))
        // axum's own plain-text 400/404/405/413/415/422 bodies become the
        // JSON error envelope (status and `Allow` unchanged).
        .layer(axum::middleware::from_fn(
            http_conventions::json_error_envelope,
        ))
        // On the hosted fleet a Gateway key in the URL is refused before any
        // handler, tag parser or token resolution sees it.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            refuse_query_gateway_tokens,
        ))
        // Outermost: every response, errors included, carries `x-request-id`.
        .layer(axum::middleware::from_fn(http_conventions::request_id))
        .with_state(state)
}

/// The native-format subscription passthrough routes. A hosted fleet replica
/// never carries a caller's subscription bearer, so it does not mount them at
/// all; the handlers' own loopback and fleet checks stay as a second line.
fn passthrough_routes(custody: crate::custody::GatewayCustody) -> Router<SharedState> {
    if !custody.mounts_passthrough() {
        return Router::new();
    }
    Router::new()
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
}

/// The fixed audit marker for a refused query-string credential.
pub(crate) const QUERY_CREDENTIAL_REFUSED: &str = "query_credential_refused";

/// Refuse a hosted Gateway token (`rgw_`) carried in a URL query string on
/// the fleet. URLs reach proxy and load-balancer logs, so the key must travel
/// in a header. The refusal leaves one audit row that never holds the token.
async fn refuse_query_gateway_tokens(
    axum::extract::State(state): axum::extract::State<SharedState>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if state.custody.accepts_query_credentials()
        || !request
            .uri()
            .query()
            .is_some_and(crate::custody::query_carries_gateway_token)
    {
        return next.run(request).await;
    }
    // The route template, never the raw path: some paths carry a proof
    // segment (`/v1/agents/:agent_id/:agent_proof/...`).
    let route = request
        .extensions()
        .get::<axum::extract::MatchedPath>()
        .map_or("unmatched", axum::extract::MatchedPath::as_str)
        .to_owned();
    state.metrics.inc_errors();
    tracing::warn!(
        route = %route,
        "refused a Gateway key sent in the URL query string"
    );
    if state.audit.is_enabled() {
        let mut record = crate::audit::AuditLogger::make_exec_record(
            uuid::Uuid::new_v4().to_string(),
            String::new(),
            "gateway".to_owned(),
            route.clone(),
            0,
            -1,
            None,
            Some(QUERY_CREDENTIAL_REFUSED.to_owned()),
        );
        record.provider = "gateway".to_owned();
        record.model = route;
        state.log_audit(record);
    }
    crate::error::GatewayError::Unauthorized(
        "Gateway keys are not accepted in the URL query string on the hosted Gateway.          Send the key in the Authorization or x-goog-api-key header."
            .to_owned(),
    )
    .into_response()
}

async fn gateway_home() -> Response {
    home_response(std::env::var("RYU_PRODUCT_DASHBOARD_URL").ok().as_deref())
}

/// `GET /`: a temporary redirect to `RYU_PRODUCT_DASHBOARD_URL` when the operator
/// sets one (Ryu's hosted deployment points it at its dashboard), otherwise a
/// neutral JSON description of this Gateway. A self-hosted Gateway never sends
/// its visitors to a Ryu-hosted page by default.
fn home_response(dashboard_url: Option<&str>) -> Response {
    match dashboard_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(target) => Redirect::temporary(target).into_response(),
        None => Json(serde_json::json!({
            "name": "ryu-gateway",
            "version": env!("CARGO_PKG_VERSION"),
            "health": "/health",
        }))
        .into_response(),
    }
}

#[cfg(test)]
mod stamp_tests {
    use super::*;
    use crate::config::AlertTier;
    /// F1-twin guard: the Ok-path writer stamps the header when a handler stashed
    /// a `PolicyAlert` on the response extensions.
    #[tokio::test]
    async fn stamps_header_when_extension_present() {
        let alert = PolicyAlert::budget("user", "u1", "notify", AlertTier::Fanout, 10, 10, "org1");
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

#[cfg(test)]
mod route_tests {
    use super::*;
    use crate::state::AppState;

    #[tokio::test]
    async fn observability_firewall_and_readiness_require_verified_credentials() {
        use axum::{
            body::Body,
            http::{Request, StatusCode},
        };
        use tower::ServiceExt;
        let admin = "gwadm_security_test_0123456789abcdef";
        let relay = "gwrelay_security_test_0123456789abcdef";
        let mut cfg = crate::config::GatewayConfig::default();
        cfg.auth.master_key = Some(admin.into());
        cfg.auth.api_keys =
            vec![serde_json::from_value(serde_json::json!({"key":relay,"name":"relay"})).unwrap()];
        cfg.audit.enabled = false;
        let state = std::sync::Arc::new(AppState::new_for_test(
            cfg,
            crate::audit::AuditLogger::new(&crate::config::AuditConfig {
                enabled: false,
                db_path: String::new(),
            })
            .unwrap(),
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        ));
        let app = router(state).layer(axum::Extension(std::net::SocketAddr::from((
            [127, 0, 0, 1],
            8080,
        ))));
        // Discovery routes reveal provider/model routing (including fine-tune
        // ids) and trigger upstream `/models` calls, so they need any valid
        // inference credential once `require_auth` is on.
        for path in ["/v1/models", "/v1/modalities"] {
            for (credential, status) in [
                (None, StatusCode::UNAUTHORIZED),
                (Some("bogus"), StatusCode::UNAUTHORIZED),
                (Some(relay), StatusCode::OK),
                (Some(admin), StatusCode::OK),
            ] {
                let mut request = Request::builder().uri(path);
                if let Some(key) = credential {
                    request = request.header("authorization", format!("Bearer {key}"));
                }
                let response = app
                    .clone()
                    .oneshot(request.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), status, "{path} with {credential:?}");
            }
        }
        for path in [
            "/metrics",
            "/v1/metrics",
            "/v1/concurrency",
            "/v1/evals",
            "/v1/evals/online",
        ] {
            for (credential, status) in [
                (None, StatusCode::UNAUTHORIZED),
                (Some("bogus"), StatusCode::UNAUTHORIZED),
                (Some(relay), StatusCode::UNAUTHORIZED),
                (Some(admin), StatusCode::OK),
            ] {
                let mut request = Request::builder().uri(path);
                if let Some(key) = credential {
                    request = request.header("authorization", format!("Bearer {key}"));
                }
                let response = app
                    .clone()
                    .oneshot(request.body(Body::empty()).unwrap())
                    .await
                    .unwrap();
                assert_eq!(response.status(), status, "{path}");
            }
        }
        for (credential, status) in [
            (None, StatusCode::UNAUTHORIZED),
            (Some("bogus"), StatusCode::UNAUTHORIZED),
            (Some(relay), StatusCode::OK),
        ] {
            let mut request = Request::builder()
                .method("POST")
                .uri("/v1/firewall/check")
                .header("content-type", "application/json");
            if let Some(key) = credential {
                request = request.header("authorization", format!("Bearer {key}"));
            }
            let response = app
                .clone()
                .oneshot(
                    request
                        .body(Body::from(
                            r#"{"text":"user@example.com","checks":["pii"]}"#,
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
        let nonce = "a".repeat(64);
        let signature = ryu_gw_credentials::readiness_request_signature(&nonce, admin).unwrap();
        for (proof, status) in [
            (None, StatusCode::UNAUTHORIZED),
            (Some("bogus"), StatusCode::UNAUTHORIZED),
            (Some(signature.as_str()), StatusCode::OK),
        ] {
            let mut request = Request::builder().uri(format!("/v1/auth/readiness?nonce={nonce}"));
            if let Some(proof) = proof {
                request = request.header("x-ryu-readiness-proof", proof);
            }
            let response = app
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), status);
        }
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["status"], "ok");
        assert!(body.get("providers").is_none());
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .header("authorization", format!("Bearer {admin}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert!(body.get("providers").is_some());
        assert_eq!(body["auth_required"], true);
    }

    /// The compat routes and the live-traffic feed are registered on the router
    /// (and therefore reachable). A route that is missing — or whose path
    /// doesn't match what a client sends — would 404 in production; this guard
    /// catches that at build time.
    #[tokio::test]
    async fn compat_and_traffic_routes_are_registered() {
        let state = std::sync::Arc::new(AppState::new_for_test_default());
        let app = router(state);
        // Anthropic Messages dialect.
        assert!(
            route_accepts_post(&app, "/v1/responses").await,
            "POST /v1/responses must route to the Responses compatibility handler"
        );
        assert!(
            route_accepts_post(&app, "/v1/messages").await,
            "POST /v1/messages must route to the Anthropic compat handler"
        );
        // Gemini: the model + operation suffix share one path segment.
        assert!(
            route_accepts_post(&app, "/v1beta/models/gemini-2.0-flash:generateContent").await,
            "POST /v1beta/models/:spec must route to the Gemini handler"
        );
        assert!(
            route_accepts_post(
                &app,
                "/v1beta/models/gemini-2.0-flash:streamGenerateContent"
            )
            .await,
            "POST streamGenerateContent must route to the Gemini streaming handler"
        );
        // Live traffic SSE.
        assert!(
            route_accepts_get(&app, "/v1/traffic").await,
            "GET /v1/traffic must route to the SSE handler"
        );
    }

    #[tokio::test]
    async fn standalone_home_describes_the_gateway_instead_of_a_hosted_dashboard() {
        use axum::http::Request;
        use tower::ServiceExt;

        let state = std::sync::Arc::new(AppState::new_for_test_default());
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri("/")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        // The router reads RYU_PRODUCT_DASHBOARD_URL, which tests never set.
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert!(response
            .headers()
            .get(axum::http::header::LOCATION)
            .is_none());
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["name"], "ryu-gateway");
        assert_eq!(body["health"], "/health");
    }

    #[test]
    fn home_redirects_only_to_an_operator_configured_dashboard() {
        let response = home_response(Some(" https://dash.example.com/home "));
        assert_eq!(
            response.status(),
            axum::http::StatusCode::TEMPORARY_REDIRECT
        );
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::LOCATION)
                .unwrap(),
            "https://dash.example.com/home"
        );
        for unset in [None, Some(""), Some("   ")] {
            let response = home_response(unset);
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            assert!(response
                .headers()
                .get(axum::http::header::LOCATION)
                .is_none());
        }
    }

    /// Job-based media submissions carry reference media inline, so they must
    /// accept bodies above axum's 2 MiB default and still refuse oversized ones
    /// at the explicit media-job ceiling.
    #[tokio::test]
    async fn media_job_routes_use_the_explicit_media_body_limit() {
        use axum::body::Body;
        use axum::http::{Method, Request, StatusCode};
        use tower::ServiceExt;

        fn padded(len: usize) -> Vec<u8> {
            let prefix = br#"{"prompt":"limit probe","pad":""#;
            let suffix = br#""}"#;
            let mut body = Vec::with_capacity(len);
            body.extend_from_slice(prefix);
            body.resize(len - suffix.len(), b'a');
            body.extend_from_slice(suffix);
            body
        }

        assert_eq!(multimodal::MAX_MEDIA_JOB_BODY_BYTES, 64 * 1024 * 1024);
        let state = std::sync::Arc::new(AppState::new_for_test_default());
        let app = router(state);
        for path in ["/v1/videos/generations", "/v1/audio/generations"] {
            for (len, too_large) in [
                (3 * 1024 * 1024, false),
                (multimodal::MAX_MEDIA_JOB_BODY_BYTES + 1024, true),
            ] {
                let req = Request::builder()
                    .method(Method::POST)
                    .uri(path)
                    .header("content-type", "application/json")
                    .body(Body::from(padded(len)))
                    .unwrap();
                let status = app.clone().oneshot(req).await.unwrap().status();
                assert_ne!(status, StatusCode::NOT_FOUND, "{path} must be routed");
                assert_eq!(
                    status == StatusCode::PAYLOAD_TOO_LARGE,
                    too_large,
                    "{path} with a {len}-byte body answered {status}"
                );
            }
        }
        assert!(
            route_accepts_get(&app, "/v1/audio/generations/job-1").await,
            "GET /v1/audio/generations/:id must route to the audio job poll"
        );
    }

    fn keyed_state(rate_limit: crate::config::RateLimitConfig) -> SharedState {
        let mut cfg = crate::config::GatewayConfig::default();
        cfg.auth.api_keys = vec![serde_json::from_value(serde_json::json!({
            "key": "gwrelay_conventions_0123456789abcdef",
            "name": "relay",
            "allowed_operations": ["inference", "web_search", "web_fetch"],
        }))
        .unwrap()];
        cfg.audit.enabled = false;
        cfg.rate_limit = rate_limit;
        cfg.cache.enabled = false;
        std::sync::Arc::new(AppState::new_for_test(
            cfg,
            crate::audit::AuditLogger::new(&crate::config::AuditConfig {
                enabled: false,
                db_path: String::new(),
            })
            .unwrap(),
            crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default()),
        ))
    }

    async fn send(
        app: &Router,
        method: &str,
        path: &str,
        body: Option<&str>,
    ) -> (
        axum::http::HeaderMap,
        axum::http::StatusCode,
        serde_json::Value,
    ) {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let mut request = Request::builder().method(method).uri(path).header(
            "authorization",
            "Bearer gwrelay_conventions_0123456789abcdef",
        );
        if body.is_some() {
            request = request.header("content-type", "application/json");
        }
        let response = app
            .clone()
            .oneshot(
                request
                    .body(body.map_or_else(Body::empty, |b| Body::from(b.to_owned())))
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
        (headers, status, json)
    }

    fn request_id_of(headers: &axum::http::HeaderMap) -> String {
        let id = headers
            .get(http_conventions::REQUEST_ID_HEADER)
            .expect("every response carries x-request-id")
            .to_str()
            .unwrap()
            .to_owned();
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "request id {id}");
        id
    }

    #[tokio::test]
    async fn unmatched_routes_wrong_methods_and_bad_json_answer_the_envelope() {
        use axum::http::StatusCode;
        let app = router(keyed_state(crate::config::RateLimitConfig::default()));

        let (headers, status, body) = send(&app, "GET", "/v1/nope", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "not_found");
        assert_eq!(body["error"]["type"], "not_found");
        assert_eq!(body["error"]["message"], "No route for GET /v1/nope");
        let first = request_id_of(&headers);

        let (headers, status, body) = send(&app, "GET", "/v1/chat/completions", None).await;
        assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(body["error"]["code"], "method_not_allowed");
        let allow = headers
            .get(axum::http::header::ALLOW)
            .expect("405 keeps Allow")
            .to_str()
            .unwrap();
        assert!(allow.contains("POST"), "Allow: {allow}");
        assert_ne!(request_id_of(&headers), first, "ids are per request");

        let (headers, status, body) =
            send(&app, "POST", "/v1/chat/completions", Some("{not json")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"]["code"], "invalid_request_error");
        request_id_of(&headers);

        // A typed body of the wrong shape keeps axum's 422.
        let (_, status, body) = send(&app, "POST", "/v1/web/search", Some(r#"{"query":1}"#)).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["error"]["code"], "invalid_request_error");

        // A body over the route's limit keeps axum's 413.
        let oversized = format!(r#"{{"query":"{}"}}"#, "q".repeat(16 * 1024));
        let (headers, status, body) = send(&app, "POST", "/v1/web/search", Some(&oversized)).await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(body["error"]["code"], "request_too_large");
        request_id_of(&headers);

        // No JSON content type keeps axum's 415.
        let response = {
            use axum::{body::Body, http::Request};
            use tower::ServiceExt;
            app.clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/v1/chat/completions")
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap()
        };
        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        request_id_of(response.headers());
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "invalid_request_error");
    }

    #[tokio::test]
    async fn gateway_errors_carry_the_request_id() {
        use axum::{body::Body, http::Request};
        use tower::ServiceExt;
        let app = router(keyed_state(crate::config::RateLimitConfig::default()));
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/v1/models")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::UNAUTHORIZED);
        request_id_of(response.headers());
    }

    #[tokio::test]
    async fn inbound_429_carries_retry_after_and_ietf_rate_limit_headers() {
        use axum::http::StatusCode;
        // Every inference route shares one admission check, so a per-key
        // refusal names its policy on each of them, not only on chat.
        let routes = [
            (
                "/v1/chat/completions",
                r#"{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}]}"#,
            ),
            (
                "/v1/embeddings",
                r#"{"model":"text-embedding-3-small","input":"hi"}"#,
            ),
            (
                "/v1/rerank",
                r#"{"model":"rerank-v3.5","query":"hi","documents":["a","b"]}"#,
            ),
            ("/v1/web/search", r#"{"query":"ryu gateway"}"#),
        ];
        for (path, request) in routes {
            let app = router(keyed_state(crate::config::RateLimitConfig {
                enabled: true,
                requests_per_minute: Some(1),
                tokens_per_minute: None,
                max_burst_per_second: 0,
            }));
            // The first request takes the only token, whatever the outcome.
            let (_, first, _) = send(&app, "POST", path, Some(request)).await;
            assert_ne!(first, StatusCode::TOO_MANY_REQUESTS, "{path}");
            let (headers, status, body) = send(&app, "POST", path, Some(request)).await;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{path}: {body}");
            assert_eq!(body["error"]["code"], "rate_limit_exceeded", "{path}");
            assert_eq!(body["error"]["retry_after"], 60, "{path}");
            assert_eq!(headers.get("retry-after").unwrap(), "60", "{path}");
            assert_eq!(
                headers.get("ratelimit-policy").unwrap(),
                "\"requests\";q=1;w=60",
                "{path}"
            );
            assert_eq!(
                headers.get("ratelimit").unwrap(),
                "\"requests\";r=0;t=60",
                "{path}"
            );
            request_id_of(&headers);
        }
    }

    #[tokio::test]
    async fn burst_refusal_names_the_burst_policy() {
        use axum::http::StatusCode;
        let app = router(keyed_state(crate::config::RateLimitConfig {
            enabled: true,
            requests_per_minute: None,
            tokens_per_minute: None,
            max_burst_per_second: 1,
        }));
        let request = r#"{"model":"text-embedding-3-small","input":"hi"}"#;
        let (_, first, _) = send(&app, "POST", "/v1/embeddings", Some(request)).await;
        assert_ne!(first, StatusCode::TOO_MANY_REQUESTS);
        let (headers, status, body) = send(&app, "POST", "/v1/embeddings", Some(request)).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert_eq!(body["error"]["retry_after"], 1);
        assert_eq!(headers.get("retry-after").unwrap(), "1");
        assert_eq!(
            headers.get("ratelimit-policy").unwrap(),
            "\"burst\";q=1;w=1"
        );
    }

    async fn route_accepts_post(app: &Router, path: &str) -> bool {
        use axum::body::Body;
        use axum::http::{Method, Request};
        use tower::ServiceExt;
        let req = Request::builder()
            .method(Method::POST)
            .uri(path)
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        // 404 means no route matched; anything else (200/400/401/415) means a
        // handler owns the path.
        resp.status() != axum::http::StatusCode::NOT_FOUND
    }

    async fn route_accepts_get(app: &Router, path: &str) -> bool {
        use axum::body::Body;
        use axum::http::{Method, Request};
        use tower::ServiceExt;
        let req = Request::builder()
            .method(Method::GET)
            .uri(path)
            .body(Body::empty())
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        resp.status() != axum::http::StatusCode::NOT_FOUND
    }
}
