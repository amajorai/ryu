use super::*;

mod checkpoints;
mod direct_hop;
mod gateway_path;

#[test]
fn presets_map_to_capabilities() {
    assert!(PermissionPreset::Summarise.allowed_tools().is_empty());
    assert!(!PermissionPreset::CodeRead.allows_mutation());
    assert!(PermissionPreset::CodeWrite.allows_mutation());
    assert!(PermissionPreset::Research
        .allowed_tools()
        .contains(&"web_search"));
    // code_read must never grant a write capability.
    assert!(!PermissionPreset::CodeRead
        .allowed_tools()
        .contains(&"write_file"));
}

#[test]
fn catalog_read_only_execution_skips_write_capable_registered_agent() {
    let spec = DelegateSpec {
        id: "catalog-review".into(),
        task: "review the listing".into(),
        agent_id: Some("write-capable-agent".into()),
        preset: PermissionPreset::CodeRead,
        inline: None,
    };

    assert!(!should_use_registered_agent(
        &spec,
        DelegationExecutionPolicy::ReadOnly
    ));
    assert!(!should_use_registered_agent(
        &spec,
        DelegationExecutionPolicy::Normal
    ));
}

#[test]
fn caps_clamp_concurrency() {
    let caps = DelegationCaps {
        max_concurrent: 99,
        ..Default::default()
    };
    assert_eq!(caps.effective_concurrency(), MAX_CONCURRENT_DELEGATES);

    let zero = DelegationCaps {
        max_concurrent: 0,
        ..Default::default()
    };
    assert_eq!(zero.effective_concurrency(), 1);
}

#[test]
fn caps_clamp_token_budget() {
    let caps = DelegationCaps {
        max_tokens: u32::MAX,
        ..Default::default()
    };
    assert_eq!(caps.effective_max_tokens(), MAX_DELEGATION_TOKENS);

    let caps = DelegationCaps {
        max_tokens: 0,
        ..Default::default()
    };
    assert_eq!(caps.effective_max_tokens(), 1);
}

#[test]
fn lifecycle_transition_is_narrow_and_monotonic() {
    let first = next_lifecycle_transition_id();
    let second = next_lifecycle_transition_id();
    assert!(second > first);
    let transition = DelegationLifecycleTransition {
        run_id: "run-1".into(),
        agent_id: "agent-a".into(),
        active_count: 0,
        transition_id: second,
        run_active_count: 0,
    };
    let value = serde_json::to_value(transition).expect("transition serialises");
    assert_eq!(
        value,
        serde_json::json!({
            "run_id": "run-1",
            "agent_id": "agent-a",
            "active_count": 0,
            "transition_id": second,
            "run_active_count": 0,
        })
    );
    assert_eq!(value.as_object().expect("object").len(), 5);
}

#[test]
fn read_only_presets_never_enter_a_registered_agent_tool_loop() {
    let mut spec = DelegateSpec {
        id: "review".into(),
        task: "inspect".into(),
        agent_id: Some("configured-agent".into()),
        preset: PermissionPreset::CodeRead,
        inline: None,
    };
    assert!(!should_use_registered_agent(
        &spec,
        DelegationExecutionPolicy::Normal
    ));
    spec.preset = PermissionPreset::Summarise;
    assert!(!should_use_registered_agent(
        &spec,
        DelegationExecutionPolicy::Normal
    ));
    spec.preset = PermissionPreset::CodeWrite;
    assert!(should_use_registered_agent(
        &spec,
        DelegationExecutionPolicy::Normal
    ));
}

#[test]
fn lifecycle_registry_tracks_overlapping_runs() {
    let mut first = DelegationRunReservation::reserve("run-a", "agent-a").admit();
    assert_eq!(active_by_run().lock().unwrap().get("run-a"), Some(&1));
    let mut second = DelegationRunReservation::reserve("run-b", "agent-b").admit();
    assert_eq!(active_by_run().lock().unwrap().get("run-a"), Some(&1));
    assert_eq!(active_by_run().lock().unwrap().get("run-b"), Some(&1));
    first.finish();
    assert!(!active_by_run().lock().unwrap().contains_key("run-a"));
    assert_eq!(active_by_run().lock().unwrap().get("run-b"), Some(&1));
    second.finish();
    assert!(!active_by_run().lock().unwrap().contains_key("run-b"));
}

#[test]
fn queued_delegates_keep_their_run_active_until_the_last_finishes() {
    // Three delegates at concurrency 1: each is reserved at fan-out, then
    // admitted and finished one at a time. The run only drains on the last.
    let run = "run-queued-serial";
    let count = || active_by_run().lock().unwrap().get(run).copied();
    let mut queued: Vec<_> = ["a", "b", "c"]
        .into_iter()
        .map(|agent| DelegationRunReservation::reserve(run, agent))
        .collect();
    assert_eq!(count(), Some(3));
    let mut remaining = 3;
    while !queued.is_empty() {
        let mut lease = queued.remove(0).admit();
        assert_eq!(count(), Some(remaining));
        lease.finish();
        remaining -= 1;
        if remaining > 0 {
            assert_eq!(count(), Some(remaining));
        }
    }
    assert_eq!(count(), None);
}

#[test]
fn an_unadmitted_reservation_still_leaves_its_run() {
    let run = "run-queued-dropped";
    let mut admitted = DelegationRunReservation::reserve(run, "a").admit();
    let never_admitted = DelegationRunReservation::reserve(run, "b");
    admitted.finish();
    assert_eq!(active_by_run().lock().unwrap().get(run), Some(&1));
    drop(never_admitted);
    assert!(!active_by_run().lock().unwrap().contains_key(run));
}

#[tokio::test]
async fn rejects_excess_depth() {
    let specs = vec![DelegateSpec {
        id: "d1".into(),
        task: "x".into(),
        agent_id: None,
        preset: PermissionPreset::Summarise,
        inline: None,
    }];
    let err = run_fanout(
        specs,
        DelegationCaps::default(),
        MAX_DELEGATION_DEPTH + 1,
        None,
    )
    .await
    .expect_err("over-depth must be rejected");
    assert!(matches!(err, DelegationError::DepthExceeded { .. }));
}

#[tokio::test]
async fn rejects_empty_fanout() {
    let err = run_fanout(vec![], DelegationCaps::default(), 1, None)
        .await
        .expect_err("empty fan-out must be rejected");
    assert!(matches!(err, DelegationError::Empty));
}

#[tokio::test]
async fn wall_time_cap_is_enforced() {
    // Point gateway at an unroutable address so the request hangs, then
    // assert the wall-time cap fires fast and yields a cap-violation error.
    // RYU_GATEWAY_URL is the gateway URL; fallback is disabled by default.
    // Process-global var shared with other modules' tests: hold the gateway-env
    // lock across the body and restore on exit.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
    // The fallback switch is removed too, so a value left in the environment
    // cannot send the call past the unreachable Gateway.
    let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
    unsafe {
        std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
    }

    let spec = DelegateSpec {
        id: "slow".into(),
        task: "hang".into(),
        agent_id: None,
        preset: PermissionPreset::Summarise,
        inline: None,
    };
    let caps = DelegationCaps {
        wall_time_secs: 1,
        ..Default::default()
    };
    let results = run_fanout(vec![spec], caps, 1, None)
        .await
        .expect("fan-out runs");
    assert_eq!(results.len(), 1);
    assert!(results[0].error.is_some());

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
async fn fanout_preserves_order_and_streams_progress() {
    // Three summarise delegates against an unreachable gateway: each fails
    // fast but ordering and progress events must still hold.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
    // The fallback switch is removed too, so a value left in the environment
    // cannot send the call past the unreachable Gateway.
    let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
    unsafe {
        std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
    }

    let specs: Vec<DelegateSpec> = (0..3)
        .map(|i| DelegateSpec {
            id: format!("d{i}"),
            task: format!("task {i}"),
            agent_id: None,
            preset: PermissionPreset::Summarise,
            inline: None,
        })
        .collect();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let caps = DelegationCaps {
        wall_time_secs: 2,
        ..Default::default()
    };
    let results = run_fanout(specs, caps, 1, Some(tx))
        .await
        .expect("fan-out runs");

    assert_eq!(results.len(), 3);
    for (i, r) in results.iter().enumerate() {
        assert_eq!(r.id, format!("d{i}"));
    }

    let mut started = 0;
    let mut finished = 0;
    while let Ok(ev) = rx.try_recv() {
        match ev {
            DelegateProgress::Started { .. } => started += 1,
            DelegateProgress::Finished { .. } => finished += 1,
        }
    }
    assert_eq!(started, 3);
    assert_eq!(finished, 3);

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

/// Verify that a fan-out with a checkpoint key skips already-completed
/// delegates on resume and preserves input-order results with sentinel output.
#[tokio::test]
async fn durable_fanout_skips_completed_delegates_on_resume() {
    // Point gateway at blackhole so any live call fails fast.
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
    // The fallback switch is removed too, so a value left in the environment
    // cannot send the call past the unreachable Gateway.
    let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
    unsafe {
        std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
    }

    let key = Arc::new(FanoutCheckpointKey {
        run_id: format!("test-run-{}", uuid::Uuid::new_v4().simple()),
        node_id: "delegate-node".to_string(),
    });

    // Pre-seed: checkpoint d0 as completed with a sentinel; d1 is pending.
    let sentinel = DelegateResult::ok(
        "d0".to_string(),
        PermissionPreset::Summarise,
        "__SENTINEL_D0__".to_string(),
    );
    save_delegate_checkpoint(&key, &sentinel);

    let specs: Vec<DelegateSpec> = vec![
        DelegateSpec {
            id: "d0".into(),
            task: "should be skipped".into(),
            agent_id: None,
            preset: PermissionPreset::Summarise,
            inline: None,
        },
        DelegateSpec {
            id: "d1".into(),
            task: "will fail fast (gateway unreachable)".into(),
            agent_id: None,
            preset: PermissionPreset::Summarise,
            inline: None,
        },
    ];

    let caps = DelegationCaps {
        wall_time_secs: 2,
        ..Default::default()
    };

    let results = run_fanout_with_checkpoint(specs, caps, 1, None, Some(Arc::clone(&key)))
        .await
        .expect("fan-out with checkpoint runs");

    assert_eq!(results.len(), 2);
    // d0 must carry the sentinel, proving it was resumed from checkpoint.
    assert_eq!(results[0].id, "d0");
    assert_eq!(
        results[0].output.as_deref(),
        Some("__SENTINEL_D0__"),
        "d0 must carry sentinel from checkpoint, not be re-run"
    );
    // d1 must have been attempted (and failed, since gateway is unreachable).
    assert_eq!(results[1].id, "d1");
    assert!(
        results[1].error.is_some(),
        "d1 must have failed (gateway unreachable)"
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
