use super::*;

/// Publish the identity vault, scheduled Core jobs, the MCP registry and secret vaults.
pub(super) async fn open_identity_and_vaults(mcp_registry: &Arc<sidecar::mcp::McpRegistry>) {
    // Identity Vault (#517): crypto-sealed per-domain agent connections. Opens its
    // own SQLite store under ~/.ryu/identities.db and is published as a
    // process-global so off-`ServerState` callers — the health-check loop and the
    // shared elicitation seam (later units) — reach it without threading it
    // through. Credential state is sealed via `ryu_crypto::global_cipher()`.
    match crate::identity::IdentityStore::open(crate::paths::db_dir()) {
        Ok(store) => {
            crate::identity::set_global(store.clone());
            // Publish the health-check engine (#524) and ensure its single
            // backing scheduler job so the sweep rides the same tick loop as
            // monitors. The engine resolves each connection's backend from the
            // per-domain `CredentialSourceRegistry` (default `manual`, env
            // overridable) and flips stale `AUTHENTICATED` connections back to
            // `NEEDS_AUTH`. The interval is the swappable
            // `RYU_IDENTITY_HEALTH_INTERVAL` env knob.
            let registry = crate::identity::CredentialSourceRegistry::from_env();
            let health_engine = crate::identity::health::HealthEngine::new(store, registry);
            crate::identity::health::set_global_engine(health_engine);
            if let Err(e) = ensure_identity_health_job() {
                tracing::warn!("identity health job not scheduled: {e}");
            }
        }
        Err(e) => tracing::warn!("identity store unavailable: {e:#}"),
    }

    // Ensure the single continual-learning cycle job exists so it rides the
    // scheduler tick loop. It no-ops unless the user opted in (and, if configured,
    // only fires inside the sleep window), so scheduling it is always safe.
    if let Err(e) = ensure_learning_cycle_job() {
        tracing::warn!("learning cycle job not scheduled: {e}");
    }

    // Publish the MCP registry globally so the workflow `Tool` node can invoke
    // tools (the executor is a free function with no ServerState handle).
    crate::sidecar::mcp::set_global_registry(Arc::clone(&mcp_registry));
    // Per-plugin BYOK secrets (the `env:` secret-header fallback + the `secret`
    // settings field). Published as a process-global for the same reason as the KV
    // store above: `tool_exec::resolve_secret_token` is a free fn with no
    // ServerState handle. Best-effort — if the at-rest master key can't be resolved
    // the store simply stays unpublished and `env:` resolves from process env only,
    // exactly as it did before this store existed.
    match crate::plugin_secrets::open_default() {
        Ok(store) => {
            // Hydrate the Composio verifier from the encrypted Webhooks-app
            // slot before the public ingress starts. An operator-provided
            // `COMPOSIO_WEBHOOK_SECRET` still wins inside the verifier.
            match store
                .get(
                    ryu_composio::triggers::WEBHOOK_SECRET_STORE_OWNER,
                    ryu_composio::triggers::WEBHOOK_SECRET_STORE_KEY,
                )
                .await
            {
                Ok(secret) => ryu_composio::triggers::set_stored_webhook_secret(secret),
                Err(e) => tracing::warn!(
                    "stored Composio webhook secret unavailable; falling back to env: {e:#}"
                ),
            }
            crate::plugin_secrets::set_global(store);
            if let Some(store) = crate::plugin_secrets::global() {
                // Declarative self-init (`RYU_VAULT_INIT_FILE`) before the
                // scheduler and routes act on the store.
                crate::vault::declarative::apply_at_startup(store).await;
                crate::vault::scheduler::spawn(store);
                crate::vault::broker::spawn(store);
                crate::vault::external::spawn(store);
                crate::vault::seal_ext::spawn_auto_unseal(store);
            }
        }
        Err(e) => tracing::warn!("plugin secret store unavailable: {e:#}"),
    }
    // Pi provider / ACP agent account vault: the sealed multi-account store for
    // provider logins, BYOK keys and ACP sign-ins. Best-effort — if the at-rest
    // master key can't be resolved the vault stays unpublished: legacy entries in
    // `auth.json` keep working, but a new API key is refused rather than written
    // in plaintext. Publish AFTER the master key resolves (the plugin-secret
    // store above is that same latch).
    match crate::pi_config::accounts::open_default() {
        Ok(vault) => {
            crate::pi_config::accounts::set_global(vault);
            // Import anything the user configured before this vault existed, then
            // make auth.json/models.json mirror the active accounts.
            crate::pi_config::sync_plaintext_into_vault();
            crate::pi_config::materialize_active_accounts();
        }
        Err(e) => tracing::warn!("pi accounts vault unavailable: {e:#}"),
    }
    // Per-conversation Pi credential projections are kept only while their Pi
    // runs; remove any a crash or power loss left behind.
    let swept = crate::pi_config::session_accounts::sweep_projections();
    if swept > 0 {
        tracing::info!(swept, "removed stale Pi account projections");
    }
    // Composio event-trigger store: registers trigger instances with Composio and
    // fires the bound agent when the webhook arrives. Published as a process-global
    // so the webhook + CRUD handlers reach it without threading through ServerState.
    // Install Core's ComposioHost (workflow/agent run fan-out) before publishing
    // the store, so a webhook that arrives during startup can fire.
    crate::composio_host::install();
    match crate::composio_triggers::ComposioTriggerStore::open(
        reqwest::Client::new(),
        crate::paths::db_path("composio-triggers.db"),
    ) {
        Ok(store) => crate::composio_triggers::set_global(store),
        Err(e) => tracing::warn!("composio triggers store unavailable: {e:#}"),
    }
}
