use super::*;

/// Seed agent gateway-routing, approval, trust and selection preferences.
pub(super) async fn seed_agent_routing_prefs(
    preferences: &server::preferences::PreferencesStore,
    offline_test_bootstrap: bool,
) {
    // Claude Code gateway-routing toggle: seed the in-process flag so the (sync)
    // ACP spawn path keeps the governed default unless an explicit direct-egress
    // opt-out is persisted.
    if let Ok(Some(value)) = preferences
        .get(claude_config::CLAUDE_GATEWAY_ROUTING_PREF_KEY)
        .await
    {
        claude_config::set_enabled(&value);
    }
    // RTK per-agent auto-wrap (rtk plugin, Phase 2): seed each agent's wrap flag and
    // reconcile its RTK PreToolUse hook (install when on, uninstall when off). A
    // no-op when rtk is not on PATH; best-effort so a slow/failed `rtk init` never
    // blocks the rest of boot.
    if !offline_test_bootstrap {
        rtk_config::seed_and_apply(&preferences).await;
    }
    // Command-approval gate: seed `RYU_EXEC_APPROVAL_MODE` from the pref so every
    // ACP agent's native tool calls (Claude/Codex `Bash`/`Write`/`Edit`) are
    // scanned at the `request_permission` seam. The pattern scanner is armed by
    // default; the permanent-deletion guard is stronger and remains active even
    // when this pattern mode is explicitly turned off.
    if let Ok(Some(value)) = preferences
        .get(exec_approval::EXEC_APPROVAL_MODE_PREF_KEY)
        .await
    {
        exec_approval::seed_from_pref(&value);
    }
    // Workspace trust: folders the user has said they trust. Agents working
    // anywhere else lose permission-skipping modes and headless shell approval,
    // and run under the strict OS sandbox profile.
    if let Ok(Some(value)) = preferences
        .get(workspace_trust::TRUSTED_WORKSPACES_PREF_KEY)
        .await
    {
        workspace_trust::set_from_pref(&value);
    }
    // Untrusted-content wrapping toggle: external/tool RESULTS re-entering the
    // model are boundary-wrapped + chat-template-token-stripped. Pre-installed (safe:
    // only untrusted tool output, never user text); seed only to honour an
    // explicit opt-OUT persisted by the desktop.
    if let Ok(Some(value)) = preferences
        .get(sidecar::untrusted::UNTRUSTED_WRAPPING_PREF_KEY)
        .await
    {
        sidecar::untrusted::set_enabled(&value);
    }
    // Codex gateway-routing toggle (subscription passthrough). Same governed
    // default as Claude: seed the in-process flag so the (sync) ACP spawn path
    // points the Codex subprocess at an isolated CODEX_HOME → gateway passthrough
    // unless the user explicitly opts out.
    if let Ok(Some(value)) = preferences
        .get(codex_config::CODEX_GATEWAY_ROUTING_PREF_KEY)
        .await
    {
        codex_config::set_enabled(&value);
    }
    // Generic per-agent gateway-routing toggles (the "point any agent at the
    // gateway via the OpenAI base-URL swap" feature). One pref holds a JSON map of
    // agent id → enabled; seed the in-process map so the (sync) ACP spawn path
    // injects OPENAI_BASE_URL by default. Explicit false entries keep provider
    // egress direct.
    if let Ok(Some(value)) = preferences
        .get(agent_routing::AGENT_GATEWAY_ROUTING_PREF_KEY)
        .await
    {
        agent_routing::set_from_json(&value);
    }
    // Per-agent MCP tool-bridge opt-OUTs. Independent of the egress toggle above
    // (they used to share one preference, so declining credential routing also
    // silently stripped every Ryu tool). Seeded the same way, but note the
    // asymmetry: this map holds only opt-OUTs — an absent preference is the
    // enabled-by-default case and needs no seeding at all, which is exactly what a missing
    // key here leaves behind. See `agent_routing`'s module docs.
    if let Ok(Some(value)) = preferences
        .get(agent_routing::AGENT_TOOL_BRIDGE_PREF_KEY)
        .await
    {
        agent_routing::set_bridge_from_json(&value);
    }
    // Per-agent ACP launch and session settings (command, args, env, config dir,
    // auto-compact, model allowlist, session defaults). Absent = launch as default.
    if let Ok(Some(value)) = preferences
        .get(acp_agent_settings::ACP_AGENT_SETTINGS_PREF_KEY)
        .await
    {
        acp_agent_settings::set_from_json(&value);
    }
    // Per-agent Plane A model-routing overrides (spec §1). One pref holds a JSON
    // map of agent id → SmartRoutingConfig; seed the in-process map so the (async)
    // chat-forward path can inject `ryu_smart_route` for agents that have one.
    if let Ok(Some(value)) = preferences
        .get(agent_routing::AGENT_SMART_ROUTE_PREF_KEY)
        .await
    {
        agent_routing::set_smart_routes_from_json(&value);
    }
    // Plane B agent-auto routing config (spec §2). Seed the in-process snapshot so
    // resolving the "auto" sentinel to a concrete agent needs no pref-store handle.
    if let Ok(Some(value)) = preferences
        .get(agent_routing::AGENT_AUTO_ROUTING_PREF_KEY)
        .await
    {
        agent_routing::set_auto_config_from_json(&value);
    }
    // The node-wide default selection every unset agent/model setting falls back
    // to. Seeded into an in-process snapshot for the same reason as agent-auto:
    // the sync routing path has no preference-store handle.
    if let Ok(Some(value)) = preferences.get(agent_selection::LOCAL_SELECTION_PREF).await {
        agent_selection::set_local_selection_from_json(&value);
    } else if let Ok(Some(value)) = preferences
        .get(agent_selection::GLOBAL_SELECTION_PREF)
        .await
    {
        // Legacy installations seed the local-lane snapshot from the former
        // one-default key until the new key is written.
        agent_selection::set_default_selection_from_json(&value);
    }
    if let Ok(Some(value)) = preferences.get(agent_selection::CLOUD_SELECTION_PREF).await {
        agent_selection::set_cloud_selection_from_json(&value);
    }
}
