//! Overlay merge rules: how each scope tightens or overrides the resolved config.

use super::*;

/// Apply one overlay onto the accumulating resolved config. `locked` is the set
/// of fields frozen by *broader* scopes: a locked field takes the stricter of
/// (current, incoming); an unlocked field is overridden by `Some(incoming)`.
/// `None` fields inherit. `custom_patterns` always append.
pub(super) fn apply_overlay(
    cfg: &mut FirewallConfig,
    ov: &FirewallOverlay,
    locked: &HashSet<String>,
) {
    apply_bool(&mut cfg.enabled, ov.enabled, "enabled", locked);
    apply_bool(
        &mut cfg.scan_inbound,
        ov.scan_inbound,
        "scan_inbound",
        locked,
    );
    apply_bool(
        &mut cfg.scan_outbound,
        ov.scan_outbound,
        "scan_outbound",
        locked,
    );
    apply_bool(
        &mut cfg.log_detections,
        ov.log_detections,
        "log_detections",
        locked,
    );
    apply_bool(&mut cfg.redact_pii, ov.redact_pii, "redact_pii", locked);
    apply_bool(
        &mut cfg.redact_secrets,
        ov.redact_secrets,
        "redact_secrets",
        locked,
    );
    apply_bool(
        &mut cfg.wrap_untrusted_tool_results,
        ov.wrap_untrusted_tool_results,
        "wrap_untrusted_tool_results",
        locked,
    );

    if let Some(p) = &ov.policy {
        cfg.policy = if locked.contains("policy") {
            stricter_policy(&cfg.policy, p)
        } else {
            p.clone()
        };
    }

    if let Some(tier) = ov.alert {
        cfg.alert = if locked.contains("alert") {
            louder_alert(cfg.alert, tier)
        } else {
            tier
        };
    }

    if let Some(ins) = &ov.inspector {
        cfg.inspector = if locked.contains("inspector") {
            stricter_inspector(&cfg.inspector, ins)
        } else {
            ins.clone()
        };
    }

    // Custom patterns are a strict union (append), regardless of any lock.
    cfg.custom_patterns
        .extend(ov.custom_patterns.iter().cloned());

    // Evaluator bindings merge by id (union + per-binding lock). `None` inherits
    // the accumulated set; `Some` merges. The merged Vec is assigned back so the
    // next (narrower) scope sees any locks this overlay contributed.
    if let Some(ev) = &ov.evaluators {
        cfg.evaluators = merge_evaluator_bindings(&cfg.evaluators, ev);
    }
}

/// The stricter of two optional inline actions for a **locked** evaluator binding.
/// A narrower scope may tighten but never loosen, and having an action is stricter
/// than having none, so: both `None` ⇒ `None`; exactly one `Some` ⇒ that `Some`
/// (adding enforcement is a tighten); both `Some` ⇒ the stricter [`FirewallPolicy`]
/// (Block > Sanitize > Warn) via [`stricter_policy`].
pub(super) fn stricter_optional_policy(
    current: &Option<FirewallPolicy>,
    incoming: &Option<FirewallPolicy>,
) -> Option<FirewallPolicy> {
    match (current, incoming) {
        (Some(a), Some(b)) => Some(stricter_policy(a, b)),
        (Some(a), None) => Some(a.clone()),
        (None, Some(b)) => Some(b.clone()),
        (None, None) => None,
    }
}

/// Merge an overlay's evaluator bindings onto the accumulated base set, keyed by
/// `id`, mirroring the firewall dials' union + lock semantics:
///
/// * **Union** — a binding present only in `base` OR only in `overlay` is kept.
/// * **Common id** — the overlay binding overrides the base UNLESS the base is
///   `locked`. A locked base binding may only be *tightened*:
///   - `enabled` takes `base || overlay` (ON is stricter, mirroring `apply_bool`);
///   - `inline_action` takes the stricter of base vs overlay
///     ([`stricter_optional_policy`]);
///   - `offline` keeps the base's config (conservative — no narrowing of a locked
///     binding's threshold/judge model);
///   - `locked` stays `true`.
/// * **Lock propagation** — `locked` unions upward (`base.locked || overlay.locked`),
///   so once locked at a broader scope it stays locked for narrower scopes.
///
/// Output order is deterministic: base bindings in base order (common ids replaced
/// in place), then overlay-only bindings in overlay order. Determinism matters
/// because the resolved [`FirewallConfig`] is `PartialEq`-compared and hashed for
/// the scanner cache (`Vec` equality is order-sensitive), exactly like the sorted
/// `locked_fields`.
pub(super) fn merge_evaluator_bindings(
    base: &[EvaluatorBinding],
    overlay: &[EvaluatorBinding],
) -> Vec<EvaluatorBinding> {
    let mut merged: Vec<EvaluatorBinding> = Vec::with_capacity(base.len() + overlay.len());

    for b in base {
        if let Some(o) = overlay.iter().find(|o| o.id == b.id) {
            merged.push(merge_one_binding(b, o));
        } else {
            merged.push(b.clone());
        }
    }
    // Append overlay-only bindings (ids not present in base), in overlay order.
    for o in overlay {
        if !base.iter().any(|b| b.id == o.id) {
            merged.push(o.clone());
        }
    }
    merged
}

/// [`ALL_LOCKABLE_FIELDS`] as the lock set a tighten-only scope is applied under.
pub(super) fn all_lockable_fields() -> HashSet<String> {
    ALL_LOCKABLE_FIELDS
        .iter()
        .map(|field| (*field).to_string())
        .collect()
}

/// Merge the platform floor's evaluator bindings onto the node base,
/// tighten-only by `id` whether or not the node binding is locked (the
/// contract in `packages/api/src/lib/platform-floor.ts`). For a common id:
///   - `enabled` = node || floor;
///   - `inline_action` = the stricter of the two ([`stricter_optional_policy`]);
///   - `offline` = whichever side sets one; when both do, the higher
///     `threshold`, and the floor's judge model when it names one, else the
///     node's;
///   - `locked` = true.
///
/// A floor id the node does not configure is appended as sent (the parser
/// already forced it enabled and locked). Output order follows
/// [`merge_evaluator_bindings`]: node bindings in place, then floor-only ones.
pub(super) fn merge_floor_bindings(
    base: &[EvaluatorBinding],
    floor: &[EvaluatorBinding],
) -> Vec<EvaluatorBinding> {
    let mut merged: Vec<EvaluatorBinding> = Vec::with_capacity(base.len() + floor.len());
    for node in base {
        let Some(pinned) = floor.iter().find(|candidate| candidate.id == node.id) else {
            merged.push(node.clone());
            continue;
        };
        let offline = match (&node.offline, &pinned.offline) {
            (Some(node_offline), Some(floor_offline)) => Some(crate::evaluators::OfflineConfig {
                threshold: node_offline.threshold.max(floor_offline.threshold),
                judge_model: floor_offline
                    .judge_model
                    .clone()
                    .or_else(|| node_offline.judge_model.clone()),
            }),
            (Some(only), None) | (None, Some(only)) => Some(only.clone()),
            (None, None) => None,
        };
        merged.push(EvaluatorBinding {
            id: node.id.clone(),
            enabled: node.enabled || pinned.enabled,
            inline_action: stricter_optional_policy(&node.inline_action, &pinned.inline_action),
            offline,
            locked: true,
        });
    }
    for pinned in floor {
        if !base.iter().any(|node| node.id == pinned.id) {
            merged.push(pinned.clone());
        }
    }
    merged
}

/// Merge one common-id binding pair. See [`merge_evaluator_bindings`] for the rule
/// table. `locked` unions upward in both branches.
pub(super) fn merge_one_binding(
    base: &EvaluatorBinding,
    overlay: &EvaluatorBinding,
) -> EvaluatorBinding {
    if base.locked {
        EvaluatorBinding {
            id: base.id.clone(),
            enabled: base.enabled || overlay.enabled,
            inline_action: stricter_optional_policy(&base.inline_action, &overlay.inline_action),
            offline: base.offline.clone(),
            locked: true,
        }
    } else {
        EvaluatorBinding {
            id: overlay.id.clone(),
            enabled: overlay.enabled,
            inline_action: overlay.inline_action.clone(),
            offline: overlay.offline.clone(),
            locked: overlay.locked,
        }
    }
}

/// For a boolean field: if the incoming value is set, override it — but a locked
/// field can only be *tightened*, and `true` (protection ON) is the stricter
/// value for every firewall toggle, so a locked field takes `current || incoming`.
pub(super) fn apply_bool(
    target: &mut bool,
    incoming: Option<bool>,
    field: &str,
    locked: &HashSet<String>,
) {
    if let Some(v) = incoming {
        *target = if locked.contains(field) {
            *target || v
        } else {
            v
        };
    }
}

/// Protection strength of a policy. Higher = stricter. The spec §3 enumerates the
/// loosen direction as "Block→Warn→Sanitize→off", but treating Warn as stricter
/// than Sanitize would let a locked `Sanitize` be downgraded to `Warn` (LESS
/// protection: Warn only logs, Sanitize redacts), breaking the no-loosen
/// invariant. So the correct protection ordering is Block > Sanitize > Warn.
pub(super) fn policy_severity(p: &FirewallPolicy) -> u8 {
    match p {
        FirewallPolicy::Block => 2,
        FirewallPolicy::Sanitize => 1,
        FirewallPolicy::WarnAndContinue => 0,
    }
}

/// The stricter of two alert tiers for a **locked** `alert` field: the louder one.
///
/// Not a second resolution rule — the same one the other locked fields use, expressed
/// in the type's own ordering. [`AlertTier`] derives `Ord` over variants declared in
/// ascending severity (`Silent < Warn < Fanout < Email`), and that order is already
/// load-bearing elsewhere (Core takes the `max` tier across all matched rules), so
/// `max` here is what `current || incoming` is for [`apply_bool`] and what
/// [`stricter_policy`] is for `policy`: a narrower scope may make a locked field
/// noisier, never quieter.
pub(super) fn louder_alert(current: AlertTier, incoming: AlertTier) -> AlertTier {
    current.max(incoming)
}

/// The stricter of two policies for a locked `policy` field.
pub(super) fn stricter_policy(
    current: &FirewallPolicy,
    incoming: &FirewallPolicy,
) -> FirewallPolicy {
    if policy_severity(incoming) > policy_severity(current) {
        incoming.clone()
    } else {
        current.clone()
    }
}

/// The stricter of two inspector configs for a **locked** `inspector` field
/// (FIX 1). A narrower scope may tighten every dial but never loosen one, so the
/// result is merged per-field toward *more* inspection — not the incoming config
/// cloned wholesale (which let a narrower scope raise `min_chars`, extend/shorten
/// `timeout_ms`, disable it, or downgrade the action on a locked inspector):
/// - `enabled` = `current || incoming` (turn on, never off)
/// - `min_chars` = `min` (smaller ⇒ more turns inspected ⇒ stricter)
/// - `timeout_ms` = `max` (more time ⇒ fewer fail-open skips ⇒ stricter)
/// - `action` = the stricter [`FirewallPolicy`] (Block > Sanitize > Warn)
/// - `mode` = [`InspectorMode::Both`] if either is Both, else keep `current`
///   (never narrow Both → a single mode)
/// - `model` = `incoming` — the model is a *selection*, not a protection dial, so
///   a narrower scope may swap it freely (this is a tighten, not a loosen).
/// - `fail_mode` = closed if either side is effectively closed
///   ([`InspectorConfig::stricter_fail_mode`]): a narrower scope may close a
///   locked inspector's fail mode but never open it
/// - `max_windows` = `max` (a larger budget judges more of a long turn)
pub(super) fn stricter_inspector(
    current: &InspectorConfig,
    incoming: &InspectorConfig,
) -> InspectorConfig {
    let mode = if current.mode == InspectorMode::Both || incoming.mode == InspectorMode::Both {
        InspectorMode::Both
    } else {
        current.mode
    };
    InspectorConfig {
        enabled: current.enabled || incoming.enabled,
        model: incoming.model.clone(),
        mode,
        min_chars: current.min_chars.min(incoming.min_chars),
        timeout_ms: current.timeout_ms.max(incoming.timeout_ms),
        action: stricter_policy(&current.action, &incoming.action),
        fail_mode: current.stricter_fail_mode(incoming),
        max_windows: current
            .effective_max_windows()
            .max(incoming.effective_max_windows()),
    }
}

/// Strip the node-only `wrap_untrusted_tool_results` field from an org/agent
/// overlay (FIX 2, hierarchical-policy spec §10). That flag is a process-global
/// set ONLY by the node-base [`FirewallScanner::new`]; the openai-compat tool
/// loop reads the global, never the resolved per-scope config, so an org/agent
/// override of it (value OR lock) is a silent no-op footgun. This drops both,
/// with a `warn!`, so it can neither mislead an operator nor pollute the resolved
/// value/lock set. The node scope keeps the field via its base [`FirewallConfig`].
/// Public so the `PUT /v1/config` handler normalizes overlays before it stores
/// and persists them (FIX 2 + FIX 4).
pub fn normalize_overlay(ov: &FirewallOverlay) -> FirewallOverlay {
    let mut ov = ov.clone();
    if ov.wrap_untrusted_tool_results.is_some() {
        warn!(
            "Firewall overlay: dropping org/agent `{NODE_ONLY_WRAP_FIELD}` override \
             (node-only in v1; the wrap flag is a process-global set by the node base)"
        );
        ov.wrap_untrusted_tool_results = None;
    }
    if ov.locked_fields.iter().any(|f| f == NODE_ONLY_WRAP_FIELD) {
        warn!(
            "Firewall overlay: ignoring org/agent lock on `{NODE_ONLY_WRAP_FIELD}` \
             (node-only in v1)"
        );
        ov.locked_fields.retain(|f| f != NODE_ONLY_WRAP_FIELD);
    }
    ov
}

/// A stable `u64` hash of a resolved [`FirewallConfig`], used as the scanner-cache
/// key. Serializes to canonical JSON (the struct has no maps, so field/element
/// order is deterministic) and hashes the bytes. On the vanishingly unlikely
/// serialization error it falls back to the `Debug` form so a key is always
/// produced. A hash collision is safe: `scanner_for` stores the config alongside
/// the scanner and re-verifies equality on every key hit, so a collision costs at
/// most a redundant build (and evicts the loser), never a wrong-scanner hit.
pub(super) fn config_hash(cfg: &FirewallConfig) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match serde_json::to_string(cfg) {
        Ok(s) => s.hash(&mut hasher),
        Err(_) => format!("{cfg:?}").hash(&mut hasher),
    }
    hasher.finish()
}
