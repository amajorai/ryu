use super::*;

#[tokio::test]
async fn pi_widget_synthesis_builds_tool_widget_event() {
    // End-to-end (minus the live Pi subprocess): the exact two-step the ACP
    // `ToolCallUpdate` handler runs — extract the binding, then feed it to the
    // SHARED `build_widget_event`. `checklist.render` used to be an in-process
    // app whose binding + HTML resolved without a live MCP server; the eight
    // inline-chat widget-apps were retired in 1af518d8, so the fixture is now
    // seeded directly. It stands in for the producer that IS still live — an
    // external MCP server declaring `ryu/outputTemplate` in its tool `_meta` —
    // which is what this synthesis path serves in production.
    let mcp = McpRegistry::empty();
    mcp.seed_widget_tool_for_test("checklist", "render", "ui://widget/checklist.html");
    let raw = ryu_widget_raw_output(
        "checklist.render",
        serde_json::json!({ "title": "Groceries", "items": [{ "text": "milk" }] }),
    );

    let (tool, args, result) =
        pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&raw)).expect("binding");
    let event = crate::sidecar::adapters::mcp_bridge::build_widget_event(
        &mcp,
        &tool,
        &args,
        &result,
        Some("acp_call_42".to_owned()),
        Some("conv-widget-test".to_owned()),
        "ryu".to_owned(),
    )
    .await
    .expect("checklist render synthesizes a widget event");

    // The widget correlates to the REAL ACP tool-call id (not the synthetic one).
    assert_eq!(event.tool_call_id, "acp_call_42");
    assert_eq!(event.tool_name, "checklist.render");
    assert_eq!(event.template_uri, "ui://widget/checklist.html");
    // `structuredContent` → `toolOutput`, delivered RAW to the widget.
    assert_eq!(event.tool_output["title"], serde_json::json!("Groceries"));
    assert!(!event.widget_html.is_empty(), "widget HTML resolves");
}

#[tokio::test]
async fn pi_widget_synthesis_skips_error_results() {
    // An `isError` MCP result NEVER emits a widget (spec §1.1) — even when the
    // Pi extension stamped the marker. Seed the binding: without it
    // `build_widget_event` would bail one step EARLIER (no widget at all) and
    // the assertion would pass without ever reaching the `isError` guard.
    let mcp = McpRegistry::empty();
    mcp.seed_widget_tool_for_test("checklist", "render", "ui://widget/checklist.html");
    let raw = serde_json::json!({
        "details": { "ryuWidget": {
            "tool": "checklist.render",
            "arguments": {},
            "output": { "isError": true, "content": [{ "type": "text", "text": "boom" }] },
        }}
    });
    let (tool, args, result) =
        pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&raw)).expect("binding");
    let event = crate::sidecar::adapters::mcp_bridge::build_widget_event(
        &mcp,
        &tool,
        &args,
        &result,
        Some("acp_call_err".to_owned()),
        Some("conv-err".to_owned()),
        "ryu".to_owned(),
    )
    .await;
    assert!(
        event.is_none(),
        "isError result must not synthesize a widget"
    );
}

#[test]
fn read_text_file_scoped_applies_line_and_limit() {
    let dir = std::env::temp_dir().join(format!("ryu-acp-fs-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("f.txt");
    std::fs::write(&path, "l1\nl2\nl3\nl4\nl5").unwrap();

    // These schema structs are `#[non_exhaustive]`, so build them from JSON.
    let req = |extra: serde_json::Value| -> ReadTextFileRequest {
        let mut obj = serde_json::json!({ "sessionId": "s" });
        obj.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(obj).expect("valid ReadTextFileRequest")
    };

    // Full read.
    let full = req(serde_json::json!({ "path": path }));
    assert_eq!(
        read_text_file_scoped_in_roots(&full, std::slice::from_ref(&dir)),
        "l1\nl2\nl3\nl4\nl5"
    );

    // 1-based line offset + limit window.
    let windowed = req(serde_json::json!({ "path": path, "line": 2, "limit": 2 }));
    assert_eq!(
        read_text_file_scoped_in_roots(&windowed, std::slice::from_ref(&dir)),
        "l2\nl3"
    );

    // Missing file → empty, never panics.
    let missing = req(serde_json::json!({ "path": dir.join("nope.txt") }));
    assert_eq!(
        read_text_file_scoped_in_roots(&missing, std::slice::from_ref(&dir)),
        ""
    );

    // Out-of-root read → empty (workspace confinement), even when the file
    // exists.
    let outside = req(serde_json::json!({ "path": path }));
    let sibling_root = dir.join("sub");
    assert_eq!(
        read_text_file_scoped_in_roots(&outside, std::slice::from_ref(&sibling_root)),
        ""
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn fs_handlers_allow_every_session_workspace_root() {
    let base = std::env::temp_dir().join(format!("ryu-acp-multi-root-{}", std::process::id()));
    let primary = base.join("web");
    let secondary = base.join("api");
    let outside = base.join("outside");
    std::fs::create_dir_all(&primary).unwrap();
    std::fs::create_dir_all(&secondary).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let secondary_file = secondary.join("src/lib.rs");
    std::fs::create_dir_all(secondary_file.parent().unwrap()).unwrap();
    std::fs::write(&secondary_file, "secondary").unwrap();

    let roots = vec![primary.clone(), secondary.clone()];
    let read_request: ReadTextFileRequest =
        serde_json::from_value(serde_json::json!({ "sessionId": "s", "path": secondary_file }))
            .expect("valid secondary-root read request");
    assert_eq!(
        read_text_file_scoped_in_roots(&read_request, &roots),
        "secondary"
    );

    let write_target = secondary.join("generated.txt");
    let write_request: WriteTextFileRequest = serde_json::from_value(serde_json::json!({
        "sessionId": "s",
        "path": write_target,
        "content": "written"
    }))
    .expect("valid secondary-root write request");
    write_text_file_scoped_in_roots(&write_request, &roots).expect("secondary-root write");
    assert_eq!(std::fs::read_to_string(&write_target).unwrap(), "written");

    let outside_request: ReadTextFileRequest = serde_json::from_value(
        serde_json::json!({ "sessionId": "s", "path": outside.join("secret.txt") }),
    )
    .expect("valid outside-root read request");
    assert_eq!(read_text_file_scoped_in_roots(&outside_request, &roots), "");

    let _ = std::fs::remove_dir_all(&base);
}

#[cfg(unix)]
#[test]
fn fs_handlers_refuse_symlink_escapes() {
    let base = std::env::temp_dir().join(format!("ryu-acp-symlink-{}", std::process::id()));
    let root = base.join("workspace");
    let outside = base.join("outside");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    let secret = outside.join("secret.txt");
    std::fs::write(&secret, "not for the agent").unwrap();
    let link = root.join("linked-secret.txt");
    std::os::unix::fs::symlink(&secret, &link).unwrap();

    let read_request: ReadTextFileRequest = serde_json::from_value(serde_json::json!({
        "sessionId": "s",
        "path": link,
    }))
    .expect("valid symlink read request");
    assert_eq!(
        read_text_file_scoped_in_roots(&read_request, std::slice::from_ref(&root)),
        ""
    );

    let write_request: WriteTextFileRequest = serde_json::from_value(serde_json::json!({
        "sessionId": "s",
        "path": root.join("linked-secret.txt"),
        "content": "must not overwrite the target",
    }))
    .expect("valid symlink write request");
    assert!(write_text_file_scoped_in_roots(&write_request, std::slice::from_ref(&root)).is_err());
    assert_eq!(
        std::fs::read_to_string(secret).unwrap(),
        "not for the agent"
    );

    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn fs_confinement_rejects_escapes_lexically() {
    let root = std::path::Path::new("/ws/project");
    // In-root, `.`/`..` that stay inside, and relative paths all pass.
    assert!(path_within_root(
        root,
        std::path::Path::new("/ws/project/a.txt")
    ));
    assert!(path_within_root(
        root,
        std::path::Path::new("/ws/project/sub/../a.txt")
    ));
    assert!(path_within_root(root, std::path::Path::new("rel/b.txt")));
    // Escapes — absolute elsewhere, `..` climbing out, sibling-prefix trick.
    assert!(!path_within_root(root, std::path::Path::new("/etc/passwd")));
    assert!(!path_within_root(
        root,
        std::path::Path::new("/ws/project/../other/c.txt")
    ));
    assert!(!path_within_root(
        root,
        std::path::Path::new("/ws/project2/d.txt")
    ));
}

#[test]
fn write_text_file_scoped_refuses_out_of_root() {
    let dir = std::env::temp_dir().join(format!("ryu-acp-fsw-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let target = dir.join("escape.txt");
    let req: WriteTextFileRequest = serde_json::from_value(serde_json::json!({
        "sessionId": "s",
        "path": target,
        "content": "nope",
    }))
    .expect("valid WriteTextFileRequest");
    // Root is a SIBLING dir, so the write must be refused and nothing created.
    let inner_root = dir.join("inner");
    let err = write_text_file_scoped_in_roots(&req, std::slice::from_ref(&inner_root)).unwrap_err();
    assert!(err.to_string().contains("outside the session workspaces"));
    assert!(!target.exists());
    // Same request against the real root succeeds.
    write_text_file_scoped_in_roots(&req, std::slice::from_ref(&dir)).expect("in-root write");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "nope");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn request_cancel_is_false_without_a_live_turn() {
    // No registered turn for this conversation → nothing to cancel.
    assert!(!request_cancel("no-such-conversation-xyz"));
}

#[test]
fn request_cancel_signals_a_registered_turn() {
    let conv = "conv-cancel-test";
    let cancel = Arc::new(TurnCancel::default());
    set_cancel(conv, Arc::clone(&cancel));
    assert!(request_cancel(conv));
    assert!(cancel.flag.load(std::sync::atomic::Ordering::SeqCst));
    clear_cancel(conv, &cancel);
    assert!(!request_cancel(conv));
}

#[test]
fn an_ended_turn_keeps_a_concurrent_turns_cancel_handle() {
    let conv = "conv-cancel-overlap-test";
    let older = Arc::new(TurnCancel::default());
    let newer = Arc::new(TurnCancel::default());
    let older_registration = CancelRegistration::register(conv, &older);
    let newer_registration = CancelRegistration::register(conv, &newer);
    drop(older_registration);
    assert!(has_live_turn(conv));
    assert!(request_cancel(conv));
    assert!(newer.flag.load(std::sync::atomic::Ordering::SeqCst));
    drop(newer_registration);
    assert!(!has_live_turn(conv));
}

#[test]
fn list_infos_binds_acp_agents_to_their_runtime() {
    let infos = AcpAgentRegistry::new().list_infos();
    let claude = infos
        .iter()
        .find(|a| a.id == "acp:claude")
        .expect("claude agent present");
    assert_eq!(claude.transport.as_deref(), Some("acp"));
    // ACP agents are their own runtime; the "acp:" prefix is stripped.
    assert_eq!(claude.engine.as_deref(), Some("claude"));
}

#[test]
fn list_infos_binds_openai_compat_agents_to_local_engine() {
    let infos = AcpAgentRegistry::new().list_infos();
    let zeroclaw = infos
        .iter()
        .find(|a| a.id == "zeroclaw")
        .expect("zeroclaw agent present");
    assert_eq!(zeroclaw.transport.as_deref(), Some("openai_compat"));
    // OpenAI-compatible agents are themselves the local engine.
    assert_eq!(zeroclaw.engine.as_deref(), Some("zeroclaw"));
}

#[test]
fn every_agent_reports_an_engine_and_transport() {
    for info in AcpAgentRegistry::new().list_infos() {
        assert!(
            info.engine.is_some(),
            "agent {} missing engine binding",
            info.id
        );
        assert!(
            info.transport.is_some(),
            "agent {} missing transport",
            info.id
        );
    }
}
