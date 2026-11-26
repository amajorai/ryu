//! How a provider proxy request is tied to the agent that sent it: the
//! agent's own bearer, the auth gate that admits it, and the middleware that
//! runs the request as that agent.
use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::selection_tests::mythos_catalog;
use super::tests::preferences;
use super::{engine_token, scope, store};
use crate::pi_config::accounts::{self, AccountVault};
use crate::server::oauth_pool_policy;
use crate::server::preferences::PreferencesStore;

const CLAUDE: &str = "claude-pro-max";
const ALL: [&str; 4] = ["a", "b", "c", "d"];

#[test]
fn each_agent_gets_its_own_bearer_and_no_other_value_names_an_agent() {
    let security = engine_token::mint("security").unwrap();
    assert_eq!(engine_token::mint("security").unwrap(), security);
    let writer = engine_token::mint("writer").unwrap();
    assert_ne!(security, writer);
    assert_eq!(
        engine_token::agent_for_token(&security).as_deref(),
        Some("security")
    );
    assert_eq!(
        engine_token::agent_for_token(&writer).as_deref(),
        Some("writer")
    );
    let shared = crate::pi_config::secret_env::provider_token();
    assert_ne!(security, shared);
    let mut near_miss = security.clone();
    near_miss.pop();
    near_miss.push(if security.ends_with('0') { '1' } else { '0' });
    for other in [shared, "", "security", "ryu-pi-agent-", near_miss.as_str()] {
        assert_eq!(engine_token::agent_for_token(other), None, "{other}");
    }
    assert_eq!(engine_token::mint(""), None);
    assert_eq!(engine_token::mint(&"a".repeat(129)), None);
}

fn guarded(expected: &str) -> Router {
    let expected = expected.to_owned();
    Router::new()
        .route(
            "/api/pi-config/claude/v1/messages",
            post(|| async { "proxy" }),
        )
        .route(
            "/api/pi-config/providers/account-pools",
            post(|| async { "pools" }),
        )
        .layer(middleware::from_fn(move |request, next| {
            let expected = Some(expected.clone());
            async move { crate::server::require_auth_with_token(request, next, expected).await }
        }))
}

#[tokio::test]
async fn an_agent_bearer_is_admitted_on_provider_routes_only() {
    let bearer = engine_token::mint("security").unwrap();
    let status = |path: &'static str, token: String| async move {
        let request = Request::builder()
            .method("POST")
            .uri(path)
            .header("x-ryu-node-token", &token)
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        guarded("node-secret")
            .oneshot(request)
            .await
            .unwrap()
            .status()
    };
    let proxy = "/api/pi-config/claude/v1/messages";
    let pools = "/api/pi-config/providers/account-pools";
    assert_eq!(status(proxy, bearer.clone()).await, StatusCode::OK);
    assert_eq!(status(pools, bearer).await, StatusCode::UNAUTHORIZED);
    let forged = format!("ryu-pi-agent-{}", "0".repeat(64));
    assert_eq!(status(proxy, forged).await, StatusCode::UNAUTHORIZED);
}

async fn scoped(
    State(preferences): State<PreferencesStore>,
    request: Request<Body>,
    next: Next,
) -> Response {
    scope::scope_request(&preferences, request, next).await
}

/// Stands in for a provider proxy: load the policy the way they all do and
/// report what it allows and which session id arrived.
async fn probe(State(preferences): State<PreferencesStore>, headers: HeaderMap) -> Json<Value> {
    let policy = oauth_pool_policy::load(&preferences, CLAUDE).await;
    Json(json!({
        "allowed": ALL.iter().filter(|id| policy.allowed(id)).collect::<Vec<_>>(),
        "session": headers.get("x-ryu-session-id").and_then(|value| value.to_str().ok()),
    }))
}

async fn ask(preferences: &PreferencesStore, path: &str, headers: &[(&str, &str)]) -> Value {
    let app = Router::new()
        .route("/api/pi-config/claude/v1/messages", post(probe))
        .route("/api/pi-config/providers/account-pools", post(probe))
        .route_layer(middleware::from_fn_with_state(preferences.clone(), scoped))
        .with_state(preferences.clone());
    let mut request = Request::builder().method("POST").uri(path);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    let response = app
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn save_claude_accounts(vault: &AccountVault, ids: &[&str]) -> String {
    let scope = crate::pi_config::provider_account_scope(CLAUDE).unwrap();
    for id in ids {
        vault
            .upsert(
                &scope,
                id,
                id,
                accounts::KIND_OAUTH,
                Some(json!({"type": "oauth"})),
            )
            .unwrap();
    }
    scope
}

#[test]
fn a_provider_request_is_limited_to_the_pool_of_the_agent_whose_bearer_it_carries() {
    accounts::with_test_vault(|vault| {
        let scope = save_claude_accounts(vault, &ALL);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (_directory, preferences) = preferences();
            store::edit(&preferences, |catalog| {
                *catalog = mythos_catalog();
                Ok(())
            })
            .await
            .unwrap();
            let proxy = "/api/pi-config/claude/v1/messages";
            let security = engine_token::mint("security").unwrap();
            let writer = engine_token::mint("writer").unwrap();
            let all = json!(ALL);

            // The pooled agent, on either header the proxies accept.
            let reply = ask(
                &preferences,
                proxy,
                &[
                    ("x-ryu-node-token", security.as_str()),
                    ("x-ryu-session-id", "chat-1"),
                ],
            )
            .await;
            assert_eq!(reply, json!({"allowed": ["b", "d"], "session": "chat-1"}));
            let bearer = format!("Bearer {security}");
            let reply = ask(
                &preferences,
                proxy,
                &[
                    ("authorization", bearer.as_str()),
                    ("x-ryu-session-id", "chat-1"),
                ],
            )
            .await;
            assert_eq!(reply["allowed"], json!(["b", "d"]));

            // It cannot skip selection by sending no usable session id.
            let own = scope::fallback_session("security");
            for session in [None, Some(""), Some("$RYU_PI_HOST_CONVERSATION_ID")] {
                let mut headers = vec![("x-ryu-node-token", security.as_str())];
                headers.extend(session.map(|id| ("x-ryu-session-id", id)));
                let reply = ask(&preferences, proxy, &headers).await;
                assert_eq!(
                    reply,
                    json!({"allowed": ["b", "d"], "session": own}),
                    "{session:?}"
                );
            }

            // An agent with no pool, the shared Pi bearer and the node token
            // are handled exactly as before.
            let shared = crate::pi_config::secret_env::provider_token();
            for token in [writer.as_str(), shared, "node-secret"] {
                let reply = ask(&preferences, proxy, &[("x-ryu-node-token", token)]).await;
                assert_eq!(reply, json!({"allowed": all, "session": null}), "{token}");
            }

            // Only the provider proxies run as an agent.
            let pools = "/api/pi-config/providers/account-pools";
            let reply = ask(
                &preferences,
                pools,
                &[("x-ryu-node-token", security.as_str())],
            )
            .await;
            assert_eq!(reply["allowed"], all);

            // Removed accounts do not count; with none left the pool holds no
            // Claude account and the agent is handled as before.
            vault.remove(&scope, "d").unwrap();
            let reply = ask(
                &preferences,
                proxy,
                &[("x-ryu-node-token", security.as_str())],
            )
            .await;
            assert_eq!(reply["allowed"], json!(["b"]));
            vault.remove(&scope, "b").unwrap();
            let reply = ask(
                &preferences,
                proxy,
                &[("x-ryu-node-token", security.as_str())],
            )
            .await;
            assert_eq!(reply["allowed"], all, "no pool member is left, so no limit");
        });
    });
}

#[test]
fn pools_read_the_same_account_list_as_each_native_proxy() {
    for (provider, auth_key) in [
        (CLAUDE, crate::pi_config::CLAUDE_AUTH_KEY),
        (
            crate::pi_config::CHATGPT_PROVIDER_ID,
            crate::pi_config::CHATGPT_AUTH_KEY,
        ),
        (
            crate::pi_config::CHATGPT_PLAN_PROVIDER_ID,
            crate::pi_config::CHATGPT_PLAN_AUTH_KEY,
        ),
        (crate::pi_config::KIRO_PROVIDER_ID, "kiro"),
    ] {
        assert_eq!(
            crate::pi_config::provider_account_scope(provider),
            Some(accounts::provider_scope(auth_key)),
            "{provider}"
        );
        assert!(oauth_pool_policy::supported(provider), "{provider}");
    }
}
