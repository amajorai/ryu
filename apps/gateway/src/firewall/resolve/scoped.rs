//! Per-request resolution through the node, floor, org, agent and request scopes,
//! and the scanner cache keyed by the resolved config.

use super::*;

impl FirewallResolver {
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
