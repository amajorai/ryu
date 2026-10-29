use super::*;
use crate::config::{ApiKeyConfig, AuthConfig, GatewayConfig};
use crate::state::AppState;

fn state_with_auth(auth: AuthConfig) -> AppState {
    let config = GatewayConfig {
        auth,
        ..GatewayConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    AppState::new_for_test(config, audit, evals)
}

fn api_key(key: &str, name: &str, trusted_forwarder: bool) -> ApiKeyConfig {
    ApiKeyConfig {
        allowed_operations: vec![crate::config::ApiKeyOperation::Inference],
        key: key.to_string(),
        name: name.to_string(),
        org_id: Some("org-acme".to_string()),
        team_id: Some("team-1".to_string()),
        channel_id: None,
        project_id: Some("proj-1".to_string()),
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder,
    }
}

#[tokio::test]
async fn anonymous_inference_never_grants_web_services() {
    let mut client = api_key("synthetic-web-client", "web-client", false);
    client.allowed_operations = vec![ApiKeyOperation::WebSearch];
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        master_key: None,
        api_keys: vec![client],
    });
    for bearer in [None, Some("unknown"), Some("gws1.invalid")] {
        assert!(authenticate_for_operation(
            &state,
            AuthInputs::with_key(bearer),
            ApiKeyOperation::WebSearch
        )
        .await
        .is_err());
    }
    let context = authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-web-client")),
        ApiKeyOperation::WebSearch,
    )
    .await
    .unwrap();
    assert_eq!(context.authorized_operation, ApiKeyOperation::WebSearch);
    assert_eq!(context.user_id.as_deref(), Some("web-client"));
    assert!(!context.is_master_key);
    assert!(authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-web-client")),
        ApiKeyOperation::WebFetch
    )
    .await
    .is_err());
}

const BOX_ID: &str = "bx_0123456789abcdef0123456789abcdef";

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn box_scope(org_id: &str, expires_at: u64) -> ryu_gw_credentials::BoxInferenceScope {
    ryu_gw_credentials::BoxInferenceScope {
        org_id: org_id.to_owned(),
        user_id: Some("user-a".to_owned()),
        session_id: "conv-1".to_owned(),
        box_id: BOX_ID.to_owned(),
        lease_epoch: 3,
        expires_at,
    }
}

const LOCAL_CORE_KEY: &str = "gwcore_0123456789abcdef0123456789abcdef";

fn local_core_state() -> AppState {
    state_with_auth(AuthConfig {
        require_auth: true,
        master_key: Some("sk-master-gwb1".to_string()),
        api_keys: vec![api_key(LOCAL_CORE_KEY, "local-core", true)],
    })
}

#[tokio::test]
async fn gwb1_local_core_key_is_accepted_for_inference_only() {
    let state = local_core_state();
    let token = box_scope("org-acme", unix_now() + 600)
        .sign(LOCAL_CORE_KEY)
        .unwrap();
    let bearer = format!("Bearer {token}");
    let context = authenticate(&state, AuthInputs::with_key(Some(&bearer)))
        .await
        .unwrap();
    assert!(
        caller_identity_is_core_forwarded(&context),
        "the Core-signed Box user's policy applies"
    );
    assert_eq!(context.org_id.as_deref(), Some("org-acme"));
    assert_eq!(context.user_id.as_deref(), Some("user-a"));
    assert_eq!(context.session_id.as_deref(), Some("conv-1"));
    assert_eq!(context.feature.as_deref(), Some("box"));
    assert_eq!(context.agent_id, None);
    assert!(!context.is_master_key);
    assert!(context.key_config.is_none(), "gwb1 is never a forwarder");
    assert!(!context.api_key.contains(&token));
    assert_eq!(context.api_key, format!("box:org-acme:{BOX_ID}"));

    // A forwarded feature header cannot re-label Box spend.
    let mut relabel = AuthInputs::with_key(Some(&bearer));
    relabel.feature = Some("chat".to_owned());
    assert_eq!(
        authenticate(&state, relabel)
            .await
            .unwrap()
            .feature
            .as_deref(),
        Some("box")
    );

    for operation in [ApiKeyOperation::WebSearch, ApiKeyOperation::WebFetch] {
        assert!(matches!(
            authenticate_for_operation(&state, AuthInputs::with_key(Some(&bearer)), operation)
                .await,
            Err(GatewayError::Unauthorized(_))
        ));
    }
}

#[tokio::test]
async fn gwb1_refuses_wrong_keys_expiry_and_identity_mismatch() {
    let state = local_core_state();
    let now = unix_now();
    let valid = box_scope("org-acme", now + 600)
        .sign(LOCAL_CORE_KEY)
        .unwrap();
    let wrong_key = box_scope("org-acme", now + 600)
        .sign("gwcore_another_org_key_0000000000000000")
        .unwrap();
    let expired = box_scope("org-acme", now - 30)
        .sign_at(LOCAL_CORE_KEY, now - 600)
        .unwrap();
    let other_org = box_scope("org-other", now + 600)
        .sign(LOCAL_CORE_KEY)
        .unwrap();
    let tampered = format!("{valid}0");
    for token in [&wrong_key, &expired, &other_org, &tampered] {
        let bearer = format!("Bearer {token}");
        assert!(
            matches!(
                authenticate(&state, AuthInputs::with_key(Some(&bearer))).await,
                Err(GatewayError::Unauthorized(_))
            ),
            "{token}"
        );
    }
    let bearer = format!("Bearer {valid}");
    for (user_id, session_id) in [(Some("user-b"), None), (None, Some("conv-2"))] {
        let mut input = AuthInputs::with_key(Some(&bearer));
        input.user_id = user_id.map(str::to_owned);
        input.session_id = session_id.map(str::to_owned);
        assert!(matches!(
            authenticate(&state, input).await,
            Err(GatewayError::Unauthorized(_))
        ));
    }
    let mut matching = AuthInputs::with_key(Some(&bearer));
    matching.user_id = Some("user-a".to_owned());
    matching.session_id = Some("conv-1".to_owned());
    assert!(authenticate(&state, matching).await.is_ok());
}

#[tokio::test]
async fn gwb1_is_refused_on_control_and_admin_routes() {
    let state = Arc::new(local_core_state());
    let token = box_scope("org-acme", unix_now() + 600)
        .sign(LOCAL_CORE_KEY)
        .unwrap();
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("authorization", format!("Bearer {token}").parse().unwrap());
    let tick: crate::api::sandbox::SandboxTickBody = serde_json::from_value(json!({
        "run_id": "run_gwb1",
        "org_id": "org-acme",
        "spec": {"vcpu": 2, "mem_gib": 4, "storage_gib": 40, "gpu": "none", "os": "linux"},
        "elapsed_seconds_delta": 10,
        "tick_index": 0,
    }))
    .unwrap();
    assert!(matches!(
        crate::api::sandbox::sandbox_tick(
            axum::extract::State(Arc::clone(&state)),
            headers.clone(),
            axum::Json(tick),
        )
        .await,
        Err(GatewayError::Unauthorized(_))
    ));
    let context = authenticate(
        &state,
        AuthInputs::with_key(headers.get("authorization").and_then(|v| v.to_str().ok())),
    )
    .await
    .unwrap();
    let loopback: std::net::SocketAddr = "127.0.0.1:5".parse().unwrap();
    assert!(crate::api::config::require_local_admin(
        &state,
        &loopback,
        context.is_master_key,
        &axum::http::HeaderMap::new(),
        "Config access",
    )
    .is_err());
}

/// A fake control plane serving the org budget route. Records each
/// request head; answers with `status` and `body`.
async fn fake_budget_plane(
    status: u16,
    body: &'static str,
) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let heads = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = Arc::clone(&heads);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                let Ok(count) = stream.read(&mut buffer).await else {
                    break;
                };
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
            }
            sink.lock()
                .unwrap()
                .push(String::from_utf8_lossy(&bytes).into_owned());
            let response = format!(
                "HTTP/1.1 {status} Canned\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes()).await;
        }
    });
    (format!("http://{address}/api"), heads)
}

struct BoxBudgetOverride;

impl BoxBudgetOverride {
    fn set(url: &str) -> Self {
        BOX_BUDGET_SOURCE_OVERRIDE.with(|cell| {
            *cell.borrow_mut() = Some(BoxBudgetSource {
                url: url.to_owned(),
                header: "x-ryu-internal-secret",
                secret: "fleet-credits-secret".to_owned(),
            });
        });
        Self
    }
}

impl Drop for BoxBudgetOverride {
    fn drop(&mut self) {
        BOX_BUDGET_SOURCE_OVERRIDE.with(|cell| *cell.borrow_mut() = None);
    }
}

/// Serializes the tests that set the process-wide proof master env.
static MASTER_KEY_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct MasterKeyEnv(Option<String>, tokio::sync::MutexGuard<'static, ()>);

impl MasterKeyEnv {
    async fn set(value: &str) -> Self {
        let guard = MASTER_KEY_ENV_LOCK.lock().await;
        let previous = std::env::var(ENV_CORE_PROOF_MASTER_KEY).ok();
        std::env::set_var(ENV_CORE_PROOF_MASTER_KEY, value);
        Self(previous, guard)
    }
}

impl Drop for MasterKeyEnv {
    fn drop(&mut self) {
        match &self.0 {
            Some(value) => std::env::set_var(ENV_CORE_PROOF_MASTER_KEY, value),
            None => std::env::remove_var(ENV_CORE_PROOF_MASTER_KEY),
        }
    }
}

#[tokio::test]
async fn gwb1_hosted_derivation_resolves_the_org_budget() {
    let master = "gwb1-test-master-0123456789abcdef0123456789";
    let _master = MasterKeyEnv::set(master).await;
    let (url, heads) = fake_budget_plane(
        200,
        r#"{"orgId":"x","managedInference":true,"remainingBudgetMicroUsd":5000000,"unrestrictedBudgetMicroUsd":4000000,"poolBudgetsMicroUsd":{"cloudflare":1000},"openrouterRoutingEnabled":true}"#,
    )
    .await;
    let _source = BoxBudgetOverride::set(&url);
    let org = format!("org-hosted-{}", Uuid::new_v4().simple());
    let org_key = ryu_gw_credentials::derive_org_core_proof_key(master, &org).unwrap();
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        master_key: None,
        api_keys: Vec::new(),
    });
    let token = box_scope(&org, unix_now() + 600).sign(&org_key).unwrap();
    let bearer = format!("Bearer {token}");
    let context = authenticate(&state, AuthInputs::with_key(Some(&bearer)))
        .await
        .unwrap();
    assert_eq!(context.org_id.as_deref(), Some(org.as_str()));
    assert_eq!(context.feature.as_deref(), Some("box"));
    assert_eq!(context.session_id.as_deref(), Some("conv-1"));
    assert!(context.managed_inference);
    assert_eq!(context.remaining_budget_micro_usd, Some(5_000_000));
    assert_eq!(context.unrestricted_budget_micro_usd, Some(4_000_000));
    assert_eq!(
        context.pool_budgets_micro_usd.get("cloudflare"),
        Some(&1000)
    );
    assert!(context.openrouter_routing_enabled);
    assert!(!context.credit_accounting_unavailable);
    assert!(context.budget_resolved_at.is_some());
    assert!(!context.is_master_key && context.key_config.is_none());

    // The second request reuses the cached budget.
    authenticate(&state, AuthInputs::with_key(Some(&bearer)))
        .await
        .unwrap();
    let recorded = heads.lock().unwrap().clone();
    assert_eq!(recorded.len(), 1);
    assert!(recorded[0].starts_with(&format!("GET /api/gateway/orgs/{org}/budget HTTP/1.1")));
    assert!(recorded[0]
        .to_ascii_lowercase()
        .contains("x-ryu-internal-secret: fleet-credits-secret"));

    // A key derived for another org does not verify, even when the
    // payload names this org.
    let other_key =
        ryu_gw_credentials::derive_org_core_proof_key(master, "org-someone-else").unwrap();
    let forged = box_scope(&org, unix_now() + 600).sign(&other_key).unwrap();
    assert!(matches!(
        authenticate(
            &state,
            AuthInputs::with_key(Some(&format!("Bearer {forged}")))
        )
        .await,
        Err(GatewayError::Unauthorized(_))
    ));
    let mut mismatch = AuthInputs::with_key(Some(&bearer));
    mismatch.session_id = Some("conv-other".to_owned());
    assert!(matches!(
        authenticate(&state, mismatch).await,
        Err(GatewayError::Unauthorized(_))
    ));
}

/// A hosted `gwb1` names its own org, so the shared direct proof key
/// (held by every legacy node) must never verify one for an arbitrary
/// org: only the org's derived key, or the direct key on a single-org
/// Gateway configured for exactly that org.
#[test]
fn gwb1_hosted_keys_never_accept_the_shared_key_for_another_org() {
    let master = "gwb1-test-master-shared-0123456789abcdef01";
    let shared = "gwcore_shared_legacy_proof_key_0123456789";
    let victim = "org-victim";
    let derived = ryu_gw_credentials::derive_org_core_proof_key(master, victim).unwrap();

    // Fleet Gateway (no single-org binding): only the derived key.
    let fleet = box_hosted_proof_keys_from(Some(shared), None, Some(master), victim);
    assert_eq!(fleet, vec![derived.clone()]);
    // A token signed with the shared key and naming the victim org fails.
    let forged = box_scope(victim, unix_now() + 600).sign(shared).unwrap();
    assert!(fleet
        .iter()
        .all(|key| { ryu_gw_credentials::BoxInferenceScope::verify(&forged, key).is_err() }));

    // Single-org Gateway: the direct key verifies only its own org.
    let own = box_hosted_proof_keys_from(Some(shared), Some(victim), None, victim);
    assert_eq!(own, vec![shared.to_owned()]);
    assert!(box_hosted_proof_keys_from(Some(shared), Some("org-other"), None, victim).is_empty());
    // Nothing configured, or no org: nothing verifies.
    assert!(box_hosted_proof_keys_from(Some(shared), None, None, victim).is_empty());
    assert!(box_hosted_proof_keys_from(Some(shared), Some(""), Some(master), "").is_empty());
}

#[tokio::test]
async fn gwb1_hosted_budget_failures_never_open_spend() {
    let master = "gwb1-test-master-fedcba9876543210fedcba9876";
    let _master = MasterKeyEnv::set(master).await;
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        master_key: None,
        api_keys: Vec::new(),
    });

    let (url, _heads) = fake_budget_plane(404, "{}").await;
    let org = format!("org-unknown-{}", Uuid::new_v4().simple());
    let key = ryu_gw_credentials::derive_org_core_proof_key(master, &org).unwrap();
    let token = box_scope(&org, unix_now() + 600).sign(&key).unwrap();
    {
        let _source = BoxBudgetOverride::set(&url);
        assert!(matches!(
            authenticate(
                &state,
                AuthInputs::with_key(Some(&format!("Bearer {token}")))
            )
            .await,
            Err(GatewayError::Unauthorized(_))
        ));
    }

    let (url, _heads) = fake_budget_plane(500, "{}").await;
    let org = format!("org-down-{}", Uuid::new_v4().simple());
    let key = ryu_gw_credentials::derive_org_core_proof_key(master, &org).unwrap();
    let token = box_scope(&org, unix_now() + 600).sign(&key).unwrap();
    let _source = BoxBudgetOverride::set(&url);
    let context = authenticate(
        &state,
        AuthInputs::with_key(Some(&format!("Bearer {token}"))),
    )
    .await
    .unwrap();
    assert!(context.managed_inference);
    assert!(context.credit_accounting_unavailable);
    assert_eq!(context.remaining_budget_micro_usd, None);
}

#[test]
fn gwb1_budget_lookup_uses_the_fleet_service_credential() {
    let env = |pairs: &'static [(&'static str, &'static str)]| {
        move |name: &str| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_owned())
        }
    };
    // A multi-tenant fleet: the credits secret, never GATEWAY_KEY.
    let fleet = crate::config::CreditsConfig {
        base_url: "https://cp.ryu.dev/api".to_owned(),
        internal_secret: Some(" fleet-secret ".to_owned()),
        ..crate::config::CreditsConfig::default()
    };
    assert_eq!(
        select_box_budget_source(
            &fleet,
            env(&[
                ("CONTROL_PLANE_URL", "https://other.example"),
                ("GATEWAY_KEY", "org-key")
            ])
        ),
        Some(BoxBudgetSource {
            url: "https://cp.ryu.dev/api".to_owned(),
            header: "x-ryu-internal-secret",
            secret: "fleet-secret".to_owned(),
        })
    );
    // No credits secret: a single-org gateway's CONTROL_PLANE_URL and key.
    let unbilled = crate::config::CreditsConfig {
        internal_secret: Some("  ".to_owned()),
        ..crate::config::CreditsConfig::default()
    };
    assert_eq!(
        select_box_budget_source(
            &unbilled,
            env(&[
                ("CONTROL_PLANE_URL", "https://cp.ryu.dev"),
                ("GATEWAY_KEY", "service-key")
            ])
        ),
        Some(BoxBudgetSource {
            url: "https://cp.ryu.dev".to_owned(),
            header: "x-gateway-key",
            secret: "service-key".to_owned(),
        })
    );
    assert_eq!(
        select_box_budget_source(&unbilled, env(&[("CONTROL_PLANE_URL", "https://cp")])),
        None
    );
    assert_eq!(select_box_budget_source(&unbilled, env(&[])), None);
    let rendered = format!("{:?}", select_box_budget_source(&fleet, env(&[])));
    assert!(rendered.contains("x-ryu-internal-secret"), "{rendered}");
    assert!(!rendered.contains("fleet-secret"), "{rendered}");
}

#[test]
fn gwb1_tenant_credit_follows_the_resolved_org_rules() {
    let unfunded = BoxOrgBudget::default();
    let credit = box_tenant_credit(&unfunded, true);
    assert!(credit.managed_inference);
    assert_eq!(credit.remaining_budget_micro_usd, Some(0));
    let credit = box_tenant_credit(&unfunded, false);
    assert!(!credit.managed_inference);
    let outage = BoxOrgBudget {
        managed_tier_unavailable: true,
        ..BoxOrgBudget::default()
    };
    assert!(box_tenant_credit(&outage, true).accounting_unavailable);
    assert_eq!(box_token_org_hint("gwb1.zz.00"), None);
    assert_eq!(box_token_org_hint("gws1.00.00"), None);
    let signed = box_scope("org-hint", unix_now() + 600)
        .sign("any-key")
        .unwrap();
    assert_eq!(box_token_org_hint(&signed).as_deref(), Some("org-hint"));
    assert!(!valid_box_org_id("org/../admin"));
}

#[tokio::test]
async fn inference_only_static_keys_cannot_authorize_web_operations() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        master_key: Some("synthetic-master".into()),
        api_keys: vec![api_key("synthetic-inference", "legacy", true)],
    });
    assert!(authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-inference")),
        ApiKeyOperation::WebSearch
    )
    .await
    .is_err());
    assert!(authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-inference")),
        ApiKeyOperation::WebFetch
    )
    .await
    .is_err());
    let master = authenticate_for_operation(
        &state,
        AuthInputs::with_key(Some("synthetic-master")),
        ApiKeyOperation::WebFetch,
    )
    .await
    .unwrap();
    assert!(master.is_master_key);
    assert_eq!(master.authorized_operation, ApiKeyOperation::WebFetch);
}

// ─── no-auth mode ────────────────────────────────────────────────────────

#[tokio::test]
async fn no_auth_mode_makes_unknown_callers_anonymous() {
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: None,
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("whatever")))
        .await
        .expect("no-auth accepts any key");
    assert!(!ctx.is_master_key);
    assert_eq!(ctx.api_key, "whatever");
    assert!(ctx.org_id.is_none());
}

#[tokio::test]
async fn no_auth_mode_with_no_key_labels_api_key_anonymous() {
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: None,
    });
    let ctx = authenticate(&state, AuthInputs::with_key(None))
        .await
        .expect("no-auth accepts missing key");
    assert_eq!(ctx.api_key, "anonymous");
    assert!(!ctx.is_master_key);
}

#[tokio::test]
async fn no_auth_mode_still_recognizes_provisioned_master_key() {
    // A provisioned master key stays authoritative even with require_auth off.
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: Some("master-secret".to_string()),
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("master-secret")))
        .await
        .expect("master key recognized");
    assert!(ctx.is_master_key);
    assert_eq!(ctx.user_name.as_deref(), Some("master"));
}

#[tokio::test]
async fn no_auth_master_key_honors_bearer_prefix() {
    let state = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: Some("master-secret".to_string()),
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("Bearer master-secret")))
        .await
        .expect("bearer-prefixed master key recognized");
    assert!(ctx.is_master_key);
}

// ─── require_auth mode ───────────────────────────────────────────────────

#[tokio::test]
async fn require_auth_rejects_missing_key() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![],
        master_key: None,
    });
    let err = authenticate(&state, AuthInputs::with_key(None))
        .await
        .expect_err("missing key must be rejected");
    assert!(matches!(err, GatewayError::Unauthorized(_)));
}

#[tokio::test]
async fn require_auth_rejects_unknown_key() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-known", "known", false)],
        master_key: None,
    });
    let err = authenticate(&state, AuthInputs::with_key(Some("sk-unknown")))
        .await
        .expect_err("unknown key must be rejected");
    assert!(matches!(err, GatewayError::Unauthorized(_)));
}

#[tokio::test]
async fn require_auth_matches_master_key() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![],
        master_key: Some("master-secret".to_string()),
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("Bearer master-secret")))
        .await
        .expect("master key accepted");
    assert!(ctx.is_master_key);
}

#[tokio::test]
async fn static_key_match_populates_org_team_project() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-acme", "acme-key", false)],
        master_key: None,
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("sk-acme")))
        .await
        .expect("static key accepted");
    assert!(!ctx.is_master_key);
    assert_eq!(ctx.org_id.as_deref(), Some("org-acme"));
    assert_eq!(ctx.team_id.as_deref(), Some("team-1"));
    assert_eq!(ctx.project_id.as_deref(), Some("proj-1"));
    assert_eq!(ctx.user_name.as_deref(), Some("acme-key"));
    assert!(ctx.key_config.is_some());
}

#[tokio::test]
async fn untrusted_key_ignores_forwarded_identity_headers() {
    // trusted_forwarder = false => the client-supplied x-ryu-user-id /
    // x-ryu-agent-id are ignored and budget identity binds to the key name,
    // so a caller cannot spoof or rotate identity to evade its quota.
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-acme", "acme-key", false)],
        master_key: None,
    });
    let inputs = AuthInputs {
        raw_api_key: Some("sk-acme"),
        user_id: Some("spoofed-user".to_string()),
        agent_id: Some("spoofed-agent".to_string()),
        ..Default::default()
    };
    let ctx = authenticate(&state, inputs).await.expect("accepted");
    assert_eq!(
        ctx.user_id.as_deref(),
        Some("acme-key"),
        "budget identity must bind to the key name, not the spoofed header"
    );
    assert!(ctx.agent_id.is_none());
}

#[tokio::test]
async fn trusted_forwarder_honors_forwarded_identity_headers() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-core", "ryu-core", true)],
        master_key: None,
    });
    let inputs = AuthInputs {
        raw_api_key: Some("sk-core"),
        user_id: Some("real-user".to_string()),
        agent_id: Some("real-agent".to_string()),
        ..Default::default()
    };
    let ctx = authenticate(&state, inputs).await.expect("accepted");
    assert_eq!(ctx.user_id.as_deref(), Some("real-user"));
    assert_eq!(ctx.agent_id.as_deref(), Some("real-agent"));
}

/// Core's host-conversation proof is relayed to the tool loop only from
/// Core's own trusted-forwarder key. Any other bearer (an ordinary key, the
/// master key, an anonymous caller) has the headers dropped, so the tool
/// loop keeps Core's fail-closed node-wide principal for it.
#[tokio::test]
async fn host_conversation_proof_is_kept_only_for_a_trusted_forwarder() {
    let host = crate::tools::HostConversation {
        id: "conv-1".into(),
        proof: "proof-1".into(),
    };
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![
            api_key("sk-core", "ryu-core", true),
            api_key("sk-acme", "acme-key", false),
        ],
        master_key: Some("master-secret".into()),
    });
    let with_key = |key: &'static str| AuthInputs {
        raw_api_key: Some(key),
        host_conversation: Some(host.clone()),
        ..Default::default()
    };
    let trusted = authenticate(&state, with_key("sk-core"))
        .await
        .expect("accepted");
    assert_eq!(trusted.host_conversation.as_ref(), Some(&host));
    for key in ["sk-acme", "master-secret"] {
        let ctx = authenticate(&state, with_key(key)).await.expect("accepted");
        assert_eq!(ctx.host_conversation, None, "{key}");
    }

    let open = state_with_auth(AuthConfig {
        require_auth: false,
        api_keys: vec![],
        master_key: None,
    });
    let anonymous = authenticate(&open, with_key("anything"))
        .await
        .expect("accepted");
    assert_eq!(anonymous.host_conversation, None);
}

#[tokio::test]
async fn rgw_token_without_resolve_cache_is_hard_rejected() {
    // An rgw_-shaped bearer only reaches the dynamic path when a resolve cache
    // is configured; the test state has none, so it must NOT fall open into
    // anonymous — it is a hard 401.
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![],
        master_key: None,
    });
    let err = authenticate(&state, AuthInputs::with_key(Some("rgw_sometoken")))
        .await
        .expect_err("rgw_ token with no resolve cache must be rejected");
    assert!(matches!(err, GatewayError::Unauthorized(_)));
}

#[tokio::test]
async fn static_key_match_strips_bearer_prefix() {
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        api_keys: vec![api_key("sk-acme", "acme-key", false)],
        master_key: None,
    });
    let ctx = authenticate(&state, AuthInputs::with_key(Some("Bearer sk-acme")))
        .await
        .expect("bearer-prefixed static key accepted");
    assert_eq!(ctx.user_name.as_deref(), Some("acme-key"));
}

#[test]
fn ct_eq_is_functionally_equivalent_to_str_eq() {
    // Constant-time compare returns the exact same boolean as `==`: the only
    // difference is the removed per-byte timing signal (see `ct_eq` doc comment).
    assert!(ct_eq("sk-abc", "sk-abc"));
    // Single trailing-byte difference (the case a naive `==` would leak).
    assert!(!ct_eq("sk-abc", "sk-abd"));
    // Length mismatch short-circuits to false (key length is not secret).
    assert!(!ct_eq("sk-ab", "sk-abc"));
    // Empty vs empty is equal.
    assert!(ct_eq("", ""));
}
