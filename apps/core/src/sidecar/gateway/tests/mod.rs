#[path = "headroom_policy_runtime_test.rs"]
mod headroom_policy_runtime;
use super::*;

#[test]
fn composio_charges_bill_the_owner_never_an_agent_entity() {
    let body = tool_charge_body(
        Some("org_1"),
        None,
        Some("agent:u1:a1"),
        Some("sess"),
        1,
        None,
        false,
    );
    assert_eq!(body["user_id"], "u1");
    assert_eq!(body["agent_id"], "a1");
    assert_eq!(body["org_id"], "org_1");
    // An explicit agent id is kept, and an ordinary user is unchanged.
    let body = tool_charge_body(None, Some("a2"), Some("agent:u1:a1"), None, 1, None, true);
    assert_eq!(body["user_id"], "u1");
    assert_eq!(body["agent_id"], "a2");
    let body = tool_charge_body(None, Some("a2"), Some("u3"), None, 1, None, false);
    assert_eq!(body["user_id"], "u3");
    assert_eq!(body["agent_id"], "a2");
    let body = tool_charge_body(None, None, None, None, 1, None, false);
    assert!(body["user_id"].is_null());
    assert!(body["agent_id"].is_null());

    let body = composio_authorization_body("org_1", Some("agent:org:u1:agent_x"));
    assert_eq!(body["user_id"], "org:u1");
    assert_eq!(body["authorizeOnly"], true);
    assert!(body.get("agent_id").is_none());
    let body = composio_authorization_body("org_1", Some("u1"));
    assert_eq!(body["user_id"], "u1");
}

#[test]
fn scoped_inference_bearer_is_reused_until_the_remint_margin() {
    let signer = "gwcore_fixture_signing_1234567890";
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let mut cache = InferenceBearerCache::new();
    fn mint(
        cache: &mut InferenceBearerCache,
        signer: &str,
        agent: &str,
        user: Option<&str>,
        session: Option<&str>,
        at: u64,
    ) -> String {
        cached_inference_bearer(cache, signer, agent, user, session, None, at).unwrap()
    }
    let first = mint(
        &mut cache,
        signer,
        "agent-a",
        Some("user-a"),
        Some("conv-a"),
        now,
    );
    assert_eq!(
        first,
        mint(
            &mut cache,
            signer,
            "agent-a",
            Some("user-a"),
            Some("conv-a"),
            now + 1
        )
    );
    assert_eq!(
        first,
        mint(
            &mut cache,
            signer,
            "agent-a",
            Some("user-a"),
            Some("conv-a"),
            now + 25 * 60
        )
    );
    let reused = ryu_gw_credentials::InferenceScope::verify(&first, signer).unwrap();
    assert_eq!(reused.agent_id, "agent-a");
    assert_eq!(reused.session_id.as_deref(), Some("conv-a"));
    assert!(reused.expires_at > now + 25 * 60 + INFERENCE_BEARER_REMINT_MARGIN_SECS);

    // Isolation: any scope component or a rotated signer mints its own bearer.
    for other in [
        mint(
            &mut cache,
            signer,
            "agent-b",
            Some("user-a"),
            Some("conv-a"),
            now + 2,
        ),
        mint(
            &mut cache,
            signer,
            "agent-a",
            Some("user-b"),
            Some("conv-a"),
            now + 2,
        ),
        mint(&mut cache, signer, "agent-a", None, Some("conv-a"), now + 2),
        mint(
            &mut cache,
            signer,
            "agent-a",
            Some("user-a"),
            Some("conv-b"),
            now + 2,
        ),
        mint(&mut cache, signer, "agent-a", Some("user-a"), None, now + 2),
    ] {
        assert_ne!(other, first);
    }
    let rotated = mint(
        &mut cache,
        "gwcore_fixture_rotated_1234567890",
        "agent-a",
        Some("user-a"),
        Some("conv-a"),
        now + 2,
    );
    assert_ne!(rotated, first);
    // A limited agent's provider access is part of the scope: it never
    // reuses the unlimited bearer, and its own bearer carries the list.
    let limited = cached_inference_bearer(
        &mut cache,
        signer,
        "agent-a",
        Some("user-a"),
        Some("conv-a"),
        Some(&["openai".to_owned()]),
        now + 2,
    )
    .unwrap();
    assert_ne!(limited, first);
    let limited_scope = ryu_gw_credentials::InferenceScope::verify(&limited, signer).unwrap();
    assert_eq!(
        limited_scope.provider_access.as_deref(),
        Some(&["openai".to_owned()][..])
    );
    assert!(ryu_gw_credentials::InferenceScope::verify(&rotated, signer).is_err());
    assert!(!cache_key_holds_raw_signer(&cache, signer));

    // Inside the margin the bearer is reminted, with a full lifetime again.
    let reminted = mint(
        &mut cache,
        signer,
        "agent-a",
        Some("user-a"),
        Some("conv-a"),
        now + 31 * 60,
    );
    assert_ne!(reminted, first);
    let scope = ryu_gw_credentials::InferenceScope::verify(&reminted, signer).unwrap();
    assert_eq!(
        scope.expires_at,
        now + 31 * 60 + INFERENCE_BEARER_LIFETIME_SECS
    );
    // Pruning dropped every bearer minted at the start.
    assert!(cache
        .values()
        .all(|(_, expires_at)| *expires_at > now + 3600));
}

fn cache_key_holds_raw_signer(cache: &InferenceBearerCache, signer: &str) -> bool {
    cache.keys().any(|key| key.signer.contains(signer))
}

#[test]
fn remote_inference_preserves_tenant_bearer_and_never_uses_core_fallback() {
    let _lock = lock_credits_env();
    let _env = EnvGuard::capture(&[
        ENV_GATEWAY_REMOTE,
        ENV_GATEWAY_MANAGED,
        ENV_GATEWAY_TOKEN,
        ENV_GATEWAY_CORE_TOKEN,
        ENV_GATEWAY_CORE_PROOF_KEY,
    ]);
    std::env::set_var(ENV_GATEWAY_REMOTE, "1");
    std::env::set_var(ENV_GATEWAY_CORE_TOKEN, "gwcore_fixture_relay_1234567890");
    let tenant = "rgw_fixture_tenant_1234567890123456";
    std::env::set_var(ENV_GATEWAY_TOKEN, tenant);
    std::env::set_var(
        ENV_GATEWAY_CORE_PROOF_KEY,
        "gwproof_fixture_proof_1234567890",
    );
    assert_eq!(required_gateway_inference_token().unwrap(), tenant);
    let proof = gateway_inference_agent_proof(tenant, "agent-a")
        .unwrap()
        .unwrap();
    assert_eq!(
        proof,
        ryu_gw_credentials::sign_agent_route_proof(
            &required_gateway_core_proof_key().unwrap(),
            tenant,
            "agent-a"
        )
        .unwrap()
    );
    std::env::remove_var(ENV_GATEWAY_TOKEN);
    assert!(required_gateway_inference_token().is_err());
    std::env::set_var(ENV_GATEWAY_TOKEN, "bad");
    assert!(required_gateway_inference_token().is_err());
    std::env::set_var(ENV_GATEWAY_REMOTE, "0");
    std::env::set_var(ENV_GATEWAY_MANAGED, "1");
    assert_eq!(
        required_gateway_inference_token().unwrap(),
        required_gateway_core_token().unwrap()
    );
    assert!(gateway_inference_agent_proof("local", "agent-a")
        .unwrap()
        .is_none());
}

#[test]
fn gateway_startup_quarantine_preserves_remote_and_external_routing() {
    let configured = "http://127.0.0.1:8981".to_owned();
    assert_eq!(
        routed_gateway_url(configured.clone(), true, false, true),
        "http://127.0.0.1:0"
    );
    assert_eq!(
        routed_gateway_url(configured.clone(), false, false, true),
        configured
    );
    assert_eq!(
        routed_gateway_url(configured.clone(), true, true, true),
        configured
    );
    assert_eq!(
        routed_gateway_url(configured.clone(), true, false, false),
        configured
    );
}

#[tokio::test]
async fn adopted_listener_applies_revision_and_revalidates_before_releasing_bearers() {
    use axum::{
        body::Body, extract::Request, http::StatusCode, response::IntoResponse, routing::any,
        Router,
    };
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    let _lock = lock_managed_node_env();
    let _gateway_lock = lock_gateway_env();
    let _env = EnvGuard::capture(&[
        ENV_GATEWAY_URL,
        ENV_GATEWAY_TOKEN,
        ENV_GATEWAY_MANAGED,
        ENV_GATEWAY_REMOTE,
        ENV_MANAGED_NODE,
        "GATEWAY_MASTER_KEY",
        "GATEWAY_CONFIG",
        ENV_GATEWAY_ADMIN_KEY,
        ENV_LOCAL_LLM_URL,
    ]);
    struct RejectionReset(bool);
    impl Drop for RejectionReset {
        fn drop(&mut self) {
            REJECTED_LOCAL_GATEWAY.store(self.0, Ordering::Release);
        }
    }
    let _rejection = RejectionReset(REJECTED_LOCAL_GATEWAY.load(Ordering::Acquire));
    std::env::set_var(ENV_GATEWAY_MANAGED, "1");
    std::env::set_var(ENV_GATEWAY_REMOTE, "0");
    std::env::set_var(ENV_MANAGED_NODE, "0");
    std::env::set_var(ENV_LOCAL_LLM_URL, "http://127.0.0.1:1/v1");
    let admin = "gwadmin_adopted_fixture_123456789".to_owned();
    let relay = "gwrelay_adopted_fixture_123456789".to_owned();
    std::env::set_var("GATEWAY_MASTER_KEY", &admin);
    std::env::set_var(ENV_GATEWAY_TOKEN, &relay);
    let core = required_gateway_core_token().unwrap();
    let revision = ryu_gw_credentials::ConfigRevision::parse(&"a".repeat(64)).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let forge = Arc::new(AtomicBool::new(false));
    let bearers = Arc::new(AtomicUsize::new(0));
    let applications = Arc::new(AtomicUsize::new(0));
    let app=Router::new().fallback(any({let forge=Arc::clone(&forge);let bearers=Arc::clone(&bearers);let applications=Arc::clone(&applications);let revision=revision.clone();move |request:Request<Body>| {
        let forge=Arc::clone(&forge);let bearers=Arc::clone(&bearers);let applications=Arc::clone(&applications);let admin=admin.clone();let relay=relay.clone();let core=core.clone();let revision=revision.clone();
        async move {
            let bearer=request.headers().get("authorization").and_then(|header|header.to_str().ok()).unwrap_or_default();
            if !bearer.is_empty(){bearers.fetch_add(1,Ordering::SeqCst);}
            let json=|value:serde_json::Value|axum::Json(value).into_response();
            match request.uri().path() {
                "/health"=>json(serde_json::json!({"status":"ok"})),
                "/v1/auth/readiness"=>{
                    let nonce=request.uri().query().unwrap_or_default().strip_prefix("nonce=").unwrap_or_default();
                    let mut claimed=address;if forge.load(Ordering::SeqCst){claimed.set_port(address.port().saturating_add(1));}
                    let proof=ryu_gw_credentials::ReadinessProof::sign(ryu_gw_credentials::Readiness {protocol:"ryu-gateway-readiness-v1".into(),version:env!("CARGO_PKG_VERSION").into(),nonce:nonce.into(),listener:claimed,require_auth:true,inference_keys:vec![ryu_gw_credentials::fingerprint(&relay)],core_keys:vec![ryu_gw_credentials::fingerprint(&core)]},&admin).unwrap();
                    json(serde_json::to_value(proof).unwrap())
                }
                "/v1/config" if bearer==format!("Bearer {admin}")=>json(serde_json::json!({"auth":{"require_auth":true}})),
                "/v1/auth/status" if bearer==format!("Bearer {relay}") || bearer==format!("Bearer {core}")=>json(serde_json::json!({"admin":false,"trustedForwarder":bearer==format!("Bearer {core}")})),
                "/v1/config/providers/apply" if bearer==format!("Bearer {admin}")=>{applications.fetch_add(1,Ordering::SeqCst);json(serde_json::to_value(ryu_gw_credentials::ProviderApplyOutcome::Applied {requested_revision:revision.clone(),applied_revision:revision,epoch:ryu_gw_credentials::ProviderRuntimeEpoch {boot:uuid::Uuid::new_v4(),sequence:1}}).unwrap())}
                _=>StatusCode::UNAUTHORIZED.into_response(),
            }
        }
    }}));
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    std::env::set_var(ENV_GATEWAY_URL, format!("http://{address}"));
    let manager = GatewayManager::new();
    assert!(manager.start().await.unwrap());
    assert!(!manager.is_running());
    let receipt = manager.apply_provider_revision(&revision).await;
    assert!(matches!(
        receipt,
        ryu_gw_credentials::ProviderApplyOutcome::Applied { .. }
    ));
    assert!(receipt.validates_request(&revision));
    assert_eq!(applications.load(Ordering::SeqCst), 1);
    assert!(!manager.is_running());
    forge.store(true, Ordering::SeqCst);
    let before = bearers.load(Ordering::SeqCst);
    assert!(matches!(
        manager.apply_provider_revision(&revision).await,
        ryu_gw_credentials::ProviderApplyOutcome::Failed {
            code: ryu_gw_credentials::ProviderApplyErrorCode::UnexpectedResponse,
            ..
        }
    ));
    assert_eq!(bearers.load(Ordering::SeqCst), before);
    assert_eq!(applications.load(Ordering::SeqCst), 1);
    assert_eq!(gateway_url(), "http://127.0.0.1:0");
    server.abort();
}

#[test]
fn managed_fleet_precedence_is_environment_then_enrollment_then_manual_preference() {
    let environment = Some((" https://env.example ".into(), " env-token ".into()));
    let enrolled = Some(("https://enrolled.example".into(), "enrolled-token".into()));
    let preference = Some(("https://manual.example".into(), "manual-token".into()));
    assert_eq!(
        select_managed_fleet(environment, enrolled.clone(), preference.clone()),
        Some(("https://env.example".into(), "env-token".into()))
    );
    assert_eq!(
        select_managed_fleet(None, enrolled.clone(), preference.clone()),
        enrolled
    );
    assert_eq!(
        select_managed_fleet(None, None, preference.clone()),
        preference
    );
}

/// One test for the whole `x-ryu-node-routing` encoder, deliberately: the
/// slot is a process-global and cargo runs tests in one process in parallel,
/// so splitting these would make them observe each other's writes.
#[test]
fn node_routing_header_encodes_and_clears() {
    // Default: an untouched node states nothing, so the header is omitted and
    // the request stays byte-identical to before this channel existed.
    set_node_routing_prefs(Vec::new(), None);
    assert_eq!(node_routing_header(), None);

    // Blank-only input is the same as no input — never a `v1.` of nothing.
    set_node_routing_prefs(vec!["  ".into(), String::new()], None);
    assert_eq!(node_routing_header(), None);

    set_node_routing_prefs(
        vec![" anthropic ".into(), "groq".into()],
        Some(serde_json::json!({ "redact_pii": true })),
    );
    let raw = node_routing_header().expect("stated prefs produce a header");
    let encoded = raw
        .strip_prefix("v1.")
        .expect("the version tag is part of the grammar the reader parses");

    use base64::Engine as _;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .expect("base64url, no padding — header-safe by construction");
    let doc: serde_json::Value =
        serde_json::from_slice(&decoded).expect("the payload is compact JSON");
    assert_eq!(doc["fallback"], serde_json::json!(["anthropic", "groq"]));
    assert_eq!(doc["firewall"]["redact_pii"], serde_json::json!(true));

    // The preference-store reader feeds the same carrier and clears a
    // previous value when an edit is malformed rather than leaving stale
    // routing active.
    set_node_routing_prefs_from_json(
        r#"{"fallback":["groq"],"firewall":{"custom_patterns":[]},"openrouter":{"sort":"throughput","allow_fallbacks":true}}"#,
    );
    let encoded = node_routing_header().expect("OpenRouter preferences produce a header");
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded.strip_prefix("v1.").expect("versioned header"))
        .expect("base64url preferences");
    let value: serde_json::Value = serde_json::from_slice(&json).expect("preference JSON");
    assert_eq!(value["openrouter"]["sort"], "throughput");
    assert_eq!(value["openrouter"]["allow_fallbacks"], true);
    set_node_routing_prefs_from_json("not-json");
    assert_eq!(node_routing_header(), None);

    // Clearing is reachable, so a node that retracts its preferences stops
    // sending the header rather than pinning the last value forever.
    set_node_routing_prefs(Vec::new(), None);
    assert_eq!(node_routing_header(), None);
}

#[test]
fn gateway_url_defaults_to_loopback() {
    // The configured default remains stable even while the operational
    // managed endpoint is quarantined pending readiness verification.
    if std::env::var(ENV_GATEWAY_URL).is_err() {
        assert_eq!(
            configured_gateway_url(),
            format!("http://127.0.0.1:{}", crate::profile::port(7981))
        );
    }
}

#[test]
fn bind_extracts_host_port_from_url() {
    // Default URL has an explicit port → host:port preserved.
    let bind = gateway_bind_from_url();
    assert!(
        bind.contains(':'),
        "bind should contain host:port, got {bind}"
    );
}

#[test]
fn explicit_local_llm_url_takes_precedence() {
    // An operator-set LOCAL_LLM_URL must win over the active-engine mapping
    // so a custom/external local server can be targeted.
    let prev = std::env::var(ENV_LOCAL_LLM_URL).ok();
    std::env::set_var(ENV_LOCAL_LLM_URL, "http://example.test:9999/v1");
    assert_eq!(
        local_engine_gateway_url().as_deref(),
        Some("http://example.test:9999/v1")
    );
    match prev {
        Some(v) => std::env::set_var(ENV_LOCAL_LLM_URL, v),
        None => std::env::remove_var(ENV_LOCAL_LLM_URL),
    }
}

#[test]
fn llamacpp_build_tag_version_counts_as_installed() {
    let mut store = crate::sidecar::download_manager::VersionStore::default();
    assert!(!llamacpp_recorded(&store));
    store.record(
        "llamacpp",
        crate::sidecar::providers::llamacpp::downloader::TARGET_VERSION,
        "checksum",
    );
    assert!(
        llamacpp_recorded(&store),
        "a non-semver llama.cpp build tag must still count as installed"
    );
}

#[test]
fn derived_llamacpp_url_requires_verified_sidecar_readiness() {
    let expected = local_engine_url("llamacpp");
    assert_eq!(
        local_engine_gateway_url_with_state(None, Some("llamacpp".to_owned()), true, false,),
        None,
        "a persisted llama.cpp selection must not publish before readiness"
    );
    assert_eq!(
        local_engine_gateway_url_with_state(None, Some("llamacpp".to_owned()), true, true,),
        expected.clone()
    );
    assert_eq!(
        local_engine_gateway_url_with_state(None, None, true, false),
        None,
        "the installed-engine fallback must also wait for readiness"
    );
    assert_eq!(
        local_engine_gateway_url_with_state(None, Some("ollama".to_owned()), true, false),
        local_engine_url("ollama"),
        "other local engines keep their existing URL contract"
    );
    assert_eq!(
        local_engine_gateway_url_with_state(
            Some("http://127.0.0.1:9999/v1".to_owned()),
            Some("llamacpp".to_owned()),
            true,
            false,
        ),
        Some("http://127.0.0.1:9999/v1".to_owned()),
        "an explicit operator endpoint remains authoritative"
    );
}

/// Snapshot + restore a set of env vars so a test that mutates process env
/// does not leak into the others (cargo runs tests in the same process).
struct EnvGuard {
    saved: Vec<(&'static str, Option<String>)>,
}
impl EnvGuard {
    fn capture(names: &[&'static str]) -> Self {
        let saved = names.iter().map(|n| (*n, std::env::var(n).ok())).collect();
        for n in names {
            std::env::remove_var(n);
        }
        Self { saved }
    }
}
impl Drop for EnvGuard {
    fn drop(&mut self) {
        for (n, v) in &self.saved {
            match v {
                Some(val) => std::env::set_var(n, val),
                None => std::env::remove_var(n),
            }
        }
    }
}

/// Serializes the credits tests that mutate process-global env vars. cargo
/// runs tests in one process and in parallel, so without this two of them can
/// race on the same vars between `EnvGuard::capture` and its `Drop` restore.
/// Poison-tolerant: a panicking test must not cascade-fail the rest.
static CREDITS_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn lock_credits_env() -> std::sync::MutexGuard<'static, ()> {
    CREDITS_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

const CREDITS_ENV: &[&str] = &[
    ENV_CREDITS_ENABLED,
    ENV_CREDITS_INTERNAL_SECRET,
    ENV_CREDITS_URL,
    ENV_CREDITS_WALLET_EMPTY_ACTION,
    ENV_CREDITS_COST_PER_TOOL_CALL,
    "RYU_CONTROL_PLANE_URL",
    "RYU_SERVER_URL",
];

#[test]
fn credits_env_absent_when_unconfigured() {
    let _lock = lock_credits_env();
    let _g = EnvGuard::capture(CREDITS_ENV);
    // Nothing set → NOP, no vars injected (graceful degrade preserved).
    assert!(credits_spawn_env().is_empty());
    assert!(!credits_configured());

    // Enabled but no secret → still inert (control plane would reject).
    std::env::set_var(ENV_CREDITS_ENABLED, "true");
    assert!(!credits_configured());
    assert!(credits_spawn_env().is_empty());

    // Secret but not enabled → still inert.
    std::env::remove_var(ENV_CREDITS_ENABLED);
    std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "shh");
    assert!(!credits_configured());
    assert!(credits_spawn_env().is_empty());
}

#[test]
fn credits_env_present_when_configured() {
    let _lock = lock_credits_env();
    let _g = EnvGuard::capture(CREDITS_ENV);
    std::env::set_var(ENV_CREDITS_ENABLED, "1");
    std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "  top-secret  ");
    std::env::set_var("RYU_CONTROL_PLANE_URL", "https://cp.example.test");

    assert!(credits_configured());
    let env = credits_spawn_env();
    let get = |k: &str| {
        env.iter()
            .find(|(name, _)| name == k)
            .map(|(_, v)| v.as_str())
    };

    assert_eq!(get(ENV_CREDITS_ENABLED), Some("true"));
    // Secret trimmed, never echoed elsewhere.
    assert_eq!(get(ENV_CREDITS_INTERNAL_SECRET), Some("top-secret"));
    // Markup pinned to 0 — margin is at deposit (B2).
    assert_eq!(get("GATEWAY_CREDITS_MARKUP_BPS"), Some("0"));
    // Missing billing metadata uses the conservative managed Composio rate.
    assert_eq!(get(ENV_CREDITS_COST_PER_TOOL_CALL), Some("500"));
    // Wallet-empty action defaults to Stop.
    assert_eq!(get(ENV_CREDITS_WALLET_EMPTY_ACTION), Some("stop"));
    // Base derived from the control-plane URL + the `/api` mount.
    assert_eq!(get(ENV_CREDITS_URL), Some("https://cp.example.test/api"));
}

#[test]
fn credits_base_url_resolution() {
    let _lock = lock_credits_env();
    let _g = EnvGuard::capture(CREDITS_ENV);

    // Default local dev when nothing is set.
    assert_eq!(credits_base_url(), "http://127.0.0.1:3000/api");

    // RYU_SERVER_URL is the fallback.
    std::env::set_var("RYU_SERVER_URL", "http://server.test:3000/");
    assert_eq!(credits_base_url(), "http://server.test:3000/api");

    // RYU_CONTROL_PLANE_URL wins over RYU_SERVER_URL.
    std::env::set_var("RYU_CONTROL_PLANE_URL", "http://cp.test:3000");
    assert_eq!(credits_base_url(), "http://cp.test:3000/api");

    // An explicit GATEWAY_CREDITS_URL always wins, and an existing `/api`
    // mount is not doubled.
    std::env::set_var(ENV_CREDITS_URL, "http://explicit.test/api/");
    assert_eq!(credits_base_url(), "http://explicit.test/api");
}

#[test]
fn credits_wallet_empty_action_downgrade_passthrough() {
    let _lock = lock_credits_env();
    let _g = EnvGuard::capture(CREDITS_ENV);
    std::env::set_var(ENV_CREDITS_ENABLED, "yes");
    std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "s");
    std::env::set_var(ENV_CREDITS_WALLET_EMPTY_ACTION, "Downgrade");
    let env = credits_spawn_env();
    let action = env
        .iter()
        .find(|(k, _)| k == ENV_CREDITS_WALLET_EMPTY_ACTION)
        .map(|(_, v)| v.as_str());
    assert_eq!(action, Some("downgrade"));
}

#[test]
fn credits_tool_call_cost_passthrough() {
    // #496: an operator-provisioned per-tool-call (Composio) cost is forwarded
    // verbatim; a non-integer value uses the conservative managed rate.
    let _lock = lock_credits_env();
    let _g = EnvGuard::capture(CREDITS_ENV);
    std::env::set_var(ENV_CREDITS_ENABLED, "1");
    std::env::set_var(ENV_CREDITS_INTERNAL_SECRET, "s");

    std::env::set_var(ENV_CREDITS_COST_PER_TOOL_CALL, "1500");
    let env = credits_spawn_env();
    let cost = env
        .iter()
        .find(|(k, _)| k == ENV_CREDITS_COST_PER_TOOL_CALL)
        .map(|(_, v)| v.as_str());
    assert_eq!(cost, Some("1500"));

    // Garbage uses the safe managed rate, never an invalid or free value.
    std::env::set_var(ENV_CREDITS_COST_PER_TOOL_CALL, "not-a-number");
    let env = credits_spawn_env();
    let cost = env
        .iter()
        .find(|(k, _)| k == ENV_CREDITS_COST_PER_TOOL_CALL)
        .map(|(_, v)| v.as_str());
    assert_eq!(cost, Some("500"));
}

/// Every env name a Ryu or BYOK provider credential can travel under, on
/// Core's own process env (the resolvers' sources) and on the gateway child
/// (what `push_provider_key_env` writes).
const PROVIDER_KEY_SOURCE_ENVS: &[&str] = &[
    "RYU_OPENROUTER_API_KEY",
    "OPENROUTER_API_KEY",
    "RYU_COMPOSIO_API_KEY",
    "COMPOSIO_API_KEY",
    "RYU_REPLICATE_API_KEY",
    "REPLICATE_API_KEY",
    "RYU_FAL_API_KEY",
    "FAL_API_KEY",
    "FAL_KEY",
];
/// The provider-key names the gateway child reads, plus the managed-only
/// OpenRouter routing default that used to ride along with a Ryu key.
const GATEWAY_PROVIDER_KEY_ENVS: &[&str] = &[
    "OPENROUTER_API_KEY",
    "COMPOSIO_API_KEY",
    "REPLICATE_API_KEY",
    "FAL_API_KEY",
    "FAL_KEY",
    "OPENROUTER_DATA_COLLECTION",
];

fn set_provider_key_prefs(value: &str) {
    crate::openrouter_auth::set_key(value);
    crate::composio_auth::set_key(value);
    crate::replicate_auth::set_key(value);
    crate::fal_auth::set_key(value);
}

#[test]
fn managed_node_passes_no_ryu_provider_key_to_the_gateway_child() {
    // D8: a managed node never holds Ryu provider keys. Its managed traffic
    // goes to the hosted fleet gateway with the node's `rgw_` credential, so
    // nothing Core builds for a gateway child may carry a provider key, and
    // the resolvers must not hand out an operator env key either.
    let _managed_lock = super::lock_managed_node_env();
    let _gateway_lock = super::lock_gateway_env();
    let mut guarded = vec![ENV_MANAGED_NODE, ENV_GATEWAY_REMOTE];
    guarded.extend_from_slice(PROVIDER_KEY_SOURCE_ENVS);
    let _g = EnvGuard::capture(&guarded);
    std::env::set_var(ENV_MANAGED_NODE, "1");
    for name in PROVIDER_KEY_SOURCE_ENVS {
        std::env::set_var(name, format!("ryu-operator-{name}"));
    }

    // Env-sourced keys are Ryu's on a managed node: none of them resolve.
    set_provider_key_prefs("");
    assert!(managed_node());
    assert!(
        remote_data_plane(),
        "a managed node is always a remote data plane"
    );
    assert_eq!(crate::openrouter_auth::key(), None);
    assert_eq!(crate::composio_auth::key(), None);
    assert_eq!(crate::replicate_auth::key(), None);
    assert_eq!(crate::fal_auth::key(), None);

    // Even with keys in the preference cache too, the explicit spawn env
    // carries no provider key at all.
    set_provider_key_prefs("tenant-saved-key");
    let env = gateway_spawn_env();
    set_provider_key_prefs("");
    for name in GATEWAY_PROVIDER_KEY_ENVS {
        assert!(
            env.iter().all(|(key, _)| key != name),
            "managed-node gateway spawn env must not carry {name}"
        );
    }
    assert!(
        env.iter()
            .all(|(_, value)| !value.starts_with("ryu-operator-") && value != "tenant-saved-key"),
        "no provider key value may reach the gateway child under any name"
    );

    // The inherited half: a gateway child on a remote plane starts from the
    // scrubbed parent env, which must drop every provider key Core holds.
    let inherited = crate::sidecar::env_scrub::scrub_child_env(std::env::vars(), &[]);
    for name in PROVIDER_KEY_SOURCE_ENVS {
        assert!(
            inherited.iter().all(|(key, _)| key != name),
            "scrubbed child env must not inherit {name}"
        );
    }
}

#[test]
fn self_hosted_gateway_child_keeps_the_users_own_provider_keys() {
    // BYOK on a self-hosted local data plane is unchanged: the user's own
    // saved keys reach the local gateway child, and the env fallback still
    // works for headless self-hosted setups.
    let _managed_lock = super::lock_managed_node_env();
    let _gateway_lock = super::lock_gateway_env();
    let mut guarded = vec![ENV_MANAGED_NODE, ENV_GATEWAY_REMOTE];
    guarded.extend_from_slice(PROVIDER_KEY_SOURCE_ENVS);
    let _g = EnvGuard::capture(&guarded);
    std::env::set_var(ENV_MANAGED_NODE, "0");
    std::env::set_var(ENV_GATEWAY_REMOTE, "0");
    assert!(!remote_data_plane());

    crate::openrouter_auth::set_key("byok-openrouter");
    crate::composio_auth::set_key("byok-composio");
    crate::replicate_auth::set_key("byok-replicate");
    crate::fal_auth::set_key("byok-fal");
    let env = gateway_spawn_env();
    set_provider_key_prefs("");
    let value = |name: &str| {
        env.iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    assert_eq!(value("OPENROUTER_API_KEY"), Some("byok-openrouter"));
    assert_eq!(value("COMPOSIO_API_KEY"), Some("byok-composio"));
    assert_eq!(value("REPLICATE_API_KEY"), Some("byok-replicate"));
    assert_eq!(value("FAL_API_KEY"), Some("byok-fal"));
    // The user's OpenRouter routing is never overridden on a self-hosted node.
    assert_eq!(value("OPENROUTER_DATA_COLLECTION"), None);

    // Headless self-hosted: the env fallback still resolves.
    std::env::set_var("RYU_OPENROUTER_API_KEY", "byok-env-openrouter");
    std::env::set_var("RYU_COMPOSIO_API_KEY", "byok-env-composio");
    assert_eq!(
        crate::openrouter_auth::key().as_deref(),
        Some("byok-env-openrouter")
    );
    assert_eq!(
        crate::composio_auth::key().as_deref(),
        Some("byok-env-composio")
    );
}

#[test]
fn managed_node_defaults_off_and_reads_env() {
    let _lock = super::lock_managed_node_env();
    let _g = EnvGuard::capture(&[ENV_MANAGED_NODE]);
    // Unset → not managed.
    assert!(!managed_node());
    // Truthy values flip it on.
    for v in ["1", "true", "yes", "YES", " True "] {
        std::env::set_var(ENV_MANAGED_NODE, v);
        assert!(managed_node(), "{v:?} should be managed");
    }
    // Anything else stays off.
    std::env::set_var(ENV_MANAGED_NODE, "0");
    assert!(!managed_node());
}

#[test]
fn unmanaged_gateway_requires_an_explicit_relay_token() {
    // Manifest sidecars receive the Gateway relay credential at spawn. An
    // externally managed/remote Gateway must therefore fail closed when the
    // operator omitted that credential, while a validated token is accepted.
    // Serialize both env domains because `remote_data_plane()` also reads the
    // managed-node flag.
    let _managed_lock = super::lock_managed_node_env();
    let _gateway_lock = super::lock_gateway_env();
    let _g = EnvGuard::capture(&[
        ENV_GATEWAY_MANAGED,
        ENV_GATEWAY_REMOTE,
        ENV_MANAGED_NODE,
        ENV_GATEWAY_TOKEN,
    ]);
    std::env::set_var(ENV_GATEWAY_MANAGED, "0");
    std::env::set_var(ENV_GATEWAY_REMOTE, "0");
    std::env::set_var(ENV_MANAGED_NODE, "0");

    let err = gateway_bearer().expect_err("unmanaged Gateway must require a token");
    assert!(
        err.to_string().contains("requires RYU_GATEWAY_TOKEN"),
        "unexpected error: {err}"
    );

    let token = "gwrelay_gateway-test-token-20260917-please-do-not-use-outside-tests";
    std::env::set_var(ENV_GATEWAY_TOKEN, token);
    assert_eq!(gateway_bearer().expect("validated relay token"), token);
}

/// #447: the four gateway/sandbox policy plugins (compression / firewall /
/// routing / sandbox) round-trip through their on/off flag into the surface
/// the gateway actually reads. Three are gateway-spawn-env policies, so they
/// must appear in `gateway_spawn_env` when ON and vanish when OFF; the fourth
/// (sandbox) is Core-local, so it round-trips through `sandbox::is_enabled()`,
/// NOT the gateway env. This is the test that lets #447 close: every policy
/// `apply_policy` flips is observable end-to-end.
#[test]
fn policy_flags_roundtrip_into_their_surface() {
    // These flip the process-global policy atomics (firewall / routing /
    // headroom / sandbox); serialize against every other test that reads or
    // writes them, and restore each to its prior value on exit.
    let _flags = crate::sidecar::gateway_policy::lock_policy_flags();
    let prev_firewall = crate::sidecar::gateway_policy::firewall_enabled();
    let prev_routing = crate::sidecar::gateway_policy::routing_enabled();
    let prev_headroom = crate::sidecar::headroom::is_enabled();
    let prev_sandbox = crate::sidecar::mcp::sandbox::is_enabled();
    // The three gateway-env policies. Capture their dev-seed env so a stray
    // GATEWAY_* in the runner does not skew the OFF assertions.
    let _g = EnvGuard::capture(&[
        "GATEWAY_FIREWALL_ENABLED",
        "GATEWAY_SMART_ROUTING_ENABLED",
        "RYU_HEADROOM_ENABLED",
        "GATEWAY_COMPRESSION_ENABLED",
        // Sandbox toggles via this env var; restore it so the test leaves no
        // residue (cargo runs all tests in one process).
        "RYU_SANDBOX_DISABLED",
    ]);
    let has = |env: &[(String, String)], key: &str| env.iter().any(|(k, _)| k == key);

    // ── ON: flip every flag the way apply_policy does, assert it lands. ──
    crate::sidecar::gateway_policy::set_firewall_enabled(true);
    crate::sidecar::gateway_policy::set_routing_enabled(true);
    crate::sidecar::headroom::set_enabled(true);
    crate::sidecar::mcp::sandbox::set_enabled(true);

    let env_on = gateway_spawn_env();
    assert!(
        has(&env_on, "GATEWAY_FIREWALL_ENABLED"),
        "firewall policy ON must inject GATEWAY_FIREWALL_ENABLED"
    );
    assert!(
        has(&env_on, "GATEWAY_SMART_ROUTING_ENABLED"),
        "routing policy ON must inject GATEWAY_SMART_ROUTING_ENABLED"
    );
    assert!(
        has(&env_on, "GATEWAY_COMPRESSION_ENABLED"),
        "compression policy ON must inject GATEWAY_COMPRESSION_ENABLED"
    );
    // Sandbox is Core-local — it round-trips through is_enabled, not the env.
    assert!(
        crate::sidecar::mcp::sandbox::is_enabled(),
        "sandbox policy ON must flip sandbox::is_enabled()"
    );

    // ── OFF: every flag back down, every surface clears. ──
    crate::sidecar::gateway_policy::set_firewall_enabled(false);
    crate::sidecar::gateway_policy::set_routing_enabled(false);
    crate::sidecar::headroom::set_enabled(false);
    crate::sidecar::mcp::sandbox::set_enabled(false);

    let env_off = gateway_spawn_env();
    assert!(
        !has(&env_off, "GATEWAY_FIREWALL_ENABLED"),
        "firewall OFF must not inject the env"
    );
    assert!(
        !has(&env_off, "GATEWAY_SMART_ROUTING_ENABLED"),
        "routing OFF must not inject the env"
    );
    assert!(
        !has(&env_off, "GATEWAY_COMPRESSION_ENABLED"),
        "compression OFF must not inject the env"
    );
    assert!(
        !crate::sidecar::mcp::sandbox::is_enabled(),
        "sandbox OFF must flip sandbox::is_enabled() back"
    );

    // Restore the flags to their prior values so this test leaves no residue.
    crate::sidecar::gateway_policy::set_firewall_enabled(prev_firewall);
    crate::sidecar::gateway_policy::set_routing_enabled(prev_routing);
    crate::sidecar::headroom::set_enabled(prev_headroom);
    crate::sidecar::mcp::sandbox::set_enabled(prev_sandbox);
}

// ── Classify tier (llamacpp-classify) ───────────────────────────────────

/// The gateway can only register the `classify` provider if Core tells it where
/// the tier lives, and it must be told UNCONDITIONALLY: the spawn env is
/// computed once, so gating on install state would hide a later-installed
/// classifier until a respawn.
#[test]
fn spawn_env_always_publishes_the_classify_tier_url() {
    // Two locks, both required: `lock_policy_flags` because `gateway_spawn_env`
    // folds the policy atomics in, and the crate-wide gateway-env lock because
    // this asserts an exact URL *value* — a stricter contract on process-global
    // env than the presence-only policy test above, and `RYU_CLASSIFY_LLM_URL`
    // is a gateway env var this module owns.
    let _flags = crate::sidecar::gateway_policy::lock_policy_flags();
    let _env = super::lock_gateway_env();
    let _g = EnvGuard::capture(&["RYU_CLASSIFY_LLM_URL"]);
    let env = gateway_spawn_env();
    let url = env
        .iter()
        .find(|(k, _)| k == "RYU_CLASSIFY_LLM_URL")
        .map(|(_, v)| v.clone())
        .expect("gateway spawn env must always carry RYU_CLASSIFY_LLM_URL");
    // Profile-aware loopback port + the OpenAI-compatible `/v1` suffix the
    // gateway's provider base URLs expect.
    assert_eq!(
        url,
        format!(
            "http://127.0.0.1:{}/v1",
            crate::sidecar::providers::llamacpp::classify::classify_port()
        )
    );
    // And it must NOT be the resident chat engine's URL — pointing the classify
    // tier at `local` is exactly the bug this unit fixes.
    assert!(!url.contains(&format!(":{}/", crate::profile::port(8080))));
    // The URL alone is not enough: the gateway also needs the resolved model ID,
    // or its inspector default stays an independent literal and a registry swap
    // produces an unroutable config.
    let model = env
        .iter()
        .find(|(k, _)| k == "RYU_CLASSIFY_MODEL_ID")
        .map(|(_, v)| v.clone())
        .expect("gateway spawn env must carry RYU_CLASSIFY_MODEL_ID beside the URL");
    // It must be the id the SIDECAR serves, resolved from the same registry entry
    // that picks its GGUF — not a second literal, which is the whole bug.
    assert_eq!(
        model,
        crate::registry::ModelRegistry::from_env()
            .local_classifier_model
            .id
    );
    assert!(!model.trim().is_empty(), "a blank id would break the seed");
    // And Core's start predicate must agree with what it published, or Core
    // starts a tier for one id while the gateway routes another.
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "firewall": { "inspector": { "enabled": true, "model": model } } }),
        &model
    ));
}

// ── Node screener (decision model, llamacpp-guard) ──────────────────────

const SCREENER_ENV: &[&str] = &[
    "RYU_NODE_SCREENER",
    "RYU_SCREENER_DECISION_URL",
    "RYU_SCREENER_DECISION_MODEL",
    "RYU_SCREENER_DECISION_SHA256",
    "RYU_SCREENER_GUARD_URL",
    "RYU_SCREENER_GUARD_MODEL",
    "RYU_SCREENER_GUARD_SHA256",
];

/// Off by default: a node that never opted in publishes no screener
/// endpoint, so its Gateway has nothing to build a backend from.
#[test]
fn spawn_env_publishes_no_screener_endpoint_by_default() {
    let _flags = crate::sidecar::gateway_policy::lock_policy_flags();
    let _env = super::lock_gateway_env();
    let _g = EnvGuard::capture(SCREENER_ENV);
    let env = gateway_spawn_env();
    let published: Vec<&str> = env
        .iter()
        .map(|(k, _)| k.as_str())
        .filter(|k| k.starts_with("RYU_SCREENER_"))
        .collect();
    assert!(published.is_empty(), "{published:?}");
}

/// Opted in to both kinds: the decision model on the reserved loopback
/// port with the operator's hash, and Core's own guard sidecar with the
/// id and hash of the weights it serves.
#[test]
fn spawn_env_publishes_the_opted_in_screener_endpoints() {
    let _flags = crate::sidecar::gateway_policy::lock_policy_flags();
    let _env = super::lock_gateway_env();
    let _g = EnvGuard::capture(SCREENER_ENV);
    let sha = "a".repeat(64);
    std::env::set_var("RYU_NODE_SCREENER", "decision,guard");
    std::env::set_var("RYU_SCREENER_DECISION_SHA256", &sha);
    let env = gateway_spawn_env();
    let get = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
    assert_eq!(
        get("RYU_SCREENER_DECISION_URL"),
        Some(format!(
            "http://127.0.0.1:{}/v1/systemone",
            crate::profile::port(crate::sidecar::node_screener::DECISION_SCREENER_PORT_BASE)
        ))
    );
    assert_eq!(get("RYU_SCREENER_DECISION_MODEL").as_deref(), Some("laya"));
    assert_eq!(get("RYU_SCREENER_DECISION_SHA256"), Some(sha));
    assert_eq!(
        get("RYU_SCREENER_GUARD_URL"),
        Some(format!(
            "http://127.0.0.1:{}/v1",
            crate::sidecar::providers::llamacpp::guard::guard_port()
        ))
    );
    let guard = crate::registry::local_guard_model();
    assert_eq!(get("RYU_SCREENER_GUARD_MODEL"), Some(guard.id));
    assert_eq!(
        get("RYU_SCREENER_GUARD_SHA256"),
        Some(guard.sha256.to_ascii_lowercase())
    );
    // The guard tier is never the classify tier or the chat engine.
    let guard_url = get("RYU_SCREENER_GUARD_URL").unwrap_or_default();
    assert_ne!(Some(guard_url.clone()), get("RYU_CLASSIFY_LLM_URL"));
    assert!(!guard_url.contains(&format!(":{}/", crate::profile::port(8080))));
}

#[test]
fn spawn_env_pins_audit_store_to_the_active_core_data_dir() {
    let _env = super::lock_gateway_env();
    let env = gateway_spawn_env();
    let path = env
        .iter()
        .find(|(key, _)| key == "RYU_AUDIT_DB_PATH")
        .map(|(_, value)| value.as_str())
        .expect("gateway spawn env must carry the active audit path");
    assert_eq!(path, crate::paths::db_path("audit.db").to_string_lossy());
    let data_dir = env
        .iter()
        .find(|(key, _)| key == "RYU_DIR")
        .map(|(_, value)| value.as_str())
        .expect("gateway spawn env must carry the active data dir");
    assert_eq!(data_dir, crate::paths::ryu_dir().to_string_lossy());
}

/// Every value `env` carries for `key`. The spawn env is applied in order, so
/// the privacy cases assert the whole list: a later entry could otherwise
/// contradict the first one they found.
fn spawn_env_values<'a>(env: &'a [(String, String)], key: &str) -> Vec<&'a str> {
    env.iter()
        .filter(|(name, _)| name == key)
        .map(|(_, value)| value.as_str())
        .collect()
}

/// Consent off means no content leaves: the child is told, explicitly, that
/// export is off and content is metadata-only, whatever the operator's
/// inherited environment or the user's stored content choice says, and it is
/// handed neither the destination nor its credentials.
#[test]
fn spawn_env_consent_off_forces_metadata_only_and_withholds_the_endpoint() {
    use crate::privacy::ContentMode;
    let _telemetry = crate::telemetry::TestStateGuard::acquire();
    let _env = super::lock_gateway_env();
    let endpoint = crate::telemetry::seed_otlp_endpoint_for_test("https://otlp.spawn-env.test");
    // Everything asks for content, except the consent that gates it.
    std::env::set_var(crate::privacy::DIAGNOSTICS_CONTENT_MODE_ENV, "content");
    std::env::set_var(crate::privacy::DIAGNOSTICS_MAX_CONTENT_BYTES_ENV, "4096");
    crate::telemetry::set_content_mode(ContentMode::Content);
    crate::telemetry::set_max_content_bytes(2048);
    crate::telemetry::set_export_consent(false);
    assert!(!crate::telemetry::is_export_consented());
    assert_eq!(crate::telemetry::content_mode(), ContentMode::Content);

    let env = gateway_spawn_env();
    assert_eq!(
        spawn_env_values(&env, "RYU_DIAGNOSTICS_EXPORT_ENABLED"),
        ["0"]
    );
    assert_eq!(
        spawn_env_values(&env, crate::privacy::DIAGNOSTICS_CONTENT_MODE_ENV),
        [ContentMode::MetadataOnly.as_str()]
    );
    for withheld in [
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        crate::telemetry::OTLP_HEADERS_ENV,
        "OTEL_SEMCONV_STABILITY_OPT_IN",
        crate::privacy::DIAGNOSTICS_MAX_CONTENT_BYTES_ENV,
    ] {
        assert_eq!(
            spawn_env_values(&env, withheld),
            Vec::<&str>::new(),
            "{withheld} must not reach a Gateway without export consent"
        );
    }
    assert!(
        env.iter().all(|(_, value)| value != &endpoint),
        "the OTLP destination must not appear under any name"
    );
}

/// With consent and a destination the Gateway receives the live settings:
/// the destination, the user's current content mode (not an inherited env
/// value) and the current byte cap.
#[test]
fn spawn_env_consent_on_forwards_endpoint_current_mode_and_cap() {
    use crate::privacy::ContentMode;
    let _telemetry = crate::telemetry::TestStateGuard::acquire();
    let _env = super::lock_gateway_env();
    let endpoint = crate::telemetry::seed_otlp_endpoint_for_test("https://otlp.spawn-env.test");
    // The inherited env disagrees with the user's settings in both cases
    // below, so a value read from the environment would fail them.
    std::env::set_var(crate::privacy::DIAGNOSTICS_CONTENT_MODE_ENV, "content");
    std::env::set_var(crate::privacy::DIAGNOSTICS_MAX_CONTENT_BYTES_ENV, "4096");
    crate::telemetry::set_export_consent(true);
    assert!(
        crate::telemetry::is_export_consented(),
        "an active endpoint lets the consent toggle take effect"
    );

    crate::telemetry::set_content_mode(ContentMode::Content);
    crate::telemetry::set_max_content_bytes(2048);
    let env = gateway_spawn_env();
    assert_eq!(
        spawn_env_values(&env, "RYU_DIAGNOSTICS_EXPORT_ENABLED"),
        ["1"]
    );
    assert_eq!(
        spawn_env_values(&env, "OTEL_EXPORTER_OTLP_ENDPOINT"),
        [endpoint.as_str()]
    );
    assert_eq!(
        spawn_env_values(&env, "OTEL_SEMCONV_STABILITY_OPT_IN"),
        ["gen_ai_latest_experimental"]
    );
    assert_eq!(
        spawn_env_values(&env, crate::privacy::DIAGNOSTICS_CONTENT_MODE_ENV),
        ["content"]
    );
    assert_eq!(
        spawn_env_values(&env, crate::privacy::DIAGNOSTICS_MAX_CONTENT_BYTES_ENV),
        ["2048"]
    );

    crate::telemetry::set_content_mode(ContentMode::MetadataOnly);
    crate::telemetry::set_max_content_bytes(crate::privacy::DEFAULT_DIAGNOSTICS_MAX_CONTENT_BYTES);
    let env = gateway_spawn_env();
    assert_eq!(
        spawn_env_values(&env, "RYU_DIAGNOSTICS_EXPORT_ENABLED"),
        ["1"]
    );
    assert_eq!(
        spawn_env_values(&env, crate::privacy::DIAGNOSTICS_CONTENT_MODE_ENV),
        ["metadata_only"]
    );
    assert_eq!(
        spawn_env_values(&env, crate::privacy::DIAGNOSTICS_MAX_CONTENT_BYTES_ENV),
        ["750000"]
    );
}

/// An externally managed Gateway may lack the sealing key, so Core refuses
/// to seal a new secret for it until the operator hands the key over.
#[test]
fn external_gateway_needs_a_key_handoff_before_core_seals() {
    assert!(super::external_seal_decision(true, false, false).is_ok());
    assert!(super::external_seal_decision(false, true, false).is_ok());
    assert!(super::external_seal_decision(false, false, true).is_ok());
    let refused = super::external_seal_decision(false, false, false).unwrap_err();
    assert!(refused.contains("ryu-core gateway-seal-env"));
    assert!(refused.contains("RYU_GATEWAY_MANAGED=0"));
}

/// The Gateway gets its own component subkey for `gateway.toml` secrets,
/// never the master key.
#[test]
fn spawn_env_delivers_the_gateway_subkey_not_the_master_key() {
    let _env = super::lock_gateway_env();
    crate::server::gateway_seal_test_key();
    let env = gateway_spawn_env();
    let scope = env
        .iter()
        .find(|(key, _)| key == ryu_crypto::SEAL_SCOPE_ENV)
        .map(|(_, value)| value.as_str());
    assert_eq!(scope, Some("component:gateway"));
    let subkey = env
        .iter()
        .find(|(key, _)| key == ryu_crypto::SEAL_KEY_ENV)
        .map(|(_, value)| value.clone())
        .expect("gateway spawn env must carry the sealing subkey");
    assert!(!env.iter().any(|(key, _)| key == "RYU_MASTER_KEY"));
    assert_ne!(
        Some(subkey.as_str()),
        std::env::var("RYU_MASTER_KEY").ok().as_deref()
    );
}

/// An operator-set `RYU_CLASSIFY_LLM_URL` points the tier at an external small
/// model and must win over the built-in loopback default.
#[test]
fn explicit_classify_url_env_wins() {
    // Same lock as the test above — these two are the only writers of
    // `RYU_CLASSIFY_LLM_URL`, so they must serialize against each other.
    let _env = super::lock_gateway_env();
    let _g = EnvGuard::capture(&["RYU_CLASSIFY_LLM_URL"]);
    std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://example.test:1234/v1");
    assert_eq!(classify_gateway_url(), "http://example.test:1234/v1");
}

/// The composition `maybe_start_classify_tier`'s second spend gate performs: an
/// operator who repoints the tier at an EXTERNAL small model must not still pay for
/// a local 300-400 MB llama-server nobody dials.
///
/// This is only sound because the gateway obeys the variable over its own
/// `[providers.classify]` (`apps/gateway/src/config.rs`, env-wins); the
/// `cores_published_classify_url_wins_the_file_table` test in that crate is the
/// other half. Asserted through the real `classify_gateway_url` rather than a
/// literal, so a change to how Core resolves the URL breaks this too.
#[test]
fn external_classify_url_blocks_the_local_lazy_start() {
    let _env = super::lock_gateway_env();
    let _g = EnvGuard::capture(&["RYU_CLASSIFY_LLM_URL"]);

    std::env::set_var(
        "RYU_CLASSIFY_LLM_URL",
        "http://small-model.internal:9999/v1",
    );
    assert!(
        !url_targets_this_machine(&classify_gateway_url()),
        "an external classify endpoint must not spend local RAM on a tier it \
             replaced"
    );

    // A loopback override is still local: the operator swapped the port, not the box.
    std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://127.0.0.1:18083/v1");
    assert!(url_targets_this_machine(&classify_gateway_url()));

    // …and the computed default (no override) is loopback by construction, so the
    // ordinary node is unaffected by the gate.
    std::env::remove_var("RYU_CLASSIFY_LLM_URL");
    assert!(
        url_targets_this_machine(&classify_gateway_url()),
        "the default must still start the tier — a gate that blocked the common \
             case would silently disable the guardrail everywhere"
    );
}

/// The half-configuration detector, over the four states it has to separate.
///
/// Pure, so no env and no registry: `(url, id)` in, verdict out. The loopback row
/// is the one that matters most — an ordinary node must never be told its default
/// configuration is suspect.
#[test]
fn a_repointed_classify_url_with_the_default_model_id_is_half_configured() {
    let default_id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;

    // Repointed endpoint, id left at the registry default: the gateway will ask
    // that endpoint for OUR id. Indistinguishable from a misconfiguration.
    assert!(half_configured_external_classify_tier(
        "http://small-model.internal:9999/v1",
        default_id
    ));
    // Whitespace must not smuggle the default id past the comparison — the
    // gateway seeds its route from a trimmed id.
    assert!(half_configured_external_classify_tier(
        "http://small-model.internal:9999/v1",
        &format!("  {default_id}  ")
    ));
    // Both halves moved: a deliberate, complete external tier. Silence is correct.
    assert!(!half_configured_external_classify_tier(
        "http://small-model.internal:9999/v1",
        "some-other-tiny-model"
    ));
    // Local target — the ordinary node, and a loopback port swap. The tier gets
    // started, so there is nothing to warn about in either.
    assert!(!half_configured_external_classify_tier(
        &format!(
            "http://127.0.0.1:{}/v1",
            crate::sidecar::providers::llamacpp::classify::classify_port()
        ),
        default_id
    ));
    assert!(!half_configured_external_classify_tier(
        "http://localhost:18083/v1",
        default_id
    ));
    // An unparseable override cannot be proven local either, so it lands in the
    // same reported bucket. Documented on the predicate rather than special-cased:
    // it is also a misconfiguration.
    assert!(half_configured_external_classify_tier(
        "not a url",
        default_id
    ));
}

/// The regression this pairs with: spend gate 2 must not log a half-configuration
/// past at `debug!`.
///
/// Gate 2 stopped the local sidecar from accidentally answering for the registry
/// id at a repointed endpoint. That was the ONLY thing making the half-configured
/// state visible, and `/api/sidecar/status` reports the skipped tier exactly like a
/// lazy tier nobody has needed yet. So the skip has to leave a queryable record —
/// which this drives through the real `maybe_start_classify_tier`, not through the
/// predicate, because the recording is the behaviour under test.
#[test]
fn a_half_configured_classify_tier_records_why_the_start_was_skipped() {
    use crate::sidecar::providers::llamacpp::classify as classify_sidecar;

    // Both globals: the env (this reads `RYU_CLASSIFY_LLM_URL` + `RYU_GATEWAY_URL`)
    // and the record itself, whose other test writer lives in `classify.rs`.
    let _env = super::lock_gateway_env();
    let _rec = classify_sidecar::lock_lazy_start_record();
    let _g = EnvGuard::capture(&["RYU_CLASSIFY_LLM_URL", "RYU_GATEWAY_URL"]);

    // Gate 1 must pass, or gate 2 is never reached: keep the gateway on this box.
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:8088");
    // A patch that genuinely selects the tier (inspector on, naming the classify
    // model), so the skip below is the gate's decision and not the predicate's.
    let patch = serde_json::json!({
        "firewall": { "inspector": { "enabled": true, "model": classify_model_id() } }
    });

    classify_sidecar::clear_lazy_start_failure_for_test();
    std::env::set_var(
        "RYU_CLASSIFY_LLM_URL",
        "http://small-model.internal:9999/v1",
    );
    maybe_start_classify_tier(&patch);
    let recorded = classify_sidecar::lazy_start_failure_reason_for_test()
        .expect("a half-configured external tier must leave a reason behind");
    // The reason has to name both halves and the fix, or it is just another
    // "something is wrong" line.
    assert!(recorded.contains("http://small-model.internal:9999/v1"));
    assert!(recorded.contains(&classify_model_id()));
    assert!(recorded.contains("RYU_LOCAL_CLASSIFIER_MODEL_ID"));

    // The ordinary node must stay quiet: a local target is not a skip at all, so
    // nothing is recorded (the start itself then no-ops in a test process, which
    // has no registered sidecar manager). Asserted against a freshly cleared slot
    // so it cannot pass on the previous write.
    //
    // The other quiet case — a fully configured EXTERNAL tier — is covered by
    // `a_repointed_classify_url_with_the_default_model_id_is_half_configured`
    // rather than here, deliberately: driving it needs
    // `RYU_LOCAL_CLASSIFIER_MODEL_ID`, whose only serializing lock is private to
    // `registry::tests`, so setting it here would race that module's own
    // override test in the shared test process.
    classify_sidecar::clear_lazy_start_failure_for_test();
    std::env::set_var("RYU_CLASSIFY_LLM_URL", "http://127.0.0.1:18083/v1");
    maybe_start_classify_tier(&patch);
    assert_eq!(
        classify_sidecar::lazy_start_failure_reason_for_test(),
        None,
        "a local classify target is not a skip and must not be reported as one"
    );

    // Leave the slot as we found it for whatever runs next.
    classify_sidecar::clear_lazy_start_failure_for_test();
}

/// The lazy-start predicate must fire for ALL THREE consumers of the classify
/// tier and for both ways of naming it (the configured id, and the router's
/// builtin `gemma-3-270m` prefix — matched case-insensitively, mirroring
/// `RoutingTables::route`) — and only when that consumer is switched ON.
#[test]
fn classify_predicate_fires_for_every_enabled_consumer() {
    let id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;

    // 1. Firewall inspector selection, inspector enabled.
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "firewall": { "enabled": true, "inspector": { "enabled": true, "model": id } } }),
        id
    ));
    // The inspector is independent of the OUTER firewall switch (`pipeline` gates
    // it on `inspector.enabled` alone), so an armed inspector inside a disarmed
    // firewall still fires — requiring `firewall.enabled` would be a miss.
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "firewall": { "enabled": false, "inspector": { "enabled": true, "model": id } } }),
        id
    ));
    // 2. Smart-routing classifier selection — the exact patch shape
    // `build_routing_patch` produces (top-level `routing` → `smart_routing`).
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "routing": { "smart_routing": { "enabled": true, "classifier_model": id } } }),
        id
    ));
    // Prefix + case: the router lowercases before matching builtin prefixes, so
    // Core must too or it would decline to start a tier the gateway will use.
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "routing": { "smart_routing": { "enabled": true, "classifier_model": "GEMMA-3-270M-IT" } } }),
        id
    ));
    // 3. An LLM-judge evaluator binding borrows `inspector.model` REGARDLESS of
    // `inspector.enabled`, so an enabled binding is its own arm. Without it, the
    // feature gate would leave judge users with a permanently cold tier.
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "firewall": {
            "inspector": { "enabled": false, "model": id },
            "evaluators": [{ "id": "toxicity", "enabled": true }],
        } }),
        id
    ));
    // A custom (registry-swapped) classifier id with no gemma prefix still fires,
    // because the predicate also matches the configured id itself.
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "firewall": { "inspector": { "enabled": true, "model": " my-tiny-classifier " } } }),
        "my-tiny-classifier"
    ));
}

/// The blank/absent-model contract for BOTH fields that can name the classify
/// tier. Pinned here because neither is true by anything in this crate: both hold
/// only by virtue of a serde attribute in `apps/gateway/src/config.rs` that runs
/// in another PROCESS, downstream of this predicate.
///
/// * `InspectorConfig::model` → `deserialize_with = de_inspector_model`, which
///   maps a blank to `classify_model_id()`, plus a field default and a manual
///   `Default` impl that both fill the same id. Blank therefore MEANS "the
///   classify tier" — so declining here (what the code did before) is what left
///   the guardrail silently dead for a user who followed the dialog's own advice
///   to leave the box empty.
/// * `SmartRoutingConfig::classifier_model` → the SAME pair as of the P1-2 fix
///   (`default = "default_classifier_model"`, `deserialize_with =
///   "de_classifier_model"`). It used to be a plain `#[serde(default)] String`
///   documented "Empty ⇒ smart routing is inert", and this test used to assert
///   the OPPOSITE for it.
///
/// **The assertion flipped, and that is the point of the rename.** While the
/// field resolved blanks and this arm did not, Core declined to start the tier
/// and the gateway dialled it anyway — connection refused, fail open, nothing
/// warned. Identical in shape to the inspector bug above, reintroduced through
/// the other field. A green test asserting the old rationale is what would have
/// hidden it, so the rationale is pinned to the CURRENT serde attributes and
/// fails loudly if either field stops resolving.
#[test]
fn a_blank_model_on_either_field_selects_the_classify_tier() {
    let id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;

    for blank in ["", "   "] {
        // The shape that reaches `PUT /api/gateway/config` from any client that
        // does not pre-resolve the field: the inspector switched on with the
        // Model box left empty. (The current desktop resolves it client-side in
        // `withResolvedInspectorModels`; this endpoint is a generic proxy, so
        // Core cannot depend on that.)
        assert!(
            patch_selects_classify_tier(
                &serde_json::json!({ "firewall": {
                    "enabled": true,
                    "inspector": { "enabled": true, "model": blank },
                } }),
                id
            ),
            "a blank inspector model ({blank:?}) resolves to the classify id in the \
                 gateway, so Core must start the tier"
        );
        // …and now the same rule, not the mirror of it: `de_classifier_model`
        // resolves this blank to the classify id too, so declining here would
        // leave the gateway dialling a tier Core never started.
        assert!(
            patch_selects_classify_tier(
                &serde_json::json!({ "routing": {
                    "smart_routing": { "enabled": true, "classifier_model": blank },
                } }),
                id
            ),
            "a blank classifier_model ({blank:?}) resolves to the classify id in the \
                 gateway, so Core must start the tier"
        );
    }

    // An ABSENT `classifier_model` inside a PRESENT, ENABLED `smart_routing` hits
    // `#[serde(default = "default_classifier_model")]` — the same resolved id.
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "routing": { "smart_routing": { "enabled": true } } }),
        id
    ));
    // The feature gate still holds: smart routing that this patch does not switch
    // ON never arms, however its model reads. This is what keeps the widening from
    // reopening the spawn-on-every-routing-push regression.
    assert!(!patch_selects_classify_tier(
        &serde_json::json!({ "routing": {
            "smart_routing": { "enabled": false, "classifier_model": "" },
        } }),
        id
    ));

    // An ABSENT `model` inside a PRESENT `inspector` hits
    // `#[serde(default = "default_inspector_model")]` — same resolved id.
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "firewall": { "inspector": { "enabled": true } } }),
        id
    ));
    // An absent `inspector` OBJECT resolves through `FirewallConfig`'s
    // `#[serde(default)] pub inspector` → the manual `Default for InspectorConfig`,
    // which also fills the classify id. So a judge binding still gets the tier
    // even when the patch names no inspector at all.
    assert!(patch_selects_classify_tier(
        &serde_json::json!({ "firewall": {
            "evaluators": [{ "id": "llm_as_a_judge", "enabled": true }],
        } }),
        id
    ));
    // A non-string `model` is NOT a selection: `de_inspector_model` begins with
    // `String::deserialize`, so the gateway rejects the whole push and nothing
    // ever dials the tier.
    assert!(!patch_selects_classify_tier(
        &serde_json::json!({ "firewall": { "inspector": { "enabled": true, "model": 7 } } }),
        id
    ));
    // Blank still needs the consuming feature ON — the flag gate is what stops a
    // "Log detections" checkbox save from spawning a resident llama-server.
    assert!(!patch_selects_classify_tier(
        &serde_json::json!({ "firewall": {
            "log_detections": true,
            "inspector": { "enabled": false, "model": "" },
            "evaluators": [],
        } }),
        id
    ));
}

/// The regression this gate exists for: the gateway resolves a blank
/// `inspector.model` to the classify id, so EVERY firewall push names the
/// classifier. Selecting the model must not be enough — the consuming feature has
/// to be on, or a "Log detections" checkbox save (and enabling *or disabling* the
/// firewall plugin, whose patch is sourced from the live config) spawns a 241 MB
/// llama-server that never exits.
#[test]
fn classify_predicate_declines_when_the_consuming_feature_is_off() {
    let id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;

    // The firewall-plugin toggle shape, both directions: the live firewall section
    // carries the resolved classify id in `inspector.model` while the inspector
    // itself is off, and no evaluator binding is enabled. That this is what a
    // fresh node's `FirewallConfig` actually serializes to is pinned in the crate
    // that owns the default, by
    // `ryu-gateway`'s `default_firewall_section_selects_nothing_for_cores_lazy_start`.
    for firewall_enabled in [true, false] {
        let patch = serde_json::json!({ "firewall": {
            "enabled": firewall_enabled,
            "log_detections": true,
            "inspector": { "enabled": false, "model": id },
            "evaluators": [{ "id": "toxicity", "enabled": false }],
        } });
        assert!(
            !patch_selects_classify_tier(&patch, id),
            "firewall.enabled={firewall_enabled} with the inspector off must not start the tier"
        );
    }
    // Smart routing configured but not switched on.
    assert!(!patch_selects_classify_tier(
        &serde_json::json!({ "routing": { "smart_routing": { "enabled": false, "classifier_model": id } } }),
        id
    ));
    // An ABSENT flag reads as off. Every real writer sends whole sections, so a
    // missing flag means "this patch does not turn the consumer on"; treating it
    // as enabled would restore the spawn-on-any-push bug.
    assert!(!patch_selects_classify_tier(
        &serde_json::json!({ "firewall": { "inspector": { "model": id } } }),
        id
    ));
    assert!(!patch_selects_classify_tier(
        &serde_json::json!({ "routing": { "smart_routing": { "classifier_model": id } } }),
        id
    ));
    // An empty evaluator list is not "an enabled binding".
    assert!(!patch_selects_classify_tier(
        &serde_json::json!({ "firewall": { "inspector": { "model": id }, "evaluators": [] } }),
        id
    ));
}

/// The host-locality test behind both classify spend gates: pushing a classify
/// selection at a REMOTE gateway must not start a local sidecar (~300-400 MB here
/// for a server nothing dials, while the remote gateway's own loopback `classify`
/// provider stays empty either way), and neither must a classify URL pointing at an
/// external small model.
#[test]
fn classify_start_is_local_only() {
    for local in [
        "http://127.0.0.1:7981",
        "http://127.0.0.1:8981/",
        "http://localhost:7981",
        "http://LOCALHOST:7981",
        "http://[::1]:7981",
        "http://127.5.5.5:7981",
        // The gateway's own default BIND address still means "this box".
        "http://0.0.0.0:7981",
    ] {
        assert!(
            url_targets_this_machine(local),
            "{local} is this machine — the lazy start must run"
        );
    }
    for remote in [
        "http://gateway.internal:7981",
        "https://gw.example.com",
        "http://10.0.0.7:7981",
        "http://192.168.1.20:7981",
        "http://[2606:4700::1]:7981",
        // Unparseable ⇒ cannot prove local ⇒ do not spend the RAM.
        "not a url",
        "",
    ] {
        assert!(
            !url_targets_this_machine(remote),
            "{remote} is not this machine — the remote node must start its own tier"
        );
    }
}

/// The negative that earns its keep: the DEFAULT local chat model must not trip
/// the predicate. A prefix slip there would start a second llama-server on every
/// routing config push.
#[test]
fn classify_predicate_ignores_the_default_chat_model_and_empty_patches() {
    let id = crate::registry::DEFAULT_LOCAL_CLASSIFIER_MODEL_ID;
    for model in [
        crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID, // gemma-4-E2B-it-Q4_K_M
        "gemma-3-27b-it",                             // same family, 100x the size
        "gpt-4o-mini",
    ] {
        // Both consumers ENABLED, so the model id is the only discriminator left
        // — this is a model-matching assertion, not a feature-gate one.
        let patch = serde_json::json!({
            "firewall": { "inspector": { "enabled": true, "model": model } },
            "routing": { "smart_routing": { "enabled": true, "classifier_model": model } },
        });
        assert!(
            !patch_selects_classify_tier(&patch, id),
            "{model:?} must not select the classify tier"
        );
    }
    // A BLANK model is deliberately NOT in the loop above: it is a SELECTION on
    // both fields rather than a non-match, so it belongs to
    // `a_blank_model_on_either_field_selects_the_classify_tier`, not here.
    // Patches that carry neither key at all (the common case: a firewall
    // pattern-pack toggle) never fire.
    assert!(!patch_selects_classify_tier(
        &serde_json::json!({ "firewall": { "enabled": true, "custom_patterns": [] } }),
        id
    ));
    assert!(!patch_selects_classify_tier(&serde_json::json!({}), id));
}

// ── Command-approval scan gate (check_exec_scan) ─────────────────────────

/// Serializes the scan-gate tests: they mutate the process-global
/// `RYU_EXEC_APPROVAL_MODE` / `RYU_GATEWAY_URL` / `RYU_ALLOW_GATEWAY_FALLBACK`
/// env vars. These are the SAME vars other modules' tests touch, so this
/// delegates to the one crate-wide [`super::GATEWAY_ENV_TEST_LOCK`] rather
/// than a second parallel lock (two locks on one global do not serialize).
fn lock_scan_env() -> std::sync::MutexGuard<'static, ()> {
    super::lock_gateway_env()
}

const SCAN_ENV: &[&str] = &[
    ENV_EXEC_APPROVAL_MODE,
    ENV_GATEWAY_URL,
    ENV_ALLOW_GATEWAY_FALLBACK,
    "RYU_ALLOW_PERMANENT_DELETE",
];

#[test]
fn exec_scan_verdict_mapping() {
    // The pure decision mapper: allow → Allow, approval_required → Approval,
    // deny / anything else → fail-closed Deny.
    assert_eq!(map_scan_decision("allow", ""), ExecScanOutcome::Allow);
    assert_eq!(
        map_scan_decision("approval_required", "needs sign-off"),
        ExecScanOutcome::ApprovalRequired("needs sign-off".to_owned())
    );
    assert_eq!(
        map_scan_decision("deny", "blocked by firewall"),
        ExecScanOutcome::Deny("blocked by firewall".to_owned())
    );
    // Unknown verdict is fail-closed (Deny), never a silent allow.
    assert!(matches!(
        map_scan_decision("wat", ""),
        ExecScanOutcome::Deny(_)
    ));
    // Empty reasons get sensible defaults.
    assert!(matches!(
        map_scan_decision("approval_required", ""),
        ExecScanOutcome::ApprovalRequired(_)
    ));
}

#[test]
fn exec_scan_off_mode_reads_env() {
    let _lock = lock_scan_env();
    let _g = EnvGuard::capture(SCAN_ENV);
    // Unset → ARMED (the default-on posture; only explicit `off` disarms).
    std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
    assert!(exec_approval_enabled(), "unset must arm the gate");
    // "off" (any case, trimmed) → disabled.
    for v in ["off", "OFF", " Off "] {
        std::env::set_var(ENV_EXEC_APPROVAL_MODE, v);
        assert!(!exec_approval_enabled(), "{v:?} should disable the gate");
    }
    // Any other value → enabled.
    for v in ["on", "enforce", "prompt", ""] {
        std::env::set_var(ENV_EXEC_APPROVAL_MODE, v);
        assert!(exec_approval_enabled(), "{v:?} should enable the gate");
    }
}

#[tokio::test]
async fn exec_scan_off_mode_short_circuits_without_network() {
    let _lock = lock_scan_env();
    let _g = EnvGuard::capture(SCAN_ENV);
    // Gate explicitly disarmed + a guaranteed-unreachable gateway + NO
    // fallback. If the off-mode path touched the network it would fail-closed
    // to Deny; an Allow proves it short-circuited before any HTTP call.
    std::env::set_var(ENV_EXEC_APPROVAL_MODE, "off");
    std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
    std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
    let out = check_exec_scan("quickjs-wasm", "echo hi", Some("sess"), Some("ryu")).await;
    assert_eq!(out, ExecScanOutcome::Allow);
}

#[tokio::test]
async fn permanent_deletion_is_denied_before_gateway_fallback() {
    let _lock = lock_scan_env();
    let _g = EnvGuard::capture(SCAN_ENV);
    std::env::set_var(ENV_EXEC_APPROVAL_MODE, "off");
    std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
    std::env::set_var(ENV_ALLOW_GATEWAY_FALLBACK, "1");
    let out = check_exec_scan("acp", "rm -rf ./disposable", None, Some("ryu")).await;
    assert!(
        matches!(&out, ExecScanOutcome::Deny(reason) if reason.contains("permanent file deletion")),
        "permanent deletion must stay denied even with approval and gateway fallbacks: {out:?}"
    );
}

#[tokio::test]
async fn legacy_permanent_deletion_policy_change_is_ignored() {
    let _lock = lock_scan_env();
    let _g = EnvGuard::capture(SCAN_ENV);
    std::env::set_var(ENV_EXEC_APPROVAL_MODE, "off");
    // A legacy deployment may still carry this variable. It must never
    // weaken the deletion block after an upgrade.
    std::env::set_var("RYU_ALLOW_PERMANENT_DELETE", "1");
    std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
    std::env::set_var(ENV_ALLOW_GATEWAY_FALLBACK, "1");
    let out = check_exec_scan("acp", "rm -rf ./disposable", None, Some("ryu")).await;
    assert!(matches!(
        out,
        ExecScanOutcome::Deny(reason) if reason.contains("permanent file deletion")
    ));
}

#[tokio::test]
async fn exec_scan_default_is_armed_and_fail_closed() {
    let _lock = lock_scan_env();
    let _g = EnvGuard::capture(SCAN_ENV);
    // The load-bearing default: with NOTHING configured, the scan runs and an
    // unreachable gateway fails closed — a default install's headless runs
    // cannot execute unscanned commands.
    std::env::remove_var(ENV_EXEC_APPROVAL_MODE);
    std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
    std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
    let out = check_exec_scan("quickjs-wasm", "echo hi", None, None).await;
    assert!(
        matches!(out, ExecScanOutcome::Deny(_)),
        "default-armed gate must fail closed on an unreachable gateway, got {out:?}"
    );
}

#[tokio::test]
async fn exec_scan_unreachable_denies_unless_fallback() {
    let _lock = lock_scan_env();
    let _g = EnvGuard::capture(SCAN_ENV);
    // Gate enabled, gateway unreachable, no fallback → fail-closed Deny.
    std::env::set_var(ENV_EXEC_APPROVAL_MODE, "enforce");
    std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
    std::env::remove_var(ENV_ALLOW_GATEWAY_FALLBACK);
    let denied = check_exec_scan("quickjs-wasm", "echo hi", None, None).await;
    assert!(
        matches!(denied, ExecScanOutcome::Deny(_)),
        "unreachable gateway must fail closed, got {denied:?}"
    );

    // Same, but with the fallback opt-in → Allow.
    std::env::set_var(ENV_ALLOW_GATEWAY_FALLBACK, "1");
    let allowed = check_exec_scan("quickjs-wasm", "echo hi", None, None).await;
    assert_eq!(allowed, ExecScanOutcome::Allow);
}

#[test]
fn widget_budget_response_requires_a_boolean_allowed_verdict() {
    for body in [
        serde_json::json!({}),
        serde_json::json!({ "allowed": null }),
        serde_json::json!({ "allowed": "true" }),
    ] {
        assert!(matches!(
            parse_widget_budget_response(body),
            ExecBudgetOutcome::Deny(_)
        ));
    }
    assert_eq!(
        parse_widget_budget_response(serde_json::json!({ "allowed": true })),
        ExecBudgetOutcome::Allow
    );
}

#[test]
fn exec_budget_response_requires_a_boolean_allowed_verdict() {
    for body in [
        serde_json::json!({}),
        serde_json::json!({ "allowed": null }),
        serde_json::json!({ "allowed": "true" }),
    ] {
        assert!(matches!(
            parse_exec_budget_response(body),
            ExecBudgetOutcome::Deny(_)
        ));
    }
    assert_eq!(
        parse_exec_budget_response(serde_json::json!({ "allowed": true })),
        ExecBudgetOutcome::Allow
    );
}

#[tokio::test]
async fn widget_budget_ignores_gateway_fallback_on_unreachable_gateway() {
    let _lock = lock_gateway_env();
    let _env = EnvGuard::capture(&[ENV_GATEWAY_URL, ENV_ALLOW_GATEWAY_FALLBACK]);
    std::env::set_var(ENV_GATEWAY_URL, "http://127.0.0.1:1");
    std::env::set_var(ENV_ALLOW_GATEWAY_FALLBACK, "1");

    assert!(matches!(
        check_widget_followup("widget-instance", "com.example.widget").await,
        ExecBudgetOutcome::Deny(_)
    ));
}

/// The config-push transport must PUT `/v1/config` and forward the gateway
/// bearer (the master key on a remote gateway) so a remote/unmanaged gateway
/// toggle is actually authorized — the item-1 "verify the master-key auth is
/// sent" requirement. Drives a oneshot listener so no process env is touched.
#[tokio::test]
async fn config_request_puts_config_path_and_forwards_bearer() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind oneshot listener");
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        // Read until we have the full request (header block + JSON body). One
        // small localhost request usually arrives at once, but loop with a
        // short timeout so a split header/body still assembles.
        let mut raw = Vec::new();
        let mut buf = [0u8; 2048];
        loop {
            match tokio::time::timeout(std::time::Duration::from_millis(500), sock.read(&mut buf))
                .await
            {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => {
                    raw.extend_from_slice(&buf[..n]);
                    // Stop once the body token has arrived.
                    if String::from_utf8_lossy(&raw).contains("\"firewall\"") {
                        break;
                    }
                }
                _ => break,
            }
        }
        let _ = sock
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
            .await;
        String::from_utf8_lossy(&raw).into_owned()
    });

    let client = reqwest::Client::new();
    let base = format!("http://{addr}");
    let patch = serde_json::json!({ "firewall": { "enabled": true } });
    let resp = gateway_config_request(&client, &base, Some("secret-master-key"), &patch)
        .send()
        .await
        .expect("request sent to oneshot listener");
    assert!(resp.status().is_success());

    let raw = server.await.unwrap();
    let lower = raw.to_ascii_lowercase();
    assert!(
        lower.contains("put /v1/config"),
        "must target PUT /v1/config, got:\n{raw}"
    );
    assert!(
        lower.contains("authorization: bearer secret-master-key"),
        "must forward the master-key bearer, got:\n{raw}"
    );
    assert!(
        raw.contains("\"firewall\""),
        "must carry the config patch body, got:\n{raw}"
    );
}

/// The live-config READ (the read-modify-write source for a firewall toggle)
/// must GET `/v1/config` and forward the gateway bearer, so a remote gateway's
/// live firewall section is actually readable (else the toggle fail-closed
/// no-ops remotely). Mirror of the PUT test, driven off a oneshot listener.
#[tokio::test]
async fn config_get_request_targets_config_path_and_forwards_bearer() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind oneshot listener");
    let addr = listener.local_addr().unwrap();

    let server = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut raw = Vec::new();
        let mut buf = [0u8; 2048];
        loop {
            match tokio::time::timeout(std::time::Duration::from_millis(500), sock.read(&mut buf))
                .await
            {
                Ok(Ok(0)) => break,
                Ok(Ok(n)) => {
                    raw.extend_from_slice(&buf[..n]);
                    // A GET has no body; stop as soon as the header block ends.
                    if String::from_utf8_lossy(&raw).contains("\r\n\r\n") {
                        break;
                    }
                }
                _ => break,
            }
        }
        let body = b"{\"firewall\":{\"enabled\":true,\"policy\":\"block\"}}";
        let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
        let _ = sock.write_all(head.as_bytes()).await;
        let _ = sock.write_all(body).await;
        String::from_utf8_lossy(&raw).into_owned()
    });

    let client = reqwest::Client::new();
    let base = format!("http://{addr}");
    let resp = gateway_config_get_request(&client, &base, Some("secret-master-key"))
        .send()
        .await
        .expect("request sent to oneshot listener");
    assert!(resp.status().is_success());
    let cfg: serde_json::Value = resp.json().await.unwrap();
    assert_eq!(cfg["firewall"]["policy"], serde_json::json!("block"));

    let raw = server.await.unwrap();
    let lower = raw.to_ascii_lowercase();
    assert!(
        lower.contains("get /v1/config"),
        "must target GET /v1/config, got:\n{raw}"
    );
    assert!(
        lower.contains("authorization: bearer secret-master-key"),
        "must forward the master-key bearer, got:\n{raw}"
    );
}
