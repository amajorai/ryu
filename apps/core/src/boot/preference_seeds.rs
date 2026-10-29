use super::*;

/// Resolve Safe Mode and seed the mesh/egress/fleet preferences; returns `mesh_preinstall_client`.
pub(super) async fn resolve_safe_mode_and_network_prefs(
    preferences: &server::preferences::PreferencesStore,
) -> bool {
    // ── Safe Mode (see `crate::safe_mode`) ────────────────────────────────────
    //
    // Resolved HERE and nowhere else. Everything the flag suppresses — the
    // pre-installed plugin seed, the MCP registry, the sidecar `start_all`, the
    // scheduler tick loop — is constructed further down this function, so this
    // read has to land ahead of all of them. Consulting the flag at request time
    // instead would mean boot already paid every cost the user is trying to
    // measure away, and the switch would look like it did nothing.
    //
    // Three tiers, env → sentinel file → preference. The sentinel exists so a node
    // that cannot come up (wedged store, hanging boot) can still be forced into
    // safe mode without HTTP or a healthy `preferences.db`.
    {
        let pref = preferences
            .get(crate::safe_mode::SAFE_MODE_PREF_KEY)
            .await
            .ok()
            .flatten();
        let env = std::env::var(crate::safe_mode::SAFE_MODE_ENV).ok();
        let source = crate::safe_mode::resolve_from(env.as_deref(), pref.as_deref());
        crate::safe_mode::set_resolved(source);
        if source != crate::safe_mode::SafeModeSource::Off {
            tracing::warn!(
                source = source.as_str(),
                "SAFE MODE: booting with apps, plugins, skills, user MCP servers and \
                 the scheduler disabled. Chat, agents and settings stay available."
            );
        }
    }
    // Mesh enable (#478): seed the desktop-driven `mesh-enabled` pref into the
    // process-global that `ryu_mesh::is_enabled()` consults. The `RYU_MESH_ENABLED`
    // env still wins when set. Placed here — after the prefs store opens and BEFORE
    // `create_router` (the fail-closed token gate) and the sidecar `start_all`
    // spawn — so the enabled signal is settled before anything security-relevant
    // or mesh-relevant reads it. Same pattern as entitlement/claude-config/etc.
    if let Ok(Some(value)) = preferences
        .get(crate::mesh_host::MESH_ENABLED_PREF_KEY)
        .await
    {
        ryu_mesh::set_pref_enabled(ryu_mesh::parse_enabled(Some(&value)));
    }
    // Desktop egress route (cloud-node side): start the credentialed local
    // proxy and restore the persisted routed flag BEFORE sidecars spawn, so the
    // browser app receives its proxy endpoint and never starts on a stale path.
    crate::local_egress::entry::init(preferences.clone()).await;
    // Mesh client PRE-install (separate decision from the enable above — see
    // `MESH_PREINSTALL_PREF_KEY`). Read into a plain bool HERE, beside the other
    // pref seeds, because `preferences` moves into `ServerState` long before the
    // mesh block near the end of boot that consumes it.
    let mesh_preinstall_client = crate::mesh_host::preinstall_client_wanted(
        preferences
            .get(crate::mesh_host::MESH_PREINSTALL_PREF_KEY)
            .await
            .ok()
            .flatten()
            .as_deref(),
    );
    // Managed-inference fleet coordinates. Same shape and the same reason as the
    // mesh seed above: `pi_config::apply` is synchronous and cannot await the
    // prefs store, so the pref half is read once here into a process-global that
    // the sync path consults (`RYU_MANAGED_GATEWAY_*` env still wins). This is
    // what lets a SELF-HOSTED node spend its plan's credits — the managed
    // provider routes at the hosted fleet while BYOK providers keep using the
    // local gateway.
    {
        let url = preferences
            .get(crate::sidecar::gateway::MANAGED_FLEET_URL_PREF_KEY)
            .await
            .ok()
            .flatten();
        let token = preferences
            .get(crate::sidecar::gateway::MANAGED_FLEET_TOKEN_PREF_KEY)
            .await
            .ok()
            .flatten();
        crate::sidecar::gateway::set_managed_fleet_pref(url, token);
    }
    // Managed per-request routing preferences. The request-forwarding path is
    // synchronous, so seed the encoded carrier beside the managed-fleet pair
    // before any agent can issue a request. The generic preference route keeps
    // it fresh after a desktop edit.
    if let Ok(Some(value)) = preferences
        .get(crate::sidecar::gateway::NODE_ROUTING_PREF_KEY)
        .await
    {
        crate::sidecar::gateway::set_node_routing_prefs_from_json(&value);
    }
    mesh_preinstall_client
}

/// Open the support-access audit store and run the startup expiry/draft sweeps.
pub(super) async fn sweep_startup_state(
    preferences: &server::preferences::PreferencesStore,
    conversations: &server::conversations::ConversationStore,
) -> support_access::SupportAccessStore {
    // Local support-access diagnostic channel (#546, P5): the append-only audit
    // log, plus the startup auto-disable sweep. Re-checking the hard expiry HERE
    // (a real write, not just a read-time gate) is what makes the AC's "auto-
    // disable when expired + survives a restart" true — a grant whose expiry has
    // passed is flipped off in the prefs before any request can use it.
    let support_audit = match support_access::SupportAccessStore::open_default() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open support-access audit store: {e:#}"),
    };
    match support_access::sweep_expired(&preferences).await {
        Ok(true) => tracing::info!("support-access: expired local grant auto-disabled at startup"),
        Ok(false) => {}
        Err(e) => tracing::warn!("support-access: startup expiry sweep failed: {e:#}"),
    }
    // Onboarding profile drafts persist into their conversation while they run,
    // and their jobs live only in memory: remove any a previous process left
    // half-built.
    let swept_drafts =
        server::onboarding_profile::sweep_abandoned_profile_drafts(&preferences, &conversations)
            .await;
    if swept_drafts > 0 {
        tracing::info!(
            swept_drafts,
            "onboarding: removed abandoned profile drafts at startup"
        );
    }
    support_audit
}

/// Seed provider credentials, bindings and entitlement flags from saved preferences.
pub(super) async fn seed_credential_prefs(preferences: &server::preferences::PreferencesStore) {
    // Load any user-configured Hugging Face token into the in-process resolver so
    // gated model search + downloads authenticate without an env var or restart.
    if let Ok(Some(token)) = preferences.get(hf_auth::HF_TOKEN_PREF_KEY).await {
        hf_auth::set_token(&token);
    }
    // Load the user's capability→provider binding overrides into the active
    // BindingConfig so capability resolution (enable/disable/broker) honours them
    // from boot, not only after the first PUT /api/capabilities/bindings.
    if let Ok(Some(json)) = preferences
        .get(plugins::binding::BINDING_OVERRIDES_PREF_KEY)
        .await
    {
        plugins::binding::set_active_config(plugins::binding::config_from_overrides_json(&json));
    }
    // Load the BYO SMTP transport (non-secret host/port/username/from/starttls)
    // and password into the in-process email sink so self-host alert/inbox email
    // works without an env var or restart. Both are prefs-first, env-fallback.
    // Secret custody stays kernel-side: the extracted `ryu-email-send` sink resolves
    // the password through this injected hook over Core's `smtp_auth` store. Wire it
    // before any alert can fire.
    ryu_email_send::set_password_resolver(smtp_auth::password);
    if let Ok(Some(json)) = preferences
        .get(ryu_email_send::SMTP_TRANSPORT_PREF_KEY)
        .await
    {
        ryu_email_send::apply_transport_prefs_json(&json);
    }
    if let Ok(Some(password)) = preferences.get(smtp_auth::SMTP_PASSWORD_PREF_KEY).await {
        smtp_auth::set_password(&password);
    }
    // Same for the Composio API key: load it into the in-process resolver so the
    // gateway (spawned below) inherits `COMPOSIO_API_KEY` and enables its tool
    // loop, and the composio_catalog browse endpoints authenticate.
    if let Ok(Some(key)) = preferences
        .get(composio_auth::COMPOSIO_API_KEY_PREF_KEY)
        .await
    {
        composio_auth::set_key(&key);
    }
    // Same for the OpenRouter API key (A4 / #501): load it into the in-process
    // resolver so the gateway (spawned below) inherits `OPENROUTER_API_KEY` and
    // activates its `openrouter` provider. On a managed node the operator sets
    // this once (env/pref) and every end user gets OpenRouter with zero setup.
    if let Ok(Some(key)) = preferences
        .get(openrouter_auth::OPENROUTER_API_KEY_PREF_KEY)
        .await
    {
        openrouter_auth::set_key(&key);
    }
    // Same for the cloud media provider keys (Replicate / Fal): load them into
    // their in-process resolvers so the gateway inherits `REPLICATE_API_KEY` /
    // `FAL_API_KEY` and activates its `replicate` / `fal` media providers.
    if let Ok(Some(key)) = preferences
        .get(replicate_auth::REPLICATE_API_KEY_PREF_KEY)
        .await
    {
        replicate_auth::set_key(&key);
    }
    if let Ok(Some(key)) = preferences.get(fal_auth::FAL_API_KEY_PREF_KEY).await {
        fal_auth::set_key(&key);
    }
    // Node entitlement gate (#496): seed the in-process flag so the scheduler
    // pauses autonomous automation when the desktop's trial has hard-expired
    // with no subscription/license. Absent ⇒ enabled by default (headless / OSS Core /
    // still-entitled desktop run automations normally).
    if let Ok(Some(v)) = preferences
        .get(entitlement::ENTITLEMENT_ACTIVE_PREF_KEY)
        .await
    {
        entitlement::set_active(&v);
    }
    if let Ok(Some(v)) = preferences
        .get(entitlement::MANAGED_INFERENCE_ENTITLED_PREF_KEY)
        .await
    {
        entitlement::set_managed_inference_entitled(&v);
    }
    // Same for the Artificial Analysis API key, which enriches the model catalog
    // with independent benchmark stats (intelligence/speed/price).
    if let Ok(Some(key)) = preferences
        .get(model_catalog::aa::AA_API_KEY_PREF_KEY)
        .await
    {
        model_catalog::aa::set_key(&key).await;
    }
    // And the AA fetch mode (cached daily cache vs. realtime). Defaults to cached
    // when unset, so the rate-limited API is hit at most once a day out of the box.
    if let Ok(Some(mode)) = preferences.get(model_catalog::aa::AA_MODE_PREF_KEY).await {
        model_catalog::aa::set_mode(&mode);
    }
}
