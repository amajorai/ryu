//! Live phone-call controls (`/v1/phone-calls/:call_sid/{control,handoff}`)
//! and the signed outbound answer webhook, driven through the real handlers
//! against a recording stand-in for Twilio's REST API.

use super::*;

pub(super) const LINE_NUMBER: &str = "+15550001111";
pub(super) const LINE_CALLER_ID: &str = "+15550002222";
pub(super) const LINE_TRANSFER: &str = "+15550003333";
const RELAY_KEY: &str = "voice-relay-fixture-key";

/// One request the Twilio stand-in received: method, path, query and body.
#[derive(Clone, Debug)]
pub(super) struct TwilioRequest {
    pub method: String,
    pub path: String,
    pub query: String,
    pub body: String,
}

/// A Twilio REST stand-in that answers each resource the phone API reads.
pub(super) struct TwilioRestFake {
    pub requests: Mutex<Vec<TwilioRequest>>,
    pub calls: Mutex<Value>,
}

impl TwilioRestFake {
    pub fn requests(&self) -> Vec<TwilioRequest> {
        self.requests.lock().unwrap().clone()
    }
}

async fn twilio_rest_fake(
    State(fake): State<Arc<TwilioRestFake>>,
    method: axum::http::Method,
    uri: Uri,
    body: String,
) -> Response {
    let path = uri.path().to_owned();
    fake.requests.lock().unwrap().push(TwilioRequest {
        method: method.to_string(),
        path: path.clone(),
        query: uri.query().unwrap_or_default().to_owned(),
        body: body.clone(),
    });
    let reply = if path.ends_with("/OutgoingCallerIds.json") {
        serde_json::json!({ "outgoing_caller_ids": [{ "phone_number": LINE_CALLER_ID }] })
    } else if path.ends_with("/Calls.json") && method == axum::http::Method::GET {
        fake.calls.lock().unwrap().clone()
    } else if path.contains("/AvailablePhoneNumbers/") {
        serde_json::json!({ "available_phone_numbers": [{ "phone_number": "+14155550199", "friendly_name": "(415) 555-0199", "locality": "San Francisco", "region": "CA" }] })
    } else if path.ends_with("/IncomingPhoneNumbers.json") {
        let number = form_value(&body, "PhoneNumber").unwrap_or_default();
        return (
            StatusCode::CREATED,
            Json(serde_json::json!({ "sid": "PN0123456789abcdef0123456789abcdef", "phone_number": number })),
        )
            .into_response();
    } else {
        serde_json::json!({ "status": "in-progress" })
    };
    Json(reply).into_response()
}

/// Fields drop in order, so the config window closes last.
pub(super) struct PhoneApiFixture {
    pub state: crate::state::SharedState,
    pub twilio: Arc<TwilioRestFake>,
    _servers: RunningServers,
    _env: EnvRestore,
    _guard: crate::config::test_config_path::ConfigPathGuard,
}

/// A master-key Gateway whose Twilio REST requests reach [`TwilioRestFake`].
/// An empty `account_sid` leaves Twilio unconfigured.
pub(super) async fn phone_api_fixture(
    tag: &str,
    lines: Vec<crate::config::PhoneCallLineConfig>,
    account_sid: &str,
) -> PhoneApiFixture {
    let guard = crate::config::test_config_path::ConfigPathGuard::isolated(tag);
    save_lines(true, lines);
    let twilio = Arc::new(TwilioRestFake {
        requests: Mutex::new(Vec::new()),
        calls: Mutex::new(serde_json::json!({ "calls": [] })),
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .fallback(twilio_rest_fake)
        .with_state(twilio.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let env = EnvRestore::set(&[
        ("RYU_TWILIO_ACCOUNT_SID", account_sid.to_owned()),
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
            api_keys: vec![crate::config::ApiKeyConfig {
                key: RELAY_KEY.to_owned(),
                name: "relay".to_owned(),
                allowed_operations: vec![crate::config::ApiKeyOperation::Inference],
                org_id: None,
                team_id: None,
                channel_id: None,
                project_id: None,
                requests_per_minute: None,
                tokens_per_minute: None,
                token_budget_total: None,
                downgrade_to: None,
                trusted_forwarder: false,
            }],
        },
        ..GatewayConfig::default()
    };
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    PhoneApiFixture {
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

pub(super) fn save_lines(enabled: bool, lines: Vec<crate::config::PhoneCallLineConfig>) {
    let mut config = GatewayConfig::default();
    config.channels.phone_calls.enabled = enabled;
    config.channels.phone_calls.lines = lines;
    config.save().unwrap();
}

pub(super) fn line(
    id: &str,
    twilio_number: &str,
    caller_id: &str,
    transfer_to: Option<&str>,
) -> crate::config::PhoneCallLineConfig {
    crate::config::PhoneCallLineConfig {
        id: id.into(),
        label: "Fixture".into(),
        twilio_number: twilio_number.into(),
        caller_id: caller_id.into(),
        transfer_to: transfer_to.map(str::to_owned),
        ..Default::default()
    }
}

pub(super) fn admin() -> HeaderMap {
    bearer(MASTER_KEY)
}

fn bearer(key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {key}").parse().unwrap(),
    );
    headers
}

pub(super) fn peer(address: &str) -> axum::extract::ConnectInfo<std::net::SocketAddr> {
    axum::extract::ConnectInfo(address.parse().unwrap())
}

pub(super) fn bad_request_message<T: std::fmt::Debug>(
    result: Result<T, crate::error::GatewayError>,
) -> String {
    match result {
        Err(crate::error::GatewayError::BadRequest(message)) => message,
        other => panic!("expected a 400: {other:?}"),
    }
}

async fn handoff(
    state: &crate::state::SharedState,
    from: &str,
    headers: HeaderMap,
    call_sid: &str,
) -> Result<Json<crate::api::phone_calls::PhoneCallActionResponse>, crate::error::GatewayError> {
    crate::api::phone_calls::handoff_call(
        State(state.clone()),
        peer(from),
        headers,
        Path(call_sid.to_owned()),
        Json(crate::api::phone_calls::PhoneCallLineRequest {
            line_id: "fixture".to_owned(),
        }),
    )
    .await
}

/// A handoff redirects the live call to TwiML that dials the line's transfer
/// number from its caller ID. Markup-bearing numbers never reach Twilio, a line
/// without a handoff number and a malformed call id are refused first, and a
/// caller without the master key is refused even from loopback.
#[tokio::test]
async fn handoff_posts_escaped_dial_twiml_and_refuses_unsafe_requests() {
    let fixture = phone_api_fixture(
        "phone-handoff",
        vec![line(
            "fixture",
            LINE_NUMBER,
            LINE_CALLER_ID,
            Some(LINE_TRANSFER),
        )],
        ACCOUNT,
    )
    .await;
    let state = &fixture.state;

    for (from, key) in [
        ("203.0.113.5:4000", RELAY_KEY),
        ("127.0.0.1:4000", RELAY_KEY),
        ("203.0.113.5:4000", "wrong-key"),
    ] {
        let refused = handoff(state, from, bearer(key), VICTIM_CALL).await;
        assert!(
            matches!(refused, Err(crate::error::GatewayError::Unauthorized(_))),
            "a non-admin caller ({from}) must be refused: {refused:?}"
        );
    }
    assert_eq!(
        bad_request_message(handoff(state, "127.0.0.1:4000", admin(), "CA123\"><Dial>").await),
        "invalid Twilio call id"
    );
    assert!(
        fixture.twilio.requests().is_empty(),
        "refusals never reach Twilio"
    );

    let Json(done) = handoff(state, "203.0.113.5:4000", admin(), VICTIM_CALL)
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(done).unwrap()["status"], "in-progress");
    let requests = fixture.twilio.requests();
    assert_eq!(requests.len(), 1, "{requests:?}");
    assert_eq!(requests[0].method, "POST");
    assert!(requests[0]
        .path
        .ends_with(&format!("/Accounts/{ACCOUNT}/Calls/{VICTIM_CALL}.json")));
    assert_eq!(
        form_value(&requests[0].body, "Twiml").unwrap(),
        format!("<Response><Say>Connecting you with the account owner.</Say><Dial callerId=\"{LINE_CALLER_ID}\" answerOnBridge=\"true\"><Number>{LINE_TRANSFER}</Number></Dial></Response>")
    );

    // A number carrying markup is refused by line validation, before Twilio.
    for (caller_id, transfer_to) in [
        (LINE_CALLER_ID, "+15550003333\"><Dial>+15559999999</Dial>"),
        (
            "+15550002222\"><Play>x</Play><Dial callerId=\"",
            LINE_TRANSFER,
        ),
    ] {
        save_lines(
            true,
            vec![line("fixture", LINE_NUMBER, caller_id, Some(transfer_to))],
        );
        let message =
            bad_request_message(handoff(state, "127.0.0.1:4000", admin(), VICTIM_CALL).await);
        assert!(message.contains("E.164"), "{message}");
    }
    save_lines(
        true,
        vec![line("fixture", LINE_NUMBER, LINE_CALLER_ID, None)],
    );
    assert_eq!(
        bad_request_message(handoff(state, "127.0.0.1:4000", admin(), VICTIM_CALL).await),
        "this phone line has no handoff number"
    );
    assert_eq!(
        fixture.twilio.requests().len(),
        1,
        "no further Twilio request"
    );
}

async fn control(
    state: &crate::state::SharedState,
    call_sid: &str,
    content: Option<&str>,
    action: Option<&str>,
) -> Result<Json<crate::api::phone_calls::PhoneCallActionResponse>, crate::error::GatewayError> {
    crate::api::phone_calls::control_call(
        State(state.clone()),
        peer("127.0.0.1:4000"),
        admin(),
        Path(call_sid.to_owned()),
        Json(crate::api::phone_calls::ControlPhoneCallRequest {
            content: content.map(str::to_owned),
            action: action.map(str::to_owned),
        }),
    )
    .await
}

/// Guidance and abort reach only the named live call as bounded control frames.
#[tokio::test]
async fn control_sends_bounded_guidance_or_abort_to_the_live_call() {
    let fixture = phone_api_fixture(
        "phone-control",
        vec![line("fixture", LINE_NUMBER, "", None)],
        ACCOUNT,
    )
    .await;
    let state = &fixture.state;
    let (control_tx, mut frames) = tokio::sync::mpsc::channel(8);
    assert!(
        state
            .phone_calls
            .try_register(VICTIM_CALL.into(), "fixture".into(), control_tx.clone(), 2)
            .await
    );
    // A session registered under a malformed id is never addressed.
    assert!(
        state
            .phone_calls
            .try_register("CA123".into(), "fixture".into(), control_tx, 2)
            .await
    );

    let Json(sent) = control(state, VICTIM_CALL, None, Some("abort"))
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(sent).unwrap()["ok"], true);
    let frame: Value = serde_json::from_str(&frames.try_recv().unwrap()).unwrap();
    assert_eq!(frame, serde_json::json!({ "type": "abort" }));
    let Json(sent) = control(state, VICTIM_CALL, Some("  Offer Friday at 3pm  "), None)
        .await
        .unwrap();
    assert_eq!(serde_json::to_value(sent).unwrap()["ok"], true);
    let frame: Value = serde_json::from_str(&frames.try_recv().unwrap()).unwrap();
    assert_eq!(
        frame,
        serde_json::json!({ "type": "text", "content": "The account owner is guiding you: Offer Friday at 3pm" })
    );

    let too_long = "x".repeat(1_001);
    for (content, action) in [
        (Some("   "), None),
        (Some(too_long.as_str()), None),
        (Some("hold\0on"), None),
        (Some("Offer Friday"), Some("abort")),
        (None, Some("hangup")),
        (None, None),
    ] {
        bad_request_message(control(state, VICTIM_CALL, content, action).await);
    }
    assert_eq!(
        bad_request_message(control(state, "CA123", None, Some("abort")).await),
        "invalid Twilio call id"
    );
    assert_eq!(
        bad_request_message(control(state, ATTACK_CALL, None, Some("abort")).await),
        "that call is no longer connected to the live assistant"
    );
    assert!(
        frames.try_recv().is_err(),
        "no refused request sends a frame"
    );
}

async fn outbound_answer(
    state: &crate::state::SharedState,
    intent_id: &str,
    call_sid: &str,
    signed: bool,
) -> (StatusCode, String) {
    let params = BTreeMap::from([
        ("AccountSid".to_owned(), ACCOUNT.to_owned()),
        ("CallSid".to_owned(), call_sid.to_owned()),
    ]);
    let url = format!("https://voice.example.test{OUTBOUND_ANSWER_PATH}/{intent_id}");
    let mut headers = HeaderMap::new();
    let signature_value = if signed {
        signature(&url, &params)
    } else {
        signature(&format!("{url}/other"), &params)
    };
    headers.insert("x-twilio-signature", signature_value.parse().unwrap());
    let response = twilio_outbound_answer(
        State(state.clone()),
        Path(intent_id.to_owned()),
        headers,
        Form(params),
    )
    .await;
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, String::from_utf8(body.to_vec()).unwrap())
}

/// Twilio's outbound answer webhook binds a Call SID to a placed intent only
/// when signed, answers only that call, and returns the bound stream TwiML.
#[tokio::test]
async fn outbound_answer_binds_only_signed_callbacks_for_one_call() {
    let fixture = outbound_fixture("voice-outbound-answer").await;
    // An uncertain placement leaves the intent without a Call SID.
    fixture
        .twilio
        .answer_calls_with(StatusCode::SERVICE_UNAVAILABLE);
    assert!(start_outbound(&fixture.state, "outbound-request-0001")
        .await
        .is_err());
    let intent_id = status_intent(&fixture.twilio.last_form());
    let state = &fixture.state;

    let (status, _) = outbound_answer(state, &intent_id, VICTIM_CALL, false).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "a wrongly signed callback"
    );
    let unsigned = twilio_outbound_answer(
        State(state.clone()),
        Path(intent_id.clone()),
        HeaderMap::new(),
        Form(BTreeMap::from([(
            "CallSid".to_owned(),
            VICTIM_CALL.to_owned(),
        )])),
    )
    .await;
    assert_eq!(unsigned.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        state
            .phone_calls
            .get_intent(&intent_id)
            .await
            .unwrap()
            .call_sid,
        None,
        "a refused callback never binds a Call SID"
    );

    let unknown = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        outbound_answer(state, unknown, VICTIM_CALL, true).await.0,
        StatusCode::GONE
    );

    let (status, xml) = outbound_answer(state, &intent_id, VICTIM_CALL, true).await;
    assert_eq!(status, StatusCode::OK, "{xml}");
    assert!(
        xml.contains("<Connect>") && xml.contains("wss://voice.example.test/voice/twilio/stream"),
        "{xml}"
    );
    assert_eq!(
        xml_parameter(&xml, "conversationId"),
        conversation_id(ACCOUNT, VICTIM_CALL).unwrap()
    );
    assert_eq!(
        xml_parameter(&xml, "callBinding"),
        stream_binding(
            ACCOUNT,
            VICTIM_CALL,
            PROVIDER_SECRET,
            "fixture",
            "outbound",
            None
        )
    );
    assert_eq!(
        state
            .phone_calls
            .get_intent(&intent_id)
            .await
            .unwrap()
            .call_sid
            .as_deref(),
        Some(VICTIM_CALL)
    );
    assert_eq!(
        outbound_answer(state, &intent_id, ATTACK_CALL, true)
            .await
            .0,
        StatusCode::CONFLICT,
        "an intent is never answered for another call"
    );
    assert_eq!(
        outbound_answer(state, &intent_id, VICTIM_CALL, true)
            .await
            .0,
        StatusCode::OK
    );

    let mut disabled = line("fixture", LINE_NUMBER, "", None);
    disabled.max_concurrent_calls = Some(1);
    save_lines(false, vec![disabled]);
    assert_eq!(
        outbound_answer(state, &intent_id, VICTIM_CALL, true)
            .await
            .0,
        StatusCode::SERVICE_UNAVAILABLE
    );
}
