//! Usage snapshots, subscriptions and Gateway budget and audit reads.
// test-exempt: moved verbatim out of plugin_host/bridge.rs; tests in bridge/tests.rs and bridge/runtime_tests.rs.

use super::*;

impl PluginHookBridge {
    /// `host.usageSnapshot(args)` accepts exactly one of two forms:
    ///
    /// - `{ agent_id }`: the same normalized, read-only subscription windows
    ///   shown in the composer. A Ryu subscription provider id reads the vault's
    ///   active account. The credential reader never refreshes tokens and the
    ///   snapshot contains no credential material.
    /// - `{ provider_id, account_id? }`: every saved account of one provider,
    ///   label-free and cache-only (a miss is `pending` and schedules a
    ///   background read), so a turn hook never waits on a vendor. Node
    ///   owner/admin only.
    pub(super) async fn usage_snapshot(&self, args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_USAGE_READ) {
            return err(format!(
                "capability '{GRANT_USAGE_READ}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        let agent_id = match parse_usage_args(&args) {
            Ok(UsageArgs::Agent(agent_id)) => agent_id,
            Ok(UsageArgs::Provider {
                provider_id,
                account_id,
            }) => return self.provider_usage(provider_id, account_id).await,
            Err(message) => return err(message),
        };
        if !crate::fleet::is_agent_available(agent_id) {
            return err(
                "host.usageSnapshot agent is unavailable under organization policy".to_owned(),
            );
        }
        // A Ryu subscription provider id reads the owner's active saved
        // account, so it carries the same owner gate as the provider form.
        if crate::subscriptions::provider_kind(agent_id)
            == Some(crate::subscriptions::ProviderKind::Subscription)
            && !self.usage_admin_allowed()
        {
            return err(
                "host.usageSnapshot provider readings are visible to the node owner only"
                    .to_owned(),
            );
        }
        if let Err(response) = crate::server::enforce_agent_resource_permission(
            &self.state,
            &self.verified_caller,
            crate::identity_verify::permissions::AGENT_VIEW,
            agent_id,
        )
        .await
        {
            return err(format!(
                "host.usageSnapshot agent is not authorized (HTTP {})",
                response.status()
            ));
        }
        match serde_json::to_value(crate::subscriptions::reading::agent_reading(agent_id).await) {
            Ok(snapshot) => ok(snapshot),
            Err(e) => err(e.to_string()),
        }
    }

    /// The `{ provider_id, account_id? }` form of `host.usageSnapshot`. Cache
    /// only and label-free: account labels never reach a turn hook.
    pub(super) async fn provider_usage(
        &self,
        provider_id: &str,
        account_id: Option<&str>,
    ) -> InvokeOutcome {
        if !self.usage_admin_allowed() {
            return err(
                "host.usageSnapshot provider readings are visible to the node owner only"
                    .to_owned(),
            );
        }
        // With an account named, only that account is probed on a miss.
        let snapshot = crate::subscriptions::snapshot(crate::subscriptions::SnapshotQuery {
            provider_id: Some(provider_id.to_owned()),
            usage: crate::subscriptions::UsageMode::Cached,
            include_labels: false,
            max_age: crate::subscriptions::DEFAULT_MAX_AGE,
            only_account: account_id.map(str::to_owned),
        })
        .await;
        let provider = snapshot
            .providers
            .into_iter()
            .find(|provider| provider.provider_id == provider_id);
        // The raw cached snapshots need each account's credential revision,
        // which is a vault read: collect them off the async workers.
        let wanted: Vec<String> = provider
            .iter()
            .flat_map(|provider| provider.accounts.iter())
            .filter(|row| account_id.is_none_or(|wanted| row.account_id == wanted))
            .map(|row| row.account_id.clone())
            .collect();
        let owned_provider = provider_id.to_owned();
        let cached: std::collections::HashMap<String, (ryu_usage::UsageSnapshot, String)> =
            crate::subscriptions::blocking(move || {
                wanted
                    .into_iter()
                    .filter_map(|account| {
                        cached_account_snapshot(&owned_provider, &account).map(|hit| (account, hit))
                    })
                    .collect()
            })
            .await;
        ok(provider_usage_projection(
            provider.as_ref(),
            provider_id,
            account_id,
            |_, account| cached.get(account).cloned(),
        ))
    }

    /// `host.subscriptions_list` / `host.subscriptions_usage` — the owner-tier
    /// (T1) subscription inventory with account labels. Fails closed: grant,
    /// then node owner/admin, then argument validation.
    pub(super) async fn subscriptions(&self, method: &str, args: Value) -> InvokeOutcome {
        if let Err(message) = subscriptions_gate(
            &self.plugin_id,
            self.grants.contains(GRANT_SUBSCRIPTIONS_READ),
            || self.usage_admin_allowed(),
        ) {
            return err(message);
        }
        let args = if args.is_null() { json!({}) } else { args };
        let result = if method == "subscriptions_list" {
            self.subscriptions_list(args).await
        } else {
            self.subscriptions_usage(args).await
        };
        match result {
            Ok(value) => ok(value),
            Err(message) => err(message),
        }
    }

    pub(super) async fn subscriptions_list(&self, args: Value) -> Result<Value, String> {
        let args: SubscriptionsListArgs = serde_json::from_value(args)
            .map_err(|error| format!("subscriptions.list received invalid arguments: {error}"))?;
        if let Some(provider_id) = args.provider_id.as_deref() {
            validate_subscription_id("providerId", provider_id)?;
        }
        let mut usage = parse_list_usage(args.usage.as_deref())?;
        if usage == crate::subscriptions::UsageMode::Refresh
            && !self.take_live_read(args.provider_id.as_deref().unwrap_or("*"), "*")
        {
            usage = crate::subscriptions::UsageMode::Cached;
        }
        let snapshot = crate::subscriptions::snapshot(crate::subscriptions::SnapshotQuery {
            provider_id: args.provider_id,
            usage,
            include_labels: true,
            max_age: crate::subscriptions::DEFAULT_MAX_AGE,
            only_account: None,
        })
        .await;
        serde_json::to_value(snapshot).map_err(|error| error.to_string())
    }

    pub(super) async fn subscriptions_usage(&self, args: Value) -> Result<Value, String> {
        let args: SubscriptionsUsageArgs = serde_json::from_value(args)
            .map_err(|error| format!("subscriptions.usage received invalid arguments: {error}"))?;
        validate_subscription_id("providerId", &args.provider_id)?;
        if let Some(account_id) = args.account_id.as_deref() {
            validate_subscription_id("accountId", account_id)?;
        }
        let account = args.account_id.as_deref().map_or(
            crate::subscriptions::AccountSel::Active,
            crate::subscriptions::AccountSel::Exact,
        );
        let mode = if self.take_live_read(
            &args.provider_id,
            args.account_id.as_deref().unwrap_or("@active"),
        ) {
            crate::subscriptions::UsageMode::Refresh
        } else {
            crate::subscriptions::UsageMode::Cached
        };
        let reading = crate::subscriptions::reading::read_with(
            &args.provider_id,
            account,
            crate::subscriptions::reading::ReadOptions {
                mode,
                max_age: crate::subscriptions::DEFAULT_MAX_AGE,
                model: None,
                include_label: true,
            },
        )
        .await;
        serde_json::to_value(reading).map_err(|error| error.to_string())
    }

    /// Claim this plugin's live-read slot for one provider account.
    pub(super) fn take_live_read(&self, provider_id: &str, account_id: &str) -> bool {
        subscription_live_reads().try_acquire(
            (
                self.plugin_id.clone(),
                provider_id.to_owned(),
                account_id.to_owned(),
            ),
            std::time::Instant::now(),
            SUBSCRIPTION_LIVE_READ_INTERVAL,
        )
    }

    /// `host.gatewayBudgetSpend()` — read the Gateway-owned charged-spend
    /// counters and configured caps without exposing its admin credential.
    pub(super) async fn gateway_budget_spend(&self, _args: Value) -> InvokeOutcome {
        if !self.grants.contains(GRANT_USAGE_READ) {
            return err(format!(
                "capability '{GRANT_USAGE_READ}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if !self.usage_admin_allowed() {
            return err("host.gatewayBudgetSpend requires a node administrator".to_owned());
        }
        let url = format!(
            "{}/v1/budget/spend",
            crate::sidecar::gateway::gateway_url().trim_end_matches('/')
        );
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
        {
            Ok(client) => client,
            Err(error) => return err(format!("Gateway budget client unavailable: {error}")),
        };
        let mut request = client.get(url);
        if let Some(token) = crate::sidecar::gateway::gateway_admin_key() {
            request = request.bearer_auth(token);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                return ok(json!({
                    "reachable": false,
                    "error": "Gateway budget is unavailable",
                    "detail": error.to_string(),
                    "users": {},
                    "agents": {},
                    "sessions": {},
                    "limits": {},
                }));
            }
        };
        if !response.status().is_success() {
            return ok(json!({
                "reachable": false,
                "status": response.status().as_u16(),
                "error": "Gateway budget request was refused",
                "users": {},
                "agents": {},
                "sessions": {},
                "limits": {},
            }));
        }
        match response.json::<Value>().await {
            Ok(value) => ok(json!({
                "reachable": true,
                "users": value.get("users").cloned().unwrap_or_else(|| json!({})),
                "agents": value.get("agents").cloned().unwrap_or_else(|| json!({})),
                "sessions": value.get("sessions").cloned().unwrap_or_else(|| json!({})),
                "limits": value.get("limits").cloned().unwrap_or_else(|| json!({})),
                "currency": value.get("currency").cloned().unwrap_or_else(|| json!("USD")),
                "unit": value.get("unit").cloned().unwrap_or_else(|| json!("micro_usd")),
            })),
            Err(error) => ok(json!({
                "reachable": false,
                "error": "Gateway budget response was invalid",
                "detail": error.to_string(),
                "users": {},
                "agents": {},
                "sessions": {},
                "limits": {},
            })),
        }
    }

    /// `host.gatewayAudit({ limit })` — read administrative Gateway audit rows.
    /// A separate audit grant and node administrator authority are both required;
    /// ordinary usage permission never authorizes cross-caller records.
    pub(super) async fn gateway_audit(&self, args: Value) -> InvokeOutcome {
        let current = match self.state.app_store.get(&self.plugin_id).await {
            Ok(Some(record)) if record.enabled => {
                crate::plugin_host::current_approved_grants(
                    &self.state,
                    &self.plugin_id,
                    &record.approved_grants,
                )
                .await
            }
            _ => HashSet::new(),
        };
        if !self.grants.contains(GRANT_USAGE_AUDIT) || !current.contains(GRANT_USAGE_AUDIT) {
            return err(format!(
                "capability '{GRANT_USAGE_AUDIT}' not granted to plugin '{}'",
                self.plugin_id
            ));
        }
        if !self.usage_admin_allowed() {
            return err("host.gatewayAudit requires a node administrator".to_owned());
        }
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(100)
            .clamp(1, 100) as u32;
        let url = format!(
            "{}/v1/audit?limit={limit}",
            crate::sidecar::gateway::gateway_url().trim_end_matches('/')
        );
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
        {
            Ok(client) => client,
            Err(error) => return err(format!("Gateway audit client unavailable: {error}")),
        };
        let mut request = client.get(url);
        if let Some(token) = crate::sidecar::gateway::gateway_admin_key() {
            request = request.bearer_auth(token);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(_error) => {
                return ok(json!({
                    "reachable": false,
                    "error": "Gateway audit is unavailable",
                    "entries": [],
                }));
            }
        };
        if !response.status().is_success() {
            return ok(json!({
                "reachable": false,
                "status": response.status().as_u16(),
                "error": "Gateway audit request was refused",
                "entries": [],
            }));
        }
        match response.json::<Value>().await {
            Ok(value) => ok(json!({
                "reachable": true,
                "entries": value.get("entries").cloned().unwrap_or_else(|| json!([])),
                "count": value.get("count").cloned().unwrap_or_else(|| json!(0)),
            })),
            Err(error) => ok(json!({
                "reachable": false,
                "error": format!("Gateway audit response was malformed: {error}"),
                "entries": [],
            })),
        }
    }
}
