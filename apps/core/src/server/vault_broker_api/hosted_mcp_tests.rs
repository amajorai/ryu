//! Hosted MCP broker tools: credential headers and calls through the agent routes.

use super::*;

fn vault() -> &'static PluginSecretStore {
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    crate::plugin_secrets::global().unwrap()
}

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

async fn mint(minted_by: &str) -> String {
    let conn = vault().conn.lock().await;
    sessions::mint(
        &conn,
        sessions::MintRequest {
            environment: "default".into(),
            services: vec![unique("svc-")],
            label: String::new(),
            ttl_secs: None,
            minted_by: minted_by.into(),
            not_after: None,
            minted_token: None,
            minter_scope: None,
        },
    )
    .unwrap()
    .0
}

/// A hosted call from a caller with no known address.
async fn run(name: &str, arguments: Value, credentials: HeaderMap) -> Result<Value, String> {
    call(name, arguments, credentials, HostedClient::default()).await
}

fn from_peer(peer: &str) -> HostedClient {
    HostedClient {
        peer: Some(format!("{peer}:4100").parse().unwrap()),
        forwarded_for: None,
    }
}

fn session_headers(token: &str) -> HeaderMap {
    let mut incoming = HeaderMap::new();
    incoming.insert(BROKER_SESSION_HEADER, HeaderValue::from_str(token).unwrap());
    agent_headers(&incoming).expect("an rvb_ session is a broker credential")
}

#[test]
fn only_a_broker_credential_reaches_the_agent_routes() {
    // The node bearer that admitted the MCP request is never forwarded.
    let mut incoming = HeaderMap::new();
    incoming.insert(
        header::AUTHORIZATION,
        HeaderValue::from_static("Bearer node-token"),
    );
    assert!(agent_headers(&incoming).is_none());

    incoming.insert(BROKER_SESSION_HEADER, HeaderValue::from_static("rvb_abc"));
    let headers = agent_headers(&incoming).unwrap();
    assert_eq!(headers.len(), 1);
    assert_eq!(headers[header::AUTHORIZATION], "Bearer rvb_abc");

    // A bearer-prefixed session is accepted; anything that is not rvb_ is not.
    let mut prefixed = HeaderMap::new();
    prefixed.insert(
        BROKER_SESSION_HEADER,
        HeaderValue::from_static("Bearer rvb_xyz"),
    );
    assert_eq!(
        agent_headers(&prefixed).unwrap()[header::AUTHORIZATION],
        "Bearer rvb_xyz"
    );
    let mut foreign = HeaderMap::new();
    foreign.insert(
        BROKER_SESSION_HEADER,
        HeaderValue::from_static("node-token"),
    );
    assert!(agent_headers(&foreign).is_none());

    // A machine token wins and is passed alone.
    incoming.insert(VAULT_TOKEN_HEADER, HeaderValue::from_static("rvt_machine"));
    let headers = agent_headers(&incoming).unwrap();
    assert_eq!(headers.len(), 1);
    assert_eq!(headers[VAULT_TOKEN_HEADER], "rvt_machine");
}

#[test]
fn tools_match_the_stdio_names_and_never_take_values() {
    let names: Vec<_> = tools().iter().map(|tool| tool.name).collect();
    assert_eq!(names, [DISCOVER, PROPOSE, PROPOSAL]);
    assert!(names.iter().all(|name| is_tool(name)));
    assert!(!is_tool("vault.reveal"));
    let propose = &tools()[1];
    assert!(!propose.read_only);
    let credential = &propose.input_schema["properties"]["credentials"]["items"];
    assert_eq!(
        credential["properties"]["ref"]["pattern"],
        "^(secret:|op://|bws://)"
    );
    assert!(credential["properties"].get("value").is_none());
    assert_eq!(tools()[0].listing()["annotations"]["readOnlyHint"], true);
}

#[tokio::test]
async fn a_session_discovers_proposes_and_polls_its_own_proposal() {
    let token = mint(&unique("user:")).await;
    let discovered = run(DISCOVER, json!({}), session_headers(&token))
        .await
        .unwrap();
    assert_eq!(discovered["environment"], "default");
    assert!(discovered["services"].is_array());

    let reference = format!("secret:{}", unique("HOSTED_"));
    let filed = run(
        PROPOSE,
        json!({
            "message": "need the Linear token",
            "credentials": [{ "ref": reference }],
        }),
        session_headers(&token),
    )
    .await
    .unwrap();
    let id = filed["proposal"]["id"].as_str().unwrap().to_owned();
    assert_eq!(filed["proposal"]["status"], "pending");

    let polled = run(PROPOSAL, json!({ "id": id }), session_headers(&token))
        .await
        .unwrap();
    assert_eq!(polled["proposal"]["id"], id.as_str());

    // Another principal's session cannot see it.
    let other = mint(&unique("user:")).await;
    let refused = run(PROPOSAL, json!({ "id": id }), session_headers(&other))
        .await
        .unwrap_err();
    assert!(refused.contains("HTTP 404"), "{refused}");
}

#[tokio::test]
async fn unknown_sessions_and_bad_arguments_are_refused_without_values() {
    vault();
    let fake = "rvb_not-a-real-session";
    let refused = run(DISCOVER, json!({}), session_headers(fake))
        .await
        .unwrap_err();
    assert!(refused.contains("HTTP 401"), "{refused}");
    assert!(!refused.contains(fake), "{refused}");

    let token = mint(&unique("user:")).await;
    let missing = run(PROPOSAL, json!({}), session_headers(&token))
        .await
        .unwrap_err();
    assert!(missing.contains("'id'"), "{missing}");
    let not_object = run(PROPOSE, json!("text"), session_headers(&token))
        .await
        .unwrap_err();
    assert!(not_object.contains("object"), "{not_object}");
    let empty = run(PROPOSE, json!({ "message": "" }), session_headers(&token))
        .await
        .unwrap_err();
    assert!(empty.contains("HTTP 400"), "{empty}");
}

#[tokio::test]
async fn a_rate_quota_on_the_agent_route_limits_the_hosted_tool() {
    let token = mint(&unique("user:")).await;
    let filed = run(
        PROPOSE,
        json!({ "message": "need a token", "credentials": [{ "ref": "secret:HOSTED_QUOTA" }] }),
        session_headers(&token),
    )
    .await
    .unwrap();
    let id = filed["proposal"]["id"].as_str().unwrap().to_owned();
    // An operator quota on exactly this agent route (unique to this test).
    vault()
        .quota_put(
            &unique("hosted-poll-"),
            crate::vault::quotas::QuotaRule::RateLimit {
                path: format!("/api/vault/agent/broker/proposals/{id}"),
                rate: 1,
                interval_secs: 60,
                block_interval_secs: None,
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let poll = || {
        call(
            PROPOSAL,
            json!({ "id": id }),
            session_headers(&token),
            from_peer("192.0.2.150"),
        )
    };
    assert_eq!(poll().await.unwrap()["proposal"]["id"], id.as_str());
    let limited = poll().await.unwrap_err();
    assert!(limited.contains("HTTP 429"), "{limited}");
    assert!(limited.contains("vault_quota_exceeded"), "{limited}");
    assert!(!limited.contains(&token), "{limited}");
}

#[tokio::test]
async fn a_cidr_bound_credential_is_judged_by_the_mcp_callers_address() {
    let store = vault();
    let issued = crate::vault::broker::test_machine_token(store, &unique("ci-"), Vec::new()).await;
    let session = {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE vault_tokens SET bound_cidrs = ?1 WHERE accessor = ?2",
            rusqlite::params![r#"["10.0.0.0/8"]"#, issued.accessor],
        )
        .unwrap();
        sessions::mint(
            &conn,
            sessions::MintRequest {
                environment: "default".into(),
                services: vec![unique("svc-")],
                label: String::new(),
                ttl_secs: None,
                minted_by: format!("machine:{}", issued.identity_id),
                not_after: Some(issued.expires_at),
                minted_token: Some(issued.accessor.clone()),
                minter_scope: None,
            },
        )
        .unwrap()
        .0
    };
    let mut machine = HeaderMap::new();
    machine.insert(
        VAULT_TOKEN_HEADER,
        HeaderValue::from_str(&issued.token).unwrap(),
    );
    let machine = agent_headers(&machine).unwrap();
    for credentials in [session_headers(&session), machine] {
        let inside = call(
            DISCOVER,
            json!({}),
            credentials.clone(),
            from_peer("10.1.2.3"),
        )
        .await;
        assert!(inside.is_ok(), "{inside:?}");
        let outside = call(
            DISCOVER,
            json!({}),
            credentials.clone(),
            from_peer("198.51.100.7"),
        )
        .await
        .unwrap_err();
        assert!(
            outside.contains("HTTP 401") || outside.contains("HTTP 403"),
            "{outside}"
        );
        let unknown = run(DISCOVER, json!({}), credentials).await.unwrap_err();
        assert!(
            unknown.contains("HTTP 401") || unknown.contains("HTTP 403"),
            "{unknown}"
        );
    }
}
