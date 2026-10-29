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

    /// Resolve the effective [`FirewallConfig`] for a request. `bundle` carries
    /// the hosted control-plane org/agent overlays; when it is `None`/empty the
    /// standalone-local overlay stores are consulted instead.
    pub fn resolve(
        &self,
        org_id: Option<&str>,
        agent_id: Option<&str>,
        bundle: Option<&PolicyBundle>,
    ) -> FirewallConfig {
        self.resolve_with_request(org_id, agent_id, bundle, None)
    }

    /// [`Self::resolve`] plus a fourth, narrowest **request** scope: the node's
    /// own extra firewall rules, arriving per request on `x-ryu-node-routing`
    /// (already clamped by `pipeline::node_routing::clamp_firewall`).
    ///
    /// The additive-only rule is enforced MECHANICALLY, not by review: the
    /// request overlay is applied with `locked` containing EVERY field name, so
    /// every scalar goes through the same `stricter_policy` / `louder_alert` /
    /// `stricter_inspector` / locked-`apply_bool` paths a narrower scope already
    /// faces for an admin-locked field. Loosening is therefore structurally
    /// impossible rather than merely unintended — a request overlay cannot
    /// disable a node-enabled firewall, cannot downgrade Block to Warn, and
    /// cannot quiet an alert tier. `custom_patterns` append, as they do at every
    /// other scope: that is the whole point of the knob.
    ///
    /// The request scope contributes NO locks (its `locked_fields` was cleared
    /// upstream): it is the leaf, so a lock there would freeze nothing while
    /// still perturbing the cache key.
    pub fn resolve_with_request(
        &self,
        org_id: Option<&str>,
        agent_id: Option<&str>,
        bundle: Option<&PolicyBundle>,
        request_overlay: Option<&FirewallOverlay>,
    ) -> FirewallConfig {
        let mut resolved = self.node_base();
        // Locks accumulate from broader scopes; an overlay's own locks apply only
        // to scopes narrower than it, so we grow the set AFTER applying each.
        let mut locked: HashSet<String> = resolved.locked_fields.iter().cloned().collect();

        // ── platform floor (fleet only): tighten-only, then everything locked ──
        // Applied under every field locked, so the floor itself can only raise
        // the node base, never lower it. Then every lockable field is locked
        // for the narrower scopes whatever the floor's wire `locked_fields`
        // says, so no tenant overlay can loosen a dial the floor or the node
        // set. Evaluator bindings merge tighten-only by id, not through the
        // overlay merge, whose unlocked-base branch would let the floor replace
        // a node binding with a weaker one.
        let platform_floor = bundle.and_then(|b| b.platform_floor.as_deref());
        if let Some(floor) = platform_floor {
            let mut ov = normalize_overlay(&floor.overlay);
            ov.evaluators = None;
            ov.locked_fields.clear();
            apply_overlay(&mut resolved, &ov, &all_lockable_fields());
            resolved.evaluators = merge_floor_bindings(&resolved.evaluators, &floor.evaluators);
            locked.extend(all_lockable_fields());
        }

        // ── org scope: hosted bundle wins; else the standalone-local store ──────
        // Normalize before use (FIX 2): strip the node-only wrap field/lock so a
        // hosted bundle overlay can never leak it into the value OR the lock union
        // (which would otherwise poison the cache key). Standalone overlays are
        // already normalized at author time, so this only fires for hosted ones.
        let org_overlay = bundle
            .and_then(|b| b.firewall.clone())
            .or_else(|| org_id.and_then(|id| self.org_overlays().get(id).cloned()))
            .map(|ov| normalize_overlay(&ov));
        if let Some(ov) = &org_overlay {
            apply_overlay(&mut resolved, ov, &locked);
            for f in &ov.locked_fields {
                locked.insert(f.clone());
            }
        }

        // ── team scope (hosted only): tighten-only, like the request scope ──────
        // Applied under EVERY field locked, so a team can enable protections,
        // raise severity, add patterns, and add locks, but never loosen the node
        // base or the org overlay. Its locks then bind the agent leaf.
        if let Some(ov) = bundle.and_then(|b| b.team_firewall.as_ref()) {
            let ov = normalize_overlay(ov);
            apply_overlay(&mut resolved, &ov, &all_lockable_fields());
            for f in &ov.locked_fields {
                locked.insert(f.clone());
            }
        }

        // ── agent scope (leaf): hosted bundle wins; else standalone-local ───────
        let agent_overlay = bundle
            .and_then(|b| agent_id.and_then(|id| b.agent_overlays.get(id).cloned()))
            .or_else(|| agent_id.and_then(|id| self.agent_overlays().get(id).cloned()))
            .map(|ov| normalize_overlay(&ov));
        if let Some(ov) = &agent_overlay {
            apply_overlay(&mut resolved, ov, &locked);
            for f in &ov.locked_fields {
                locked.insert(f.clone());
            }
        }

        // ── request scope (new leaf): additive only, by construction ───────────
        // Normalized here too (defense in depth — the clamp already did it), and
        // applied under EVERY field locked so no dial can be loosened. Its own
        // locks are not unioned in: a leaf lock binds nothing.
        if let Some(ov) = request_overlay {
            let ov = normalize_overlay(ov);
            apply_overlay(&mut resolved, &ov, &all_lockable_fields());
        }

        // The floor's inspector model is a floor choice, not a selection a
        // narrower scope may swap (the locked-inspector merge otherwise takes
        // the incoming model), so it is restored after every scope.
        if let Some(inspector) = platform_floor.and_then(|floor| floor.overlay.inspector.as_ref()) {
            resolved.inspector.model = inspector.model.clone();
        }

        // Finalize the union of locks. Sort so a stable serialization → a stable
        // cache-key hash (a HashSet's iteration order is nondeterministic and
        // would defeat scanner deduplication).
        let mut all_locked: Vec<String> = locked.into_iter().collect();
        all_locked.sort();
        resolved.locked_fields = all_locked;
        resolved
    }

    /// Resolve the config for a request and return a cached compiled scanner,
    /// building (and caching) one on a miss. Identical resolved configs share a
    /// single scanner. Recovers from a poisoned cache lock by building a fresh,
    /// uncached scanner (matching `with_firewall`'s fail-open discipline).
    /// Kept as the three-scope shape (and used by this module's tests) even
    /// though the pipeline now goes through [`Self::scanner_for_request`]: it is
    /// the honest signature for "resolve the cascade, no per-request input", and
    /// collapsing it into the four-arg form would push a `None` into every caller
    /// for no gain.
    #[allow(dead_code)]
    pub fn scanner_for(
        &self,
        org_id: Option<&str>,
        agent_id: Option<&str>,
        bundle: Option<&PolicyBundle>,
    ) -> Arc<FirewallScanner> {
        self.scanner_for_request(org_id, agent_id, bundle, None)
    }

    /// [`Self::scanner_for`] with the per-request overlay scope
    /// ([`Self::resolve_with_request`]).
    ///
    /// An overlay-bearing resolution is built fresh and **never cached**. That is
    /// the whole mitigation for the growth vector this scope opens: the cache is
    /// keyed by resolved-config hash and invalidated only wholesale, so one
    /// `rgw_` bearer rotating `custom_patterns` per request would otherwise grow
    /// it without bound. A capacity cap plus an eviction policy would work too,
    /// but not caching at all needs no eviction semantics and keeps this file's
    /// "whole-cache invalidation is trivially correct" posture intact.
    ///
    /// The cost is honestly stated: this rebuilds the WHOLE scanner, curated
    /// pattern sets included, not just the request's own few patterns — the
    /// curated sets dominate. That is paid only by requests that actually send a
    /// firewall overlay (a `None` here takes the cached path unchanged), so it is
    /// opt-in per request rather than a tax on the hot path. If overlay-bearing
    /// traffic ever stops being rare, the fix is a bounded LRU here, not a return
    /// to unbounded caching.
    pub fn scanner_for_request(
        &self,
        org_id: Option<&str>,
        agent_id: Option<&str>,
        bundle: Option<&PolicyBundle>,
        request_overlay: Option<&FirewallOverlay>,
    ) -> Arc<FirewallScanner> {
        if request_overlay.is_some() {
            let cfg = self.resolve_with_request(org_id, agent_id, bundle, request_overlay);
            return Arc::new(FirewallScanner::new_scoped(cfg));
        }
        let cfg = self.resolve(org_id, agent_id, bundle);
        let key = config_hash(&cfg);

        // Fast path: a shared read. Verify the stored config equals the freshly
        // resolved one — a 64-bit hash collision must NOT serve another config's
        // scanner (FIX 3).
        if let Ok(cache) = self.scanner_cache.read() {
            if let Some((stored_cfg, scanner)) = cache.get(&key) {
                if *stored_cfg == cfg {
                    return Arc::clone(scanner);
                }
            }
        }

        // Miss (or collision): build once (scoped — never touches the
        // process-global wrap flag) and insert. Re-check under the write lock so
        // two concurrent misses converge on one scanner; on a genuine collision
        // (same key, different config) the new entry overwrites the old — safe,
        // because reads always re-verify config equality above.
        let scanner = Arc::new(FirewallScanner::new_scoped(cfg.clone()));
        match self.scanner_cache.write() {
            Ok(mut cache) => match cache.entry(key) {
                Entry::Occupied(e) if e.get().0 == cfg => Arc::clone(&e.get().1),
                Entry::Occupied(mut e) => {
                    e.insert((cfg, Arc::clone(&scanner)));
                    scanner
                }
                Entry::Vacant(e) => {
                    e.insert((cfg, Arc::clone(&scanner)));
                    scanner
                }
            },
            Err(_) => scanner,
        }
    }
}

/// Apply one overlay onto the accumulating resolved config. `locked` is the set
/// of fields frozen by *broader* scopes: a locked field takes the stricter of
/// (current, incoming); an unlocked field is overridden by `Some(incoming)`.
/// `None` fields inherit. `custom_patterns` always append.
fn apply_overlay(cfg: &mut FirewallConfig, ov: &FirewallOverlay, locked: &HashSet<String>) {
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
fn stricter_optional_policy(
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
fn merge_evaluator_bindings(
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
fn all_lockable_fields() -> HashSet<String> {
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
fn merge_floor_bindings(
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
fn merge_one_binding(base: &EvaluatorBinding, overlay: &EvaluatorBinding) -> EvaluatorBinding {
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
fn apply_bool(target: &mut bool, incoming: Option<bool>, field: &str, locked: &HashSet<String>) {
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
fn policy_severity(p: &FirewallPolicy) -> u8 {
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
fn louder_alert(current: AlertTier, incoming: AlertTier) -> AlertTier {
    current.max(incoming)
}

/// The stricter of two policies for a locked `policy` field.
fn stricter_policy(current: &FirewallPolicy, incoming: &FirewallPolicy) -> FirewallPolicy {
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
fn stricter_inspector(current: &InspectorConfig, incoming: &InspectorConfig) -> InspectorConfig {
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
fn config_hash(cfg: &FirewallConfig) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    match serde_json::to_string(cfg) {
        Ok(s) => s.hash(&mut hasher),
        Err(_) => format!("{cfg:?}").hash(&mut hasher),
    }
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{CustomPattern, CustomPatternKind, FirewallPolicy, InspectorMode};

    fn base() -> FirewallConfig {
        FirewallConfig::default()
    }

    /// A node base with the default lock set removed, for tests exercising
    /// unlocked-field precedence (default inbound and egress protection locks
    /// otherwise prevent narrower scopes from disabling these fields).
    fn unlocked_base() -> FirewallConfig {
        FirewallConfig {
            locked_fields: Vec::new(),
            ..FirewallConfig::default()
        }
    }

    // ── request scope (`x-ryu-node-routing`): additive only ──────────────────
    //
    // The request scope is the one scope fed by an untrusted bearer, so these
    // assert the mechanism (locked = every field), not just the outcome. An
    // `unlocked_base` is used deliberately: it strips the DEFAULT locks, so a
    // pass here proves the request-scope lock set is doing the work rather than
    // the node's own default locks masking a loosening bug.

    #[test]
    fn a_request_overlay_cannot_disable_a_node_enabled_firewall() {
        let r = FirewallResolver::new(unlocked_base());
        let ov = FirewallOverlay {
            enabled: Some(false),
            scan_inbound: Some(false),
            redact_pii: Some(false),
            ..Default::default()
        };
        let cfg = r.resolve_with_request(None, None, None, Some(&ov));
        assert!(cfg.enabled, "a request must not switch the firewall off");
        assert!(cfg.scan_inbound, "nor stop inbound scanning");
        assert!(cfg.redact_pii, "nor turn redaction off");
    }

    #[test]
    fn a_request_overlay_cannot_downgrade_block_to_warn() {
        let r = FirewallResolver::new(unlocked_base());
        let ov = FirewallOverlay {
            policy: Some(FirewallPolicy::WarnAndContinue),
            alert: Some(crate::config::AlertTier::Silent),
            ..Default::default()
        };
        let cfg = r.resolve_with_request(None, None, None, Some(&ov));
        assert_eq!(cfg.policy, FirewallPolicy::Block);
        assert_eq!(cfg.alert, unlocked_base().alert, "nor quiet the alert tier");
    }

    #[test]
    fn a_request_overlay_may_still_tighten() {
        // Additive-only is not read-only: narrowing is the point of the knob.
        let mut node = unlocked_base();
        node.policy = FirewallPolicy::WarnAndContinue;
        node.redact_secrets = false;
        let r = FirewallResolver::new(node);
        let ov = FirewallOverlay {
            policy: Some(FirewallPolicy::Block),
            redact_secrets: Some(true),
            ..Default::default()
        };
        let cfg = r.resolve_with_request(None, None, None, Some(&ov));
        assert_eq!(cfg.policy, FirewallPolicy::Block);
        assert!(cfg.redact_secrets);
    }

    #[test]
    fn a_request_overlay_appends_custom_patterns() {
        let r = FirewallResolver::new(unlocked_base());
        let ov = FirewallOverlay {
            custom_patterns: vec![CustomPattern {
                name: "acme_internal_id".into(),
                regex: r"ACME-\d{6}".into(),
                kind: CustomPatternKind::Pii,
            }],
            ..Default::default()
        };
        let cfg = r.resolve_with_request(None, None, None, Some(&ov));
        assert_eq!(cfg.custom_patterns.len(), 1);
        assert_eq!(cfg.custom_patterns[0].name, "acme_internal_id");
    }

    #[test]
    fn a_request_overlay_contributes_no_locks_to_the_resolved_config() {
        // Request scope is the leaf: a lock there binds nothing, and would only
        // perturb the cache key. (The clamp clears `locked_fields` upstream; this
        // asserts the resolver does not re-introduce them either.)
        let r = FirewallResolver::new(unlocked_base());
        let ov = FirewallOverlay {
            redact_pii: Some(true),
            locked_fields: vec!["redact_pii".into()],
            ..Default::default()
        };
        let cfg = r.resolve_with_request(None, None, None, Some(&ov));
        assert!(cfg.locked_fields.is_empty());
    }

    #[test]
    fn overlay_bearing_resolutions_never_enter_the_scanner_cache() {
        // The growth bound. `scanner_cache` is keyed by resolved-config hash and
        // invalidated only wholesale, so caching client-supplied patterns would
        // let one bearer grow it without limit by rotating them per request.
        let r = FirewallResolver::new(unlocked_base());
        let cached_before = r.scanner_cache.read().expect("cache lock").len();

        for i in 0..64 {
            let ov = FirewallOverlay {
                custom_patterns: vec![CustomPattern {
                    name: format!("p{i}"),
                    regex: format!("token-{i}"),
                    kind: CustomPatternKind::Secret,
                }],
                ..Default::default()
            };
            let _ = r.scanner_for_request(None, None, None, Some(&ov));
        }

        assert_eq!(
            r.scanner_cache.read().expect("cache lock").len(),
            cached_before,
            "64 distinct request overlays must not add 64 cache entries"
        );
    }

    #[test]
    fn no_request_overlay_still_shares_the_cached_scanner() {
        // The uncached branch must not cost the common path its dedup.
        let r = FirewallResolver::new(base());
        let s1 = r.scanner_for_request(None, None, None, None);
        let s2 = r.scanner_for_request(None, None, None, None);
        assert!(Arc::ptr_eq(&s1, &s2));
    }

    #[test]
    fn node_only_resolves_to_base() {
        let r = FirewallResolver::new(base());
        let cfg = r.resolve(None, None, None);
        assert!(cfg.enabled);
        assert_eq!(cfg.policy, FirewallPolicy::Block);
        assert!(cfg.custom_patterns.is_empty());
        // The default lock set survives resolution (already sorted).
        assert_eq!(
            cfg.locked_fields,
            vec![
                "enabled",
                "policy",
                "redact_pii",
                "redact_secrets",
                "scan_inbound",
                "scan_outbound"
            ]
        );
    }

    #[test]
    fn team_overlay_can_only_tighten_the_node_and_org() {
        let mut base = unlocked_base();
        base.enabled = true;
        base.redact_pii = false;
        let r = FirewallResolver::new(base);
        let bundle = PolicyBundle {
            platform_floor: None,
            firewall: Some(FirewallOverlay {
                policy: Some(FirewallPolicy::Sanitize),
                ..Default::default()
            }),
            team_firewall: Some(FirewallOverlay {
                // Attempted loosening: ignored.
                enabled: Some(false),
                policy: Some(FirewallPolicy::WarnAndContinue),
                redact_pii: Some(true),
                locked_fields: vec!["redact_pii".into()],
                ..Default::default()
            }),
            agent_overlays: HashMap::from([(
                "agent".to_owned(),
                FirewallOverlay {
                    redact_pii: Some(false),
                    ..Default::default()
                },
            )]),
        };
        let resolved = r.resolve(Some("o"), Some("agent"), Some(&bundle));
        assert!(resolved.enabled, "a team cannot disable the firewall");
        assert_eq!(resolved.policy, FirewallPolicy::Sanitize);
        assert!(resolved.redact_pii, "the team lock binds the agent leaf");

        let stricter = PolicyBundle {
            platform_floor: None,
            firewall: None,
            team_firewall: Some(FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        assert_eq!(
            r.resolve(Some("o"), None, Some(&stricter)).policy,
            FirewallPolicy::Block
        );
    }

    #[test]
    fn org_some_overrides_none_inherits() {
        let r = FirewallResolver::new(unlocked_base());
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                redact_pii: Some(false),
                // scan_inbound left None ⇒ inherits node's `true`.
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        let cfg = r.resolve(Some("o1"), None, Some(&bundle));
        assert_eq!(cfg.policy, FirewallPolicy::Block, "Some overrides");
        assert!(!cfg.redact_pii, "Some(false) overrides");
        assert!(cfg.scan_inbound, "None inherits node base");
    }

    #[test]
    fn agent_overrides_org() {
        // `policy` is locked by default; unlock it here to prove plain
        // agent-over-org precedence for an UNLOCKED field.
        let r = FirewallResolver::new(unlocked_base());
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "a1".to_string(),
            FirewallOverlay {
                policy: Some(FirewallPolicy::Sanitize),
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                policy: Some(FirewallPolicy::WarnAndContinue),
                ..Default::default()
            }),
            agent_overlays,
        };
        let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
        // Agent leaf (Sanitize) wins over org (Warn) for a non-locked field.
        assert_eq!(cfg.policy, FirewallPolicy::Sanitize);
    }

    /// `alert` is the trigger for the ENTIRE alert fan-out (`pipeline/mod.rs`
    /// ::`firewall_policy_alert` gates on `cfg.alert >= AlertTier::Warn`), and the node
    /// base defaults it to `Silent`. So overlay resolution for this field is what makes
    /// org/agent-scoped delivery possible at all.
    #[test]
    fn alert_tier_resolves_through_the_cascade() {
        let r = FirewallResolver::new(unlocked_base());
        assert_eq!(
            r.resolve(None, None, None).alert,
            AlertTier::Silent,
            "the node base default is Silent — nothing is delivered until a scope raises it"
        );

        // Org raises it; the agent leaf leaves it None and therefore inherits.
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert("a1".to_string(), FirewallOverlay::default());
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                alert: Some(AlertTier::Fanout),
                ..Default::default()
            }),
            agent_overlays,
        };
        assert_eq!(
            r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
            AlertTier::Fanout,
            "None at the leaf inherits the org tier"
        );

        // An UNLOCKED tier is a plain override in both directions: the leaf may go
        // louder…
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "a1".to_string(),
            FirewallOverlay {
                alert: Some(AlertTier::Email),
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                alert: Some(AlertTier::Warn),
                ..Default::default()
            }),
            agent_overlays,
        };
        assert_eq!(
            r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
            AlertTier::Email
        );

        // …and quieter, including all the way back to Silent. `alert` is deliberately
        // NOT in `default_firewall_locked_fields` (it is a notification dial, not one of
        // the protection dials whose loosening disables the firewall), so this is the
        // default posture and a scope CAN opt out of noise.
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "a1".to_string(),
            FirewallOverlay {
                alert: Some(AlertTier::Silent),
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                alert: Some(AlertTier::Email),
                ..Default::default()
            }),
            agent_overlays,
        };
        assert_eq!(
            r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
            AlertTier::Silent
        );
    }

    /// A LOCKED broader scope: once locked, a narrower scope may only raise the tier.
    /// Same rule as every other locked field, expressed in `AlertTier`'s ascending-
    /// severity `Ord` (`louder_alert` = `max`, mirroring `apply_bool`'s `||`).
    #[test]
    fn locked_alert_tier_can_only_be_raised() {
        // Locked at the NODE base, so both narrower scopes are constrained.
        let node = FirewallConfig {
            alert: AlertTier::Fanout,
            locked_fields: vec!["alert".into()],
            ..FirewallConfig::default()
        };
        let r = FirewallResolver::new(node);

        // Going quieter is refused at the org level…
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                alert: Some(AlertTier::Silent),
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        assert_eq!(
            r.resolve(Some("o1"), None, Some(&bundle)).alert,
            AlertTier::Fanout,
            "a locked tier cannot be silenced by a narrower scope"
        );

        // …and at the agent leaf, even when the org already tried.
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "a1".to_string(),
            FirewallOverlay {
                alert: Some(AlertTier::Warn),
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                alert: Some(AlertTier::Silent),
                ..Default::default()
            }),
            agent_overlays,
        };
        assert_eq!(
            r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
            AlertTier::Fanout,
            "Warn < Fanout is still a loosening"
        );

        // Raising it is allowed — a lock is a floor, not a pin.
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "a1".to_string(),
            FirewallOverlay {
                alert: Some(AlertTier::Email),
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                alert: Some(AlertTier::Silent),
                ..Default::default()
            }),
            agent_overlays,
        };
        assert_eq!(
            r.resolve(Some("o1"), Some("a1"), Some(&bundle)).alert,
            AlertTier::Email
        );

        // A lock authored by the ORG binds the agent leaf too (locks union upward).
        let r = FirewallResolver::new(unlocked_base());
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "a1".to_string(),
            FirewallOverlay {
                alert: Some(AlertTier::Warn),
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                alert: Some(AlertTier::Email),
                locked_fields: vec!["alert".into()],
                ..Default::default()
            }),
            agent_overlays,
        };
        let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
        assert_eq!(
            cfg.alert,
            AlertTier::Email,
            "the org's lock survives into the leaf's resolution"
        );
        assert!(cfg.locked_fields.iter().any(|f| f == "alert"));
    }

    /// `alert` must NOT be treated like `wrap_untrusted_tool_results`: it is a real
    /// per-scope value (the resolved config reaches `firewall_policy_alert` via
    /// `FirewallScanner::config()`), so `normalize_overlay` must leave it — and its
    /// lock — alone.
    #[test]
    fn normalize_overlay_keeps_alert_and_its_lock() {
        let ov = FirewallOverlay {
            alert: Some(AlertTier::Email),
            locked_fields: vec!["alert".into(), NODE_ONLY_WRAP_FIELD.into()],
            wrap_untrusted_tool_results: Some(false),
            ..Default::default()
        };
        let cleaned = normalize_overlay(&ov);
        assert_eq!(cleaned.alert, Some(AlertTier::Email));
        assert_eq!(cleaned.locked_fields, vec!["alert".to_string()]);
        assert!(cleaned.wrap_untrusted_tool_results.is_none());
    }

    #[test]
    fn custom_patterns_union_across_scopes() {
        let mut node = base();
        node.custom_patterns.push(CustomPattern {
            name: "node_pat".into(),
            regex: r"NODE-\d+".into(),
            kind: CustomPatternKind::Pii,
        });
        let r = FirewallResolver::new(node);

        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "a1".to_string(),
            FirewallOverlay {
                custom_patterns: vec![CustomPattern {
                    name: "agent_pat".into(),
                    regex: r"AGT-\d+".into(),
                    kind: CustomPatternKind::Secret,
                }],
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                custom_patterns: vec![CustomPattern {
                    name: "org_pat".into(),
                    regex: r"ORG-\d+".into(),
                    kind: CustomPatternKind::Pii,
                }],
                ..Default::default()
            }),
            agent_overlays,
        };
        let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
        let names: Vec<&str> = cfg
            .custom_patterns
            .iter()
            .map(|p| p.name.as_str())
            .collect();
        assert_eq!(
            names,
            vec!["node_pat", "org_pat", "agent_pat"],
            "union/append"
        );
    }

    #[test]
    fn locked_field_cannot_be_loosened_stricter_wins() {
        // Node locks `enabled` = true. A narrower scope trying to disable it must
        // be ignored (stricter/ON wins).
        let mut node = base();
        node.enabled = true;
        node.locked_fields = vec!["enabled".into()];
        let r = FirewallResolver::new(node);

        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                enabled: Some(false), // attempt to loosen
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        let cfg = r.resolve(Some("o1"), None, Some(&bundle));
        assert!(cfg.enabled, "locked enabled=true cannot be disabled");
        assert!(cfg.locked_fields.contains(&"enabled".to_string()));
    }

    #[test]
    fn locked_policy_cannot_be_downgraded_but_can_tighten() {
        // Node locks `policy` at Sanitize. A narrower Warn must NOT loosen it,
        // but a narrower Block MUST tighten it.
        let mut node = base();
        node.policy = FirewallPolicy::Sanitize;
        node.locked_fields = vec!["policy".into()];
        let r = FirewallResolver::new(node);

        let loosen = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                policy: Some(FirewallPolicy::WarnAndContinue),
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        assert_eq!(
            r.resolve(Some("o"), None, Some(&loosen)).policy,
            FirewallPolicy::Sanitize,
            "cannot downgrade a locked Sanitize to Warn"
        );

        let tighten = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        assert_eq!(
            r.resolve(Some("o"), None, Some(&tighten)).policy,
            FirewallPolicy::Block,
            "can tighten a locked Sanitize to Block"
        );
    }

    #[test]
    fn lock_added_at_org_binds_the_agent_leaf() {
        // Node does NOT lock (default locks removed); org locks `enabled` = true;
        // the agent leaf cannot then disable it. This proves locks bind scopes
        // narrower than the locker.
        let r = FirewallResolver::new(unlocked_base());
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "a1".to_string(),
            FirewallOverlay {
                enabled: Some(false),
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                enabled: Some(true),
                locked_fields: vec!["enabled".into()],
                ..Default::default()
            }),
            agent_overlays,
        };
        let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
        assert!(cfg.enabled, "org lock binds the agent leaf");
    }

    #[test]
    fn default_locks_prevent_overlay_from_disabling_firewall() {
        // With NO explicit lock config, an org/agent overlay must not be able to
        // switch the inbound firewall off for its scope: `enabled`,
        // `scan_inbound`, and `policy` are locked by default, so every loosening
        // attempt is refused (stricter/ON wins).
        let r = FirewallResolver::new(base());
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "a1".to_string(),
            FirewallOverlay {
                scan_inbound: Some(false), // attempt: skip the inbound scan
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                enabled: Some(false),                          // attempt: disable
                scan_inbound: Some(false),                     // attempt: skip scan
                policy: Some(FirewallPolicy::WarnAndContinue), // attempt: downgrade
                ..Default::default()
            }),
            agent_overlays,
        };
        let cfg = r.resolve(Some("o1"), Some("a1"), Some(&bundle));
        assert!(cfg.enabled, "default lock keeps the firewall enabled");
        assert!(cfg.scan_inbound, "default lock keeps inbound scanning on");
        assert_eq!(
            cfg.policy,
            FirewallPolicy::Block,
            "default lock refuses a policy downgrade"
        );
    }

    #[test]
    fn default_locks_still_allow_tightening() {
        // The dual: on a node explicitly loosened to Sanitize (locks left at the
        // default), a narrower scope may still TIGHTEN a locked field.
        let mut node = base();
        node.policy = FirewallPolicy::Sanitize;
        let r = FirewallResolver::new(node);
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                log_detections: Some(false), // explicit unlocked notification setting
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        let cfg = r.resolve(Some("o1"), None, Some(&bundle));
        assert_eq!(
            cfg.policy,
            FirewallPolicy::Block,
            "a locked field may still be tightened"
        );
        assert!(
            !cfg.log_detections,
            "an unlocked field is still freely overridable"
        );
    }

    #[test]
    fn locked_inspector_cannot_be_disabled() {
        let mut node = base();
        node.inspector = InspectorConfig {
            enabled: true,
            mode: InspectorMode::Both,
            ..InspectorConfig::default()
        };
        node.locked_fields = vec!["inspector".into()];
        let r = FirewallResolver::new(node);
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                inspector: Some(InspectorConfig {
                    enabled: false,
                    ..InspectorConfig::default()
                }),
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        let cfg = r.resolve(Some("o1"), None, Some(&bundle));
        assert!(cfg.inspector.enabled, "locked inspector stays enabled");
    }

    #[test]
    fn standalone_local_overlays_apply_without_bundle() {
        let r = FirewallResolver::new(base());
        r.set_agent_overlay(
            "a1".into(),
            FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                ..Default::default()
            },
        );
        // No control-plane bundle (standalone path) — overlay comes from the store.
        let cfg = r.resolve(None, Some("a1"), None);
        assert_eq!(cfg.policy, FirewallPolicy::Block);
    }

    #[test]
    fn scanner_cache_shares_and_invalidates() {
        let r = FirewallResolver::new(base());
        let s1 = r.scanner_for(None, None, None);
        let s2 = r.scanner_for(None, None, None);
        assert!(
            Arc::ptr_eq(&s1, &s2),
            "identical resolved configs share one scanner"
        );

        r.invalidate_cache();
        let s3 = r.scanner_for(None, None, None);
        assert!(
            !Arc::ptr_eq(&s1, &s3),
            "invalidation forces a fresh scanner build"
        );
    }

    #[test]
    fn different_configs_get_different_scanners() {
        let r = FirewallResolver::new(unlocked_base());
        let s1 = r.scanner_for(None, None, None);
        // Explicitly unlock this fixture so the redaction overlay changes the
        // resolved config rather than testing a correctly rejected loosening.
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                redact_pii: Some(false),
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        let s2 = r.scanner_for(Some("o1"), None, Some(&bundle));
        assert!(
            !Arc::ptr_eq(&s1, &s2),
            "distinct resolved configs get distinct scanners"
        );
    }

    #[test]
    fn locked_inspector_cannot_be_loosened_field_by_field() {
        // FIX 1: node locks `inspector` at a strict setting. A narrower scope that
        // tries to loosen EVERY dial (disable, raise min_chars, shorten timeout,
        // narrow Both→single, downgrade the action) must be rejected field by
        // field; the resolved inspector stays at least as strict as the node's.
        let mut node = base();
        node.inspector = InspectorConfig {
            enabled: true,
            model: "node-model".into(),
            mode: InspectorMode::Both,
            min_chars: 20,
            timeout_ms: 3000,
            action: FirewallPolicy::Block,
        };
        node.locked_fields = vec!["inspector".into()];
        let r = FirewallResolver::new(node);

        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                inspector: Some(InspectorConfig {
                    enabled: false,                          // attempt: disable
                    model: "agent-model".into(),             // selection, may swap
                    mode: InspectorMode::Injection,          // attempt: narrow Both
                    min_chars: 500,                          // attempt: scan fewer
                    timeout_ms: 100,                         // attempt: shorten
                    action: FirewallPolicy::WarnAndContinue, // attempt: downgrade
                }),
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        let ins = r.resolve(Some("o1"), None, Some(&bundle)).inspector;
        assert!(ins.enabled, "locked inspector cannot be disabled");
        assert_eq!(ins.mode, InspectorMode::Both, "Both cannot be narrowed");
        assert_eq!(
            ins.min_chars, 20,
            "min_chars cannot be raised (smaller wins)"
        );
        assert_eq!(
            ins.timeout_ms, 3000,
            "timeout cannot be shortened (larger wins)"
        );
        assert_eq!(
            ins.action,
            FirewallPolicy::Block,
            "action cannot be downgraded"
        );
        assert_eq!(
            ins.model, "agent-model",
            "model is a selection: the narrower scope may swap it"
        );
    }

    #[test]
    fn locked_inspector_can_still_tighten() {
        // The dual of the loosen test: a narrower scope enabling a locked-but-off
        // inspector and raising the action MUST take effect (tightening allowed).
        let mut node = base();
        node.inspector = InspectorConfig {
            enabled: false,
            action: FirewallPolicy::WarnAndContinue,
            ..InspectorConfig::default()
        };
        node.locked_fields = vec!["inspector".into()];
        let r = FirewallResolver::new(node);

        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                inspector: Some(InspectorConfig {
                    enabled: true,
                    action: FirewallPolicy::Block,
                    ..InspectorConfig::default()
                }),
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        let ins = r.resolve(Some("o1"), None, Some(&bundle)).inspector;
        assert!(
            ins.enabled,
            "narrower scope may enable a locked-off inspector"
        );
        assert_eq!(
            ins.action,
            FirewallPolicy::Block,
            "narrower scope may tighten"
        );
    }

    #[test]
    fn org_overlay_wrap_untrusted_field_and_lock_are_dropped() {
        // FIX 2: the node-only `wrap_untrusted_tool_results` flag cannot be set or
        // locked by an org/agent overlay. The node base has it `true`; an org
        // overlay flipping it off AND locking it must have BOTH stripped — the
        // resolved value stays at the node base and the lock never appears (so it
        // also never poisons the scanner-cache key).
        let r = FirewallResolver::new(base());
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                wrap_untrusted_tool_results: Some(false),
                locked_fields: vec!["wrap_untrusted_tool_results".into()],
                ..Default::default()
            }),
            agent_overlays: HashMap::new(),
        };
        let cfg = r.resolve(Some("o1"), None, Some(&bundle));
        assert!(
            cfg.wrap_untrusted_tool_results,
            "org overlay cannot change the node-only wrap flag"
        );
        assert!(
            !cfg.locked_fields
                .contains(&"wrap_untrusted_tool_results".to_string()),
            "org overlay cannot lock the node-only wrap flag"
        );
    }

    #[test]
    fn seed_overlays_normalizes_and_populates_local_stores() {
        // FIX 4 + FIX 2: seeding from persisted config populates the resolver's
        // standalone stores, and re-normalizes so a hand-edited gateway.toml
        // cannot smuggle the node-only wrap field back in.
        let r = FirewallResolver::new(base());
        let mut org = HashMap::new();
        org.insert(
            "o1".to_string(),
            FirewallOverlay {
                policy: Some(FirewallPolicy::Block),
                wrap_untrusted_tool_results: Some(false),
                locked_fields: vec!["wrap_untrusted_tool_results".into()],
                ..Default::default()
            },
        );
        r.seed_overlays(&org, &HashMap::new());

        let stored = r.org_overlays();
        assert_eq!(stored["o1"].policy, Some(FirewallPolicy::Block));
        assert_eq!(
            stored["o1"].wrap_untrusted_tool_results, None,
            "seed normalizes away the node-only wrap field"
        );
        assert!(
            stored["o1"].locked_fields.is_empty(),
            "seed normalizes away the node-only wrap lock"
        );
        // And it drives resolution on the standalone (no-bundle) path.
        let cfg = r.resolve(Some("o1"), None, None);
        assert_eq!(cfg.policy, FirewallPolicy::Block);
    }

    // ── Evaluator-binding cascade (P1) ─────────────────────────────────────────

    use crate::evaluators::EvaluatorBinding;

    /// Build a test evaluator binding.
    fn binding(
        id: &str,
        enabled: bool,
        inline_action: Option<FirewallPolicy>,
        locked: bool,
    ) -> EvaluatorBinding {
        EvaluatorBinding {
            id: id.into(),
            enabled,
            inline_action,
            offline: None,
            locked,
        }
    }

    fn find<'a>(bindings: &'a [EvaluatorBinding], id: &str) -> &'a EvaluatorBinding {
        bindings
            .iter()
            .find(|b| b.id == id)
            .unwrap_or_else(|| panic!("binding {id} missing"))
    }

    #[test]
    fn merge_evaluator_bindings_unions_and_tightens_locked() {
        // Direct unit test of the helper: a locked base binding may be tightened
        // (never loosened) and an overlay-only binding is appended (union).
        let base = vec![binding("a", true, Some(FirewallPolicy::Block), true)];
        let overlay = vec![
            binding("a", false, Some(FirewallPolicy::WarnAndContinue), false),
            binding("b", true, None, false),
        ];
        let merged = merge_evaluator_bindings(&base, &overlay);
        assert_eq!(merged.len(), 2, "union keeps a and appends b");
        let a = find(&merged, "a");
        assert!(a.enabled, "locked+enabled base cannot be disabled");
        assert_eq!(
            a.inline_action,
            Some(FirewallPolicy::Block),
            "locked action cannot be downgraded to Warn"
        );
        assert!(a.locked, "lock stays");
        assert!(find(&merged, "b").enabled, "overlay-only binding appended");
    }

    #[test]
    fn merge_evaluator_bindings_overrides_unlocked() {
        // An unlocked base binding is overridden wholesale by the overlay.
        let base = vec![binding("a", false, None, false)];
        let overlay = vec![binding("a", true, Some(FirewallPolicy::Sanitize), false)];
        let merged = merge_evaluator_bindings(&base, &overlay);
        let a = find(&merged, "a");
        assert!(a.enabled);
        assert_eq!(a.inline_action, Some(FirewallPolicy::Sanitize));
    }

    #[test]
    fn cascade_merges_evaluators_by_id() {
        // Node base has A (off) + B (off). Org overrides A (on/Block) and adds C.
        // Agent overrides B (on/Sanitize). Resolved: A(org), B(agent), C(org).
        let mut node = base();
        node.evaluators = vec![
            binding("a", false, None, false),
            binding("b", false, None, false),
        ];
        let r = FirewallResolver::new(node);

        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "ag".to_string(),
            FirewallOverlay {
                evaluators: Some(vec![binding(
                    "b",
                    true,
                    Some(FirewallPolicy::Sanitize),
                    false,
                )]),
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                evaluators: Some(vec![
                    binding("a", true, Some(FirewallPolicy::Block), false),
                    binding("c", true, None, false),
                ]),
                ..Default::default()
            }),
            agent_overlays,
        };
        let cfg = r.resolve(Some("o1"), Some("ag"), Some(&bundle));
        assert_eq!(cfg.evaluators.len(), 3, "A, B, C");
        let a = find(&cfg.evaluators, "a");
        assert!(
            a.enabled && a.inline_action == Some(FirewallPolicy::Block),
            "A from org"
        );
        let b = find(&cfg.evaluators, "b");
        assert!(
            b.enabled && b.inline_action == Some(FirewallPolicy::Sanitize),
            "B from agent"
        );
        assert!(find(&cfg.evaluators, "c").enabled, "C from org");
    }

    #[test]
    fn locked_evaluator_cannot_be_disabled_by_narrower_scope() {
        // Org locks A enabled+Block. The agent leaf tries enabled=false + Warn.
        // The lock binds the narrower scope: A stays enabled + Block.
        let r = FirewallResolver::new(base());
        let mut agent_overlays = HashMap::new();
        agent_overlays.insert(
            "ag".to_string(),
            FirewallOverlay {
                evaluators: Some(vec![binding(
                    "a",
                    false,
                    Some(FirewallPolicy::WarnAndContinue),
                    false,
                )]),
                ..Default::default()
            },
        );
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(FirewallOverlay {
                evaluators: Some(vec![binding("a", true, Some(FirewallPolicy::Block), true)]),
                ..Default::default()
            }),
            agent_overlays,
        };
        let cfg = r.resolve(Some("o1"), Some("ag"), Some(&bundle));
        let a = find(&cfg.evaluators, "a");
        assert!(
            a.enabled,
            "org lock keeps A enabled against the agent's false"
        );
        assert_eq!(
            a.inline_action,
            Some(FirewallPolicy::Block),
            "org lock keeps Block against the agent's Warn"
        );
        assert!(a.locked, "lock propagates to the narrower scope");
    }

    #[test]
    fn back_compat_deserialize_without_evaluators_field() {
        // A FirewallConfig / FirewallOverlay JSON authored before P1 (no
        // `evaluators` key) still deserializes: config → empty Vec, overlay → None.
        let cfg: FirewallConfig = serde_json::from_str("{}").expect("config deserializes");
        assert!(cfg.evaluators.is_empty(), "missing field → empty Vec");

        let ov: FirewallOverlay = serde_json::from_str("{}").expect("overlay deserializes");
        assert!(ov.evaluators.is_none(), "missing field → None");
    }
    fn disable_egress() -> FirewallOverlay {
        FirewallOverlay {
            scan_outbound: Some(false),
            redact_pii: Some(false),
            redact_secrets: Some(false),
            ..Default::default()
        }
    }

    #[test]
    fn inherited_default_egress_locks_reject_org_and_agent_loosening() {
        let resolver = FirewallResolver::new(base());
        resolver.set_org_overlay("org".into(), disable_egress());
        resolver.set_agent_overlay("agent".into(), disable_egress());
        for (org, agent) in [
            (Some("org"), None),
            (None, Some("agent")),
            (Some("org"), Some("agent")),
        ] {
            let config = resolver.resolve(org, agent, None);
            assert!(config.scan_outbound && config.redact_pii && config.redact_secrets);
        }
        let bundle = PolicyBundle {
            platform_floor: None,
            team_firewall: None,
            firewall: Some(disable_egress()),
            agent_overlays: HashMap::from([("agent".into(), disable_egress())]),
        };
        let config = resolver.resolve(Some("org"), Some("agent"), Some(&bundle));
        assert!(config.scan_outbound && config.redact_pii && config.redact_secrets);
    }

    #[test]
    fn partial_node_config_inherits_egress_locks_and_allows_tightening() {
        let partial: crate::config::GatewayConfig = toml::from_str(
            r#"[firewall]
policy = "sanitize"
"#,
        )
        .unwrap();
        let resolver = FirewallResolver::new(partial.firewall);
        resolver.set_agent_overlay("agent".into(), disable_egress());
        let config = resolver.resolve(None, Some("agent"), None);
        assert_eq!(config.policy, FirewallPolicy::Sanitize);
        assert!(config.scan_outbound && config.redact_pii && config.redact_secrets);

        let authored: crate::config::GatewayConfig = toml::from_str(
            r#"[firewall]
scan_outbound = false
redact_pii = false
redact_secrets = false
"#,
        )
        .unwrap();
        let resolver = FirewallResolver::new(authored.firewall);
        let config = resolver.resolve(None, None, None);
        assert!(
            !config.scan_outbound && !config.redact_pii && !config.redact_secrets,
            "node-authored values remain authoritative"
        );
        resolver.set_agent_overlay(
            "agent".into(),
            FirewallOverlay {
                scan_outbound: Some(true),
                redact_pii: Some(true),
                redact_secrets: Some(true),
                ..Default::default()
            },
        );
        let tightened = resolver.resolve(None, Some("agent"), None);
        assert!(tightened.scan_outbound && tightened.redact_pii && tightened.redact_secrets);
    }

    #[test]
    fn explicit_custom_node_locks_preserve_operator_choice() {
        for locks in ["[]", "[\"enabled\"]"] {
            let config: crate::config::GatewayConfig =
                toml::from_str(&format!("[firewall]\nlocked_fields = {locks}\n")).unwrap();
            assert!(!config
                .firewall
                .locked_fields
                .iter()
                .any(|field| field == "scan_outbound"));
            let resolver = FirewallResolver::new(config.firewall);
            resolver.set_agent_overlay("agent".into(), disable_egress());
            let config = resolver.resolve(None, Some("agent"), None);
            assert!(!config.scan_outbound && !config.redact_pii && !config.redact_secrets);
            assert!(config.enabled);
        }
    }
}
