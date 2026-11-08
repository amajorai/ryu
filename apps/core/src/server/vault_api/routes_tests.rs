//! Vault route tests: transfers, timestamps, vouching, and bearer handling.

use super::principal::node_key_may_vouch;
use super::scan_route::scan_known_values;
use super::tests::*;
use super::transfer::{import_with, is_step_up_required, overlay_local_values};
use super::value_actions::{secret_action_with, VersionActionBody};
use super::wire::{millis_fields, rfc3339_fields, user_jwt};
use super::*;

async fn body_json(response: Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn constrained_writer() -> Policy {
    Policy {
        name: "constrained".into(),
        description: String::new(),
        rules: vec![PolicyRule {
            path: "**".into(),
            capabilities: vec![Capability::Read, Capability::Write],
            deny: false,
            denied_parameters: Some(BTreeMap::from([(
                "value".to_owned(),
                vec!["bad*".to_owned()],
            )])),
            ..Default::default()
        }],
    }
}

#[tokio::test]
async fn import_and_rollback_cannot_bypass_write_parameter_constraints() {
    let ctx = ctx(
        None,
        Some(caller("alice", OrgRole::Member, &[])),
        true,
        vec![constrained_writer()],
    );
    // v1 predates the constraint; v2 is the current, compliant value.
    for value in ["bad-old", "good"] {
        ctx.store
            .set_vault_secret(SecretScope::User, "alice", None, "API_KEY", value)
            .await
            .unwrap();
    }
    let coords = SecretCoords::root(SecretScope::User, "alice", None, "API_KEY");
    assert!(ctx
        .require_write_parameters(&coords, Some("bad-new"))
        .is_err());
    assert!(ctx.require_write_parameters(&coords, Some("fine")).is_ok());

    let import = |content: &str| -> ImportBody {
        serde_json::from_value(json!({
            "scope": "user", "scopeId": "alice", "format": "dotenv",
            "content": content, "onConflict": "overwrite",
        }))
        .unwrap()
    };
    let response = import_with(&ctx, import("API_KEY=bad-new\n")).await;
    assert_eq!(response.status(), StatusCode::OK);
    let report = body_json(response).await;
    assert_eq!(report["report"]["skipped"], 1);
    let actor = ctx.actor();
    assert_eq!(
        ctx.store.reveal(&coords, None, &actor).await.unwrap(),
        "good"
    );
    let response = import_with(&ctx, import("API_KEY=fine\n")).await;
    assert_eq!(body_json(response).await["report"]["updated"], 1);

    let action = |version: i64| -> VersionActionBody {
        serde_json::from_value(json!({
            "scope": "user", "scopeId": "alice", "version": version,
        }))
        .unwrap()
    };
    let response = secret_action_with(&ctx, "API_KEY", "rollback", action(1)).await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = secret_action_with(&ctx, "API_KEY", "rollback", action(2)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        ctx.store.reveal(&coords, None, &actor).await.unwrap(),
        "good"
    );
}

#[test]
fn timestamps_render_as_rfc3339_both_ways() {
    let out =
        rfc3339_fields(json!({ "createdAt": 0, "nested": [{ "expiresAt": 1000 }], "version": 3 }));
    assert_eq!(out["createdAt"], "1970-01-01T00:00:00+00:00");
    assert_eq!(out["nested"][0]["expiresAt"], "1970-01-01T00:00:01+00:00");
    assert_eq!(out["version"], 3);
    let engines = rfc3339_fields(json!({
        "approvals": [{ "at": 0 }], "notAfter": 1000, "validBefore": 1,
    }));
    assert_eq!(engines["approvals"][0]["at"], "1970-01-01T00:00:00+00:00");
    assert_eq!(engines["notAfter"], "1970-01-01T00:00:01+00:00");
    assert_eq!(engines["validBefore"], "1970-01-01T00:00:01+00:00");
    let back = millis_fields(json!({ "expiresAt": "1970-01-01T00:00:01Z" })).unwrap();
    assert_eq!(back["expiresAt"], 1000);
    assert!(millis_fields(json!({ "expiresAt": "tomorrow" })).is_err());
}

#[test]
fn the_step_up_refusal_is_recognized_by_its_error_code() {
    assert!(is_step_up_required(
        &json!({ "error": "STEP_UP_REQUIRED", "scope": "org.credentials" })
    ));
    assert!(!is_step_up_required(&json!({ "error": "forbidden" })));
    assert!(!is_step_up_required(
        &json!({ "message": "STEP_UP_REQUIRED" })
    ));
    assert!(!is_step_up_required(&Value::Null));
}

#[test]
fn the_node_key_vouches_only_for_its_verified_local_caller_on_a_shared_node() {
    let alice = caller("alice", OrgRole::Member, &["team-a"]);
    let org = node(NodeScope::Org, None, None);
    let team = node(NodeScope::Team, Some("team-a"), None);
    // The legitimate path: `ryu secrets` on this org or team node's own
    // machine, with the JWT that produced the verified caller.
    assert!(node_key_may_vouch(
        Some(&org),
        Some(&alice),
        Some(&alice),
        true
    ));
    assert!(node_key_may_vouch(
        Some(&team),
        Some(&alice),
        Some(&alice),
        true
    ));

    // A personal node never vouches, even for its owner.
    let personal = node(NodeScope::Personal, None, Some("alice"));
    assert!(!node_key_may_vouch(
        Some(&personal),
        Some(&alice),
        Some(&alice),
        true
    ));
    // A remote holder of a node or paired token gets no proof, and neither
    // does a loopback request whose bearer is not the owner token (a
    // session-riding page sending a minted user JWT to this port).
    assert!(!node_key_may_vouch(
        Some(&org),
        Some(&alice),
        Some(&alice),
        false
    ));
    // The forwarded JWT names someone else, or does not verify at all.
    let mallory = caller("mallory", OrgRole::Admin, &[]);
    assert!(!node_key_may_vouch(
        Some(&org),
        Some(&alice),
        Some(&mallory),
        true
    ));
    assert!(!node_key_may_vouch(Some(&org), Some(&alice), None, true));
    let mut alice_elsewhere = alice.clone();
    alice_elsewhere.org_id = Some("org-2".to_owned());
    assert!(!node_key_may_vouch(
        Some(&org),
        Some(&alice),
        Some(&alice_elsewhere),
        true
    ));
    // No verified caller, a caller from another org, or no node at all.
    assert!(!node_key_may_vouch(Some(&org), None, Some(&alice), true));
    assert!(!node_key_may_vouch(
        Some(&org),
        Some(&alice_elsewhere),
        Some(&alice_elsewhere),
        true
    ));
    assert!(!node_key_may_vouch(None, Some(&alice), Some(&alice), true));
}

#[tokio::test]
async fn the_vouch_is_withheld_unless_the_forwarded_jwt_verifies_locally() {
    let alice = caller("alice", OrgRole::Member, &[]);
    let mut with_jwt = ctx(
        Some(node(NodeScope::Org, None, None)),
        Some(alice),
        false,
        Vec::new(),
    );
    // No JWT to forward: nothing to vouch for.
    assert!(!with_jwt.node_vouches().await);
    with_jwt.jwt = Some("not-a-jwt".to_owned());
    // Outside an HTTP request, locality is unknown and counts as remote.
    assert!(!with_jwt.node_vouches().await);
    // A local request whose bearer is not the owner token gets no proof.
    assert!(
        !crate::server::REQUEST_PEER_IS_LOCAL
            .scope(true, with_jwt.node_vouches())
            .await
    );
    // Nor does a remote one.
    assert!(
        !crate::server::REQUEST_PEER_IS_LOCAL
            .scope(false, with_jwt.node_vouches())
            .await
    );
    // Nor a local owner-token request whose JWT does not verify.
    assert!(
        !crate::server::REQUEST_PEER_IS_LOCAL
            .scope(
                true,
                crate::server::REQUEST_PRESENTS_OWNER_TOKEN.scope(true, with_jwt.node_vouches())
            )
            .await
    );
}

#[tokio::test]
async fn only_a_local_request_admitted_with_the_owner_token_is_the_local_owner() {
    use crate::authorization::{AuthorizationContext, CredentialKind};
    let local_owner = |local: bool, owner: bool| {
        crate::server::REQUEST_PEER_IS_LOCAL.scope(
            local,
            crate::server::REQUEST_PRESENTS_OWNER_TOKEN.scope(owner, async {
                crate::server::request_is_from_local_owner()
            }),
        )
    };
    assert!(local_owner(true, true).await);
    // A browser script on a CORS-allowed origin reaches loopback with a
    // minted user JWT as its bearer: local, but not the owner token.
    assert!(!local_owner(true, false).await);
    // The owner token from a remote peer, or through a forwarding tunnel.
    assert!(!local_owner(false, true).await);
    assert!(!local_owner(false, false).await);
    // Outside an HTTP request it fails closed.
    assert!(!crate::server::request_is_from_local_owner());
    assert!(
        !crate::server::REQUEST_PEER_IS_LOCAL
            .scope(true, async { crate::server::request_is_from_local_owner() })
            .await
    );

    let owner = AuthorizationContext::owner(0);
    assert!(crate::server::presents_owner_token(&owner));
    for credential in [
        CredentialKind::None,
        CredentialKind::ManagedUserJwt,
        CredentialKind::ManagedDelegation,
        CredentialKind::HostedOAuth,
        CredentialKind::PluginHostGrant,
        CredentialKind::NodeWorkload,
        CredentialKind::PairedCapability {
            grant_id: "grant".to_owned(),
        },
    ] {
        let context = AuthorizationContext {
            credential,
            ..AuthorizationContext::owner(0)
        };
        assert!(!crate::server::presents_owner_token(&context));
    }
}

#[test]
fn only_a_verified_user_jwt_bearer_is_forwarded_as_the_user_jwt() {
    let headers = |pairs: &[(&'static str, &str)]| {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(*name, value.parse().unwrap());
        }
        map
    };
    // A bearer that admitted the request as anything but a user JWT (the
    // owner token, a paired token, a node delegation) never goes upstream.
    let node_bearer = headers(&[("authorization", "Bearer node-local-secret")]);
    assert_eq!(user_jwt(&node_bearer, false), None);
    // The header JWT is forwarded beside such a bearer.
    let with_header = headers(&[
        ("authorization", "Bearer node-local-secret"),
        ("x-ryu-user-jwt", "user.jwt.value"),
    ]);
    assert_eq!(
        user_jwt(&with_header, false).as_deref(),
        Some("user.jwt.value")
    );
    // A bearer that admitted the request as a verified user JWT is that JWT.
    let jwt_bearer = headers(&[("authorization", "Bearer user.jwt.value")]);
    assert_eq!(
        user_jwt(&jwt_bearer, true).as_deref(),
        Some("user.jwt.value")
    );
    assert_eq!(user_jwt(&HeaderMap::new(), true), None);
}

#[test]
fn only_a_managed_user_jwt_admission_marks_the_bearer_as_the_user_jwt() {
    use crate::authorization::{AuthorizationContext, CredentialKind};
    let admitted_by = |credential| AuthorizationContext {
        credential,
        ..AuthorizationContext::owner(0)
    };
    assert!(crate::server::bearer_is_user_jwt(&admitted_by(
        CredentialKind::ManagedUserJwt
    )));
    for credential in [
        CredentialKind::None,
        CredentialKind::OwnerRecoveryToken,
        CredentialKind::ManagedDelegation,
        CredentialKind::HostedOAuth,
        CredentialKind::PluginHostGrant,
        CredentialKind::NodeWorkload,
        CredentialKind::PairedCapability {
            grant_id: "grant".to_owned(),
        },
    ] {
        assert!(!crate::server::bearer_is_user_jwt(&admitted_by(credential)));
    }
}

#[tokio::test]
async fn the_user_jwt_bearer_flag_is_read_only_inside_the_request_scope() {
    assert!(!crate::server::request_bearer_is_user_jwt());
    assert!(
        crate::server::REQUEST_BEARER_IS_USER_JWT
            .scope(true, async { crate::server::request_bearer_is_user_jwt() })
            .await
    );
    assert!(
        !crate::server::REQUEST_BEARER_IS_USER_JWT
            .scope(false, async { crate::server::request_bearer_is_user_jwt() })
            .await
    );
}

#[tokio::test]
async fn the_owner_token_flag_is_read_only_inside_the_request_scope() {
    assert!(!crate::server::request_presents_owner_token());
    assert!(
        crate::server::REQUEST_PRESENTS_OWNER_TOKEN
            .scope(true, async {
                crate::server::request_presents_owner_token()
            })
            .await
    );
    assert!(
        !crate::server::REQUEST_PRESENTS_OWNER_TOKEN
            .scope(false, async {
                crate::server::request_presents_owner_token()
            })
            .await
    );
}

#[test]
fn export_warns_on_caller_refusals_and_fails_only_on_step_up() {
    let coded = |code: &str| json!({ "code": code, "error": "Unauthorized" });
    for code in [
        "node_proxy_required",
        "user_jwt_invalid",
        "user_jwt_session_ended",
        "user_jwt_org_not_admitted",
        "org_ip_not_allowed",
        "org_mfa_session_required",
        "org_session_expired",
        "mfa_enrollment_required",
        "staff_session_factor_required",
    ] {
        assert!(is_caller_refusal(401, &coded(code)), "{code}");
        assert!(is_caller_refusal(403, &coded(code)), "{code}");
        assert!(!is_caller_refusal(400, &coded(code)), "{code}");
    }
    // The step-up prompt is passed through instead (it fails the export).
    let step_up = json!({ "error": "STEP_UP_REQUIRED", "scope": "org.credentials" });
    assert!(is_step_up_required(&step_up));
    assert!(!is_caller_refusal(403, &step_up));
    // Not a member of the node's organization, or a closed (family) vault:
    // there are simply no shared values for this caller.
    assert!(!is_caller_refusal(403, &coded("not_an_org_member")));
    assert!(!is_caller_refusal(
        403,
        &json!({ "error": "not a member of this org" })
    ));
    assert!(!is_caller_refusal(401, &Value::Null));
    // An outage is never a caller refusal; the export goes on and warns.
    assert!(!is_caller_refusal(503, &coded("org_ip_not_allowed")));
    assert!(!is_caller_refusal(
        503,
        &coded("user_jwt_lookup_unavailable")
    ));
    assert_eq!(
        format!("{SHARED_REFUSED_PREFIX}org_ip_not_allowed"),
        "vault_shared_refused: org_ip_not_allowed"
    );
}

#[test]
fn an_export_never_hands_back_a_shared_value_a_local_sealed_one_shadows() {
    let shared = BTreeMap::from([
        ("SIGNING_KEY".to_owned(), "shared-plain".to_owned()),
        ("API_URL".to_owned(), "https://shared".to_owned()),
        ("LOG_LEVEL".to_owned(), "warn".to_owned()),
    ]);
    let local = BTreeMap::from([(
        "LOG_LEVEL".to_owned(),
        (
            SecretCoords::root(SecretScope::Node, "node-1", None, "LOG_LEVEL"),
            "debug".to_owned(),
        ),
    )]);
    let withheld = std::collections::BTreeSet::from(["SIGNING_KEY".to_owned()]);
    let values = overlay_local_values(shared, local, &withheld);
    assert_eq!(
        values,
        BTreeMap::from([
            ("API_URL".to_owned(), "https://shared".to_owned()),
            ("LOG_LEVEL".to_owned(), "debug".to_owned()),
        ])
    );
}

#[tokio::test]
async fn a_scan_never_matches_text_against_a_sealed_value() {
    use crate::plugin_secrets::kv::ValueType;
    let operator = ctx(None, None, true, Vec::new());
    let actor = operator.actor();
    for (name, value, value_type) in [
        (
            "SEALED_KEY",
            "sealed-plaintext-1234567890",
            ValueType::Sealed,
        ),
        ("PLAIN_KEY", "plain-plaintext-1234567890", ValueType::Secret),
    ] {
        operator
            .store
            .write_secret(WriteRequest {
                coords: SecretCoords::root(SecretScope::Node, "node-1", None, name),
                value: Some(value),
                patch: SecretMetadataPatch {
                    value_type: Some(value_type),
                    ..Default::default()
                },
                actor: &actor,
                source: VersionSource::Write,
                expected_version: None,
            })
            .await
            .unwrap();
    }
    let known = scan_known_values(&operator).await.unwrap();
    let refs: Vec<scan::KnownValue<'_>> = known
        .iter()
        .map(|(label, value)| scan::KnownValue { label, value })
        .collect();
    let text = "A=sealed-plaintext-1234567890\nB=plain-plaintext-1234567890\n";
    let findings = serde_json::to_string(&scan::scan(text, None, &refs, &[])).unwrap();
    assert!(findings.contains("PLAIN_KEY"), "{findings}");
    assert!(!findings.contains("SEALED_KEY"), "{findings}");
}
