//! Declarative pipeline stage ordering (W6d decomposition).
//!
//! Before W6d, [`crate::pipeline::pre_process`] ran its stages as a hardcoded
//! sequence of numbered steps (`1. rate limit`, `2. burst`, `3. firewall`, …).
//! That made the order a compile-time constant with no seam: an operator could
//! not disable an opt-in governance stage or reorder the governance block, and a
//! plugin had no place to describe where it runs.
//!
//! This module turns that order into DATA. [`StageOrder`] is a resolved,
//! validated `Vec<PipelineStage>` built ONCE at config-apply time (in
//! [`crate::state::AppState::new`]) and stored on the state, so the request hot
//! path pays **zero** per-request allocation to know the order — it borrows the
//! pre-resolved slice. `pre_process` iterates that slice and dispatches each id
//! to the same inline logic it always ran.
//!
//! ## Safety is enforced as invariants, not convention
//!
//! Config may reorder or disable ONLY the stages [`PipelineStage::reorderable`]
//! marks reorderable (the governance block: inspector, inline-input, policy,
//! companion-DLP). The safety-critical skeleton is pinned and immovable:
//!
//! - **rate-limit → firewall → route** always run in that relative order,
//! - **firewall is never disableable** (a lower config layer cannot switch off
//!   inbound scanning),
//! - **audit is always last**.
//!
//! [`StageOrder::resolve`] REJECTS any config that violates these (returns
//! [`StageOrderError`]) — attempting to disable the firewall or move audit is a
//! config error, not a silently-ignored request. The default (empty config)
//! reproduces the exact pre-W6d sequence ([`DEFAULT_ORDER`]).

use serde::{Deserialize, Serialize};

/// One stage of the request pre-processing pipeline. The variant set is closed;
/// each maps to one block of [`crate::pipeline::pre_process`].
///
/// [`PipelineStage::Audit`] is the ordering ANCHOR only — it never executes
/// inside `pre_process` (auditing needs the provider response). Its real
/// `audit.log` runs post-provider in [`crate::pipeline::run`] /
/// [`crate::pipeline::run_stream`], which is genuinely last. It is modelled as a
/// pinned terminal stage purely so "audit is always last" is an enforceable,
/// testable invariant rather than an implicit assumption.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PipelineStage {
    /// Per-key request rate limit + burst/bot detection. Pinned first.
    RateLimit,
    /// Inbound regex firewall (block / sanitize / warn). Pinned; never disableable.
    Firewall,
    /// Opt-in LLM traffic inspector (fail-open). Reorderable.
    Inspector,
    /// Unified-evaluator inline INPUT guardrails. Reorderable.
    InlineInput,
    /// Control-plane policy: model allowlist + locked guardrails. Reorderable.
    Policy,
    /// Companion (screen-capture) DLP egress redaction. Reorderable.
    CompanionDlp,
    /// Model routing (Plane A). Pinned; produces the [`crate::router::RouteDecision`].
    Route,
    /// Ordering anchor for the post-provider audit sink (see the type docs).
    /// Pinned last; a no-op inside `pre_process`.
    Audit,
}

impl PipelineStage {
    /// Whether config may reorder or disable this stage. Only the governance
    /// block is reorderable; the rate-limit → firewall → route → audit skeleton
    /// is pinned so the safety-critical ordering constraints hold structurally.
    pub const fn reorderable(self) -> bool {
        matches!(
            self,
            Self::Inspector | Self::InlineInput | Self::Policy | Self::CompanionDlp
        )
    }

    /// Stable kebab-case id (matches the serde representation) for diagnostics.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::RateLimit => "rate-limit",
            Self::Firewall => "firewall",
            Self::Inspector => "inspector",
            Self::InlineInput => "inline-input",
            Self::Policy => "policy",
            Self::CompanionDlp => "companion-dlp",
            Self::Route => "route",
            Self::Audit => "audit",
        }
    }
}

/// The canonical, immutable default order — the exact sequence `pre_process` ran
/// as hardcoded numbered steps before W6d. An empty [`PipelineOrderConfig`]
/// resolves to this, so an absent `[pipeline]` table is byte-for-byte today's
/// behavior.
pub const DEFAULT_ORDER: [PipelineStage; 8] = [
    PipelineStage::RateLimit,
    PipelineStage::Firewall,
    PipelineStage::Inspector,
    PipelineStage::InlineInput,
    PipelineStage::Policy,
    PipelineStage::CompanionDlp,
    PipelineStage::Route,
    PipelineStage::Audit,
];

/// The reorderable governance block, in default order. Config reorders/disables
/// within this set; the pinned skeleton wraps it as
/// `[RateLimit, Firewall, <block>, Route, Audit]`.
const DEFAULT_REORDERABLE: [PipelineStage; 4] = [
    PipelineStage::Inspector,
    PipelineStage::InlineInput,
    PipelineStage::Policy,
    PipelineStage::CompanionDlp,
];

/// Operator-facing pipeline order override (W6d). Mirrors the
/// [`crate::config::StageBackendsConfig`] precedent: `#[serde(default)]` +
/// skip-when-empty, so an absent `[pipeline]` table is identical to today. Both
/// fields default empty ⇒ [`DEFAULT_ORDER`].
///
/// Applied at `AppState` build (a startup snapshot, like the router model map),
/// fail-closed: a config that violates a safety invariant refuses startup rather
/// than silently degrading.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PipelineOrderConfig {
    /// Explicit execution order for the ENABLED reorderable governance stages.
    /// When non-empty it is the complete ordered set of enabled reorderable
    /// stages — a reorderable stage omitted here is disabled. Listing a pinned
    /// stage (rate-limit / firewall / route / audit) is a config error.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub order: Vec<PipelineStage>,
    /// Reorderable stages to disable (used when `order` is empty to drop a stage
    /// from the default sequence). Listing a pinned stage is a config error.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled: Vec<PipelineStage>,
}

/// Why a [`PipelineOrderConfig`] was rejected. Each variant is a distinct,
/// testable safety violation; [`StageOrder::resolve`] fails closed on the first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageOrderError {
    /// `order` names a pinned stage (rate-limit / firewall / route / audit) —
    /// only reorderable stages may be positioned by config. This is how
    /// "attempting to move audit / rate-limit / route = rejected" is enforced.
    NotReorderable(PipelineStage),
    /// `disabled` names a pinned stage — the firewall (and the rest of the
    /// skeleton) cannot be switched off. This enforces "firewall not disableable".
    CannotDisable(PipelineStage),
    /// A stage appears twice in `order` or `disabled`.
    Duplicate(PipelineStage),
    /// A stage is present in both `order` (enabled) and `disabled` — contradictory.
    DisabledAndOrdered(PipelineStage),
}

impl std::fmt::Display for StageOrderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotReorderable(s) => write!(
                f,
                "pipeline stage '{}' is pinned and cannot be reordered by config \
                 (only the governance block is reorderable)",
                s.as_str()
            ),
            Self::CannotDisable(s) => write!(
                f,
                "pipeline stage '{}' is pinned and cannot be disabled \
                 (safety-critical: e.g. the firewall is always on)",
                s.as_str()
            ),
            Self::Duplicate(s) => {
                write!(f, "pipeline stage '{}' listed more than once", s.as_str())
            }
            Self::DisabledAndOrdered(s) => write!(
                f,
                "pipeline stage '{}' is both ordered (enabled) and disabled",
                s.as_str()
            ),
        }
    }
}

impl std::error::Error for StageOrderError {}

/// The resolved, validated stage execution order. Built once at config-apply
/// time and stored on [`crate::state::AppState`]; the request path borrows
/// [`StageOrder::stages`] with no per-request allocation.
#[derive(Debug, Clone)]
pub struct StageOrder {
    stages: Vec<PipelineStage>,
}

impl Default for StageOrder {
    /// [`DEFAULT_ORDER`] — the exact pre-W6d sequence.
    fn default() -> Self {
        Self {
            stages: DEFAULT_ORDER.to_vec(),
        }
    }
}

impl StageOrder {
    /// The ordered, enabled stages. Iterated by `pre_process`; every element is
    /// `Copy`, so iteration allocates nothing.
    pub fn stages(&self) -> &[PipelineStage] {
        &self.stages
    }

    /// Whether an order satisfies the pinned safety invariants: rate-limit before
    /// firewall before route, firewall present, and audit last. The resolved
    /// output of [`Self::resolve`] always satisfies this (the pinned skeleton
    /// guarantees it structurally); exposed so tests can assert it directly.
    pub fn satisfies_invariants(stages: &[PipelineStage]) -> bool {
        let idx = |target: PipelineStage| stages.iter().position(|&s| s == target);
        let (Some(rl), Some(fw), Some(rt)) = (
            idx(PipelineStage::RateLimit),
            idx(PipelineStage::Firewall),
            idx(PipelineStage::Route),
        ) else {
            return false;
        };
        rl < fw && fw < rt && stages.last() == Some(&PipelineStage::Audit)
    }

    /// Resolve a [`PipelineOrderConfig`] into a validated order, or reject it.
    /// Empty config ⇒ [`DEFAULT_ORDER`]. Fails closed on the first safety
    /// violation. This runs at config-apply time, never per request.
    pub fn resolve(cfg: &PipelineOrderConfig) -> Result<Self, StageOrderError> {
        if cfg.order.is_empty() && cfg.disabled.is_empty() {
            return Ok(Self::default());
        }

        // `disabled` may only name reorderable stages, no duplicates.
        let mut disabled: std::collections::HashSet<PipelineStage> =
            std::collections::HashSet::new();
        for &s in &cfg.disabled {
            if !s.reorderable() {
                return Err(StageOrderError::CannotDisable(s));
            }
            if !disabled.insert(s) {
                return Err(StageOrderError::Duplicate(s));
            }
        }

        // `order` may only name reorderable stages, no duplicates, none disabled.
        let mut ordered: std::collections::HashSet<PipelineStage> =
            std::collections::HashSet::new();
        for &s in &cfg.order {
            if !s.reorderable() {
                return Err(StageOrderError::NotReorderable(s));
            }
            if !ordered.insert(s) {
                return Err(StageOrderError::Duplicate(s));
            }
            if disabled.contains(&s) {
                return Err(StageOrderError::DisabledAndOrdered(s));
            }
        }

        // Build the enabled reorderable sequence. An explicit `order` is the
        // complete enabled set (omitted reorderable stages are dropped); an empty
        // `order` keeps the default block minus `disabled`.
        let reorderable_seq: Vec<PipelineStage> = if cfg.order.is_empty() {
            DEFAULT_REORDERABLE
                .iter()
                .copied()
                .filter(|s| !disabled.contains(s))
                .collect()
        } else {
            cfg.order.clone()
        };

        // Wrap in the pinned safety skeleton.
        let mut stages = Vec::with_capacity(4 + reorderable_seq.len());
        stages.push(PipelineStage::RateLimit);
        stages.push(PipelineStage::Firewall);
        stages.extend(reorderable_seq);
        stages.push(PipelineStage::Route);
        stages.push(PipelineStage::Audit);

        // The skeleton makes this hold structurally; assert it so a future edit to
        // the skeleton that breaks it fails loudly in tests.
        debug_assert!(
            Self::satisfies_invariants(&stages),
            "resolved pipeline order violates a safety invariant: {stages:?}"
        );

        Ok(Self { stages })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve(
        order: &[PipelineStage],
        disabled: &[PipelineStage],
    ) -> Result<StageOrder, StageOrderError> {
        StageOrder::resolve(&PipelineOrderConfig {
            order: order.to_vec(),
            disabled: disabled.to_vec(),
        })
    }

    #[test]
    fn default_order_preserved() {
        // Empty config reproduces the exact pre-W6d sequence.
        let resolved = StageOrder::resolve(&PipelineOrderConfig::default()).unwrap();
        assert_eq!(resolved.stages(), DEFAULT_ORDER);
    }

    #[test]
    fn default_order_satisfies_invariants() {
        assert!(StageOrder::satisfies_invariants(&DEFAULT_ORDER));
    }

    #[test]
    fn firewall_not_disableable() {
        // Attempting to disable the firewall = config rejected.
        let err = resolve(&[], &[PipelineStage::Firewall]).unwrap_err();
        assert_eq!(err, StageOrderError::CannotDisable(PipelineStage::Firewall));
    }

    #[test]
    fn rate_limit_and_route_not_disableable() {
        assert_eq!(
            resolve(&[], &[PipelineStage::RateLimit]).unwrap_err(),
            StageOrderError::CannotDisable(PipelineStage::RateLimit)
        );
        assert_eq!(
            resolve(&[], &[PipelineStage::Route]).unwrap_err(),
            StageOrderError::CannotDisable(PipelineStage::Route)
        );
    }

    #[test]
    fn audit_cannot_be_moved() {
        // Naming audit in `order` = config rejected (it is pinned last).
        let err = resolve(&[PipelineStage::Audit], &[]).unwrap_err();
        assert_eq!(err, StageOrderError::NotReorderable(PipelineStage::Audit));
    }

    #[test]
    fn pinned_stages_not_reorderable() {
        for pinned in [
            PipelineStage::RateLimit,
            PipelineStage::Firewall,
            PipelineStage::Route,
            PipelineStage::Audit,
        ] {
            assert_eq!(
                resolve(&[pinned], &[]).unwrap_err(),
                StageOrderError::NotReorderable(pinned)
            );
        }
    }

    #[test]
    fn reorderable_stage_can_be_reordered() {
        // Swap the governance block order; the pinned skeleton is preserved and
        // the safety invariants still hold.
        let resolved = resolve(
            &[
                PipelineStage::Policy,
                PipelineStage::Inspector,
                PipelineStage::CompanionDlp,
                PipelineStage::InlineInput,
            ],
            &[],
        )
        .unwrap();
        assert_eq!(
            resolved.stages(),
            [
                PipelineStage::RateLimit,
                PipelineStage::Firewall,
                PipelineStage::Policy,
                PipelineStage::Inspector,
                PipelineStage::CompanionDlp,
                PipelineStage::InlineInput,
                PipelineStage::Route,
                PipelineStage::Audit,
            ]
        );
        assert!(StageOrder::satisfies_invariants(resolved.stages()));
    }

    #[test]
    fn reorderable_stage_can_be_disabled() {
        // Disabling a reorderable stage drops it; the skeleton and invariants hold.
        let resolved = resolve(&[], &[PipelineStage::Inspector]).unwrap();
        assert!(!resolved.stages().contains(&PipelineStage::Inspector));
        assert_eq!(
            resolved.stages(),
            [
                PipelineStage::RateLimit,
                PipelineStage::Firewall,
                PipelineStage::InlineInput,
                PipelineStage::Policy,
                PipelineStage::CompanionDlp,
                PipelineStage::Route,
                PipelineStage::Audit,
            ]
        );
        assert!(StageOrder::satisfies_invariants(resolved.stages()));
    }

    #[test]
    fn explicit_order_disables_omitted_reorderable_stages() {
        // A non-empty `order` is the complete enabled set: omitted reorderable
        // stages (inline-input, companion-dlp) are dropped.
        let resolved = resolve(&[PipelineStage::Policy, PipelineStage::Inspector], &[]).unwrap();
        assert_eq!(
            resolved.stages(),
            [
                PipelineStage::RateLimit,
                PipelineStage::Firewall,
                PipelineStage::Policy,
                PipelineStage::Inspector,
                PipelineStage::Route,
                PipelineStage::Audit,
            ]
        );
    }

    #[test]
    fn duplicate_stage_rejected() {
        assert_eq!(
            resolve(&[PipelineStage::Policy, PipelineStage::Policy], &[]).unwrap_err(),
            StageOrderError::Duplicate(PipelineStage::Policy)
        );
    }

    #[test]
    fn stage_ordered_and_disabled_rejected() {
        assert_eq!(
            resolve(&[PipelineStage::Policy], &[PipelineStage::Policy]).unwrap_err(),
            StageOrderError::DisabledAndOrdered(PipelineStage::Policy)
        );
    }

    #[test]
    fn any_valid_reordering_keeps_invariants() {
        // Every reorderable permutation still satisfies the pinned invariants.
        let block = DEFAULT_REORDERABLE;
        let perms = [
            [block[0], block[1], block[2], block[3]],
            [block[3], block[2], block[1], block[0]],
            [block[1], block[3], block[0], block[2]],
        ];
        for p in perms {
            let resolved = resolve(&p, &[]).unwrap();
            assert!(StageOrder::satisfies_invariants(resolved.stages()));
        }
    }
}
