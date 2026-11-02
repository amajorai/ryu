use super::*;

struct SafeActionsTestHooks;

impl crate::plugin_host::HookDispatch for SafeActionsTestHooks {
    fn dispatch<'a>(
        &'a self,
        phase: &'a str,
        ctx: crate::plugin_host::HookContext,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Vec<crate::plugin_host::HookDirective>> + Send + 'a>,
    > {
        Box::pin(async move {
            if phase == crate::plugin_host::ON_PRE_TOOL_USE
                && ctx.tool_name.as_deref() == Some("app.echo")
                && ctx.tool_input.as_ref().and_then(|value| value.get("hook"))
                    == Some(&json!("block"))
            {
                return vec![crate::plugin_host::HookDirective::Deny {
                    reason: "blocked by the Safe Actions hook fixture".to_owned(),
                }];
            }
            Vec::new()
        })
    }

    fn dispatch_tool_result<'a>(
        &'a self,
        ctx: crate::plugin_host::HookContext,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<Value>> + Send + 'a>> {
        Box::pin(async move {
            (ctx.tool_name.as_deref() == Some("app.echo")
                && ctx.tool_input.as_ref().and_then(|value| value.get("hook"))
                    == Some(&json!("redact")))
            .then(|| json!({"value": "[redacted by hook]"}))
        })
    }
}

#[tokio::test]
async fn verified_plan_executes_once_through_the_live_registry_boundary() {
    use crate::plugin_manifest::schema::RunnableEntry;
    use crate::plugin_manifest::PluginManifest;
    use crate::runnable::RunnableKind;
    use crate::sidecar::mcp::{AppToolBackendTag, RegistryTool};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tokio::sync::RwLock;

    struct GatewayEnv {
        fallback: Option<std::ffi::OsString>,
        approval_mode: Option<std::ffi::OsString>,
        gateway_url: Option<std::ffi::OsString>,
    }
    impl Drop for GatewayEnv {
        fn drop(&mut self) {
            unsafe {
                match self.fallback.take() {
                    Some(value) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", value),
                    None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
                }
                match self.approval_mode.take() {
                    Some(value) => std::env::set_var("RYU_EXEC_APPROVAL_MODE", value),
                    None => std::env::remove_var("RYU_EXEC_APPROVAL_MODE"),
                }
                match self.gateway_url.take() {
                    Some(value) => std::env::set_var("RYU_GATEWAY_URL", value),
                    None => std::env::remove_var("RYU_GATEWAY_URL"),
                }
            }
        }
    }

    let _gateway_env_lock = crate::sidecar::gateway::lock_gateway_env();
    let _gateway_env = GatewayEnv {
        fallback: std::env::var_os("RYU_ALLOW_GATEWAY_FALLBACK"),
        approval_mode: std::env::var_os("RYU_EXEC_APPROVAL_MODE"),
        gateway_url: std::env::var_os("RYU_GATEWAY_URL"),
    };
    unsafe {
        std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
        std::env::set_var("RYU_EXEC_APPROVAL_MODE", "off");
        // Keep the live-boundary test hermetic. A developer machine may have
        // a real Gateway at the profile default, but this fixture is testing
        // the explicit local fallback path, not Gateway authentication.
        std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    }

    let calls = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/echo", listener.local_addr().unwrap());
    let echo = Router::new()
        .route(
            "/echo",
            post(
                |State(counter): State<Arc<AtomicUsize>>, Json(body): Json<Value>| async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    let value = body.get("value").cloned().unwrap_or(Value::Null);
                    if value == json!("needs-auth") {
                        return Json(json!({
                            "__ryu_elicitation__": {
                                "kind": "url",
                                "message": "Connect the fixture account",
                                "url": "https://example.invalid/connect"
                            }
                        }));
                    }
                    Json(json!({"value": value}))
                },
            ),
        )
        .with_state(Arc::clone(&calls));
    let server = tokio::spawn(async move {
        axum::serve(listener, echo).await.unwrap();
    });

    let app_store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    app_store.insert("com.test.echo", "1.0.0").await.unwrap();
    app_store
        .set_enabled("com.test.echo", &["tool:http-egress:127.0.0.1".to_owned()])
        .await
        .unwrap();
    let input_schema = json!({
        "type": "object",
        "properties": { "value": { "type": "string" } },
        "required": ["value"],
        "additionalProperties": false
    });
    let output_schema = input_schema.clone();
    let manifest = PluginManifest {
        id: "com.test.echo".to_owned(),
        name: "Echo fixture".to_owned(),
        version: "1.0.0".to_owned(),
        permission_grants: vec!["tool:http-egress:127.0.0.1".to_owned()],
        runnables: vec![RunnableEntry {
            id: "echo".to_owned(),
            name: "echo".to_owned(),
            kind: RunnableKind::Tool,
            config: Some(json!({
                "slug": "echo",
                "backend": "http",
                "url": endpoint,
                "method": "POST",
                "unwrap_body": true,
                "input_schema": input_schema,
                "output_schema": output_schema,
            })),
        }],
        companion: None,
        ..Default::default()
    };
    let manifests = Arc::new(RwLock::new(vec![manifest]));
    let acp_registry = crate::sidecar::adapters::AcpAgentRegistry::new();
    let agent_store = crate::agents::AgentStore::open_in_memory(&acp_registry).unwrap();
    let create: crate::agents::CreateAgent = serde_json::from_value(json!({
        "name": "Verified echo",
        "safety_profile": "verified_plan_only",
        "tools": ["app.echo"]
    }))
    .unwrap();
    let created = agent_store.create(create).await.unwrap();
    let agent = agent_store
        .update(
            &created.id,
            crate::agents::UpdateAgent {
                lifecycle_status: Some(crate::agents::AgentLifecycleStatus::Active),
                ..Default::default()
            },
        )
        .await
        .unwrap()
        .unwrap();

    let registry = Arc::new(
        crate::sidecar::mcp::McpRegistry::empty()
            .with_self_build(manifests, app_store)
            .with_agent_store(agent_store),
    );
    registry.register_test_app_tool_descriptor(RegistryTool {
        id: "app.echo".to_owned(),
        server: "app".to_owned(),
        name: "echo".to_owned(),
        description: Some("Echo a value".to_owned()),
        input_schema: Some(input_schema.clone()),
        output_schema: Some(output_schema.clone()),
        annotations: Some(json!({"readOnlyHint": true})),
        meta: None,
        widget: None,
        widget_accessible: false,
        output_template: None,
        app_backend: Some(AppToolBackendTag::Http),
    });
    assert!(
        crate::plugin_host::set_global(Arc::new(SafeActionsTestHooks)),
        "the live-boundary test must own the process-global hook dispatcher"
    );
    let blocked = registry
        .call_tool_with_identity_after_approval(
            None,
            "app.echo",
            json!({"value": "must-not-run", "hook": "block"}),
            Some(&["app.echo".to_owned()]),
            None,
            &[],
            None,
            None,
        )
        .await
        .unwrap_err();
    assert!(blocked.to_string().contains("blocked by a plugin hook"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let redacted = registry
        .call_tool_with_identity_after_approval(
            None,
            "app.echo",
            json!({"value": "secret result", "hook": "redact"}),
            Some(&["app.echo".to_owned()]),
            None,
            &[],
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(redacted, json!({"value": "[redacted by hook]"}));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    calls.store(0, Ordering::SeqCst);
    let probe = registry
        .call_tool_with_identity_after_approval(
            None,
            "app.echo",
            json!({"value": "probe"}),
            Some(&["app.echo".to_owned()]),
            None,
            &[],
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(probe, json!({"value": "probe"}));
    calls.store(0, Ordering::SeqCst);
    let store = SafeActionsStore::open_in_memory().unwrap();
    let service = SafeActionsService::with_registry(store.clone(), Arc::clone(&registry));
    let descriptor = service
        .catalog(Some(&agent.tools))
        .await
        .unwrap()
        .into_iter()
        .find(|tool| tool.name == "app.echo")
        .unwrap();
    let contract = ryu_safe_actions::EffectContract {
        trust: ContractTrust::OperatorAttested,
        effects: [ryu_safe_actions::EffectKind::Read].into_iter().collect(),
        resources: ["test://echo/value".to_owned()].into_iter().collect(),
        resource_bindings: Vec::new(),
        arguments_independent: true,
    };
    store
        .put_contract(
            ToolContractRecord {
                tool: "app.echo".to_owned(),
                contract: contract.clone(),
                contract_hash: sha256_canonical(&contract).unwrap(),
                implementation_hash: descriptor.implementation_hash,
                attested_by: "operator-1".to_owned(),
                created_at: String::new(),
                updated_at: String::new(),
            },
            None,
            None,
        )
        .await
        .unwrap();
    let policy = Policy {
        allow_tools: ["app.echo".to_owned()].into_iter().collect(),
        deny_tools: Default::default(),
        allowed_effects: [ryu_safe_actions::EffectKind::Read].into_iter().collect(),
        allowed_resources: ["test://echo/*".to_owned()].into_iter().collect(),
        review_tools: Default::default(),
        review_effects: [ryu_safe_actions::EffectKind::Read].into_iter().collect(),
        allow_parallel_reads: false,
        limits: Default::default(),
    };
    let policy_hash = sha256_canonical(&policy).unwrap();
    let policy = store
        .put_policy(
            PolicyRecord {
                id: "echo-policy".to_owned(),
                name: "Echo policy".to_owned(),
                description: None,
                policy,
                policy_hash,
                version: 0,
                bound_agent_ids: vec![agent.id.clone()],
                created_at: String::new(),
                updated_at: String::new(),
            },
            None,
        )
        .await
        .unwrap();

    let raw_error = registry
        .call_tool_with_identity(
            Some(&agent.id),
            "app.echo",
            json!({"value": "unsafe"}),
            Some(&agent.tools),
            None,
            &[],
            None,
            None,
        )
        .await
        .unwrap_err();
    assert!(raw_error.to_string().contains("typed plan"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let plan = ToolPlan {
        schema_version: ryu_safe_actions::TOOL_PLAN_SCHEMA_VERSION,
        root: PlanNode::Call {
            id: "echo".to_owned(),
            tool: "app.echo".to_owned(),
            arguments: PlanValue::Object {
                fields: BTreeMap::from([(
                    "value".to_owned(),
                    PlanValue::Literal {
                        value: json!("verified"),
                    },
                )]),
            },
        },
    };
    let pending = service
        .submit(&agent.id, "request-echo-1", plan.clone(), None)
        .await
        .unwrap();
    assert_eq!(pending.get("status"), Some(&json!("pending_review")));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let submission_id = pending
        .pointer("/submission/id")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    let plan_hash = pending
        .pointer("/submission/report/bindings/plan_hash")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    let mismatched = service
        .approve(
            &submission_id,
            ReviewDecisionInput {
                note: None,
                expected_plan_hash: "hash-from-another-visible-review".to_owned(),
            },
            "operator-1".to_owned(),
        )
        .await
        .unwrap_err();
    assert!(mismatched.to_string().contains("plan binding"));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        store
            .get_submission(&submission_id)
            .await
            .unwrap()
            .unwrap()
            .status,
        "pending_review"
    );
    let completed = service
        .approve(
            &submission_id,
            ReviewDecisionInput {
                note: Some("verified test approval".to_owned()),
                expected_plan_hash: plan_hash,
            },
            "operator-1".to_owned(),
        )
        .await
        .unwrap();
    assert_eq!(completed.get("status"), Some(&json!("succeeded")));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let receipt = store.get_receipt(&submission_id).await.unwrap().unwrap();
    assert_eq!(receipt.status, "succeeded");
    assert_eq!(receipt.steps.len(), 1);
    assert_eq!(receipt.steps[0].status, "succeeded");

    let auth_plan = ToolPlan {
        schema_version: ryu_safe_actions::TOOL_PLAN_SCHEMA_VERSION,
        root: PlanNode::Call {
            id: "echo-auth".to_owned(),
            tool: "app.echo".to_owned(),
            arguments: PlanValue::Object {
                fields: BTreeMap::from([(
                    "value".to_owned(),
                    PlanValue::Literal {
                        value: json!("needs-auth"),
                    },
                )]),
            },
        },
    };
    let auth_pending = service
        .submit(&agent.id, "request-echo-auth", auth_plan, None)
        .await
        .unwrap();
    let auth_submission_id = auth_pending
        .pointer("/submission/id")
        .and_then(Value::as_str)
        .unwrap();
    let auth_plan_hash = auth_pending
        .pointer("/submission/report/bindings/plan_hash")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    let auth_blocked = service
        .approve(
            auth_submission_id,
            ReviewDecisionInput {
                note: None,
                expected_plan_hash: auth_plan_hash,
            },
            "operator-1".to_owned(),
        )
        .await
        .unwrap_err();
    assert!(auth_blocked
        .to_string()
        .contains("tool execution did not complete"));
    let auth_receipt = store
        .get_receipt(auth_submission_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(auth_receipt.status, "blocked");
    assert_eq!(auth_receipt.steps[0].status, "blocked");
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    assert!(store
        .delete_policy(&policy.id, policy.version)
        .await
        .unwrap());
    let retry = service
        .submit(&agent.id, "request-echo-1", plan, None)
        .await
        .unwrap();
    assert_eq!(retry.get("status"), Some(&json!("succeeded")));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    server.abort();
}

#[tokio::test]
async fn raw_dispatch_has_no_implicit_verified_grant() {
    let error = authorize_verified_dispatch("agent", "files.delete", &json!({"id": 1}))
        .await
        .unwrap_err();
    assert!(error.to_string().contains("direct tool call denied"));
}
