//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::{allow_discovery_test_host, lock_mcp_env};
use serde_json::json;

#[tokio::test]
async fn stale_manifest_mcp_registration_cannot_execute_after_disable() {
    let mut config: McpServerConfig = serde_json::from_value(serde_json::json!({
        "command": "does-not-exist-security-sentinel", "enabled": true
    }))
    .unwrap();
    config.owner_plugin_id = Some("security.lifecycle".into());
    let registry = McpRegistry::from_servers(BTreeMap::from([("securityprobe".into(), config)]));
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    registry.set_plugin_runtime(runtime.clone());
    let activation = runtime.begin_activation("security.lifecycle").await;
    activation.commit();
    let lease = runtime.acquire("security.lifecycle").await.unwrap();
    drop(lease);
    drop(runtime.begin_deactivation("security.lifecycle").await);
    for id in ["securityprobe.echo", "securityprobe__echo"] {
        let error = registry
            .call_tool(id, serde_json::json!({}), None)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("owning plugin is inactive"),
            "{error}"
        );
    }
    assert!(registry
        .tools_for_server("securityprobe")
        .await
        .unwrap_err()
        .to_string()
        .contains("owning plugin is inactive"));
    assert!(registry.prewarm_widgets("securityprobe").await.is_err());
    registry.seed_widget_tool_for_test("securityprobe", "echo", "ui://widget/stale");
    assert!(registry
        .widget_resource("securityprobe", "ui://widget/stale")
        .await
        .is_none());
    assert!(runtime.acquire("security.lifecycle").await.is_none());
    let activation = runtime.begin_activation("security.lifecycle").await;
    activation.commit();
    assert!(runtime.acquire("security.lifecycle").await.is_some());
}

#[tokio::test]
async fn plugin_mcp_call_cancellation_and_timeout_release_lifecycle_authority() {
    let _env_lock = lock_mcp_env();
    let gates = std::sync::Arc::new([
        tokio::sync::Semaphore::new(0),
        tokio::sync::Semaphore::new(0),
        tokio::sync::Semaphore::new(0),
    ]);
    let (started, mut starts) = tokio::sync::mpsc::unbounded_channel();
    let app = axum::Router::new().route("/mcp", axum::routing::post({
        let gates = gates.clone();
        move |axum::Json(body): axum::Json<Value>| {
            let gates = gates.clone();
            let started = started.clone();
            async move {
                if body["method"] == "server/discover" {
                    return axum::Json(json!({"jsonrpc":"2.0","id":body["id"],"error":{"code":-32601,"message":"Method not found"}}));
                }
                let result = match body["method"].as_str() {
                    Some("initialize") => json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"lifecycle","version":"1"}}),
                    Some("tools/call") => {
                        started.send(()).unwrap();
                        let round = body["params"]["arguments"]["round"].as_u64().unwrap_or(2) as usize;
                        gates[round].acquire().await.unwrap().forget();
                        json!({"content":[{"type":"text","text":"echo"}]})
                    }
                    _ => json!({}),
                };
                axum::Json(json!({"jsonrpc":"2.0","id":body["id"],"result":result}))
            }
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let _allow_host = allow_discovery_test_host(address);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut config: McpServerConfig = serde_json::from_value(
        json!({"type":"http","url":format!("http://{address}/mcp"),"enabled":true}),
    )
    .unwrap();
    config.owner_plugin_id = Some("security.lifecycle".into());
    let registry = std::sync::Arc::new(McpRegistry::from_servers(BTreeMap::from([(
        "securityprobe".into(),
        config,
    )])));
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    registry.set_plugin_runtime(runtime.clone());
    for timed_out in [false, true] {
        runtime
            .begin_activation("security.lifecycle")
            .await
            .commit();
        let registry_ref = registry.clone();
        // The timed-out round's deadline is armed only once the server holds
        // the call, so a loaded host cannot expire it before delivery.
        let (arm_deadline, deadline_armed) = tokio::sync::oneshot::channel::<()>();
        let mut call = tokio::spawn(async move {
            // The timed-out round's budget must outlast tool discovery, the
            // call's delivery and the lifecycle assertions below (start +
            // 20ms + 100ms); a deadline started up front expired before the
            // server was reached on slower or loaded hosts, releasing the
            // lease early. It is therefore armed only after those assertions.
            let call = registry_ref.call_tool(
                "securityprobe.echo",
                json!({"round":usize::from(timed_out)}),
                None,
            );
            if !timed_out {
                return tokio::time::timeout(std::time::Duration::from_secs(10), call).await;
            }
            tokio::pin!(call);
            tokio::select! {
                result = &mut call => Ok(result),
                _ = deadline_armed => {
                    tokio::time::timeout(std::time::Duration::from_millis(200), call).await
                }
            }
        });
        tokio::select! {
            result = &mut call => panic!("MCP call ended before the server received it: {result:?}"),
            result = tokio::time::timeout(std::time::Duration::from_secs(2), starts.recv()) => { result.unwrap().unwrap(); }
        }
        let runtime_ref = runtime.clone();
        let mut disable =
            tokio::spawn(async move { runtime_ref.begin_deactivation("security.lifecycle").await });
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut disable)
                .await
                .is_err()
        );
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(100),
            registry.tools_for_server("securityprobe")
        )
        .await
        .unwrap()
        .is_err());
        if timed_out {
            arm_deadline.send(()).unwrap();
            assert!(call.await.unwrap().is_err());
        } else {
            call.abort();
            assert!(call.await.unwrap_err().is_cancelled());
        }
        drop(
            tokio::time::timeout(std::time::Duration::from_secs(2), disable)
                .await
                .unwrap()
                .unwrap(),
        );
        assert!(runtime.acquire("security.lifecycle").await.is_none());
        gates[usize::from(timed_out)].add_permits(1);
    }
    runtime
        .begin_activation("security.lifecycle")
        .await
        .commit();
    gates[2].add_permits(1);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        registry.call_tool("securityprobe.echo", json!({"round":2}), None),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result["content"][0]["text"], "echo");
    assert!(runtime.acquire("security.lifecycle").await.is_some());
    server.abort();
}

#[tokio::test]
async fn synthetic_mcp_records_keep_their_lifecycle_boundary_without_wire_ownership() {
    let owner = "security.synthetic";
    let config: McpServerConfig = serde_json::from_value(
        json!({"command":"does-not-exist-security-sentinel","enabled":true}),
    )
    .unwrap();
    let store = std::sync::Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(owner, "1.0.0").await.unwrap();
    store.set_enabled(owner, &[]).await.unwrap();
    let manifests = std::sync::Arc::new(TokioRwLock::new(vec![
        crate::plugin_manifest::PluginManifest {
            id: owner.into(),
            category: Some(MCP_SERVER_CATEGORY.into()),
            ..Default::default()
        },
    ]));
    let registry = McpRegistry::from_servers(BTreeMap::from([
        (owner.into(), config.clone()),
        ("legacy".into(), config.clone()),
    ]))
    .with_self_build(manifests, store.clone());
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    registry.set_plugin_runtime(runtime.clone());
    assert!(registry
        .active_server_config(owner, config.clone())
        .await
        .is_err());
    runtime.begin_activation(owner).await.commit();
    assert!(registry
        .active_server_config(owner, config.clone())
        .await
        .is_ok());
    store.set_disabled(owner).await.unwrap();
    for id in ["security.synthetic.echo", "security.synthetic__echo"] {
        let error = registry.call_tool(id, json!({}), None).await.unwrap_err();
        assert!(
            error.to_string().contains("owning plugin is inactive"),
            "{error}"
        );
    }
    assert!(registry.tools_for_server(owner).await.is_err());
    assert!(registry
        .active_server_config("legacy", config)
        .await
        .is_ok());
}
