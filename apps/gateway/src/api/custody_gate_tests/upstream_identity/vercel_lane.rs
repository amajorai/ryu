//! The Vercel AI Gateway lane through the whole pipeline (spec 08.4).
//!
//! The lane is registered under a fixture written-permission reference and
//! points both of its upstream shapes at the shared mock. Each test asserts on
//! the bytes the mock received: Ryu's hashed subject on every attempt, forced
//! zero data retention, and no `byok` entry or tenant identifier anywhere.
use super::*;

/// A fixture reference, not a real agreement.
const APPROVED: &str = "approved:VERCEL-RESALE-FIXTURE-1";
/// A tenant BYOK key sentinel (spec 00.9). It must never reach the upstream.
const TENANT_BYOK: &str = "RYU_TEST_LEXICON-vercel-byok";

fn vercel_harness(custody: GatewayCustody, upstream: &MockUpstream) -> Harness {
    let base = upstream.base.clone();
    let (mut state, audit) = state_with(custody, |config| {
        config.providers.vercel = Some(crate::config::VercelProviderConfig {
            api_key: "vercel-mock-key".to_owned(),
            api_keys: Vec::new(),
            base_url: format!("{base}/vercel/v1"),
            messages_base_url: format!("{base}/vercel"),
            resale_permission: Some(APPROVED.to_owned()),
        });
        config.routing.default_provider = ProviderId::from("vercel");
        config.routing.fallback_chain = vec![];
    });
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        upstream.base.clone(),
        reqwest::Client::new(),
    ));
    state.identity_keys = Arc::new(keys());
    Harness {
        app: crate::api::router(Arc::new(state)),
        audit,
    }
}

/// A tenant chat body that also tries to steer Vercel: its own BYOK key, ZDR
/// off, and fallback models.
fn tenant_vercel_chat(model: &str, stream: bool) -> Value {
    let mut body = tenant_chat(model, stream);
    body["providerOptions"] = json!({
        "gateway": {
            "zeroDataRetention": false,
            "byok": { "anthropic": [{ "apiKey": TENANT_BYOK }] }
        }
    });
    body["provider"] = json!({ "zeroDataRetention": false });
    body["models"] = json!(["fixture/fallback-model"]);
    body
}

fn assert_lane_wire(body: &Value) {
    assert_eq!(
        body["providerOptions"],
        json!({ "gateway": { "zeroDataRetention": true } }),
        "{body}"
    );
    assert!(body.get("provider").is_none(), "{body}");
    assert!(body.get("models").is_none(), "{body}");
    let wire = body.to_string();
    assert!(!wire.contains("byok"), "{wire}");
    assert!(!wire.contains(TENANT_BYOK), "{wire}");
    assert_no_tenant_identifier(body);
}

#[tokio::test]
async fn fleet_chat_leg_carries_the_subject_and_forced_zdr() {
    let expected = credential_subject("cred_default");
    for stream in [false, true] {
        let upstream = spawn_upstream().await;
        let harness = vercel_harness(GatewayCustody::Fleet, &upstream);
        let (status, reply) = post(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            None,
            &tenant_vercel_chat("openai/fixture-model", stream),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "stream={stream}: {reply}");
        let requests = upstream.requests();
        assert_eq!(requests.len(), 1, "stream={stream}");
        assert_eq!(requests[0].path, "/vercel/v1/chat/completions");
        let body = &requests[0].body;
        assert_eq!(body["safety_identifier"], json!(expected), "{body}");
        assert!(body.get("metadata").is_none(), "{body}");
        assert_lane_wire(body);
    }
}

#[tokio::test]
async fn fleet_messages_leg_carries_the_subject_and_forced_zdr() {
    let expected = credential_subject("cred_default");
    for stream in [false, true] {
        let upstream = spawn_upstream().await;
        let harness = vercel_harness(GatewayCustody::Fleet, &upstream);
        let (status, reply) = post(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            None,
            &tenant_vercel_chat("anthropic/claude-fixture", stream),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "stream={stream}: {reply}");
        let requests = upstream.requests();
        assert_eq!(requests.len(), 1, "stream={stream}");
        assert_eq!(requests[0].path, "/vercel/v1/messages");
        let body = &requests[0].body;
        assert_eq!(body["metadata"], json!({ "user_id": expected }), "{body}");
        assert!(body.get("safety_identifier").is_none(), "{body}");
        assert_lane_wire(body);
    }
}

#[tokio::test]
async fn an_unstamped_attempt_never_leaves_on_the_lane() {
    // Off the fleet the Gateway forwards the caller's body without Ryu's
    // subject, and the lane is not registered there at all, so no byte
    // reaches Vercel.
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let upstream = spawn_upstream().await;
        let harness = vercel_harness(custody, &upstream);
        let (status, reply) = post(
            &harness.app,
            "/v1/chat/completions",
            DEFAULT_KEY,
            None,
            &tenant_vercel_chat("openai/fixture-model", false),
        )
        .await;
        assert_ne!(status, StatusCode::OK, "{custody:?}: {reply}");
        assert!(
            upstream
                .requests()
                .iter()
                .all(|request| !request.path.starts_with("/vercel")),
            "{custody:?}"
        );
    }
}

#[tokio::test]
async fn a_forged_ryu_subject_never_reaches_the_lane_off_the_fleet() {
    // Off the fleet stamping is skipped, so a caller's `safety_identifier`
    // survives into the body. A forgery in the exact `ryu.<pv>.<hex32>` shape
    // passes the adapter's format check, so only custody can stop it: the lane
    // must not be registered on a self-hosted or managed node.
    let forged = format!("ryu.1.{}", "ab".repeat(16));
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        for model in ["openai/fixture-model", "anthropic/claude-fixture"] {
            for stream in [false, true] {
                let upstream = spawn_upstream().await;
                let harness = vercel_harness(custody, &upstream);
                let mut body = tenant_vercel_chat(model, stream);
                body["safety_identifier"] = json!(forged);
                let (status, reply) = post(
                    &harness.app,
                    "/v1/chat/completions",
                    DEFAULT_KEY,
                    None,
                    &body,
                )
                .await;
                assert_ne!(
                    status,
                    StatusCode::OK,
                    "{custody:?} {model} stream={stream}: {reply}"
                );
                let requests = upstream.requests();
                assert!(
                    requests
                        .iter()
                        .all(|request| !request.path.starts_with("/vercel")),
                    "{custody:?} {model} stream={stream}"
                );
                assert!(
                    requests
                        .iter()
                        .all(|request| !request.body.to_string().contains(&forged)),
                    "{custody:?} {model} stream={stream}"
                );
            }
        }
    }
}

#[tokio::test]
async fn without_a_recorded_permission_the_lane_is_not_routable() {
    let upstream = spawn_upstream().await;
    let base = upstream.base.clone();
    let (mut state, _audit) = state_with(GatewayCustody::Fleet, |config| {
        config.providers.vercel = Some(crate::config::VercelProviderConfig {
            api_key: "vercel-mock-key".to_owned(),
            api_keys: Vec::new(),
            base_url: format!("{base}/vercel/v1"),
            messages_base_url: format!("{base}/vercel"),
            resale_permission: Some("unreviewed".to_owned()),
        });
        config.routing.default_provider = ProviderId::from("vercel");
        config.routing.fallback_chain = vec![];
    });
    state.resolve_cache = Some(crate::policy::ResolveCache::for_test(
        upstream.base.clone(),
        reqwest::Client::new(),
    ));
    state.identity_keys = Arc::new(keys());
    let app = crate::api::router(Arc::new(state));
    let (status, reply) = post(
        &app,
        "/v1/chat/completions",
        DEFAULT_KEY,
        None,
        &tenant_vercel_chat("openai/fixture-model", false),
    )
    .await;
    assert_ne!(status, StatusCode::OK, "{reply}");
    assert!(upstream
        .requests()
        .iter()
        .all(|request| !request.path.starts_with("/vercel")));
}
