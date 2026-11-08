//! `GET /api/vault/sys/status` and `POST /api/vault/sys/{action}` over HTTP,
//! through the shipping handlers: rotation (with rewrap), seal and unseal in
//! both modes, the switch to Shamir and back, unknown actions, and refusal of
//! a non-admin caller. These actions change the process-global vault, so the
//! case runs alone in a child process with its own data folder.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::routing::{get, post};
use axum::{Extension, Router};
use serde_json::{json, Value};
use tower::ServiceExt;

use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::plugin_secrets::PluginSecretStore;
use crate::server::vault_api::{sys_action, sys_status};
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

const CHILD_ENV: &str = "RYU_CORE_VAULT_SYS_HTTP_CHILD";
const TEST: &str = "sys_actions_rotate_seal_and_switch_modes_over_http";

/// Whether this is the child that runs the case. Otherwise run the child,
/// require exactly one passing test, and return `false`.
fn in_isolated_process() -> bool {
    if std::env::var_os(CHILD_ENV).is_some() {
        return true;
    }
    let data_dir = tempfile::tempdir().unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("vault::keyring::sys_http_test::{TEST}"),
            "--nocapture",
        ])
        .env(CHILD_ENV, "1")
        .env("RYU_PROFILE", "dev")
        .env("RYU_KEYCHAIN", "off")
        .env("RYU_DIR", data_dir.path())
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed; 0 failed"),
        "isolated sys/:action test failed:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    false
}

fn store() -> &'static PluginSecretStore {
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    crate::plugin_secrets::global().unwrap()
}

async fn send(
    caller: Option<VerifiedCaller>,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let mut request = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = Router::new()
        .route("/api/vault/sys/status", get(sys_status))
        .route("/api/vault/sys/:action", post(sys_action))
        .layer(Extension(caller))
        .with_state(state)
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn post_ok(uri: &str, body: Option<Value>) -> Value {
    let (status, value) = send(None, "POST", uri, body).await;
    assert_eq!(status, StatusCode::OK, "{uri}: {value}");
    value
}

async fn secret(store: &PluginSecretStore) -> Option<String> {
    store.get("plug", "token").await.unwrap()
}

async fn audit_rows(store: &PluginSecretStore) -> Vec<(String, String, String)> {
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare("SELECT action, outcome, COALESCE(details, '') FROM vault_audit ORDER BY seq")
        .unwrap();
    let rows = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .unwrap();
    rows.collect::<rusqlite::Result<_>>().unwrap()
}

async fn member_is_refused(store: &PluginSecretStore) {
    let node = RegisteredNode {
        org: RegisteredOrg {
            id: "org-sys".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-sys".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    };
    let member = Some(VerifiedCaller {
        user_id: "member".to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-sys".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    });
    with_test_node_binding(false, Some(node), async {
        for action in ["rotate", "seal", "init-shamir", "migrate-auto"] {
            let uri = format!("/api/vault/sys/{action}");
            let (status, body) = send(member.clone(), "POST", &uri, None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{uri}: {body}");
        }
    })
    .await;
    assert_eq!(store.keyring.active_version(), 1);
    assert!(!store.keyring.is_sealed());
}

#[tokio::test]
async fn sys_actions_rotate_seal_and_switch_modes_over_http() {
    if !in_isolated_process() {
        return;
    }
    let store = store();
    store.set("plug", "token", "s3cret").await.unwrap();
    member_is_refused(store).await;
    let shares = with_test_node_binding(false, None, async {
        let (status, body) = send(None, "GET", "/api/vault/sys/status", None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["seal"]["mode"], "auto");
        assert_eq!(body["seal"]["activeKeyVersion"], 1);

        let (status, _) = send(None, "POST", "/api/vault/sys/explode", None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);

        let rotated = post_ok("/api/vault/sys/rotate", None).await;
        assert_eq!(rotated["keyVersion"], 2);
        assert_eq!(rotated["rewrapped"], 1);
        assert_eq!(rotated["seal"]["activeKeyVersion"], 2);
        assert_eq!(secret(store).await.as_deref(), Some("s3cret"));

        let sealed = post_ok("/api/vault/sys/seal", None).await;
        assert_eq!(sealed["seal"]["sealed"], true);
        assert_eq!(secret(store).await, None, "a sealed vault resolves nothing");
        let (status, _) = send(None, "POST", "/api/vault/sys/rotate", None).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        let unsealed = post_ok("/api/vault/sys/unseal", None).await;
        assert_eq!(unsealed["seal"]["sealed"], false);
        assert_eq!(secret(store).await.as_deref(), Some("s3cret"));

        let init = post_ok(
            "/api/vault/sys/init-shamir",
            Some(json!({ "shares": 3, "threshold": 2 })),
        )
        .await;
        let shares: Vec<String> = serde_json::from_value(init["shares"].clone()).unwrap();
        assert_eq!(shares.len(), 3);
        assert_eq!(init["seal"]["mode"], "shamir");

        post_ok("/api/vault/sys/seal", None).await;
        let (status, _) = send(None, "POST", "/api/vault/sys/unseal", None).await;
        assert!(!status.is_success(), "a shamir vault needs shares");
        let first = post_ok("/api/vault/sys/unseal", Some(json!({ "share": shares[0] }))).await;
        assert_eq!(first["seal"]["progress"], 1);
        assert_eq!(first["seal"]["sealed"], true);
        let (status, _) = send(
            None,
            "POST",
            "/api/vault/sys/unseal",
            Some(json!({ "share": shares[0] })),
        )
        .await;
        assert!(!status.is_success(), "the same share twice is refused");
        let second = post_ok("/api/vault/sys/unseal", Some(json!({ "share": shares[2] }))).await;
        assert_eq!(second["seal"]["sealed"], false);
        assert_eq!(secret(store).await.as_deref(), Some("s3cret"));

        let back = post_ok("/api/vault/sys/migrate-auto", None).await;
        assert_eq!(back["seal"]["mode"], "auto");
        assert_eq!(secret(store).await.as_deref(), Some("s3cret"));
        shares
    })
    .await;

    let rows = audit_rows(store).await;
    for action in [
        "sys.rotate",
        "sys.seal",
        "sys.unseal",
        "sys.init-shamir",
        "sys.migrate-auto",
    ] {
        assert!(
            rows.iter()
                .any(|(a, outcome, _)| a == action && outcome == "ok"),
            "{action} is audited: {rows:?}"
        );
    }
    assert!(
        rows.iter()
            .any(|(a, outcome, _)| a == "sys.rotate" && outcome == "error"),
        "the refused rotation while sealed is audited"
    );
    for share in &shares {
        assert!(
            !rows
                .iter()
                .any(|(_, _, details)| details.contains(share.as_str())),
            "a key share reached the audit log"
        );
    }
}
