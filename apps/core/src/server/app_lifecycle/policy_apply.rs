//! App lifecycle handlers: isolation, revocation, install, enable, activation, contributions and policies: `push_gateway_policy_section` through `apply_policy`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Push one live `PUT /v1/config` section to the RUNNING gateway through the single
/// shared [`crate::sidecar::gateway::push_config`] transport, logging the outcome. A
/// push failure (gateway unreachable / non-2xx) is logged, not fatal — the toggle's
/// process-global flag is already set, so the change still lands on the next spawn.
pub(in crate::server) async fn push_gateway_policy_section(
    client: &reqwest::Client,
    section: &str,
    patch: &serde_json::Value,
) {
    match crate::sidecar::gateway::push_config(client, patch).await {
        Ok((status, _)) if status.is_success() => {
            tracing::info!("gateway: {section} policy pushed live via PUT /v1/config (no respawn)");
        }
        Ok((status, body)) => {
            tracing::warn!("gateway: {section} policy push returned {status}: {body}");
        }
        Err(e) => {
            tracing::warn!("gateway: {section} policy push failed: {e}");
        }
    }
}

/// Sync the Dictation plugin's enabled state into the `dictation` preference
/// blob so Island's preference subscription rebinds global shortcuts live when
/// the user enables/disables the plugin. Best-effort: preference I/O failures
/// are logged and do not fail the policy apply.
pub(in crate::server) async fn sync_dictation_pref_enabled(state: &ServerState, enabled: bool) {
    let key = crate::dictation::DICTATION_PREF_KEY;
    let next = match state.preferences.get(key).await {
        Ok(Some(raw)) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(mut value) => {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("enabled".to_string(), serde_json::Value::Bool(enabled));
                }
                value.to_string()
            }
            Err(_) => serde_json::json!({ "enabled": enabled }).to_string(),
        },
        Ok(None) => serde_json::json!({ "enabled": enabled }).to_string(),
        Err(e) => {
            tracing::warn!("dictation: could not read preference to sync enabled={enabled}: {e}");
            return;
        }
    };
    if let Err(e) = state.preferences.set(key, &next).await {
        tracing::warn!("dictation: could not sync preference enabled={enabled}: {e}");
    }
}

/// Apply a firewall definition through the live Gateway config transport.
/// Shared by the plugin policy dispatcher; returns whether a live push was
/// attempted. Transport refusal remains best-effort and never rebuilds a missing
/// live firewall section from defaults.
pub(in crate::server) async fn apply_firewall_policy(
    client: &reqwest::Client,
    definition: &serde_json::Value,
    enabled: bool,
) -> bool {
    let mut gateway_touched = false;
    // Keep the flag: it seeds `gateway_spawn_env` so the INITIAL spawn
    // (and any compression-triggered respawn) boots with the firewall
    // forced on/off. The RUNTIME effect now comes from a live push.
    //
    // Only the pure on/off switch (empty config-pack) seeds the global
    // spawn-env flag; a pattern-pack plugin must not flip the global
    // switch (same decoupling as `build_firewall_patch`), else disabling
    // one pack would force the firewall off at the next spawn.
    let bundle = FirewallPolicyBundle::from_definition(definition);
    if bundle.custom_patterns.is_empty() {
        crate::sidecar::gateway_policy::set_firewall_enabled(enabled);
    }
    // Read-modify-write the LIVE gateway firewall section (GET
    // /v1/config), not Core's local toml — Core has no copy of a REMOTE
    // gateway's config, and a full-replacement firewall PUT built from an
    // empty section would silently reset `policy` to warn-only and wipe
    // `locked_fields`/`inspector`/operator patterns (a firewall bypass).
    // Fail CLOSED: if the live config can't be read (or carries no
    // firewall object), we DO NOT push a reconstructed/defaulted section
    // — the flag above still lands the change on the next spawn.
    match crate::sidecar::gateway::fetch_config(client).await {
        Ok(cfg) => match cfg.get("firewall") {
            Some(live_fw) if live_fw.is_object() => {
                let firewall = build_firewall_patch(live_fw.clone(), enabled, &bundle);
                gateway_touched = true;
                push_gateway_policy_section(client, "firewall", &json!({ "firewall": firewall }))
                    .await;
            }
            _ => tracing::warn!(
                "gateway: firewall policy toggle skipped — live GET /v1/config \
             carried no firewall object; NOT pushing a defaulted firewall \
             (would clobber enforcement). The flag is set for the next spawn."
            ),
        },
        Err(e) => tracing::warn!(
            "gateway: firewall policy toggle skipped — could not read the live \
         gateway config ({e}); NOT pushing (avoids clobbering enforcement). \
         The flag is set for the next spawn."
        ),
    }
    gateway_touched
}

/// Apply a manifest's **policy** runtime side effects (the async work the sync
/// [`RunnableRegistry`] Policy handler cannot do — it stays validate-only per the
/// Core-vs-Gateway rule). Dispatches on each `Policy` runnable's `policy_type`.
///
/// `enabled` selects direction (true on plugin-enable, false on plugin-disable).
///
/// Two distinct mechanisms, per the gateway's config surface:
/// - **live config-push** (`firewall`, `routing`): the toggle (and, for firewall,
///   its config-pack pattern set) is pushed to the RUNNING gateway via the shared
///   `PUT /v1/config` transport ([`crate::sidecar::gateway::push_config`]), which
///   hot-swaps with **no respawn** and works for a remote gateway too. Each arm
///   still flips the process-global flag ([`set_firewall_enabled`] etc.) so the
///   INITIAL spawn env is correct across a Core restart — but the runtime toggle no
///   longer respawns.
/// - **respawn** (`compression`): env-only config (`GATEWAY_COMPRESSION_*`, not in
///   the gateway's `ConfigPatch`), so it flips the flag + runs the local proxy
///   side effect and a batched `gateway.refresh()` re-reads `gateway_spawn_env`.
///
/// `sandbox` / `predict` / `dictation` are Core-local (no gateway). Unknown
/// `policy_type` is a logged no-op. All steps are best-effort and logged.
pub(in crate::server) async fn apply_policy(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
    enabled: bool,
) -> PolicyApplyOutcome {
    let policies = manifest_policies(manifest);
    if policies.is_empty() {
        return PolicyApplyOutcome::default();
    }

    // Respawn only for env-only policies (compression). Live config-push patches
    // accumulate here as (section-label, `PUT /v1/config` body) and are sent after
    // the loop, before any respawn. `firewall` is the exception: it fetches the LIVE
    // gateway config and pushes INLINE (per policy) so that two firewall policies in
    // one manifest compose correctly — the second read-modify-write sees the first's
    // patterns already applied, instead of both racing off one stale pre-loop
    // snapshot. `outcome` is declared here (not after the loop) so the inline
    // firewall push can record that the gateway was touched.
    let mut gateway_dirty = false;
    let mut config_pushes: Vec<(&'static str, serde_json::Value)> = Vec::new();
    let mut outcome = PolicyApplyOutcome::default();

    for policy in &policies {
        match policy.policy_type.as_str() {
            "compression" => {
                // ── THE PROTOCOL-HOST SEAM ──────────────────────────────────────
                // The second gateway-plugin extension shape (distinct from the
                // firewall/routing config-pack live-push above): the gateway HOSTS a
                // protocol (here the egress-compression transform in
                // `apps/gateway/src/.../compression.rs`) and the plugin is an
                // EXTERNAL HTTP SERVICE the gateway calls. A policy plugin declares
                // its service endpoint in the policy `definition`
                // (url/token/timeout_ms/min_messages/service); Core data-drives the
                // gateway to call it, hardcoding no URL — so any compression plugin,
                // not just the bundled `headroom`, works by pointing at its own
                // `/v1/compress` service (an MCP-style host/service split). This is
                // the defined extension point future provider/protocol plugins (and
                // the later WASM round) build on; it stays respawn-driven only
                // because the compression wiring is env-only (`GATEWAY_COMPRESSION_*`,
                // not in the gateway's `ConfigPatch`).
                if enabled {
                    crate::sidecar::headroom::set_compression_policy(
                        crate::sidecar::headroom::CompressionPolicy::from_definition(
                            &policy.definition,
                        ),
                    );
                } else {
                    crate::sidecar::headroom::set_compression_policy(Default::default());
                }
                crate::sidecar::headroom::set_enabled(enabled);
                // Manage the bundled local proxy only when the active service IS
                // the bundled headroom one; a third-party service URL is the
                // plugin's own process and Core only configures the gateway.
                if crate::sidecar::headroom::manages_bundled_service() {
                    if enabled {
                        if let Err(e) = state.headroom.start().await {
                            tracing::warn!(
                                "headroom: start on plugin-enable failed (compression may pass through): {e}"
                            );
                        }
                    } else if let Err(e) = state.headroom.stop().await {
                        tracing::warn!("headroom: stop on plugin-disable failed: {e}");
                    }
                }
                gateway_dirty = true;
            }
            "firewall" => {
                outcome.gateway_touched |=
                    apply_firewall_policy(&state.client, &policy.definition, enabled).await;
            }
            "routing" => {
                crate::sidecar::gateway_policy::set_routing_enabled(enabled);
                let routing = build_routing_patch(read_gateway_section("routing"), enabled);
                config_pushes.push(("routing", json!({ "routing": routing })));
            }
            "sandbox" => {
                // The wasmtime sandbox is a Core-local tool, not a gateway feature
                // — toggling it needs no gateway respawn.
                crate::sidecar::mcp::sandbox::set_enabled(enabled);
            }
            "predict" => {
                // System-wide autocomplete (the `/api/predict/*` brain used by
                // the `apps-store/predict` overlay and any predict client) — a Core-local
                // feature, no gateway respawn. Enabling this plugin IS the on/off
                // switch (there is no separate settings toggle); disabling makes
                // `complete()` refuse every request, so the feature is fully inert.
                crate::predict::set_enabled(enabled);
            }
            "dictation" => {
                // System-wide dictation + agent-ask (Island companion surface) —
                // Core-local, no gateway respawn. Enabling this plugin IS the on/off
                // switch; we also sync the `dictation` preference `enabled` field so
                // Island's preference subscription rebinds shortcuts live.
                crate::dictation::set_enabled(enabled);
                sync_dictation_pref_enabled(state, enabled).await;
            }
            other => {
                tracing::debug!(
                    "apply_policy: no runtime handler for policy_type '{other}'; \
                     validate-only (gateway owns enforcement)"
                );
            }
        }
    }

    // 1. Live config-push for the deferred hot-swappable policies (routing). This
    //    reconfigures the RUNNING gateway — local OR remote — with no respawn, so
    //    in-flight requests, rate-limit windows, and caches survive. (Firewall was
    //    already pushed inline above, off a fresh live GET.) A push failure is logged
    //    by the shared helper; the flag is still set, so the change lands on the next
    //    spawn.
    for (section, patch) in config_pushes {
        outcome.gateway_touched = true;
        push_gateway_policy_section(&state.client, section, &patch).await;
    }

    // 2. Respawn the gateway ONCE for env-only policies (compression). Batched so
    //    enabling several respawn policies at once is one refresh, not N.
    if gateway_dirty {
        outcome.gateway_touched = true;
        match state.gateway.refresh().await {
            // Core-managed gateway respawned with the new policy env — reconfigured.
            Ok(true) => {}
            // Externally managed (RYU_GATEWAY_MANAGED=0): the compression flag
            // flipped in Core's memory, but the RUNNING gateway was NOT
            // reconfigured (its config is env-only, so there is no live push to fall
            // back on). Surface this so the enable/disable response tells the caller
            // a manual restart is required rather than lying that it took effect.
            Ok(false) => {
                outcome.gateway_externally_managed = true;
                tracing::warn!(
                    "gateway: a compression policy flag changed but the gateway is externally \
                     managed (RYU_GATEWAY_MANAGED=0); the running gateway was NOT reconfigured — \
                     a manual gateway restart is required for the change to take effect"
                );
            }
            Err(e) => {
                tracing::warn!("gateway: refresh after policy change failed: {e}");
            }
        }
    }
    outcome
}
