use super::*;

#[tokio::test]
async fn configuration_http_request_checks_peer_edit_acl_after_calling_agent_run_grant() {
    use axum::{body::Body, http::Request, routing::post, Json, Router};
    use tower::ServiceExt;
    let _lock = ACL_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let _restore = install_agent_acl();
    let key = crate::acl::store::ResourceKey::new(crate::acl::KIND_AGENT, PERSISTED_AGENT_ID);
    let mut overwrites = crate::acl::store::stored_for(&key);
    overwrites.push(crate::acl::store::StoredOverwrite {
        target_type: "member".to_owned(),
        target_id: "carol".to_owned(),
        allow: vec![crate::identity_verify::permissions::AGENT_EDIT.to_owned()],
        deny: Vec::new(),
    });
    crate::acl::store::set_overwrites(&key, overwrites).unwrap();
    let bob = member("bob");
    assert_eq!(
        crate::acl::decide_with_context(
            &bob,
            crate::acl::KIND_AGENT,
            "calling-agent",
            crate::identity_verify::permissions::AGENT_RUN,
            &std::collections::HashSet::new(),
            &std::collections::HashSet::new()
        ),
        crate::acl::Decision::Allowed
    );
    for (user, expected) in [("bob", StatusCode::FORBIDDEN), ("carol", StatusCode::OK)] {
        let caller = member(user);
        let registry = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        registry.register_app_tool(
            "app.agent_builder.configure_agent".to_owned(),
            "agent_builder.configure_agent".to_owned(),
            None,
        );
        let writes = Arc::new(AtomicUsize::new(0));
        let handler_writes = Arc::clone(&writes);
        let router = Router::new().route(
            "/api/mcp/tools/call",
            post(move |Json(body): Json<serde_json::Value>| {
                let registry = Arc::clone(&registry);
                let caller = caller.clone();
                let writes = Arc::clone(&handler_writes);
                async move {
                    let result = crate::server::authorize_agent_configuration_tool(
                        &registry,
                        body["tool"].as_str().unwrap(),
                        &body["arguments"],
                        |target| async move {
                            assert_eq!(target, PERSISTED_AGENT_ID);
                            match crate::acl::decide_with_context(
                                &caller,
                                crate::acl::KIND_AGENT,
                                target,
                                crate::identity_verify::permissions::AGENT_EDIT,
                                &std::collections::HashSet::new(),
                                &std::collections::HashSet::new(),
                            ) {
                                crate::acl::Decision::Allowed => Ok(()),
                                crate::acl::Decision::Denied => Err(json_error(
                                    StatusCode::FORBIDDEN,
                                    "agent.edit denied".to_owned(),
                                )),
                            }
                        },
                    )
                    .await;
                    match result {
                        Err(response) => response,
                        Ok(()) => {
                            writes.fetch_add(1, Ordering::SeqCst);
                            json_error(StatusCode::OK, "authorized target".to_owned())
                        }
                    }
                }
            }),
        );
        for tool in [
            "agent_builder.configure_agent",
            "agent_builder__configure_agent",
            "app.agent_builder.configure_agent",
        ] {
            let body = serde_json::json!({"tool": tool, "agent_id": "calling-agent",
                "arguments": {"agent_id": PERSISTED_AGENT_ID, "name": "Changed"}});
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/mcp/tools/call")
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
        }
        assert_eq!(
            writes.load(Ordering::SeqCst),
            if expected == StatusCode::OK { 3 } else { 0 }
        );
    }
}

#[tokio::test]
async fn network_configuration_checks_target_acl_and_preserves_interactive_authority() {
    use axum::response::IntoResponse;
    use axum::{body::Body, http::Request, routing::post, Json, Router};
    use tower::ServiceExt;
    let _lock = ACL_TEST_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let directory = tempfile::tempdir().unwrap();
    let preferences =
        crate::server::preferences::PreferencesStore::open(directory.path().join("preferences.db"))
            .unwrap();
    preferences
        .set(crate::approvals::policy::APPROVAL_MODE_PREF, "off")
        .await
        .unwrap();
    let agent_path = directory.path().join("agents.db");
    let agents = crate::agents::AgentStore::open_approval_test_file(&agent_path).unwrap();
    assert!(agents.get("ryu").await.unwrap().is_some());
    let target = agents
        .create(crate::agents::CreateAgent {
            name: "Original".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap();
    let sql = rusqlite::Connection::open(&agent_path).unwrap();
    sql.execute_batch("CREATE TABLE configure_action_audit (agent_id TEXT); CREATE TRIGGER configure_action_count AFTER UPDATE OF name ON agents BEGIN INSERT INTO configure_action_audit VALUES (NEW.id); END;").unwrap();
    let key = crate::acl::store::ResourceKey::new(crate::acl::KIND_AGENT, &target.id);
    let _restore = RestoredAgentAcl {
        previous: crate::acl::store::stored_for(&key),
        key: key.clone(),
    };
    crate::acl::store::set_overwrites(
        &key,
        vec![
            crate::acl::store::StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: "bob".to_owned(),
                allow: Vec::new(),
                deny: vec![crate::identity_verify::permissions::AGENT_EDIT.to_owned()],
            },
            crate::acl::store::StoredOverwrite {
                target_type: "member".to_owned(),
                target_id: "carol".to_owned(),
                allow: vec![crate::identity_verify::permissions::AGENT_EDIT.to_owned()],
                deny: Vec::new(),
            },
        ],
    )
    .unwrap();
    assert_eq!(crate::acl::store::stored_for(&key).len(), 2);
    let registry =
        Arc::new(crate::sidecar::mcp::McpRegistry::empty().with_agent_store(agents.clone()));
    registry.register_app_tool(
        "app.agent_builder.configure_agent".to_owned(),
        "agent_builder.configure_agent".to_owned(),
        None,
    );
    let approvals = crate::approvals::store::ApprovalStore::open_in_memory().unwrap();
    let engine = Arc::new(
        crate::approvals::ApprovalEngine::new(approvals.clone(), reqwest::Client::new())
            .with_preferences(preferences)
            .with_registry(Arc::clone(&registry)),
    );
    // The actual network adapter has no interactive permission channel. A
    // target ACL grant must not silently supply that separate authority.
    for tool in [
        "agent_builder.configure_agent",
        "agent_builder__configure_agent",
        "app.agent_builder.configure_agent",
    ] {
        let message = serde_json::json!({"jsonrpc":"2.0", "id":7, "method":"tools/call",
            "params":{"name":tool, "arguments":{"agent_id":target.id, "name":"Changed"}}});
        let response =
            crate::sidecar::adapters::mcp_bridge::serve_http_jsonrpc_versioned_with_headers(
                Arc::clone(&registry),
                "ryu".to_owned(),
                None,
                Vec::new(),
                &message,
                false,
                &axum::http::HeaderMap::new(),
            )
            .await
            .expect("tools/call must respond");
        assert_eq!(response["result"]["isError"], serde_json::json!(true));
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("requires an interactive permission channel"),
            "{tool}: unexpected network refusal: {response}"
        );
        assert_eq!(
            agents.get(&target.id).await.unwrap().unwrap().name,
            "Original"
        );
        assert!(approvals
            .list(Some(crate::approvals::ApprovalStatus::Pending))
            .await
            .unwrap()
            .is_empty());
    }
    // Exercise the ACL-before-queue seam with a grant already obtained by
    // an interactive caller. Operator review preserves that grant; it must
    // never manufacture a missing identity or interactive permission.
    for (user, expected) in [("bob", StatusCode::FORBIDDEN), ("carol", StatusCode::OK)] {
        let caller = member(user);
        assert_eq!(
            crate::acl::decide_with_context(
                &caller,
                crate::acl::KIND_AGENT,
                "ryu",
                crate::identity_verify::permissions::AGENT_RUN,
                &std::collections::HashSet::new(),
                &std::collections::HashSet::new()
            ),
            crate::acl::Decision::Allowed
        );
        let registry = Arc::clone(&registry);
        let engine = Arc::clone(&engine);
        let router = Router::new().route("/mcp/ryu", post(move |Json(message): Json<serde_json::Value>| {
            let registry = Arc::clone(&registry);
            let caller = caller.clone();
            let engine = Arc::clone(&engine);
            async move {
                if let Err(response) = crate::server::authorize_network_agent_configuration_tool(
                    &registry, &message, |target| async move {
                        match crate::acl::decide_with_context(&caller, crate::acl::KIND_AGENT,
                            target, crate::identity_verify::permissions::AGENT_EDIT,
                            &std::collections::HashSet::new(), &std::collections::HashSet::new()) {
                            crate::acl::Decision::Allowed => Ok(()),
                            crate::acl::Decision::Denied => Err(json_error(StatusCode::FORBIDDEN, "agent.edit denied".to_owned())),
                        }
                    }).await { return response; }
                let tool = message["params"]["name"].as_str().unwrap();
                let arguments = &message["params"]["arguments"];
                // The interactive bridge separately supplies the verified calling
                // agent and configuration grant; inbox approval preserves both.
                let allowlist = vec![registry.canonical_tool_id_for_registry(tool)];
                assert!(crate::approvals::gate_tool_call_with_engine(&engine,
                    crate::runnable::agent_configuration_policy::TOOL_ID,
                    &registry.canonical_tool_id_for_registry(tool), arguments,
                    Some("ryu"), &[], Some(&allowlist), None, &[], None, None, None, None, true, true).await.is_some());
                Json(serde_json::json!({"jsonrpc":"2.0", "id":message["id"], "result":{"approval_pending":true}})).into_response()
            }
        }));
        for tool in [
            "agent_builder.configure_agent",
            "agent_builder__configure_agent",
            "app.agent_builder.configure_agent",
        ] {
            let message = serde_json::json!({"jsonrpc":"2.0", "id":7, "method":"tools/call",
                "params":{"name":tool, "arguments":{"agent_id":target.id, "name":"Changed"}}});
            let response = router
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/mcp/ryu")
                        .header("content-type", "application/json")
                        .body(Body::from(message.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                expected,
                "target denied caller must not queue approval"
            );
            assert_eq!(
                agents.get(&target.id).await.unwrap().unwrap().name,
                "Original"
            );
        }
        let pending = approvals
            .list(Some(crate::approvals::ApprovalStatus::Pending))
            .await
            .unwrap();
        assert_eq!(pending.len(), if user == "bob" { 0 } else { 3 });
    }
    for approval in approvals
        .list(Some(crate::approvals::ApprovalStatus::Pending))
        .await
        .unwrap()
    {
        let Some(crate::approvals::PendingAction::ToolCall {
            agent_id,
            arguments,
            configure_approved,
            ..
        }) = approval.action.as_ref()
        else {
            panic!("configuration must queue its actual authorized action");
        };
        assert_eq!(agent_id.as_deref(), Some("ryu"));
        assert_eq!(arguments["agent_id"], serde_json::json!(target.id));
        assert!(*configure_approved);
        engine.decide(&approval.id, true, None).await.unwrap();
    }
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let rows = approvals.list(None).await.unwrap();
            for row in &rows {
                assert!(
                    row.error.is_none(),
                    "authorized configuration failed: {:?}",
                    row.error
                );
            }
            if rows.len() == 3 && rows.iter().all(|row| row.result.is_some()) {
                assert_eq!(
                    agents.get(&target.id).await.unwrap().unwrap().name,
                    "Changed"
                );
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("authorized operator review must execute configuration");
    let count: i64 = sql
        .query_row(
            "SELECT count(*) FROM configure_action_audit WHERE agent_id = ?1",
            rusqlite::params![target.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        count, 3,
        "each approved alias must perform exactly one durable edit"
    );
    let reopened = crate::agents::AgentStore::open_approval_test_file(&agent_path).unwrap();
    assert_eq!(
        reopened.get(&target.id).await.unwrap().unwrap().name,
        "Changed"
    );
}
