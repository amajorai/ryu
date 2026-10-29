use axum::{
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;
use tracing::debug;

use crate::{
    budget::BudgetDecision,
    config::{BudgetAction, ProviderId},
    error::GatewayError,
    pipeline::{self, authenticate, AuthInputs},
    state::SharedState,
};

/// Read an optional non-empty header value as an owned string.
fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `x-ryu-purpose`, kept only when it satisfies the shared Core/Gateway
/// contract ([`crate::audit::valid_purpose`]).
fn purpose_header(headers: &HeaderMap) -> Option<String> {
    header_string(headers, "x-ryu-purpose")
        .filter(|purpose| crate::audit::valid_purpose(purpose).is_some())
}

/// Whether the request carries `x-ryu-untrusted-caller` set to a true value
/// (`1`, `true`, `on` or `yes`). Any other value, or no header, is the normal
/// path; the header can only restrict.
fn untrusted_caller_header(headers: &HeaderMap) -> bool {
    header_string(headers, "x-ryu-untrusted-caller").is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "1" | "true" | "on" | "yes"
        )
    })
}

/// Core's host conversation (`x-ryu-host-conversation-id`) with the proof Core
/// minted for it (`x-ryu-host-conversation-proof`). Both are required; either
/// alone is ignored. The Gateway cannot verify the proof, so this stays caller
/// input until `authenticate` keeps it for a trusted forwarder.
fn host_conversation_headers(headers: &HeaderMap) -> Option<crate::tools::HostConversation> {
    Some(crate::tools::HostConversation {
        id: header_string(headers, "x-ryu-host-conversation-id")?,
        proof: header_string(headers, "x-ryu-host-conversation-proof")?,
    })
}

/// Stable lowercase label for a budget action (response header value).
fn budget_action_label(action: BudgetAction) -> &'static str {
    match action {
        BudgetAction::Notify => "notify",
        BudgetAction::Downgrade => "downgrade",
        BudgetAction::Restrict => "restrict",
        BudgetAction::Stop => "stop",
    }
}

/// Echo whether the node's routing preferences were looked at, on the same
/// header name the request carried them on — mirroring `x-ryu-prompt-cache`'s
/// existing two-way use.
///
/// Deliberately reports RECEIPT, not the per-entry drop reasons. The fallback
/// clamp runs inside the chain-expansion helper (it needs the routed primary,
/// which only exists after the Route stage) and threading its `DropReason`s back
/// out to this handler would mean widening `run` / `run_stream` / `pre_process`
/// return types across three call sites for a diagnostic. The drops are logged at
/// `debug` where they happen; this header answers the question a caller actually
/// has, which is "did the header reach a reader that understood it".
fn apply_node_routing_header(
    hdrs: &mut HeaderMap,
    prefs: Option<&pipeline::node_routing::NodeRoutingPrefs>,
) {
    if prefs.is_some() {
        hdrs.insert("x-ryu-node-routing", HeaderValue::from_static("accepted"));
    }
}

/// Fold the caller's `anthropic-beta` header into the body as the private
/// `ryu_anthropic_beta` field.
///
/// Anthropic betas (code execution, extended cache TTLs, …) are opted into on a
/// REQUEST HEADER, but the only thing that reaches [`Provider::complete`] is the
/// OpenAI-compat body — so the header rides along as a private `ryu_*` body
/// field, exactly like `ryu_smart_route` does for the per-agent smart-routing
/// override (see [`crate::pipeline`]). The Anthropic provider is its intended
/// reader, and it builds its own whitelist payload from the body, so the field
/// cannot leak upstream there whether or not it is read. Every other provider
/// clones the body VERBATIM, so the field is stripped before dispatch
/// (`pipeline::strip_anthropic_beta_for`) — an unknown top-level field 400s a
/// strict OpenAI endpoint.
///
/// An absent or empty header inserts NOTHING, so a request that did not ask for a
/// beta is byte-identical to what the caller sent.
fn apply_anthropic_beta(headers: &HeaderMap, body: &mut Value) {
    let Some(obj) = body.as_object_mut() else {
        return;
    };
    // The field is private to the header seam, so a client-supplied one is
    // always dropped first. Without this a caller could set arbitrary Anthropic
    // betas by writing the private field straight into the JSON body, bypassing
    // the header that is supposed to be its only source.
    obj.remove(pipeline::ANTHROPIC_BETA_FIELD);
    // Every header line is folded, not just the first, so a value on a second
    // `anthropic-beta` line reaches the fleet's allowlist check.
    let Some(betas) = pipeline::upstream_features::beta_header(headers) else {
        return;
    };
    obj.insert(
        pipeline::ANTHROPIC_BETA_FIELD.to_string(),
        Value::String(betas),
    );
}

/// Attach `x-budget-*` headers so the client can observe budget state and the
/// action that was taken (U21 acceptance criterion: observable to the client).
fn apply_budget_headers(hdrs: &mut HeaderMap, budget: &BudgetDecision) {
    hdrs.insert(
        "x-budget-scope",
        HeaderValue::from_static(budget.scope.as_str()),
    );
    hdrs.insert(
        "x-budget-action",
        HeaderValue::from_static(budget_action_label(budget.action)),
    );
    if let Ok(v) = HeaderValue::from_str(&budget.used.to_string()) {
        hdrs.insert("x-budget-used", v);
    }
    if let Ok(v) = HeaderValue::from_str(&budget.limit.to_string()) {
        hdrs.insert("x-budget-limit", v);
    }
    hdrs.insert("x-budget-currency", HeaderValue::from_static("USD"));
    hdrs.insert("x-budget-unit", HeaderValue::from_static("micro_usd"));
}

pub async fn chat_completions(
    State(state): State<SharedState>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Result<Response, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());

    // Caller identity for per-user / per-agent budgets (U21).
    let user_id = header_string(&headers, "x-ryu-user-id");
    let agent_id = header_string(&headers, "x-ryu-agent-id");
    let agent_proof = header_string(&headers, "x-ryu-agent-proof");
    // Active skill ids for attribution (M3 / #145 AC3).
    let skill_ids = header_string(&headers, "x-ryu-skill-ids");
    // Per-agent egress tool allowlist (#475 C7). Only the Core-stamped
    // `x-ryu-tools` header is accepted. The legacy Composio action header is
    // caller-controlled and cannot grant capabilities during migration.
    let tools_header = header_string(&headers, "x-ryu-tools");
    let tools_header_present = tools_header.is_some();
    let tool_actions = tools_header;
    // Core's automatic, turn-scoped capability suggestions. This is discovery
    // metadata only; the Gateway still checks every execution against the
    // allowlist below.
    let capability_hints = header_string(&headers, "x-ryu-capability-hints");
    // Core marks a turn spoken by an unverified phone caller. The header only
    // removes tool surfaces (always-on tools, `tool_search`, hint grants, and
    // the managed loops when no explicit allowlist is present), so a client can
    // use it only to restrict its own request; it needs no authentication.
    let untrusted_caller = untrusted_caller_header(&headers);
    // Explicit opt-in to the unified search-based tool loop (#475). `on`/`true`/`1`
    // flips the chat path to the buffered tool loop even without an allowlist
    // header (so the model can discover tools via `tool_search`). Core's ACP
    // forwarder never sets this → no double tool surface on ACP egress.
    let tool_search_requested = headers
        .get("x-ryu-tool-search")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            matches!(v.as_str(), "on" | "true" | "1" | "yes")
        })
        .unwrap_or(false);
    // Per-agent chat slot override (M3 / #164). For chat requests the chat slot
    // model can override what the gateway's model map would select. The chat
    // slot provider is stored on the context but run/run_stream currently use
    // model-based routing; the model override is forwarded via body["model"] by
    // Core so the gateway's existing model routing picks it up.
    // Any non-empty id is a valid provider id now (open routing); an unregistered
    // id simply misses the registry at dispatch and fails safe.
    let slot_provider = header_string(&headers, "x-ryu-slot-chat-provider").map(ProviderId::from);
    let slot_model = header_string(&headers, "x-ryu-slot-chat-model");
    // Core conversation/session id for per-run audit correlation (M4 / #176).
    let session_id = header_string(&headers, "x-ryu-session-id");
    // Core's host conversation and the process-local proof it minted for it.
    // Caller input here: `authenticate` keeps it only for a trusted forwarder.
    let host_conversation = host_conversation_headers(&headers);
    // Product surface that originated this request (profiles / usage-points):
    // `chat` | `island` | `predict` | `agent`. Recorded on the audit row so the
    // reporter can build the per-feature daily usage breakdown. Absent on
    // self-hosted / legacy callers.
    let feature = header_string(&headers, "x-ryu-feature");
    // Background feature that issued this call (`compaction`, `auto_title`,
    // `plugin:<id>`, ...). Attribution only: it never changes routing or
    // policy, and a value outside the shared contract is dropped to NULL.
    let purpose = purpose_header(&headers);
    // Companion-sourced flag (M7 / #199): true when Core has tagged this request as
    // originating from the screen-capture companion path. Triggers unconditional
    // Gateway DLP/PII redaction before the provider call.
    let companion_source = headers
        .get("x-ryu-companion-source")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(false);
    // Local-engine admission priority (#queue): Core marks fan-out / scheduled /
    // monitor work as `background` so an interactive chat turn jumps ahead of it
    // when the resident engine's batch slots are full. Unset ⇒ interactive.
    let priority = crate::concurrency::Priority::from_header(
        headers.get("x-ryu-priority").and_then(|v| v.to_str().ok()),
    );
    // Named tool-policy profile (#473 profiles). Core forwards the agent's
    // selected profile name; the gateway resolves it to an allowlist preset in
    // `effective_tool_allowlist`. Absent or unknown ⇒ today's allowlist path.
    let tool_profile = header_string(&headers, "x-ryu-tool-profile");
    // Raw tool passthrough (SDK-side agent loops). When `on`/`true`/`1`, the
    // gateway suppresses BOTH managed tool loops (unified + legacy Composio) and
    // takes the plain branch, so the caller's own `tools` and `tool_calls` pass
    // through untouched. Set by `@ryu/sdk`'s agent runtime so its in-process loop
    // owns tool calling even against a Composio-on node.
    let raw_tools = headers
        .get("x-ryu-raw-tools")
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            let v = v.trim().to_ascii_lowercase();
            matches!(v.as_str(), "on" | "true" | "1" | "yes")
        })
        .unwrap_or(false);

    // Per-request provider prompt-cache override (`off` | `auto` | `explicit`)
    // and TTL. An unparseable value is ignored rather than guessed — a typo must
    // not silently start billing cache writes. The node can refuse overrides
    // entirely via `[prompt_cache].allow_request_override = false`.
    let prompt_cache_mode = header_string(&headers, "x-ryu-prompt-cache")
        .and_then(|v| ryu_gw_providers::PromptCacheMode::parse(&v));
    let prompt_cache_ttl = header_string(&headers, "x-ryu-prompt-cache-ttl");

    // The node's own routing preferences (`v1.<base64url-nopad(JSON)>`). Same
    // discipline as the prompt-cache block above: an unparseable value is ignored
    // rather than guessed at, for the same reason — a typo must not change
    // routing, and must not fail the turn either. What survives here is still
    // RAW; every knob is clamped against the fleet's own decision before it can
    // touch anything (see `pipeline::node_routing`).
    let node_routing = header_string(&headers, "x-ryu-node-routing")
        .and_then(|v| pipeline::node_routing::parse(&v, &state.config.node_routing));

    let mut ctx = authenticate(
        &state,
        AuthInputs {
            raw_api_key: raw_key,
            user_id,
            user_jwt: header_string(&headers, "x-ryu-user-jwt"),
            agent_id,
            agent_provider_access: header_string(&headers, "x-ryu-agent-provider-access"),
            agent_proof,
            skill_ids,
            tool_actions,
            tools_header_present,
            capability_hints,
            slot_provider,
            slot_model,
            session_id,
            feature,
            companion_source,
            tool_search_requested,
            untrusted_caller,
            priority,
            tool_profile,
            raw_tools,
            prompt_cache_mode,
            prompt_cache_ttl,
            node_routing,
            host_conversation,
        },
    )
    .await?;
    ctx.purpose = purpose;
    debug!(request_id = %ctx.request_id, "chat_completions: authenticated");

    // Caller-requested Anthropic betas, carried to the provider on the body.
    apply_anthropic_beta(&headers, &mut body);

    let is_stream = body["stream"].as_bool().unwrap_or(false);

    if is_stream {
        let output = pipeline::run_stream(state, ctx, body).await?;

        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .header("x-request-id", &output.context.request_id)
            .header("x-provider", output.provider_used)
            .body(output.body)
            .map_err(|e| GatewayError::Internal(anyhow::anyhow!("response build error: {e}")))?;

        if let Ok(v) = HeaderValue::from_str(&output.model_used) {
            response.headers_mut().insert("x-routed-model", v);
        }
        if let Some(ref budget) = output.budget {
            apply_budget_headers(response.headers_mut(), budget);
        }
        if let Some(ref degraded) = output.degraded {
            if let Ok(v) = HeaderValue::from_str(&degraded.header_value()) {
                response.headers_mut().insert("x-degraded", v);
            }
        }
        // What the prompt-cache stage did. Read/write token counts are not
        // available yet on a stream (they arrive in the terminal usage frame,
        // after the headers are on the wire) — the observer records them into
        // metrics at stream end instead.
        response.headers_mut().insert(
            "x-ryu-prompt-cache",
            HeaderValue::from_static(output.prompt_cache.as_str()),
        );
        apply_node_routing_header(response.headers_mut(), output.context.node_routing.as_ref());
        // Ok-path policy-alert stamp: stash on the RESPONSE extensions so the
        // router's `map_response` layer writes `x-ryu-policy-alert`. Inserting on
        // the response (not the request) is the F1 correctness fix.
        if let Some(alert) = output.policy_alert {
            response.extensions_mut().insert(alert);
        }

        Ok(response)
    } else {
        let output = pipeline::run(state, ctx, body).await?;

        let budget = output.budget.clone();
        let degraded = output.degraded.clone();
        let policy_alert = output.policy_alert.clone();
        let prompt_cache = output.prompt_cache;
        let cache_read_tokens = output.cache_read_tokens;
        let cache_write_tokens = output.cache_write_tokens;
        let node_routing_seen = output.context.node_routing.clone();
        let mut response = Json(output.response).into_response();
        let hdrs = response.headers_mut();
        if let Ok(v) = HeaderValue::from_str(&output.context.request_id) {
            hdrs.insert("x-request-id", v);
        }
        hdrs.insert("x-provider", HeaderValue::from_static(output.provider_used));
        if let Ok(v) = HeaderValue::from_str(&output.model_used) {
            hdrs.insert("x-routed-model", v);
        }
        hdrs.insert(
            "x-cache",
            HeaderValue::from_static(if output.cache_hit { "HIT" } else { "MISS" }),
        );
        if let Some(ref budget) = budget {
            apply_budget_headers(hdrs, budget);
        }
        if let Some(score) = output.eval_score {
            if let Ok(v) = HeaderValue::from_str(&format!("{score:.4}")) {
                hdrs.insert("x-eval-score", v);
            }
        }
        // AC1 (#218): emit x-degraded header when the request was served by a
        // fallback provider because the primary circuit was open.
        if let Some(ref d) = degraded {
            if let Ok(v) = HeaderValue::from_str(&d.header_value()) {
                hdrs.insert("x-degraded", v);
            }
        }
        // Provider prompt-cache observability, per request rather than only in
        // the aggregate `/metrics` counters: what we did (`x-ryu-prompt-cache`)
        // and what the provider reported back (`x-ryu-cache-read` / `-write`).
        // Together these are how a caller verifies markers actually reached the
        // provider and hit — note `x-cache: HIT` above means this gateway's own
        // response cache answered instead, so the two are never both meaningful.
        hdrs.insert(
            "x-ryu-prompt-cache",
            HeaderValue::from_static(prompt_cache.as_str()),
        );
        if let Ok(v) = HeaderValue::from_str(&cache_read_tokens.to_string()) {
            hdrs.insert("x-ryu-cache-read", v);
        }
        if let Ok(v) = HeaderValue::from_str(&cache_write_tokens.to_string()) {
            hdrs.insert("x-ryu-cache-write", v);
        }
        apply_node_routing_header(hdrs, node_routing_seen.as_ref());
        // Ok-path policy-alert stamp (see the streaming branch): stash on the
        // response extensions for the router's `map_response` layer.
        if let Some(alert) = policy_alert {
            response.extensions_mut().insert(alert);
        }

        Ok(response)
    }
}

/// Agent-scoped OpenAI-compatible ingress used by ACP subprocesses.
///
/// ACP agents make their own HTTP requests, so Core cannot add the normal
/// forwarded identity header after the subprocess starts. Giving them an
/// agent-specific base URL lets the gateway bind that identity at the ingress
/// boundary; the existing authentication rules still decide whether the
/// caller is allowed to use the forwarded id.
pub async fn agent_chat_completions(
    State(state): State<SharedState>,
    Path(agent_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    agent_chat_completions_inner(state, agent_id, None, headers, body).await
}

/// Agent-scoped ingress variant used by managed/remote ACP routes. The proof is
/// bound to the Gateway bearer held by Core, so a tenant token cannot simply
/// rewrite the path and move spend to another agent.
pub async fn agent_chat_completions_with_proof(
    State(state): State<SharedState>,
    Path((agent_id, proof)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    agent_chat_completions_inner(state, agent_id, Some(proof), headers, body).await
}

async fn agent_chat_completions_inner(
    state: SharedState,
    agent_id: String,
    proof: Option<String>,
    mut headers: HeaderMap,
    body: Value,
) -> Result<Response, GatewayError> {
    let agent_id = agent_id.trim();
    if agent_id.is_empty() {
        return Err(GatewayError::BadRequest(
            "agent_id must not be empty".to_owned(),
        ));
    }
    let value = HeaderValue::from_str(agent_id)
        .map_err(|_| GatewayError::BadRequest("invalid agent_id".to_owned()))?;
    headers.insert("x-ryu-agent-id", value);
    if let Some(proof) = proof {
        let value = HeaderValue::from_str(proof.trim())
            .map_err(|_| GatewayError::BadRequest("invalid agent route proof".to_owned()))?;
        headers.insert("x-ryu-agent-proof", value);
    }
    chat_completions(State(state), headers, Json(body)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn headers_with(name: &'static str, value: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(name, HeaderValue::from_static(value));
        headers
    }

    #[test]
    fn purpose_header_keeps_only_contract_values() {
        for value in ["compaction", "auto_title", "plugin:@ryu/notes", "a.b-c_9"] {
            let mut headers = HeaderMap::new();
            headers.insert("x-ryu-purpose", HeaderValue::from_str(value).unwrap());
            assert_eq!(purpose_header(&headers).as_deref(), Some(value), "{value}");
        }
        let too_long = "a".repeat(65);
        for value in ["Compaction", "auto title", "x;drop", "", too_long.as_str()] {
            let mut headers = HeaderMap::new();
            headers.insert("x-ryu-purpose", HeaderValue::from_str(value).unwrap());
            assert_eq!(purpose_header(&headers), None, "{value}");
        }
        assert_eq!(purpose_header(&HeaderMap::new()), None);
    }

    #[test]
    fn untrusted_caller_header_reads_only_true_values() {
        for value in ["1", "true", "ON", "yes"] {
            let mut headers = HeaderMap::new();
            headers.insert(
                "x-ryu-untrusted-caller",
                HeaderValue::from_str(value).unwrap(),
            );
            assert!(untrusted_caller_header(&headers), "{value}");
        }
        for value in ["0", "false", "", "maybe"] {
            let mut headers = HeaderMap::new();
            headers.insert(
                "x-ryu-untrusted-caller",
                HeaderValue::from_str(value).unwrap(),
            );
            assert!(!untrusted_caller_header(&headers), "{value}");
        }
        assert!(!untrusted_caller_header(&HeaderMap::new()));
    }

    #[test]
    fn host_conversation_needs_both_the_id_and_its_proof() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-ryu-host-conversation-id",
            HeaderValue::from_static("conv-1"),
        );
        assert_eq!(host_conversation_headers(&headers), None);
        headers.insert(
            "x-ryu-host-conversation-proof",
            HeaderValue::from_static("proof-1"),
        );
        assert_eq!(
            host_conversation_headers(&headers),
            Some(crate::tools::HostConversation {
                id: "conv-1".into(),
                proof: "proof-1".into(),
            })
        );
        assert_eq!(
            host_conversation_headers(&headers_with(
                "x-ryu-host-conversation-proof",
                "proof-1"
            )),
            None
        );
    }

    #[test]
    fn anthropic_beta_header_becomes_the_private_body_field() {
        let mut body = json!({ "model": "claude-sonnet-4-5", "messages": [] });
        apply_anthropic_beta(
            &headers_with("anthropic-beta", "code-execution-2025-05-22"),
            &mut body,
        );
        assert_eq!(
            body[pipeline::ANTHROPIC_BETA_FIELD],
            json!("code-execution-2025-05-22")
        );
    }

    #[test]
    fn multiple_betas_pass_through_as_the_comma_separated_string() {
        // The provider consumes one comma-separated string, so the header value is
        // forwarded verbatim rather than split and re-joined here.
        let mut body = json!({ "model": "claude-sonnet-4-5" });
        apply_anthropic_beta(
            &headers_with(
                "anthropic-beta",
                "code-execution-2025-05-22,files-api-2025-04-14",
            ),
            &mut body,
        );
        assert_eq!(
            body[pipeline::ANTHROPIC_BETA_FIELD],
            json!("code-execution-2025-05-22,files-api-2025-04-14")
        );
    }

    #[test]
    fn no_header_leaves_the_body_byte_identical() {
        let original = json!({ "model": "gpt-4o", "messages": [], "stream": true });
        let mut body = original.clone();
        apply_anthropic_beta(&HeaderMap::new(), &mut body);
        assert_eq!(body, original, "an untouched request must stay untouched");
    }

    #[test]
    fn blank_header_inserts_nothing() {
        // A whitespace-only value is not an opt-in; inserting it would send an
        // empty `anthropic-beta` to the provider.
        let original = json!({ "model": "claude-sonnet-4-5" });
        let mut body = original.clone();
        apply_anthropic_beta(&headers_with("anthropic-beta", "   "), &mut body);
        assert_eq!(body, original);
    }
}
