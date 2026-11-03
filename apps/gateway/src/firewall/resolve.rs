//! Hierarchical firewall/DLP policy resolution (node → org → agent cascade).
//!
//! The gateway's single process-global firewall becomes a **three-level
//! cascade** resolved per request:
//!
//! ```text
//! node  (base)   gateway-local config.firewall — the box admin's baseline
//!   ▼
//! floor          Ryu's platform floor, hosted fleet only (`platform_floor`)
//!   ▼
//! org   (mid)    control-plane bundle (hosted) OR gateway-local store (standalone)
//!   ▼
//! agent (leaf)   per-agent overlay, keyed by x-ryu-agent-id
//! ```
//!
//! Resolution rules ([`FirewallResolver::resolve`]):
//! 1. Start from the node base [`FirewallConfig`] (all fields set).
//! 2. Apply the org [`FirewallOverlay`]: every `Some` scalar overrides,
//!    `custom_patterns` **union** (append).
//! 3. Apply the agent overlay the same way.
//! 4. `locked_fields` **union upward**: a field locked at any *broader* scope
//!    cannot be loosened by a narrower one — on conflict the *stricter* value
//!    wins. A narrower scope may still *tighten* a locked field. "Stricter" is
//!    per-field but always one idea (more protection / more notification):
//!    `true` for a bool, higher severity for `policy`, more inspection for
//!    `inspector`, the louder tier for `alert`.
//!
//! A [`FirewallScanner`] cache keyed by a stable hash of the resolved config lets
//! identical policies share one compiled scanner (no per-request regex compile).
//! Any config/overlay write invalidates the **whole** cache. Every lock recovers
//! from poisoning to a safe default, matching `AppState::with_firewall`.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, RwLock};

use tracing::warn;

use crate::config::{
    AlertTier, FirewallConfig, FirewallOverlay, FirewallPolicy, InspectorConfig, InspectorMode,
};
use crate::evaluators::EvaluatorBinding;
use crate::firewall::FirewallScanner;

/// The one field an org/agent overlay may neither set nor lock: it is a
/// process-global flag written ONLY by the node-base [`FirewallScanner::new`],
/// and the tool loop reads that global — never the resolved per-scope config —
/// so a per-scope override would be a silent no-op (hierarchical-policy spec §10,
/// FIX 2). [`normalize_overlay`] strips it from every org/agent overlay.
const NODE_ONLY_WRAP_FIELD: &str = "wrap_untrusted_tool_results";

/// Every field name [`apply_overlay`] consults its `locked` set for. Passed as
/// the whole lock set when applying the REQUEST scope, which is what makes that
/// scope additive-only by construction rather than by review — see
/// [`FirewallResolver::resolve_with_request`]. Kept next to `apply_overlay` in
/// spirit: adding a lockable dial there means adding it here, or the new dial
/// silently becomes loosenable from a request header.
const ALL_LOCKABLE_FIELDS: &[&str] = &[
    "enabled",
    "scan_inbound",
    "scan_outbound",
    "log_detections",
    "redact_pii",
    "redact_secrets",
    "wrap_untrusted_tool_results",
    "policy",
    "alert",
    "inspector",
];

/// The org + per-agent firewall overlays a hosted control plane cascades and
/// hands the gateway on a resolved request (see `policy::EffectivePolicy`). The
/// gateway does NOT re-cascade the org side — it only adds the node base (below)
/// and the agent leaf. `None`/empty ⇒ the standalone path, which reads overlays
/// from the resolver's local store instead.
#[derive(Debug, Clone, Default)]
pub struct PolicyBundle {
    /// Ryu's platform floor (spec 02.3), set only where it binds (fleet
    /// custody). Applied first, directly on the node base and tighten-only
    /// against it, and then every lockable field is locked, so the org, team,
    /// agent and request scopes can only tighten what the floor and the node
    /// set. Its evaluator bindings merge tighten-only by id
    /// ([`merge_floor_bindings`]) and its inspector model stays pinned.
    pub platform_floor: Option<Arc<crate::platform_floor::PlatformFloor>>,
    /// The org-effective firewall overlay (already cascaded by the control plane).
    pub firewall: Option<FirewallOverlay>,
    /// The node's team overlay, when the node runs for a team. Applied after the
    /// org overlay as tighten-only (every field treated as locked), because a
    /// team may be administered below the organization and must never loosen
    /// what the node or the organization set.
    pub team_firewall: Option<FirewallOverlay>,
    /// Per-agent overlays for this org, keyed by agent id.
    pub agent_overlays: HashMap<String, FirewallOverlay>,
}

impl PolicyBundle {
    /// Whether this bundle carries any overlay data at all. An empty bundle lets
    /// the resolver fall back to its local (standalone) overlay store.
    pub fn is_empty(&self) -> bool {
        self.platform_floor.is_none()
            && self.firewall.is_none()
            && self.team_firewall.is_none()
            && self.agent_overlays.is_empty()
    }
}

/// Holds the node base config, the standalone-local org/agent overlay stores, and
/// a compiled-scanner cache. All behind `RwLock`s with poison recovery.
pub struct FirewallResolver {
    node_base: RwLock<FirewallConfig>,
    /// Standalone-desktop org overlays (authored via `PUT /v1/config`), keyed by
    /// org id. Ignored for a request that carries a hosted [`PolicyBundle`].
    org_overlays: RwLock<HashMap<String, FirewallOverlay>>,
    /// Standalone-desktop agent overlays, keyed by agent id.
    agent_overlays: RwLock<HashMap<String, FirewallOverlay>>,
    /// Resolved-config-hash → (config, compiled scanner). The stored config lets
    /// `scanner_for` verify equality on a key hit so a 64-bit hash collision
    /// serves a rebuild, never the WRONG scanner (FIX 3). Whole-cache
    /// invalidation on any write (never per-entry) keeps invalidation trivially
    /// correct.
    scanner_cache: RwLock<HashMap<u64, (FirewallConfig, Arc<FirewallScanner>)>>,
}

impl FirewallResolver {
    /// Build a resolver from the node base firewall config, with empty local
    /// overlay stores and an empty scanner cache.
    pub fn new(node_base: FirewallConfig) -> Self {
        Self {
            node_base: RwLock::new(node_base),
            org_overlays: RwLock::new(HashMap::new()),
            agent_overlays: RwLock::new(HashMap::new()),
            scanner_cache: RwLock::new(HashMap::new()),
        }
    }

    /// Seed the standalone org/agent overlay stores from persisted config at
    /// startup (FIX 4). Overlays authored via `PUT /v1/config` round-trip through
    /// `gateway.toml` (`GatewayConfig::firewall_{org,agent}_overlays`), so on
    /// restart the resolver reloads them here instead of starting empty. Each
    /// overlay is re-normalized so a hand-edited `gateway.toml` can never
    /// reintroduce the node-only wrap field (FIX 2, defense in depth). No scanner
    /// cache exists yet at construction time, so there is nothing to invalidate.
    pub fn seed_overlays(
        &self,
        org: &HashMap<String, FirewallOverlay>,
        agent: &HashMap<String, FirewallOverlay>,
    ) {
        if let Ok(mut g) = self.org_overlays.write() {
            *g = org
                .iter()
                .map(|(k, v)| (k.clone(), normalize_overlay(v)))
                .collect();
        }
        if let Ok(mut g) = self.agent_overlays.write() {
            *g = agent
                .iter()
                .map(|(k, v)| (k.clone(), normalize_overlay(v)))
                .collect();
        }
    }

    /// Snapshot the node base config (poison-safe; falls back to default).
    pub fn node_base(&self) -> FirewallConfig {
        self.node_base.read().map(|g| g.clone()).unwrap_or_default()
    }

    /// Replace the node base config (called by `PUT /v1/config`). Invalidates the
    /// whole scanner cache since every resolved config inherits from the base.
    pub fn set_node_base(&self, cfg: FirewallConfig) {
        if let Ok(mut g) = self.node_base.write() {
            *g = cfg;
        }
        self.invalidate_cache();
    }

    /// Snapshot the local (standalone) org overlay store.
    pub fn org_overlays(&self) -> HashMap<String, FirewallOverlay> {
        self.org_overlays
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Snapshot the local (standalone) agent overlay store.
    pub fn agent_overlays(&self) -> HashMap<String, FirewallOverlay> {
        self.agent_overlays
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    /// Author/replace a standalone org overlay. Invalidates the scanner cache.
    /// (Part of the standalone-desktop overlay-CRUD surface consumed by the
    /// gateway config API, §6.)
    #[allow(dead_code)]
    pub fn set_org_overlay(&self, org_id: String, overlay: FirewallOverlay) {
        if let Ok(mut g) = self.org_overlays.write() {
            g.insert(org_id, overlay);
        }
        self.invalidate_cache();
    }

    /// Author/replace a standalone agent overlay. Invalidates the scanner cache.
    /// (Standalone-desktop overlay-CRUD surface for the gateway config API, §6.)
    #[allow(dead_code)]
    pub fn set_agent_overlay(&self, agent_id: String, overlay: FirewallOverlay) {
        if let Ok(mut g) = self.agent_overlays.write() {
            g.insert(agent_id, overlay);
        }
        self.invalidate_cache();
    }

    /// Remove a standalone org overlay. Invalidates the scanner cache.
    #[allow(dead_code)]
    pub fn remove_org_overlay(&self, org_id: &str) {
        if let Ok(mut g) = self.org_overlays.write() {
            g.remove(org_id);
        }
        self.invalidate_cache();
    }

    /// Remove a standalone agent overlay. Invalidates the scanner cache.
    #[allow(dead_code)]
    pub fn remove_agent_overlay(&self, agent_id: &str) {
        if let Ok(mut g) = self.agent_overlays.write() {
            g.remove(agent_id);
        }
        self.invalidate_cache();
    }

    /// Drop every cached scanner. Called on any config/overlay write.
    pub fn invalidate_cache(&self) {
        if let Ok(mut cache) = self.scanner_cache.write() {
            cache.clear();
        }
    }
}

mod merge;
mod scoped;
pub use merge::*;

#[cfg(test)]
mod evaluator_tests;
#[cfg(test)]
mod merge_tests;
#[cfg(test)]
mod scoped_tests;
#[cfg(test)]
mod tests;
