use super::*;

// ── MCP tool bridge gate (split from egress routing) ───────────────────
//
// These assert on `acp_tool_bridge_enabled` — the SAME function
// `run_acp_instance` calls — rather than re-deriving the rule, so a change to
// the composition (or to the default) fails here instead of only in a live
// session nobody runs in CI.

/// The headline behaviour change: an ACP agent nobody has configured now gets
/// the bridge. Before the split this required opting into gateway EGRESS,
/// which is why an installed agent had no Ryu tools out of the box.
#[test]
fn fresh_acp_agent_gets_the_tool_bridge() {
    let _guard = crate::agent_routing::TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    crate::agent_routing::set_bridge_from_json("");
    // Egress explicitly OFF for this agent — the bridge must not care.
    crate::agent_routing::set_from_json(r#"{"acp:goose": false}"#);
    assert!(acp_tool_bridge_enabled("npx -y goose-acp", "acp:goose"));
    assert!(!crate::agent_routing::is_gateway_routing("acp:goose"));
}

/// The opt-out must be reachable. A default-ON gate whose `false` never lands
/// is not a toggle, it is a constant with a misleading name.
#[test]
fn explicit_opt_out_withholds_the_bridge() {
    let _guard = crate::agent_routing::TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    crate::agent_routing::set_bridge_from_json(r#"{"acp:goose": false}"#);
    assert!(!acp_tool_bridge_enabled("npx -y goose-acp", "acp:goose"));
    // Scoped to that agent id only.
    assert!(acp_tool_bridge_enabled("npx -y goose-acp", "acp:opencode"));
}

/// pi-acp advertises no MCP-server support, so the transport guard must win
/// over the (now ON) preference default in BOTH orders of configuration —
/// otherwise defaulting the bridge on would make Core inject into an agent
/// that cannot accept it. Covers the managed `ryu` engine's command too,
/// which carries `PI_CODING_AGENT_DIR` but is still pi-acp.
#[test]
fn pi_acp_never_gets_the_bridge_despite_the_on_default() {
    let _guard = crate::agent_routing::TEST_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    // Unconfigured (the default-ON path) …
    crate::agent_routing::set_bridge_from_json("");
    assert!(!acp_tool_bridge_enabled(&pi_acp_cmd_gated(), "acp:pi"));
    // … and explicitly opted IN, which must not override a transport fact.
    crate::agent_routing::set_bridge_from_json(r#"{"ryu": true, "acp:pi": true}"#);
    assert!(!acp_tool_bridge_enabled(&pi_acp_cmd_gated(), "acp:pi"));
    assert!(!acp_bridge_supported(&pi_acp_cmd_gated()));
    let managed = format!("PI_CODING_AGENT_DIR=/tmp/pi {}", pi_acp_cmd_gated());
    assert!(!acp_tool_bridge_enabled(&managed, "ryu"));
    // A non-pi transport with the same preference IS enabled, proving the
    // rejection above came from the transport guard and not a stuck map.
    assert!(acp_tool_bridge_enabled("npx -y claude-code-acp", "ryu"));
}

// ── Tool-access classification (which road, if any) ───────────────────
//
// These pin the CLASSIFIER, not any claim about the pi-acp npm package: a
// Rust unit test cannot observe what `dist/index.js` does with
// `params.mcpServers`. That claim lives in `acp_bridge_supported`'s doc
// comment, with the version and date it was verified against.

/// Every non-pi transport takes the in-process bridge — the road the whole
/// `mcp_bridge` module exists to serve.
#[test]
fn non_pi_transports_are_classified_as_bridge() {
    for cmd in [
        "npx -y claude-code-acp",
        "npx -y @zed-industries/codex-acp",
        "npx -y goose-acp",
        "/usr/local/bin/my-own-agent --acp",
    ] {
        assert_eq!(ryu_tool_access(cmd), RyuToolAccess::Bridge, "{cmd}");
    }
}

/// The flagship. Its spawn command is pi-acp (so no bridge) but carries
/// `PI_CODING_AGENT_DIR`, which is what makes the managed Pi load the
/// `ryu-mcp` extension — the road that gives the DEFAULT agent its tools.
/// Asserted on BOTH platform spellings of the env prefix, because the Windows
/// `set VAR=…&&` form is the one a POSIX-only substring test would miss.
#[test]
fn managed_pi_is_classified_as_pi_extension() {
    let posix = format!("PI_CODING_AGENT_DIR=/tmp/pi-agent {}", pi_acp_cmd_gated());
    assert_eq!(ryu_tool_access(&posix), RyuToolAccess::PiExtension);
    let windows = "cmd /c set PI_CODING_AGENT_DIR=C:\\pi&& npx -y pi-acp";
    assert_eq!(ryu_tool_access(windows), RyuToolAccess::PiExtension);
}

/// The gap this classification exists to make visible: bare `acp:pi` (the
/// user's own `~/.pi`) and any custom agent bound to the `acp:pi` engine get
/// NEITHER road. The bridge is unsupported by the transport and the extension
/// lives only in Ryu's managed config dir, so such an agent cannot call a
/// single Ryu tool — a fact nothing surfaced before this.
#[test]
fn bare_pi_acp_is_classified_as_no_tool_access() {
    assert_eq!(ryu_tool_access(&pi_acp_cmd_gated()), RyuToolAccess::None);
}

/// The wire strings are a client contract (`probe_acp_config`'s
/// `ryuToolAccess`, which the desktop switches on to word its copy), so a
/// rename must break here rather than silently fall through a `default:` arm
/// in TypeScript.
#[test]
fn tool_access_wire_strings_are_stable() {
    assert_eq!(RyuToolAccess::Bridge.as_str(), "bridge");
    assert_eq!(RyuToolAccess::PiExtension.as_str(), "pi-extension");
    assert_eq!(RyuToolAccess::None.as_str(), "none");
}

/// `is_managed_pi` in `run_acp_instance` is derived from this classifier, and
/// it gates real behaviour (managed-Pi OAuth refresh, the LSP-server table,
/// the widget-synthesis path). So `PiExtension` must mean *exactly* what that
/// call site's original two-substring test meant — no wider, no narrower.
#[test]
fn pi_extension_matches_the_managed_pi_predicate() {
    for cmd in [
        format!("PI_CODING_AGENT_DIR=/tmp/pi {}", pi_acp_cmd_gated()),
        pi_acp_cmd_gated(),
        "npx -y claude-code-acp".to_owned(),
        // A non-pi agent that happens to carry the env var must NOT be taken
        // for the managed Pi: the extension is a Pi mechanism, and the bridge
        // is the road this command actually gets.
        "PI_CODING_AGENT_DIR=/tmp/pi npx -y claude-code-acp".to_owned(),
    ] {
        let legacy = cmd.contains("pi-acp") && cmd.contains("PI_CODING_AGENT_DIR");
        assert_eq!(
            ryu_tool_access(&cmd) == RyuToolAccess::PiExtension,
            legacy,
            "{cmd}"
        );
    }
}

/// What the bridge actually exposes: exactly the agent's own allowlist, never a
/// superset. If that ever stops holding, the ON default must be revisited.
///
/// It is **not**, on its own, the justification for defaulting ON — the baseline
/// assertion below is the reason why. `allowlist_for` resolves only from
/// `RYU_MCP_ALLOWLIST*`, so on a stock node the allowlist is `None` =
/// unrestricted, and "exactly the allowlist" is then the full built-in set. The
/// real argument is parity: the Pi-extension and openai-compat planes pass the
/// same `allowlist_for(agent_id)` and are already default-on, and every bridged
/// call still crosses `approvals::gate_tool_call`. See the module doc on
/// `crate::agent_routing`.
#[tokio::test]
async fn bridge_offers_exactly_the_agents_tool_allowlist() {
    let mcp = Arc::new(McpRegistry::empty());
    let unrestricted = mcp.tools_for_agent(None).await;
    assert!(
        !unrestricted.is_empty(),
        "the built-in providers must offer something, or this test is vacuous"
    );

    // Restrict to ONE of the tools the unrestricted agent can see.
    let keep = unrestricted[0].id.clone();
    let restricted = mcp.tools_for_agent(Some(&[keep.clone()])).await;
    let ids: Vec<String> = restricted.iter().map(|t| t.id.clone()).collect();
    assert_eq!(
        ids,
        vec![keep],
        "a restricted agent sees exactly its allowlist through the bridge"
    );

    // An allowlist naming nothing real yields no registry tools at all — the
    // bridge cannot widen an allowlist, only honour it. (The always-on
    // meta/discovery tools are added on top and are not a grant: every call
    // still re-enters `McpRegistry::call_tool`'s allowlist check.)
    let none = mcp
        .tools_for_agent(Some(&["no-such-server".to_owned()]))
        .await;
    assert!(none.is_empty());
}

// ── Managed-Pi widget synthesis (Round A) ──────────────────────────────
//
// The `ryu-mcp` Pi extension stamps `details.ryuWidget = { tool, arguments,
// output }` on its tool result; pi-acp preserves it as ACP `rawOutput`. These
// cover the NEW extraction/gating (`pi_widget_binding`) and the end-to-end
// synthesis into a `ToolWidgetEvent` via the SHARED `build_widget_event`, using
// a real in-process app (`checklist.render`) so the binding + HTML resolve.

#[test]
fn pi_widget_binding_extracts_only_on_completed_with_marker() {
    let raw = ryu_widget_raw_output("checklist.render", serde_json::json!({ "items": [] }));

    // Completed + marker → extracted (tool, args, mcp result).
    let got = pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&raw));
    let (tool, args, result) = got.expect("completed + marker extracts a binding");
    assert_eq!(tool, "checklist.render");
    assert_eq!(args["title"], serde_json::json!("Groceries"));
    assert_eq!(result["structuredContent"]["items"], serde_json::json!([]));

    // In-progress (a partial `tool_execution_update`) must NOT extract — else a
    // premature widget would render before the tool finished.
    assert!(pi_widget_binding(Some(&ToolCallStatus::InProgress), Some(&raw)).is_none());
    // Missing status → none.
    assert!(pi_widget_binding(None, Some(&raw)).is_none());
}

#[test]
fn pi_widget_binding_none_without_marker_or_fields() {
    // Completed but no `details.ryuWidget` (an ordinary Pi tool result).
    let plain = serde_json::json!({ "content": [{ "type": "text", "text": "hi" }] });
    assert!(pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&plain)).is_none());
    // Marker present but missing the required `tool` / `output` fields → none.
    let partial = serde_json::json!({ "details": { "ryuWidget": { "arguments": {} } } });
    assert!(pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&partial)).is_none());
    // No raw_output at all → none.
    assert!(pi_widget_binding(Some(&ToolCallStatus::Completed), None).is_none());
}

// ── Nested sub-step fan-out (Unit 6) ───────────────────────────────────
//
// A tool result stamps `details.ryuSteps = [{ name, input, output?, status }]`
// and pi-acp preserves it as ACP `rawOutput`. These cover the extraction only;
// the `<parent>:<n>` minting itself lives in mod.rs.

#[test]
fn pi_subagent_steps_extracts_on_every_update_not_only_completed() {
    // The deliberate DIVERGENCE from `pi_widget_binding`: steps stream, so the
    // extractor has no `Completed` gate. A widget renders once from a final
    // result; a nested transcript has to grow live, which is why this asserts
    // the opposite of `pi_widget_binding_extracts_only_on_completed_with_marker`.
    let raw = ryu_steps_raw_output(
        "done",
        serde_json::json!([
            { "name": "read", "input": { "file_path": "/a.rs" }, "status": "completed" },
        ]),
    );
    let steps = pi_subagent_steps(Some(&raw)).expect("marker extracts regardless of status");
    assert_eq!(steps.len(), 1);
    assert_eq!(steps[0]["name"], serde_json::json!("read"));
    // Status never enters the extractor at all — there is nothing to gate on.
}

#[test]
fn pi_subagent_steps_none_without_marker_or_wrong_shape() {
    // An ordinary tool result (no `details.ryuSteps`) must not fan out.
    let plain = serde_json::json!({ "content": [{ "type": "text", "text": "hi" }] });
    assert!(pi_subagent_steps(Some(&plain)).is_none());
    // The widget marker is a different seam; it must not be mistaken for steps.
    let widget = ryu_widget_raw_output("checklist.render", serde_json::json!({}));
    assert!(pi_subagent_steps(Some(&widget)).is_none());
    // Marker present but not an array → none (never mint a child from a scalar).
    let scalar = serde_json::json!({ "details": { "ryuSteps": "oops" } });
    assert!(pi_subagent_steps(Some(&scalar)).is_none());
    // No raw_output at all → none.
    assert!(pi_subagent_steps(None).is_none());
}
