//! An app that refreshes stored sources on a timer (dashboard widgets) may
//! only make provider calls that read (security finding CE-7). The admission
//! test calls every step `providers.call` takes before Gateway, with a real
//! sidecar credential; no test here sends a request anywhere.

use super::read_only::{not_a_read, refreshes_stored_sources, refusal, REASON};
use super::*;
use crate::plugin_manifest::{PluginManifest, PluginManifestLoader};

const WIDGET_APP: &str = "@example/widgets-read-only";
const OTHER_APP: &str = "@example/poster-read-only";

fn manifest(id: &str, provides: serde_json::Value) -> PluginManifest {
    serde_json::from_value(json!({
        "id": id, "name": "Example", "version": "1.0.0", "runnables": [],
        "sidecars": [{
            "name": "backend",
            "process": { "kind": "binary", "url": "https://example.com/b", "version": "1.0.0" },
            "port": 19998,
            "health_path": "/health",
            "http": { "routes": [{ "path": "/widgets/upsert", "method": "POST" }] }
        }],
        "provides": provides
    }))
    .expect("manifest parses")
}

fn widget_app_manifest() -> PluginManifest {
    manifest(
        WIDGET_APP,
        json!([{
            "capability": crate::dashboard_capabilities::CAP_UPSERT_WIDGET,
            "version": "1.0.0",
            "sidecar": "backend",
            "route": "/widgets/upsert"
        }]),
    )
}

fn call(provider: &str, tool_id: &str, operation: Option<&str>) -> ManagedProviderCall {
    serde_json::from_value(json!({
        "provider": provider,
        "toolId": tool_id,
        "operation": operation,
        "method": "POST",
        "body": { "recipient_email": "someone@example.com" },
        "requestId": "req-read-only",
        "taskLabel": "Dashboards Composio widget"
    }))
    .expect("call")
}

async fn response_json(response: Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&bytes).expect("json body"))
}

#[test]
fn only_an_app_that_provides_widget_authoring_is_held_to_reads() {
    assert!(refreshes_stored_sources(&widget_app_manifest()));
    assert!(!refreshes_stored_sources(&manifest(OTHER_APP, json!([]))));
    assert!(!refreshes_stored_sources(&manifest(
        OTHER_APP,
        json!([{ "capability": "dashboards.get", "version": "1.0.0" }])
    )));
    // The app Core ships as the dashboards provider is held.
    let shipped: Vec<String> = PluginManifestLoader::load_builtins()
        .into_iter()
        .filter(refreshes_stored_sources)
        .map(|manifest| manifest.id)
        .collect();
    assert_eq!(shipped, [crate::plugins::builtins::DASHBOARDS_PLUGIN_ID]);
}

#[test]
fn a_write_delete_or_unknown_action_is_not_a_read() {
    for action in [
        "GMAIL_SEND_EMAIL",
        "SLACK_SEND_MESSAGE",
        "GITHUB_CREATE_ISSUE",
        "GITHUB_DELETE_A_REPOSITORY",
        "GITHUB_STAR_A_REPOSITORY",
    ] {
        let reason = not_a_read(&call("composio", action, Some("execute")))
            .unwrap_or_else(|| panic!("{action} must be refused"));
        assert!(reason.contains(action), "{reason}");
        // A call that names no operation is classified the same way.
        assert!(
            not_a_read(&call("composio", action, None)).is_some(),
            "{action}"
        );
        // Letting Gateway pick the provider does not change the answer.
        assert!(
            not_a_read(&call("builtin", action, Some("execute"))).is_some(),
            "{action}"
        );
    }
}

#[test]
fn a_read_action_and_a_capabilities_lookup_go_on() {
    for action in ["GMAIL_FETCH_EMAILS", "GITHUB_LIST_REPOSITORY_ISSUES"] {
        assert_eq!(not_a_read(&call("composio", action, Some("execute"))), None);
    }
    // The toolkit's public tool list, whatever the toolkit is called.
    assert_eq!(
        not_a_read(&call("composio", "gmail", Some("capabilities"))),
        None
    );
}

#[test]
fn account_and_upload_operations_are_not_reads() {
    for operation in ["connect", "disconnect", "file_upload", "anything_else"] {
        let reason = not_a_read(&call("composio", "gmail", Some(operation)))
            .unwrap_or_else(|| panic!("{operation} must be refused"));
        assert!(reason.contains(operation), "{reason}");
    }
    // `capabilities` is a Composio lookup only.
    assert!(not_a_read(&call("treg", "x.post.create", Some("capabilities"))).is_some());
    // Gateway reads the operation exactly as sent, so a padded or respelled
    // name is not taken for the lookup or for a classified `execute`.
    for operation in [" capabilities", "Capabilities", "execute ", "EXECUTE"] {
        assert!(
            not_a_read(&call("composio", "GMAIL_FETCH_EMAILS", Some(operation))).is_some(),
            "{operation:?}"
        );
    }
    assert!(not_a_read(&call(" composio", "gmail", Some("capabilities"))).is_some());
}

fn sidecar_headers(app: &str) -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        crate::sidecar::ext_proxy::HDR_PLUGIN_ID,
        app.parse().unwrap(),
    );
    let token = crate::sidecar::plugin_credentials::token_for(app);
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    headers
}

/// The admitted app id, or the status and body of the refusal.
async fn admitted(
    state: &ServerState,
    headers: &axum::http::HeaderMap,
    call: &ManagedProviderCall,
) -> Result<String, (StatusCode, serde_json::Value)> {
    match admit_provider_call(state, headers, &mut call.clone()).await {
        Ok(app) => Ok(app),
        Err(refused) => Err(response_json(refused).await),
    }
}

/// `admit_provider_call` is every step `providers.call` takes before it asks
/// Gateway, called here as the app's sidecar calls it (its own id and minted
/// credential). No step in it makes a network request.
#[tokio::test]
async fn providers_call_refuses_a_widget_write_before_gateway_is_asked() {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    for (app, manifest) in [
        (WIDGET_APP, widget_app_manifest()),
        (OTHER_APP, manifest(OTHER_APP, json!([]))),
    ] {
        state.app_store.insert(app, "1.0.0").await.unwrap();
        state.app_store.set_enabled(app, &[]).await.unwrap();
        state.app_manifests.write().await.push(manifest);
    }
    let widget_app = sidecar_headers(WIDGET_APP);
    let write = call("composio", "GMAIL_SEND_EMAIL", Some("execute"));
    let read = call("composio", "GMAIL_FETCH_EMAILS", Some("execute"));

    // The stored widget's write is refused, with a reason the app can tell apart.
    let (status, body) = admitted(&state, &widget_app, &write)
        .await
        .expect_err("a widget app's write must not be admitted");
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["reason"], REASON, "{body}");
    assert!(
        body["error"].as_str().unwrap().contains("GMAIL_SEND_EMAIL"),
        "{body}"
    );
    assert!(refusal(&state, WIDGET_APP, &write).await.is_some());

    // Its read is admitted, and so is its toolkit lookup.
    assert_eq!(
        admitted(&state, &widget_app, &read).await,
        Ok(WIDGET_APP.to_owned())
    );
    let lookup = call("composio", "gmail", Some("capabilities"));
    assert_eq!(
        admitted(&state, &widget_app, &lookup).await,
        Ok(WIDGET_APP.to_owned())
    );

    // An app that provides no widget authoring keeps its writes (a scheduled post).
    assert_eq!(
        admitted(&state, &sidecar_headers(OTHER_APP), &write).await,
        Ok(OTHER_APP.to_owned())
    );

    // A wrong credential is still an authentication failure, not this refusal.
    let mut forged = widget_app.clone();
    forged.insert("authorization", "Bearer not-the-token".parse().unwrap());
    let (status, _) = admitted(&state, &forged, &write)
        .await
        .expect_err("a forged credential is refused");
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
