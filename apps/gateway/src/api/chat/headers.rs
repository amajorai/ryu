//! Request-header readers and response-header writers for the chat
//! completions handlers.
use axum::http::{HeaderMap, HeaderValue};
use serde_json::Value;

use crate::{budget::BudgetDecision, config::BudgetAction, pipeline};

/// Read an optional non-empty header value as an owned string.
pub(super) fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `x-ryu-purpose`, kept only when it satisfies the shared Core/Gateway
/// contract ([`crate::audit::valid_purpose`]).
pub(super) fn purpose_header(headers: &HeaderMap) -> Option<String> {
    header_string(headers, "x-ryu-purpose")
        .filter(|purpose| crate::audit::valid_purpose(purpose).is_some())
}

/// Whether the request carries `x-ryu-untrusted-caller` set to a true value
/// (`1`, `true`, `on` or `yes`). Any other value, or no header, is the normal
/// path; the header can only restrict.
pub(super) fn untrusted_caller_header(headers: &HeaderMap) -> bool {
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
pub(super) fn host_conversation_headers(
    headers: &HeaderMap,
) -> Option<crate::tools::HostConversation> {
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
pub(super) fn apply_node_routing_header(
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
pub(super) fn apply_anthropic_beta(headers: &HeaderMap, body: &mut Value) {
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
pub(super) fn apply_budget_headers(hdrs: &mut HeaderMap, budget: &BudgetDecision) {
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
            host_conversation_headers(&headers_with("x-ryu-host-conversation-proof", "proof-1")),
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
