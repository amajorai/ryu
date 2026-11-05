//! Request-side governance of passthrough prompts: the vouched caller identity,
//! the model allowlist, request DLP and locked guardrails, and the provider and
//! region policy.

use axum::http::HeaderMap;
use serde_json::Value;

use super::{audit_rows::header_string, WireFormat};
use crate::{firewall::FirewallBackend, state::SharedState};
use ryu_gw_passthrough::{visit_request_conversation_strings_mut, visit_request_strings_mut};

/// Header a trusted forwarder uses to authenticate on the passthrough. The
/// `Authorization` header already carries the user's subscription bearer, so the
/// Gateway credential travels separately; it is stripped before forwarding.
pub(super) const GATEWAY_KEY_HEADER: &str = "x-ryu-gateway-key";

/// Attribution recorded on passthrough audit rows.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct PassthroughIdentity {
    pub(super) user_id: Option<String>,
    pub(super) agent_id: Option<String>,
    pub(super) feature: Option<String>,
}

impl PassthroughIdentity {
    /// Honor `x-ryu-user-id` / `x-ryu-agent-id` / `x-ryu-feature` only when the
    /// request also presents the master key or a `trusted_forwarder` API key in
    /// [`GATEWAY_KEY_HEADER`]; otherwise record no identity. Loopback alone is not
    /// an identity: any local process (or, under userspace mesh networking, a
    /// tailnet peer) can reach this route.
    pub(super) fn from_headers(state: &SharedState, headers: &HeaderMap) -> Self {
        let Some(key) = header_string(headers, GATEWAY_KEY_HEADER) else {
            return Self::default();
        };
        let key = key.strip_prefix("Bearer ").unwrap_or(&key);
        let trusted = state.with_auth(|auth| {
            auth.master_key
                .as_deref()
                .is_some_and(|master| crate::pipeline::ct_eq(key, master))
                || auth
                    .api_keys
                    .iter()
                    .any(|entry| entry.trusted_forwarder && crate::pipeline::ct_eq(key, &entry.key))
        });
        if !trusted {
            return Self::default();
        }
        Self {
            user_id: header_string(headers, "x-ryu-user-id"),
            agent_id: header_string(headers, "x-ryu-agent-id"),
            feature: header_string(headers, "x-ryu-feature"),
        }
    }
}

/// Apply request-side DLP and locked guardrails to a parsed prompt body in place.
///
/// When `redact` is on, every prompt-bearing string is sanitized; the redacted
/// text is then re-scanned, and a PII/secret match that survived redaction (for
/// example a zero-width split the raw-text regexes miss) refuses the request
/// rather than forwarding it. Control-plane locked guardrails are enforced on
/// the outgoing text even when the local firewall is off, as on the chat path.
/// Returns whether the body changed, or the refusal reason.
fn inspect_request(
    format: WireFormat,
    scanner: &crate::firewall::FirewallScanner,
    policy: &crate::policy::EffectivePolicy,
    redact: bool,
    body: &mut Value,
) -> Result<bool, String> {
    if !redact && policy.locked_guardrails.is_empty() {
        return Ok(false);
    }
    let mut changed = false;
    let mut outgoing = String::new();
    visit_request_strings_mut(format, body, &mut |text| {
        if redact {
            let sanitized = FirewallBackend::sanitize(scanner, text);
            if sanitized != *text {
                *text = sanitized;
                changed = true;
            }
        }
        if !outgoing.is_empty() {
            outgoing.push('\n');
        }
        outgoing.push_str(text);
    });
    if redact {
        let config = scanner.config();
        let mut categories: Vec<String> = Vec::with_capacity(2);
        if config.redact_pii {
            categories.push("pii".to_owned());
        }
        if config.redact_secrets {
            categories.push("secrets".to_owned());
        }
        if let Some(survivor) = scanner.scan_locked_guardrails(&outgoing, &categories) {
            return Err(format!(
                "passthrough prompt content could not be redacted: {} ({:?})",
                survivor.pattern_name, survivor.kind
            ));
        }
    }
    // Locked DLP categories (secrets, PII) scan every outgoing string. The
    // content categories (prompt and code injection, toxicity, bias) scan only
    // the conversation: the agent's own system prompt and tool definitions are
    // agent-authored and would trip them on every turn (Claude Code's Bash tool
    // text matches both the instruction-override and `$(cat …)` patterns).
    let (dlp, content): (Vec<String>, Vec<String>) = policy
        .locked_guardrails
        .iter()
        .cloned()
        .partition(|name| crate::pipeline::is_dlp_guardrail(name));
    let mut violation = scanner.scan_locked_guardrails(&outgoing, &dlp);
    if violation.is_none() && !content.is_empty() {
        let mut conversation = String::new();
        visit_request_conversation_strings_mut(format, body, &mut |text| {
            if !conversation.is_empty() {
                conversation.push('\n');
            }
            conversation.push_str(text);
        });
        violation = scanner.scan_locked_guardrails(&conversation, &content);
    }
    if let Some(violation) = violation {
        return Err(format!(
            "passthrough prompt violates a locked guardrail: {} ({:?})",
            violation.pattern_name, violation.kind
        ));
    }
    Ok(changed)
}

/// Apply the model allowlist and [`inspect_request`] to one native prompt body.
/// A prompt that names no model is refused while the policy restricts models
/// (or is unavailable), so omitting `model` cannot skip the allowlist.
/// Records the first model seen in `model` for the audit row.
pub(super) fn govern_prompt(
    format: WireFormat,
    scanner: &crate::firewall::FirewallScanner,
    policy: &crate::policy::EffectivePolicy,
    redact: bool,
    prompt: &mut Value,
    model: &mut String,
) -> Result<bool, String> {
    match prompt.get("model").and_then(Value::as_str) {
        Some(requested) => {
            if *model == "unknown" {
                *model = requested.to_owned();
            }
            if !policy.allows_model(requested) {
                return Err(format!(
                    "Model '{requested}' is not approved by control-plane policy"
                ));
            }
        }
        None if !policy.available || !policy.approved_models.is_empty() => {
            return Err(
                "passthrough prompt names no model and control-plane policy restricts models"
                    .to_owned(),
            );
        }
        None => {}
    }
    inspect_request(format, scanner, policy, redact, prompt)
}

/// Govern an Anthropic Message Batches create body: every `requests[].params`
/// is a Messages request and gets the same model allowlist and DLP as
/// `v1/messages`. While any prompt policy is in force, a body that is not a
/// `requests` array of objects with `params` cannot be evaluated and is refused.
pub(super) fn govern_message_batch(
    scanner: &crate::firewall::FirewallScanner,
    policy: &crate::policy::EffectivePolicy,
    redact: bool,
    governed: bool,
    body: &mut Value,
    model: &mut String,
) -> Result<bool, String> {
    const MALFORMED: &str =
        "passthrough message batch must be a `requests` array of objects with `params`";
    let Some(requests) = body.get_mut("requests").and_then(Value::as_array_mut) else {
        return if governed {
            Err(MALFORMED.to_owned())
        } else {
            Ok(false)
        };
    };
    let mut changed = false;
    for request in requests {
        match request
            .get_mut("params")
            .filter(|params| params.is_object())
        {
            Some(params) => {
                changed |= govern_prompt(
                    WireFormat::Anthropic,
                    scanner,
                    policy,
                    redact,
                    params,
                    model,
                )?;
            }
            None if governed => return Err(MALFORMED.to_owned()),
            None => {}
        }
    }
    Ok(changed)
}

/// The control-plane provider id a passthrough wire format reaches upstream.
fn upstream_provider_id(format: WireFormat) -> &'static str {
    match format {
        WireFormat::Anthropic => "anthropic",
        WireFormat::OpenAiResponses => "openai",
    }
}

/// The policy that governs one passthrough request: the node's effective
/// policy, narrowed by the caller's own rules when a trusted credential vouched
/// for an end-user id (as the chat path narrows `resolved_policy`). Unresolved
/// caller rules yield an unavailable policy, which denies.
pub(super) async fn passthrough_policy(
    state: &SharedState,
    user_id: Option<&str>,
) -> crate::policy::EffectivePolicy {
    let base = state.policy_snapshot();
    let (Some(cache), Some(user_id)) = (state.user_policy.as_ref(), user_id) else {
        return base;
    };
    let Some(token) = cache.static_key() else {
        return base;
    };
    let rules = cache.rules_for(token, user_id).await;
    crate::policy::policy_for_caller(&base, rules.as_deref())
}

/// Refuse the request unless the policy approves the fixed upstream provider
/// and its data region. The passthrough upstreams carry no verified region
/// metadata, so any `allowed_regions` restriction denies them (fail closed).
pub(super) fn authorize_upstream(
    format: WireFormat,
    policy: &crate::policy::EffectivePolicy,
) -> Result<(), String> {
    let provider = upstream_provider_id(format);
    if policy.allows_provider(provider) && policy.allows_region(None) {
        return Ok(());
    }
    Err(format!(
        "Provider '{provider}' is not authorized for the control-plane provider or region policy"
    ))
}
