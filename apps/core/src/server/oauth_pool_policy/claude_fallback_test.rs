use super::*;
use axum::{body::to_bytes, routing::post, Router};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

// Made-up values. They do not have the shape of any provider's real key.
const KEY_WORK: &str = "test-key-work-00000000000001";
const KEY_SPARE: &str = "test-key-spare-0000000000002";
const SCOPE: &str = "provider:anthropic";
const SERVED_BODY: &str = "event: message_stop\ndata: {}\n\n";
const ON: Settings = Settings {
    api_key_fallback: true,
};
const OFF: Settings = Settings {
    api_key_fallback: false,
};

/// What the stand-in provider answers for one key.
#[derive(Clone)]
struct Reply {
    key: &'static str,
    status: StatusCode,
    retry_after: Option<&'static str>,
}

fn reply(key: &'static str, status: u16) -> Reply {
    Reply {
        key,
        status: StatusCode::from_u16(status).unwrap(),
        retry_after: None,
    }
}

struct Provider {
    url: String,
    seen: Arc<Mutex<Vec<HeaderMap>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Provider {
    /// The `x-api-key` of every request that arrived, in order.
    fn keys_seen(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|headers| {
                header_text(headers, "x-api-key")
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    }
}

impl Drop for Provider {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn provider(replies: Vec<Reply>) -> Provider {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&seen);
    let replies = Arc::new(replies);
    let router = Router::new().route(
        "/v1/messages",
        post(move |headers: HeaderMap, _body: Bytes| {
            let recorded = Arc::clone(&recorded);
            let replies = Arc::clone(&replies);
            async move {
                let key = header_text(&headers, "x-api-key")
                    .unwrap_or_default()
                    .to_owned();
                recorded.lock().unwrap().push(headers);
                let Some(reply) = replies.iter().find(|reply| reply.key == key) else {
                    return StatusCode::IM_A_TEAPOT.into_response();
                };
                let mut response = (
                    reply.status,
                    [("content-type", "text/event-stream")],
                    SERVED_BODY,
                )
                    .into_response();
                if let Some(wait) = reply.retry_after {
                    response
                        .headers_mut()
                        .insert("retry-after", HeaderValue::from_static(wait));
                }
                response
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("stand-in provider");
    });
    Provider {
        url: format!("http://{address}/v1/messages"),
        seen,
        task,
    }
}

fn account(id: &str, label: &str, kind: &str) -> AccountInfo {
    serde_json::from_value(json!({
        "accountId": id,
        "label": label,
        "kind": kind,
        "active": false,
        "gatewayActive": false,
        "updatedAt": 0,
    }))
    .expect("account info")
}

fn policy(value: Value) -> Policy {
    serde_json::from_value(value).expect("policy")
}

fn candidate(id: &str, label: &str) -> KeyCandidate {
    KeyCandidate {
        account_id: id.to_owned(),
        label: label.to_owned(),
    }
}

/// A vault with two saved keys, and a plan that tries "key-work" first.
fn two_keys() -> (AccountVault, Plan) {
    let vault = AccountVault::in_memory().unwrap();
    for (id, label, key) in [
        ("key-work", "Work", KEY_WORK),
        ("key-spare", "Spare", KEY_SPARE),
    ] {
        vault
            .upsert(
                SCOPE,
                id,
                label,
                KIND_API_KEY,
                Some(json!({ "type": "api_key", "key": key })),
            )
            .unwrap();
    }
    let plan = Plan {
        enabled_subscriptions: 1,
        keys: vec![
            candidate("key-work", "Work"),
            candidate("key-spare", "Spare"),
        ],
    };
    (vault, plan)
}

fn request_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("claude-code-20250219, oauth-2025-04-20"),
    );
    headers.insert(
        "authorization",
        HeaderValue::from_static("Bearer local-placeholder"),
    );
    headers.insert(
        "x-ryu-session-id",
        HeaderValue::from_static("conversation-a"),
    );
    headers
}

fn subscription_answer(status: u16) -> Response {
    error(
        StatusCode::from_u16(status).unwrap(),
        "from_subscription",
        "the subscription accounts answered",
    )
}

/// Run one request whose subscription accounts always answer `status`.
/// Returns the answer, the key that served it, and how often the
/// subscription accounts were asked.
async fn run_once(
    settings: Settings,
    plan: &Plan,
    vault: &AccountVault,
    url: &str,
    health: &Mutex<Health>,
    status: u16,
) -> (Response, Option<KeyCandidate>, usize) {
    let calls = AtomicUsize::new(0);
    let flow = Flow {
        settings,
        plan,
        vault,
        scope: SCOPE,
        url,
        health,
    };
    let body = Bytes::from_static(br#"{"model":"claude-fable-5","messages":[]}"#);
    let (response, served_by) = run(&flow, &request_headers(), &body, || {
        calls.fetch_add(1, Ordering::SeqCst);
        async move { subscription_answer(status) }
    })
    .await;
    (response, served_by, calls.load(Ordering::SeqCst))
}

async fn text(response: Response) -> String {
    let bytes = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

#[test]
fn the_plan_lists_enabled_keys_in_the_saved_order() {
    let accounts = vec![
        account("login-a", "a@example.com", KIND_OAUTH),
        account("login-b", "b@example.com", KIND_OAUTH),
        account("key-work", "Work", KIND_API_KEY),
        account("key-spare", "Spare", KIND_API_KEY),
        account("key-old", "Old", KIND_API_KEY),
    ];
    let subscriptions = policy(json!({ "accounts": { "login-b": { "enabled": false } } }));
    let keys = policy(json!({
        "accounts": {
            "key-spare": { "priority": 0 },
            "key-old": { "priority": 1, "enabled": false },
            "key-work": { "priority": 2 },
        }
    }));
    assert_eq!(
        plan(accounts, &subscriptions, &keys),
        Plan {
            enabled_subscriptions: 1,
            keys: vec![
                candidate("key-spare", "Spare"),
                candidate("key-work", "Work")
            ],
        }
    );
}

#[test]
fn a_key_is_allowed_only_when_the_setting_is_on_and_the_accounts_ran_out() {
    let (_vault, plan) = two_keys();
    for status in [200, 400, 401, 403, 404, 429, 500, 529] {
        assert!(!may_use_key(OFF, &plan, status), "off, {status}");
    }
    for status in [401, 403, 429] {
        assert!(may_use_key(ON, &plan, status), "on, {status}");
    }
    for status in [200, 400, 404, 409, 500, 502, 529] {
        assert!(!may_use_key(ON, &plan, status), "on, {status}");
    }
    // Nothing ran out when no subscription account is signed in and enabled.
    let no_subscription = Plan {
        enabled_subscriptions: 0,
        ..plan.clone()
    };
    assert!(!may_use_key(ON, &no_subscription, 429));
    let no_keys = Plan {
        enabled_subscriptions: 2,
        keys: Vec::new(),
    };
    assert!(!may_use_key(ON, &no_keys, 429));
}

#[test]
fn every_enabled_account_gets_its_turn_before_a_key() {
    for (accounts, calls) in [(0, 1), (1, 1), (4, 1), (5, 2), (8, 2), (9, 3), (50, 4)] {
        assert_eq!(subscription_calls(accounts), calls, "{accounts} accounts");
    }
}

#[tokio::test]
async fn with_the_setting_off_a_limit_never_reaches_an_api_key() {
    let provider = provider(vec![reply(KEY_WORK, 200), reply(KEY_SPARE, 200)]).await;
    let (vault, plan) = two_keys();
    let health = Mutex::new(Health::default());
    for status in [401, 403, 429] {
        let (response, served_by, calls) =
            run_once(OFF, &plan, &vault, &provider.url, &health, status).await;
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(served_by, None);
        assert_eq!(calls, 1);
        assert!(text(response).await.contains("from_subscription"));
    }
    assert!(provider.keys_seen().is_empty());
}

#[tokio::test]
async fn with_the_setting_on_a_limit_uses_the_first_enabled_key() {
    let provider = provider(vec![reply(KEY_WORK, 200), reply(KEY_SPARE, 200)]).await;
    let (vault, plan) = two_keys();
    let health = Mutex::new(Health::default());
    let (response, served_by, calls) =
        run_once(ON, &plan, &vault, &provider.url, &health, 429).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[SOURCE_HEADER], SOURCE_API_KEY);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(served_by, Some(candidate("key-work", "Work")));
    assert_eq!(calls, 1);
    assert_eq!(text(response).await, SERVED_BODY);
    assert_eq!(provider.keys_seen(), vec![KEY_WORK]);

    let seen = provider.seen.lock().unwrap();
    // The placeholder bearer and the sign-in only beta entry stay behind.
    assert!(seen[0].get("authorization").is_none());
    assert_eq!(seen[0]["anthropic-beta"], "claude-code-20250219");
    assert_eq!(seen[0]["anthropic-version"], "2023-06-01");
}

#[tokio::test]
async fn an_answer_that_does_not_move_on_never_uses_a_key() {
    let provider = provider(vec![reply(KEY_WORK, 200)]).await;
    let (vault, plan) = two_keys();
    let health = Mutex::new(Health::default());
    // A served request, a refusal or bad request, and a server error.
    for status in [200, 400, 404, 500, 529] {
        let (response, served_by, _) =
            run_once(ON, &plan, &vault, &provider.url, &health, status).await;
        assert_eq!(response.status().as_u16(), status);
        assert_eq!(served_by, None);
    }
    assert!(provider.keys_seen().is_empty());
}

#[tokio::test]
async fn a_limited_key_rests_for_the_wait_hint_and_the_next_key_serves() {
    let limited = Reply {
        retry_after: Some("120"),
        ..reply(KEY_WORK, 429)
    };
    let provider = provider(vec![limited, reply(KEY_SPARE, 200)]).await;
    let (vault, plan) = two_keys();
    let health = Mutex::new(Health::default());
    let (response, served_by, _) = run_once(ON, &plan, &vault, &provider.url, &health, 429).await;

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_by, Some(candidate("key-spare", "Spare")));
    assert_eq!(provider.keys_seen(), vec![KEY_WORK, KEY_SPARE]);
    let now = Instant::now();
    {
        let health = health.lock().unwrap();
        assert_eq!(
            health.resting("key-work", now + Duration::from_secs(110)),
            Some(Rest::Limited)
        );
        assert!(health.usable("key-work", now + Duration::from_secs(121)));
        assert!(health.usable("key-spare", now));
    }

    // The next call skips the resting key without asking the provider.
    let (_, served_by, _) = run_once(ON, &plan, &vault, &provider.url, &health, 429).await;
    assert_eq!(served_by, Some(candidate("key-spare", "Spare")));
    assert_eq!(provider.keys_seen(), vec![KEY_WORK, KEY_SPARE, KEY_SPARE]);
}

#[tokio::test]
async fn a_refused_key_is_marked_failing_and_the_next_key_serves() {
    for status in [401, 403] {
        let provider = provider(vec![reply(KEY_WORK, status), reply(KEY_SPARE, 200)]).await;
        let (vault, plan) = two_keys();
        let health = Mutex::new(Health::default());
        let (response, served_by, _) =
            run_once(ON, &plan, &vault, &provider.url, &health, 429).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(served_by, Some(candidate("key-spare", "Spare")));
        let now = Instant::now();
        let health = health.lock().unwrap();
        assert_eq!(
            health.resting("key-work", now + Duration::from_secs(290)),
            Some(Rest::Rejected)
        );
        assert!(health.usable("key-work", now + Duration::from_secs(301)));
    }
}

#[tokio::test]
async fn when_every_key_is_resting_the_subscription_answer_is_returned() {
    let provider = provider(vec![reply(KEY_WORK, 429), reply(KEY_SPARE, 401)]).await;
    let (vault, plan) = two_keys();
    let health = Mutex::new(Health::default());
    let (response, served_by, _) = run_once(ON, &plan, &vault, &provider.url, &health, 429).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(served_by, None);
    assert!(text(response).await.contains("from_subscription"));
    assert_eq!(provider.keys_seen(), vec![KEY_WORK, KEY_SPARE]);

    // Both rest now, so the provider is not asked again.
    let (response, _, _) = run_once(ON, &plan, &vault, &provider.url, &health, 429).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(provider.keys_seen().len(), 2);
}

#[tokio::test]
async fn a_bad_request_on_a_key_is_returned_without_trying_another_key() {
    let provider = provider(vec![reply(KEY_WORK, 400), reply(KEY_SPARE, 200)]).await;
    let (vault, plan) = two_keys();
    let health = Mutex::new(Health::default());
    let (response, served_by, _) = run_once(ON, &plan, &vault, &provider.url, &health, 429).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert!(response.headers().get(SOURCE_HEADER).is_none());
    assert_eq!(served_by, None);
    assert_eq!(provider.keys_seen(), vec![KEY_WORK]);
    assert!(health.lock().unwrap().usable("key-work", Instant::now()));
}

#[tokio::test]
async fn a_network_error_is_returned_without_resting_the_key_or_naming_it() {
    // A port nothing listens on: bind, read the address, close.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1/messages", listener.local_addr().unwrap());
    drop(listener);
    let (vault, plan) = two_keys();
    let health = Mutex::new(Health::default());
    let (response, served_by, _) = run_once(ON, &plan, &vault, &url, &health, 429).await;

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(served_by, None);
    assert!(health.lock().unwrap().usable("key-work", Instant::now()));
    let body = text(response).await;
    assert!(body.contains("upstream_unreachable"));
    assert!(!body.contains(KEY_WORK) && !body.contains("0001"));
}

#[tokio::test]
async fn a_removed_key_is_skipped() {
    let provider = provider(vec![reply(KEY_SPARE, 200)]).await;
    let (vault, plan) = two_keys();
    assert!(vault.remove(SCOPE, "key-work").unwrap());
    let health = Mutex::new(Health::default());
    let (response, served_by, _) = run_once(ON, &plan, &vault, &provider.url, &health, 403).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_by, Some(candidate("key-spare", "Spare")));
    assert_eq!(provider.keys_seen(), vec![KEY_SPARE]);
}

#[test]
fn nothing_printable_holds_a_key() {
    let (vault, plan) = two_keys();
    let secret = read_key(&vault, SCOPE, "key-work").expect("saved key");
    let printed = format!("{secret:?} {plan:?} {:?}", secret.0);
    assert!(!printed.contains(KEY_WORK), "{printed}");
    assert!(!printed.contains("0001"), "{printed}");
    assert!(read_key(&vault, SCOPE, "missing").is_none());
}

#[test]
fn sign_in_only_beta_entries_are_dropped_for_an_api_key() {
    let mut headers = HeaderMap::new();
    assert_eq!(api_key_beta(&headers), None);
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("oauth-2025-04-20"),
    );
    assert_eq!(api_key_beta(&headers), None);
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("oauth-2025-04-20,claude-code-20250219 , fine-grained"),
    );
    assert_eq!(
        api_key_beta(&headers).unwrap(),
        "claude-code-20250219,fine-grained"
    );
}
