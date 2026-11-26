//! The batched POST against a mock relay, and the configuration gate.

use std::sync::atomic::AtomicUsize;
use std::sync::Mutex;

use axum::http::{HeaderMap, StatusCode};
use serde_json::Value;

use super::*;

/// What the mock relay received, and the status it answers with.
struct Relay {
    posts: Mutex<Vec<(HeaderMap, Value)>>,
    status: AtomicUsize,
}

impl Relay {
    fn bodies(&self) -> Vec<Value> {
        let posts = self.posts.lock().unwrap();
        posts.iter().map(|(_, body)| body.clone()).collect()
    }
}

async fn mock_relay() -> (Arc<Relay>, String, tokio::task::JoinHandle<()>) {
    let relay = Arc::new(Relay {
        posts: Mutex::default(),
        status: AtomicUsize::new(200),
    });
    let seen = Arc::clone(&relay);
    let app = axum::Router::new().route(
        "/api/telemetry/ryu",
        axum::routing::post(move |headers: HeaderMap, body: axum::Json<Value>| {
            let seen = Arc::clone(&seen);
            async move {
                seen.posts.lock().unwrap().push((headers, body.0));
                let status = seen.status.load(Ordering::SeqCst);
                StatusCode::from_u16(u16::try_from(status).unwrap()).unwrap()
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!(
        "http://{}/api/telemetry/ryu",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (relay, url, server)
}

fn event(index: u64) -> ModelCallEvent {
    ModelCallEvent {
        kind: "gateway_model_call",
        event_id: format!("event-{index}"),
        operation: "chat".to_owned(),
        provider: "provider".to_owned(),
        model: "model".to_owned(),
        input_tokens: index,
        output_tokens: 2,
        latency_ms: 3,
        outcome: "success",
        error_code: None,
        service_version: "0.0.0",
    }
}

fn config(url: &str, auth: AuthMode) -> Config {
    Config {
        auth,
        url: url.to_owned(),
    }
}

#[test]
fn the_gate_is_unresolved_until_a_configuration_is_stored_and_then_follows_it() {
    let state = RelayState::new();
    assert_eq!(state.enabled(), None);
    assert!(state.current().is_none());
    state.store(None);
    assert_eq!(state.enabled(), Some(false));
    state.store(Some(config(
        "https://api.example/api/telemetry/ryu",
        AuthMode::HostedSecret("s".to_owned()),
    )));
    assert_eq!(state.enabled(), Some(true));
    assert_eq!(
        state.current().unwrap().url,
        "https://api.example/api/telemetry/ryu"
    );
    // Core turned the relay off: the next model call queues nothing.
    state.store(None);
    assert_eq!(state.enabled(), Some(false));
    assert!(state.current().is_none());
}

#[test]
fn the_production_pacing_fits_the_relay_limits() {
    // 20 events per POST and 60 POSTs per minute per rate key.
    assert_eq!(SETTINGS.batch_size, 20);
    assert!(SETTINGS.post_interval >= Duration::from_secs(1));
    assert!(SETTINGS.flush_after <= Duration::from_secs(5));
    assert!(SETTINGS.capacity >= 100 * SETTINGS.batch_size);
}

#[tokio::test]
async fn one_post_carries_every_event_with_the_mode_s_auth_headers() {
    let (relay, url, server) = mock_relay().await;
    let client = reqwest::Client::new();
    let events: Vec<ModelCallEvent> = (0..20).map(event).collect();

    let node = config(&url, AuthMode::GatewayRelayToken("rgw_relay".to_owned()));
    let sent = post_batch(&client, &node, &events).await;
    assert_eq!(sent, (Delivery::Sent, Some(200)));
    let hosted = config(&url, AuthMode::HostedSecret("hosted-secret".to_owned()));
    let sent = post_batch(&client, &hosted, &events[..1]).await;
    assert_eq!(sent, (Delivery::Sent, Some(200)));

    let posts = relay.posts.lock().unwrap();
    assert_eq!(posts.len(), 2);
    let (headers, body) = &posts[0];
    assert_eq!(headers["x-gateway-key"], "rgw_relay");
    assert_eq!(headers["x-ryu-diagnostics-opt-in"], "true");
    assert!(headers.get("x-ryu-analytics-secret").is_none());
    let sent_events = body["events"].as_array().unwrap();
    assert_eq!(sent_events.len(), 20);
    assert_eq!(body.as_object().unwrap().len(), 1);
    for (index, sent_event) in sent_events.iter().enumerate() {
        assert_eq!(sent_event["eventId"], format!("event-{index}"));
        assert_eq!(sent_event["kind"], "gateway_model_call");
        assert_eq!(sent_event["inputTokens"], index);
        assert!(sent_event.get("errorCode").is_none());
    }
    let (headers, body) = &posts[1];
    assert_eq!(headers["x-ryu-analytics-secret"], "hosted-secret");
    assert!(headers.get("x-gateway-key").is_none());
    assert!(headers.get("x-ryu-diagnostics-opt-in").is_none());
    assert_eq!(body["events"].as_array().unwrap().len(), 1);
    drop(posts);
    server.abort();
}

#[tokio::test]
async fn a_429_is_rate_limited_and_any_other_failure_loses_the_batch() {
    let (relay, url, server) = mock_relay().await;
    let client = reqwest::Client::new();
    let hosted = config(&url, AuthMode::HostedSecret("hosted-secret".to_owned()));
    let events = [event(0)];
    for (status, expected) in [
        (429, Delivery::RateLimited),
        (401, Delivery::Lost),
        (413, Delivery::Lost),
        (500, Delivery::Lost),
        (204, Delivery::Sent),
    ] {
        relay.status.store(status, Ordering::SeqCst);
        let outcome = post_batch(&client, &hosted, &events).await;
        assert_eq!(outcome, (expected, Some(u16::try_from(status).unwrap())));
    }
    server.abort();
    let _ = server.await;
    // Nothing listens any more: the POST fails without a status.
    // A new client: the old one may still hold a connection the server kept.
    let outcome = post_batch(&reqwest::Client::new(), &hosted, &events).await;
    assert_eq!(outcome, (Delivery::Lost, None));
}

/// Posts to one fixed relay, as `RelayPost` does to the configured one.
struct FixedRelay {
    client: reqwest::Client,
    config: Config,
}

impl Post<ModelCallEvent> for FixedRelay {
    fn post<'a>(&'a self, events: &'a [ModelCallEvent]) -> BoxFuture<'a, Delivery> {
        Box::pin(async move { post_batch(&self.client, &self.config, events).await.0 })
    }
}

#[tokio::test]
async fn one_hundred_model_calls_reach_the_relay_in_five_posts() {
    let (relay, url, server) = mock_relay().await;
    let queue = Queue::spawn(
        Settings {
            post_interval: Duration::from_millis(1),
            ..SETTINGS
        },
        Arc::new(FixedRelay {
            client: reqwest::Client::new(),
            config: config(&url, AuthMode::HostedSecret("hosted-secret".to_owned())),
        }),
    );
    for index in 0..100 {
        assert!(queue.push(event(index)));
    }
    queue.flush().await;
    let bodies = relay.bodies();
    assert_eq!(bodies.len(), 5, "one POST per 20 events, not one per event");
    let ids: Vec<String> = bodies
        .iter()
        .flat_map(|body| body["events"].as_array().unwrap().clone())
        .map(|sent| sent["eventId"].as_str().unwrap().to_owned())
        .collect();
    let expected: Vec<String> = (0..100).map(|index| format!("event-{index}")).collect();
    assert_eq!(ids, expected);
    server.abort();
}
