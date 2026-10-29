use super::*;

// ── Late-arriving tool arguments ────────────────────────────────────────
//
// An ACP agent may open a tool call before its arguments exist and fill them
// in on a later update — pi-acp does exactly that while the model streams the
// call. The desktop's rich cards read `part.input`, so the opening frame has
// to be re-emitted when the arguments land. These pin the two decisions that
// makes: what counts as "nothing yet", and that the re-emitted frame keeps the
// part type it opened with.

#[test]
fn blank_tool_input_is_null_or_an_empty_object() {
    assert!(is_blank_tool_input(&Value::Null));
    assert!(is_blank_tool_input(&serde_json::json!({})));
    // Anything with content is real input, including a partial-JSON blob an
    // adapter may hand over mid-stream — a later frame simply replaces it.
    assert!(!is_blank_tool_input(&serde_json::json!({ "todos": [] })));
    assert!(!is_blank_tool_input(&serde_json::json!([])));
    assert!(!is_blank_tool_input(&serde_json::json!("")));
}

#[test]
fn tool_frame_is_stable_between_an_empty_open_and_a_filled_update() {
    // The flagship's own shape: pi-acp puts Pi's tool NAME in the title, so
    // `KNOWN_TOOLS` matches on the title alone and the part type cannot move
    // when the arguments arrive. That stability is what lets the update
    // CORRECT the part instead of minting a second one.
    let (open_name, open_dynamic, open_input) =
        acp_tool_frame("other", "PlanWrite", &serde_json::json!({}), &[]);
    assert_eq!(open_name, "PlanWrite");
    assert!(!open_dynamic);
    assert_eq!(open_input, serde_json::json!({}));

    let filled = serde_json::json!({ "plan": { "title": "Add a health endpoint" } });
    let (late_name, late_dynamic, late_input) = acp_tool_frame("other", "PlanWrite", &filled, &[]);
    assert_eq!(late_name, open_name);
    assert_eq!(late_dynamic, open_dynamic);
    assert_eq!(
        late_input["plan"]["title"],
        serde_json::json!("Add a health endpoint")
    );
}

#[test]
fn tool_frame_folds_locations_and_reshapes_a_question() {
    // Both transformations the emitted input carries, exercised through the
    // one function so the open and the late-update paths cannot drift.
    let locations = vec![serde_json::json!({ "path": "/x.rs", "line": 3 })];
    let (_, _, input) = acp_tool_frame(
        "read",
        "Read",
        &serde_json::json!({ "file_path": "/x.rs" }),
        &locations,
    );
    assert_eq!(
        input["_ryuLocations"][0]["path"],
        serde_json::json!("/x.rs")
    );

    let question = serde_json::json!({
        "questions": [{
            "question": "Which one?",
            "header": "Pick",
            "options": [{ "label": "a" }, { "label": "b" }],
        }]
    });
    let (name, dynamic, _) = acp_tool_frame("other", "AskUserQuestion", &question, &[]);
    assert_eq!(name, "Question");
    assert!(!dynamic);

    // Ryu's own `ask_user` bridge tool draws its card from Core; the agent's
    // frame for the same call must not become a second Question card.
    for title in ["mcp__ryu__ask_user", "ryu.ask_user", "ask_user"] {
        let (name, _, _) = acp_tool_frame("other", title, &question, &[]);
        assert_ne!(name, "Question", "{title}");
    }
}

#[test]
fn tool_frame_detects_an_artifact_render_payload() {
    // Nested `artifact` object.
    let (name, dynamic, _) = acp_tool_frame(
        "other",
        "RenderArtifact",
        &serde_json::json!({
            "artifact": { "kind": "database", "title": "Q3", "content": "[{\"a\":1}]" }
        }),
        &[],
    );
    assert_eq!(name, "artifact.render");
    assert!(dynamic);

    // Flat `kind` + `content` pair.
    let (name2, _, _) = acp_tool_frame(
        "other",
        "CreateArtifact",
        &serde_json::json!({ "kind": "code", "title": "main.rs", "content": "fn main(){}" }),
        &[],
    );
    assert_eq!(name2, "artifact.render");

    // A generic tool whose input is a stringified file shape is untouched.
    let (name3, _, _) = acp_tool_frame(
        "other",
        "Something",
        &serde_json::json!({ "query": "hello" }),
        &[],
    );
    assert_ne!(name3, "artifact.render");
}

#[test]
fn default_agent_recognized() {
    assert!(is_default_agent(None));
    assert!(is_default_agent(Some("")));
    assert!(is_default_agent(Some("default")));
    // ryu is the flagship; it is recognized as a default agent (AC1).
    assert!(is_default_agent(Some("ryu")));
    assert!(!is_default_agent(Some("acp:claude")));
    assert!(!is_default_agent(Some("zeroclaw")));
}

#[test]
fn no_agent_id_routes_to_default_provider() {
    // No agent_id and "default" both resolve to the OpenAI-compat default,
    // never the unknown-agent error path.
    for id in [None, Some("default")] {
        let route =
            agent_route(id, None, None, &acp_reg(), &provider_reg()).expect("default route");
        assert!(matches!(route, AgentRoute::OpenAiCompat { .. }));
    }
}

#[test]
fn default_route_goes_through_gateway() {
    // U18: the built-in default LLM path must forward to ryu-gateway, not
    // hit a provider directly.
    let route = agent_route(None, None, None, &acp_reg(), &provider_reg()).expect("default route");
    assert!(matches!(
        route,
        AgentRoute::OpenAiCompat {
            via_gateway: true,
            ..
        }
    ));
}
