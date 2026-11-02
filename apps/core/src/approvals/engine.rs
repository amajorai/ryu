//! The approval engine: requests, decisions, expiry and the global mode.

use super::*;

impl ApprovalEngine {
    pub fn new(store: ApprovalStore, http: reqwest::Client) -> Self {
        Self {
            store,
            http,
            push_store: None,
            registry: None,
            preferences: None,
            skills: None,
        }
    }

    /// Attach the kernel notify store so approval notifications reuse its
    /// registered Expo push tokens (the mobile-push fan-out). Builder-style;
    /// no-op if unset.
    pub fn with_push_store(mut self, push_store: crate::notify::NotifyStore) -> Self {
        self.push_store = Some(push_store);
        self
    }

    /// Attach the MCP registry so an approved tool call can be executed on
    /// approve. Builder-style; without it a `ToolCall` approval can't run.
    pub fn with_registry(
        mut self,
        registry: std::sync::Arc<crate::sidecar::mcp::McpRegistry>,
    ) -> Self {
        self.registry = Some(registry);
        self
    }

    /// Attach the preferences store so the global approval mode (Layer B) is
    /// readable. Builder-style; without it the mode resolves to the fail-safe
    /// `Smart` default (only an explicit `off` pref disables Layer B).
    pub fn with_preferences(
        mut self,
        preferences: crate::server::preferences::PreferencesStore,
    ) -> Self {
        self.preferences = Some(preferences);
        self
    }

    /// Attach the skills registry so an approved learning-synthesized skill can be
    /// written + activated + hot-reloaded. Builder-style; without it an
    /// `ActivateSkill` approval fails with a clear error on approve.
    pub fn with_skills(mut self, skills: ryu_skills::SkillRegistry) -> Self {
        self.skills = Some(skills);
        self
    }

    /// The raw `approval-mode` preference value, if any. `None` = no preferences
    /// store attached or the key is unset; `Some("off")` = the explicit escape
    /// hatch. The CoreApi-mutation gate (Layer B′) needs to tell an unset pref
    /// from an explicit `off`, which the collapsed [`policy::ApprovalMode`] loses.
    pub async fn approval_mode_pref(&self) -> Option<String> {
        let prefs = self.preferences.as_ref()?;
        prefs.get(policy::APPROVAL_MODE_PREF).await.ok().flatten()
    }

    /// The current global approval mode (Layer B), read from the `approval-mode`
    /// preference. Resolves to the `Smart` default when unset or no preferences
    /// store attached; only an explicit `off` disables Layer B.
    pub async fn approval_mode(&self) -> policy::ApprovalMode {
        let raw = self.approval_mode_pref().await;
        policy::ApprovalMode::from_pref(raw.as_deref().unwrap_or_default())
    }

    /// Raise a pending approval request (deferred, non-blocking). Persists +
    /// broadcasts (via the store) + fans out notifications. Returns the request.
    pub async fn request(&self, req: ApprovalRequest) -> anyhow::Result<ApprovalRequest> {
        self.store.insert(&req).await?;
        // The push fan-out may wait on per-member permission lookups and on
        // Expo, so it runs beside the caller rather than delaying the request.
        if self.push_store.is_some() {
            let (engine, created) = (self.clone(), req.clone());
            tokio::spawn(async move { engine.notify_created(&created).await });
        }
        Ok(req)
    }

    /// Like [`request`](Self::request) but a no-op when a Pending request already
    /// exists for `source_ref` (prevents a scheduled job from piling up a fresh
    /// approval on every tick). Returns the new request, or `None` if deduped.
    pub async fn request_deduped(
        &self,
        req: ApprovalRequest,
    ) -> anyhow::Result<Option<ApprovalRequest>> {
        if let Some(src) = req.source_ref.as_deref() {
            if self.store.has_pending_for_source(src).await? {
                return Ok(None);
            }
        }
        Ok(Some(self.request(req).await?))
    }

    /// Decide a request. **Idempotent**: only a `Pending` request transitions, so
    /// a double-approve (or approve-after-expire) never re-runs the action. On
    /// approve the status is flipped *durably first*, then the action executes —
    /// so a crash mid-execute fails safe (the action is lost, never double-run).
    /// Returns the updated request, or `None` if no such id.
    pub async fn decide(
        &self,
        id: &str,
        approve: bool,
        note: Option<String>,
    ) -> anyhow::Result<Option<ApprovalRequest>> {
        let Some(mut req) = self.store.get(id).await? else {
            return Ok(None);
        };
        // Fast-path idempotency: anything already decided/expired is returned
        // as-is (the authoritative guard is the atomic CAS below).
        if req.status != ApprovalStatus::Pending {
            return Ok(Some(req));
        }
        req.status = if approve {
            ApprovalStatus::Approved
        } else {
            ApprovalStatus::Rejected
        };
        req.note = note;
        req.decided_at = Some(chrono::Utc::now().to_rfc3339());

        // ATOMIC compare-and-swap from Pending: exactly one of N concurrent
        // deciders wins. Only the winner runs side effects, so a double-approve
        // (double-click / phone+desktop) can never double-execute the action.
        // The status is flipped durably BEFORE the action runs (crash-safety: a
        // crash mid-execute leaves an Approved row whose action was lost, never
        // double-run).
        if !self.store.try_transition(&req).await? {
            // Someone else decided it first — return the current persisted state.
            return Ok(self.store.get(id).await?);
        }

        if approve {
            // Run the approved action in the background so the decide call (and the
            // HTTP approve handler) returns immediately rather than blocking for the
            // whole workflow/agent run. Success (a tool result) / failure is
            // recorded back onto the row + re-broadcast so the inbox shows it.
            if let Some(action) = req.action.clone() {
                let engine = self.clone();
                let id = req.id.clone();
                tokio::spawn(async move {
                    match engine.execute_action(&action).await {
                        Ok(Some(result)) => engine.record_action_result(&id, result).await,
                        Ok(None) => {}
                        Err(e) => {
                            let msg = format!("{e:#}");
                            tracing::warn!("approval {id}: action failed: {msg}");
                            engine.record_action_error(&id, msg).await;
                        }
                    }
                });
            }
        } else if let Some(action) = req.action.clone() {
            // Reject teardown (fail a suspended workflow gate). Only the winner
            // reaches here, so it runs exactly once.
            reject_action(&action).await;
        }

        Ok(Some(req))
    }

    /// Record that an approved action failed to execute, onto the row (so the
    /// inbox surfaces the failure). Best-effort: a missing row is ignored.
    pub(super) async fn record_action_error(&self, id: &str, msg: String) {
        if let Ok(Some(mut req)) = self.store.get(id).await {
            req.error = Some(msg);
            let _ = self.store.update(&req).await;
        }
    }

    /// Record an approved action's result (a tool call's output) onto the row so
    /// the inbox shows what the approved call returned. Best-effort.
    pub(super) async fn record_action_result(&self, id: &str, result: String) {
        if let Ok(Some(mut req)) = self.store.get(id).await {
            // Bound the stored preview so a large tool result can't bloat the row
            // (char-based so a multi-byte codepoint is never split).
            const MAX: usize = 4000;
            req.result = Some(if result.chars().count() > MAX {
                let mut s: String = result.chars().take(MAX).collect();
                s.push('…');
                s
            } else {
                result
            });
            let _ = self.store.update(&req).await;
        }
    }

    /// Cancel a pending request programmatically (e.g. its source run was deleted).
    pub async fn cancel(&self, id: &str) -> anyhow::Result<Option<ApprovalRequest>> {
        let Some(mut req) = self.store.get(id).await? else {
            return Ok(None);
        };
        if req.status != ApprovalStatus::Pending {
            return Ok(Some(req));
        }
        req.status = ApprovalStatus::Cancelled;
        req.decided_at = Some(chrono::Utc::now().to_rfc3339());
        // CAS so a cancel racing an approve can't both act.
        if !self.store.try_transition(&req).await? {
            return Ok(self.store.get(id).await?);
        }
        Ok(Some(req))
    }

    /// Delete decided requests older than [`APPROVAL_HISTORY_RETENTION_DAYS`].
    /// Called by the same background sweep as [`Self::sweep_expired`]; pending
    /// requests are never pruned. Returns the number removed.
    pub async fn prune_history(&self) -> anyhow::Result<usize> {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(APPROVAL_HISTORY_RETENTION_DAYS);
        self.store.prune_decided_before(&cutoff.to_rfc3339()).await
    }

    /// Expire any pending requests past their `expires_at`. Called periodically by
    /// the background sweep. Returns the number expired.
    pub async fn sweep_expired(&self) -> anyhow::Result<usize> {
        let now = chrono::Utc::now().to_rfc3339();
        let stale = self.store.pending_expired(&now).await?;
        let mut n = 0;
        for mut req in stale {
            req.status = ApprovalStatus::Expired;
            req.decided_at = Some(now.clone());
            // CAS from Pending: only expire (and tear down) if we win the race
            // against a concurrent approve/reject — otherwise the decider owns it.
            if self.store.try_transition(&req).await.unwrap_or(false) {
                // A rejected/expired workflow gate must fail its run so it doesn't
                // hang suspended forever.
                if let Some(action) = req.action.clone() {
                    reject_action(&action).await;
                }
                n += 1;
            }
        }
        Ok(n)
    }
}
