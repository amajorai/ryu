//! Hosted `gwb1` Box keys: per-org derivation, the org budget and
//! governance lookup, and their failure modes; and that no `gwb1` key
//! reaches control or admin routes.

use super::*;
use crate::pipeline::auth_identity::box_governance::box_tenant_credit;

#[path = "authenticate_box_member_tests.rs"]
mod member;

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

struct MasterKeyEnv {
    previous: Option<String>,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl MasterKeyEnv {
    async fn set(value: &str) -> Self {
        let guard = MASTER_KEY_ENV_LOCK.lock().await;
        let previous = std::env::var(ENV_CORE_PROOF_MASTER_KEY).ok();
        std::env::set_var(ENV_CORE_PROOF_MASTER_KEY, value);
        Self {
            previous,
            _guard: guard,
        }
    }
}

impl Drop for MasterKeyEnv {
    fn drop(&mut self) {
        match &self.previous {
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
        r#"{"orgId":"x","managedInference":true,"remainingBudgetMicroUsd":5000000,"unrestrictedBudgetMicroUsd":4000000,"poolBudgetsMicroUsd":{"cloudflare":1000},"openrouterRoutingEnabled":true,"governance":{"policy":{"rules":{}},"limits":{},"standing":{"state":"active","refuses":"none"}}}"#,
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
    // The Box member travels so the plane applies the member's policy layer.
    assert!(recorded[0].starts_with(&format!(
        "GET /api/gateway/orgs/{org}/budget?userId=user-a HTTP/1.1"
    )));
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
    // An unreachable plane leaves the org's governance unknown: a retryable
    // 503, never a request served under the fleet's own policy.
    assert!(matches!(
        authenticate(
            &state,
            AuthInputs::with_key(Some(&format!("Bearer {token}")))
        )
        .await,
        Err(GatewayError::StandingUnavailable)
    ));
}

/// Authenticate a hosted `gwb1` for a fresh org against a plane serving `body`.
async fn hosted_box_auth(
    master: &str,
    prefix: &str,
    body: &'static str,
) -> Result<RequestContext, GatewayError> {
    hosted_box_auth_in(
        crate::custody::GatewayCustody::SelfHosted,
        master,
        prefix,
        body,
    )
    .await
}

async fn hosted_box_auth_in(
    custody: crate::custody::GatewayCustody,
    master: &str,
    prefix: &str,
    body: &'static str,
) -> Result<RequestContext, GatewayError> {
    let (url, _heads) = fake_budget_plane(200, body).await;
    let org = format!("{prefix}-{}", Uuid::new_v4().simple());
    let key = ryu_gw_credentials::derive_org_core_proof_key(master, &org).unwrap();
    let token = box_scope(&org, unix_now() + 600).sign(&key).unwrap();
    let _source = BoxBudgetOverride::set(&url);
    let mut state = state_with_auth(AuthConfig {
        require_auth: true,
        master_key: None,
        api_keys: Vec::new(),
    });
    state.custody = custody;
    let bearer = format!("Bearer {token}");
    if custody.is_fleet() {
        // Identity admission only: a test fleet holds no platform floor.
        return crate::pipeline::auth_identity::authenticate_identity(
            &state,
            AuthInputs::with_key(Some(&bearer)),
            crate::config::ApiKeyOperation::Inference,
        )
        .await;
    }
    authenticate(&state, AuthInputs::with_key(Some(&bearer))).await
}

#[tokio::test]
async fn gwb1_hosted_requests_run_under_the_orgs_governance() {
    let master = "gwb1-test-master-governance-0123456789abcd";
    let _master = MasterKeyEnv::set(master).await;
    let context = hosted_box_auth(
        master,
        "org-governed",
        r#"{"managedInference":true,"remainingBudgetMicroUsd":5000000,"governance":{"policy":{"rules":{"approvedModels":["cheap"],"allowedRegions":["eu"],"lockedGuardrails":["pii"]}},"limits":{"members":{"user-a":{"rpm":1}},"teams":{"team-z":{"budgetMicroUsd":10}}},"teamIds":["team-z"],"standing":{"state":"active","refuses":"none"},"policyVersion":"v1-x"}}"#,
    )
    .await
    .unwrap();
    // The org's policy, not the fleet's permissive snapshot.
    let policy = context
        .resolved_policy
        .as_ref()
        .expect("org policy applied");
    assert!(policy.allows_model("cheap"));
    assert!(!policy.allows_model("expensive"));
    assert!(!policy.allows_region(Some("us")));
    assert!(policy.requires_firewall());
    // The org's caps, bound to the Core-signed Box member and their teams.
    let limits = context.org_limits.as_deref().expect("org limits applied");
    assert_eq!(limits.bound_user_id.as_deref(), Some("user-a"));
    assert_eq!(limits.team_ids, vec!["team-z".to_owned()]);
    assert!(limits.limits.members.contains_key("user-a"));
}

#[tokio::test]
async fn gwb1_hosted_member_rpm_cap_is_enforced() {
    let master = "gwb1-test-master-member-rpm-0123456789ab";
    let _master = MasterKeyEnv::set(master).await;
    let body = r#"{"managedInference":true,"governance":{"limits":{"members":{"user-a":{"rpm":1}}},"standing":{"state":"active","refuses":"none"}}}"#;
    let context = hosted_box_auth(master, "org-rpm", body).await.unwrap();
    let state = state_with_auth(AuthConfig {
        require_auth: true,
        master_key: None,
        api_keys: Vec::new(),
    });
    assert!(crate::org_limits::check_request(&state, &context).is_ok());
    assert!(matches!(
        crate::org_limits::check_request(&state, &context),
        Err(GatewayError::RateLimited)
    ));
}

#[tokio::test]
async fn gwb1_hosted_refuses_a_suspended_org_or_a_plane_without_governance() {
    let master = "gwb1-test-master-standing-0123456789abcde";
    let _master = MasterKeyEnv::set(master).await;
    let suspended = hosted_box_auth(
        master,
        "org-suspended",
        r#"{"managedInference":true,"remainingBudgetMicroUsd":5000000,"governance":{"policy":{"rules":{}},"standing":{"state":"org_suspended","refuses":"all"}}}"#,
    )
    .await;
    assert!(
        matches!(suspended, Err(GatewayError::StandingRefused(_))),
        "{suspended:?}"
    );
    // An older plane that sends only the credit view is refused too.
    let ungoverned = hosted_box_auth(
        master,
        "org-ungoverned",
        r#"{"managedInference":true,"remainingBudgetMicroUsd":5000000}"#,
    )
    .await;
    assert!(
        matches!(ungoverned, Err(GatewayError::StandingUnavailable)),
        "{ungoverned:?}"
    );
}

#[tokio::test]
async fn gwb1_hosted_on_the_fleet_carries_the_orgs_abuse_ladder() {
    let master = "gwb1-test-master-ladder-0123456789abcdefg";
    let _master = MasterKeyEnv::set(master).await;
    // The detector restricted the org (org-scope L3): its Box is served under
    // that restriction, exactly as the org's rgw_ keys are.
    let context = hosted_box_auth_in(
        crate::custody::GatewayCustody::Fleet,
        master,
        "org-ladder",
        r#"{"managedInference":true,"remainingBudgetMicroUsd":5000000,"governance":{"policy":{"rules":{}},"standing":{"state":"active","refuses":"none","ladder":[{"scope":"org","level":3,"reasonClass":"platform_abuse","until":"2999-01-01T00:00:00.000Z"}]}}}"#,
    )
    .await
    .unwrap();
    assert!(crate::enforcement::is_restricted(&context));
    assert!(crate::enforcement::refuse_media(&context).is_err());
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
