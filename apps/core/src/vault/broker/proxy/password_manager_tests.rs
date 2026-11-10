//! Password-manager references behind the broker approval flow.

use super::*;

#[tokio::test]
async fn password_manager_credentials_wait_for_approval_then_inject() {
    use crate::vault::password_managers::tests::{
        add_cli_account, invocations, BWS_TOKEN, SECRET_ID,
    };
    use crate::vault::password_managers::GrantMode;
    let dir = tempfile::tempdir().unwrap();
    let store = leak_store();
    add_cli_account(store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut service = test_service("bw", "127.0.0.1", Some(upstream), "/v1");
    service.allow_insecure_http = true;
    service.auth = ServiceAuth::Bearer {
        token: format!("bws://{SECRET_ID}"),
    };
    add_service(store, service).await;
    let (token, session) = mint(store, &["bw"]).await;
    let port = start(store, loopback_config()).await;
    let request = || {
        get_via_proxy(
            &format!("http://127.0.0.1:{upstream}/v1/items"),
            Some(token.as_str()),
            "",
        )
    };

    // First use: refused with the approval id; the provider is not called
    // and nothing reaches the upstream.
    let refused = send_raw(port, request()).await;
    assert!(refused.starts_with("HTTP/1.1 403"), "{refused}");
    assert!(
        refused.contains("credential_approval_required"),
        "{refused}"
    );
    assert_eq!(invocations(dir.path()), 0);
    assert!(seen.try_recv().is_err());
    let approvals = store
        .pm_approvals(Some(
            crate::vault::broker::proposals::ProposalStatus::Pending,
        ))
        .await
        .unwrap();
    assert_eq!(approvals.len(), 1);
    assert!(refused.contains(&approvals[0].id));
    // The session's minting principal is the grant subject; the session filed it.
    assert_eq!(
        approvals[0].credential_use.as_ref().unwrap().subject,
        "broker:operator"
    );
    assert_eq!(
        approvals[0].requested_by,
        format!("broker_session:{}", session.id)
    );

    store
        .pm_approve(
            &approvals[0].id,
            GrantMode::Hour,
            "",
            "operator",
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let response = send_raw(port, request()).await;
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let forwarded = seen.recv().await.unwrap().to_ascii_lowercase();
    assert!(
        forwarded.contains("authorization: bearer bw-secret-value"),
        "{forwarded}"
    );
    assert_eq!(invocations(dir.path()), 1);
    let serialized = serde_json::to_string(&log_rows(store).await).unwrap();
    assert!(!serialized.contains("bw-secret-value"));
}

#[tokio::test]
async fn human_sessions_honor_the_minters_role_and_team_denies() {
    use crate::vault::password_managers::tests::{
        add_cli_account, invocations, BWS_TOKEN, SECRET_ID,
    };
    use crate::vault::policy::{bind, put_policy, Capability, Policy, PolicyRule};
    let dir = tempfile::tempdir().unwrap();
    let store = leak_store();
    put_secret(store, "API_TOKEN", TOKEN_VALUE).await;
    put_secret(store, "OTHER", "other-value").await;
    add_cli_account(store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    {
        let conn = store.conn.lock().await;
        let deny = |name: &str, path: &str| Policy {
            name: name.into(),
            description: String::new(),
            rules: vec![PolicyRule {
                path: path.into(),
                capabilities: vec![Capability::Use, Capability::Read],
                deny: true,
                ..Default::default()
            }],
        };
        put_policy(&conn, &deny("contractor", "default/API_TOKEN")).unwrap();
        put_policy(&conn, &deny("vendors", "default/OTHER")).unwrap();
        put_policy(
            &conn,
            &deny(
                "no-pm",
                &crate::vault::password_managers::account_key("team"),
            ),
        )
        .unwrap();
        bind(&conn, "contractor", "role:contractor", None, None).unwrap();
        bind(&conn, "vendors", "team:t1", None, None).unwrap();
        bind(&conn, "no-pm", "role:contractor", None, None).unwrap();
    }
    let (upstream, mut seen) = fake_http_upstream().await;
    let mut role_denied = test_service("role", "127.0.0.1", Some(upstream), "/role");
    role_denied.allow_insecure_http = true;
    add_service(store, role_denied).await;
    let mut team_denied = test_service("team", "127.0.0.1", Some(upstream), "/team");
    team_denied.allow_insecure_http = true;
    team_denied.auth = ServiceAuth::Bearer {
        token: "secret:OTHER".into(),
    };
    add_service(store, team_denied).await;
    let mut pm = test_service("pm", "127.0.0.1", Some(upstream), "/pm");
    pm.allow_insecure_http = true;
    pm.auth = ServiceAuth::Bearer {
        token: format!("bws://{SECRET_ID}"),
    };
    add_service(store, pm).await;
    let services = ["role", "team", "pm"];
    let contractor = MinterScope {
        subjects: vec!["user:u1".into(), "role:contractor".into(), "team:t1".into()],
        manager: false,
    };
    let (token, _) = mint_as(store, &services, "user:u1", contractor).await;
    let member = MinterScope {
        subjects: vec!["user:u2".into(), "role:member".into()],
        manager: false,
    };
    let (member_token, _) = mint_as(store, &services, "user:u2", member).await;
    let port = start(store, loopback_config()).await;
    let url = |path: &str| format!("http://127.0.0.1:{upstream}{path}");

    for path in ["/role", "/team", "/pm"] {
        let response = send_raw(port, get_via_proxy(&url(path), Some(token.as_str()), "")).await;
        assert!(response.starts_with("HTTP/1.1 403"), "{path}: {response}");
        assert!(response.contains("credential_denied"), "{path}: {response}");
    }
    assert!(
        seen.try_recv().is_err(),
        "a denied credential reached upstream"
    );
    assert_eq!(invocations(dir.path()), 0);

    // A minter without those roles or teams still resolves both secrets.
    for path in ["/role", "/team"] {
        let response = send_raw(
            port,
            get_via_proxy(&url(path), Some(member_token.as_str()), ""),
        )
        .await;
        assert!(response.starts_with("HTTP/1.1 200"), "{path}: {response}");
        seen.recv().await.unwrap();
    }
}
