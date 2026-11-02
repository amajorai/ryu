//! Live policy, router, firewall, budget and auth swaps on [`AppState`].

use super::*;

impl AppState {
    /// The lazily-constructed WASM policy host. Returns `None` only if the wasmtime
    /// engine could not be built (wasm evaluation then fails closed for security
    /// policies). Construction â€” including the epoch ticker thread â€” happens at most
    /// once, on the first request that references a `Wasm` evaluator; a gateway
    /// without any wasm policy never pays for it.
    pub fn wasm_host(&self) -> Option<&Arc<WasmPolicyHost>> {
        self.wasm_host
            .get_or_init(|| match WasmPolicyHost::new() {
                Ok(h) => Some(Arc::new(h)),
                Err(e) => {
                    tracing::error!("failed to build WASM policy host: {e}");
                    None
                }
            })
            .as_ref()
    }

    /// The merged evaluator catalog (built-ins + the live custom evaluators).
    /// Every request-time and API call site reads through this so a custom
    /// evaluator saved by `PUT /v1/config` applies without a restart.
    pub fn evaluator_registry(&self) -> crate::evaluators::EvaluatorRegistry {
        crate::evaluators::EvaluatorRegistry::from_custom(&self.live_custom_evaluators())
    }

    /// The live user-authored evaluator set (not the startup config snapshot).
    pub fn live_custom_evaluators(&self) -> Arc<Vec<crate::evaluators::Evaluator>> {
        self.custom_evaluators
            .read()
            .map(|custom| Arc::clone(&custom))
            .unwrap_or_else(|poisoned| Arc::clone(&poisoned.into_inner()))
    }

    /// Swap the live custom-evaluator set (called after `PUT /v1/config`
    /// validated and persisted it).
    pub fn update_custom_evaluators(&self, custom: Vec<crate::evaluators::Evaluator>) {
        let next = Arc::new(custom);
        match self.custom_evaluators.write() {
            Ok(mut guard) => *guard = next,
            Err(poisoned) => *poisoned.into_inner() = next,
        }
    }

    /// Snapshot the current effective policy. Cheap clone; a poisoned policy
    /// lock returns an unavailable policy so managed requests fail closed.
    pub fn policy_snapshot(&self) -> EffectivePolicy {
        self.policy
            .read()
            .map(|policy| policy.clone())
            .unwrap_or_else(|_| EffectivePolicy {
                available: false,
                ..EffectivePolicy::default()
            })
    }

    /// Replace the effective policy (called by the control-plane refresh task).
    pub fn set_policy(&self, policy: EffectivePolicy) {
        if let Ok(mut guard) = self.policy.write() {
            *guard = policy;
        }
    }

    /// Apply a fresh resolution of this gateway's own key: swap in its policy
    /// and record its `policyVersion`. When the version changed, cached
    /// per-token resolutions for the same org are dropped so new policy and
    /// limits reach hosted traffic on the next request instead of after the
    /// positive TTL. Returns whether the version changed.
    pub fn apply_resolved_policy(&self, resolved: crate::policy::ResolvedOrg) -> bool {
        self.observe_platform_floor(&resolved);
        // A standing that refuses this gateway's own key installs a policy
        // that permits nothing, never the (possibly empty) body it came with.
        let mut policy = resolved.policy;
        if resolved.standing.refusal(self.custody).is_some() {
            policy.available = false;
            tracing::warn!(
                state = ?resolved.standing.state,
                "policy: this gateway's own key is refused by its platform standing"
            );
        }
        self.set_policy(policy);
        let mut guard = self
            .policy_version
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let changed = guard.is_some() && *guard != resolved.policy_version;
        *guard = resolved.policy_version;
        drop(guard);
        if changed {
            if let Some(cache) = self.resolve_cache.as_ref() {
                let dropped = cache.invalidate_org(&resolved.org_id);
                tracing::info!(
                    dropped,
                    "policy: version changed; refreshed cached resolutions"
                );
            }
        }
        changed
    }

    /// Keep the platform floor a resolve carried when it is newer than the
    /// one held (see [`crate::platform_floor::FloorStore::observe`]). Called
    /// for this gateway's own key and for every dynamically resolved `rgw_`
    /// bearer. A changed floor drops every cached scanner, since each was
    /// compiled against the old one.
    pub fn observe_platform_floor(&self, resolved: &crate::policy::ResolvedOrg) {
        let Some(floor) = resolved.platform_floor.as_ref() else {
            return;
        };
        let newer = self
            .platform_floor
            .current()
            .is_none_or(|current| current.version < floor.version);
        // A `screener` this replica cannot apply (a role naming a backend it
        // has no endpoint for, a remote processor without its record, a role
        // that cannot cover a hard code) rejects the whole floor: the previous
        // one stays and a `screening_degraded` event fires.
        if newer {
            if let Some(screener) = floor.screener.as_deref() {
                if let Err(reason) = self.screening.validate_floor(screener) {
                    tracing::warn!(
                        version = floor.version,
                        reason,
                        "platform floor: rejected as a whole"
                    );
                    crate::screening::publish_degraded(
                        &self.traffic,
                        serde_json::json!({
                            "reason": "floor_rejected",
                            "floorVersion": floor.version,
                            "detail": reason,
                        }),
                    );
                    return;
                }
            }
        }
        if self.platform_floor.observe(Some(floor)) {
            self.resolver.invalidate_cache();
        }
    }

    /// The last `policyVersion` reported for this gateway's own key.
    pub fn policy_version(&self) -> Option<String> {
        self.policy_version
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Clone the current global smart router out under a brief read lock. The
    /// returned `Arc` holds no lock, so the async request path
    /// ([`crate::pipeline::apply_smart_routing`]) can keep it across the classifier
    /// `.await`. Recovers from a poisoned lock by returning the inner value.
    pub fn smart_router(&self) -> std::sync::Arc<dyn SmartRouterBackend> {
        self.smart_router.active()
    }

    /// Hot-swap the global smart router with one built from a new
    /// [`crate::config::SmartRoutingConfig`]. Called by `PUT /v1/config` when the
    /// patch carries `routing`, so a smart-routing toggle (or an updated ruleset)
    /// takes effect on the request path with **no gateway restart** â€” the same
    /// live-swap discipline as [`Self::update_firewall_config`].
    ///
    /// Rebuilding drops the per-session decision cache (like the firewall scanner
    /// swap resets its compiled state); this is intentional and cheap. Only
    /// `smart_routing` swaps here â€” `model_map` / `fallback_chain` / `provider_tiers`
    /// live in [`Self::router`] (a startup snapshot) and remain restart-only.
    pub fn update_smart_router(&self, cfg: crate::config::SmartRoutingConfig) {
        self.smart_router.update_config(cfg);
    }

    /// Hot-swap the firewall scanner with a new config. Called by PUT /v1/config.
    /// The existing scanner is replaced atomically; in-flight requests that already
    /// acquired a read guard finish with the old config. Also updates the
    /// resolver's node base and invalidates its scanner cache so every resolved
    /// (nodeâ†’orgâ†’agent) scanner picks up the new baseline.
    pub fn update_firewall_config(&self, cfg: FirewallConfig) {
        self.firewall.update_config(cfg.clone());
        self.resolver.set_node_base(cfg);
    }

    /// Build the per-request control-plane [`PolicyBundle`] from the request's
    /// resolved policy (the dynamic `rgw_`-token tenant path) or the global
    /// startup policy, mirroring the pipeline's `resolved_policy || snapshot`
    /// fallback. On fleet custody it also carries the platform floor, which
    /// binds every request there. Returns `None` when nothing carries any
    /// firewall overlay, so the resolver falls back to its standalone-local
    /// overlay store.
    pub(super) fn request_bundle(&self, ctx: &RequestContext) -> Option<PolicyBundle> {
        let policy = ctx
            .resolved_policy
            .clone()
            .unwrap_or_else(|| self.policy_snapshot());
        let bundle = PolicyBundle {
            platform_floor: crate::platform_floor::binding_floor(
                self.custody,
                &self.platform_floor,
            ),
            firewall: policy.firewall.clone(),
            team_firewall: policy.team_firewall.clone(),
            agent_overlays: policy.agent_overlays.clone(),
        };
        if bundle.is_empty() {
            None
        } else {
            Some(bundle)
        }
    }

    /// Resolve the per-request firewall scanner for `ctx` (node â†’ org â†’ agent),
    /// returning a shared, cached [`FirewallScanner`]. The returned `Arc` holds
    /// no lock, so it is safe to keep across an `.await` (the inspector needs to).
    pub fn resolved_scanner(&self, ctx: &RequestContext) -> Arc<FirewallScanner> {
        let bundle = self.request_bundle(ctx);
        // The node's OWN extra rules, as the narrowest scope. Clamped here rather
        // than read raw: the resolver applies it under locked = every field, so it
        // can only tighten, and `clamp_firewall` is what enforces the node's
        // `allow_request_override` lever and the size caps before it gets there.
        //
        // `pre_process` calls this ONCE at the top and shares the returned `Arc`
        // across the regex scan, the inspector's `.await`, the locked-guardrail
        // scan and companion redaction â€” so the request overlay lands on all four
        // with no second resolution.
        let (request_overlay, _dropped) = crate::pipeline::node_routing::clamp_firewall(
            ctx.node_routing.as_ref(),
            &self.config.node_routing,
        );
        self.resolver.scanner_for_request(
            ctx.org_id.as_deref(),
            ctx.agent_id.as_deref(),
            bundle.as_ref(),
            request_overlay.as_ref(),
        )
    }

    /// The resolved firewall scanner for the loopback subscription passthrough,
    /// which carries no Gateway credential and so has no org or request scope:
    /// node base → the global control-plane org overlay (or the standalone local
    /// overlay) → the node's tighten-only team overlay → the agent overlay when a
    /// trusted forwarder named the agent. It
    /// is the scanner the chat path resolves for an anonymous request, so
    /// overlays and custom patterns apply to agent passthrough traffic too.
    pub fn passthrough_scanner(&self, agent_id: Option<&str>) -> Arc<FirewallScanner> {
        let policy = self.policy_snapshot();
        let bundle = PolicyBundle {
            platform_floor: crate::platform_floor::binding_floor(
                self.custody,
                &self.platform_floor,
            ),
            firewall: policy.firewall.clone(),
            team_firewall: policy.team_firewall.clone(),
            agent_overlays: policy.agent_overlays.clone(),
        };
        let bundle = (!bundle.is_empty()).then_some(bundle);
        self.resolver
            .scanner_for_request(None, agent_id, bundle.as_ref(), None)
    }

    /// Borrow the per-request *resolved* firewall scanner for the duration of a
    /// closure. The per-agent analogue of [`Self::with_firewall`]: it resolves
    /// the nodeâ†’orgâ†’agent cascade from `ctx` and hands a cached scanner to `f`.
    ///
    /// The chat inbound/locked/companion paths call [`Self::resolved_scanner`]
    /// directly to share ONE resolution (and its `Arc`) across the regex scan,
    /// the inspector's `.await`, the locked-guardrail scan, and companion
    /// redaction; this closure form is provided for single-shot call sites.
    #[allow(dead_code)]
    pub fn with_resolved_firewall<F, T>(&self, ctx: &RequestContext, f: F) -> T
    where
        F: FnOnce(&FirewallScanner) -> T,
    {
        let scanner = self.resolved_scanner(ctx);
        f(&scanner)
    }

    /// Hot-swap the budget enforcer with a new config. Called by PUT /v1/config.
    /// In-memory usage counters reset on swap â€” this is intentional: lifetime
    /// counters are ephemeral by design (see budget/mod.rs module comment).
    pub fn update_budget_config(&self, cfg: BudgetConfig) {
        self.budget.update_config(cfg);
    }

    /// Replace the `api_keys` list in the live auth config. Called by PUT /v1/config.
    /// The master_key and require_auth flag are unchanged â€” they are startup-only.
    pub fn update_auth_config(&self, mut api_keys: Vec<ApiKeyConfig>) {
        // Host-provisioned relays are bootstrap credentials, not user-editable
        // API keys. Preserve their original authority even if a config patch
        // omits them or submits the same bearer with trusted_forwarder changed.
        for managed in self
            .config
            .auth
            .api_keys
            .iter()
            .filter(|entry| entry.is_system_relay())
        {
            api_keys.retain(|entry| entry.key != managed.key && entry.name != managed.name);
            api_keys.push(managed.clone());
        }
        if let Ok(mut guard) = self.auth.write() {
            guard.api_keys = api_keys;
        }
    }
}
