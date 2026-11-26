//! A request of an agent on Auto, account by account: a limit answer moves
//! the same request to the next account, the limited account is skipped until
//! its reset, backups run when no account can serve the model, and when every
//! account is out the agent gets one answer without another vendor call.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::post,
    Extension, Json, Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

use super::super::modes::{Backup, Mode};
use super::super::tests::preferences;
use super::super::{engine_token, scope, store};
use super::answer::Vendor;
use super::memory::{self, Candidate, Memory};
use super::{models_to_try, run, with_model, Plan, Usage};
use crate::pi_config::accounts;
use crate::server::oauth_pool_policy;
use crate::server::preferences::PreferencesStore;

const CLAUDE: &str = "claude-pro-max";
const OPUS: &str = "claude-opus-4-5";
const SONNET: &str = "claude-sonnet-4-5";
const FIVE_HOURS: u64 = 5 * 60 * 60;

type Calls = Arc<Mutex<Vec<(String, Option<String>)>>>;

fn plan(accounts: &[&str], models: &[&str]) -> Plan {
    Plan {
        vendor: Vendor::Anthropic,
        provider_id: CLAUDE.to_owned(),
        session: Some("chat".to_owned()),
        accounts: accounts
            .iter()
            .map(|id| Candidate {
                id: (*id).to_owned(),
                priority: 0,
                active: false,
            })
            .collect(),
        manual: false,
        models: models.iter().map(|model| (*model).to_owned()).collect(),
    }
}

fn limited(seconds: u64) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({"type": "error"})),
    )
        .into_response();
    response
        .headers_mut()
        .insert("retry-after", seconds.to_string().parse().unwrap());
    response
}

fn served(account: &str, model: Option<&str>) -> Response {
    Json(json!({"account": account, "model": model})).into_response()
}

fn no_model(model: &str) -> Response {
    let body = json!({"type": "error", "error": {"type": "not_found_error", "message": format!("model: {model}")}});
    (StatusCode::NOT_FOUND, Json(body)).into_response()
}

/// Run `plan` against a vendor that answers with `answer(account, model)`.
async fn request(
    plan: &Plan,
    memory: &'static Mutex<Memory>,
    calls: &Calls,
    answer: impl Fn(&str, Option<&str>) -> Response,
) -> (StatusCode, Option<String>, Value) {
    let attempt = |account: String, model: Option<String>| {
        calls.lock().unwrap().push((account.clone(), model.clone()));
        let response = answer(&account, model.as_deref());
        async move { response }
    };
    let none = |_: &str| -> Option<Duration> { None };
    let refresh = |_: &str, _: &str| {};
    let usage = Usage {
        observed: &none,
        refresh: &refresh,
    };
    let response = run(plan, memory, attempt, &usage).await;
    let status = response.status();
    let retry = response
        .headers()
        .get("retry-after")
        .map(|value| value.to_str().unwrap().to_owned());
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, retry, serde_json::from_slice(&bytes).unwrap())
}

fn leaked() -> &'static Mutex<Memory> {
    Box::leak(Box::new(Mutex::new(Memory::default())))
}

fn taken(calls: &Calls) -> Vec<String> {
    std::mem::take(&mut *calls.lock().unwrap())
        .into_iter()
        .map(|(account, _)| account)
        .collect()
}

#[tokio::test]
async fn a_limit_answer_moves_the_same_request_to_the_next_account_and_the_limited_one_waits_for_its_reset(
) {
    let memory = leaked();
    let calls = Calls::default();
    let plan = plan(&["a", "b", "c"], &[OPUS]);
    let vendor = |account: &str, model: Option<&str>| match account {
        "a" => limited(FIVE_HOURS),
        _ => served(account, model),
    };
    let (status, _, body) = request(&plan, memory, &calls, vendor).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["account"], "b");
    // Same request, same model: only the account changed.
    assert_eq!(
        *calls.lock().unwrap(),
        [("a".to_owned(), None), ("b".to_owned(), None)]
    );
    taken(&calls);

    // The conversation stays on b; new conversations never reach a.
    let (_, _, body) = request(&plan, memory, &calls, vendor).await;
    assert_eq!(body["account"], "b");
    for session in ["sub-1", "sub-2", "sub-3"] {
        let other = Plan {
            session: Some(session.to_owned()),
            ..plan.clone()
        };
        let (status, _, _) = request(&other, memory, &calls, vendor).await;
        assert_eq!(status, StatusCode::OK);
    }
    let used = taken(&calls);
    assert!(!used.contains(&"a".to_owned()), "{used:?}");
    assert!(
        used.contains(&"c".to_owned()),
        "new sessions spread: {used:?}"
    );

    // a is out until its own reset, five hours, not one minute.
    let reset = memory::lock(memory)
        .first_reset(CLAUDE, &plan.accounts, &plan.models, Instant::now())
        .unwrap();
    assert!(reset > Duration::from_secs(FIVE_HOURS - 60), "{reset:?}");
    let later = Instant::now() + Duration::from_secs(FIVE_HOURS + 1);
    let order = memory::lock(memory).order(CLAUDE, Some("new"), OPUS, &plan.accounts, false, later);
    assert!(
        order.contains(&"a".to_owned()),
        "back after its reset: {order:?}"
    );
}

#[tokio::test]
async fn when_every_account_is_out_the_agent_gets_one_answer_and_the_vendor_is_not_called_again() {
    let memory = leaked();
    let calls = Calls::default();
    let plan = plan(&["a", "b", "c"], &[OPUS]);
    let vendor = |account: &str, _: Option<&str>| match account {
        "a" => limited(3 * 3600),
        "b" => limited(3600),
        _ => limited(2 * 3600),
    };
    let (status, retry, body) = request(&plan, memory, &calls, vendor).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(taken(&calls).len(), 3);
    let retry: u64 = retry.unwrap().parse().unwrap();
    assert!((3590..=3600).contains(&retry), "first reset: {retry}");
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.starts_with("Every account this agent can use is at its usage limit."));

    let (status, retry, _) = request(&plan, memory, &calls, vendor).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(retry.is_some());
    assert!(taken(&calls).is_empty(), "no vendor call while all are out");
}

#[tokio::test]
async fn when_no_account_has_the_model_the_backups_run_in_order_on_the_same_accounts() {
    let memory = leaked();
    let calls = Calls::default();
    let backups = [
        Backup {
            provider_id: "chatgpt".into(),
            model: "gpt-5".into(),
        },
        Backup {
            provider_id: "anthropic".into(),
            model: SONNET.into(),
        },
        Backup {
            provider_id: CLAUDE.into(),
            model: "claude-haiku-4-5".into(),
        },
    ];
    // Another provider's backup is stored but cannot run in this request.
    let models = models_to_try(OPUS, &backups, CLAUDE);
    assert_eq!(models, [OPUS, SONNET, "claude-haiku-4-5"]);
    let plan = plan(&["a", "b"], &[OPUS, SONNET, "claude-haiku-4-5"]);
    let vendor = |account: &str, model: Option<&str>| match model {
        None => no_model(OPUS),
        Some(SONNET) if account == "a" => no_model(SONNET),
        Some(model) => served(account, Some(model)),
    };
    let (status, _, body) = request(&plan, memory, &calls, vendor).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["model"], SONNET);
    let tried = std::mem::take(&mut *calls.lock().unwrap());
    // Both accounts were asked for the model, then the first backup.
    assert!(matches!(tried.len(), 3 | 4), "{tried:?}");
    assert!(tried[..2].iter().all(|(_, model)| model.is_none()));
    assert!(tried[2..]
        .iter()
        .all(|(_, model)| model.as_deref() == Some(SONNET)));
    // No access is not a limit: nothing waits for a reset.
    assert_eq!(
        memory::lock(memory).first_reset(CLAUDE, &plan.accounts, &plan.models, Instant::now()),
        None
    );
    // The next request does not ask for the model again.
    request(&plan, memory, &calls, vendor).await;
    let tried = std::mem::take(&mut *calls.lock().unwrap());
    assert!(tried.iter().all(|(_, model)| model.is_some()), "{tried:?}");

    let body = Bytes::from(json!({"model": OPUS, "max_tokens": 9}).to_string());
    let replaced: Value = serde_json::from_slice(&with_model(&body, SONNET)).unwrap();
    assert_eq!(replaced, json!({"model": SONNET, "max_tokens": 9}));
}

#[tokio::test]
async fn an_answer_about_the_request_itself_goes_back_at_once() {
    let memory = leaked();
    let calls = Calls::default();
    let plan = plan(&["a", "b"], &[OPUS]);
    let vendor = |_: &str, _: Option<&str>| {
        let body = json!({"error": {"type": "invalid_request_error", "message": "max_tokens"}});
        (StatusCode::BAD_REQUEST, Json(body)).into_response()
    };
    let (status, _, body) = request(&plan, memory, &calls, vendor).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"]["message"], "max_tokens");
    assert_eq!(taken(&calls).len(), 1);
}

#[tokio::test]
async fn a_limit_that_names_no_reset_uses_the_observed_usage_and_reads_it_again() {
    let memory = leaked();
    let plan = plan(&["a", "b"], &[OPUS]);
    let refreshed = Mutex::new(Vec::new());
    let observed = |account: &str| (account == "a").then_some(Duration::from_secs(4 * 3600));
    let refresh = |account: &str, model: &str| {
        refreshed
            .lock()
            .unwrap()
            .push((account.to_owned(), model.to_owned()));
    };
    let usage = Usage {
        observed: &observed,
        refresh: &refresh,
    };
    let attempt = |account: String, _: Option<String>| async move {
        if account == "a" {
            (StatusCode::TOO_MANY_REQUESTS, "limit").into_response()
        } else {
            served(&account, None)
        }
    };
    let response = run(&plan, memory, attempt, &usage).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        *refreshed.lock().unwrap(),
        [("a".to_owned(), OPUS.to_owned())]
    );
    let only_a = &plan.accounts[..1];
    let reset = memory::lock(memory)
        .first_reset(CLAUDE, only_a, &plan.models, Instant::now())
        .unwrap();
    assert!(reset > Duration::from_secs(4 * 3600 - 60), "{reset:?}");
}

// Through the real middleware: an agent on Auto, its bearer, saved accounts.

#[derive(Default)]
struct FakeVendor {
    limited: Vec<String>,
    seen: Vec<(String, Value)>,
}

async fn scoped(
    State(preferences): State<PreferencesStore>,
    request: Request<Body>,
    next: Next,
) -> Response {
    scope::scope_request(&preferences, request, next).await
}

/// Stands in for the Claude proxy: load the policy as it does, take the one
/// saved account it allows, and answer as that account.
async fn proxy(
    State(preferences): State<PreferencesStore>,
    Extension(vendor): Extension<Arc<Mutex<FakeVendor>>>,
    body: Bytes,
) -> Response {
    let policy = oauth_pool_policy::load(&preferences, CLAUDE).await;
    let scope = crate::pi_config::provider_account_scope(CLAUDE).unwrap();
    let allowed: Vec<String> = accounts::global()
        .unwrap()
        .list(&scope)
        .unwrap()
        .into_iter()
        .map(|account| account.account_id)
        .filter(|id| policy.allowed(id))
        .collect();
    let [account] = allowed.as_slice() else {
        return served("many", None);
    };
    let mut vendor = vendor.lock().unwrap();
    vendor
        .seen
        .push((account.clone(), serde_json::from_slice(&body).unwrap()));
    if vendor.limited.contains(account) {
        limited(FIVE_HOURS)
    } else {
        served(account, None)
    }
}

async fn send(app: &Router, agent: &str, session: &str) -> (StatusCode, Value) {
    let token = engine_token::mint(agent).unwrap();
    let request = Request::post("/api/pi-config/claude/v1/messages")
        .header("x-ryu-node-token", token)
        .header("x-ryu-session-id", session)
        .body(Body::from(
            json!({"model": OPUS, "messages": [{"role": "user", "content": "hi"}]}).to_string(),
        ))
        .unwrap();
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[test]
fn through_the_middleware_an_agent_on_auto_continues_on_the_next_account_when_one_is_limited() {
    accounts::with_test_vault(|vault| {
        let prefix = uuid::Uuid::new_v4().simple().to_string();
        let ids: Vec<String> = (1..=2).map(|n| format!("{prefix}-{n}")).collect();
        let scope_id = crate::pi_config::provider_account_scope(CLAUDE).unwrap();
        for id in &ids {
            vault
                .upsert(
                    &scope_id,
                    id,
                    id,
                    accounts::KIND_OAUTH,
                    Some(json!({"type": "oauth"})),
                )
                .unwrap();
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (_directory, preferences) = preferences();
            store::edit(&preferences, |catalog| {
                catalog.set_mode("worker", Mode::Auto, None)
            })
            .await
            .unwrap();
            let vendor = Arc::new(Mutex::new(FakeVendor::default()));
            let app = Router::new()
                .route("/api/pi-config/claude/v1/messages", post(proxy))
                .route_layer(middleware::from_fn_with_state(preferences.clone(), scoped))
                .layer(Extension(vendor.clone()))
                .with_state(preferences.clone());

            // The first account the request reaches is at its limit.
            let (status, body) = send(&app, "worker", "chat-1").await;
            assert_eq!(status, StatusCode::OK);
            let first_served = body["account"].as_str().unwrap().to_owned();
            let seen = std::mem::take(&mut vendor.lock().unwrap().seen);
            assert_eq!(seen.len(), 1, "nothing was limited yet: {seen:?}");
            let limited_id = first_served.clone();
            let other = ids.iter().find(|id| **id != limited_id).unwrap().clone();
            vendor.lock().unwrap().limited.push(limited_id.clone());

            let (status, body) = send(&app, "worker", "chat-1").await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["account"], other.as_str());
            let seen = std::mem::take(&mut vendor.lock().unwrap().seen);
            assert_eq!(seen.len(), 2);
            assert_eq!(seen[0].0, limited_id);
            assert_eq!(seen[1].0, other);
            assert_eq!(
                seen[0].1, seen[1].1,
                "the same request went to the next account"
            );

            // Later requests, of this or another conversation, skip it.
            for session in ["chat-1", "chat-2", "chat-3"] {
                let (status, _) = send(&app, "worker", session).await;
                assert_eq!(status, StatusCode::OK);
            }
            let seen = std::mem::take(&mut vendor.lock().unwrap().seen);
            assert!(seen.iter().all(|(id, _)| *id == other), "{seen:?}");

            // Both out: one clear answer.
            vendor.lock().unwrap().limited.push(other.clone());
            let (status, body) = send(&app, "worker", "chat-4").await;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
            assert!(body["error"]["message"]
                .as_str()
                .unwrap()
                .starts_with("Every account"));

            // An agent with no setting is handled as before, all accounts open.
            let (_, body) = send(&app, "writer", "chat-5").await;
            assert_eq!(body["account"], "many");
        });
    });
}
