use super::*;

#[test]
fn consent_calls_normalized_by_qualified_title_only() {
    assert_eq!(
        acp_tool_ui_name(
            "other",
            "mcp__ryu__consent.connect_app",
            &serde_json::json!({})
        ),
        ("consent.connect_app".to_owned(), true)
    );
    assert_eq!(
        acp_tool_ui_name(
            "other",
            "mcp__ryu__consent.install_plugin",
            &serde_json::json!({})
        ),
        ("consent.install_plugin".to_owned(), true)
    );
}

#[test]
fn ordinary_tools_with_consent_like_fields_keep_their_rows() {
    // No payload shape turns a tool into a consent card, however close.
    let connect_like = serde_json::json!({ "app": "billing", "reason": "Deploy it" });
    assert_eq!(
        acp_tool_ui_name("other", "Deploy app", &connect_like).0,
        "Deploy app"
    );
    let install_like = serde_json::json!({ "pluginIds": ["x"], "reason": "y" });
    assert_eq!(
        acp_tool_ui_name("other", "Bundle", &install_like).0,
        "Bundle"
    );
    let search = serde_json::json!({ "query": "linear", "reason": "x" });
    assert_eq!(acp_tool_ui_name("search", "Search", &search).0, "WebSearch");
    assert_eq!(
        acp_tool_ui_name("other", "my_install_plugin", &serde_json::json!({})).0,
        "my_install_plugin"
    );
}

#[test]
fn ui_render_call_normalized_by_spec_shape() {
    // ACP gives no stable machine name; a spec-shaped input must still map to
    // the stable `ui.render` name (dynamic) so the desktop renders it inline,
    // regardless of the humanized title the adapter reports.
    let input = serde_json::json!({
        "spec": { "root": "a", "elements": { "a": { "type": "Text" } } }
    });
    let (name, dynamic) = acp_tool_ui_name("other", "Render some UI", &input);
    assert_eq!(name, "ui.render");
    assert!(dynamic);
}

#[test]
fn a2ui_render_call_normalized_by_explicit_format() {
    let input = serde_json::json!({
        "format": "a2ui",
        "spec": [{
            "version": "v0.9",
            "createSurface": {
                "surfaceId": "status",
                "catalogId": "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json"
            }
        }]
    });
    let (name, dynamic) = acp_tool_ui_name("other", "Render some UI", &input);
    assert_eq!(name, "ui.render");
    assert!(dynamic);
}

#[test]
fn non_ui_tool_falls_through_to_title() {
    let (name, _) = acp_tool_ui_name("other", "some_custom_tool", &Value::Null);
    assert_eq!(name, "some_custom_tool");
}

// ── Nested sub-step fan-out (Unit 6) ──────────────────────────────────────

#[test]
fn nested_step_tool_name_canonicalizes_case() {
    // Pi's built-in tools are lowercase (`read`/`bash`/`edit`/`write`) while the
    // desktop's nested-row registry keys on the capitalized spellings. A
    // verbatim pass-through would mint `tool-read` and the nested row would
    // render with no title — the one failure this whole helper exists to stop.
    for raw in ["read", "Read", "READ"] {
        assert_eq!(
            nested_step_tool_name(raw),
            ("Read".to_owned(), false),
            "{raw}"
        );
    }
    assert_eq!(
        nested_step_tool_name("bash"),
        ("Bash".to_owned(), false),
        "the terminal card keys on `Bash`",
    );
    assert_eq!(
        nested_step_tool_name("webfetch"),
        ("WebFetch".to_owned(), false)
    );
    // `TaskOutput` is reachable through the same list (Core mints it directly,
    // but the list must stay the single source of truth for the spelling).
    assert_eq!(
        nested_step_tool_name("TaskOutput"),
        ("TaskOutput".to_owned(), false)
    );
    // Unknown names stay dynamic under their own label: generic, never blank.
    assert_eq!(
        nested_step_tool_name("mcp.foo.bar"),
        ("mcp.foo.bar".to_owned(), true),
    );
}

#[test]
fn nested_step_defaults_mean_not_yet_not_absent() {
    // A step announced before its arguments/status exist: the row must open
    // (so the user sees the child working) but must NOT be treated as finished.
    let announced = nested_step(&serde_json::json!({ "name": "bash" }));
    assert_eq!(announced.name, "Bash");
    assert!(!announced.dynamic);
    assert_eq!(announced.input, Value::Null);
    assert_eq!(announced.status, "in_progress");
    assert!(
        !announced.terminal,
        "an unstated status means still running — closing the row here would \
             freeze the nested card before the step ran",
    );

    // Both failure spellings close the row; only `completed` is a success.
    for bad in ["error", "failed"] {
        let step = nested_step(&serde_json::json!({ "name": "read", "status": bad }));
        assert!(step.terminal, "{bad}");
        assert_ne!(step.status, "completed", "{bad}");
    }
    assert!(nested_step(&serde_json::json!({ "status": "completed" })).terminal);

    // No name at all → a generic dynamic row, never a blank `tool-` part type.
    let anonymous = nested_step(&serde_json::json!({}));
    assert_eq!(anonymous.name, "tool");
    assert!(anonymous.dynamic);
}

#[test]
fn nested_step_input_grows_across_updates() {
    // The producer re-sends the whole `ryuSteps` array per update, and a step's
    // arguments stream in after it is announced (the ACP wire does the same:
    // the first `tool_call` carries `rawInput: {}`). The fan-out keys its
    // re-emit decision on the `(name, input)` pair, so that pair MUST differ
    // between the announcement and the filled step — otherwise the nested row
    // stays pinned to empty arguments for the rest of the turn.
    let announced = nested_step(&serde_json::json!({ "name": "read", "input": {} }));
    let filled =
        nested_step(&serde_json::json!({ "name": "read", "input": { "file_path": "/a.rs" } }));
    assert_ne!(
        (announced.name, announced.input),
        (filled.name, filled.input)
    );
}

#[test]
fn nested_step_suffix_keeps_parallel_lifecycle_ids_stable_and_scoped() {
    assert_eq!(
        nested_step_suffix(&serde_json::json!({ "id": "agent-3" }), 9),
        "agent-3"
    );
    for unsafe_id in ["", "out", "child:nested"] {
        assert_eq!(
            nested_step_suffix(&serde_json::json!({ "id": unsafe_id }), 9),
            "9",
            "{unsafe_id}"
        );
    }
    assert_eq!(nested_step_suffix(&serde_json::json!({}), 9), "9");
}

#[test]
fn known_tools_includes_task_output_for_the_subagent_answer() {
    // `tool-TaskOutput` is what `CoworkContextPanel` reads as a subagent's final
    // answer (and what the message list suppresses). Losing the entry would make
    // the `<parent>:out` part render as an ordinary row in the transcript.
    assert!(KNOWN_TOOLS.contains(&"TaskOutput"));
    // The two parent types the desktop groups nested children under.
    assert!(KNOWN_TOOLS.contains(&"Task") && KNOWN_TOOLS.contains(&"Agent"));
}
