use super::*;
use axum::{
    extract::{ws::Message, State},
    routing::{get, post},
    Json, Router,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const ACCOUNT: &str = "AC0123456789abcdef0123456789abcdef";
const VICTIM_CALL: &str = "CA0123456789abcdef0123456789abcdef";
const ATTACK_CALL: &str = "CA1123456789abcdef0123456789abcdef";
const PROVIDER_SECRET: &str = "voice-provider-fixture-secret";
const CORE_SECRET: &str = "voice-core-fixture-secret";

struct EnvRestore(Vec<(&'static str, Option<String>)>);
impl EnvRestore {
    fn set(values: &[(&'static str, String)]) -> Self {
        let old = values
            .iter()
            .map(|(name, _)| (*name, std::env::var(name).ok()))
            .collect();
        for (name, value) in values {
            std::env::set_var(name, value);
        }
        Self(old)
    }
}
impl Drop for EnvRestore {
    fn drop(&mut self) {
        for (name, value) in &self.0 {
            if let Some(value) = value {
                std::env::set_var(name, value);
            } else {
                std::env::remove_var(name);
            }
        }
    }
}

struct CoreFixture {
    tickets: Mutex<HashMap<String, String>>,
    turns: Mutex<HashMap<String, usize>>,
    starts: tokio::sync::mpsc::UnboundedSender<(String, usize, Option<String>)>,
    /// Every `start` frame Core received, in order, for assertions on fields
    /// the `starts` summary does not carry.
    start_frames: Mutex<Vec<Value>>,
}

async fn issue_fixture_ticket(
    State(state): State<Arc<CoreFixture>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    assert_eq!(
        headers.get(header::AUTHORIZATION).unwrap(),
        format!("Bearer {CORE_SECRET}").as_str()
    );
    assert_eq!(body["route"], "voice");
    let conversation = body["roomId"].as_str().unwrap().to_owned();
    let ticket = uuid::Uuid::new_v4().simple().to_string();
    state
        .tickets
        .lock()
        .unwrap()
        .insert(ticket.clone(), conversation);
    Json(serde_json::json!({ "ticket": ticket, "expires_in": 60 })).into_response()
}

async fn fixture_voice(
    ws: WebSocketUpgrade,
    State(state): State<Arc<CoreFixture>>,
    uri: Uri,
) -> Response {
    let query = uri.query().unwrap();
    assert!(!query.contains("token="));
    assert!(!query.contains(CORE_SECRET));
    let ticket = query.strip_prefix("ticket=").unwrap();
    let conversation = state.tickets.lock().unwrap().remove(ticket).unwrap();
    ws.on_upgrade(move |mut socket| async move {
        let Message::Text(start) = socket.recv().await.unwrap().unwrap() else {
            panic!("expected Core start")
        };
        let start: Value = serde_json::from_str(&start).unwrap();
        assert_eq!(start["conversation_id"], conversation);
        let prior = state
            .turns
            .lock()
            .unwrap()
            .get(&conversation)
            .copied()
            .unwrap_or(0);
        let agent = start["agent_id"].as_str().map(str::to_owned);
        state.start_frames.lock().unwrap().push(start.clone());
        state
            .starts
            .send((conversation.clone(), prior, agent))
            .unwrap();
        while let Some(Ok(frame)) = socket.recv().await {
            if matches!(frame, Message::Binary(_)) {
                *state
                    .turns
                    .lock()
                    .unwrap()
                    .entry(conversation.clone())
                    .or_default() += 1;
                socket
                    .send(Message::Text(
                        serde_json::json!({ "type": "stop_playback" }).to_string(),
                    ))
                    .await
                    .unwrap();
            } else if matches!(&frame, Message::Text(text) if serde_json::from_str::<Value>(text).is_ok_and(|value| value["type"] == "summary")) {
                socket.send(Message::Text(serde_json::json!({ "type": "error", "message": "fixture summary complete" }).to_string())).await.unwrap();
            } else if matches!(frame, Message::Close(_)) {
                break;
            }
        }
    })
    .into_response()
}

fn signature(url: &str, params: &BTreeMap<String, String>) -> String {
    let mut mac = HmacSha1::new_from_slice(PROVIDER_SECRET.as_bytes()).unwrap();
    mac.update(url.as_bytes());
    for (name, value) in params {
        mac.update(name.as_bytes());
        mac.update(value.as_bytes());
    }
    BASE64.encode(mac.finalize().into_bytes())
}

fn xml_parameter(xml: &str, name: &str) -> String {
    let marker = format!("name=\"{name}\" value=\"");
    xml.split_once(&marker)
        .unwrap()
        .1
        .split_once('"')
        .unwrap()
        .0
        .to_owned()
}

async fn answer(
    client: &reqwest::Client,
    gateway: std::net::SocketAddr,
    call: Option<&str>,
    from: Option<&str>,
) -> reqwest::Response {
    let mut params = BTreeMap::from([
        ("AccountSid".to_owned(), ACCOUNT.to_owned()),
        ("To".to_owned(), "+15550001111".to_owned()),
    ]);
    if let Some(call) = call {
        params.insert("CallSid".to_owned(), call.to_owned());
    }
    if let Some(from) = from {
        params.insert("From".to_owned(), from.to_owned());
    }
    let signed = signature("https://voice.example.test/voice/twilio/answer", &params);
    client
        .post(format!("http://{gateway}{ANSWER_PATH}"))
        .header("x-twilio-signature", signed)
        .form(&params)
        .send()
        .await
        .unwrap()
}

async fn stream(
    gateway: std::net::SocketAddr,
    call: &str,
    binding: &str,
    override_conversation: &str,
) -> tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>> {
    let mut request = format!("ws://{gateway}{STREAM_PATH}")
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "x-twilio-signature",
        signature(
            "wss://voice.example.test/voice/twilio/stream",
            &BTreeMap::new(),
        )
        .parse()
        .unwrap(),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    socket
        .send(CoreMessage::Text(
            serde_json::json!({ "event": "connected", "protocol": "Call", "version": "1.0.0" })
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    // Preserve WebSocket liveness while waiting for the provider's start frame.
    socket.send(CoreMessage::Ping(vec![1, 2, 3])).await.unwrap();
    let pong = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(pong, CoreMessage::Pong(payload) if payload == vec![1, 2, 3]));
    let start = serde_json::json!({
        "event": "start", "sequenceNumber": "1", "streamSid": "MZfixture",
        "start": { "accountSid": ACCOUNT, "callSid": call, "streamSid": "MZfixture", "tracks": ["inbound"],
            "mediaFormat": { "encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1 },
            "customParameters": { "conversationId": override_conversation, "callBinding": binding, "agentId": "attacker-agent", "lineId": "fixture", "callKind": "inbound", "callerNumber": "+15551234567" }
        }
    });
    socket
        .send(CoreMessage::Text(start.to_string().into()))
        .await
        .unwrap();
    socket
}

struct RunningServers(Vec<tokio::task::JoinHandle<()>>);
impl Drop for RunningServers {
    fn drop(&mut self) {
        for handle in &self.0 {
            handle.abort();
        }
    }
}

/// An inbound call is refused before any speech, model or voice work when the
/// caller is outside the line's allowlist, and answered busy once the line is
/// at its simultaneous-call cap, counting calls already answered whose media
/// streams have not opened yet.
#[tokio::test]
async fn inbound_answer_enforces_caller_allowlist_and_line_call_cap() {
    let _guard =
        crate::config::test_config_path::ConfigPathGuard::isolated("voice-caller-controls");
    let mut config = GatewayConfig::default();
    config.channels.phone_calls.enabled = true;
    config.channels.phone_calls.lines = vec![crate::config::PhoneCallLineConfig {
        id: "fixture".into(),
        label: "Fixture".into(),
        twilio_number: "+15550001111".into(),
        allowed_callers: vec!["+15551234567".into()],
        max_concurrent_calls: Some(1),
        ..Default::default()
    }];
    config.save().unwrap();
    let gateway_state = Arc::new(crate::state::AppState::new_for_test_default());
    let _env = EnvRestore::set(&[
        (TWILIO_AUTH_TOKEN_ENV, PROVIDER_SECRET.to_owned()),
        (PUBLIC_URL_ENV, "https://voice.example.test".to_owned()),
        (CORE_URL_ENV, "http://127.0.0.1:9".to_owned()),
        (CORE_TOKEN_ENV, CORE_SECRET.to_owned()),
    ]);
    let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = gateway_listener.local_addr().unwrap();
    let routes = Router::new()
        .route(ANSWER_PATH, post(twilio_answer))
        .with_state(gateway_state.clone());
    let gateway_task = tokio::spawn(async move {
        axum::serve(gateway_listener, routes).await.unwrap();
    });
    let _servers = RunningServers(vec![gateway_task]);
    let client = reqwest::Client::new();

    let unlisted = answer(&client, gateway, Some(ATTACK_CALL), Some("+15559876543"))
        .await
        .text()
        .await
        .unwrap();
    assert!(
        unlisted.contains("<Reject reason=\"rejected\"/>") && !unlisted.contains("<Connect>"),
        "an unlisted caller must be rejected: {unlisted}"
    );

    // Two listed callers ring the one-slot line at once. Neither stream has
    // opened, so only an admission held from the webhook keeps the second out.
    let (first, second) = tokio::join!(
        answer(&client, gateway, Some(VICTIM_CALL), Some("+15551234567")),
        answer(&client, gateway, Some(ATTACK_CALL), Some("+15551234567")),
    );
    let first = first.text().await.unwrap();
    let second = second.text().await.unwrap();
    let connected = [&first, &second]
        .into_iter()
        .filter(|xml| xml.contains("<Connect>"))
        .count();
    let busy = [&first, &second]
        .into_iter()
        .filter(|xml| xml.contains("<Reject reason=\"busy\"/>") && !xml.contains("<Connect>"))
        .count();
    assert_eq!(
        (connected, busy),
        (1, 1),
        "one racing call is answered and the other hears busy: {first} | {second}"
    );

    let answered = if first.contains("<Connect>") {
        VICTIM_CALL
    } else {
        ATTACK_CALL
    };
    let retry = answer(&client, gateway, Some(answered), Some("+15551234567"))
        .await
        .text()
        .await
        .unwrap();
    assert!(
        retry.contains("<Connect>"),
        "a retried webhook for the answered call keeps its slot: {retry}"
    );
    assert!(
        !gateway_state
            .phone_calls
            .try_reserve("CA2123456789abcdef0123456789abcdef", "fixture", 1)
            .await,
        "the answered call still holds the line's only slot"
    );
}

fn save_fixture_line(allowed_callers: Vec<String>) {
    let mut config = GatewayConfig::default();
    config.channels.phone_calls.enabled = true;
    config.channels.phone_calls.lines = vec![crate::config::PhoneCallLineConfig {
        id: "fixture".into(),
        twilio_number: "+15550001111".into(),
        allowed_callers,
        ..Default::default()
    }];
    config.save().unwrap();
}

/// Caller trust reaches Core as data, not only as prompt text: a caller the
/// line does not list opens Core's voice session with `caller_trusted: false`,
/// and the same caller, once listed, opens the owner's normal session.
#[tokio::test]
async fn inbound_start_frame_carries_caller_trust_to_core() {
    let _guard = crate::config::test_config_path::ConfigPathGuard::isolated("voice-caller-trust");
    save_fixture_line(Vec::new());
    let gateway_state = Arc::new(crate::state::AppState::new_for_test_default());
    let (tx, mut starts) = tokio::sync::mpsc::unbounded_channel();
    let state = Arc::new(CoreFixture {
        tickets: Mutex::new(HashMap::new()),
        turns: Mutex::new(HashMap::new()),
        starts: tx,
        start_frames: Mutex::new(Vec::new()),
    });
    let core_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let core_address = core_listener.local_addr().unwrap();
    let core_router = Router::new()
        .route("/api/ws/ticket", post(issue_fixture_ticket))
        .route("/api/voice/ws", get(fixture_voice))
        .with_state(state.clone());
    let core_task = tokio::spawn(async move {
        axum::serve(core_listener, core_router).await.unwrap();
    });
    let _env = EnvRestore::set(&[
        (TWILIO_AUTH_TOKEN_ENV, PROVIDER_SECRET.to_owned()),
        (PUBLIC_URL_ENV, "https://voice.example.test".to_owned()),
        (CORE_URL_ENV, format!("http://{core_address}")),
        (CORE_TOKEN_ENV, CORE_SECRET.to_owned()),
    ]);
    let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = gateway_listener.local_addr().unwrap();
    let routes = Router::new()
        .route(ANSWER_PATH, post(twilio_answer))
        .route(STREAM_PATH, get(twilio_stream))
        .with_state(gateway_state);
    let gateway_task = tokio::spawn(async move {
        axum::serve(gateway_listener, routes).await.unwrap();
    });
    let _servers = RunningServers(vec![core_task, gateway_task]);
    let client = reqwest::Client::new();

    // No allowlist: the caller reaches the assistant but is not listed.
    let unlisted = answer(&client, gateway, Some(VICTIM_CALL), Some("+15551234567"))
        .await
        .text()
        .await
        .unwrap();
    let unlisted_conversation = xml_parameter(&unlisted, "conversationId");
    let mut call = stream(
        gateway,
        VICTIM_CALL,
        &xml_parameter(&unlisted, "callBinding"),
        "ignored",
    )
    .await;
    let (conversation, _, _) =
        tokio::time::timeout(std::time::Duration::from_secs(5), starts.recv())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(conversation, unlisted_conversation);
    let frame = state.start_frames.lock().unwrap().last().cloned().unwrap();
    assert_eq!(
        frame["caller_trusted"],
        Value::Bool(false),
        "an unlisted caller's session must be marked untrusted: {frame}"
    );
    call.close(None).await.unwrap();

    // The same caller, now on the line's allowlist, is trusted.
    save_fixture_line(vec!["+15551234567".into()]);
    let listed = answer(&client, gateway, Some(ATTACK_CALL), Some("+15551234567"))
        .await
        .text()
        .await
        .unwrap();
    let listed_conversation = xml_parameter(&listed, "conversationId");
    let mut call = stream(
        gateway,
        ATTACK_CALL,
        &xml_parameter(&listed, "callBinding"),
        "ignored",
    )
    .await;
    let (conversation, _, _) =
        tokio::time::timeout(std::time::Duration::from_secs(5), starts.recv())
            .await
            .unwrap()
            .unwrap();
    assert_eq!(conversation, listed_conversation);
    let frame = state.start_frames.lock().unwrap().last().cloned().unwrap();
    assert!(
        frame.get("caller_trusted").is_none(),
        "a listed caller opens the owner's normal session: {frame}"
    );
    call.close(None).await.unwrap();
}

#[tokio::test]
async fn signed_callbacks_and_media_streams_isolate_calls_and_preserve_same_call_turns() {
    let _guard = crate::config::test_config_path::ConfigPathGuard::isolated("voice-security");
    let mut config = GatewayConfig::default();
    config.channels.phone_calls.enabled = true;
    config.channels.phone_calls.lines = vec![crate::config::PhoneCallLineConfig {
        id: "fixture".into(),
        twilio_number: "+15550001111".into(),
        agent_id: Some("configured-agent".into()),
        ..Default::default()
    }];
    config.save().unwrap();
    let gateway_state = Arc::new(crate::state::AppState::new_for_test_default());
    let (tx, mut starts) = tokio::sync::mpsc::unbounded_channel();
    let old_phone = format!(
        "phone_{}",
        &hex::encode(Sha256::digest(b"+15551234567"))[..24]
    );
    let state = Arc::new(CoreFixture {
        tickets: Mutex::new(HashMap::new()),
        turns: Mutex::new(HashMap::from([(old_phone.clone(), 99)])),
        starts: tx,
        start_frames: Mutex::new(Vec::new()),
    });
    let core_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let core_address = core_listener.local_addr().unwrap();
    let core_router = Router::new()
        .route("/api/ws/ticket", post(issue_fixture_ticket))
        .route("/api/voice/ws", get(fixture_voice))
        .with_state(state.clone());
    let core_task = tokio::spawn(async move {
        axum::serve(core_listener, core_router).await.unwrap();
    });
    let _env = EnvRestore::set(&[
        (TWILIO_AUTH_TOKEN_ENV, PROVIDER_SECRET.to_owned()),
        (PUBLIC_URL_ENV, "https://voice.example.test".to_owned()),
        (CORE_URL_ENV, format!("http://{core_address}")),
        (CORE_TOKEN_ENV, CORE_SECRET.to_owned()),
        (AGENT_ID_ENV, "configured-agent".to_owned()),
    ]);
    let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gateway = gateway_listener.local_addr().unwrap();
    let routes = Router::new()
        .route(ANSWER_PATH, post(twilio_answer))
        .route(STREAM_PATH, get(twilio_stream))
        .with_state(gateway_state);
    let gateway_task = tokio::spawn(async move {
        axum::serve(gateway_listener, routes).await.unwrap();
    });
    let _servers = RunningServers(vec![core_task, gateway_task]);
    let client = reqwest::Client::new();

    let unsigned = client
        .post(format!("http://{gateway}{ANSWER_PATH}"))
        .form(&BTreeMap::from([
            ("AccountSid", ACCOUNT),
            ("CallSid", VICTIM_CALL),
        ]))
        .send()
        .await
        .unwrap();
    assert_eq!(unsigned.status(), StatusCode::UNAUTHORIZED);
    let unsigned_stream = format!("ws://{gateway}{STREAM_PATH}")
        .into_client_request()
        .unwrap();
    let Err(tokio_tungstenite::tungstenite::Error::Http(response)) =
        connect_async(unsigned_stream).await
    else {
        panic!("unsigned stream upgraded")
    };
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let first = answer(&client, gateway, Some(VICTIM_CALL), Some("+15551234567")).await;
    assert_eq!(first.status(), StatusCode::OK);
    let first = first.text().await.unwrap();
    let victim_conversation = xml_parameter(&first, "conversationId");
    let victim_binding = xml_parameter(&first, "callBinding");
    assert_ne!(victim_conversation, old_phone);
    for from in [None, Some(""), Some("anonymous"), Some("+15559876543")] {
        let retry = answer(&client, gateway, Some(VICTIM_CALL), from)
            .await
            .text()
            .await
            .unwrap();
        assert_eq!(xml_parameter(&retry, "conversationId"), victim_conversation);
        let caller = from
            .filter(|value| is_e164_phone_number(value))
            .unwrap_or("unknown");
        assert_eq!(
            xml_parameter(&retry, "callBinding"),
            stream_binding(
                ACCOUNT,
                VICTIM_CALL,
                PROVIDER_SECRET,
                "fixture",
                "inbound",
                Some(caller)
            )
        );
    }
    for bad in [
        None,
        Some(""),
        Some("unknown-call"),
        Some("CA123"),
        Some(" CA0123456789abcdef0123456789abcdef"),
    ] {
        assert_eq!(
            answer(&client, gateway, bad, Some("+15551234567"))
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let second = answer(&client, gateway, Some(ATTACK_CALL), Some("+15551234567"))
        .await
        .text()
        .await
        .unwrap();
    let attacker_conversation = xml_parameter(&second, "conversationId");
    let attacker_binding = xml_parameter(&second, "callBinding");
    assert_ne!(victim_conversation, attacker_conversation);
    for from in [None, Some(""), Some("anonymous")] {
        let hidden_caller = answer(&client, gateway, Some(ATTACK_CALL), from)
            .await
            .text()
            .await
            .unwrap();
        assert_eq!(
            xml_parameter(&hidden_caller, "conversationId"),
            attacker_conversation
        );
        assert_ne!(
            xml_parameter(&hidden_caller, "conversationId"),
            victim_conversation
        );
    }

    let mut victim = stream(gateway, VICTIM_CALL, &victim_binding, &old_phone).await;
    let start = tokio::time::timeout(std::time::Duration::from_secs(5), starts.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        start,
        (
            victim_conversation.clone(),
            0,
            Some("configured-agent".to_owned())
        )
    );
    for n in 0..2 {
        let media = serde_json::json!({ "event": "media", "sequenceNumber": (n + 2).to_string(), "streamSid": "MZfixture", "media": { "track": "inbound", "chunk": (n + 1).to_string(), "timestamp": "0", "payload": BASE64.encode([0xff; 160]) } });
        victim
            .send(CoreMessage::Text(media.to_string().into()))
            .await
            .unwrap();
        let reply = tokio::time::timeout(std::time::Duration::from_secs(5), victim.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(reply.into_text().unwrap().contains("\"clear\""));
    }
    victim.send(CoreMessage::Text(serde_json::json!({ "event": "stop", "sequenceNumber": "4", "streamSid": "MZfixture", "stop": { "accountSid": ACCOUNT, "callSid": VICTIM_CALL } }).to_string().into())).await.unwrap();
    let stopped = tokio::time::timeout(std::time::Duration::from_secs(5), victim.next())
        .await
        .unwrap();
    assert!(matches!(
        stopped,
        None | Some(Err(_)) | Some(Ok(CoreMessage::Close(_)))
    ));
    let mut reconnect = stream(gateway, VICTIM_CALL, &victim_binding, "human-conversation").await;
    let start = tokio::time::timeout(std::time::Duration::from_secs(5), starts.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(start.0, victim_conversation);
    assert_eq!(start.1, 2);
    reconnect.close(None).await.unwrap();
    let mut attacker = stream(
        gateway,
        ATTACK_CALL,
        &attacker_binding,
        &victim_conversation,
    )
    .await;
    let start = tokio::time::timeout(std::time::Duration::from_secs(5), starts.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(start.0, attacker_conversation);
    assert_eq!(start.1, 0);
    attacker.close(None).await.unwrap();
    // A URL-signed upgrade cannot alter the answer-issued identity or restore a
    // previous conversation through custom parameters.
    for (call, binding) in [
        (VICTIM_CALL, attacker_binding.as_str()),
        (ATTACK_CALL, ""),
        ("unknown-call", attacker_binding.as_str()),
    ] {
        let mut invalid = stream(gateway, call, binding, &victim_conversation).await;
        let closed = tokio::time::timeout(std::time::Duration::from_secs(5), invalid.next())
            .await
            .unwrap();
        assert!(matches!(
            closed,
            None | Some(Err(_)) | Some(Ok(CoreMessage::Close(_)))
        ));
        assert!(starts.try_recv().is_err());
    }
    assert_eq!(state.turns.lock().unwrap().get(&old_phone), Some(&99));
    assert!(state.tickets.lock().unwrap().is_empty());
}

const MASTER_KEY: &str = "voice-gateway-fixture-master";

/// A stand-in for Twilio's REST API. It records every request and answers the
/// Calls API with a fresh Call SID, or with `calls_status` when that is not a
/// success.
struct TwilioApiFixture {
    requests: Mutex<Vec<(String, String)>>,
    calls_status: Mutex<StatusCode>,
    placed: std::sync::atomic::AtomicUsize,
    /// When set, each caller-ID lookup records how many slots the fixture
    /// line held while Twilio was being asked.
    observed_hub: Mutex<Option<crate::phone_calls::PhoneCallHub>>,
    slots_during_caller_id_lookup: Mutex<Vec<usize>>,
}

impl TwilioApiFixture {
    fn requests(&self) -> Vec<(String, String)> {
        self.requests.lock().unwrap().clone()
    }

    fn last_form(&self) -> String {
        self.requests.lock().unwrap().last().unwrap().1.clone()
    }

    fn answer_calls_with(&self, status: StatusCode) {
        *self.calls_status.lock().unwrap() = status;
    }
}

async fn fixture_twilio_api(
    State(state): State<Arc<TwilioApiFixture>>,
    uri: Uri,
    body: String,
) -> Response {
    state
        .requests
        .lock()
        .unwrap()
        .push((uri.path().to_owned(), body));
    if uri.path().ends_with("/OutgoingCallerIds.json") {
        let hub = state.observed_hub.lock().unwrap().clone();
        if let Some(hub) = hub {
            let held = hub
                .slots_held_on_line("fixture", std::time::Instant::now())
                .await;
            state
                .slots_during_caller_id_lookup
                .lock()
                .unwrap()
                .push(held);
        }
        return Json(serde_json::json!({ "outgoing_caller_ids": [] })).into_response();
    }
    let status = *state.calls_status.lock().unwrap();
    if !status.is_success() {
        return (
            status,
            Json(serde_json::json!({ "message": "fixture refusal" })),
        )
            .into_response();
    }
    let placed = state
        .placed
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "sid": format!("CA{placed:032x}"), "status": "queued" })),
    )
        .into_response()
}

/// Fields drop in order, so the config window closes last.
struct OutboundFixture {
    state: crate::state::SharedState,
    twilio: Arc<TwilioApiFixture>,
    _servers: RunningServers,
    _env: EnvRestore,
    _guard: crate::config::test_config_path::ConfigPathGuard,
}

/// A Gateway with one phone line that carries a single call at a time, whose
/// Twilio REST requests reach [`TwilioApiFixture`].
async fn outbound_fixture(tag: &str) -> OutboundFixture {
    let guard = crate::config::test_config_path::ConfigPathGuard::isolated(tag);
    let mut config = GatewayConfig::default();
    config.channels.phone_calls.enabled = true;
    config.channels.phone_calls.lines = vec![crate::config::PhoneCallLineConfig {
        id: "fixture".into(),
        label: "Fixture".into(),
        twilio_number: "+15550001111".into(),
        max_concurrent_calls: Some(1),
        ..Default::default()
    }];
    config.save().unwrap();
    let twilio = Arc::new(TwilioApiFixture {
        requests: Mutex::new(Vec::new()),
        calls_status: Mutex::new(StatusCode::CREATED),
        placed: std::sync::atomic::AtomicUsize::new(0),
        observed_hub: Mutex::new(None),
        slots_during_caller_id_lookup: Mutex::new(Vec::new()),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .fallback(fixture_twilio_api)
        .with_state(twilio.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let env = EnvRestore::set(&[
        ("RYU_TWILIO_ACCOUNT_SID", ACCOUNT.to_owned()),
        (TWILIO_AUTH_TOKEN_ENV, PROVIDER_SECRET.to_owned()),
        (PUBLIC_URL_ENV, "https://voice.example.test".to_owned()),
        (CORE_URL_ENV, "http://127.0.0.1:9".to_owned()),
        (CORE_TOKEN_ENV, CORE_SECRET.to_owned()),
        (
            crate::api::phone_calls::TWILIO_API_ORIGIN_TEST_ENV,
            format!("http://{address}"),
        ),
    ]);
    let gateway_config = GatewayConfig {
        auth: crate::config::AuthConfig {
            require_auth: true,
            master_key: Some(MASTER_KEY.to_owned()),
            api_keys: Vec::new(),
        },
        ..GatewayConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    OutboundFixture {
        state: Arc::new(crate::state::AppState::new_for_test(
            gateway_config,
            audit,
            evals,
        )),
        twilio,
        _servers: RunningServers(vec![task]),
        _env: env,
        _guard: guard,
    }
}

type StartCallResult = Result<
    (
        StatusCode,
        Json<crate::api::phone_calls::StartPhoneCallResponse>,
    ),
    crate::error::GatewayError,
>;

async fn start_outbound(state: &crate::state::SharedState, key: &str) -> StartCallResult {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {MASTER_KEY}").parse().unwrap(),
    );
    crate::api::phone_calls::start_call(
        State(state.clone()),
        axum::extract::ConnectInfo("127.0.0.1:5".parse().unwrap()),
        headers,
        Json(crate::api::phone_calls::StartPhoneCallRequest {
            idempotency_key: key.to_owned(),
            line_id: "fixture".to_owned(),
            to: "+15557654321".to_owned(),
            goal: "Confirm Friday".to_owned(),
        }),
    )
    .await
}

fn is_line_busy(result: &StartCallResult) -> bool {
    matches!(
        result,
        Err(crate::error::GatewayError::Overloaded(message))
            if message == crate::api::phone_calls::PHONE_LINE_BUSY
    )
}

fn placed_call_sid(result: StartCallResult) -> String {
    let (status, Json(body)) = result.unwrap();
    assert_eq!(status, StatusCode::CREATED);
    serde_json::to_value(body).unwrap()["callSid"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn form_value(form: &str, name: &str) -> Option<String> {
    reqwest::Url::parse(&format!("http://form.invalid/?{form}"))
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// The intent id Gateway gave Twilio in the placed call's status callback URL.
fn status_intent(form: &str) -> String {
    form_value(form, "StatusCallback")
        .unwrap()
        .rsplit('/')
        .next()
        .unwrap()
        .to_owned()
}

async fn status_callback(
    state: &crate::state::SharedState,
    intent_id: &str,
    call_sid: &str,
    call_status: &str,
) -> StatusCode {
    let params = BTreeMap::from([
        ("AccountSid".to_owned(), ACCOUNT.to_owned()),
        ("CallSid".to_owned(), call_sid.to_owned()),
        ("CallStatus".to_owned(), call_status.to_owned()),
    ]);
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-twilio-signature",
        signature(
            &format!("https://voice.example.test{OUTBOUND_STATUS_PATH}/{intent_id}"),
            &params,
        )
        .parse()
        .unwrap(),
    );
    twilio_status(
        State(state.clone()),
        Path(intent_id.to_owned()),
        headers,
        Form(params),
    )
    .await
    .status()
}

async fn held_slots(state: &crate::state::SharedState) -> usize {
    state
        .phone_calls
        .slots_held_on_line("fixture", std::time::Instant::now())
        .await
}

/// An outbound call on a line already at its simultaneous-call cap, whether
/// the slot is held by a live call or by an answered inbound call whose stream
/// has not opened, is refused before any request reaches Twilio.
#[tokio::test]
async fn outbound_start_on_a_full_line_never_reaches_twilio() {
    let fixture = outbound_fixture("voice-outbound-full-line").await;
    let (control_tx, _control_rx) = tokio::sync::mpsc::channel(1);
    assert!(
        fixture
            .state
            .phone_calls
            .try_register(VICTIM_CALL.into(), "fixture".into(), control_tx.clone(), 1)
            .await
    );
    let busy = start_outbound(&fixture.state, "outbound-request-0001").await;
    assert!(is_line_busy(&busy), "a live call holds the slot: {busy:?}");
    // A busy line is a temporary capacity refusal, not invalid input.
    let response = axum::response::IntoResponse::into_response(busy.unwrap_err());
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        body["error"]["message"],
        crate::api::phone_calls::PHONE_LINE_BUSY
    );
    fixture.state.phone_calls.remove(VICTIM_CALL).await;

    assert!(
        fixture
            .state
            .phone_calls
            .try_reserve(ATTACK_CALL, "fixture", 1)
            .await
    );
    let busy = start_outbound(&fixture.state, "outbound-request-0001").await;
    assert!(
        is_line_busy(&busy),
        "an answered inbound call holds the slot: {busy:?}"
    );
    assert!(
        fixture.twilio.requests().is_empty(),
        "a refused outbound call never reaches Twilio"
    );
    assert!(
        fixture
            .state
            .phone_calls
            .try_register(ATTACK_CALL.into(), "fixture".into(), control_tx, 1)
            .await
    );
    fixture.state.phone_calls.remove(ATTACK_CALL).await;

    placed_call_sid(start_outbound(&fixture.state, "outbound-request-0001").await);
    let requests = fixture.twilio.requests();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert!(requests[0].0.ends_with("/Calls.json"));
    assert_eq!(
        form_value(&requests[0].1, "Timeout").as_deref(),
        Some("60"),
        "the ring timeout bounds how long the call holds its slot"
    );
}

/// An unverified caller ID is refused before the request is journaled or
/// takes a slot, so a retry with the same key during the Twilio lookup is
/// never told the call is pending, and the retry after the refusal is
/// refused the same way.
#[tokio::test]
async fn unverified_caller_id_is_refused_before_the_request_is_recorded() {
    let fixture = outbound_fixture("voice-outbound-caller-id").await;
    let mut config = GatewayConfig::default();
    config.channels.phone_calls.enabled = true;
    config.channels.phone_calls.lines = vec![crate::config::PhoneCallLineConfig {
        id: "fixture".into(),
        label: "Fixture".into(),
        twilio_number: "+15550001111".into(),
        caller_id: "+15550002222".into(),
        max_concurrent_calls: Some(1),
        ..Default::default()
    }];
    config.save().unwrap();
    *fixture.twilio.observed_hub.lock().unwrap() = Some(fixture.state.phone_calls.clone());

    for _ in 0..2 {
        let refused = start_outbound(&fixture.state, "outbound-request-0001").await;
        assert!(
            matches!(
                &refused,
                Err(crate::error::GatewayError::BadRequest(message))
                    if message == "verify this caller ID with Twilio before placing outbound calls"
            ),
            "{refused:?}"
        );
    }
    assert_eq!(
        *fixture.twilio.slots_during_caller_id_lookup.lock().unwrap(),
        vec![0, 0],
        "nothing is recorded while Twilio is asked about the caller ID"
    );
    assert_eq!(held_slots(&fixture.state).await, 0);
    assert!(
        fixture
            .twilio
            .requests()
            .iter()
            .all(|(path, _)| path.ends_with("/OutgoingCallerIds.json")),
        "no call is placed"
    );
}

/// Two outbound calls racing for a line's last slot: exactly one reaches
/// Twilio. A repeated request takes no second slot, and the placed call's slot
/// becomes its live call when its media stream starts.
#[tokio::test]
async fn racing_outbound_starts_place_exactly_one_call() {
    let fixture = outbound_fixture("voice-outbound-race").await;
    let (first, second) = tokio::join!(
        start_outbound(&fixture.state, "outbound-request-000a"),
        start_outbound(&fixture.state, "outbound-request-000b"),
    );
    let (placed, key) = match (first, second) {
        (placed @ Ok(_), busy) if is_line_busy(&busy) => (placed, "outbound-request-000a"),
        (busy, placed @ Ok(_)) if is_line_busy(&busy) => (placed, "outbound-request-000b"),
        other => panic!("exactly one racing call is placed: {other:?}"),
    };
    let call_sid = placed_call_sid(placed);
    assert_eq!(
        fixture.twilio.requests().len(),
        1,
        "only the call holding the slot reaches Twilio"
    );

    let (status, _) = start_outbound(&fixture.state, key).await.unwrap();
    assert_eq!(
        status,
        StatusCode::OK,
        "a repeated request reports the call"
    );
    assert_eq!(fixture.twilio.requests().len(), 1);
    assert_eq!(held_slots(&fixture.state).await, 1);

    let (control_tx, _control_rx) = tokio::sync::mpsc::channel(1);
    assert!(
        fixture
            .state
            .phone_calls
            .try_register(call_sid, "fixture".into(), control_tx, 1)
            .await,
        "the placed call's stream takes over its own slot"
    );
    assert_eq!(
        held_slots(&fixture.state).await,
        1,
        "the live call is counted once"
    );
    let busy = start_outbound(&fixture.state, "outbound-request-000c").await;
    assert!(is_line_busy(&busy), "{busy:?}");
}

/// A call Twilio refuses gives its slot back at once. A call whose outcome is
/// unknown keeps it until a terminal status callback arrives, which also frees
/// the slot of a call that rang out without a media stream.
#[tokio::test]
async fn refused_or_unanswered_outbound_call_frees_the_line() {
    let fixture = outbound_fixture("voice-outbound-cleanup").await;

    fixture.twilio.answer_calls_with(StatusCode::BAD_REQUEST);
    let refused = start_outbound(&fixture.state, "outbound-request-0001").await;
    assert!(
        matches!(refused, Err(crate::error::GatewayError::ProviderError(_))),
        "{refused:?}"
    );
    assert_eq!(
        held_slots(&fixture.state).await,
        0,
        "a call Twilio refused frees its slot"
    );

    fixture
        .twilio
        .answer_calls_with(StatusCode::SERVICE_UNAVAILABLE);
    let uncertain = start_outbound(&fixture.state, "outbound-request-0002").await;
    assert!(
        matches!(uncertain, Err(crate::error::GatewayError::ProviderError(_))),
        "{uncertain:?}"
    );
    assert_eq!(
        held_slots(&fixture.state).await,
        1,
        "a call Twilio may have placed keeps its slot"
    );
    let (status, _) = start_outbound(&fixture.state, "outbound-request-0002")
        .await
        .unwrap();
    assert_eq!(status, StatusCode::ACCEPTED);
    assert_eq!(held_slots(&fixture.state).await, 1);
    let intent_id = status_intent(&fixture.twilio.last_form());
    let lost_call = "CA2123456789abcdef0123456789abcdef";
    assert_eq!(
        status_callback(&fixture.state, &intent_id, lost_call, "ringing").await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        held_slots(&fixture.state).await,
        1,
        "a ringing call keeps its slot"
    );
    assert_eq!(
        status_callback(&fixture.state, &intent_id, lost_call, "failed").await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(held_slots(&fixture.state).await, 0);

    fixture.twilio.answer_calls_with(StatusCode::CREATED);
    let call_sid = placed_call_sid(start_outbound(&fixture.state, "outbound-request-0003").await);
    let intent_id = status_intent(&fixture.twilio.last_form());
    assert_eq!(held_slots(&fixture.state).await, 1);
    assert_eq!(
        status_callback(&fixture.state, &intent_id, &call_sid, "no-answer").await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        held_slots(&fixture.state).await,
        0,
        "a call that rang out without a stream frees its slot"
    );
    placed_call_sid(start_outbound(&fixture.state, "outbound-request-0004").await);
}

#[path = "phone_calls_live_test.rs"]
mod phone_calls_live;
#[path = "phone_calls_numbers_test.rs"]
mod phone_calls_numbers;
