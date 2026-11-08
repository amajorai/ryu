//! Agent principals, discovery, credential-use requests, and proposal approval.

use super::*;

fn machine(rules: &[(&str, Capability)]) -> Agent {
    Agent::Machine {
        principal: TokenPrincipal {
            accessor: "rva_x".into(),
            identity_id: "mid_x".into(),
            identity_name: "ci".into(),
            policies: vec!["ci".into()],
            expires_at: i64::MAX,
        },
        policies: vec![Policy {
            name: "ci".into(),
            description: String::new(),
            rules: rules
                .iter()
                .map(|(path, capability)| crate::vault::policy::PolicyRule {
                    path: (*path).into(),
                    capabilities: vec![*capability],
                    deny: false,
                    ..Default::default()
                })
                .collect(),
        }],
    }
}

#[test]
fn machines_broker_only_with_use_on_the_service_key() {
    let openai = stored(test_service("openai", "api.openai.com", None, "/"));
    let github = stored(test_service("github", "api.github.com", None, "/"));
    let agent = machine(&[("sys/broker/openai", Capability::Use)]);
    assert!(agent.may_use(&openai));
    assert!(!agent.may_use(&github));
    let wildcard = machine(&[("sys/broker/*", Capability::Use)]);
    assert!(wildcard.may_use(&github));
    let reader = machine(&[("sys/broker/*", Capability::Read)]);
    assert!(!reader.may_use(&github));
    assert_eq!(agent.subject(), "machine:mid_x");
}

#[test]
fn sessions_see_only_their_services_and_environment() {
    let session = sessions::BrokerSession {
        id: "bvs_1".into(),
        environment: "default".into(),
        services: vec!["openai".into()],
        label: String::new(),
        minted_by: "operator".into(),
        created_at: 0,
        expires_at: i64::MAX,
        revoked_at: None,
        minted_token: None,
        minter_scope: None,
    };
    let agent = Agent::Session(session);
    let openai = stored(test_service("openai", "api.openai.com", None, "/"));
    let mut elsewhere = test_service("openai", "api.openai.com", None, "/");
    elsewhere.environment = "prod".into();
    assert!(agent.may_use(&openai));
    assert!(!agent.may_use(&stored(elsewhere)));
    assert_eq!(agent.subject(), "broker_session:bvs_1");
    // Its proposals count against whoever minted it.
    assert_eq!(agent.accountable(), "operator");
}

fn credential_use(store: &PluginSecretStore, subject: &str) -> proposals::Proposal {
    let conn = store.conn.blocking_lock();
    proposals::create_credential_use(
        &conn,
        proposals::CredentialUse {
            reference: "op://work@dev/GitHub/token".into(),
            account_id: "pma_1".into(),
            account: "work".into(),
            provider: "1password-connect".into(),
            subject: subject.into(),
        },
        "default",
        "broker_session:bvs_1",
    )
    .unwrap()
}

#[test]
fn sessions_of_one_principal_poll_its_credential_use_requests() {
    let store = PluginSecretStore::in_memory().unwrap();
    let request = credential_use(&store, "broker:user:u1");
    let session = |id: &str, minted_by: &str| {
        Agent::Session(sessions::BrokerSession {
            id: id.into(),
            environment: "default".into(),
            services: vec!["gh".into()],
            label: String::new(),
            minted_by: minted_by.into(),
            created_at: 0,
            expires_at: i64::MAX,
            revoked_at: None,
            minted_token: None,
            minter_scope: None,
        })
    };
    // The filing session and a second session of the same minter both
    // poll it; another minter's session and a machine do not.
    assert!(may_poll(&session("bvs_1", "user:u1"), &request));
    assert!(may_poll(&session("bvs_2", "user:u1"), &request));
    assert!(!may_poll(&session("bvs_3", "user:u2"), &request));
    assert!(!may_poll(&machine(&[]), &request));
    // A second session's retry returns the same request.
    let again = credential_use(&store, "broker:user:u1");
    assert_eq!(again.id, request.id);
    let for_machine = credential_use(&store, "broker:machine:mid_x");
    assert!(may_poll(&machine(&[]), &for_machine));
    // A request for the user's explicit read is not a broker request.
    let read = credential_use(&store, "read:user:u1");
    assert!(!may_poll(&session("bvs_2", "user:u1"), &read));
}

#[tokio::test]
async fn credential_use_requests_need_the_account_on_broker_routes() {
    let lister = human_ctx(vec![
        rule(SYS_BROKER, Capability::Admin, false),
        rule(SYS_BROKER, Capability::List, false),
    ]);
    let request = {
        let conn = lister.store.conn.lock().await;
        proposals::create_credential_use(
            &conn,
            proposals::CredentialUse {
                reference: "op://work@dev/GitHub/token".into(),
                account_id: "pma_1".into(),
                account: "work".into(),
                provider: "1password-connect".into(),
                subject: "broker:operator".into(),
            },
            "default",
            "broker_session:bvs_1",
        )
        .unwrap()
    };
    let mut plain = proposals::ProposalInput::default();
    plain.message = "need linear".into();
    plain.credentials = vec![proposals::CredentialRequest {
        reference: "secret:LINEAR".into(),
        description: String::new(),
        obtain_instructions: String::new(),
    }];
    let all = {
        let conn = lister.store.conn.lock().await;
        proposals::create(&conn, plain, "default", "machine:m1", "machine:m1").unwrap();
        proposals::list(&conn, None).unwrap()
    };
    assert_eq!(all.len(), 2);
    // Without any capability on `sys/password-managers/work` the
    // credential-use request is neither listed nor rejectable.
    let listed = visible_proposals(&lister, all.clone());
    assert_eq!(listed.len(), 1);
    assert!(listed[0].credential_use.is_none());
    assert_eq!(
        reject_inner(&lister, &request.id, "").await.status(),
        StatusCode::FORBIDDEN
    );
    let account_admin = Ctx {
        store: lister.store,
        ..human_ctx(vec![
            rule(SYS_BROKER, Capability::Admin, false),
            rule("sys/password-managers/work", Capability::Admin, false),
        ])
    };
    assert_eq!(visible_proposals(&account_admin, all).len(), 2);
}

#[tokio::test]
async fn approval_values_honor_the_approvers_write_parameter_constraints() {
    let ctx = human_ctx(vec![crate::vault::policy::PolicyRule {
        path: "prod/**".into(),
        capabilities: vec![Capability::Write],
        deny: false,
        denied_parameters: Some(BTreeMap::from([(
            "value".to_owned(),
            vec!["bad*".to_owned()],
        )])),
        ..Default::default()
    }]);
    let mut input = proposals::ProposalInput::default();
    input.message = "need a token".into();
    input.credentials = vec![proposals::CredentialRequest {
        reference: "secret:API_TOKEN".into(),
        description: String::new(),
        obtain_instructions: String::new(),
    }];
    let proposal = {
        let conn = ctx.store.conn.lock().await;
        proposals::create(&conn, input, "prod", "machine:m1", "machine:m1").unwrap()
    };
    let values = |value: &str| BTreeMap::from([("secret:API_TOKEN".to_owned(), value.to_owned())]);
    // A value the approver's write grant denies is refused before
    // anything is written, and the proposal stays pending.
    let refused = plan_values(&ctx, &proposal, &values("bad-token")).await;
    assert_eq!(
        refused.err().map(|response| response.status()),
        Some(StatusCode::FORBIDDEN)
    );
    {
        let conn = ctx.store.conn.lock().await;
        assert!(proposals::pending(&conn, &proposal.id).is_ok());
    }
    // A compliant value is planned for the write.
    let planned = plan_values(&ctx, &proposal, &values("good-token"))
        .await
        .unwrap_or_else(|_| panic!("compliant value planned"));
    assert_eq!(planned.len(), 1);
    assert_eq!(planned[0].0.environment, "prod");
    assert_eq!(planned[0].1, "good-token");
}

#[tokio::test]
async fn password_manager_refs_are_pinned_to_their_account_on_write() {
    use crate::vault::password_managers::tests::{add_cli_account, BWS_TOKEN, SECRET_ID};
    let dir = tempfile::tempdir().unwrap();
    let ctx = human_ctx(vec![
        rule("sys/broker/bw", Capability::Admin, false),
        rule("sys/password-managers/team", Capability::Use, false),
    ]);
    add_cli_account(ctx.store, dir.path(), "team", "bitwarden-sm", BWS_TOKEN).await;
    let mut service = test_service("bw", "api.example.com", None, "/");
    service.auth = services::ServiceAuth::Custom {
        headers: [(
            "x-key".to_owned(),
            format!("k {{{{ bws://{SECRET_ID} }}}} / {{{{secret:API_TOKEN}}}}"),
        )]
        .into_iter()
        .collect(),
    };
    service.substitutions = vec![Substitution {
        placeholder: "__BW__".into(),
        reference: format!("secret:bws://{SECRET_ID}"),
        surfaces: vec![Surface::Header],
    }];
    assert_eq!(
        status(authorize_service_write(&ctx, &mut service).await),
        StatusCode::OK
    );
    let services::ServiceAuth::Custom { headers } = &service.auth else {
        panic!("custom auth");
    };
    assert_eq!(
        headers["x-key"],
        format!("k {{{{bws://team@{SECRET_ID}}}}} / {{{{secret:API_TOKEN}}}}")
    );
    assert_eq!(
        service.substitutions[0].reference,
        format!("secret:bws://team@{SECRET_ID}")
    );
    assert!(service.clone().normalize().is_ok());
    // Without `use` on the account the write is refused.
    let mut fresh = test_service("bw", "api.example.com", None, "/");
    fresh.auth = services::ServiceAuth::Bearer {
        token: format!("bws://{SECRET_ID}"),
    };
    let no_use = Ctx {
        store: ctx.store,
        ..human_ctx(vec![rule("sys/broker/bw", Capability::Admin, false)])
    };
    assert_eq!(
        status(authorize_service_write(&no_use, &mut fresh).await),
        StatusCode::FORBIDDEN
    );
}

#[test]
fn discovery_lists_placeholders_and_skills_but_no_values() {
    let mut openai = test_service("openai", "api.openai.com", None, "/");
    openai.substitutions = vec![Substitution {
        placeholder: "__OPENAI_ORG__".into(),
        reference: "secret:OPENAI_ORG".into(),
        surfaces: vec![Surface::Header],
    }];
    openai.notes = "Use model gpt-x".into();
    let mut disabled = test_service("off", "api.off.com", None, "/");
    disabled.enabled = false;
    let services = vec![
        stored(openai),
        stored(disabled),
        stored(test_service("github", "api.github.com", None, "/")),
    ];
    let settings = settings::EnvironmentSettings {
        environment: "default".into(),
        unmatched_host_policy: settings::UnmatchedHostPolicy::Deny,
        broker_runs_under_deny: false,
        skills: "# House rules".into(),
        updated_at: 0,
    };
    let doc = discovery(&services, &settings, &BTreeMap::new(), |s| {
        s.name() != "github"
    });
    let listed = doc["services"].as_array().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["name"], "openai");
    assert_eq!(listed[0]["auth"], "bearer");
    assert_eq!(
        listed[0]["placeholders"][0]["placeholder"],
        "__OPENAI_ORG__"
    );
    assert_eq!(doc["skills"], "# House rules");
    assert_eq!(doc["proposalsEndpoint"], broker::proxy::PROPOSALS_ENDPOINT);
    let text = doc.to_string();
    assert!(!text.contains("secret:API_TOKEN"));
    assert!(!text.contains("secret:OPENAI_ORG"));
    assert!(listed[0].get("oauth").is_none());
}

#[test]
fn discovery_reports_oauth_status_for_oauth_services() {
    use crate::vault::broker::oauth::{OAuthBinding, OAuthState, OAuthStatus};
    let mut linear = test_service("linear", "mcp.linear.app", None, "/");
    linear.auth = services::ServiceAuth::OAuth(OAuthBinding {
        plugin: "@ryu/linear".into(),
        server: "linear".into(),
        profile: "personal".into(),
        resource: "https://mcp.linear.app/mcp".into(),
        client_id: None,
        scopes: vec!["read".into(), "write".into()],
    });
    let services = vec![stored(linear)];
    let settings = settings::EnvironmentSettings {
        environment: "default".into(),
        unmatched_host_policy: settings::UnmatchedHostPolicy::Deny,
        broker_runs_under_deny: false,
        skills: String::new(),
        updated_at: 0,
    };
    let status = OAuthStatus {
        state: OAuthState::NeedsScopes,
        missing_scopes: vec!["write".into()],
        expires_at: None,
    };
    let oauth = BTreeMap::from([("linear".to_owned(), status)]);
    let doc = discovery(&services, &settings, &oauth, |_| true);
    let listed = &doc["services"][0];
    assert_eq!(listed["auth"], "oauth");
    assert_eq!(listed["injectedHeaders"], json!(["authorization"]));
    assert_eq!(listed["oauth"]["state"], "needs_scopes");
    assert_eq!(listed["oauth"]["missingScopes"], json!(["write"]));
}

#[tokio::test]
async fn approving_with_values_honors_write_parameter_constraints() {
    let mut constrained = rule("default/STRIPE_KEY", Capability::Write, false);
    constrained.allowed_parameters = Some(BTreeMap::from([(
        "value".to_owned(),
        vec!["sk_test_*".to_owned()],
    )]));
    let ctx = human_ctx(vec![constrained]);
    let input = proposals::ProposalInput {
        credentials: vec![proposals::CredentialRequest {
            reference: "secret:STRIPE_KEY".into(),
            description: String::new(),
            obtain_instructions: String::new(),
        }],
        ..Default::default()
    };
    let proposal = {
        let conn = ctx.store.conn.lock().await;
        proposals::create(&conn, input, "default", "machine:m", "machine:m").unwrap()
    };
    let values = |value: &str| BTreeMap::from([("secret:STRIPE_KEY".to_owned(), value.to_owned())]);
    assert_eq!(
        plan_values(&ctx, &proposal, &values("sk_live_123"))
            .await
            .err()
            .map(|response| response.status()),
        Some(StatusCode::FORBIDDEN)
    );
    assert_eq!(
        plan_values(&ctx, &proposal, &values("sk_test_123"))
            .await
            .ok()
            .map(|planned| planned.len()),
        Some(1)
    );
}

#[tokio::test]
async fn approving_a_proposal_creates_its_services_atomically() {
    let store = PluginSecretStore::in_memory().unwrap();
    let conn = store.conn.lock().await;
    let input = proposals::ProposalInput {
        services: vec![
            test_service("one", "api.one.com", None, "/"),
            test_service("two", "api.two.com", None, "/"),
        ],
        ..Default::default()
    };
    let proposal =
        proposals::create(&conn, input.clone(), "default", "machine:m", "machine:m").unwrap();
    services::insert(
        &conn,
        test_service("two", "api.other.com", None, "/")
            .normalize()
            .unwrap(),
    )
    .unwrap();
    assert!(apply_proposal(&conn, &proposal, "operator", "").is_err());
    assert!(services::get(&conn, "one").unwrap().is_none());
    assert_eq!(
        proposals::get(&conn, &proposal.id).unwrap().unwrap().status,
        proposals::ProposalStatus::Pending
    );
    services::delete(&conn, "two").unwrap();
    apply_proposal(&conn, &proposal, "operator", "ok").unwrap();
    assert!(services::get(&conn, "one").unwrap().is_some());
    assert!(apply_proposal(&conn, &proposal, "operator", "").is_err());
}
