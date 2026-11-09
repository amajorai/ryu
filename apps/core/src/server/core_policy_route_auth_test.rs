//! Route policy and node authentication on the preference and support-access
//! routes.
//!
//! The router mounts the shipping handlers behind the shipping middleware in
//! `create_router`'s protected order: `require_auth` (with the expected node
//! token injected, as `require_auth_tests` does, so the cases do not race the
//! process-wide token resolver), connection tracking, then the verified-caller
//! layer. Paired credentials are real records in the process paired-client
//! store and resolve through `require_auth`'s own lookup. Durable effects are
//! read back through an independent SQLite connection, a reopened preference
//! store and the support audit file.
use super::*;
use crate::authorization::{Capability, CapabilitySet, GrantConstraints};
use axum::{body::Body, http::Request};
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::TryRecvError;
use tower::ServiceExt;

const OWNER: &str = "core-policy-owner-node-token";
const SECRET: &str = "core-policy-unsplash-secret";

struct Harness {
    _directory: tempfile::TempDir,
    preferences_path: std::path::PathBuf,
    audit_path: std::path::PathBuf,
    state: ServerState,
    router: Router,
}

/// How a request presents (or fails to present) a credential.
#[derive(Clone, Copy, Debug)]
enum Credential<'a> {
    None,
    Bearer(&'a str),
    /// A raw `Authorization` header value.
    Authorization(&'a str),
    /// The node-token header the local model proxies accept.
    NodeTokenHeader(&'a str),
}

struct Reply {
    status: StatusCode,
    body: String,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or_else(|error| {
            panic!("{} body is not JSON ({error}): {}", self.status, self.body)
        })
    }
}

impl Harness {
    fn new(expected_token: Option<&str>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let preferences_path = directory.path().join("preferences.db");
        let audit_path = directory.path().join("support-access-audit.db");
        let mut state = isolated_plugin_hook_test_state(directory.path());
        state.support_audit =
            crate::support_access::SupportAccessStore::open(audit_path.clone()).unwrap();
        let expected = expected_token.map(str::to_owned);
        let auth_token = expected.clone();
        let router = Router::new()
            .route("/api/preferences/stream", get(preferences_stream))
            .route(
                "/api/preferences/:key",
                get(get_preference).put(set_preference),
            )
            .route(
                "/api/support-access/diagnostics",
                get(support_access_diagnostics),
            )
            .route("/api/support-access/audit", get(support_access_audit))
            .layer(middleware::from_fn(attach_verified_caller))
            .layer(middleware::from_fn_with_state(
                state.connections.clone(),
                track_connection,
            ))
            .layer(middleware::from_fn(move |request, next| {
                let expected = expected.clone();
                async move { require_auth_with_token(request, next, expected).await }
            }))
            .layer(axum::Extension(auth_token))
            .with_state(state.clone());
        Self {
            _directory: directory,
            preferences_path,
            audit_path,
            state,
            router,
        }
    }

    fn request(
        method: &str,
        uri: &str,
        credential: Credential<'_>,
    ) -> axum::http::request::Builder {
        let request = Request::builder().method(method).uri(uri);
        match credential {
            Credential::None => request,
            Credential::Bearer(token) => request.header("authorization", format!("Bearer {token}")),
            Credential::Authorization(value) => request.header("authorization", value),
            Credential::NodeTokenHeader(token) => request.header("x-ryu-node-token", token),
        }
    }

    async fn send(&self, request: Request<Body>) -> Reply {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        Reply {
            status,
            body: String::from_utf8(bytes.to_vec()).unwrap(),
        }
    }

    async fn get(&self, key: &str, credential: Credential<'_>) -> Reply {
        let request = Self::request("GET", &format!("/api/preferences/{key}"), credential);
        self.send(request.body(Body::empty()).unwrap()).await
    }

    async fn put(&self, key: &str, value: &str, credential: Credential<'_>) -> Reply {
        let request = Self::request("PUT", &format!("/api/preferences/{key}"), credential)
            .header("content-type", "application/json");
        self.send(
            request
                .body(Body::from(json!({ "value": value }).to_string()))
                .unwrap(),
        )
        .await
    }

    async fn diagnostics(&self, credential: Credential<'_>) -> Reply {
        let request = Self::request("GET", "/api/support-access/diagnostics", credential)
            .header("x-ryu-support-actor", "support-engineer-a");
        self.send(request.body(Body::empty()).unwrap()).await
    }

    async fn audit(&self, credential: Credential<'_>) -> Reply {
        let request = Self::request("GET", "/api/support-access/audit", credential);
        self.send(request.body(Body::empty()).unwrap()).await
    }

    /// Open the preference stream and report its status with the number of
    /// live change subscriptions while the response is held; the body is then
    /// dropped, as a disconnecting client's would be.
    async fn open_stream(&self, credential: Credential<'_>) -> (StatusCode, usize) {
        let request = Self::request("GET", "/api/preferences/stream", credential);
        let response = self
            .router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        (
            response.status(),
            self.state.preferences.live_subscriber_count(),
        )
    }

    /// The exact persisted row (stored value and write timestamp), read through
    /// a second SQLite connection outside the store's handle.
    fn raw_record(&self, key: &str) -> Option<(String, i64)> {
        rusqlite::Connection::open(&self.preferences_path)
            .unwrap()
            .query_row(
                "SELECT value, updated_at FROM preferences WHERE key = ?1",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .unwrap()
    }

    fn reopen(&self) -> crate::server::preferences::PreferencesStore {
        crate::server::preferences::PreferencesStore::open(self.preferences_path.clone()).unwrap()
    }

    /// Audit rows as `(actor, action, detail)`, read from a reopened audit file.
    async fn audit_rows(&self) -> Vec<(String, String, Option<String>)> {
        crate::support_access::SupportAccessStore::open(self.audit_path.clone())
            .unwrap()
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|entry| (entry.actor, entry.action, entry.detail))
            .collect()
    }

    /// Every protected route this suite covers refuses `credential` with
    /// `status`, opens no subscription and leaks no stored secret.
    async fn assert_every_route_refuses(&self, credential: Credential<'_>, status: StatusCode) {
        let label = format!("{credential:?}");
        let secret = self.get("unsplash-access-key", credential).await;
        assert_eq!(secret.status, status, "{label}: secret read");
        assert!(!secret.body.contains(SECRET), "{label}: {}", secret.body);
        assert_eq!(
            self.get("theme", credential).await.status,
            status,
            "{label}"
        );
        assert_eq!(
            self.put("theme", "light", credential).await.status,
            status,
            "{label}: theme write"
        );
        let grant = crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY;
        assert_eq!(
            self.put(grant, "true", credential).await.status,
            status,
            "{label}: support grant write"
        );
        let consent = crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY;
        assert_eq!(
            self.put(consent, "true", credential).await.status,
            status,
            "{label}: consent write"
        );
        let subscribers = self.state.preferences.live_subscriber_count();
        assert_eq!(
            self.open_stream(credential).await,
            (status, subscribers),
            "{label}: a refused stream must not subscribe"
        );
        assert_eq!(
            self.diagnostics(credential).await.status,
            status,
            "{label}: diagnostics"
        );
        let audit = self.audit(credential).await;
        assert_eq!(audit.status, status, "{label}: audit read");
        assert!(!audit.body.contains("support-engineer"), "{label}");
    }
}

fn no_event(
    events: &mut tokio::sync::broadcast::Receiver<crate::server::preferences::PreferenceEvent>,
) {
    match events.try_recv() {
        Err(TryRecvError::Empty) => {}
        Ok(event) => panic!(
            "a refused request published a preference change: {} = {}",
            event.key, event.value
        ),
        Err(error) => panic!("preference change stream failed: {error}"),
    }
}

/// Seed through the router with the owner bearer and capture the durable rows
/// a refused request must leave untouched.
async fn seed(harness: &Harness) -> ((String, i64), (String, i64)) {
    let owner = Credential::Bearer(OWNER);
    for (key, value) in [
        ("theme", "dark"),
        ("unsplash-access-key", SECRET),
        (crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY, "false"),
    ] {
        let reply = harness.put(key, value, owner).await;
        assert_eq!(reply.status, StatusCode::OK, "{key}: {}", reply.body);
        assert_eq!(reply.json(), json!({ "ok": true, "key": key }));
    }
    (
        harness.raw_record("theme").unwrap(),
        harness
            .raw_record(crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY)
            .unwrap(),
    )
}

#[tokio::test]
async fn missing_wrong_and_misplaced_node_tokens_never_reach_preference_or_support_handlers() {
    let harness = Harness::new(Some(OWNER));
    let (theme, consent) = seed(&harness).await;
    let mut events = harness.state.preferences.subscribe();
    let lowercase_scheme = format!("bearer {OWNER}");
    let basic = format!("Basic {OWNER}");
    let near_miss = &OWNER[..OWNER.len() - 1];
    for credential in [
        Credential::None,
        Credential::Bearer("not-the-node-token"),
        Credential::Bearer(near_miss),
        Credential::Authorization(&lowercase_scheme),
        Credential::Authorization(&basic),
        // Only the local model-proxy routes accept the node-token header.
        Credential::NodeTokenHeader(OWNER),
    ] {
        harness
            .assert_every_route_refuses(credential, StatusCode::UNAUTHORIZED)
            .await;
    }

    no_event(&mut events);
    assert_eq!(harness.raw_record("theme").unwrap(), theme);
    assert_eq!(
        harness
            .raw_record(crate::privacy::CRASH_REPORTS_ENABLED_PREF_KEY)
            .unwrap(),
        consent
    );
    assert_eq!(
        harness.raw_record(crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY),
        None,
        "an unauthenticated caller must not open the support channel"
    );
    assert!(
        harness.audit_rows().await.is_empty(),
        "refused callers never reach the audited diagnostics handler"
    );
    let reopened = harness.reopen();
    assert_eq!(
        reopened.get("theme").await.unwrap().as_deref(),
        Some("dark")
    );
    assert!(!crate::privacy::crash_reports_enabled(&reopened).await);

    // The owner bearer reaches the same handlers, and its write is durable.
    let owner = Credential::Bearer(OWNER);
    let write = harness.put("theme", "light", owner).await;
    assert_eq!(write.status, StatusCode::OK, "{}", write.body);
    let published = events
        .try_recv()
        .map(|event| (event.key, event.value))
        .unwrap_or_else(|error| panic!("the owner's write must publish: {error}"));
    assert_eq!(published, ("theme".to_owned(), "light".to_owned()));
    no_event(&mut events);
    assert_eq!(
        harness.get("theme", owner).await.json(),
        json!({ "key": "theme", "value": "light" })
    );
    assert_eq!(
        harness.get("unsplash-access-key", owner).await.json(),
        json!({ "key": "unsplash-access-key", "value": ryu_crypto::redact::REDACTED })
    );
    assert_eq!(
        harness.reopen().get("theme").await.unwrap().as_deref(),
        Some("light")
    );
    // Only this test's own change receiver is subscribed around the owner's
    // stream, which subscribes while open and releases on disconnect.
    assert_eq!(harness.state.preferences.live_subscriber_count(), 1);
    assert_eq!(harness.open_stream(owner).await, (StatusCode::OK, 2));
    assert_eq!(
        harness.state.preferences.live_subscriber_count(),
        1,
        "the owner's dropped stream releases its subscription"
    );
}

#[tokio::test]
async fn protected_routes_fail_closed_when_the_node_token_is_unavailable() {
    let harness = Harness::new(None);
    harness
        .state
        .preferences
        .set("theme", "dark")
        .await
        .unwrap();
    let theme = harness.raw_record("theme").unwrap();
    let mut events = harness.state.preferences.subscribe();
    for credential in [
        Credential::None,
        Credential::Bearer(OWNER),
        Credential::Bearer("anything"),
    ] {
        harness
            .assert_every_route_refuses(credential, StatusCode::SERVICE_UNAVAILABLE)
            .await;
    }
    no_event(&mut events);
    assert_eq!(harness.raw_record("theme").unwrap(), theme);
    assert_eq!(
        harness.raw_record(crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY),
        None
    );
    assert!(harness.audit_rows().await.is_empty());
}

#[tokio::test]
async fn owner_requests_reach_the_support_handler_which_gates_and_audits_the_actor() {
    assert!(
        !ryu_mesh::is_enabled(),
        "this case expects the default mesh-off transport gate"
    );
    let harness = Harness::new(Some(OWNER));
    let owner = Credential::Bearer(OWNER);
    let enabled = crate::privacy::SUPPORT_ACCESS_LOCAL_ENABLED_PREF_KEY;
    let expiry = crate::privacy::SUPPORT_ACCESS_LOCAL_EXPIRY_PREF_KEY;

    let off = harness.diagnostics(owner).await;
    assert_eq!(off.status, StatusCode::FORBIDDEN);
    assert_eq!(off.json()["code"], "support_access_off");

    let until = chrono::Utc::now().timestamp_millis() + 10 * 60_000;
    assert_eq!(
        harness.put(expiry, &until.to_string(), owner).await.status,
        StatusCode::OK
    );
    assert_eq!(
        harness.put(enabled, "true", owner).await.status,
        StatusCode::OK
    );
    let mesh_off = harness.diagnostics(owner).await;
    assert_eq!(mesh_off.status, StatusCode::FORBIDDEN);
    assert_eq!(mesh_off.json()["code"], "support_access_mesh_off");

    assert_eq!(
        harness.put(enabled, "false", owner).await.status,
        StatusCode::OK
    );
    assert_eq!(
        harness.diagnostics(owner).await.json()["code"],
        "support_access_off"
    );

    let actor = || "support-engineer-a".to_owned();
    let expected = vec![
        (
            actor(),
            "access_refused".to_owned(),
            Some("grant off or expired".to_owned()),
        ),
        (
            actor(),
            "access_refused".to_owned(),
            Some("mesh disabled".to_owned()),
        ),
        (
            actor(),
            "access_refused".to_owned(),
            Some("grant off or expired".to_owned()),
        ),
    ];
    assert_eq!(harness.audit_rows().await, expected);
    let listed = harness.audit(owner).await.json();
    let listed = listed["entries"].as_array().unwrap();
    assert_eq!(listed.len(), 3);
    assert!(listed
        .iter()
        .all(|entry| entry["actor"] == "support-engineer-a"));
    assert!(
        !crate::privacy::support_access_local(&harness.reopen())
            .await
            .enabled
    );
}

/// The A2A management surface sits on the same protected chain:
/// `create_router` merges `crate::a2a::management_routes()` before these layers,
/// so its settings are neither readable nor writable without the node token.
#[tokio::test]
async fn a2a_management_settings_need_the_node_token() {
    let _serial = crate::a2a::test_support::SERIAL.lock().await;
    let (runtime, _) = crate::a2a::test_support::runtime();
    let before = runtime.store.server_config("default").unwrap();
    let directory = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    let expected = Some(OWNER.to_owned());
    let router = crate::a2a::management_routes()
        .layer(middleware::from_fn(attach_verified_caller))
        .layer(middleware::from_fn_with_state(
            state.connections.clone(),
            track_connection,
        ))
        .layer(middleware::from_fn(move |request, next| {
            let expected = expected.clone();
            async move { require_auth_with_token(request, next, expected).await }
        }))
        .layer(axum::Extension(Some(OWNER.to_owned())))
        .with_state(state);
    let hijack = json!({
        "tenantId": "default",
        "enabled": !before.enabled,
        "displayName": "Hijacked",
        "description": "Not the owner's",
        "publicBaseUrl": null,
        "exposeExtendedCard": true,
        "maxPayloadBytes": 4096,
        "maxConcurrentTasks": 1,
        "requireSignedPeerCards": false,
        "updatedAt": "",
    });
    let send = |credential: Credential<'_>, write: bool| {
        let request = if write {
            Harness::request("PUT", "/api/a2a/settings", credential)
                .header("content-type", "application/json")
                .body(Body::from(hijack.to_string()))
        } else {
            Harness::request("GET", "/api/a2a/settings", credential).body(Body::empty())
        };
        router.clone().oneshot(request.unwrap())
    };

    for credential in [
        Credential::None,
        Credential::Bearer("not-the-node-token"),
        Credential::NodeTokenHeader(OWNER),
    ] {
        for write in [false, true] {
            let response = send(credential, write).await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "{credential:?} write={write}"
            );
        }
    }
    let after = runtime.store.server_config("default").unwrap();
    assert_eq!(after.display_name, before.display_name);
    assert_eq!(after.enabled, before.enabled);
    assert_eq!(after.updated_at, before.updated_at, "nothing was saved");

    let response = send(Credential::Bearer(OWNER), false).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .unwrap();
    let read: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(read["tenantId"], "default");
    assert_eq!(read["displayName"], json!(before.display_name));
}

mod paired_test;
