//! Per-request NODE ROUTING PREFERENCES — the `x-ryu-node-routing` channel.
//!
//! A managed node (Core pointed at the hosted fleet by `remote_data_plane()`)
//! has opinions about routing that used to have nowhere to go. Most of them
//! already do travel: `connect_openai` sends `x-ryu-slot-chat-provider` /
//! `-model`, `x-ryu-prompt-cache(-ttl)`, `x-ryu-agent-id`, `x-ryu-priority`, and
//! the private `ryu_smart_route` body field, so model/provider pinning, smart
//! routing rules and prompt-cache mode reach the fleet today. What did NOT
//! travel — and what this module carries — is the node's **fallback-chain
//! preference**, its **own additive firewall rules**, and its **OpenRouter
//! provider defaults**, inside a versioned envelope future knobs can plug into
//! without a second header.
//!
//! # Trust class: exactly as trustworthy as the bearer, i.e. not
//!
//! There is no "trusted node" tier to build on. For a dynamically-resolved
//! `rgw_` token `key_config` is `None` (see `authenticate`'s `TryDynamic` arm),
//! so `ApiKeyConfig::trusted_forwarder` never applies and cannot vouch for
//! anything. `ctx.managed_inference` is a *billing* property, not a trust level.
//! So the preference document is treated as hostile input throughout:
//!
//! * every knob may only **narrow** the org's envelope, never widen it;
//! * anything that would widen it is **IGNORED, never rejected** — a preference
//!   must not fail a turn that would otherwise succeed, and must not pass one
//!   that would otherwise fail. The second half is the easy one to lose: a
//!   dropped preference falls back to the FLEET decision, which is then gated
//!   normally. It never falls back to "skip the gate".
//!
//! # Conflict table — which fleet-side symbol wins, and always wins
//!
//! | Concern                     | Authority (a preference cannot touch it)            |
//! |-----------------------------|-----------------------------------------------------|
//! | approved model allowlist    | `EffectivePolicy::allows_model`                     |
//! | locked guardrails           | `EffectivePolicy::requires_firewall` + `scan_locked_guardrails` |
//! | firewall/DLP dials          | `FirewallResolver::resolve` — request scope applies under locked = ALL fields |
//! | credit envelope             | `preflight_credit_gate` (per credit pool)           |
//! | wallet-empty action         | `wallet_empty_decision` + `[credits].fail_closed`   |
//! | spend / session budgets     | `state.with_budget`                                 |
//! | rate limit bucket           | `check_request_for_key(&ctx.api_key, …)` — the key is `rgw_org:<id>`, so a preference cannot move the bucket |
//! | prompt-cache override       | `[prompt_cache].allow_request_override`             |
//! | OpenRouter privacy          | configured `data_collection`/`zdr` values override node defaults |
//! | post-call debit attribution | reads the provider that actually answered, never a preference |
//! | provider credentials        | fleet config; nothing here names a key               |
//!
//! # Why fallback is subset-and-reorder only
//!
//! This is load-bearing, not stylistic. `preflight_credit_gate` runs against the
//! PRIMARY provider's credit pool only — `enforce_budget` says so in prose — and
//! it runs BEFORE the chain is expanded at the three `fallback_chain` sites. A
//! preference that could ADD a provider would therefore get a request served out
//! of a pool that was never gated, which is precisely the "never widens the
//! envelope" acceptance criterion inverted. So: every id must already appear in
//! the fleet's own chain, position 0 (the primary) stays pinned by the fleet, and
//! each surviving entry is re-checked against its own pool.
//!
//! # Shape: two clamps, not one, because they run at different times
//!
//! `pre_process` resolves the firewall scanner ONCE at the top, above the stage
//! loop — before `PipelineStage::Route` produces a decision. So the firewall half
//! must be clamped early (it has no dependency beyond node config) while the
//! fallback half needs `decision.provider` and can only run at chain expansion.
//! Folding both into one call would silently apply the overlay to nothing.
//!
//! Every function here is pure: no `AppState`, no live fleet, no I/O. That is
//! deliberate and mirrors why `resolve_prompt_cache_override` was split out of
//! `apply_prompt_cache` — the interesting behaviour is the clamp, and the clamp
//! should be testable on its own.

use serde::Deserialize;

use crate::config::{FirewallOverlay, NodeRoutingConfig, ProviderId};
use crate::pipeline::RequestContext;

/// The version tag this reader understands. The grammar is
/// `v1.<base64url-nopad(compact JSON)>`. Base64 is the encoding rather than raw
/// JSON so the value is header-safe by construction (no CR/LF, no non-ASCII, no
/// quoting rules to get wrong) and so the size bound is a plain byte count on the
/// wire, checkable before any decoding work happens.
const VERSION_PREFIX: &str = "v1.";

/// The node's stated routing preferences, straight off the wire and NOT yet
/// clamped. Deliberately has NO `deny_unknown_fields`: the same contract as
/// `policy::ResolveResponse`, whose
/// `resolve_response_ignores_unknown_credential_rotation_field` test exists
/// precisely so a newer sender cannot brick an older reader. Every field is
/// `#[serde(default)]`, so a v1.1 sender adding a knob degrades to "the fields
/// this reader knows about" rather than to nothing.
#[derive(Debug, Clone, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "snake_case")]
pub struct NodeRoutingPrefs {
    /// Preferred fallback order, as gateway provider ids. A SUBSET of the fleet's
    /// own chain for the routed primary, in the node's preferred order; ids the
    /// fleet would not have used anyway are dropped. See the module doc for why
    /// this can never be an append.
    pub fallback: Vec<String>,
    /// The node's OWN extra firewall rules, applied as the narrowest scope in the
    /// node → org → agent cascade and only ever additively (see
    /// [`clamp_firewall`]).
    pub firewall: Option<FirewallOverlay>,
    /// OpenRouter's request-level `provider` options. Applied only to an
    /// OpenRouter attempt; the provider's configured privacy policy remains
    /// authoritative after these defaults are merged.
    pub openrouter: Option<serde_json::Value>,
    /// OpenRouter model ids to try after the caller's primary model. An
    /// explicit request-level `models` array always wins.
    pub openrouter_model_fallbacks: Vec<String>,
}

impl NodeRoutingPrefs {
    /// Whether this document asks for anything at all. An empty document is
    /// indistinguishable from no header, so callers can drop it early.
    pub fn is_empty(&self) -> bool {
        self.fallback.is_empty()
            && self.firewall.is_none()
            && self
                .openrouter
                .as_ref()
                .and_then(serde_json::Value::as_object)
                .is_none_or(serde_json::Map::is_empty)
            && self.openrouter_model_fallbacks.is_empty()
    }
}

/// Merge saved OpenRouter provider defaults into one OpenRouter attempt.
/// Explicit per-request fields keep precedence, and other providers never see
/// the OpenRouter-only `provider` options.
pub fn apply_openrouter_preferences(
    allowed_by_entitlement: bool,
    prefs: Option<&NodeRoutingPrefs>,
    cfg: &NodeRoutingConfig,
    provider_name: &str,
    payload: &mut serde_json::Value,
) -> bool {
    if !allowed_by_entitlement || !cfg.allow_request_override || provider_name != "openrouter" {
        return false;
    }
    let Some(options) = prefs
        .and_then(|prefs| prefs.openrouter.as_ref())
        .and_then(serde_json::Value::as_object)
    else {
        return false;
    };
    let Some(payload) = payload.as_object_mut() else {
        return false;
    };

    let provider = payload
        .entry("provider")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let Some(provider) = provider.as_object_mut() else {
        return false;
    };

    let mut applied = false;
    for (key, value) in options {
        if !provider.contains_key(key) {
            provider.insert(key.clone(), value.clone());
            applied = true;
        }
    }
    applied
}

/// Add model fallbacks to an OpenRouter chat completion only when it has no
/// explicit `models` list. This is separate from generic provider preferences
/// because embeddings, images, and audio endpoints do not use chat fallback
/// routing.
pub fn apply_openrouter_model_fallbacks(
    allowed_by_entitlement: bool,
    prefs: Option<&NodeRoutingPrefs>,
    cfg: &NodeRoutingConfig,
    provider_name: &str,
    payload: &mut serde_json::Value,
) -> bool {
    if !allowed_by_entitlement || !cfg.allow_request_override || provider_name != "openrouter" {
        return false;
    }
    let Some(prefs) = prefs.filter(|prefs| !prefs.openrouter_model_fallbacks.is_empty()) else {
        return false;
    };
    let Some(payload) = payload.as_object_mut() else {
        return false;
    };
    if payload.contains_key("models") {
        return false;
    }
    payload.insert(
        "models".to_owned(),
        serde_json::Value::Array(
            prefs
                .openrouter_model_fallbacks
                .iter()
                .cloned()
                .map(serde_json::Value::String)
                .collect(),
        ),
    );
    true
}

/// Why a preference (or part of one) was not honoured. Carried out of the clamps
/// so tests assert on the REASON rather than only on the outcome — "the chain was
/// unchanged" is true for a dozen different bugs, "the entry was dropped because
/// its pool is unfunded" is true for one.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(dead_code)] // Variants are matched in tests and logged; not all are read in prod.
pub enum DropReason {
    /// `[node_routing].allow_request_override = false` — the whole document is
    /// dropped without inspecting it.
    NodeLocked,
    /// A fallback id the fleet's own chain for this primary does not contain.
    NotInFleetChain(String),
    /// The preference named the fleet's own primary. A harmless no-op — position 0
    /// is pinned by the fleet — but distinct from [`Self::NotInFleetChain`], which
    /// would be a literally false statement about a provider that IS in the chain.
    PrimaryIsPinned(String),
    /// A fallback id whose credit pool this org cannot pay for.
    PoolUnfunded(String),
    /// More `fallback` entries than `[node_routing].max_fallback`; the excess is
    /// ignored (the prefix is still honoured — a work bound must not become a
    /// policy cliff).
    TooManyFallbacks,
    /// More `custom_patterns` than `max_patterns`, or more total regex bytes than
    /// `max_pattern_bytes`. The whole overlay is dropped rather than truncated:
    /// half of somebody's rule set is not a rule set.
    OverlayTooLarge,
}

/// Parse the raw `x-ryu-node-routing` header value.
///
/// Returns `None` — never an error — on every malformed case: empty, missing or
/// unknown version tag, bad base64, bad JSON, over the wire bound, over the
/// decoded bound, or a document that asks for nothing. Same discipline as the
/// `x-ryu-prompt-cache` header one block above it in `api/chat.rs`: a typo must
/// not change routing, and it must not fail the turn either.
///
/// A node with `allow_request_override = false` returns `None` too, so
/// `ctx.node_routing` is `None` and the observable state matches the enforced
/// one. Doing the lock check only in the clamps would leave the context field
/// `Some` on a locked node, and the response echo would then tell a caller its
/// preference was accepted while every clamp had dropped it — the worst possible
/// answer for someone debugging why their preference is not applying. The clamps
/// keep their own lock check regardless: this is the early exit, not the
/// enforcement point, and enforcement must not depend on a caller having gone
/// through `parse`.
pub fn parse(raw: &str, cfg: &NodeRoutingConfig) -> Option<NodeRoutingPrefs> {
    use base64::Engine as _;

    if !cfg.allow_request_override {
        return None;
    }

    let raw = raw.trim();
    // Wire bound FIRST, before any decode: the point of a byte bound is that it
    // costs nothing to enforce.
    if raw.is_empty() || raw.len() > cfg.max_header_bytes {
        return None;
    }
    let encoded = raw.strip_prefix(VERSION_PREFIX)?;

    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded.as_bytes())
        .ok()?;
    if decoded.len() > cfg.max_doc_bytes {
        return None;
    }

    let prefs: NodeRoutingPrefs = serde_json::from_slice(&decoded).ok()?;
    (!prefs.is_empty()).then_some(prefs)
}

/// The result of clamping the node's fallback preference against the fleet's own
/// chain: the chain to actually iterate, plus why anything was left out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClampedFallback {
    /// The chain to dispatch over. Always a permutation of a SUBSET of the fleet
    /// chain, always with the fleet's primary at position 0.
    pub chain: Vec<ProviderId>,
    pub dropped: Vec<DropReason>,
}

/// Clamp the node's fallback preference against the fleet's own chain for the
/// routed primary.
///
/// `fleet_chain` is `state.router.fallback_chain(&decision.provider)` — the whole
/// universe of providers this request may touch. The output is a re-ordering of
/// a subset of it:
///
/// * position 0 is the fleet's primary, always, and is never taken from the
///   preference. It is the one the pre-flight credit gate already ran against.
/// * an id the fleet chain does not contain is dropped (`NotInFleetChain`) —
///   this is the rule that keeps the envelope from widening.
/// * a surviving id whose credit pool the org cannot fund is dropped
///   (`PoolUnfunded`), so a reorder can never promote a provider the org cannot
///   pay for into a position the gate never checked.
/// * fleet entries the preference did not mention keep their relative order and
///   follow the preferred ones. Dropping them would let the preference SHORTEN
///   the chain into a hard failure where the fleet had a working fallback, which
///   is the "must not fail a turn that would otherwise succeed" half.
///
/// `allow_request_override = false`, no preference, or an empty `fallback` all
/// return the fleet chain untouched.
pub fn clamp_fallback(
    prefs: Option<&NodeRoutingPrefs>,
    cfg: &NodeRoutingConfig,
    ctx: &RequestContext,
    fleet_chain: Vec<ProviderId>,
    pool_gate: impl Fn(&RequestContext, Option<&str>) -> bool,
) -> ClampedFallback {
    let mut dropped = Vec::new();

    if !cfg.allow_request_override {
        // Only report the lock when there was something to lock out, so an
        // operator reading logs is not told about a preference nobody sent.
        if prefs.is_some() {
            dropped.push(DropReason::NodeLocked);
        }
        return ClampedFallback {
            chain: fleet_chain,
            dropped,
        };
    }

    let Some(prefs) = prefs.filter(|p| !p.fallback.is_empty()) else {
        return ClampedFallback {
            chain: fleet_chain,
            dropped,
        };
    };

    // The fleet's primary is pinned. Everything below reorders the TAIL.
    let Some((primary, tail)) = fleet_chain.split_first() else {
        return ClampedFallback {
            chain: fleet_chain,
            dropped,
        };
    };
    let primary = primary.clone();
    let tail: Vec<ProviderId> = tail.to_vec();

    let requested = if prefs.fallback.len() > cfg.max_fallback {
        dropped.push(DropReason::TooManyFallbacks);
        &prefs.fallback[..cfg.max_fallback]
    } else {
        &prefs.fallback[..]
    };

    let mut preferred: Vec<ProviderId> = Vec::with_capacity(tail.len());
    for id in requested {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        // Membership in the TAIL, not the whole chain: naming the primary again
        // is a no-op, not a promotion, and must not duplicate a dispatch attempt.
        let Some(found) = tail.iter().find(|p| p.as_str() == id) else {
            dropped.push(if primary.as_str() == id {
                DropReason::PrimaryIsPinned(id.to_string())
            } else {
                DropReason::NotInFleetChain(id.to_string())
            });
            continue;
        };
        if preferred.iter().any(|p| p == found) {
            continue;
        }
        // Re-gate: a reorder promotes a provider into a slot the pre-flight gate
        // never evaluated (it only ever saw the primary's pool).
        let pool = crate::credit_pools::pool_for_gateway_provider(found.as_str());
        if !pool_gate(ctx, pool) {
            dropped.push(DropReason::PoolUnfunded(id.to_string()));
            continue;
        }
        preferred.push(found.clone());
    }

    let mut chain = Vec::with_capacity(fleet_chain.len());
    chain.push(primary);
    chain.extend(preferred.iter().cloned());
    // Fleet entries the preference did not name (or that were dropped) keep their
    // original relative order behind the preferred ones. The preference reorders;
    // it never removes a fallback the fleet was willing to use.
    chain.extend(tail.into_iter().filter(|p| !preferred.contains(p)));

    ClampedFallback { chain, dropped }
}

/// Clamp the node's own firewall overlay into something safe to apply as the
/// narrowest scope of the cascade.
///
/// The additive-only rule is NOT enforced here — it is enforced mechanically by
/// the resolver, which applies this overlay with `locked` containing every field
/// name, so each scalar goes through `stricter_policy` / `louder_alert` /
/// `stricter_inspector` / locked `apply_bool` and loosening is structurally
/// impossible. What this function does is make that application *safe to reach*:
///
/// * `[node_routing].allow_request_override = false` ⇒ nothing (`NodeLocked`).
/// * `normalize_overlay` strips the node-only `wrap_untrusted_tool_results`
///   (a per-scope override of a process-global would be a silent no-op).
/// * `locked_fields` is cleared. A client must not contribute locks: request
///   scope is the leaf, so a lock there freezes nothing, and it would still
///   perturb the resolver's cache key.
/// * `evaluators` is cleared. Evaluator bindings merge by id under a PER-BINDING
///   `locked` flag rather than the field-lock set, so the "locked = ALL fields"
///   trick does not cover them and an unlocked binding could be loosened. v1
///   therefore carries no evaluator bindings at request scope at all — an
///   omission, not a silent ignore, and cheap to add properly later.
/// * over the pattern caps ⇒ nothing (`OverlayTooLarge`). Dropped whole rather
///   than truncated: half a rule set is not a rule set.
pub fn clamp_firewall(
    prefs: Option<&NodeRoutingPrefs>,
    cfg: &NodeRoutingConfig,
) -> (Option<FirewallOverlay>, Vec<DropReason>) {
    let mut dropped = Vec::new();

    if !cfg.allow_request_override {
        if prefs.is_some() {
            dropped.push(DropReason::NodeLocked);
        }
        return (None, dropped);
    }

    let Some(ov) = prefs.and_then(|p| p.firewall.as_ref()) else {
        return (None, dropped);
    };

    let mut ov = crate::firewall::resolve::normalize_overlay(ov);
    ov.locked_fields.clear();
    ov.evaluators = None;

    if ov.custom_patterns.len() > cfg.max_patterns {
        dropped.push(DropReason::OverlayTooLarge);
        return (None, dropped);
    }
    let pattern_bytes: usize = ov.custom_patterns.iter().map(|p| p.regex.len()).sum();
    if pattern_bytes > cfg.max_pattern_bytes {
        dropped.push(DropReason::OverlayTooLarge);
        return (None, dropped);
    }

    (Some(ov), dropped)
}

/// Whether a CLIENT-SUPPLIED slot model may be dispatched under `policy`.
///
/// This closes a live envelope hole that predates the preference channel and is
/// independent of it. `PipelineStage::Policy` checks `allows_model` against
/// `body["model"]`, but `PipelineStage::Route` then lets `ctx.slot_model` — read
/// straight off the client's `x-ryu-slot-chat-model` header — replace the model
/// actually dispatched, via `route_modality_with_slot`. An `rgw_` bearer could
/// therefore route to a model the org's `approved_models` forbids by naming an
/// approved one in the body and the real one in the headers.
///
/// "Headers", plural, and that was checked rather than inferred: `ryu-gw-router`'s
/// `route_modality` only reads `slot_model` inside its
/// `if let Some(provider) = slot_provider` arm, so the bypass needs BOTH
/// `x-ryu-slot-chat-provider` and `-model`. The pipeline's own guard
/// (`slot_provider.is_some() || slot_model.is_some()`) is looser than what
/// actually routes, which is exactly the kind of gap that makes a
/// "surely a bare slot model does nothing" reading wrong in one direction or the
/// other. Clamping the model unconditionally is correct either way: with the slot
/// provider set, dropping the model falls back to `requested_model`, which the
/// Policy stage already approved.
///
/// Only the CLIENT-supplied value is checked, never the fleet's own map output:
/// a `model_map` rewrite to a provider-side id (`gpt-4o` → `gpt-4o-2024-08-06`)
/// is the fleet's own decision and must keep working. On failure the caller
/// ignores the slot and takes the fleet's own routing — ignore, never reject, so
/// the turn still succeeds under a model the org DID approve.
pub fn slot_model_allowed(
    slot_model: Option<&str>,
    policy: &crate::policy::EffectivePolicy,
) -> bool {
    match slot_model {
        Some(m) => policy.allows_model(m),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CustomPattern, CustomPatternKind, FirewallPolicy};

    fn cfg() -> NodeRoutingConfig {
        NodeRoutingConfig::default()
    }

    fn encode(json: &str) -> String {
        use base64::Engine as _;
        format!(
            "{VERSION_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes())
        )
    }

    fn ctx() -> RequestContext {
        RequestContext {
            org_limits: None,
            identity: None,
            standing: None,
            enforcement: None,
            host_conversation: None,
            authorized_operation: crate::config::ApiKeyOperation::Inference,
            provider_snapshot: None,
            request_id: "nr-test".into(),
            api_key: "rgw_org:acme".into(),
            owner_binding: ryu_gw_credentials::fingerprint("rgw_org:acme"),
            is_master_key: false,
            org_id: Some("acme".into()),
            team_id: None,
            project_id: None,
            user_name: None,
            user_id: None,
            agent_id: None,
            agent_provider_access: None,
            key_config: None,
            skill_ids: None,
            tool_actions: None,
            tools_header_present: false,
            capability_hints: None,
            slot_provider: None,
            slot_model: None,
            own_supply_route: None,
            violation_attempt: Default::default(),
            session_id: None,
            feature: None,
            purpose: None,
            companion_source: false,
            tool_search_requested: false,
            untrusted_caller: false,
            priority: crate::concurrency::Priority::Interactive,
            tool_profile: None,
            raw_tools: false,
            managed_inference: true,
            openrouter_routing_enabled: false,
            remaining_budget_micro_usd: None,
            unrestricted_budget_micro_usd: None,
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            credit_accounting_unavailable: false,
            budget_resolved_at: None,
            resolved_policy: None,
            prompt_cache_mode: None,
            prompt_cache_ttl: None,
            node_routing: None,
        }
    }

    /// Every entry's pool is funded. The default for tests that are not about
    /// the credit gate.
    fn funded(_: &RequestContext, _: Option<&str>) -> bool {
        true
    }

    fn chain(ids: &[&str]) -> Vec<ProviderId> {
        ids.iter().map(|s| ProviderId::from(*s)).collect()
    }

    // ── parse: ignore, never reject ──────────────────────────────────────────

    #[test]
    fn parse_accepts_a_well_formed_v1_document() {
        let raw = encode(r#"{"fallback":["anthropic","groq"]}"#);
        let prefs = parse(&raw, &cfg()).expect("a well-formed v1 document parses");
        assert_eq!(prefs.fallback, vec!["anthropic", "groq"]);
        assert!(prefs.firewall.is_none());
    }

    #[test]
    fn parse_accepts_openrouter_provider_preferences() {
        let raw = encode(
            r#"{"openrouter":{"sort":"throughput","allow_fallbacks":true,"zdr":true},"openrouter_model_fallbacks":["anthropic/claude-sonnet-4.5"]}"#,
        );
        let prefs = parse(&raw, &cfg()).expect("OpenRouter routing options parse");
        assert_eq!(prefs.openrouter.as_ref().unwrap()["sort"], "throughput");
        assert_eq!(prefs.openrouter.as_ref().unwrap()["zdr"], true);
        assert_eq!(
            prefs.openrouter_model_fallbacks,
            vec!["anthropic/claude-sonnet-4.5"]
        );
    }

    #[test]
    fn openrouter_preferences_only_fill_missing_fields_for_openrouter() {
        let prefs = NodeRoutingPrefs {
            openrouter: Some(serde_json::json!({
                "allow_fallbacks": true,
                "data_collection": "deny",
                "sort": "throughput"
            })),
            ..Default::default()
        };
        let mut body = serde_json::json!({
            "provider": { "allow_fallbacks": false, "only": ["azure"] }
        });
        assert!(apply_openrouter_preferences(
            true,
            Some(&prefs),
            &cfg(),
            "openrouter",
            &mut body
        ));
        assert_eq!(body["provider"]["allow_fallbacks"], false);
        assert_eq!(body["provider"]["only"], serde_json::json!(["azure"]));
        assert_eq!(body["provider"]["sort"], "throughput");
        assert_eq!(body["provider"]["data_collection"], "deny");

        let mut other_provider_body = serde_json::json!({ "model": "gpt-4o" });
        assert!(!apply_openrouter_preferences(
            true,
            Some(&prefs),
            &cfg(),
            "openai",
            &mut other_provider_body
        ));
        assert!(other_provider_body.get("provider").is_none());

        let fallbacks = NodeRoutingPrefs {
            openrouter_model_fallbacks: vec!["anthropic/claude-sonnet-4.5".to_owned()],
            ..Default::default()
        };
        let mut fallback_body = serde_json::json!({"model":"openai/gpt-4.1"});
        assert!(apply_openrouter_model_fallbacks(
            true,
            Some(&fallbacks),
            &cfg(),
            "openrouter",
            &mut fallback_body
        ));
        assert_eq!(
            fallback_body["models"],
            serde_json::json!(["anthropic/claude-sonnet-4.5"])
        );

        let mut explicit_models = serde_json::json!({
            "model":"openai/gpt-4.1",
            "models":["google/gemini-2.5-pro"]
        });
        assert!(!apply_openrouter_model_fallbacks(
            true,
            Some(&fallbacks),
            &cfg(),
            "openrouter",
            &mut explicit_models
        ));
        assert_eq!(
            explicit_models["models"],
            serde_json::json!(["google/gemini-2.5-pro"])
        );

        let mut locked = cfg();
        locked.allow_request_override = false;
        let mut locked_body = serde_json::json!({"model":"openai/gpt-4.1"});
        assert!(!apply_openrouter_model_fallbacks(
            true,
            Some(&fallbacks),
            &locked,
            "openrouter",
            &mut locked_body
        ));
        assert!(locked_body.get("models").is_none());

        let mut locked = cfg();
        locked.allow_request_override = false;
        let mut locked_body = serde_json::json!({ "model": "openrouter/auto" });
        assert!(!apply_openrouter_preferences(
            true,
            Some(&prefs),
            &locked,
            "openrouter",
            &mut locked_body
        ));
        assert!(locked_body.get("provider").is_none());

        let mut unentitled_body = serde_json::json!({"model":"openrouter/auto"});
        assert!(!apply_openrouter_preferences(
            false,
            Some(&prefs),
            &cfg(),
            "openrouter",
            &mut unentitled_body
        ));
        assert!(!apply_openrouter_model_fallbacks(
            false,
            Some(&fallbacks),
            &cfg(),
            "openrouter",
            &mut unentitled_body
        ));
        assert!(unentitled_body.get("provider").is_none());
        assert!(unentitled_body.get("models").is_none());
    }

    #[test]
    fn parse_ignores_an_unknown_field_so_a_newer_sender_cannot_brick_this_reader() {
        // The `ResolveResponse` contract: no `deny_unknown_fields`, so a v1.1
        // sender's extra knob degrades to "the fields v1 knows", not to nothing.
        let raw = encode(r#"{"fallback":["groq"],"cost_tier":"cheap"}"#);
        let prefs = parse(&raw, &cfg()).expect("an unknown field must not fail the parse");
        assert_eq!(prefs.fallback, vec!["groq"]);
    }

    #[test]
    fn parse_returns_none_on_every_malformed_shape() {
        let c = cfg();
        let cases: Vec<(&str, String)> = vec![
            ("empty", String::new()),
            ("whitespace", "   ".into()),
            ("no version tag", "eyJhIjoxfQ".into()),
            ("unknown version", "v2.eyJhIjoxfQ".into()),
            ("bare version tag", VERSION_PREFIX.into()),
            ("bad base64", format!("{VERSION_PREFIX}!!!!not-base64!!!!")),
            (
                "standard-base64 padding",
                format!("{VERSION_PREFIX}eyJhIjoxfQ=="),
            ),
            ("bad json", encode("{not json")),
            ("json but not an object", encode("[1,2,3]")),
            ("wrong field type", encode(r#"{"fallback":"groq"}"#)),
            ("asks for nothing", encode("{}")),
            ("empty fallback", encode(r#"{"fallback":[]}"#)),
        ];
        for (label, raw) in cases {
            assert!(
                parse(&raw, &c).is_none(),
                "{label}: a malformed document must be ignored, not guessed at"
            );
        }
    }

    #[test]
    fn parse_returns_none_on_a_locked_node_so_the_echo_cannot_lie() {
        // If this returned `Some`, `ctx.node_routing` would be `Some` on a locked
        // node and the response echo would report the preference as accepted while
        // every clamp dropped it.
        let mut c = cfg();
        c.allow_request_override = false;
        let raw = encode(r#"{"fallback":["groq"]}"#);
        assert!(parse(&raw, &c).is_none());
        // …and the same document parses fine once the node allows overrides, so
        // this is the lock talking and not an unrelated rejection.
        c.allow_request_override = true;
        assert!(parse(&raw, &c).is_some());
    }

    #[test]
    fn parse_enforces_the_wire_bound_before_decoding() {
        let mut c = cfg();
        c.max_header_bytes = 32;
        let raw = encode(r#"{"fallback":["anthropic","groq","cerebras","together"]}"#);
        assert!(raw.len() > 32, "fixture must actually exceed the bound");
        assert!(parse(&raw, &c).is_none());
    }

    #[test]
    fn parse_enforces_the_decoded_bound_too() {
        // The wire bound alone cannot bound serde's work: base64 expands 4:3, so
        // a document inside the wire bound is still up to 3/4 of it decoded.
        let mut c = cfg();
        c.max_doc_bytes = 8;
        let raw = encode(r#"{"fallback":["groq"]}"#);
        assert!(raw.len() <= c.max_header_bytes);
        assert!(parse(&raw, &c).is_none());
    }

    // ── clamp_fallback ───────────────────────────────────────────────────────

    #[test]
    fn a_locked_node_drops_the_preference_entirely() {
        let mut c = cfg();
        c.allow_request_override = false;
        let prefs = NodeRoutingPrefs {
            fallback: vec!["groq".into()],
            firewall: Some(FirewallOverlay {
                enabled: Some(false),
                ..Default::default()
            }),
            openrouter: None,
            openrouter_model_fallbacks: Vec::new(),
        };
        let fleet = chain(&["openai", "anthropic", "groq"]);

        let out = clamp_fallback(Some(&prefs), &c, &ctx(), fleet.clone(), funded);
        assert_eq!(
            out.chain, fleet,
            "a locked node keeps the fleet chain as-is"
        );
        assert_eq!(out.dropped, vec![DropReason::NodeLocked]);

        let (ov, dropped) = clamp_firewall(Some(&prefs), &c);
        assert!(ov.is_none());
        assert_eq!(dropped, vec![DropReason::NodeLocked]);
    }

    #[test]
    fn no_preference_leaves_the_fleet_chain_byte_identical() {
        let fleet = chain(&["openai", "anthropic", "groq"]);
        let out = clamp_fallback(None, &cfg(), &ctx(), fleet.clone(), funded);
        assert_eq!(out.chain, fleet);
        assert!(out.dropped.is_empty());
    }

    #[test]
    fn a_reorder_inside_the_fleet_chain_survives() {
        let prefs = NodeRoutingPrefs {
            fallback: vec!["groq".into(), "anthropic".into()],
            ..Default::default()
        };
        let fleet = chain(&["openai", "anthropic", "groq"]);
        let out = clamp_fallback(Some(&prefs), &cfg(), &ctx(), fleet, funded);
        assert_eq!(
            out.chain,
            chain(&["openai", "groq", "anthropic"]),
            "the primary stays pinned; the tail takes the node's order"
        );
        assert!(out.dropped.is_empty());
    }

    #[test]
    fn an_id_outside_the_fleet_chain_is_dropped_and_never_added() {
        // THE acceptance criterion. `preflight_credit_gate` ran against the
        // primary's pool only, before expansion — an added provider would be
        // served out of a pool nothing ever gated.
        let prefs = NodeRoutingPrefs {
            fallback: vec!["bedrock".into(), "groq".into()],
            ..Default::default()
        };
        let fleet = chain(&["openai", "anthropic", "groq"]);
        let out = clamp_fallback(Some(&prefs), &cfg(), &ctx(), fleet.clone(), funded);

        assert_eq!(out.chain, chain(&["openai", "groq", "anthropic"]));
        assert_eq!(
            out.dropped,
            vec![DropReason::NotInFleetChain("bedrock".into())]
        );
        for p in &out.chain {
            assert!(
                fleet.contains(p),
                "{p:?} is not in the fleet chain — the preference widened the envelope"
            );
        }
        assert!(out.chain.len() <= fleet.len());
    }

    #[test]
    fn naming_the_primary_does_not_duplicate_a_dispatch_attempt() {
        let prefs = NodeRoutingPrefs {
            fallback: vec!["openai".into(), "groq".into()],
            ..Default::default()
        };
        let fleet = chain(&["openai", "anthropic", "groq"]);
        let out = clamp_fallback(Some(&prefs), &cfg(), &ctx(), fleet, funded);
        assert_eq!(out.chain, chain(&["openai", "groq", "anthropic"]));
        assert_eq!(
            out.dropped,
            vec![DropReason::PrimaryIsPinned("openai".into())],
            "the primary is pinned by the fleet, so naming it is a no-op — and \
             reporting it as 'not in the fleet chain' would be a false statement \
             about a provider that plainly is"
        );
    }

    #[test]
    fn an_entry_whose_pool_is_unfunded_is_dropped() {
        // A reorder must not promote a provider the org cannot pay for into a
        // position the pre-flight gate never evaluated.
        let prefs = NodeRoutingPrefs {
            fallback: vec!["groq".into()],
            ..Default::default()
        };
        let fleet = chain(&["openai", "anthropic", "groq"]);
        let out = clamp_fallback(Some(&prefs), &cfg(), &ctx(), fleet, |_, _| false);
        assert_eq!(
            out.chain,
            chain(&["openai", "anthropic", "groq"]),
            "the fleet order stands when the preferred entry cannot be funded"
        );
        assert_eq!(out.dropped, vec![DropReason::PoolUnfunded("groq".into())]);
    }

    #[test]
    fn the_gate_closure_contract_is_admit_true_reject_false() {
        // The signature alone does not say which way `bool` points, and
        // `clamped_fallback_chain` adapts a function whose `Some` means REJECTED.
        // Pin the contract on this side; `credit_gate_polarity_is_wired_correctly`
        // in `pipeline::fallback_tests` pins the adapter itself, end to end.
        let prefs = NodeRoutingPrefs {
            fallback: vec!["groq".into()],
            ..Default::default()
        };
        let fleet = chain(&["openai", "anthropic", "groq"]);

        let admit = clamp_fallback(Some(&prefs), &cfg(), &ctx(), fleet.clone(), |_, _| true);
        assert_eq!(
            admit.chain,
            chain(&["openai", "groq", "anthropic"]),
            "true must mean ADMIT — the reorder survives"
        );
        assert!(admit.dropped.is_empty());

        let reject = clamp_fallback(Some(&prefs), &cfg(), &ctx(), fleet.clone(), |_, _| false);
        assert_eq!(
            reject.chain, fleet,
            "false must mean REJECT — nothing moves"
        );
        assert_eq!(
            reject.dropped,
            vec![DropReason::PoolUnfunded("groq".into())]
        );
    }

    #[test]
    fn the_preference_can_never_lengthen_the_chain() {
        let prefs = NodeRoutingPrefs {
            fallback: (0..64).map(|i| format!("made-up-{i}")).collect(),
            ..Default::default()
        };
        let fleet = chain(&["openai", "anthropic"]);
        let out = clamp_fallback(Some(&prefs), &cfg(), &ctx(), fleet.clone(), funded);
        assert_eq!(out.chain, fleet);
        assert!(
            out.dropped.contains(&DropReason::TooManyFallbacks),
            "the work bound must fire before 64 pool lookups do"
        );
    }

    // ── clamp_firewall ───────────────────────────────────────────────────────

    #[test]
    fn a_request_overlay_contributes_no_locks() {
        // Request scope is the leaf, so a lock there freezes nothing — but it
        // WOULD perturb the resolver's cache key.
        let prefs = NodeRoutingPrefs {
            firewall: Some(FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                locked_fields: vec!["enabled".into(), "policy".into()],
                ..Default::default()
            }),
            ..Default::default()
        };
        let (ov, dropped) = clamp_firewall(Some(&prefs), &cfg());
        let ov = ov.expect("a stricter policy survives the clamp");
        assert!(ov.locked_fields.is_empty());
        assert_eq!(ov.policy, Some(FirewallPolicy::Block));
        assert!(dropped.is_empty());
    }

    #[test]
    fn the_node_only_wrap_field_is_stripped_at_request_scope_too() {
        let prefs = NodeRoutingPrefs {
            firewall: Some(FirewallOverlay {
                wrap_untrusted_tool_results: Some(false),
                redact_pii: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        };
        let (ov, _) = clamp_firewall(Some(&prefs), &cfg());
        let ov = ov.expect("the rest of the overlay survives");
        assert_eq!(ov.wrap_untrusted_tool_results, None);
        assert_eq!(ov.redact_pii, Some(true));
    }

    #[test]
    fn evaluator_bindings_are_not_carried_at_request_scope_in_v1() {
        // Bindings merge under a per-binding `locked` flag, which the
        // "locked = ALL fields" trick does not cover — so an unlocked binding
        // could be loosened. Omitted outright rather than half-honoured.
        let prefs = NodeRoutingPrefs {
            firewall: Some(FirewallOverlay {
                evaluators: Some(Vec::new()),
                redact_secrets: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        };
        let (ov, _) = clamp_firewall(Some(&prefs), &cfg());
        let ov = ov.expect("the rest of the overlay survives");
        assert!(ov.evaluators.is_none());
    }

    #[test]
    fn an_oversized_pattern_set_drops_the_whole_overlay() {
        let mut c = cfg();
        c.max_patterns = 2;
        let prefs = NodeRoutingPrefs {
            firewall: Some(FirewallOverlay {
                custom_patterns: (0..3)
                    .map(|i| CustomPattern {
                        name: format!("p{i}"),
                        regex: "x".into(),
                        kind: CustomPatternKind::default(),
                    })
                    .collect(),
                ..Default::default()
            }),
            ..Default::default()
        };
        let (ov, dropped) = clamp_firewall(Some(&prefs), &c);
        assert!(ov.is_none(), "half a rule set is not a rule set");
        assert_eq!(dropped, vec![DropReason::OverlayTooLarge]);
    }

    #[test]
    fn a_pattern_set_over_the_byte_budget_drops_the_whole_overlay() {
        let mut c = cfg();
        c.max_pattern_bytes = 8;
        let prefs = NodeRoutingPrefs {
            firewall: Some(FirewallOverlay {
                custom_patterns: vec![CustomPattern {
                    name: "huge".into(),
                    regex: "a".repeat(64),
                    kind: CustomPatternKind::default(),
                }],
                ..Default::default()
            }),
            ..Default::default()
        };
        let (ov, dropped) = clamp_firewall(Some(&prefs), &c);
        assert!(ov.is_none());
        assert_eq!(dropped, vec![DropReason::OverlayTooLarge]);
    }

    // ── slot model allowlist ─────────────────────────────────────────────────

    #[test]
    fn a_client_slot_model_outside_the_allowlist_is_not_allowed() {
        let policy = crate::policy::EffectivePolicy {
            approved_models: vec!["gpt-4o-mini".into()],
            ..Default::default()
        };
        assert!(!slot_model_allowed(Some("gpt-4o"), &policy));
        assert!(slot_model_allowed(Some("gpt-4o-mini"), &policy));
    }

    #[test]
    fn an_empty_allowlist_allows_every_slot_model() {
        // The non-allowlisted deployment (every self-hosted / single-org node)
        // must be byte-identical to today.
        let policy = crate::policy::EffectivePolicy::default();
        assert!(slot_model_allowed(Some("anything-at-all"), &policy));
        assert!(slot_model_allowed(None, &policy));
    }
}
