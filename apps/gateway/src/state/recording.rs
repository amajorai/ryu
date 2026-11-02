//! The audit and violation chokepoints, and borrows of the live backends.

use super::*;

impl AppState {
    /// The gateway's single audit chokepoint: persists the record to the active
    /// audit backend AND broadcasts a redacted copy to the live traffic bus.
    /// Every audit call site funnels through here, so the `GET /v1/traffic` feed
    /// can never miss a request the audit store recorded (and vice-versa).
    pub fn log_audit(&self, record: crate::audit::AuditRecord) {
        let outcome = crate::traffic::TrafficOutcome::inferred(&record);
        self.log_audit_with(record, outcome);
    }

    /// [`Self::log_audit`] for a row whose outcome the caller knows: a
    /// guardrail verdict, or a failure and the error it returned. The live
    /// event is published even when the audit store is disabled, so blocks
    /// and rate limits stay visible on the feed.
    pub fn log_audit_with(
        &self,
        record: crate::audit::AuditRecord,
        outcome: crate::traffic::TrafficOutcome,
    ) {
        if record.event_type == crate::audit::EventType::ServiceCall {
            tracing::warn!("service audit requires validated service usage");
            return;
        }
        let event = self.traffic.enrich(
            crate::traffic::traffic_event(&record),
            &record,
            outcome,
            self.custody,
        );
        if crate::usage_windows::window_reporting_active(self.custody, &self.config.control_plane) {
            let cost = crate::reporter::record_cost_micro_usd(&record, &self.config);
            self.usage_windows
                .observe(self.custody, &record, &event, cost);
        }
        self.traffic.publish(event);
        self.audit.log(record);
    }

    /// The gateway's single violation chokepoint, beside [`Self::log_audit`]
    /// (spec 03.4.3). Fills the identity from `ctx` (the TENANT org, the
    /// presenting credential, the actor and every hashed subject), redacts
    /// and bounds the excerpt, hashes the evidence, and writes the event to
    /// the violation outbox, which the reporter drains with its own cursor.
    /// Call it only in verdict branches, never for transport or budget
    /// errors. Returns the event id when a new event was stored, or when an
    /// unreported event with the same `dedupeKey` took this stronger action;
    /// any other repeat of the key returns `None`.
    pub fn record_violation(
        &self,
        ctx: &RequestContext,
        input: crate::violations::VerdictInput,
    ) -> Option<String> {
        // Stored evidence is redacted whatever `redact_pii` / `redact_secrets`
        // say, with Unicode evasions folded; an excerpt the redactor cannot
        // clean comes back empty and is dropped.
        let redact = |text: &str| self.with_firewall(|fw| fw.redact_excerpt(text));
        // A stream cut is recorded after its handler returned, outside the
        // route scope; the route the request noted then stands in.
        let route =
            crate::traffic::current_route().or_else(|| self.traffic.noted_route(&ctx.request_id));
        let (event, excerpt) = crate::violations::build_event(
            self.custody,
            &self.identity_keys,
            &redact,
            ctx,
            route,
            input,
        );
        match self.violations.record(&event, excerpt.as_deref()) {
            Ok(crate::audit::RecordOutcome::Inserted) => Some(event.event_id),
            Ok(crate::audit::RecordOutcome::Upgraded { event_id }) => Some(event_id),
            Ok(crate::audit::RecordOutcome::Duplicate) => None,
            Err(error) => {
                tracing::error!(
                    request_id = %ctx.request_id,
                    category = %event.category,
                    "violation event not stored: {error}"
                );
                None
            }
        }
    }

    /// The custom pattern names each firewall layer contributes to `ctx`'s
    /// scanner, so a firewall match can be attributed to the layer that
    /// declared it on the live feed. Read only when a match happened.
    pub(crate) fn firewall_layers(&self, ctx: &RequestContext) -> crate::traffic::FirewallLayers {
        fn names(overlay: Option<&crate::config::FirewallOverlay>) -> Vec<String> {
            overlay
                .map(|overlay| {
                    overlay
                        .custom_patterns
                        .iter()
                        .map(|p| p.name.clone())
                        .collect()
                })
                .unwrap_or_default()
        }
        let bundle = self.request_bundle(ctx);
        let floor = bundle.as_ref().and_then(|b| b.platform_floor.as_deref());
        let org = bundle
            .as_ref()
            .and_then(|b| b.firewall.clone())
            .or_else(|| {
                ctx.org_id
                    .as_deref()
                    .and_then(|id| self.resolver.org_overlays().get(id).cloned())
            });
        let agent = bundle
            .as_ref()
            .and_then(|b| {
                ctx.agent_id
                    .as_deref()
                    .and_then(|id| b.agent_overlays.get(id).cloned())
            })
            .or_else(|| {
                ctx.agent_id
                    .as_deref()
                    .and_then(|id| self.resolver.agent_overlays().get(id).cloned())
            });
        let mut org_patterns = names(org.as_ref());
        org_patterns.extend(names(
            bundle.as_ref().and_then(|b| b.team_firewall.as_ref()),
        ));
        let (request_overlay, _dropped) = crate::pipeline::node_routing::clamp_firewall(
            ctx.node_routing.as_ref(),
            &self.config.node_routing,
        );
        let mut node_patterns: Vec<String> = self
            .resolver
            .node_base()
            .custom_patterns
            .iter()
            .map(|p| p.name.clone())
            .collect();
        node_patterns.extend(names(request_overlay.as_ref()));
        crate::traffic::FirewallLayers {
            floor_scans_inbound: floor.is_some_and(|floor| {
                floor.overlay.enabled == Some(true) && floor.overlay.scan_inbound != Some(false)
            }),
            floor_patterns: names(floor.map(|floor| &floor.overlay)),
            org_patterns,
            agent_patterns: names(agent.as_ref()),
            node_patterns,
        }
    }

    pub fn log_audit_service(
        &self,
        record: crate::audit::AuditRecord,
        usage: crate::audit::AuditServiceUsage,
    ) -> Result<(), crate::audit::ServiceAuditError> {
        let safe = crate::audit::normalize_service_audit_record(record, &usage)?;
        let event = self.traffic.enrich(
            crate::traffic::service_traffic_event(&safe, &usage)?,
            &safe,
            crate::traffic::TrafficOutcome::inferred(&safe),
            self.custody,
        );
        self.audit.log_service(safe, usage)?;
        self.traffic.publish(event);
        Ok(())
    }

    /// Borrow the auth config for the duration of a closure.
    pub fn with_auth<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&AuthConfig) -> T,
    {
        match self.auth.read() {
            Ok(guard) => f(&*guard),
            Err(poisoned) => f(&*poisoned.into_inner()),
        }
    }

    /// Borrow the firewall scanner for the duration of a closure. Recovers from
    /// a poisoned lock by rebuilding a default scanner rather than panicking.
    pub fn with_firewall<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&dyn crate::firewall::FirewallBackend) -> T,
    {
        self.firewall.with_active(f)
    }

    /// Borrow the budget enforcer for the duration of a closure.
    pub fn with_budget<F, T>(&self, f: F) -> T
    where
        F: FnOnce(&dyn BudgetBackend) -> T,
    {
        self.budget.with_active(f)
    }
}
