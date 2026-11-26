use super::*;

/// Verify fail-closed: when gateway is unreachable and fallback is not
/// opted in, the delegate error message mentions the gateway.
#[tokio::test]
async fn fail_closed_when_gateway_unreachable() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
    let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
    unsafe {
        std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
    }

    let spec = DelegateSpec {
        id: "fc".into(),
        task: "any task".into(),
        agent_id: None,
        preset: PermissionPreset::Summarise,
        inline: None,
    };
    let caps = DelegationCaps {
        wall_time_secs: 3,
        ..Default::default()
    };
    let results = run_fanout(vec![spec], caps, 1, None)
        .await
        .expect("fan-out itself doesn't error");
    assert_eq!(results.len(), 1);
    let err = results[0].error.as_deref().unwrap_or("");
    assert!(
        err.contains("gateway") || err.contains("wall-time"),
        "expected gateway or wall-time error, got: {err}"
    );

    unsafe {
        match prev_url {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }
        match prev_fb {
            Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
            None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
        }
    }
}

#[tokio::test]
async fn inline_delegate_takes_clean_context_gateway_path() {
    // An inline ephemeral sub-agent (no registered agent_id) must run through
    // the Gateway completion path — proven here by the fail-closed error when
    // the gateway is unreachable. This exercises the inline branch of
    // `call_sub_agent` end-to-end without a live gateway.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
    let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
    unsafe {
        std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
    }

    let spec = DelegateSpec {
        id: "inline0".into(),
        task: "classify this ticket".into(),
        agent_id: None,
        preset: PermissionPreset::default(),
        inline: Some(InlineAgentDef {
            system_prompt: "You are a terse ticket triager. Reply with one label.".into(),
            model: Some("gpt-4o-mini".into()),
            tools: vec!["read_memory".into()],
        }),
    };
    let caps = DelegationCaps {
        wall_time_secs: 3,
        ..Default::default()
    };
    let results = run_fanout(vec![spec], caps, 1, None)
        .await
        .expect("fan-out itself doesn't error");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].id, "inline0");
    let err = results[0].error.as_deref().unwrap_or("");
    assert!(
        err.contains("gateway") || err.contains("wall-time"),
        "inline delegate must go through the gateway path (fail-closed), got: {err}"
    );

    unsafe {
        match prev_url {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }
        match prev_fb {
            Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
            None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
        }
    }
}

#[tokio::test]
async fn inline_takes_precedence_over_agent_id() {
    // A spec that carries BOTH an agent_id and an inline def must take the
    // inline clean-context Gateway path uniformly (never the registered-agent
    // path), so behavior does not depend on whether a runner is live. With an
    // unreachable gateway this surfaces as the fail-closed gateway error.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
    let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
    unsafe {
        std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
    }
    let spec = DelegateSpec {
        id: "both".into(),
        task: "do the thing".into(),
        agent_id: Some("ryu".into()),
        preset: PermissionPreset::default(),
        inline: Some(InlineAgentDef {
            system_prompt: "You are an inline specialist.".into(),
            model: None,
            tools: vec![],
        }),
    };
    let results = run_fanout(
        vec![spec],
        DelegationCaps {
            wall_time_secs: 3,
            ..Default::default()
        },
        1,
        None,
    )
    .await
    .expect("fan-out runs");
    assert_eq!(results.len(), 1);
    let err = results[0].error.as_deref().unwrap_or("");
    assert!(
        err.contains("gateway") || err.contains("wall-time"),
        "inline+agent_id must take the inline gateway path, got: {err}"
    );
    unsafe {
        match prev_url {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }
        match prev_fb {
            Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
            None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
        }
    }
}

#[test]
fn inline_agent_def_survives_json_round_trip() {
    // The inline field must (de)serialize so workflow-authored `AgentDelegate`
    // nodes and the `delegate.fanout` tool can carry inline sub-agents.
    let spec = DelegateSpec {
        id: "d0".into(),
        task: "t".into(),
        agent_id: None,
        preset: PermissionPreset::default(),
        inline: Some(InlineAgentDef {
            system_prompt: "be brief".into(),
            model: None,
            tools: vec!["web_search".into(), "web_fetch".into()],
        }),
    };
    let json = serde_json::to_string(&spec).expect("serialize");
    let back: DelegateSpec = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(spec, back);
    // A spec without inline omits the field and still parses (back-compat).
    let legacy: DelegateSpec =
        serde_json::from_str(r#"{"id":"d1","task":"t"}"#).expect("legacy parse");
    assert!(legacy.inline.is_none());
    assert!(legacy.agent_id.is_none());
}
