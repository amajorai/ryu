use super::*;

/// Loaded plugin manifests, the plugin store and the skill registry.
pub(super) struct PluginBoot {
    pub(super) incompatible_manifests:
        Arc<tokio::sync::RwLock<Vec<crate::plugin_manifest::IncompatibleManifest>>>,
    pub(super) app_manifests: Arc<tokio::sync::RwLock<Vec<crate::plugin_manifest::PluginManifest>>>,
    pub(super) app_store: crate::plugins::PluginStore,
    pub(super) skill_registry: ryu_skills::SkillRegistry,
}

/// Load plugin manifests, seed plugin-backed flags and pre-installed plugins, and load skills.
pub(super) async fn load_plugins(
    sidecars: &Arc<SidecarManager>,
    offline_test_bootstrap: bool,
) -> PluginBoot {
    // App manifests: wrapped in RwLock so self-build tools can hot-install new
    // apps without restarting Core (U57). The self-build tools write into this
    // store and `GET /api/apps` reads from it; no restart required.
    // `load_all` splits the pass in two: `compatible` is what the runtime gets (and
    // is byte-for-byte what `load()` used to return), while `incompatible` holds the
    // plugins this node's version cannot run. The second list exists ONLY so the
    // marketplace can show them greyed with what they need — it is never activated.
    let loaded_manifests = {
        let mut loaded = crate::plugin_manifest::PluginManifestLoader::load_all();
        let runtime = crate::plugin_manifest::PluginManifestLoader::load_runtime();
        loaded.compatible = runtime;
        loaded
    };
    if !loaded_manifests.incompatible.is_empty() {
        tracing::info!(
            count = loaded_manifests.incompatible.len(),
            "plugins held back as incompatible with this node's versions"
        );
    }
    let incompatible_manifests = Arc::new(tokio::sync::RwLock::new(loaded_manifests.incompatible));
    let app_manifests = Arc::new(tokio::sync::RwLock::new(loaded_manifests.compatible));
    // Home dashboards, quests, monitors and meetings are reached only through the
    // capabilities those apps provide, over the generic capability consumer:
    // `crate::dashboard_capabilities` (hardware device dashboards + nudge loop, and
    // `dashboard_builder` through the registry's `with_capabilities` consumer),
    // `crate::scheduler::app_jobs` (the generic `jobs.list` / `jobs.run` app-job
    // contract: `JobTarget::AppJob` ticks and their reconcile) and
    // `crate::scheduler::legacy_quest_jobs` (the frozen `JobTarget::Quest` residue),
    // `crate::meeting_capabilities` (hardware
    // ambient ingest), and `server::data_admin` (the `data.count` / `data.purge`
    // fan-out behind app-owned Danger Zone rows).
    let app_store = match crate::plugins::PluginStore::open() {
        Ok(store) => store,
        Err(e) => boot_fail!("failed to open app store: {e:#}"),
    };
    // The state-free scheduler has no `ServerState`, so its app-backed job targets
    // reach their providers through the process-global consumer.
    crate::sidecar::capability_consumer::install_global(
        crate::sidecar::capability_consumer::CapabilityConsumer::new(
            Arc::clone(&sidecars),
            Arc::clone(&app_manifests),
            app_store.clone(),
        ),
    );

    // Seed gateway egress compression from the headroom plugin's persisted state
    // (#425, policy-driven). The plugin's enabled flag is the single source of
    // truth: if it is installed, its state wins (so a Core/gateway restart never
    // silently reverts what the plugin set); otherwise the `RYU_HEADROOM_ENABLED`
    // dev seed (read lazily by `headroom::is_enabled`) stands. This runs before
    // the headroom proxy + gateway are spawned below, so both see the right state.
    if let Ok(Some(rec)) = app_store
        .get(crate::sidecar::headroom::HEADROOM_PLUGIN_ID)
        .await
    {
        crate::sidecar::headroom::set_enabled(rec.enabled);
        // Also seed the data-driven compression policy (service URL/token/timeout/
        // min) from the plugin manifest, so a restart preserves the configured
        // service — not just the on/off flag. Find the compression Policy runnable
        // in the headroom manifest and parse its `definition`.
        if rec.enabled {
            if let Some(def) = crate::plugin_manifest::PluginManifestLoader::load()
                .iter()
                .find(|m| m.id == crate::sidecar::headroom::HEADROOM_PLUGIN_ID)
                .and_then(|m| {
                    m.runnables
                        .iter()
                        .filter(|r| r.kind == crate::runnable::RunnableKind::Policy)
                        .filter_map(|r| r.config.as_ref())
                        .filter_map(|c| {
                            serde_json::from_value::<crate::plugin_manifest::schema::PolicyConfig>(
                                c.clone(),
                            )
                            .ok()
                        })
                        .find(|c| c.policy_type == "compression")
                        .map(|c| c.definition)
                })
            {
                crate::sidecar::headroom::set_compression_policy(
                    crate::sidecar::headroom::CompressionPolicy::from_definition(&def),
                );
            }
        }
    }
    // Seed the gateway-policy plugin flags (#447) from their persisted enabled
    // state, exactly like headroom above: if the firewall/routing plugin is
    // installed, its stored enabled flag wins so a gateway restart never reverts
    // what the user set; otherwise the dev env seed (GATEWAY_FIREWALL_ENABLED /
    // GATEWAY_SMART_ROUTING_ENABLED, read lazily) stands. Runs before the gateway
    // is spawned so `gateway_spawn_env` reads the right state.
    if let Ok(Some(rec)) = app_store
        .get(crate::sidecar::gateway_policy::FIREWALL_PLUGIN_ID)
        .await
    {
        crate::sidecar::gateway_policy::set_firewall_enabled(rec.enabled);
    }
    if let Ok(Some(rec)) = app_store
        .get(crate::sidecar::gateway_policy::ROUTING_PLUGIN_ID)
        .await
    {
        crate::sidecar::gateway_policy::set_routing_enabled(rec.enabled);
    }
    // Seed system-wide predictive typing from the Predict plugin's persisted
    // enabled state (opt-in, Core-tier): installing/enabling the plugin is the
    // single on/off switch, so a restart must preserve it before
    // `/api/predict/complete` first reads `predict::is_enabled()`. No record
    // (never installed) ⇒ stays off (the AtomicBool default).
    if let Ok(Some(rec)) = app_store.get(crate::predict::PREDICT_PLUGIN_ID).await {
        crate::predict::set_enabled(rec.enabled);
    }
    // Seed system-wide dictation from the Dictation plugin's persisted enabled
    // state. Pre-installed (see CORE_PREINSTALLED): Island hosts the OS surface and
    // reads the synced `dictation` preference `enabled` field for live shortcut
    // rebinding when the plugin flips.
    if let Ok(Some(rec)) = app_store.get(crate::dictation::DICTATION_PLUGIN_ID).await {
        crate::dictation::set_enabled(rec.enabled);
    }
    // Pre-installed plugin seeding (#444) — the ONE definition lives in
    // `plugins::seed`. It seeds every `CORE_PREINSTALLED` plugin INSTALLED +
    // ENABLED on a fresh install (the three companions with their grants +
    // prebuilt `ui_code` bundle, everything else with empty grants), in
    // DEPENDENCY ORDER, and refuses to enable a plugin whose `requires` cannot be
    // satisfied from the pre-installed set.
    //
    // It writes the store directly rather than calling `lifecycle::enable_app`
    // because the Gateway is not spawned until further below and `enable_app`
    // fails closed on an unreachable Gateway — routing the seed through it would
    // disable every pre-installed plugin on every fresh install. The dependency
    // GRAPH is still honoured (see the module docs); only the Gateway grant call
    // is bypassed, for a fixed first-party grant set.
    //
    // One-time and user-respecting: a plugin with any existing record (enabled OR
    // disabled) is left alone, so a user's disable survives restarts.
    //
    // Skipped entirely under Safe Mode. Both calls WRITE lifecycle records, and
    // safe mode's whole non-destructive property is that it never writes the
    // `enabled` column — a seed or a migration running in a diagnostic boot would
    // persist state the user never asked for. Both are one-time and gated on
    // record presence / schema version, so the next normal boot performs them.
    if crate::safe_mode::is_active() {
        tracing::info!("safe mode: skipping pre-installed plugin seed and one-time migrations");
    } else {
        let manifests = app_manifests.read().await.clone();
        // Open plugin-owned KV before the seed migrations: v6 moves legacy
        // unscoped rows through this process-global handle. Safe mode leaves the
        // store unopened, preserving its non-destructive boot contract.
        match crate::plugin_storage::open_default() {
            Ok(store) => crate::plugin_storage::set_global(store),
            Err(e) => tracing::warn!("plugin storage unavailable: {e:#}"),
        }
        // Repair ALREADY-INSTALLED stores before seeding fresh defaults. The
        // migration must see the user's legacy disabled record first; seeding it
        // before migration would recreate a pre-installed row and erase that choice.
        crate::plugins::seed::run_one_time_migrations(&app_store, &manifests).await;
        if !offline_test_bootstrap {
            crate::plugins::seed::seed_preinstalled(&app_store, &manifests).await;
        }
    }
    // Re-read dictation after pre-installed seed: a fresh install may have just
    // created the enabled record, and the pre-seed AtomicBool read above would
    // have missed it.
    if let Ok(Some(rec)) = app_store.get(crate::dictation::DICTATION_PLUGIN_ID).await {
        crate::dictation::set_enabled(rec.enabled);
    }
    // Agent Skill registry (M3 / issue #145). Loads from the universal Agent
    // Skills directory `~/.claude/skills/<id>/SKILL.md` (overridable via
    // `RYU_SKILLS_DIR`), the same location Claude Code and the skills CLI read.
    // A missing directory is not an error — Core runs without skills until the user
    // installs any. Skills are injected into outgoing chat requests by the adapter.
    // Publish the Ryu data folder to the extracted `ryu_skills` crate BEFORE
    // `SkillRegistry::load()`, whose `ensure_active_set_seeded` + `migrate_legacy_skills`
    // touch `~/.ryu` — so they resolve against the real (possibly relocated) folder,
    // not the crate's `$RYU_DIR`/`~/.ryu` fallback.
    ryu_skills::set_data_dir(crate::paths::ryu_dir());
    let skill_registry = ryu_skills::SkillRegistry::load();
    // The flagship Ryu assistant owns the platform operating layer, while the
    // detailed reference stays a normal progressive skill that other assistants
    // can load when they need to help configure Ryu.
    skill_registry.register_builtin_skill(
        crate::ryu_platform::SKILL_ID.to_owned(),
        crate::ryu_platform::SKILL_NAME.to_owned(),
        Some(crate::ryu_platform::SKILL_DESCRIPTION.to_owned()),
        crate::ryu_platform::SKILL_INSTRUCTIONS.to_owned(),
    );
    PluginBoot {
        incompatible_manifests,
        app_manifests,
        app_store,
        skill_registry,
    }
}
