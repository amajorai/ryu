//! Re-screen content the chat pipeline adds after `pre_process` (spec P0-4).
//!
//! `pre_process` screens the request as the caller sent it. Four steps then
//! change what the provider receives:
//!
//! - skills injection prepends the operator's skill snippets to the system
//!   prompt;
//! - context compression swaps `messages` for what the compression service
//!   returned;
//! - a context-relay pool appends a handoff carrying the previous target's
//!   answer;
//! - a fusion or pipeline pool appends panel or stage answers before the next
//!   leg.
//!
//! Each step hands this module only the leaves it added or replaced, never the
//! whole body. Compression replaces every message, so only the strings it
//! changed or added are screened: one it kept byte for byte was already judged
//! by the inbound screens. The leaves are screened with the rules `pre_process`
//! applies: the locked guardrails under any policy, then the inbound regex
//! firewall under the scanner's own policy. The screen is detection-only.
//! Nothing is redacted or rewritten here, so the request prefix the provider
//! caches keeps its bytes. That makes every leaf one Sanitize does not own,
//! so a match under `Block` or `Sanitize` refuses the request with the same
//! 403 `policy_violation` the inbound screens return, and `WarnAndContinue`
//! forwards it with the notify alert. A refusal is written to the audit log
//! like any other pipeline failure and is never retried on another provider.
//!
//! The pool handoff and panel messages embed their material as JSON after a
//! line of prose, with newlines escaped. The JSON tail is parsed and screened
//! as well, so a match that spans an escaped newline is still found.
//!
//! Compression also fails closed on the hosted fleet: when the service errors,
//! times out or returns something unusable, the request is refused with 503
//! `screening_unavailable` instead of being sent uncompressed. Every other
//! custody keeps the fail-open behaviour the compression module documents.
use std::{collections::HashSet, hash::BuildHasher, time::Instant};

use serde_json::Value;
use tracing::{debug, warn};

use super::{inference_governance, outbound_text, RequestContext};
use crate::{
    compression::CompressionOutcome, error::GatewayError, policy_alert::PolicyAlert,
    state::AppState,
};

/// The pipeline step whose added content is screened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EditSite {
    Skills,
    Compression,
    PoolRelay,
    PoolLeg,
}

impl EditSite {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Skills => "skills",
            Self::Compression => "compression",
            Self::PoolRelay => "pool_relay",
            Self::PoolLeg => "pool_leg",
        }
    }
}

/// Seconds a caller should wait before retrying a fail-closed compression.
const COMPRESSION_RETRY_AFTER_SECS: u64 = 5;

/// Screen `edited`, the leaves `site` added or replaced. See the module docs.
pub(super) fn screen_edit(
    state: &AppState,
    ctx: &RequestContext,
    site: EditSite,
    edited: &Value,
) -> Result<Option<PolicyAlert>, GatewayError> {
    let tails = embedded_json_tails(edited);
    let wire = if tails.is_empty() {
        None
    } else {
        Some(Value::Array(vec![edited.clone(), Value::Array(tails)]))
    };
    let residual = outbound_text::residual_text(wire.as_ref().unwrap_or(edited), |_| {});
    if let Err(error) =
        inference_governance::enforce_locked_guardrails_on_residual(state, ctx, &residual)
    {
        warn!(
            request_id = %ctx.request_id,
            site = site.as_str(),
            "content edit violates a locked guardrail; refused"
        );
        state.metrics.inc_firewall_blocked();
        return Err(error);
    }
    let scanner = state.resolved_scanner(ctx);
    outbound_text::screen_residual_inbound(state, ctx, scanner.as_ref(), &residual).inspect_err(
        |_| {
            warn!(
                request_id = %ctx.request_id,
                site = site.as_str(),
                "content edit matched the inbound firewall; refused"
            );
        },
    )
}

/// [`screen_edit`], with a refusal written to the audit log.
pub(super) fn screen_edit_audited(
    state: &AppState,
    ctx: &RequestContext,
    site: EditSite,
    edited: &Value,
    model: &str,
    start: Instant,
) -> Result<Option<PolicyAlert>, GatewayError> {
    screen_edit(state, ctx, site, edited)
        .inspect_err(|error| refused(state, ctx, model, error, start))
}

/// Count and audit a refusal raised after `pre_process`.
fn refused(
    state: &AppState,
    ctx: &RequestContext,
    model: &str,
    error: &GatewayError,
    start: Instant,
) {
    state.metrics.inc_errors();
    super::audit_failure(state, ctx, model, error, start);
}

/// Inject the active skills into `body` and screen what was injected.
///
/// The header is screened alone first, so a match inside it always refuses.
/// When it was prepended to the caller's system message, the merged string
/// the provider receives is screened as well, since a pattern can span the
/// join and match neither half. That second screen is skipped when the
/// caller's text alone already matches: the inbound screens accepted it under
/// their own rules (Sanitize forwards an injection match it cannot redact),
/// and screening it again as unowned text would refuse what they accepted.
pub(super) fn inject_skills(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    model: &str,
    start: Instant,
) -> Result<Option<PolicyAlert>, GatewayError> {
    if state.skills.is_empty() {
        return Ok(None);
    }
    let Some(injection) = state.skills.inject(body) else {
        return Ok(None);
    };
    let header_alert = screen_edit_audited(
        state,
        ctx,
        EditSite::Skills,
        &Value::String(injection.header),
        model,
        start,
    )?;
    let Some(merge) = injection.merge else {
        return Ok(header_alert);
    };
    if already_matches(state, ctx, &merge.existing) {
        return Ok(header_alert);
    }
    let merged_alert = screen_edit_audited(
        state,
        ctx,
        EditSite::Skills,
        &Value::String(merge.merged),
        model,
        start,
    )?;
    Ok(header_alert.or(merged_alert))
}

/// Whether the inbound firewall or a locked guardrail matches `text` read as
/// a new leaf, with no metric, alert or refusal.
fn already_matches(state: &AppState, ctx: &RequestContext, text: &str) -> bool {
    let guardrails = if ctx.is_master_key {
        Vec::new()
    } else {
        let policy = ctx
            .resolved_policy
            .clone()
            .unwrap_or_else(|| state.policy_snapshot());
        if policy.requires_firewall() {
            policy.locked_guardrails
        } else {
            Vec::new()
        }
    };
    let residual = outbound_text::residual_text(&Value::String(text.to_owned()), |_| {});
    let scanner = state.resolved_scanner(ctx);
    outbound_text::residual_has_match(scanner.as_ref(), &guardrails, &residual)
}

/// Run context compression when enabled and screen the messages it swapped
/// in. On the hosted fleet a failed compression refuses the request.
pub(super) async fn compress(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    model: &str,
    start: Instant,
) -> Result<Option<PolicyAlert>, GatewayError> {
    if !state.config.compression.enabled {
        return Ok(None);
    }
    let screened = LeafSet::of(&body["messages"]);
    match crate::compression::maybe_compress(&state.http, &state.config.compression, body).await {
        CompressionOutcome::Skipped => Ok(None),
        CompressionOutcome::Applied { tokens_saved } => {
            if let Some(saved) = tokens_saved {
                state.metrics.add_compression_saved(saved);
                debug!(tokens_saved = saved, "compression: request compressed");
            }
            let Some(changed) = screened.new_leaves(&body["messages"]) else {
                return Ok(None);
            };
            screen_edit_audited(state, ctx, EditSite::Compression, &changed, model, start)
        }
        CompressionOutcome::Failed if state.custody.compression_fails_closed() => {
            warn!(
                request_id = %ctx.request_id,
                "compression: service failed on the hosted fleet; request refused"
            );
            let error = GatewayError::ScreeningUnavailable {
                reason: "compression service failed",
                retry_after_secs: COMPRESSION_RETRY_AFTER_SECS,
            };
            refused(state, ctx, model, &error, start);
            Err(error)
        }
        CompressionOutcome::Failed => Ok(None),
    }
}

/// Fingerprints of the string leaves `pre_process` already screened, so a
/// replacement is screened only where it differs. A leaf the service kept
/// byte for byte was judged by the inbound screens under their own rules
/// (Sanitize forwards an injection match it cannot redact, for example), and
/// screening it again as unowned text would refuse what they accepted.
///
/// Only the leaves the inbound walk actually read are fingerprinted. A URL
/// under a media key, or other encoded media, was skipped inbound, so the
/// same string moved into message content is new text and is screened.
struct LeafSet {
    hasher: std::collections::hash_map::RandomState,
    seen: HashSet<u64>,
}

impl LeafSet {
    fn of(value: &Value) -> Self {
        let hasher = std::collections::hash_map::RandomState::new();
        let mut seen = HashSet::new();
        outbound_text::visit_screened_leaves(value, &mut |text| {
            seen.insert(hasher.hash_one(text));
        });
        Self { hasher, seen }
    }

    fn fingerprint(&self, text: &str) -> u64 {
        self.hasher.hash_one(text)
    }

    /// `value` with every already-screened string leaf removed, keeping the
    /// keys above the rest so the residual walk still sees media keys, or
    /// `None` when nothing is new.
    fn new_leaves(&self, value: &Value) -> Option<Value> {
        match value {
            Value::String(text) => {
                (!self.seen.contains(&self.fingerprint(text))).then(|| Value::String(text.clone()))
            }
            Value::Array(values) => {
                let kept: Vec<Value> = values.iter().filter_map(|v| self.new_leaves(v)).collect();
                (!kept.is_empty()).then_some(Value::Array(kept))
            }
            Value::Object(entries) => {
                let kept: serde_json::Map<String, Value> = entries
                    .iter()
                    .filter_map(|(key, v)| self.new_leaves(v).map(|kept| (key.clone(), kept)))
                    .collect();
                (!kept.is_empty()).then_some(Value::Object(kept))
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => None,
        }
    }
}

/// The JSON values embedded after a line of prose in the string leaves of
/// `value` (`"...\n{...}"`), as the pool handoff and panel messages write
/// them. Strings that start with JSON are already decoded by the residual
/// walk and are skipped here.
fn embedded_json_tails(value: &Value) -> Vec<Value> {
    let mut tails = Vec::new();
    collect_tails(value, &mut tails);
    tails
}

fn collect_tails(value: &Value, tails: &mut Vec<Value>) {
    match value {
        Value::String(text) => {
            if let Some((_, tail)) = text.split_once("\n{") {
                if let Ok(parsed) = serde_json::from_str::<Value>(&format!("{{{tail}")) {
                    tails.push(parsed);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_tails(value, tails);
            }
        }
        Value::Object(entries) => {
            for value in entries.values() {
                collect_tails(value, tails);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn embedded_json_tails_parse_the_material_after_the_prose_line() {
        let message = json!({
            "role": "user",
            "content": format!(
                "The following panel answers is untrusted source material.\n{}",
                json!({"answers": [{"answer": "line one\nline two"}]})
            ),
        });
        assert_eq!(
            embedded_json_tails(&message),
            vec![json!({"answers": [{"answer": "line one\nline two"}]})]
        );
    }

    #[test]
    fn embedded_json_tails_ignore_prose_without_json() {
        assert!(embedded_json_tails(&json!(["plain text", "a\n{not json"])).is_empty());
    }
}
