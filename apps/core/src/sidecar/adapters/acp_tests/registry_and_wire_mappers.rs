use super::*;

// ── OpenClaw + Hermes as native ACP agents ───────────────────────────────

#[test]
fn openclaw_and_hermes_are_acp_agents() {
    // Both speak ACP natively (openclaw acp / hermes acp), so they must bind
    // as ACP — not the stale OpenAI-compat localhost ports they used before.
    let reg = AcpAgentRegistry::new();
    for id in &["openclaw", "hermes"] {
        let entry = reg.find_by_prefix(id).expect("entry present");
        assert!(
            matches!(entry.transport, AgentTransport::Acp { .. }),
            "{id} should use ACP transport"
        );
    }
    let infos = reg.list_infos();
    for id in &["openclaw", "hermes"] {
        let info = infos.iter().find(|a| &a.id == id).expect("info present");
        assert_eq!(info.transport.as_deref(), Some("acp"), "{id} transport");
    }
}

#[test]
fn openclaw_and_hermes_carry_gateway_bypass() {
    // As ACP subprocesses they make their own provider calls (OpenClaw → its
    // own WS gateway, Hermes → ~/.hermes creds); neither traverses Ryu's
    // gateway, so both must surface gateway_bypass: true.
    let infos = AcpAgentRegistry::new().list_infos();
    for id in &["openclaw", "hermes"] {
        let info = infos.iter().find(|a| &a.id == id).expect("info present");
        assert_eq!(
            info.gateway_bypass,
            Some(true),
            "{id} should carry gateway_bypass: true"
        );
    }
}

// ── Self-fetching ACP registry agents ────────────────────────────────────

#[test]
fn kiro_uses_vendor_native_acp_without_gateway_credentials() {
    let registry = AcpAgentRegistry::new_with_registry_entries(Some(vec![]));
    let entry = registry
        .find_by_prefix("acp:kiro")
        .expect("native Kiro entry");
    assert_eq!(entry.detect_binary, Some("kiro-cli"));
    assert!(entry.gateway_bypass);
    assert!(entry.direct_archive.is_none());
    assert!(entry.archive_spec.is_none());
    let AgentTransport::Acp { spawn_cmd } = &entry.transport else {
        panic!("ACP transport required")
    };
    let parsed = AcpSpawn::from_str(spawn_cmd).expect("structured native command");
    let McpServer::Stdio(stdio) = parsed.into_server() else {
        panic!("stdio required")
    };
    assert_eq!(
        stdio.command,
        resolve_in_path("kiro-cli").unwrap_or_else(|| PathBuf::from("kiro-cli"))
    );
    assert_eq!(stdio.args, ["acp", "--agent-engine", "v2"]);
    for name in UNSCOPED_ACP_BRIDGE_CREDENTIALS {
        assert!(
            stdio
                .env
                .iter()
                .any(|entry| entry.name == name && entry.value.is_empty()),
            "vendor ACP must mask inherited credential {name}"
        );
    }
    assert!(
        stdio.env.iter().all(|entry| entry.value.is_empty()),
        "the native catalog must not embed any credentials"
    );
    assert!(entry.install_hint.contains("kiro-cli login"));
}

#[test]
fn registry_acp_agents_are_present_and_acp() {
    // Keep this catalog transformation test hermetic: the production
    // constructor reads a CDN-backed registry and the headless suite has no
    // cache/network dependency.
    let registry_ids = [
        "cline",
        "auggie",
        "qwen-code",
        "github-copilot-cli",
        "grok-build",
        "fast-agent",
        "minion-code",
        "cursor",
        "opencode",
        "devin",
    ];
    let expected_ids = [
        "acp:cline",
        "acp:auggie",
        "acp:qwen",
        "acp:copilot",
        "acp:grok",
        "acp:fast-agent",
        "acp:minion",
        "acp:cursor",
        "acp:opencode",
        "acp:devin",
    ];
    let registry_entries = registry_ids
        .iter()
        .map(|id| registry_fixture_entry(id))
        .collect();
    let reg = AcpAgentRegistry::new_with_registry_entries(Some(registry_entries));
    for id in &expected_ids {
        let entry = reg
            .find_by_prefix(id)
            .unwrap_or_else(|| panic!("{id} should be registered"));
        assert!(
            matches!(entry.transport, AgentTransport::Acp { .. }),
            "{id} should use ACP transport"
        );
        assert_eq!(entry.id, *id, "find_by_prefix must return an exact match");
    }
}

fn registry_fixture_entry(id: &str) -> AcpAgentEntry {
    let agent: crate::sidecar::agents::acp_registry::RegistryAgent =
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "version": "fixture",
            "description": "fixture entry",
            "distribution": {
                "npx": {
                    "package": format!("{id}-acp"),
                    "args": [],
                    "env": {}
                }
            }
        }))
        .expect("decode registry fixture");
    entry_from_registry(&agent)
}

#[test]
fn registry_acp_spawn_cmds_invoke_their_runner() {
    // npx agents must spawn via `npx -y`; uvx agents via `uvx`. (On Windows the
    // npx command is wrapped in `cmd /c`; either way the runner token is there.)
    let reg = AcpAgentRegistry::new();
    let spawn = |id: &str| match &reg.find_by_prefix(id).unwrap().transport {
        AgentTransport::Acp { spawn_cmd } => spawn_cmd.clone(),
        AgentTransport::OpenAiCompat { .. } => unreachable!("expected ACP"),
    };
    assert!(spawn("acp:cline").contains("npx -y cline@latest"));
    assert!(spawn("acp:fast-agent").contains("uvx fast-agent-acp"));
    assert!(spawn("acp:minion").contains("uvx minion-code"));
}

#[test]
fn registry_does_not_duplicate_curated_agents() {
    // The curated entries (Claude Code, Codex, Gemini, Pi) have bespoke
    // gateway handling; the self-fetching registry set must not re-add them
    // under a colliding id, and every entry id must be unique.
    let reg = AcpAgentRegistry::new();
    let mut ids: Vec<&str> = reg.entries.iter().map(|e| e.id.as_str()).collect();
    let count = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(count, ids.len(), "agent ids must be unique");
    // The registry's claude-acp/codex-acp/gemini/pi-acp packages must not have
    // been added as new ids — those live as the curated acp:claude etc.
    for dup in &["acp:claude-agent", "acp:gemini-cli", "acp:pi-acp"] {
        assert!(
            reg.find_by_prefix(dup).map(|e| e.id.as_str()) != Some(dup),
            "{dup} should not be a separate registry entry"
        );
    }
}

#[test]
fn every_acp_spawn_cmd_parses_at_spawn_time() {
    // The spawn command is handed to `AcpSpawn::from_str` (shell_words::split)
    // before the subprocess launches. A malformed command — e.g. an unbalanced
    // quote in the uvx/hermes invocations — would only surface at runtime, so
    // assert here that every ACP entry's command parses cleanly. This is the
    // same parse the real spawn path runs.
    for entry in &AcpAgentRegistry::new().entries {
        if let AgentTransport::Acp { spawn_cmd } = &entry.transport {
            AcpSpawn::from_str(spawn_cmd).unwrap_or_else(|e| {
                panic!("spawn cmd for '{}' must parse, got error: {e}", entry.id)
            });
        }
    }
}

// ── ACP wire-shape mappers (kind/status/exit) ───────────────────────────

#[test]
fn tool_kind_str_serializes_snake_case_variants() {
    assert_eq!(tool_kind_str(&ToolKind::Read), "read");
    assert_eq!(tool_kind_str(&ToolKind::Edit), "edit");
    assert_eq!(tool_kind_str(&ToolKind::Execute), "execute");
    assert_eq!(tool_kind_str(&ToolKind::SwitchMode), "switch_mode");
    // The `#[default] #[serde(other)]` variant maps to "other".
    assert_eq!(tool_kind_str(&ToolKind::Other), "other");
    assert_eq!(tool_kind_str(&ToolKind::default()), "other");
}

#[test]
fn tool_status_str_serializes_snake_case_variants() {
    assert_eq!(tool_status_str(&ToolCallStatus::Pending), "pending");
    assert_eq!(tool_status_str(&ToolCallStatus::InProgress), "in_progress");
    assert_eq!(tool_status_str(&ToolCallStatus::Completed), "completed");
    assert_eq!(tool_status_str(&ToolCallStatus::Failed), "failed");
}

// ── Tool content → output collapsing ────────────────────────────────────

fn text_content(text: &str) -> ToolCallContent {
    ToolCallContent::from(text.to_owned())
}

#[test]
fn tool_content_to_output_empty_is_none() {
    assert!(tool_content_to_output(&[]).is_none());
}

#[test]
fn tool_content_to_output_text_only_is_a_string() {
    let out = tool_content_to_output(&[text_content("hello "), text_content("world")])
        .expect("text content collapses to a string");
    assert_eq!(out, serde_json::Value::String("hello world".to_owned()));
}

#[test]
fn tool_content_to_output_diff_becomes_structured_array() {
    // A non-text block (a Diff) forces the structured-array branch.
    let diff = ToolCallContent::Diff(Diff::new("/tmp/f.rs", "new").old_text("old"));
    let out = tool_content_to_output(&[diff]).expect("structured content");
    let arr = out.as_array().expect("diff yields a JSON array");
    assert_eq!(arr.len(), 1);
    assert_eq!(arr[0]["type"], serde_json::json!("diff"));
}

#[test]
fn tool_content_to_output_mixed_appends_text_after_structured() {
    // Text + a structured block: the text is appended as the LAST array entry.
    let diff = ToolCallContent::Diff(Diff::new("/tmp/f.rs", "new"));
    let out =
        tool_content_to_output(&[text_content("note"), diff]).expect("mixed content is structured");
    let arr = out.as_array().expect("array");
    assert_eq!(arr.len(), 2);
    assert_eq!(arr[0]["type"], serde_json::json!("diff"));
    assert_eq!(arr[1], serde_json::Value::String("note".to_owned()));
}

// ── Diff extraction (desktop edit card) ─────────────────────────────────

#[test]
fn extract_diff_output_maps_old_new_path() {
    let content = vec![ToolCallContent::Diff(
        Diff::new("/repo/src/lib.rs", "after").old_text("before"),
    )];
    let out = extract_diff_output(&content).expect("diff present");
    assert_eq!(out["old_content"], serde_json::json!("before"));
    assert_eq!(out["content"], serde_json::json!("after"));
    assert_eq!(out["path"], serde_json::json!("/repo/src/lib.rs"));
}

#[test]
fn extract_diff_output_new_file_has_empty_old_content() {
    // A brand-new file has no `old_text`; the card must still render (empty old).
    let content = vec![ToolCallContent::Diff(Diff::new("/repo/new.rs", "created"))];
    let out = extract_diff_output(&content).expect("diff present");
    assert_eq!(out["old_content"], serde_json::json!(""));
    assert_eq!(out["content"], serde_json::json!("created"));
}

#[test]
fn extract_diff_output_none_for_non_edit_tools() {
    assert!(extract_diff_output(&[text_content("just text")]).is_none());
    assert!(extract_diff_output(&[]).is_none());
}

// ── Location JSON ───────────────────────────────────────────────────────

#[test]
fn locations_json_includes_line_only_when_present() {
    let with_line: ToolCallLocation =
        serde_json::from_value(serde_json::json!({ "path": "/a/b.rs", "line": 12 })).unwrap();
    let without: ToolCallLocation =
        serde_json::from_value(serde_json::json!({ "path": "/a/c.rs" })).unwrap();
    let out = locations_json(&[with_line, without]);
    assert_eq!(out[0]["path"], serde_json::json!("/a/b.rs"));
    assert_eq!(out[0]["line"], serde_json::json!(12));
    assert_eq!(out[1]["path"], serde_json::json!("/a/c.rs"));
    assert!(out[1].get("line").is_none(), "absent line is omitted");
}

// ── Tool call/update → AcpEvent ─────────────────────────────────────────

#[test]
fn tool_call_event_carries_kind_locations_and_input() {
    let loc: ToolCallLocation =
        serde_json::from_value(serde_json::json!({ "path": "/x.rs", "line": 3 })).unwrap();
    let call = ToolCall::new("call-1", "Edit x.rs")
        .kind(ToolKind::Edit)
        .locations(vec![loc])
        .raw_input(serde_json::json!({ "path": "/x.rs" }));
    match tool_call_event(&call) {
        AcpEvent::ToolCall {
            id,
            title,
            kind,
            input,
            locations,
        } => {
            assert_eq!(id, "call-1");
            assert_eq!(title, "Edit x.rs");
            assert_eq!(kind, "edit");
            assert_eq!(input, Some(serde_json::json!({ "path": "/x.rs" })));
            assert_eq!(locations.len(), 1);
            assert_eq!(locations[0]["line"], serde_json::json!(3));
        }
        other => panic!("expected ToolCall event, got {other:?}"),
    }
}

#[test]
fn tool_update_event_none_when_nothing_actionable() {
    // A bare title tweak carries no status and no output → nothing to surface.
    let update = ToolCallUpdate::new("c1", ToolCallUpdateFields::new().title("renamed"));
    assert!(tool_update_event(&update).is_none());
}

#[test]
fn tool_update_event_prefers_diff_over_raw_output() {
    // Both a Diff content block AND a raw_output are present; the diff wins so
    // the desktop's edit card renders old↔new (not the opaque raw output).
    let fields = ToolCallUpdateFields::new()
        .status(ToolCallStatus::Completed)
        .content(vec![ToolCallContent::Diff(
            Diff::new("/f.rs", "new").old_text("old"),
        )])
        .raw_output(serde_json::json!({ "ignored": true }));
    let update = ToolCallUpdate::new("c2", fields);
    match tool_update_event(&update).expect("actionable update") {
        AcpEvent::ToolResult {
            id, status, output, ..
        } => {
            assert_eq!(id, "c2");
            assert_eq!(status, "completed");
            let out = output.expect("diff output");
            assert_eq!(out["old_content"], serde_json::json!("old"));
            assert_eq!(out["content"], serde_json::json!("new"));
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }
}

#[test]
fn tool_update_event_falls_back_to_raw_output_then_content() {
    // No diff: raw_output is used verbatim.
    let raw = ToolCallUpdate::new(
        "c3",
        ToolCallUpdateFields::new().raw_output(serde_json::json!({ "rows": 2 })),
    );
    match tool_update_event(&raw).expect("update") {
        AcpEvent::ToolResult { status, output, .. } => {
            // No status supplied → defaults to "in_progress".
            assert_eq!(status, "in_progress");
            assert_eq!(output, Some(serde_json::json!({ "rows": 2 })));
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }

    // No diff, no raw_output: collapse the plain text content instead.
    let text = ToolCallUpdate::new(
        "c4",
        ToolCallUpdateFields::new().content(vec![text_content("plain result")]),
    );
    match tool_update_event(&text).expect("update") {
        AcpEvent::ToolResult { output, .. } => {
            assert_eq!(output, Some(serde_json::json!("plain result")));
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }
}

#[test]
fn tool_update_event_carries_late_arriving_raw_input() {
    // The shape that motivates the field: pi-acp opens a tool call while the
    // model is still streaming its arguments (`rawInput: {}`) and fills them
    // in on a later update. Dropping this leaves every rich renderer that
    // reads `part.input` — the plan card, the to-do checklist, the subagent
    // card — pinned to the empty opening frame with no error anywhere.
    let update = ToolCallUpdate::new(
        "c5",
        ToolCallUpdateFields::new()
            .status(ToolCallStatus::InProgress)
            .raw_input(serde_json::json!({ "plan": { "title": "Add a health endpoint" } })),
    );
    match tool_update_event(&update).expect("actionable update") {
        AcpEvent::ToolResult { input, .. } => {
            assert_eq!(
                input,
                Some(serde_json::json!({ "plan": { "title": "Add a health endpoint" } }))
            );
        }
        other => panic!("expected ToolResult, got {other:?}"),
    }

    // An update with no arguments carries `None` rather than an empty object,
    // so mod.rs can tell "unchanged" from "cleared" without guessing.
    let bare = ToolCallUpdate::new(
        "c6",
        ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
    );
    match tool_update_event(&bare).expect("actionable update") {
        AcpEvent::ToolResult { input, .. } => assert_eq!(input, None),
        other => panic!("expected ToolResult, got {other:?}"),
    }
}
