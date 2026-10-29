//! Ryu's platform floor (managed guardrails spec 02.3): the locked firewall
//! layer applied first, directly on the node base, so org, team, agent and
//! request scopes can only tighten it.
//!
//! The floor arrives on every `/gateway/resolve` answer. The wire contract is
//! documented in `packages/api/src/lib/platform-floor.ts`:
//!
//! ```jsonc
//! "platformFloor": {
//!   "version": 3,
//!   "contentHash": "9f2c...",
//!   "issuedAt": "2026-10-23T09:00:00.000Z",
//!   "overlay": { "enabled": true, "scan_inbound": true, "policy": "block",
//!                "custom_patterns": [...], "locked_fields": [...],
//!                "evaluators": [...] },
//!   "allowedProviders": [],
//!   "allowedModels": [],
//!   "restrictedModels": ["vendor/small-model"]
//! },
//! "platformFloorUnavailable": false
//! ```
//!
//! Where it binds. The floor binds every request on `Fleet` custody, whatever
//! the tenant's `managedInference`. Attempts do not carry a credential origin
//! yet, and on the fleet every credential is Ryu's (vault keys, own-supply
//! slots, the Ryu-held aggregator fallback) or a resolved `rgw_` tenant that
//! still leaves from Ryu's IPs (decision D9), so custody is the stand-in for
//! "floor-bound", the same one `standing` uses for its `floor_bound` refusal.
//! A managed node holds no Ryu keys (it is a client of the fleet, which
//! screens that traffic) and a self-hosted node spends its operator's keys,
//! so neither ever applies the floor.
//!
//! Fail closed. Every resolve advertises the `platform_floor` capability
//! ([`crate::standing::RESOLVE_CAPABILITIES`]), so
//! a control plane that cannot read its floor answers 200 with
//! `platformFloorUnavailable: true` instead of failing the whole resolve. The
//! Gateway keeps the newest valid floor it has seen ([`FloorStore`]) and an
//! unavailable or malformed answer never clears or rolls it back. A fleet
//! Gateway that holds no floor at all refuses every request with a retryable
//! 503 `screening_unavailable` ([`admit`]).
//!
//! All or nothing. A floor the Gateway cannot apply in full is rejected as a
//! whole and the previous one stays: an unknown top-level or overlay key, a
//! custom pattern the scanner would skip, an evaluator binding whose id the
//! built-in catalog does not know or whose evaluator cannot run in the mode
//! it binds (inline or offline), a non-empty provider or model allowlist
//! (not enforced by this Gateway yet), a `restrictedModels` list with an
//! empty, padded or overlong id (the ladder L3 model list, see
//! [`crate::enforcement`]), or a `screener` field that does not
//! parse ([`crate::screening::policy`]) or that this replica cannot apply
//! ([`crate::screening::ScreeningRuntime::validate_floor`], checked before
//! the floor is stored).
//!
//! The `screener` field is top level, beside `overlay`, so no tenant overlay
//! has a path to it: an overlay carrying a `screener` key is an unknown
//! overlay field and rejects the floor.

use std::collections::HashSet;
use std::sync::{Arc, OnceLock, RwLock};

use serde::Deserialize;
use serde_json::Value;
use tracing::warn;

use crate::config::FirewallOverlay;
use crate::custody::GatewayCustody;
use crate::error::GatewayError;
use crate::evaluators::{EvaluatorBinding, EvaluatorRegistry};

/// Seconds a client waits before retrying a floor refusal. Matches the
/// resolve cache's negative TTL.
pub const FLOOR_RETRY_AFTER_SECS: u64 = 10;
/// The `reason` recorded when the fleet holds no floor.
const REASON_UNAVAILABLE: &str = "platform_floor_unavailable";
/// The `reason` recorded when the floor needs a node switch that is off.
const REASON_UNAPPLIED: &str = "platform_floor_not_applied";

/// Top-level keys the wire object may carry. Anything else is a field this
/// Gateway does not know how to apply, so the floor is rejected.
const WIRE_KEYS: &[&str] = &[
    "version",
    "contentHash",
    "issuedAt",
    "overlay",
    "allowedProviders",
    "allowedModels",
    "screener",
    "restrictedModels",
];

/// Overlay keys this Gateway applies (the snake_case [`FirewallOverlay`]).
const OVERLAY_KEYS: &[&str] = &[
    "enabled",
    "scan_inbound",
    "scan_outbound",
    "policy",
    "log_detections",
    "redact_pii",
    "redact_secrets",
    "wrap_untrusted_tool_results",
    "alert",
    "inspector",
    "custom_patterns",
    "locked_fields",
    "evaluators",
];

/// One validated platform floor.
#[derive(Debug, Clone, PartialEq)]
pub struct PlatformFloor {
    /// Strictly increasing; 0 is the control plane's compiled baseline.
    pub version: u64,
    /// For logs only. It hashes the stored document, not this wire shape.
    pub content_hash: String,
    /// The firewall overlay, with its wire `locked_fields` dropped: the
    /// resolver locks every field after applying the floor regardless.
    /// Its evaluator bindings are kept apart in [`Self::evaluators`].
    pub overlay: FirewallOverlay,
    /// Floor evaluator bindings, each forced enabled and locked. Merged
    /// tighten-only against the node base (see
    /// [`crate::firewall::resolve`]).
    pub evaluators: Vec<EvaluatorBinding>,
    /// The hazard screener policy (screener addendum 5.3). `None` means the
    /// compiled baseline screener applies.
    pub screener: Option<Arc<crate::screening::FloorScreener>>,
    /// The models a request at ladder L3 (Restrict) may dispatch, by the id
    /// the routed provider is sent (spec 04.8.1). Empty admits none: a
    /// restricted subject is then refused every chat model.
    pub restricted_models: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FloorWire {
    version: u64,
    #[serde(default)]
    content_hash: String,
    overlay: FirewallOverlay,
    #[serde(default)]
    allowed_providers: Vec<String>,
    #[serde(default)]
    allowed_models: Vec<String>,
    #[serde(default)]
    screener: Option<Value>,
    #[serde(default)]
    restricted_models: Vec<String>,
}

impl PlatformFloor {
    /// Parse the resolve's `platformFloor` and `platformFloorUnavailable`.
    /// `None` means this resolve carried no usable floor: unavailable, absent,
    /// `null`, malformed, or not applicable in full. The caller keeps the
    /// floor it already holds.
    pub fn from_wire(value: Option<&Value>, unavailable: bool) -> Option<Arc<Self>> {
        if unavailable {
            return None;
        }
        let value = value.filter(|value| !value.is_null())?;
        match Self::parse(value) {
            Ok(floor) => Some(Arc::new(floor)),
            Err(reason) => {
                let version = value.get("version").and_then(Value::as_u64);
                warn!(?version, reason, "platform floor: rejected as a whole");
                None
            }
        }
    }

    fn parse(value: &Value) -> Result<Self, &'static str> {
        let object = value.as_object().ok_or("not an object")?;
        if object.keys().any(|key| !WIRE_KEYS.contains(&key.as_str())) {
            return Err("unknown top-level field");
        }
        let overlay_keys = object
            .get("overlay")
            .and_then(Value::as_object)
            .ok_or("overlay is not an object")?;
        if overlay_keys
            .keys()
            .any(|key| !OVERLAY_KEYS.contains(&key.as_str()))
        {
            return Err("unknown overlay field");
        }
        let wire: FloorWire = serde_json::from_value(value.clone()).map_err(|_| "malformed")?;
        if !wire.allowed_providers.is_empty() || !wire.allowed_models.is_empty() {
            // The resolver cannot enforce these, and a partial floor is never
            // applied.
            return Err("provider or model allowlist is not enforced by this gateway");
        }
        for pattern in &wire.overlay.custom_patterns {
            if !crate::firewall::custom_pattern_compiles(pattern) {
                return Err("custom pattern the scanner would skip");
            }
        }
        let mut overlay = wire.overlay;
        overlay.locked_fields.clear();
        let evaluators = overlay
            .evaluators
            .take()
            .unwrap_or_default()
            .into_iter()
            .map(|binding| EvaluatorBinding {
                enabled: true,
                locked: true,
                ..binding
            })
            .collect::<Vec<_>>();
        let mut ids = HashSet::new();
        if evaluators
            .iter()
            .any(|binding| binding.id.is_empty() || !ids.insert(binding.id.clone()))
        {
            return Err("evaluator binding with an empty or repeated id");
        }
        // The floor is one document for every replica, so its bindings are
        // checked against the catalog this binary ships. An id the catalog
        // does not know would be skipped at request time, and one it cannot
        // run in the binding's mode would fail every request.
        let registry = EvaluatorRegistry::new();
        if let Some(binding) = evaluators
            .iter()
            .find(|binding| registry.get(&binding.id).is_none())
        {
            warn!(
                id = binding.id.as_str(),
                "platform floor: unknown evaluator"
            );
            return Err("evaluator binding with an id this gateway does not know");
        }
        if let Err(detail) = registry.validate_bindings(&evaluators) {
            warn!(
                detail = detail.as_str(),
                "platform floor: evaluator binding cannot run"
            );
            return Err("evaluator binding this gateway cannot run");
        }
        if wire.restricted_models.len() > crate::enforcement::MAX_RESTRICTED_MODELS
            || wire.restricted_models.iter().any(|model| {
                model.is_empty()
                    || model.len() > 256
                    || model.trim() != model
                    || model.chars().any(char::is_control)
            })
        {
            return Err("restricted model list is malformed");
        }
        let screener = match wire.screener.as_ref().filter(|value| !value.is_null()) {
            None => None,
            Some(value) => {
                let screener =
                    crate::screening::FloorScreener::parse(value).inspect_err(|reason| {
                        warn!(reason, "platform floor: screener field rejected");
                    })?;
                Some(Arc::new(screener))
            }
        };
        Ok(Self {
            version: wire.version,
            content_hash: wire.content_hash,
            overlay,
            evaluators,
            screener,
            restricted_models: wire.restricted_models,
        })
    }

    /// The control plane's version 0 baseline, compiled in. Used only when
    /// a fleet request reaches the scanner with no stored floor (a master
    /// key request, which [`admit`] lets through so an operator can reach
    /// admin routes during a floor outage), so the scanner never runs with
    /// no floor at all on the fleet.
    pub fn compiled_baseline() -> Arc<Self> {
        static BASELINE: OnceLock<Arc<PlatformFloor>> = OnceLock::new();
        Arc::clone(BASELINE.get_or_init(|| {
            Arc::new(Self {
                version: 0,
                content_hash: String::new(),
                overlay: FirewallOverlay {
                    enabled: Some(true),
                    scan_inbound: Some(true),
                    scan_outbound: Some(true),
                    redact_secrets: Some(true),
                    ..FirewallOverlay::default()
                },
                evaluators: Vec::new(),
                screener: None,
                restricted_models: Vec::new(),
            })
        }))
    }

    /// A floor that sets no dial. It still locks every field at the node's
    /// value, so a fleet test can keep its node firewall off to reach a path
    /// behind it (for example a locked-guardrail refusal).
    #[cfg(test)]
    pub fn setting_nothing() -> Arc<Self> {
        Arc::new(Self {
            version: 1,
            content_hash: String::new(),
            overlay: FirewallOverlay::default(),
            evaluators: Vec::new(),
            screener: None,
            restricted_models: Vec::new(),
        })
    }

    /// Whether this floor turns on the node-only untrusted tool result
    /// wrap, which only the node base can set.
    fn requires_untrusted_wrap(&self) -> bool {
        self.overlay.wrap_untrusted_tool_results == Some(true)
    }
}

/// The newest valid floor this process has seen. One per process: the floor
/// is global, so every tenant's resolve carries the same document.
#[derive(Debug, Default)]
pub struct FloorStore {
    current: RwLock<Option<Arc<PlatformFloor>>>,
}

impl FloorStore {
    /// A store already holding `floor`.
    #[cfg(test)]
    pub fn with(floor: Arc<PlatformFloor>) -> Self {
        Self {
            current: RwLock::new(Some(floor)),
        }
    }

    /// The floor to apply, or `None` when none was ever received.
    pub fn current(&self) -> Option<Arc<PlatformFloor>> {
        self.current
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Record the floor a resolve carried. Only a strictly newer version
    /// replaces the stored one, so an older cached resolve never rolls the
    /// floor back and a resolve with no usable floor never clears it.
    /// Returns whether the stored floor changed.
    pub fn observe(&self, floor: Option<&Arc<PlatformFloor>>) -> bool {
        let Some(floor) = floor else {
            return false;
        };
        let mut guard = self
            .current
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard
            .as_ref()
            .is_some_and(|current| current.version >= floor.version)
        {
            return false;
        }
        tracing::info!(
            version = floor.version,
            content_hash = floor.content_hash.as_str(),
            "platform floor: applied"
        );
        *guard = Some(Arc::clone(floor));
        true
    }

    /// Drop the stored floor, so a test can start from a fleet that never
    /// received one.
    #[cfg(test)]
    pub fn clear(&self) {
        *self
            .current
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
}

/// The floor the resolver applies for a request on `custody`, or `None` when
/// the floor does not bind there. On the fleet this is never `None`: with no
/// stored floor the compiled baseline stands in (only a request [`admit`]
/// let through can get that far).
pub fn binding_floor(custody: GatewayCustody, store: &FloorStore) -> Option<Arc<PlatformFloor>> {
    if !custody.is_fleet() {
        return None;
    }
    Some(
        store
            .current()
            .unwrap_or_else(PlatformFloor::compiled_baseline),
    )
}

/// Refuse a fleet request when no floor can be applied to it: none was ever
/// received, or it needs the node's untrusted tool result wrap and that is
/// off. A retryable 503 `screening_unavailable`, never a silent pass.
///
/// The master key is exempt so an operator can still reach admin routes
/// during a floor outage; its requests are screened with the compiled
/// baseline then ([`binding_floor`]). Other custodies never apply the floor.
pub fn admit(
    custody: GatewayCustody,
    store: &FloorStore,
    is_master_key: bool,
) -> Result<(), GatewayError> {
    if !custody.is_fleet() || is_master_key {
        return Ok(());
    }
    let Some(floor) = store.current() else {
        return Err(GatewayError::ScreeningUnavailable {
            reason: REASON_UNAVAILABLE,
            retry_after_secs: FLOOR_RETRY_AFTER_SECS,
        });
    };
    if floor.requires_untrusted_wrap() && !crate::untrusted::is_enabled() {
        return Err(GatewayError::ScreeningUnavailable {
            reason: REASON_UNAPPLIED,
            retry_after_secs: FLOOR_RETRY_AFTER_SECS,
        });
    }
    Ok(())
}

#[cfg(test)]
#[path = "platform_floor_tests.rs"]
mod tests;
