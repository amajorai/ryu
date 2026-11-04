use super::*;
use crate::config::{AuthConfig, GatewayConfig};
use crate::error::GatewayError;
use crate::pipeline::{authenticate, AuthInputs};
use crate::state::AppState;
use axum::{extract::State, http::HeaderMap, Json};
use std::sync::Arc;

const MASTER: &str = "gwcore-relay-master-0123456789abcdef";
const SHARED_CORE_KEY: &str = "gwcore_shared_static_relay_key_0000";

/// Serializes the tests that set the process-wide relay master env.
static RELAY_MASTER_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

struct RelayMasterEnv {
    previous: Option<String>,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

impl RelayMasterEnv {
    async fn set(value: Option<&str>) -> Self {
        let guard = RELAY_MASTER_ENV_LOCK.lock().await;
        let previous = std::env::var(ENV_CORE_RELAY_MASTER_KEY).ok();
        match value {
            Some(value) => std::env::set_var(ENV_CORE_RELAY_MASTER_KEY, value),
            None => std::env::remove_var(ENV_CORE_RELAY_MASTER_KEY),
        }
        Self {
            previous,
            _guard: guard,
        }
    }
}

impl Drop for RelayMasterEnv {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(ENV_CORE_RELAY_MASTER_KEY, value),
            None => std::env::remove_var(ENV_CORE_RELAY_MASTER_KEY),
        }
    }
}

fn org_key(org: &str) -> String {
    ryu_gw_credentials::derive_org_core_relay_key(MASTER, org).unwrap()
}

/// A fleet Gateway that also keeps a legacy static `local-core` relay.
fn fleet_state() -> Arc<AppState> {
    fleet_state_with(GatewayConfig::default())
}

/// [`fleet_state`] over `base`, whose `auth` is replaced.
fn fleet_state_with(base: GatewayConfig) -> Arc<AppState> {
    let static_core = ApiKeyConfig {
        key: SHARED_CORE_KEY.to_owned(),
        name: "local-core".to_owned(),
        allowed_operations: vec![ApiKeyOperation::Inference],
        org_id: None,
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder: true,
    };
    let auth = AuthConfig {
        require_auth: true,
        master_key: Some("gwadm_fleet_master_key_0123456789".to_owned()),
        api_keys: vec![static_core],
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    Arc::new(AppState::new_for_test(
        GatewayConfig { auth, ..base },
        audit,
        evals,
    ))
}

fn bearer(key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
    headers
}

#[test]
fn an_org_relay_key_binds_its_own_org_only() {
    let entry = org_core_relay_entry_from(Some(MASTER), &org_key("org-a")).unwrap();
    assert_eq!(entry.org_id.as_deref(), Some("org-a"));
    assert!(entry.trusted_forwarder);
    assert_ne!(entry.name, "local-core");
    let forged = org_key("org-a").replace("_org-a", "_org-b");
    assert!(org_core_relay_entry_from(Some(MASTER), &forged).is_none());
    assert!(org_core_relay_entry_from(None, &org_key("org-a")).is_none());
    assert!(
        org_core_relay_entry_from(Some("another-master-0123456789ab"), &org_key("org-a")).is_none()
    );
}

#[tokio::test]
async fn the_fleet_authenticates_an_org_relay_key_as_its_org() {
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state();
    let ctx = authenticate(
        &state,
        AuthInputs {
            raw_api_key: Some(&org_key("org-a")),
            user_id: Some("user-1".to_owned()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(ctx.org_id.as_deref(), Some("org-a"));
    assert_eq!(bound_forwarder_org(&ctx), Some("org-a"));
    assert!(!is_unscoped_trusted(&ctx));
    assert!(require_forwarder_org(&ctx, Some("org-b")).is_err());
    assert!(require_forwarder_org(&ctx, Some("org-a")).is_ok());
    assert!(require_forwarder_org(&ctx, None).is_ok());

    // A relabelled key does not authenticate at all.
    let forged = org_key("org-a").replace("_org-a", "_org-b");
    assert!(matches!(
        authenticate(&state, AuthInputs::with_key(Some(&forged))).await,
        Err(GatewayError::Unauthorized(_))
    ));

    // The static single-org relay stays unscoped.
    let ctx = authenticate(&state, AuthInputs::with_key(Some(SHARED_CORE_KEY)))
        .await
        .unwrap();
    assert!(is_unscoped_trusted(&ctx));
    assert!(require_forwarder_org(&ctx, Some("org-b")).is_ok());
}

#[tokio::test]
async fn without_the_master_an_org_relay_key_is_refused() {
    let _env = RelayMasterEnv::set(None).await;
    let state = fleet_state();
    assert!(matches!(
        authenticate(&state, AuthInputs::with_key(Some(&org_key("org-a")))).await,
        Err(GatewayError::Unauthorized(_))
    ));
}

#[tokio::test]
async fn an_org_relay_key_signs_no_box_or_scoped_inference_credential() {
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state();
    let relay = org_key("org-a");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let box_key = ryu_gw_credentials::BoxInferenceScope {
        org_id: "org-b".to_owned(),
        user_id: Some("victim".to_owned()),
        session_id: "session-1".to_owned(),
        box_id: "bx_0123456789abcdef0123456789abcdef".to_owned(),
        lease_epoch: 1,
        expires_at: now + 600,
    }
    .sign(&relay)
    .unwrap();
    let scoped = ryu_gw_credentials::InferenceScope {
        agent_id: "agent-1".to_owned(),
        user_id: Some("victim".to_owned()),
        session_id: None,
        expires_at: now + 600,
        provider_access: None,
    }
    .sign(&relay)
    .unwrap();
    let api_keys = state.with_auth(|auth| auth.api_keys.clone());
    assert!(
        crate::pipeline::auth_identity::box_governance::verify_local_box(
            &api_keys, &box_key, None, None
        )
        .is_none()
    );
    assert!(matches!(
        crate::pipeline::auth::verify_scoped_inference(&api_keys, &scoped, None, None, None),
        Err(GatewayError::Unauthorized(_))
    ));
    for key in [&box_key, &scoped] {
        assert!(authenticate(&state, AuthInputs::with_key(Some(key)))
            .await
            .is_err());
    }
}

#[tokio::test]
async fn an_org_relay_key_cannot_charge_another_org_or_execute_fleet_tools() {
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state();
    let relay = org_key("org-a");

    let charge: crate::api::budget::ToolChargeBody = serde_json::from_value(serde_json::json!({
        "tool_calls": 1,
        "org_id": "org-b",
        "provider": "composio",
        "cost_micro_usd": 1_000_000,
    }))
    .unwrap();
    assert!(matches!(
        crate::api::budget::charge_tool(State(Arc::clone(&state)), bearer(&relay), Json(charge))
            .await,
        Err(GatewayError::Unauthorized(_))
    ));

    let exec: crate::tools::exec::ExecToolBody = serde_json::from_value(serde_json::json!({
        "kind": "tool",
        "tool_id": "fs.read",
        "agent_id": "agent-1",
    }))
    .unwrap();
    assert!(matches!(
        crate::tools::exec::exec_tool(State(Arc::clone(&state)), bearer(&relay), Json(exec)).await,
        Err(GatewayError::Unauthorized(_))
    ));
}

#[tokio::test]
async fn an_org_relay_key_cannot_bill_another_orgs_sandbox() {
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state();
    let tick = |org: &str| -> crate::api::sandbox::SandboxTickBody {
        serde_json::from_value(serde_json::json!({
            "run_id": format!("run_relay_{}", uuid::Uuid::new_v4().simple()),
            "org_id": org,
            "spec": {"vcpu": 2, "mem_gib": 4, "storage_gib": 40, "gpu": "none", "os": "linux"},
            "elapsed_seconds_delta": 10,
            "tick_index": 0,
        }))
        .unwrap()
    };
    let relay = org_key("org-a");
    assert!(matches!(
        crate::api::sandbox::sandbox_tick(
            State(Arc::clone(&state)),
            bearer(&relay),
            Json(tick("org-b"))
        )
        .await,
        Err(GatewayError::Unauthorized(_))
    ));
    assert!(crate::api::sandbox::sandbox_tick(
        State(Arc::clone(&state)),
        bearer(&relay),
        Json(tick("org-a"))
    )
    .await
    .is_ok());
}

async fn relay_ctx(state: &AppState, key: &str) -> crate::pipeline::RequestContext {
    authenticate(
        state,
        AuthInputs {
            raw_api_key: Some(key),
            agent_id: Some("fleet-agent".to_owned()),
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn an_org_relay_key_is_refused_inference_before_dispatch() {
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state();
    let relay = relay_ctx(&state, &org_key("org-a")).await;
    let body =
        || serde_json::json!({"model": "gpt-4o", "messages": [{"role": "user", "content": "hi"}]});

    // The shared inference admission refuses it, and so does the budget gate.
    assert!(matches!(
        crate::pipeline::admit_request(&state, &relay),
        Err(GatewayError::Unauthorized(_))
    ));
    let mut decision = crate::router::RouteDecision {
        provider: crate::config::ProviderId::from("openai"),
        model: "gpt-4o".to_owned(),
    };
    assert!(matches!(
        crate::pipeline::budget::enforce_budget(
            &state,
            &relay,
            &mut body(),
            &mut decision,
            crate::budget::BudgetChargeKind::Model,
            crate::pipeline::OutputCeiling::Clamp,
        ),
        Err(GatewayError::Unauthorized(_))
    ));
    // Buffered, streamed and embedding requests all stop before any provider.
    assert!(matches!(
        crate::pipeline::run(Arc::clone(&state), relay.clone(), body()).await,
        Err(GatewayError::Unauthorized(_))
    ));
    assert!(matches!(
        crate::pipeline::run_stream(Arc::clone(&state), relay.clone(), body()).await,
        Err(GatewayError::Unauthorized(_))
    ));
    assert!(matches!(
        crate::pipeline::run_embedding(
            Arc::clone(&state),
            relay,
            serde_json::json!({"model": "text-embedding-3-small", "input": "hi"}),
            crate::pipeline::EmbeddingOperation::Embed,
        )
        .await,
        Err(GatewayError::Unauthorized(_))
    ));

    // The operator's own static Core relay is still admitted.
    let local = relay_ctx(&state, SHARED_CORE_KEY).await;
    assert!(crate::pipeline::admit_request(&state, &local).is_ok());
    assert!(!matches!(
        crate::pipeline::run(Arc::clone(&state), local, body()).await,
        Err(GatewayError::Unauthorized(_))
    ));
}

#[tokio::test]
async fn an_org_relay_turn_never_runs_this_gateways_tool_loop() {
    use crate::pipeline::tool_loop_select::{
        effective_tool_allowlist, select_tool_loop, ToolLoopKind,
    };
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state();
    let cfg = crate::config::ToolsConfig::default();
    let hinted = |mut ctx: crate::pipeline::RequestContext, header: bool| {
        ctx.tools_header_present = header;
        ctx.tool_actions = header.then(|| "fs.read".to_owned());
        ctx.capability_hints = Some(r#"{"tools":["fs.read"],"skills":["s"]}"#.to_owned());
        ctx
    };

    let relay = relay_ctx(&state, &org_key("org-a")).await;
    let signaled = hinted(relay.clone(), true);
    assert_eq!(
        select_tool_loop(&signaled, true, true, &cfg, false),
        ToolLoopKind::Plain
    );
    assert_eq!(
        select_tool_loop(&signaled, false, true, &cfg, false),
        ToolLoopKind::Plain
    );
    // No capability-hint grant either.
    assert!(effective_tool_allowlist(&hinted(relay, false), &cfg).is_empty());

    let local = relay_ctx(&state, SHARED_CORE_KEY).await;
    assert_eq!(
        select_tool_loop(&hinted(local.clone(), true), true, true, &cfg, false),
        ToolLoopKind::Unified
    );
    assert!(
        effective_tool_allowlist(&hinted(local, false), &cfg).contains(&"skills.load".to_owned())
    );
}

#[tokio::test]
async fn one_orgs_exec_rows_do_not_exhaust_another_orgs_exec_budget() {
    let _env = RelayMasterEnv::set(Some(MASTER)).await;
    let state = fleet_state_with(GatewayConfig {
        exec_budget: crate::budget::ExecBudgetConfig {
            max_count: 1,
            max_wall_clock_secs: 0,
            window_secs: 3600,
            action: crate::budget::ExecBudgetAction::Stop,
        },
        ..GatewayConfig::default()
    });
    let ingest = |key: String| {
        let state = Arc::clone(&state);
        async move {
            let body = serde_json::from_value(serde_json::json!({
                "backend": "local", "command": "ls", "duration_ms": 10, "exit_code": 0,
            }))
            .unwrap();
            crate::api::audit::ingest_exec_audit(State(state), bearer(&key), Json(body)).await
        }
    };
    let allowed = |key: String| {
        let state = Arc::clone(&state);
        async move {
            let body =
                serde_json::from_value(serde_json::json!({"backend": "local", "command": "ls"}))
                    .unwrap();
            crate::api::audit::check_exec_budget(State(state), bearer(&key), Json(body))
                .await
                .unwrap()
                .0
                .allowed
        }
    };

    assert!(ingest(org_key("org-a")).await.is_ok());
    assert!(!allowed(org_key("org-a")).await);
    assert!(allowed(org_key("org-b")).await);
    assert!(allowed(SHARED_CORE_KEY.to_owned()).await);

    // The operator's own Core still counts against the global window.
    assert!(ingest(SHARED_CORE_KEY.to_owned()).await.is_ok());
    assert!(!allowed(SHARED_CORE_KEY.to_owned()).await);
    assert!(allowed(org_key("org-b")).await);
}
