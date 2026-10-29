//! Credential broker human routes over the shipping router: proposal
//! approve/reject transitions, session revocation, and the status, catalog,
//! and usage reads.
//!
//! The handlers resolve the process-global vault store (an in-memory store is
//! published; first set wins), so every proposal, service, session, and
//! reference here is named uniquely and effects are read back from the store.
use super::*;
use crate::identity_verify::OrgRole;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};
use crate::vault::broker::services::test_service;
use axum::body::Body;
use tower::ServiceExt;

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

fn vault() -> &'static PluginSecretStore {
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    crate::plugin_secrets::global().unwrap()
}

async fn send(
    caller: Option<VerifiedCaller>,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> (StatusCode, Value) {
    vault();
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let mut request = axum::http::Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = routes()
        .merge(public_routes())
        .layer(axum::Extension(caller))
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

async fn file_proposal(input: proposals::ProposalInput) -> proposals::Proposal {
    let accountable = unique("machine:");
    let conn = vault().conn.lock().await;
    proposals::create(&conn, input, "default", &accountable, &accountable).unwrap()
}

async fn stored_proposal(id: &str) -> proposals::Proposal {
    let conn = vault().conn.lock().await;
    proposals::get(&conn, id).unwrap().expect("proposal exists")
}

async fn mint(minted_by: &str) -> sessions::BrokerSession {
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
    .1
}

fn org_member(user_id: &str) -> Option<VerifiedCaller> {
    Some(VerifiedCaller {
        user_id: user_id.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-vb".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: "org-vb".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-vb".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

#[tokio::test]
async fn rejecting_a_proposal_decides_it_once_with_the_note() {
    with_test_node_binding(false, None, async {
        let proposal = file_proposal(proposals::ProposalInput {
            message: "need a token".into(),
            credentials: vec![proposals::CredentialRequest {
                reference: format!("secret:{}", unique("REJ_")),
                description: String::new(),
                obtain_instructions: String::new(),
            }],
            ..Default::default()
        })
        .await;
        let uri = format!("/api/vault/broker/proposals/{}/reject", proposal.id);

        let (status, body) = send(None, "POST", &uri, Some(json!({ "note": "not today" }))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["rejected"], true);
        let decided = stored_proposal(&proposal.id).await;
        assert_eq!(decided.status, proposals::ProposalStatus::Rejected);
        assert_eq!(decided.note, "not today");
        assert_eq!(decided.decided_by.as_deref(), Some("operator"));

        // A decided proposal is not decided again.
        let (status, body) = send(None, "POST", &uri, None).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(stored_proposal(&proposal.id).await.note, "not today");
        // Nor can it be approved after the rejection.
        let (status, _) = send(
            None,
            "POST",
            &format!("/api/vault/broker/proposals/{}/approve", proposal.id),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            stored_proposal(&proposal.id).await.status,
            proposals::ProposalStatus::Rejected
        );
    })
    .await;
}

#[tokio::test]
async fn approving_a_proposal_creates_its_services_and_lists_it_approved() {
    with_test_node_binding(false, None, async {
        let name = unique("svc-");
        let proposal = file_proposal(proposals::ProposalInput {
            message: "add a service".into(),
            services: vec![test_service(
                &name,
                &format!("{name}.example.com"),
                None,
                "/",
            )],
            ..Default::default()
        })
        .await;
        let uri = format!("/api/vault/broker/proposals/{}/approve", proposal.id);

        let (status, body) = send(None, "POST", &uri, Some(json!({ "note": "ok" }))).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["approved"], true);
        assert_eq!(body["proposal"], proposal.id.as_str());
        let created = {
            let conn = vault().conn.lock().await;
            services::get(&conn, &name).unwrap()
        };
        assert_eq!(
            created.expect("service created").input.host,
            format!("{name}.example.com")
        );
        let decided = stored_proposal(&proposal.id).await;
        assert_eq!(decided.status, proposals::ProposalStatus::Approved);

        // The approved proposal is listed under its status, not as pending.
        let (status, listed) = send(
            None,
            "GET",
            "/api/vault/broker/proposals?status=approved",
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(listed["proposals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == proposal.id.as_str()));
        let (_, pending) = send(
            None,
            "GET",
            "/api/vault/broker/proposals?status=pending",
            None,
        )
        .await;
        assert!(!pending["proposals"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == proposal.id.as_str()));

        // Approving twice is refused; approving an unknown id is a 404.
        let (status, _) = send(None, "POST", &uri, None).await;
        assert_eq!(status, StatusCode::CONFLICT);
        let (status, _) = send(
            None,
            "POST",
            &format!("/api/vault/broker/proposals/{}/approve", unique("bvp_")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    })
    .await;
}

#[tokio::test]
async fn deleting_a_session_revokes_it_once() {
    with_test_node_binding(false, None, async {
        let session = mint(&unique("user:")).await;
        let uri = format!("/api/vault/broker/sessions/{}", session.id);

        let (status, body) = send(None, "DELETE", &uri, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["revoked"], true);
        let revoked = {
            let conn = vault().conn.lock().await;
            sessions::get(&conn, &session.id).unwrap().unwrap()
        };
        assert!(revoked.revoked_at.is_some());
        // Revoked sessions leave the live list.
        let (status, listed) = send(None, "GET", "/api/vault/broker/sessions", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!listed["sessions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["id"] == session.id.as_str()));

        let (status, body) = send(None, "DELETE", &uri, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["revoked"], false);
        let (status, _) = send(
            None,
            "DELETE",
            &format!("/api/vault/broker/sessions/{}", unique("bvs_")),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    })
    .await;
}

#[tokio::test]
async fn status_catalog_and_usage_reads_report_the_broker_state() {
    with_test_node_binding(false, None, async {
        let (status, body) = send(None, "GET", "/api/vault/broker/status", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["broker"]["caUrl"], CA_PATH);
        assert_eq!(body["broker"]["portEnv"], broker::ENV_PORT);
        assert_eq!(
            body["broker"]["listening"],
            broker::listening_port().is_some()
        );

        let (status, body) = send(None, "GET", "/api/vault/broker/catalog", None).await;
        assert_eq!(status, StatusCode::OK);
        let templates = body["templates"].as_array().unwrap();
        assert!(!templates.is_empty());
        assert_eq!(templates.len(), catalog::templates().len());

        // Usage names exactly the services whose auth references the secret.
        let reference = format!("secret:{}", unique("USE_"));
        let user = unique("svc-");
        let other = unique("svc-");
        {
            let conn = vault().conn.lock().await;
            let mut uses = test_service(&user, &format!("{user}.example.com"), None, "/");
            uses.auth = services::ServiceAuth::Bearer {
                token: reference.clone(),
            };
            services::insert(&conn, uses.normalize().unwrap()).unwrap();
            services::insert(
                &conn,
                test_service(&other, &format!("{other}.example.com"), None, "/")
                    .normalize()
                    .unwrap(),
            )
            .unwrap();
        }
        let (status, body) = send(
            None,
            "GET",
            &format!("/api/vault/broker/usage?ref={reference}"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["ref"], reference.as_str());
        assert_eq!(body["services"], json!([user]));
    })
    .await;
}

#[tokio::test]
async fn a_member_without_broker_grants_cannot_decide_revoke_or_read_status() {
    let proposal = file_proposal(proposals::ProposalInput {
        message: "need a token".into(),
        credentials: vec![proposals::CredentialRequest {
            reference: format!("secret:{}", unique("MEM_")),
            description: String::new(),
            obtain_instructions: String::new(),
        }],
        ..Default::default()
    })
    .await;
    let session = mint(&unique("user:")).await;
    with_test_node_binding(false, Some(org_node()), async {
        let member = org_member(&unique("member-"));
        for (method, uri) in [
            (
                "POST",
                format!("/api/vault/broker/proposals/{}/approve", proposal.id),
            ),
            (
                "POST",
                format!("/api/vault/broker/proposals/{}/reject", proposal.id),
            ),
            (
                "DELETE",
                format!("/api/vault/broker/sessions/{}", session.id),
            ),
            ("GET", "/api/vault/broker/sessions".to_owned()),
            ("GET", "/api/vault/broker/status".to_owned()),
            ("GET", "/api/vault/broker/proposals".to_owned()),
        ] {
            let (status, body) = send(member.clone(), method, &uri, None).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        }
    })
    .await;
    assert_eq!(
        stored_proposal(&proposal.id).await.status,
        proposals::ProposalStatus::Pending
    );
    let conn = vault().conn.lock().await;
    assert!(sessions::get(&conn, &session.id)
        .unwrap()
        .unwrap()
        .revoked_at
        .is_none());
}
