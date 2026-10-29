use super::*;

// ── Core-synthesized plan-mode config option (Unit 7) ────────────────────
//
// The ONE option Ryu invents rather than reports. These pin the two halves
// that make it safe: it is offered only to the agent that can honour it, and
// it never goes back to that agent over the wire.

/// A flagship spawn command, in the POSIX spelling `ryu_pi_acp_cmd` emits.
fn flagship_spawn_cmd() -> String {
    format!("PI_CODING_AGENT_DIR=/tmp/pi-agent {}", pi_acp_cmd_gated())
}

#[test]
fn plan_mode_config_option_is_appended_only_for_the_flagship() {
    // The flagship gets the pill appended AFTER whatever it advertised, so
    // pi-acp's own model selector keeps the leading slot it chose.
    let advertised = vec![SessionConfigOption::select(
        "model",
        "Model",
        "gpt-5",
        vec![SessionConfigSelectOption::new("gpt-5", "GPT-5")],
    )];
    let out = with_plan_mode_option(&flagship_spawn_cmd(), Some(advertised))
        .expect("flagship gets options");
    assert_eq!(out.len(), 2, "appended, not replaced");
    assert_eq!(&*out[0].id.0, "model", "agent's order is preserved");
    assert_eq!(&*out[1].id.0, PLAN_MODE_CONFIG_ID);

    // An agent that advertised nothing still gets the pill — otherwise the
    // affordance would depend on the agent happening to report something else.
    let bare = with_plan_mode_option(&flagship_spawn_cmd(), None).expect("None becomes a list");
    assert_eq!(bare.len(), 1);
    assert_eq!(&*bare[0].id.0, PLAN_MODE_CONFIG_ID);

    // Every OTHER agent is untouched, in both directions. A pill on an agent
    // with no `ryu-plan.ts` would be a control that does nothing worse than
    // nothing: the sentinel would reach that model as literal text.
    for cmd in [
        "npx -y claude-code-acp",
        "npx -y @zed-industries/codex-acp",
        // Bare pi-acp: pi, but NOT the managed config dir, so no extension.
        &pi_acp_cmd_gated(),
    ] {
        assert!(
            with_plan_mode_option(cmd, None).is_none(),
            "{cmd}: no synthesized option"
        );
        let one = with_plan_mode_option(
            cmd,
            Some(vec![SessionConfigOption::select(
                "model",
                "Model",
                "a",
                vec![SessionConfigSelectOption::new("a", "A")],
            )]),
        )
        .expect("advertised list survives");
        assert_eq!(one.len(), 1, "{cmd}: agent's own options are not extended");
    }
}

#[test]
fn plan_mode_config_option_renders_in_the_composer() {
    // Three properties the desktop's generic renderer depends on. None is
    // cosmetic: each one, if broken, makes the pill silently absent rather
    // than visibly wrong.
    let opt = plan_mode_config_option();
    let json = serde_json::to_value(&opt).expect("serializes");

    // 0. The field names the desktop's `AcpConfigOption` interface requires.
    //    Asserted explicitly because a serde rename would leave every other
    //    assertion below passing while the renderer saw an option with no id.
    assert_eq!(json["id"], serde_json::json!(PLAN_MODE_CONFIG_ID));
    assert!(json["name"].is_string(), "camelCase field names: {json}");

    // 1. It is a `select` with both values, in off→on order.
    assert_eq!(json["type"], serde_json::json!("select"));
    let values: Vec<&str> = json["options"]
        .as_array()
        .expect("options array")
        .iter()
        .map(|o| o["value"].as_str().expect("value"))
        .collect();
    assert_eq!(values, vec![PLAN_MODE_OFF, PLAN_MODE_ON]);

    // 2. `currentValue` is the OFF default. Core holds no per-session plan
    //    state and this probe is cached per spawn command, so there is
    //    nothing else it could honestly be; the desktop overlays the user's
    //    own pick on top.
    assert_eq!(json["currentValue"], serde_json::json!(PLAN_MODE_OFF));

    // 3. Neither the category, the id nor the name may contain a word the
    //    composer reads as "this is a reasoning control" — such options are
    //    hidden outright for an agent that reports no reasoning capability.
    let haystack = format!(
        "{} {} {}",
        json["category"].as_str().unwrap_or_default(),
        json["id"].as_str().unwrap_or_default(),
        json["name"].as_str().unwrap_or_default()
    )
    .to_lowercase();
    for needle in ["thought", "reason", "think", "effort"] {
        assert!(
            !haystack.contains(needle),
            "'{needle}' in \"{haystack}\" would hide the pill when reasoning is off"
        );
    }
    assert_eq!(json["category"], serde_json::json!("mode"));
}

#[test]
fn acp_auth_required_code_matches_the_protocol() {
    // The whole re-login branch hangs off this number. ACP's
    // `ErrorCode::AuthRequired` is JSON-RPC -32000; if it ever moved, an
    // expired token would silently fall back to the "no model configured"
    // message again — advice that cannot fix it.
    assert_eq!(
        ACP_AUTH_REQUIRED_CODE,
        i32::from(agent_client_protocol::ErrorCode::AuthRequired)
    );
}

#[test]
fn config_option_value_maps_booleans_and_leaves_ids_alone() {
    // Boolean config options (`SessionConfigKind::Boolean`) split the wire value into a select's value
    // id and a real boolean. Every layer above Core stores config picks as
    // STRINGS, so sending a toggle the string "true" as a value id makes the
    // agent hunt for an option whose id is "true" and reject the write.
    assert_eq!(
        config_option_value("true").as_bool(),
        Some(true),
        "\"true\" must cross the wire as a boolean, not a value id"
    );
    assert_eq!(config_option_value("false").as_bool(), Some(false));

    // Everything else stays a value id, including strings that merely look
    // boolean-ish — only the two exact spellings convert.
    for id in ["high", "off", "True", "FALSE", "yes", "1", ""] {
        assert!(
            config_option_value(id).as_bool().is_none(),
            "{id} must stay a value id"
        );
        assert_eq!(
            config_option_value(id).as_value_id().map(|v| v.to_string()),
            Some(id.to_owned())
        );
    }
}

#[test]
fn plan_mode_id_is_filtered_from_set_config_option() {
    // pi-acp accepts `model` and `thought_level` and throws on anything else,
    // so sending the synthesized id would produce a rejected request and a
    // warn line on every single turn.
    assert!(is_core_synthesized_config_id(PLAN_MODE_CONFIG_ID));
    for agent_reported in ["model", "thought_level", "mode", "ryu", "ryu.plan.extra"] {
        assert!(
            !is_core_synthesized_config_id(agent_reported),
            "{agent_reported} is agent-reported and must still be sent"
        );
    }
}

#[test]
fn plan_mode_id_coexists_with_the_model_config_option() {
    // Covers the DATA `apply_turn_config` reads, not its send loop (that needs
    // a live `ConnectionTo<Agent>`). It skips the synthesized id inside the loop rather
    // than removing it from `turn.config_options`, because the model fallback
    // below scans that same list to decide whether `model` was already sent
    // explicitly. This pins that the scan still sees `model` when a plan pick
    // rides alongside it — a `.retain()` "cleanup" would break it silently.
    let turn = AcpTurnConfig {
        session_mode: None,
        config_options: vec![
            (PLAN_MODE_CONFIG_ID.to_owned(), PLAN_MODE_ON.to_owned()),
            (MODEL_CONFIG_OPTION_ID.to_owned(), "gpt-5".to_owned()),
        ],
        model_id: Some("gpt-5".to_owned()),
        agent_effort: None,
        interactive: true,
    };
    assert!(
        turn.config_options
            .iter()
            .any(|(id, _)| id == MODEL_CONFIG_OPTION_ID),
        "the model fallback's `already_via_config` scan must still hit"
    );
    assert_eq!(
        turn.config_options
            .iter()
            .filter(|(id, _)| !is_core_synthesized_config_id(id))
            .count(),
        1,
        "exactly one option reaches the wire"
    );
}
