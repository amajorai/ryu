//! Session Box tests (prefix `session_box_`). A fake Box service (axum on a
//! loopback port) records every request; process-wide test overrides point
//! Core's Box credential, wallet probe, signing key and Gateway URL at fakes.
//! The overrides are held by [`Harness`], which also serializes these tests.
use super::*;
use axum::{
    extract::{ws::WebSocketUpgrade, Request, State},
    response::{IntoResponse, Response},
    routing::{any, get},
    Router,
};
use ryu_gw_credentials::BoxInferenceScope;
use ryu_sandbox::box_types::SecretString;
use std::sync::RwLock;

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CREDENTIAL: RwLock<Option<BoxCredential>> = RwLock::new(None);
static WALLET: RwLock<Option<Option<Value>>> = RwLock::new(None);
static SIGNER: RwLock<Option<String>> = RwLock::new(None);
static GATEWAY_URL: RwLock<Option<Option<String>>> = RwLock::new(None);
static REFRESH: RwLock<Option<Duration>> = RwLock::new(None);
static UPSTREAM: RwLock<Option<String>> = RwLock::new(None);
static QUOTE: RwLock<Option<Result<u64, String>>> = RwLock::new(None);
/// `Some(true)`: every owner counts as having acknowledged the computer-use
/// cost notice. The harness sets it so lifecycle tests create Boxes; the
/// notice tests clear it with [`Harness::require_cost_notice`].
static NOTICE_BYPASS: RwLock<Option<bool>> = RwLock::new(None);
/// How long a held session Box call waits for the cost notice (none by
/// default, so a test that does not answer is refused at once).
static NOTICE_WAIT: RwLock<Option<Duration>> = RwLock::new(None);

/// The tenant bearer the fake Box service expects. It must never reach a
/// client.
pub(crate) const BEARER: &str = "rbx1.test-tenant-bearer-never-leaves-core";
/// The key Core signs `gwb1` scopes with in these tests.
pub(crate) const SIGNER_KEY: &str = "gwcore_test_signer_key_0123456789abcdef";
const BOX_GATEWAY_URL: &str = "https://node.example/api/session-boxes/inference";
const PUBLIC_BASE: &str = "wss://box.example";
const DESKTOP_TOKEN: &str = "desk-token-1";

fn read<T: Clone>(lock: &RwLock<Option<T>>) -> Option<T> {
    lock.read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn write<T>(lock: &RwLock<Option<T>>, value: Option<T>) {
    *lock
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = value;
}

pub(super) fn test_credential() -> Option<BoxCredential> {
    read(&CREDENTIAL)
}

pub(super) fn test_wallet() -> Option<Option<Value>> {
    read(&WALLET)
}

pub(super) fn test_quote() -> Option<Result<u64, String>> {
    read(&QUOTE)
}

pub(super) fn test_notice_bypass() -> bool {
    read(&NOTICE_BYPASS).unwrap_or(false)
}

pub(super) fn test_notice_wait() -> Option<Duration> {
    read(&NOTICE_WAIT)
}

pub(super) fn test_signer_key() -> Option<String> {
    read(&SIGNER)
}

pub(super) fn test_gateway_url() -> Option<Option<String>> {
    read(&GATEWAY_URL)
}

pub(super) fn test_refresh_interval() -> Option<Duration> {
    read(&REFRESH)
}

pub(super) fn test_upstream_gateway() -> Option<String> {
    read(&UPSTREAM)
}

// ── Fake Box service ─────────────────────────────────────────────────────────

/// One request the fake Box service saw.
#[derive(Clone, Debug)]
pub(crate) struct Recorded {
    pub method: String,
    pub path: String,
    pub body: Value,
    pub headers: HashMap<String, String>,
}

#[derive(Default)]
pub(crate) struct FakeState {
    pub requests: Vec<Recorded>,
    /// Box id → (name, status).
    pub boxes: HashMap<String, (String, String)>,
    pub viewers: u32,
    pub limits: Option<Value>,
    /// `(status, body, retry_after)` for the next creates.
    pub create_error: Option<(u16, Value, Option<u64>)>,
    pub next_box: u32,
    /// The service has no desktop image: `/health` leaves out `desktop`.
    pub no_desktop: bool,
    /// Stops answer `409 box_busy` until the Box is interrupted.
    pub busy: HashSet<String>,
    /// Resumes report the per-start minimum as waived (the Box's own parked
    /// VM inside the hour already paid for), with a signed waiver.
    pub resume_waived: bool,
    /// Waived resumes carry no signed waiver (a Box service without
    /// `RYU_BOX_MINIMUM_WAIVER_KEY`).
    pub resume_unsigned: bool,
}

type FakeShared = Arc<StdMutex<FakeState>>;

/// The signed waiver the fake Box service hands out on a waived resume.
const FAKE_WAIVER: &str = "bw1.eyJib3hJZCI6ImJ4In0.c2lnbmF0dXJl";

fn lock_fake(state: &FakeShared) -> std::sync::MutexGuard<'_, FakeState> {
    state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Clone)]
pub(crate) struct FakeBox {
    pub base: String,
    pub state: FakeShared,
}

fn box_json(id: &str, status: &str, viewers: u32) -> Value {
    json!({
        "id": id,
        "status": status,
        "size": "small",
        "desktop": {"ready": status == "ready", "viewers": viewers, "width": 1280, "height": 800},
        "placement": {"tier": "hetzner", "provider": "hetzner", "location": "nbg1", "serverType": "cx23", "isolation": "vm"},
        "runningSince": if status == "ready" { json!("2026-10-19T10:00:00Z") } else { Value::Null },
    })
}

fn json_response(status: u16, body: Value) -> Response {
    let mut response = axum::Json(body).into_response();
    *response.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::OK);
    response
}

async fn fake_handler(State(state): State<FakeShared>, request: Request) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1 << 20)
        .await
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    let headers = parts
        .headers
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or_default().to_owned(),
            )
        })
        .collect();
    let method = parts.method.to_string();
    let path = parts.uri.path().to_owned();
    let mut fake = lock_fake(&state);
    fake.requests.push(Recorded {
        method: method.clone(),
        path: path.clone(),
        body: body.clone(),
        headers,
    });
    let segments: Vec<&str> = path
        .trim_start_matches("/v1/")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let viewers = fake.viewers;
    match (method.as_str(), segments.as_slice()) {
        ("GET", ["health"]) => {
            let mut features = vec!["boxes", "commands", "interrupt"];
            if !fake.no_desktop {
                features.push("desktop");
            }
            json_response(200, json!({"ok": true, "type": "box.health", "features": features}))
        }
        ("POST", ["boxes"]) => {
            if let Some((status, error, retry_after)) = fake.create_error.clone() {
                let mut response = json_response(status, error);
                if let Some(seconds) = retry_after {
                    response
                        .headers_mut()
                        .insert("retry-after", seconds.to_string().parse().unwrap());
                }
                return response;
            }
            fake.next_box += 1;
            let id = format!("bx_{:032x}", fake.next_box);
            let name = body["name"].as_str().unwrap_or_default().to_owned();
            fake.boxes.insert(id.clone(), (name, "ready".to_owned()));
            json_response(201, json!({"box": box_json(&id, "ready", viewers)}))
        }
        ("GET", ["boxes"]) => {
            let boxes: Vec<Value> = fake
                .boxes
                .iter()
                .map(|(id, (name, status))| json!({"id": id, "name": name, "status": status}))
                .collect();
            json_response(200, json!({"boxes": boxes}))
        }
        ("GET", ["boxes", id]) => match fake.boxes.get(*id) {
            Some((_, status)) => json_response(200, json!({"box": box_json(id, status, viewers)})),
            None => json_response(404, json!({"error": {"code": "not_found"}})),
        },
        ("DELETE", ["boxes", id]) => match fake.boxes.remove(*id) {
            Some(_) => json_response(200, json!({"ok": true})),
            None => json_response(404, json!({"error": {"code": "not_found"}})),
        },
        ("POST", ["boxes", id, verb]) if fake.boxes.contains_key(*id) => {
            let id = (*id).to_owned();
            match *verb {
                "stop" if fake.busy.contains(&id) => json_response(
                    409,
                    json!({"error": {"code": "box_busy", "message": "A command is running."}}),
                ),
                "interrupt" => {
                    fake.busy.remove(&id);
                    json_response(200, json!({"ok": true, "type": "box.interrupted", "killed": 1}))
                }
                "stop" => {
                    if let Some(entry) = fake.boxes.get_mut(&id) {
                        entry.1 = "stopped".to_owned();
                    }
                    json_response(200, json!({"type": "box.stopped"}))
                }
                "resume" => {
                    if let Some(entry) = fake.boxes.get_mut(&id) {
                        entry.1 = "ready".to_owned();
                    }
                    let mut resumed = box_json(&id, "ready", viewers);
                    resumed["billing"] = json!({
                        "minimumWaived": fake.resume_waived,
                        "paidHourEndsAt": if fake.resume_waived { json!("2026-10-19T11:00:00Z") } else { Value::Null },
                    });
                    if fake.resume_waived && !fake.resume_unsigned {
                        resumed["billing"]["waiver"] = json!(FAKE_WAIVER);
                    }
                    json_response(200, json!({"box": resumed}))
                }
                "access-tokens" => json_response(
                    201,
                    json!({
                        "ok": true,
                        "type": "access_token.created",
                        "token": DESKTOP_TOKEN,
                        "expiresAt": "2026-10-19T10:00:30Z",
                        "protocols": ["ryu.box.v1", format!("ryu.token.{DESKTOP_TOKEN}")],
                        "url": format!("/v1/boxes/{id}/desktop/ws"),
                    }),
                ),
                "keepalive" => json_response(200, json!({"ok": true})),
                _ => json_response(404, json!({"error": {"code": "not_found"}})),
            }
        }
        ("PUT", ["boxes", id, "session-credential"]) if fake.boxes.contains_key(*id) => {
            json_response(200, json!({"ok": true}))
        }
        ("GET", ["limits"]) => json_response(
            200,
            fake.limits.clone().unwrap_or_else(
                || json!({"running": 0, "maxRunning": 8, "stored": 0, "maxStored": 64, "resourceUnits": 0, "maxResourceUnits": 16}),
            ),
        ),
        _ => json_response(404, json!({"error": {"code": "not_found"}})),
    }
}

/// The Box desktop socket: records the dial and echoes frames.
async fn fake_desktop_ws(
    State(state): State<FakeShared>,
    axum::extract::Path(id): axum::extract::Path<String>,
    headers: axum::http::HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    lock_fake(&state).requests.push(Recorded {
        method: "WS".to_owned(),
        path: format!("/v1/boxes/{id}/desktop/ws"),
        body: Value::Null,
        headers: headers
            .iter()
            .map(|(name, value)| {
                (
                    name.to_string(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect(),
    });
    ws.protocols(["ryu.box.v1"])
        .on_upgrade(|mut socket| async move {
            while let Some(Ok(message)) = socket.recv().await {
                if matches!(message, axum::extract::ws::Message::Close(_))
                    || socket.send(message).await.is_err()
                {
                    break;
                }
            }
        })
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await;
    });
    format!("http://{address}")
}

impl FakeBox {
    pub(crate) async fn start() -> Self {
        let state: FakeShared = Arc::default();
        let router = Router::new()
            .route("/v1/boxes/:id/desktop/ws", get(fake_desktop_ws))
            .fallback(any(fake_handler))
            .with_state(state.clone());
        let address = serve(router).await;
        Self {
            base: format!("{address}/v1"),
            state,
        }
    }

    pub(crate) fn requests(&self) -> Vec<Recorded> {
        lock_fake(&self.state).requests.clone()
    }

    pub(crate) fn matching(&self, method: &str, path: &str) -> Vec<Recorded> {
        self.requests()
            .into_iter()
            .filter(|request| request.method == method && request.path == path)
            .collect()
    }

    pub(crate) fn find(&self, method: &str, path: &str) -> Option<Recorded> {
        self.matching(method, path).into_iter().last()
    }

    pub(crate) fn add_box(&self, id: &str, name: &str) {
        lock_fake(&self.state)
            .boxes
            .insert(id.to_owned(), (name.to_owned(), "ready".to_owned()));
    }

    pub(crate) fn has_box(&self, id: &str) -> bool {
        lock_fake(&self.state).boxes.contains_key(id)
    }

    fn set_viewers(&self, viewers: u32) {
        lock_fake(&self.state).viewers = viewers;
    }

    fn set_limits(&self, limits: Value) {
        lock_fake(&self.state).limits = Some(limits);
    }

    pub(crate) fn without_desktop(&self) {
        lock_fake(&self.state).no_desktop = true;
    }

    fn set_busy(&self, id: &str) {
        lock_fake(&self.state).busy.insert(id.to_owned());
    }

    fn fail_create(&self, status: u16, body: Value, retry_after: Option<u64>) {
        lock_fake(&self.state).create_error = Some((status, body, retry_after));
    }
}

// ── Harness ──────────────────────────────────────────────────────────────────

/// Serializes the tests that touch the process-wide session Box state and
/// points every Box call at a fresh fake service.
pub(crate) struct Harness {
    pub fake: FakeBox,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

fn credential(base: &str, public_base: Option<&str>) -> BoxCredential {
    BoxCredential {
        base: reqwest::Url::parse(base).unwrap(),
        token: SecretString::new(BEARER),
        public_base: public_base.map(|url| reqwest::Url::parse(url).unwrap()),
        billing_owner: BillingOwner::None,
        expires_at: None,
    }
}

impl Harness {
    pub(crate) async fn new() -> Self {
        let guard = TEST_LOCK.lock().await;
        reset();
        let fake = FakeBox::start().await;
        write(&CREDENTIAL, Some(credential(&fake.base, None)));
        write(&WALLET, Some(None));
        write(&SIGNER, Some(SIGNER_KEY.to_owned()));
        write(&GATEWAY_URL, Some(Some(BOX_GATEWAY_URL.to_owned())));
        write(&NOTICE_BYPASS, Some(true));
        Self {
            fake,
            _guard: guard,
        }
    }

    /// Ask every owner for the one-time cost notice again, from an empty
    /// acknowledgement store.
    pub(crate) fn require_cost_notice(&self) {
        notice::reset_for_test(true);
        write(&NOTICE_BYPASS, Some(false));
    }

    /// Hold a session Box call up to `wait` for the cost notice's answer.
    pub(crate) fn hold_for_notice(&self, wait: Duration) {
        write(&NOTICE_WAIT, Some(wait));
    }

    /// What the Gateway quotes for a Box rate (`Err` for a failed quote).
    pub(crate) fn set_quote(&self, quote: Result<u64, String>) {
        caps::clear_quotes();
        write(&QUOTE, Some(quote));
    }

    /// Hosted mode: the credential carries a public stream ingress.
    fn direct(&self) {
        write(
            &CREDENTIAL,
            Some(credential(&self.fake.base, Some(PUBLIC_BASE))),
        );
    }
}

/// Hold the session Box test lock with no override installed, for a test
/// elsewhere whose Box calls must use the process-wide credential.
pub(crate) async fn without_overrides() -> tokio::sync::MutexGuard<'static, ()> {
    let guard = TEST_LOCK.lock().await;
    reset();
    guard
}

impl Drop for Harness {
    fn drop(&mut self) {
        reset();
    }
}

/// Forget every session Box this process registered and every override.
fn reset() {
    let slots: Vec<Slot> = lock_registry().drain().map(|(_, slot)| slot).collect();
    for slot in slots {
        if let Ok(mut guard) = slot.try_lock() {
            if let Some(entry) = guard.as_mut() {
                entry.stop_refresher();
                heartbeat::unregister(&entry.run_id());
            }
        }
    }
    lock_shared().clear();
    lock_child_counters().clear();
    clear_view_cache();
    relay_viewers()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
    caps::clear_cache();
    if let Ok(entries) = std::fs::read_dir(lease_directory()) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    write(&CREDENTIAL, None);
    write(&WALLET, None);
    write(&SIGNER, None);
    write(&GATEWAY_URL, None);
    write(&REFRESH, None);
    write(&UPSTREAM, None);
    write(&QUOTE, None);
    write(&NOTICE_BYPASS, None);
    write(&NOTICE_WAIT, None);
    caps::clear_quotes();
    notice::reset_for_test(true);
}

fn clear_view_cache() {
    view_cache()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clear();
}

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// The node owner over the node credential, with no cloud identity.
pub(crate) fn local_owner() -> ResolvedAuthorization {
    use crate::authorization::*;
    ResolvedAuthorization {
        context: AuthorizationContext {
            credential: CredentialKind::OwnerRecoveryToken,
            principal: Principal::Owner,
            capabilities: CapabilitySet::new([Capability::GatewayRoute, Capability::ToolsExec]),
            constraints: GrantConstraints::default(),
            issued_at: 0,
            expires_at: None,
        },
        bindings: crate::authorization::RequestBindings::default(),
        caller: None,
        verified_user_jwt: None,
    }
}

async fn cloud_jwt(user: &str, flag: bool, limit: Option<u32>) -> String {
    let flags: Vec<&str> = if flag {
        vec![environments::BOX_BACKEND_FLAG]
    } else {
        Vec::new()
    };
    let mut claims = json!({
        "id": user,
        "sub": user,
        "email": format!("{user}@example.com"),
        "ryu_flags": flags,
    });
    if let Some(limit) = limit {
        claims["ryu_limits"] = json!({"boxConcurrency": limit});
    }
    environments::tests::signed_user_jwt_with_claims(claims, 600).await
}

/// A verified cloud caller; `flag` puts `cloud_tasks.box_backend` in its
/// signed claim, `limit` its `ryu_limits.boxConcurrency`.
pub(crate) async fn cloud_user(
    user: &str,
    flag: bool,
    limit: Option<u32>,
) -> ResolvedAuthorization {
    environments::tests::cloud_auth(cloud_jwt(user, flag, limit).await).await
}

async fn wait_for<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(found) = probe() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn entry_phase(key: &SessionBoxKey) -> Option<(Phase, Option<String>, u64)> {
    let slot = existing_slot(key)?;
    let guard = slot.lock().await;
    guard
        .as_ref()
        .map(|entry| (entry.phase, entry.stop_reason.clone(), entry.lease_epoch))
}

async fn age_entry(key: &SessionBoxKey, seconds: u64) {
    let slot = existing_slot(key).expect("entry exists");
    let mut guard = slot.lock().await;
    let entry = guard.as_mut().expect("entry exists");
    entry.last_activity = Instant::now() - Duration::from_secs(seconds);
}

fn code(error: &ApiError) -> (StatusCode, String) {
    (
        error.0,
        error.1 .0["error"]["code"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    )
}

async fn acquire(auth: &ResolvedAuthorization, key: &SessionBoxKey) -> BoxTarget {
    desktop_target(auth, key, Some(AcquireReason::ComputerUse))
        .await
        .expect("acquire succeeds")
        .expect("a Box is acquired")
}

// ── Keys and pure decisions ──────────────────────────────────────────────────

#[test]
fn session_box_keys_parse_children_and_refuse_unsafe_ids() {
    let parent = SessionBoxKey::parse("user:u", "conv-1").unwrap();
    assert_eq!(parent, SessionBoxKey::session("user:u", "conv-1"));
    assert_eq!(parent.session_id(), "conv-1");
    let child = SessionBoxKey::parse("user:u", "conv-1#sub:3").unwrap();
    assert_eq!(child, SessionBoxKey::child("user:u", "conv-1", 3));
    assert_eq!(child.session_id(), "conv-1#sub:3");
    assert_eq!(child.parent(), parent);
    for bad in [
        "",
        "conv/1",
        "conv 1",
        "conv-1#sub:0",
        "conv-1#sub:01",
        "conv-1#sub:65",
        "conv-1#sub:x",
        "#sub:1",
    ] {
        assert!(SessionBoxKey::parse("user:u", bad).is_none(), "{bad:?}");
    }
}

#[test]
fn session_box_next_child_index_counts_per_conversation() {
    let conversation = unique("children");
    assert_eq!(next_child_index("user:a", &conversation), Some(1));
    assert_eq!(next_child_index("user:a", &conversation), Some(2));
    assert_eq!(next_child_index("user:a", &conversation), Some(3));
    assert_eq!(next_child_index("user:b", &conversation), Some(1));
    lock_child_counters().retain(|(_, id), _| id != &conversation);
}

#[test]
fn session_box_warning_levels_and_minutes_remaining() {
    use heartbeat::Verdict;
    assert_eq!(minutes_remaining(Some(1_000_000), Some(60_000)), Some(1000));
    assert_eq!(minutes_remaining(Some(-5), Some(60_000)), Some(0));
    assert_eq!(minutes_remaining(None, Some(60_000)), None);
    assert_eq!(minutes_remaining(Some(5), Some(0)), None);
    assert_eq!(
        warning_level(Some(Verdict::Continue), Some(120), Some(10)),
        "none"
    );
    assert_eq!(
        warning_level(Some(Verdict::Warn), Some(120), Some(10)),
        "low"
    );
    assert_eq!(warning_level(None, Some(14), Some(10)), "low");
    assert_eq!(warning_level(None, Some(4), Some(10)), "critical");
    assert_eq!(warning_level(None, None, Some(0)), "critical");
    assert_eq!(warning_level(None, None, None), "none");
}

#[test]
fn session_box_preflight_and_limits_decisions() {
    use caps::PreflightRate::{Known, NotCoreMetered, Unknown};
    assert!(caps::preflight_decision(None, Known(40_000)).is_ok());
    assert!(caps::preflight_decision(None, Unknown).is_ok());
    assert!(caps::preflight_decision(Some(&json!({"balance_micro_usd": null})), Unknown).is_ok());
    for refused in [
        json!({"empty": true, "balance_micro_usd": 99_999_999}),
        json!({"balance_micro_usd": 0}),
        // The 5-minute minimum at $0.04/h is 3_333 micro-USD.
        json!({"balance_micro_usd": 3_332}),
    ] {
        let error = caps::preflight_decision(Some(&refused), Known(40_000)).unwrap_err();
        assert_eq!(
            code(&error),
            (
                StatusCode::PAYMENT_REQUIRED,
                "session_box_insufficient_credits".to_owned()
            ),
            "{refused}"
        );
    }
    assert!(
        caps::preflight_decision(Some(&json!({"balance_micro_usd": 3_333})), Known(40_000)).is_ok()
    );
    // The horizon is the per-start minimum the Gateway charges on a run's
    // first tick, from the shared Box rate fixture.
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../../crates/gateway/contracts/fixtures/box-rates.json"
    ))
    .expect("box-rates.json is JSON");
    assert_eq!(
        fixture["minimumSecondsPerStart"].as_u64(),
        Some(PREFLIGHT_SECONDS)
    );
    // A Box another owner bills is not held to Core's horizon.
    assert!(
        caps::preflight_decision(Some(&json!({"balance_micro_usd": 5})), NotCoreMetered).is_ok()
    );
    // A Box Core meters whose rate the Gateway cannot name fails safe.
    assert_eq!(
        code(
            &caps::preflight_decision(Some(&json!({"balance_micro_usd": 5})), Unknown).unwrap_err()
        ),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "session_box_rate_unavailable".to_owned()
        )
    );
    assert!(caps::wallet_needs_rate(Some(
        &json!({"balance_micro_usd": 5})
    )));
    assert!(!caps::wallet_needs_rate(Some(
        &json!({"balance_micro_usd": null})
    )));
    assert!(!caps::wallet_needs_rate(Some(
        &json!({"empty": true, "balance_micro_usd": 5})
    )));
    assert!(!caps::wallet_needs_rate(None));

    let full = ryu_sandbox::box_types::BoxLimits {
        running: 2,
        max_running: 2,
        stored: 0,
        max_stored: 10,
    };
    assert_eq!(
        code(&caps::limits_decision(Ok(&full)).unwrap_err()).1,
        "session_box_limit_reached"
    );
    let open = ryu_sandbox::box_types::BoxLimits { running: 1, ..full };
    assert!(caps::limits_decision(Ok(&open)).is_ok());
    assert_eq!(
        code(&caps::limits_decision(Err(&BoxApiError::InsufficientCredits)).unwrap_err()).0,
        StatusCode::PAYMENT_REQUIRED
    );
    assert!(caps::limits_decision(Err(&BoxApiError::NotFound)).is_ok());
}

#[test]
fn session_box_idle_setting_parses_with_a_floor() {
    assert_eq!(idle::parse_idle_secs("900"), Some(900));
    assert_eq!(idle::parse_idle_secs(" 5 "), Some(60));
    assert_eq!(idle::parse_idle_secs("soon"), None);
    assert_eq!(idle::DEFAULT_IDLE_SECS, 600);
    assert_eq!(idle::SWEEP_INTERVAL, Duration::from_secs(30));
}

#[test]
fn session_box_capacity_errors_carry_retry_after() {
    let error = box_api_error(&BoxApiError::Capacity { retry_after: 30 });
    assert_eq!(
        code(&error),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "session_box_capacity".to_owned()
        )
    );
    assert_eq!(error.1 .0["error"]["retryAfter"], 30);
    assert_eq!(
        code(&box_api_error(&BoxApiError::Quota)).0,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        code(&box_api_error(&BoxApiError::InsufficientCredits)).0,
        StatusCode::PAYMENT_REQUIRED
    );
}

// ── Acquire, attach, idle, resume, release ───────────────────────────────────

#[tokio::test]
async fn session_box_acquire_creates_a_desktop_box_without_binding_the_conversation() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("acquire");
    let key = SessionBoxKey::session("node-owner", &conversation);

    let target = acquire(&auth, &key).await;
    assert_eq!(target.source, TargetSource::Session);
    assert!(target.desktop);
    assert_eq!(target.size, BoxSize::Small);

    let create = harness.fake.find("POST", "/v1/boxes").expect("Box created");
    assert_eq!(create.body["desktop"], true);
    assert_eq!(create.body["size"], "small");
    assert_eq!(create.body["network"], "egress");
    assert_eq!(create.body["labels"]["ryu-kind"], "session");
    assert_eq!(
        create.headers.get("authorization").map(String::as_str),
        Some(format!("Bearer {BEARER}").as_str())
    );
    assert!(
        !create.body.to_string().contains("gwb1"),
        "the inference key never rides the create body"
    );

    // The lease names the Box.
    let lease = leases()
        .into_iter()
        .find(|lease| lease.conversation_id == conversation)
        .expect("lease written");
    assert_eq!(lease.box_id.as_deref(), Some(target.box_id.0.as_str()));
    assert!(!lease.parked);

    // A second call reuses the Box.
    assert_eq!(acquire(&auth, &key).await, target);
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 1);

    // A display Box never flips the conversation into "cloud tools only".
    assert!(!cloud_tasks::has_bound_task(&conversation).await);
    assert!(routes_to_box(&SessionBoxKey::session("node-owner", &conversation)).await);
    assert!(!routes_to_box(&SessionBoxKey::session("node-owner", &unique("other"))).await);
    assert!(!routes_to_box(&SessionBoxKey::session("user:someone-else", &conversation)).await);

    // Status reports the Box with its placement and screen.
    let found = status("node-owner", &conversation).await.expect("status");
    let view = found.session_box.expect("box view");
    assert_eq!(view.state, "ready");
    assert_eq!(view.id.as_deref(), Some(target.box_id.0.as_str()));
    assert_eq!(
        view.placement
            .and_then(|placement| placement.provider)
            .as_deref(),
        Some("hetzner")
    );
    assert!(view.desktop.is_some_and(|desktop| desktop.ready));
    assert_eq!(view.warning, "none");

    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_attaches_to_a_cloud_task_box_instead_of_creating_one() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("cloud-attach");
    let lease = uuid::Uuid::new_v4().to_string();
    let cloud = BoxTarget {
        box_id: WorkspaceId(format!("bx_{}", "c".repeat(32))),
        lease_id: lease.clone(),
        run_id: lease.clone(),
        size: BoxSize::Default,
        desktop: true,
        source: TargetSource::CloudTask,
    };
    cloud_tasks::bind_box("node-owner", &conversation, cloud.clone());

    let key = SessionBoxKey::session("node-owner", &conversation);
    let target = desktop_target(&auth, &key, Some(AcquireReason::ComputerUse))
        .await
        .unwrap();
    cloud_tasks::unbind_box("node-owner", &conversation, &lease);

    assert_eq!(target, Some(cloud));
    assert!(
        harness.fake.matching("POST", "/v1/boxes").is_empty(),
        "no second Box is created"
    );
    assert!(existing_slot(&key).is_none());
}

#[tokio::test]
async fn session_box_without_a_flag_or_with_the_node_preference_stays_on_the_node() {
    let harness = Harness::new().await;
    let conversation = unique("no-flag");
    let auth = cloud_user("user-no-flag", false, None).await;
    let key = SessionBoxKey::session("user:user-no-flag", &conversation);
    assert_eq!(
        desktop_target(&auth, &key, Some(AcquireReason::ComputerUse))
            .await
            .unwrap(),
        None
    );

    let store = crate::server::preferences::PreferencesStore::open_default().unwrap();
    store.set(PREF_COMPUTER_TARGET, "node").await.unwrap();
    let local = SessionBoxKey::session("node-owner", &conversation);
    let routed = desktop_target(&local_owner(), &local, Some(AcquireReason::ComputerUse)).await;
    store.delete(PREF_COMPUTER_TARGET).await.unwrap();
    assert_eq!(routed.unwrap(), None);
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
    assert!(existing_slot(&key).is_none() && existing_slot(&local).is_none());

    // Another caller's key is refused outright.
    let error = desktop_target(&auth, &local, Some(AcquireReason::ComputerUse))
        .await
        .unwrap_err();
    assert_eq!(code(&error).1, "session_box_forbidden");
}

#[tokio::test]
async fn session_box_node_preference_keeps_sub_agent_machine_verbs_on_the_node() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("node-pref-child");
    let index = next_child_index("node-owner", &conversation).unwrap();
    let child = SessionBoxKey::child("node-owner", &conversation, index);

    let store = crate::server::preferences::PreferencesStore::open_default().unwrap();
    store.set(PREF_COMPUTER_TARGET, "node").await.unwrap();
    let routed = desktop_target(&auth, &child, Some(AcquireReason::SubAgent)).await;
    store.delete(PREF_COMPUTER_TARGET).await.unwrap();

    assert_eq!(routed.unwrap(), None);
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
    assert!(existing_slot(&child).is_none());
}

#[tokio::test]
async fn session_box_idle_sweep_parks_after_idle_unless_someone_watches() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("idle");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let target = acquire(&auth, &key).await;
    let idle = Duration::from_secs(600);

    // Recently active: kept.
    assert!(idle::sweep_once(idle).await.is_empty());

    // Idle, but a viewer is watching: that counts as activity.
    age_entry(&key, 700).await;
    harness.fake.set_viewers(1);
    clear_view_cache();
    assert!(idle::sweep_once(idle).await.is_empty());
    assert_eq!(entry_phase(&key).await.unwrap().0, Phase::Live);

    // Idle and unwatched: parked with reason idle.
    age_entry(&key, 700).await;
    harness.fake.set_viewers(0);
    clear_view_cache();
    assert_eq!(
        idle::sweep_once(idle).await,
        vec![(key.clone(), ParkReason::Idle)]
    );
    let stop = harness
        .fake
        .find("POST", &format!("/v1/boxes/{}/stop", target.box_id.0))
        .expect("parked");
    assert_eq!(stop.body["reason"], "idle");
    let (phase, reason, _) = entry_phase(&key).await.unwrap();
    assert_eq!(phase, Phase::Parked);
    assert_eq!(reason.as_deref(), Some("idle"));
    assert!(
        heartbeat::run_snapshot(&target.run_id).is_none(),
        "metering ended"
    );
    assert!(leases()
        .iter()
        .any(|lease| lease.conversation_id == conversation && lease.parked));
    // A parked Box still routes: the next call resumes it.
    assert!(routes_to_box(&key).await);
    let view = status("node-owner", &conversation)
        .await
        .unwrap()
        .session_box
        .unwrap();
    assert_eq!(view.state, "parked");
    assert_eq!(view.stop_reason.as_deref(), Some("idle"));

    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_lifetime_parks_with_reason_ttl_and_extend_pushes_it_back() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("ttl");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let target = acquire(&auth, &key).await;
    {
        let slot = existing_slot(&key).unwrap();
        let mut guard = slot.lock().await;
        guard.as_mut().unwrap().run_until = unix_now() - 1;
    }
    assert_eq!(
        idle::sweep_once(Duration::from_secs(600)).await,
        vec![(key.clone(), ParkReason::Ttl)]
    );
    let stop = harness
        .fake
        .find("POST", &format!("/v1/boxes/{}/stop", target.box_id.0))
        .unwrap();
    assert_eq!(stop.body["reason"], "ttl");
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_next_call_resumes_a_parked_box_with_a_new_epoch() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("resume");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let target = acquire(&auth, &key).await;
    park(&key, ParkReason::User).await.unwrap();
    assert_eq!(entry_phase(&key).await.unwrap().0, Phase::Parked);
    // Without an acquire reason, a parked Box is not resumed.
    assert_eq!(desktop_target(&auth, &key, None).await.unwrap(), None);

    let resumed = acquire(&auth, &key).await;
    assert_eq!(resumed.box_id, target.box_id);
    assert!(harness
        .fake
        .find("POST", &format!("/v1/boxes/{}/resume", target.box_id.0))
        .is_some());
    let (phase, reason, epoch) = entry_phase(&key).await.unwrap();
    assert_eq!((phase, reason, epoch), (Phase::Live, None, 2));
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 1);
    // The resumed Box gets a key for its new epoch.
    let path = format!("/v1/boxes/{}/session-credential", target.box_id.0);
    let put = wait_for(|| {
        harness.fake.matching("PUT", &path).into_iter().find(|put| {
            BoxInferenceScope::verify(put.body["key"].as_str().unwrap_or_default(), SIGNER_KEY)
                .is_ok_and(|scope| scope.lease_epoch == 2)
        })
    })
    .await;
    assert_eq!(put.body["gatewayUrl"], BOX_GATEWAY_URL);
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_a_resume_the_box_service_waived_meters_without_a_new_minimum() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("waived");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let created = acquire(&auth, &key).await;
    // A created Box always pays its minimum.
    let snapshot = heartbeat::run_snapshot(&created.run_id).expect("metered");
    assert!(!snapshot.minimum_waived);
    park(&key, ParkReason::Idle).await.unwrap();

    // The Box service reattached the Box to its own parked VM inside the
    // hour already paid for: the new run segment carries the waiver.
    lock_fake(&harness.fake.state).resume_waived = true;
    let resumed = acquire(&auth, &key).await;
    assert_ne!(resumed.run_id, created.run_id);
    assert!(
        heartbeat::run_snapshot(&resumed.run_id)
            .expect("metered")
            .minimum_waived
    );
    // (The run forwards the signed waiver on its ticks and final debit; the
    // heartbeat tests pin that wire, and the Gateway verifies it.)
    park(&key, ParkReason::Idle).await.unwrap();

    // Waived but unsigned: Core has nothing the Gateway would honour, so the
    // run is metered like any other start.
    {
        let mut fake = lock_fake(&harness.fake.state);
        fake.resume_unsigned = true;
    }
    let unsigned = acquire(&auth, &key).await;
    assert!(
        !heartbeat::run_snapshot(&unsigned.run_id)
            .expect("metered")
            .minimum_waived
    );
    park(&key, ParkReason::Idle).await.unwrap();
    lock_fake(&harness.fake.state).resume_unsigned = false;

    // A resume it did not waive (a new VM, or after the hour) pays it again.
    lock_fake(&harness.fake.state).resume_waived = false;
    let charged = acquire(&auth, &key).await;
    assert!(
        !heartbeat::run_snapshot(&charged.run_id)
            .expect("metered")
            .minimum_waived
    );
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_deleting_the_conversation_deletes_parent_and_child_boxes() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("delete");
    let parent = SessionBoxKey::session("node-owner", &conversation);
    let parent_box = acquire(&auth, &parent).await;
    let index = next_child_index("node-owner", &conversation).unwrap();
    let child = SessionBoxKey::child("node-owner", &conversation, index);
    let child_box = desktop_target(&auth, &child, Some(AcquireReason::SubAgent))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(child_box.source, TargetSource::SubAgent);
    assert_ne!(child_box.box_id, parent_box.box_id);
    assert_eq!(
        harness.fake.find("POST", "/v1/boxes").unwrap().body["labels"]["ryu-kind"],
        "sub-agent"
    );

    cloud_tasks::release_deleted_conversation(&conversation).await;
    wait_for(|| {
        (!harness.fake.has_box(&parent_box.box_id.0) && !harness.fake.has_box(&child_box.box_id.0))
            .then_some(())
    })
    .await;
    wait_for(|| conversation_keys(&conversation).is_empty().then_some(())).await;
    assert!(leases()
        .iter()
        .all(|lease| lease.conversation_id != conversation));
    assert!(heartbeat::run_snapshot(&parent_box.run_id).is_none());
    assert!(heartbeat::run_snapshot(&child_box.run_id).is_none());
    assert_eq!(
        next_child_index("node-owner", &conversation),
        Some(1),
        "counter reset"
    );
}

#[tokio::test]
async fn session_box_a_core_restart_parks_recovered_leases() {
    let harness = Harness::new().await;
    let conversation = unique("restart");
    let live_id = format!("bx_{}", "d".repeat(32));
    let lease_id = uuid::Uuid::new_v4().to_string();
    harness.fake.add_box(&live_id, &box_name(&lease_id));
    write_lease(&SessionLease {
        schema_version: 1,
        id: lease_id.clone(),
        owner: "node-owner".to_owned(),
        conversation_id: conversation.clone(),
        child: None,
        box_id: Some(live_id.clone()),
        size: BoxSize::Small,
        parked: false,
        deleted: false,
        box_expires_at: unix_now() + 3600,
        lease_epoch: 0,
    })
    .unwrap();
    let deleted_id = format!("bx_{}", "e".repeat(32));
    let deleted_lease = uuid::Uuid::new_v4().to_string();
    harness.fake.add_box(&deleted_id, &box_name(&deleted_lease));
    write_lease(&SessionLease {
        schema_version: 1,
        id: deleted_lease.clone(),
        owner: "node-owner".to_owned(),
        conversation_id: unique("gone"),
        child: None,
        box_id: Some(deleted_id.clone()),
        size: BoxSize::Small,
        parked: true,
        deleted: true,
        box_expires_at: unix_now() + 3600,
        lease_epoch: 0,
    })
    .unwrap();

    recover_leases().await;

    let stop = harness
        .fake
        .find("POST", &format!("/v1/boxes/{live_id}/stop"))
        .expect("recovered lease parked, not destroyed");
    assert_eq!(stop.body["reason"], "user");
    assert!(harness.fake.has_box(&live_id));
    assert!(
        !harness.fake.has_box(&deleted_id),
        "a deleted conversation's Box is deleted"
    );
    let key = SessionBoxKey::session("node-owner", &conversation);
    let (phase, reason, _) = entry_phase(&key).await.expect("registered as parked");
    assert_eq!(phase, Phase::Parked);
    assert_eq!(reason.as_deref(), Some("restart"));
    let leases = leases();
    assert!(leases
        .iter()
        .any(|lease| lease.id == lease_id && lease.parked));
    assert!(leases.iter().all(|lease| lease.id != deleted_lease));

    // The next heavy call resumes it.
    let target = acquire(&local_owner(), &key).await;
    assert_eq!(target.box_id.0, live_id);
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_kill_balance_parks_and_records_the_reason() {
    let harness = Harness::new().await;
    let conversation = unique("kill");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let target = acquire(&local_owner(), &key).await;

    let park_fn = session_kill_action(key.clone(), target.box_id.clone(), 1);
    park_fn(KillReason::Balance).await.expect("park confirmed");
    let stop = harness
        .fake
        .find("POST", &format!("/v1/boxes/{}/stop", target.box_id.0))
        .unwrap();
    assert_eq!(stop.body["reason"], "balance");
    wait_for(|| {
        existing_slot(&key)?
            .try_lock()
            .ok()?
            .as_ref()
            .filter(|entry| entry.phase == Phase::Parked)
            .map(|entry| entry.stop_reason.clone())
    })
    .await;
    let view = status("node-owner", &conversation)
        .await
        .unwrap()
        .session_box
        .unwrap();
    assert_eq!(view.state, "parked");
    assert_eq!(view.stop_reason.as_deref(), Some("balance"));
    release_conversation("node-owner", &conversation).await;
}

// ── Admission ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn session_box_caps_claim_preflight_and_box_limits() {
    let harness = Harness::new().await;

    // The signed claim: one running Box.
    let user = unique("cap-user");
    let owner = format!("user:{user}");
    let auth = cloud_user(&user, true, Some(1)).await;
    let first = unique("cap-a");
    acquire(&auth, &SessionBoxKey::session(&owner, &first)).await;
    let error = desktop_target(
        &auth,
        &SessionBoxKey::session(&owner, &unique("cap-b")),
        Some(AcquireReason::ComputerUse),
    )
    .await
    .unwrap_err();
    assert_eq!(
        code(&error),
        (
            StatusCode::TOO_MANY_REQUESTS,
            "session_box_limit_reached".to_owned()
        )
    );
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 1);
    let caps = status(&owner, &first).await.unwrap().caps.unwrap();
    assert_eq!(
        caps,
        BoxCaps {
            running: 1,
            max: Some(1)
        }
    );

    // The credit pre-flight.
    write(
        &WALLET,
        Some(Some(json!({"balance_micro_usd": 0, "empty": true}))),
    );
    let error = desktop_target(
        &local_owner(),
        &SessionBoxKey::session("node-owner", &unique("broke")),
        Some(AcquireReason::ComputerUse),
    )
    .await
    .unwrap_err();
    assert_eq!(
        code(&error),
        (
            StatusCode::PAYMENT_REQUIRED,
            "session_box_insufficient_credits".to_owned()
        )
    );
    write(&WALLET, Some(None));

    // A local owner has no claim: the Box service's limits decide.
    let before = harness.fake.matching("GET", "/v1/limits").len();
    harness
        .fake
        .set_limits(json!({"running": 3, "maxRunning": 3, "stored": 0, "maxStored": 64}));
    let error = desktop_target(
        &local_owner(),
        &SessionBoxKey::session("node-owner", &unique("full")),
        Some(AcquireReason::ComputerUse),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error).1, "session_box_limit_reached");
    assert!(harness.fake.matching("GET", "/v1/limits").len() > before);
    harness
        .fake
        .set_limits(json!({"running": 0, "maxRunning": 3, "stored": 0, "maxStored": 64}));
    let open = unique("open");
    acquire(&local_owner(), &SessionBoxKey::session("node-owner", &open)).await;
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 2);

    // Box capacity: 503 with the service's retry delay.
    harness.fake.fail_create(
        503,
        json!({"error": {"code": "capacity_unavailable", "message": "full"}}),
        Some(45),
    );
    let error = desktop_target(
        &local_owner(),
        &SessionBoxKey::session("node-owner", &unique("no-capacity")),
        Some(AcquireReason::ComputerUse),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error).1, "session_box_capacity");
    assert_eq!(error.1 .0["error"]["retryAfter"], 45);

    release_conversation(&owner, &first).await;
    release_conversation("node-owner", &open).await;
}

#[tokio::test]
async fn session_box_a_sub_agent_refused_by_the_cap_shares_the_parent_box() {
    let harness = Harness::new().await;
    let user = unique("fanout-user");
    let owner = format!("user:{user}");
    let auth = cloud_user(&user, true, Some(1)).await;
    let conversation = unique("fanout");
    let parent = acquire(&auth, &SessionBoxKey::session(&owner, &conversation)).await;
    let child = SessionBoxKey::child(
        &owner,
        &conversation,
        next_child_index(&owner, &conversation).unwrap(),
    );
    let shared = desktop_target(&auth, &child, Some(AcquireReason::SubAgent))
        .await
        .expect("cap pressure is not an error")
        .expect("the child gets a Box");
    assert_eq!(shared.box_id, parent.box_id);
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 1);
    assert!(lock_shared().contains(&child));
    release_conversation(&owner, &conversation).await;
    assert!(!lock_shared().contains(&child));
}

// ── Screen ───────────────────────────────────────────────────────────────────

fn origin_headers(origin: &str) -> axum::http::HeaderMap {
    let mut headers = axum::http::HeaderMap::new();
    headers.insert("origin", origin.parse().unwrap());
    headers
}

#[tokio::test]
async fn session_box_screen_requires_the_owner_and_grants_direct_or_relay() {
    let harness = Harness::new().await;
    let owner_user = unique("screen-owner");
    let owner = format!("user:{owner_user}");
    let auth = cloud_user(&owner_user, true, None).await;
    let conversation = unique("screen");
    let target = acquire(&auth, &SessionBoxKey::session(&owner, &conversation)).await;

    // Another caller: 403, never a grant.
    let intruder = cloud_user(&unique("intruder"), true, None).await;
    let error = api::screen_grant_for_test(
        &intruder,
        &conversation,
        &origin_headers("https://app.ryu.ai"),
        b"",
    )
    .await
    .unwrap_err();
    assert_eq!(
        code(&error),
        (StatusCode::FORBIDDEN, "session_box_forbidden".to_owned())
    );
    // No Box at all: 404.
    let error = api::screen_grant_for_test(
        &auth,
        &unique("none"),
        &origin_headers("https://app.ryu.ai"),
        b"",
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error).1, "session_box_not_found");

    // Self-hosted (no public ingress): relay mode.
    let relay =
        api::screen_grant_for_test(&auth, &conversation, &axum::http::HeaderMap::new(), b"")
            .await
            .unwrap();
    assert_eq!(relay["mode"], "relay");
    assert_eq!(
        relay["path"],
        format!("/api/session-boxes/{conversation}/screen/ws")
    );
    assert_eq!(relay["protocols"], json!([]));
    assert!(relay.get("url").is_none());

    // Hosted: direct mode with an absolute URL and the token in protocols.
    harness.direct();
    let direct = api::screen_grant_for_test(
        &auth,
        &conversation,
        &origin_headers("https://app.ryu.ai"),
        br#"{"viewOnly":true}"#,
    )
    .await
    .unwrap();
    assert_eq!(direct["mode"], "direct");
    assert_eq!(
        direct["url"],
        format!("{PUBLIC_BASE}/v1/boxes/{}/desktop/ws", target.box_id.0)
    );
    assert_eq!(
        direct["protocols"],
        json!(["ryu.box.v1", format!("ryu.token.{DESKTOP_TOKEN}")])
    );
    assert!(
        !direct.to_string().contains(BEARER),
        "the tenant bearer never reaches a viewer"
    );
    let grant: ryu_sandbox::box_types::DesktopGrant =
        serde_json::from_value(direct.clone()).expect("the wire matches DesktopGrant");
    assert_eq!(grant.mode, ryu_sandbox::box_types::StreamMode::Direct);
    let minted = harness
        .fake
        .find(
            "POST",
            &format!("/v1/boxes/{}/access-tokens", target.box_id.0),
        )
        .unwrap();
    assert_eq!(
        minted.body,
        json!({"scope": "desktop", "origin": "https://app.ryu.ai", "sub": owner, "viewOnly": true})
    );
    // A direct grant needs a viewer origin.
    let error =
        api::screen_grant_for_test(&auth, &conversation, &axum::http::HeaderMap::new(), b"")
            .await
            .unwrap_err();
    assert_eq!(code(&error).0, StatusCode::BAD_REQUEST);

    release_conversation(&owner, &conversation).await;
}

/// Issue a `session-box` ticket the way a client does.
async fn ticket(path: &str, jwt: Option<&str>) -> String {
    let mut headers = axum::http::HeaderMap::new();
    if let Some(token) = crate::node_token::active_token() {
        headers.insert(
            "authorization",
            format!("Bearer {}", token.trim()).parse().unwrap(),
        );
    }
    if let Some(jwt) = jwt {
        headers.insert("x-ryu-user-jwt", jwt.parse().unwrap());
    }
    let response = crate::server::ws_ticket::issue(
        axum::extract::ConnectInfo(std::net::SocketAddr::from((
            std::net::Ipv4Addr::LOCALHOST,
            50_001,
        ))),
        headers,
        axum::Json(crate::server::ws_ticket::IssueWsTicketRequest {
            route: "session-box".to_owned(),
            path: Some(path.to_owned()),
            room_id: None,
            kind: None,
            app_id: None,
        }),
    )
    .await;
    assert!(response.status().is_success(), "{}", response.status());
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    serde_json::from_slice::<Value>(&body).unwrap()["ticket"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn core_server() -> (String, tempfile::TempDir) {
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let address = serve(public_routes().with_state(state)).await;
    (address, directory)
}

fn upgrade_status(
    result: Result<
        (
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            tokio_tungstenite::tungstenite::handshake::client::Response,
        ),
        tokio_tungstenite::tungstenite::Error,
    >,
) -> u16 {
    match result {
        Ok(_) => 101,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => response.status().as_u16(),
        Err(error) => panic!("unexpected WebSocket failure: {error}"),
    }
}

#[tokio::test]
async fn session_box_relay_bridges_the_owner_and_refuses_others_and_hosted_mode() {
    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let harness = Harness::new().await;
    let owner_user = unique("relay-owner");
    let owner = format!("user:{owner_user}");
    let jwt = cloud_jwt(&owner_user, true, None).await;
    let auth = environments::tests::cloud_auth(jwt.clone()).await;
    let conversation = unique("relay");
    let target = acquire(&auth, &SessionBoxKey::session(&owner, &conversation)).await;
    let (core, _directory) = core_server().await;
    let path = format!("/api/session-boxes/{conversation}/screen/ws");
    let ws_url = |ticket: &str| format!("{}{path}?ticket={ticket}", core.replacen("http", "ws", 1));

    // No or a bad ticket: 401.
    assert_eq!(
        upgrade_status(tokio_tungstenite::connect_async(ws_url("bogus")).await),
        401
    );

    // The owner's ticket: bridged to the Box's desktop socket.
    let ticket_value = ticket(&path, Some(&jwt)).await;
    let mut request = ws_url(&ticket_value).into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", "http://localhost:1420".parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .expect("relay upgrade");
    socket
        .send(tokio_tungstenite::tungstenite::Message::binary(vec![
            1, 2, 3,
        ]))
        .await
        .unwrap();
    let echoed = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(echoed.into_data().to_vec(), vec![1, 2, 3]);
    let dial = harness
        .fake
        .find("WS", &format!("/v1/boxes/{}/desktop/ws", target.box_id.0))
        .expect("the relay dialled the Box service");
    assert_eq!(
        dial.headers.get("origin").map(String::as_str),
        Some("http://localhost:1420")
    );
    assert!(dial.headers["sec-websocket-protocol"].contains(&format!("ryu.token.{DESKTOP_TOKEN}")));
    assert!(
        !dial.headers.values().any(|value| value.contains(BEARER)),
        "the tenant bearer is never dialled with"
    );
    assert_eq!(relay_viewer_count(&target.box_id.0), 1);
    socket.close(None).await.unwrap();
    wait_for(|| (relay_viewer_count(&target.box_id.0) == 0).then_some(())).await;

    // A ticket is single-use.
    assert_eq!(
        upgrade_status(tokio_tungstenite::connect_async(ws_url(&ticket_value)).await),
        401
    );

    // Another caller's ticket: refused.
    let other_user = unique("relay-other");
    let other_jwt = cloud_jwt(&other_user, true, None).await;
    let other_ticket = ticket(&path, Some(&other_jwt)).await;
    assert_eq!(
        upgrade_status(tokio_tungstenite::connect_async(ws_url(&other_ticket)).await),
        403
    );

    // Hosted mode: 409, video never crosses the node.
    harness.direct();
    let hosted_ticket = ticket(&path, Some(&jwt)).await;
    assert_eq!(
        upgrade_status(tokio_tungstenite::connect_async(ws_url(&hosted_ticket)).await),
        409
    );

    release_conversation(&owner, &conversation).await;
}

// ── gwb1 ─────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn session_box_gwb1_is_scoped_refreshed_while_live_and_stops_after_park() {
    assert_eq!(inference::REFRESH_INTERVAL, Duration::from_secs(600));
    assert_eq!(inference::KEY_TTL_SECONDS, 1200);
    let harness = Harness::new().await;
    write(&REFRESH, Some(Duration::from_millis(100)));
    let user = unique("gwb1-user");
    let owner = format!("user:{user}");
    let auth = cloud_user(&user, true, None).await;
    let conversation = unique("gwb1");
    let key = SessionBoxKey::session(&owner, &conversation);
    let target = acquire(&auth, &key).await;
    let path = format!("/v1/boxes/{}/session-credential", target.box_id.0);

    let puts = wait_for(|| {
        let puts = harness.fake.matching("PUT", &path);
        (puts.len() >= 3).then_some(puts)
    })
    .await;
    let now = unix_now();
    for put in &puts {
        let token = put.body["key"].as_str().unwrap();
        assert!(token.starts_with("gwb1."));
        let scope = BoxInferenceScope::verify(token, SIGNER_KEY).expect("signed by Core");
        assert_eq!(scope.org_id, "local");
        assert_eq!(scope.user_id.as_deref(), Some(user.as_str()));
        assert_eq!(scope.session_id, conversation);
        assert_eq!(scope.box_id, target.box_id.0);
        assert_eq!(scope.lease_epoch, 1);
        assert!(scope.expires_at <= now + 1200 + 5);
        assert_eq!(put.body["gatewayUrl"], BOX_GATEWAY_URL);
    }
    assert!(BoxInferenceScope::verify(puts[0].body["key"].as_str().unwrap(), "wrong-key").is_err());
    let create = harness.fake.find("POST", "/v1/boxes").unwrap();
    assert!(!create.body.to_string().contains("gwb1."));

    park(&key, ParkReason::User).await.unwrap();
    let parked = harness.fake.matching("PUT", &path).len();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        harness.fake.matching("PUT", &path).len(),
        parked,
        "refresh stops after a park"
    );
    release_conversation(&owner, &conversation).await;
}

#[tokio::test]
async fn session_box_no_reachable_gateway_delivers_no_key() {
    let harness = Harness::new().await;
    write(&GATEWAY_URL, Some(None));
    let conversation = unique("no-gateway");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let target = acquire(&local_owner(), &key).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(harness
        .fake
        .matching(
            "PUT",
            &format!("/v1/boxes/{}/session-credential", target.box_id.0)
        )
        .is_empty());
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_inference_relay_accepts_only_live_gwb1_keys() {
    let harness = Harness::new().await;
    // A loopback Gateway that echoes what it received.
    let seen: Arc<StdMutex<Vec<(String, String)>>> = Arc::default();
    let recorded = seen.clone();
    let gateway = serve(Router::new().fallback(any(move |request: Request| {
        let recorded = recorded.clone();
        async move {
            let auth = request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_owned();
            recorded
                .lock()
                .unwrap()
                .push((request.uri().path().to_owned(), auth));
            axum::Json(json!({"ok": true})).into_response()
        }
    })))
    .await;
    write(&UPSTREAM, Some(gateway));
    let (core, _directory) = core_server().await;
    let url = format!("{core}/api/session-boxes/inference/v1/chat/completions");
    let client = reqwest::Client::new();
    let post = |bearer: Option<String>| {
        let mut request = client
            .post(&url)
            .header("content-type", "application/json")
            .body(r#"{"model":"auto","messages":[]}"#);
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        request.send()
    };

    assert_eq!(post(None).await.unwrap().status(), 401);
    assert_eq!(
        post(Some("sk-node-key".to_owned())).await.unwrap().status(),
        401
    );
    assert_eq!(
        post(Some("gws1.00.00".to_owned())).await.unwrap().status(),
        401
    );

    let conversation = unique("relay-inference");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let target = acquire(&local_owner(), &key).await;
    let now = unix_now();
    let scope = inference::scope_for(&key, &target.box_id, 1, now);
    let token = scope.sign_at(SIGNER_KEY, now).unwrap();
    let forged = scope.sign_at("another-key", now).unwrap();
    assert_eq!(post(Some(forged)).await.unwrap().status(), 401);
    let stale = inference::scope_for(&key, &target.box_id, 7, now)
        .sign_at(SIGNER_KEY, now)
        .unwrap();
    assert_eq!(
        post(Some(stale)).await.unwrap().status(),
        401,
        "an old epoch is refused"
    );

    let response = post(Some(token.clone())).await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.json::<Value>().await.unwrap()["ok"], true);
    assert_eq!(
        seen.lock().unwrap().last().cloned(),
        Some(("/v1/chat/completions".to_owned(), format!("Bearer {token}")))
    );

    park(&key, ParkReason::User).await.unwrap();
    assert_eq!(
        post(Some(token)).await.unwrap().status(),
        401,
        "a parked Box's key is refused"
    );
    drop(harness);
}

/// `create_router` merges the protected routes and the public routes into one
/// router: they must not conflict (axum panics on overlapping routes at
/// startup), and the static `inference` segment must win over the
/// `{conversationId}` routes, so a Box's inference call reaches the relay.
#[tokio::test]
async fn session_box_protected_and_public_routes_merge_without_conflict() {
    use tower::ServiceExt as _;
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let router = routes().merge(public_routes()).with_state(state);
    for method in ["GET", "POST"] {
        let response = router
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method(method)
                    .uri("/api/session-boxes/inference/v1/chat/completions")
                    .header("authorization", "Bearer sk-not-a-box-key")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{method}");
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["error"]["code"],
            "session_box_inference_unauthorized",
            "{method} reaches the inference relay"
        );
    }
    assert_eq!(
        crate::server::route_policy(
            &axum::http::Method::GET,
            "/api/session-boxes/conversation-1"
        ),
        crate::authorization::RoutePolicy::requires([
            crate::authorization::Capability::GatewayRoute
        ])
    );
}

// ── Review fixes ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn session_box_billing_park_interrupts_a_busy_box() {
    // A foreground command holds the Box: the service refuses a plain stop
    // with `409 box_busy`. A balance kill must still park within seconds.
    let harness = Harness::new().await;
    let conversation = unique("busy");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let target = acquire(&local_owner(), &key).await;
    harness.fake.set_busy(&target.box_id.0);

    let park_fn = session_kill_action(key.clone(), target.box_id.clone(), 1);
    park_fn(KillReason::Balance)
        .await
        .expect("a busy Box is interrupted and parked");
    let interrupt = format!("/v1/boxes/{}/interrupt", target.box_id.0);
    assert_eq!(harness.fake.matching("POST", &interrupt).len(), 1);
    let stops = harness
        .fake
        .matching("POST", &format!("/v1/boxes/{}/stop", target.box_id.0));
    assert!(stops.len() >= 2, "the refused stop is retried");
    assert!(stops.iter().all(|stop| stop.body["reason"] == "balance"));
    wait_for(|| {
        existing_slot(&key)?
            .try_lock()
            .ok()?
            .as_ref()
            .filter(|entry| entry.phase == Phase::Parked)
            .map(|_| ())
    })
    .await;
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_a_parked_box_whose_turn_token_expired_is_refused_not_dropped() {
    let harness = Harness::new().await;
    let user = unique("expired");
    let owner = format!("user:{user}");
    let conversation = unique("expired-conv");
    let key = SessionBoxKey::session(&owner, &conversation);
    acquire(&cloud_user(&user, true, None).await, &key).await;
    park(&key, ParkReason::Idle).await.unwrap();

    // The same turn, 15+ minutes later: its JWT no longer verifies.
    let mut expired = cloud_user(&user, true, None).await;
    expired.verified_user_jwt = Some(
        environments::tests::signed_user_jwt_with_claims(
            json!({
                "id": user,
                "sub": user,
                "email": format!("{user}@example.com"),
                "ryu_flags": [environments::BOX_BACKEND_FLAG],
            }),
            -600,
        )
        .await,
    );
    let error = desktop_target(&expired, &key, Some(AcquireReason::ComputerUse))
        .await
        .expect_err("a parked Box never silently becomes the node");
    assert_eq!(
        code(&error),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "session_box_authority_expired".to_owned()
        )
    );
    assert_eq!(entry_phase(&key).await.unwrap().0, Phase::Parked);
    // A conversation without a Box still keeps the node for such a caller.
    assert_eq!(
        desktop_target(
            &expired,
            &SessionBoxKey::session(&owner, &unique("no-box")),
            Some(AcquireReason::ComputerUse)
        )
        .await
        .unwrap(),
        None
    );
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 1);
    release_conversation(&owner, &conversation).await;
}

#[tokio::test]
async fn session_box_an_acquire_waiting_on_a_deleted_conversation_creates_nothing() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("delete-race");
    let key = SessionBoxKey::session("node-owner", &conversation);
    // An acquire is waiting on the slot (another call holds it) when the
    // conversation is deleted.
    let slot = slot_for(&key);
    let held = slot.lock().await;
    let waiting = tokio::spawn({
        let auth = auth.clone();
        let key = key.clone();
        async move { desktop_target(&auth, &key, Some(AcquireReason::ComputerUse)).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    let release = tokio::spawn({
        let conversation = conversation.clone();
        async move { release_conversation("node-owner", &conversation).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    drop(held);
    let refused = waiting
        .await
        .unwrap()
        .expect_err("no Box for a deleted conversation");
    assert_eq!(
        code(&refused),
        (
            StatusCode::GONE,
            "session_box_conversation_deleted".to_owned()
        )
    );
    release.await.unwrap();
    // A turn still running after the delete cannot recreate it either.
    assert_eq!(
        code(
            &desktop_target(&auth, &key, Some(AcquireReason::ComputerUse))
                .await
                .unwrap_err()
        )
        .1,
        "session_box_conversation_deleted"
    );
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
    assert!(conversation_keys(&conversation).is_empty());
    assert!(leases()
        .iter()
        .all(|lease| lease.conversation_id != conversation));
}

#[tokio::test]
async fn session_box_recovery_skips_creates_in_flight_and_ends_orphan_metering() {
    let harness = Harness::new().await;
    // A create in flight: its lease has no box id yet.
    let creating = uuid::Uuid::new_v4().to_string();
    let marker = CreatingLease::new(&creating);
    write_lease(&SessionLease {
        schema_version: 1,
        id: creating.clone(),
        owner: "node-owner".to_owned(),
        conversation_id: unique("in-flight"),
        child: None,
        box_id: None,
        size: BoxSize::Small,
        parked: false,
        deleted: false,
        box_expires_at: unix_now() + 3600,
        lease_epoch: 1,
    })
    .unwrap();
    // A Box whose run is metered with no registry entry left to park it.
    let orphan_box = format!("bx_{}", "f".repeat(32));
    let orphan = uuid::Uuid::new_v4().to_string();
    harness.fake.add_box(&orphan_box, &box_name(&orphan));
    write_lease(&SessionLease {
        schema_version: 1,
        id: orphan.clone(),
        owner: "node-owner".to_owned(),
        conversation_id: unique("orphan"),
        child: None,
        box_id: Some(orphan_box.clone()),
        size: BoxSize::Small,
        parked: false,
        deleted: false,
        box_expires_at: unix_now() + 3600,
        lease_epoch: 1,
    })
    .unwrap();
    let orphan_run = run_id_for(&orphan, 1);
    heartbeat::register(
        orphan_run.clone(),
        None,
        "box",
        WorkspaceId(orphan_box.clone()),
        ryu_sandbox::box_types::spec_for(BoxSize::Small),
        0,
    );

    recover_leases().await;
    assert!(
        leases().iter().any(|lease| lease.id == creating),
        "an in-flight create's lease is not destroyed"
    );
    assert!(
        heartbeat::run_snapshot(&orphan_run).is_none(),
        "the orphan's metering ended"
    );
    assert!(harness
        .fake
        .find("POST", &format!("/v1/boxes/{orphan_box}/stop"))
        .is_some());
    drop(marker);
    let _ = remove_lease(&creating);
}

#[tokio::test]
async fn session_box_child_numbers_are_reused_and_never_aliased() {
    let _harness = Harness::new().await;
    let conversation = unique("many-children");
    for expected in 1..=MAX_CHILDREN {
        assert_eq!(next_child_index("user:a", &conversation), Some(expected));
    }
    assert_eq!(
        next_child_index("user:a", &conversation),
        None,
        "all numbers held: no alias of #sub:64"
    );
    let key = SessionBoxKey::child("user:a", &conversation, 5);
    release_child(&key).await;
    assert_eq!(next_child_index("user:a", &conversation), Some(5));
    lock_child_counters().retain(|(_, id), _| id != &conversation);
}

#[tokio::test]
async fn session_box_idle_sweep_keeps_a_parent_whose_children_are_working() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("fanout-idle");
    let parent = SessionBoxKey::session("node-owner", &conversation);
    let parent_box = acquire(&auth, &parent).await;
    let child = SessionBoxKey::child(
        "node-owner",
        &conversation,
        next_child_index("node-owner", &conversation).unwrap(),
    );
    let child_box = desktop_target(&auth, &child, Some(AcquireReason::SubAgent))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(child_box.box_id, parent_box.box_id);
    // The parent waits on its fan-out; the child is busy.
    age_entry(&parent, 3600).await;
    assert!(idle::sweep_once(Duration::from_secs(600)).await.is_empty());
    assert_eq!(entry_phase(&parent).await.unwrap().0, Phase::Live);
    assert_eq!(entry_phase(&child).await.unwrap().0, Phase::Live);
    // Once the child is idle too, both park.
    age_entry(&child, 3600).await;
    let parked = idle::sweep_once(Duration::from_secs(600)).await;
    assert!(parked.contains(&(parent.clone(), ParkReason::Idle)));
    assert_eq!(entry_phase(&child).await.unwrap().0, Phase::Parked);
    assert!(harness
        .fake
        .find("POST", &format!("/v1/boxes/{}/stop", child_box.box_id.0))
        .is_some());
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_preflight_holds_the_first_box_to_the_gateway_quote() {
    let harness = Harness::new().await;
    // No Box of any size runs, so the rate comes from the Gateway's quote.
    // The 5-minute minimum at a quoted $0.40/h is 33_333 micro-USD.
    write(&QUOTE, Some(Ok(400_000)));
    assert_eq!(
        caps::preflight_rate(BoxSize::Small, true).await,
        caps::PreflightRate::Known(400_000)
    );
    assert_eq!(
        caps::preflight_rate(BoxSize::Large, false).await,
        caps::PreflightRate::NotCoreMetered
    );
    write(&WALLET, Some(Some(json!({"balance_micro_usd": 33_332}))));
    let error = desktop_target(
        &local_owner(),
        &SessionBoxKey::session("node-owner", &unique("quote-broke")),
        Some(AcquireReason::ComputerUse),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error).1, "session_box_insufficient_credits");
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());

    // The same balance covers a size the Gateway prices lower.
    caps::clear_quotes();
    write(&QUOTE, Some(Ok(25_000)));
    let cheap = unique("quote-cheap");
    acquire(
        &local_owner(),
        &SessionBoxKey::session("node-owner", &cheap),
    )
    .await;
    release_conversation("node-owner", &cheap).await;

    // An unknown rate never falls back to a price table: the Box is refused.
    caps::clear_quotes();
    write(&QUOTE, Some(Err("gateway down".to_owned())));
    let error = desktop_target(
        &local_owner(),
        &SessionBoxKey::session("node-owner", &unique("quote-unknown")),
        Some(AcquireReason::ComputerUse),
    )
    .await
    .unwrap_err();
    assert_eq!(
        code(&error),
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "session_box_rate_unavailable".to_owned()
        )
    );

    // A Box another owner bills (settlement) is not held to Core's horizon,
    // so it needs no rate.
    let mut settled = credential(&harness.fake.base, None);
    settled.billing_owner = BillingOwner::Settlement;
    write(&CREDENTIAL, Some(settled));
    let conversation = unique("settled");
    acquire(
        &local_owner(),
        &SessionBoxKey::session("node-owner", &conversation),
    )
    .await;
    write(&WALLET, Some(None));
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_a_stale_kill_never_parks_the_resumed_phase() {
    let _harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("stale-kill");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let first = acquire(&auth, &key).await;
    park(&key, ParkReason::User).await.unwrap();
    let resumed = acquire(&auth, &key).await;
    assert_eq!(resumed.box_id, first.box_id);
    assert_ne!(
        resumed.run_id, first.run_id,
        "each live phase is its own run"
    );
    // The first phase's kill verdict lands late.
    mark_killed(key.clone(), 1, KillReason::Balance).await;
    let (phase, reason, epoch) = entry_phase(&key).await.unwrap();
    assert_eq!((phase, reason, epoch), (Phase::Live, None, 2));
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_recovery_continues_above_the_persisted_epoch() {
    let harness = Harness::new().await;
    let conversation = unique("epoch");
    let box_id = format!("bx_{}", "a".repeat(32));
    let lease_id = uuid::Uuid::new_v4().to_string();
    harness.fake.add_box(&box_id, &box_name(&lease_id));
    write_lease(&SessionLease {
        schema_version: 1,
        id: lease_id.clone(),
        owner: "node-owner".to_owned(),
        conversation_id: conversation.clone(),
        child: None,
        box_id: Some(box_id.clone()),
        size: BoxSize::Small,
        parked: true,
        deleted: false,
        box_expires_at: unix_now() + 3600,
        // A key for epoch 2 was signed before the restart.
        lease_epoch: 2,
    })
    .unwrap();
    recover_leases().await;
    let key = SessionBoxKey::session("node-owner", &conversation);
    assert_eq!(entry_phase(&key).await.unwrap().2, 3);
    acquire(&local_owner(), &key).await;
    assert_eq!(entry_phase(&key).await.unwrap().2, 4, "never epoch 2 again");
    assert!(leases()
        .iter()
        .any(|lease| lease.id == lease_id && lease.lease_epoch == 4));
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_a_service_without_a_desktop_keeps_computer_use_on_the_node() {
    let harness = Harness::new().await;
    harness.fake.without_desktop();
    let key = SessionBoxKey::session("node-owner", &unique("no-desktop"));
    assert_eq!(
        desktop_target(&local_owner(), &key, Some(AcquireReason::ComputerUse))
            .await
            .unwrap(),
        None
    );
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
    assert!(existing_slot(&key).is_none());
}

#[test]
fn session_box_low_credit_minutes_count_every_box_on_the_wallet() {
    let run = |id: &str, org: Option<&str>, rate: Option<u64>| heartbeat::SandboxRunSnapshot {
        run_id: id.to_owned(),
        org_id: org.map(str::to_owned),
        backend: "box".to_owned(),
        spec: ryu_sandbox::box_types::spec_for(BoxSize::Small),
        elapsed_seconds: 0,
        ticked_seconds: 0,
        tick_index: 0,
        accrued_micro_usd: 0,
        per_run_budget_micro_usd: 0,
        last_verdict: None,
        balance_micro_usd: Some(40_000),
        rate_micro_usd_per_hour: rate,
        box_id: None,
        size: Some(BoxSize::Small),
        stopping: false,
        minimum_waived: false,
    };
    let this = run("a", Some("org"), Some(40_000));
    let active = vec![
        this.clone(),
        run("b", Some("org"), Some(40_000)),
        run("c", Some("org"), Some(40_000)),
        run("d", Some("org"), Some(40_000)),
        run("other-org", Some("org-2"), Some(40_000)),
        run("unrated", Some("org"), None),
    ];
    let rate = combined_rate(&this, &active);
    assert_eq!(rate, Some(160_000));
    // $0.04 left across four $0.04/h Boxes: 15 minutes, not 60.
    let minutes = minutes_remaining(this.balance_micro_usd, rate);
    assert_eq!(minutes, Some(15));
    assert_eq!(
        warning_level(None, minutes_remaining(Some(30_000), rate), Some(30_000)),
        "low"
    );
    assert_eq!(combined_rate(&run("x", None, Some(10)), &active), Some(10));
    assert_eq!(combined_rate(&run("y", Some("org"), None), &active), None);
}

#[tokio::test]
async fn session_box_a_cloud_task_box_is_admitted_against_the_claim_cap() {
    let _harness = Harness::new().await;
    let user = unique("task-cap");
    let owner = format!("user:{user}");
    let auth = cloud_user(&user, true, Some(1)).await;
    let conversation = unique("task-cap-conv");
    acquire(&auth, &SessionBoxKey::session(&owner, &conversation)).await;
    let refused = admit_cloud_task(&auth, &owner, BoxSize::Small)
        .await
        .expect_err("the plan's one running Box is taken");
    assert_eq!(refused.0 .0, StatusCode::TOO_MANY_REQUESTS);
    assert!(refused.to_string().contains("limit"));
    release_conversation(&owner, &conversation).await;
    admit_cloud_task(&auth, &owner, BoxSize::Small)
        .await
        .expect("admitted once nothing runs");
}

// ── The one-time computer-use cost notice ────────────────────────────────────

fn notice_body(error: &ApiError) -> Value {
    error.1 .0["error"].clone()
}

#[tokio::test]
async fn session_box_first_computer_use_box_waits_for_the_cost_notice() {
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    let auth = local_owner();
    let conversation = unique("notice");
    let key = SessionBoxKey::session("node-owner", &conversation);

    // The first Box is refused with the size and the Gateway's live rate,
    // and nothing is created.
    let error = desktop_target(&auth, &key, Some(AcquireReason::ComputerUse))
        .await
        .unwrap_err();
    assert_eq!(error.0, StatusCode::PRECONDITION_REQUIRED);
    let body = notice_body(&error);
    assert_eq!(body["code"], notice::NOTICE_REQUIRED_CODE);
    assert_eq!(body["size"], "small");
    assert_eq!(body["ratePerHourMicroUsd"], 25_000);
    assert_eq!(body["minimumSecondsPerStart"], 300);
    let message = body["message"].as_str().unwrap();
    assert!(message.contains("$0.025 an hour"), "{body}");
    assert!(
        message.contains("5-minute minimum each time it starts (a resume within the hour already paid owes no new one)"),
        "{body}"
    );
    assert!(message.contains("Settings > Computer use"), "{body}");
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
    assert!(
        existing_slot(&key).is_none(),
        "no empty slot is left behind"
    );

    // The conversation's status carries the notice for the UI.
    let found = status("node-owner", &conversation).await.expect("status");
    assert!(found.session_box.is_none());
    assert_eq!(
        found.cost_notice,
        Some(notice::CostNotice {
            required: true,
            size: "small".to_owned(),
            rate_per_hour_micro_usd: Some(25_000),
            minimum_seconds_per_start: 300,
            waiting: false,
        })
    );
    let wire = serde_json::to_value(&found).unwrap();
    assert_eq!(wire["costNotice"]["ratePerHourMicroUsd"], 25_000);
    assert_eq!(wire["costNotice"]["minimumSecondsPerStart"], 300);
    assert_eq!(wire["costNotice"]["waiting"], false);

    // A sub-agent's first Box waits for the same acknowledgement.
    let child = SessionBoxKey::child("node-owner", &conversation, 1);
    let error = desktop_target(&auth, &child, Some(AcquireReason::SubAgent))
        .await
        .unwrap_err();
    assert_eq!(code(&error).1, notice::NOTICE_REQUIRED_CODE);

    // A stale rate is refused with the current one, which the notice then shows.
    harness.set_quote(Ok(30_000));
    let stale = notice::acknowledge("node-owner", 25_000).await.unwrap_err();
    assert_eq!(
        status("node-owner", &conversation)
            .await
            .and_then(|found| found.cost_notice)
            .and_then(|notice| notice.rate_per_hour_micro_usd),
        Some(30_000)
    );
    harness.set_quote(Ok(25_000));
    assert_eq!(
        code(&stale),
        (StatusCode::CONFLICT, "session_box_rate_changed".to_owned())
    );
    assert_eq!(notice_body(&stale)["ratePerHourMicroUsd"], 30_000);
    assert!(notice::acknowledgement("node-owner").is_none());

    // The acknowledgement clears the notice and lets the Box start.
    let acknowledged = notice::acknowledge("node-owner", 25_000).await.unwrap();
    assert_eq!(acknowledged.rate_per_hour_micro_usd, 25_000);
    assert!(status("node-owner", &conversation).await.is_none());
    let target = acquire(&auth, &key).await;
    assert!(target.desktop);
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 1);

    // Once per owner: another conversation of the same owner starts at once.
    let other = SessionBoxKey::session("node-owner", &unique("notice-other"));
    acquire(&auth, &other).await;
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 2);

    // The acknowledgement survives a restart (the store is reloaded from disk).
    notice::reset_for_test(false);
    assert_eq!(
        notice::acknowledgement("node-owner"),
        Some(acknowledged),
        "stored under state/"
    );

    release_conversation("node-owner", &conversation).await;
    release_conversation("node-owner", &other.conversation_id).await;
}

#[tokio::test]
async fn session_box_cost_notice_is_per_owner() {
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    let conversation = unique("notice-owner");
    notice::acknowledge("user:alice-notice", 25_000)
        .await
        .unwrap();

    let bob = cloud_user("bob-notice", true, None).await;
    let key = SessionBoxKey::session("user:bob-notice", &conversation);
    let error = desktop_target(&bob, &key, Some(AcquireReason::ComputerUse))
        .await
        .unwrap_err();
    assert_eq!(code(&error).1, notice::NOTICE_REQUIRED_CODE);
    assert!(status("user:alice-notice", &conversation).await.is_none());
    assert!(status("user:bob-notice", &conversation)
        .await
        .and_then(|found| found.cost_notice)
        .is_some());
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
}

#[tokio::test]
async fn session_box_cost_notice_without_a_rate_cannot_be_acknowledged() {
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Err("gateway down".to_owned()));
    let conversation = unique("notice-rate");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let error = desktop_target(&local_owner(), &key, Some(AcquireReason::ComputerUse))
        .await
        .unwrap_err();
    let body = notice_body(&error);
    assert_eq!(body["code"], notice::NOTICE_REQUIRED_CODE);
    assert!(body["ratePerHourMicroUsd"].is_null());
    assert!(body["message"]
        .as_str()
        .unwrap()
        .contains("billed by the hour"));
    let refused = notice::acknowledge("node-owner", 25_000).await.unwrap_err();
    assert_eq!(code(&refused).1, "session_box_rate_unavailable");
    assert!(notice::acknowledgement("node-owner").is_none());
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
}

#[tokio::test]
async fn session_box_a_parked_box_resumes_without_the_cost_notice() {
    let harness = Harness::new().await;
    let auth = local_owner();
    let conversation = unique("notice-parked");
    let key = SessionBoxKey::session("node-owner", &conversation);
    acquire(&auth, &key).await;
    park(&key, ParkReason::User).await.unwrap();
    // The owner's store is empty now (a Box created before the notice).
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    let resumed = desktop_target(&auth, &key, Some(AcquireReason::ComputerUse))
        .await
        .unwrap();
    assert!(resumed.is_some());
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 1);
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_cost_notice_route_acknowledges_for_the_caller() {
    use tower::ServiceExt as _;
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let router = routes()
        .layer(axum::Extension(local_owner()))
        .with_state(state);
    let conversation = unique("notice-route");
    let post = |body: &'static str| {
        axum::http::Request::builder()
            .method("POST")
            .uri(format!("/api/session-boxes/{conversation}/cost-notice"))
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body))
            .unwrap()
    };
    let read = |response: axum::response::Response| async move {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        (status, serde_json::from_slice::<Value>(&body).unwrap())
    };

    let (status_code, body) = read(router.clone().oneshot(post("{}")).await.unwrap()).await;
    assert_eq!(status_code, StatusCode::BAD_REQUEST, "{body}");
    let (status_code, body) = read(
        router
            .clone()
            .oneshot(post(r#"{"ratePerHourMicroUsd":25000,"owner":"user:x"}"#))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(
        status_code,
        StatusCode::BAD_REQUEST,
        "unknown fields: {body}"
    );
    let (status_code, body) = read(
        router
            .clone()
            .oneshot(post(r#"{"ratePerHourMicroUsd":1}"#))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status_code, StatusCode::CONFLICT);
    assert_eq!(body["error"]["ratePerHourMicroUsd"], 25_000);
    let (status_code, body) = read(
        router
            .clone()
            .oneshot(post(r#"{"ratePerHourMicroUsd":25000}"#))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status_code, StatusCode::OK, "{body}");
    assert_eq!(body["acknowledged"], true);
    assert_eq!(body["ratePerHourMicroUsd"], 25_000);
    assert!(body["acknowledgedAt"].as_str().is_some());
    assert!(notice::acknowledgement("node-owner").is_some());
    assert_eq!(
        crate::server::route_policy(
            &axum::http::Method::POST,
            &format!("/api/session-boxes/{conversation}/cost-notice")
        ),
        crate::authorization::RoutePolicy::requires([
            crate::authorization::Capability::GatewayRoute
        ])
    );
}

#[tokio::test]
async fn session_box_held_call_starts_the_box_once_the_cost_is_allowed() {
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    write(&NOTICE_WAIT, Some(Duration::from_secs(20)));
    let auth = local_owner();
    let conversation = unique("notice-held");
    let key = SessionBoxKey::session("node-owner", &conversation);

    let held = tokio::spawn({
        let auth = auth.clone();
        let key = key.clone();
        async move { desktop_target(&auth, &key, Some(AcquireReason::ComputerUse)).await }
    });
    // The status shows the notice as waiting while the call is held, and
    // nothing has been created.
    let mut shown = None;
    for _ in 0..200 {
        shown = status("node-owner", &conversation)
            .await
            .and_then(|found| found.cost_notice);
        if shown.as_ref().is_some_and(|notice| notice.waiting) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let shown = shown.expect("the held call shows the notice");
    assert!(shown.waiting, "{shown:?}");
    assert_eq!(shown.rate_per_hour_micro_usd, Some(25_000));
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
    assert!(!held.is_finished());

    // Allowing it lets the same call start the Box: no new message needed.
    notice::acknowledge("node-owner", 25_000).await.unwrap();
    let target = tokio::time::timeout(Duration::from_secs(10), held)
        .await
        .expect("the held call goes on at once")
        .unwrap()
        .expect("admitted")
        .expect("a Box");
    assert!(target.desktop);
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 1);
    assert!(status("node-owner", &conversation)
        .await
        .and_then(|found| found.cost_notice)
        .is_none());
    release_conversation("node-owner", &conversation).await;
}

#[tokio::test]
async fn session_box_unanswered_notice_stops_waiting_and_says_so() {
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    write(&NOTICE_WAIT, Some(Duration::from_millis(200)));
    let conversation = unique("notice-timeout");
    let key = SessionBoxKey::session("node-owner", &conversation);
    let started = Instant::now();
    let error = desktop_target(&local_owner(), &key, Some(AcquireReason::ComputerUse))
        .await
        .unwrap_err();
    assert!(started.elapsed() >= Duration::from_millis(200));
    assert_eq!(code(&error).1, notice::NOTICE_REQUIRED_CODE);
    // The notice stays for the UI but no call is held any more.
    let shown = status("node-owner", &conversation)
        .await
        .and_then(|found| found.cost_notice)
        .expect("the notice stays");
    assert!(!shown.waiting);
    assert!(existing_slot(&key).is_none());
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
}

#[tokio::test]
async fn session_box_cost_notice_is_asked_only_after_admission() {
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    let auth = local_owner();

    // Out of credit: refused for credit, never asked about the cost.
    write(
        &WALLET,
        Some(Some(json!({"balance_micro_usd": 0, "empty": true}))),
    );
    let broke = unique("notice-broke");
    let error = desktop_target(
        &auth,
        &SessionBoxKey::session("node-owner", &broke),
        Some(AcquireReason::ComputerUse),
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error).1, "session_box_insufficient_credits");
    assert!(status("node-owner", &broke)
        .await
        .and_then(|found| found.cost_notice)
        .is_none());
    write(&WALLET, Some(None));

    // At the plan cap: refused for the cap, never asked about the cost.
    harness
        .fake
        .set_limits(json!({"running": 1, "maxRunning": 1, "stored": 0, "maxStored": 64}));
    let capped = unique("notice-capped");
    let error = desktop_target(
        &auth,
        &SessionBoxKey::session("node-owner", &capped),
        Some(AcquireReason::ComputerUse),
    )
    .await
    .unwrap_err();
    assert_eq!(error.0, StatusCode::TOO_MANY_REQUESTS);
    assert!(status("node-owner", &capped)
        .await
        .and_then(|found| found.cost_notice)
        .is_none());
    assert!(harness.fake.matching("POST", "/v1/boxes").is_empty());
}

#[tokio::test]
async fn session_box_cost_can_be_allowed_ahead_of_any_conversation() {
    use tower::ServiceExt as _;
    let harness = Harness::new().await;
    harness.require_cost_notice();
    harness.set_quote(Ok(25_000));
    let directory = tempfile::tempdir().unwrap();
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let router = routes()
        .layer(axum::Extension(local_owner()))
        .with_state(state);
    let send = |method: &'static str, body: &'static str| {
        axum::http::Request::builder()
            .method(method)
            .uri("/api/session-boxes/cost-notice")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(body))
            .unwrap()
    };
    let read = |response: axum::response::Response| async move {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        (status, serde_json::from_slice::<Value>(&body).unwrap())
    };

    let (status_code, body) = read(router.clone().oneshot(send("GET", "")).await.unwrap()).await;
    assert_eq!(status_code, StatusCode::OK, "{body}");
    assert_eq!(body["acknowledged"], false);
    assert!(body.get("acknowledgedAt").is_none());
    assert_eq!(body["size"], "small");
    assert_eq!(body["ratePerHourMicroUsd"], 25_000);
    assert_eq!(body["minimumSecondsPerStart"], 300);

    let (status_code, body) = read(
        router
            .clone()
            .oneshot(send("POST", r#"{"ratePerHourMicroUsd":40000}"#))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status_code, StatusCode::CONFLICT, "{body}");
    let (status_code, body) = read(
        router
            .clone()
            .oneshot(send("POST", r#"{"ratePerHourMicroUsd":25000}"#))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(status_code, StatusCode::OK, "{body}");
    assert_eq!(body["acknowledged"], true);

    let (_, body) = read(router.clone().oneshot(send("GET", "")).await.unwrap()).await;
    assert_eq!(body["acknowledged"], true);
    assert!(body["acknowledgedAt"].as_str().is_some());

    // A run nobody watches (a routine) now starts its Box at once.
    let key = SessionBoxKey::session("node-owner", &unique("notice-routine"));
    acquire(&local_owner(), &key).await;
    assert_eq!(harness.fake.matching("POST", "/v1/boxes").len(), 1);
    release_conversation("node-owner", &key.conversation_id).await;
    assert_eq!(
        crate::server::route_policy(&axum::http::Method::GET, "/api/session-boxes/cost-notice"),
        crate::authorization::RoutePolicy::requires([
            crate::authorization::Capability::GatewayRoute
        ])
    );
}

#[test]
fn session_box_cost_notice_formats_dollars() {
    assert_eq!(notice::dollars(25_000), "$0.025");
    assert_eq!(notice::dollars(40_000), "$0.04");
    assert_eq!(notice::dollars(70_000), "$0.07");
    assert_eq!(notice::dollars(1_500_000), "$1.50");
    assert_eq!(notice::dollars(0), "$0.00");
    assert_eq!(notice::dollars(123_456), "$0.123456");
    // A held call waits long enough for a 10 s status poll to show the notice,
    // and gives up before an MCP client's usual 120 s tool timeout.
    assert_eq!(notice::WAIT_FOR_ACKNOWLEDGEMENT, Duration::from_secs(90));
    assert_eq!(notice::MINIMUM_SECONDS_PER_START, 300);
}
