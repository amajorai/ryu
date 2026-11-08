use super::*;
use crate::vault::broker::services::{test_service, Substitution};
use crate::vault::broker::substitute::Surface;

fn stored(input: services::ServiceInput) -> services::BrokerService {
    services::BrokerService {
        input: input.normalize().unwrap(),
        created_at: 0,
        updated_at: 0,
    }
}

fn rule(path: &str, capability: Capability, deny: bool) -> crate::vault::policy::PolicyRule {
    crate::vault::policy::PolicyRule {
        path: path.into(),
        capabilities: vec![capability],
        deny,
        ..Default::default()
    }
}

/// A non-manager human principal holding `rules` (the local node, so
/// node-scoped values start from the full baseline and only policies
/// narrow them).
fn human_ctx(rules: Vec<crate::vault::policy::PolicyRule>) -> Ctx {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    Ctx {
        store,
        node: None,
        node_id: crate::vault::broker::local_node_id(),
        caller: None,
        manager: false,
        policies: vec![Policy {
            name: "p".into(),
            description: String::new(),
            rules,
        }],
        jwt: None,
    }
}

fn status(result: Result<(), Response>) -> StatusCode {
    match result {
        Ok(()) => StatusCode::OK,
        Err(response) => response.status(),
    }
}

#[tokio::test]
async fn service_writes_need_admin_and_use_on_every_credential() {
    let mut service = test_service("gh", "api.github.com", None, "/");
    service.substitutions = vec![Substitution {
        placeholder: "__ORG__".into(),
        reference: "secret:prod:/team/ORG_ID".into(),
        surfaces: vec![Surface::Header],
    }];
    // No admin on the service key.
    let ctx = human_ctx(vec![rule("sys/broker/other", Capability::Admin, false)]);
    assert_eq!(
        status(authorize_service_write(&ctx, &mut service.clone()).await),
        StatusCode::FORBIDDEN
    );
    // Admin, and `use` on both references (auth in the service's
    // environment, the substitution in the one it names).
    let ctx = human_ctx(vec![rule("sys/broker/gh", Capability::Admin, false)]);
    assert_eq!(
        status(authorize_service_write(&ctx, &mut service.clone()).await),
        StatusCode::OK
    );
    // Admin on the key alone cannot aim a credential the caller may not
    // use: a deny on either reference refuses the write.
    for denied in ["default/API_TOKEN", "prod/team/ORG_ID"] {
        let ctx = human_ctx(vec![
            rule("sys/broker/gh", Capability::Admin, false),
            rule(denied, Capability::Use, true),
        ]);
        assert_eq!(
            status(authorize_service_write(&ctx, &mut service.clone()).await),
            StatusCode::FORBIDDEN,
            "{denied}"
        );
    }
    let mut bad = service.clone();
    bad.auth = services::ServiceAuth::Bearer {
        token: "secret:bad name".into(),
    };
    let ctx = human_ctx(vec![rule("sys/broker/gh", Capability::Admin, false)]);
    assert_eq!(
        status(authorize_service_write(&ctx, &mut bad.clone()).await),
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn human_session_minting_needs_use_on_each_service() {
    let ctx = human_ctx(vec![rule("sys/broker/gh", Capability::Use, false)]);
    {
        let conn = ctx.store.conn.lock().await;
        for name in ["gh", "linear"] {
            services::insert(
                &conn,
                test_service(name, &format!("{name}.example.com"), None, "/"),
            )
            .unwrap();
        }
    }
    let check = |names: &[&str]| {
        let names: Vec<String> = names.iter().map(|name| (*name).to_owned()).collect();
        let ctx = &ctx;
        async move {
            status(
                check_session_services(ctx.store, "default", &names, |name| {
                    ctx.sys_caps(&service_key(name)).contains(&Capability::Use)
                })
                .await,
            )
        }
    };
    assert_eq!(check(&["gh"]).await, StatusCode::OK);
    assert_eq!(check(&["gh", "linear"]).await, StatusCode::FORBIDDEN);
    assert_eq!(check(&["missing"]).await, StatusCode::BAD_REQUEST);
    let admin_only = human_ctx(vec![rule("sys/broker/*", Capability::Admin, false)]);
    assert!(!admin_only
        .sys_caps(&service_key("gh"))
        .contains(&Capability::Use));
}

#[test]
fn only_the_minter_or_a_broker_admin_revokes_a_session() {
    let session = |minted_by: &str| sessions::BrokerSession {
        id: "bvs_1".into(),
        environment: "default".into(),
        services: vec!["gh".into()],
        label: String::new(),
        minted_by: minted_by.into(),
        created_at: 0,
        expires_at: i64::MAX,
        revoked_at: None,
        minted_token: None,
        minter_scope: None,
    };
    let nobody = human_ctx(Vec::new());
    assert_eq!(
        status(authorize_revoke(&nobody, &session("operator"))),
        StatusCode::OK
    );
    assert_eq!(
        status(authorize_revoke(&nobody, &session("user:someone-else"))),
        StatusCode::FORBIDDEN
    );
    let lister = human_ctx(vec![rule(SYS_BROKER, Capability::List, false)]);
    assert_eq!(
        status(authorize_revoke(&lister, &session("machine:m1"))),
        StatusCode::FORBIDDEN
    );
    let admin = human_ctx(vec![rule(SYS_BROKER, Capability::Admin, false)]);
    assert_eq!(
        status(authorize_revoke(&admin, &session("machine:m1"))),
        StatusCode::OK
    );
}

#[test]
fn broker_wide_routes_gate_on_sys_broker() {
    // Logs, discovered hosts, proposals listing, and status need `list`;
    // settings, the session list, and decisions need `admin`.
    let nobody = human_ctx(Vec::new());
    assert_eq!(
        status(nobody.require_sys(SYS_BROKER, Capability::List)),
        StatusCode::FORBIDDEN
    );
    let lister = human_ctx(vec![rule(SYS_BROKER, Capability::List, false)]);
    assert_eq!(
        status(lister.require_sys(SYS_BROKER, Capability::List)),
        StatusCode::OK
    );
    assert_eq!(
        status(lister.require_sys(SYS_BROKER, Capability::Admin)),
        StatusCode::FORBIDDEN
    );
    // A per-service grant does not reach the broker-wide key.
    let service_admin = human_ctx(vec![rule("sys/broker/*", Capability::Admin, false)]);
    assert_eq!(
        status(service_admin.require_sys(SYS_BROKER, Capability::Admin)),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn the_public_ca_route_never_creates_the_ca() {
    // `broker_ca` reads through the global store; exercise the read it
    // performs on a fresh store instead.
    let store = PluginSecretStore::in_memory().unwrap();
    assert!(ca::existing_certificate_pem(&store)
        .await
        .unwrap()
        .is_none());
    let audits: i64 = {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT COUNT(*) FROM vault_audit WHERE action = 'broker.ca.create'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(audits, 0);
}

#[path = "tests_agent.rs"]
mod agent;
