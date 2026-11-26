//! A preference key that names a credential is never loaded as a selection.
//!
//! `host.sideModel` takes `model_pref_key` from the calling app. Before the
//! refusal in [`AgentSelection::load`], a stored credential was decrypted, used
//! as the model name, sent to the Gateway, and returned to the app in the
//! Gateway error text.
//!
//! Every value here is made up for the tests, and the Gateway is a loopback
//! fixture. The bridge is the production `PluginHookBridge`.

use super::*;
use crate::server::preferences::is_secret_preference_key;
use crate::tool_exec::{InvokeOutcome, SandboxBridge};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Arc, Mutex};

/// Made up for these tests. Not a real credential.
const STORED: &str = "sk-or-v1-CE42x9Qz7Lw3Tn8Vb5Kd2Hs6Jf4Gm1Pr0Yc";
/// The model the node default lane names in these tests.
const NODE_DEFAULT: &str = "ce42-node-default-model";
/// A prompt the fixture Gateway answers.
const ANSWER_PROMPT: &str = "ce42 fixture, answer this call";
/// A prompt the fixture Gateway refuses with HTTP 400.
const REFUSE_PROMPT: &str = "ce42 fixture, refuse this call";

/// The credential keys of `server/preferences.rs` when this was written.
const CREDENTIAL_KEYS: [&str; 15] = [
    "aa-api-key",
    "acp-agent-settings",
    "composio-api-key",
    "fal-api-key",
    "gif-api-key",
    "github-api-token",
    "hf-token",
    "learning.prm-key",
    "managed-gateway-token",
    "openrouter-api-key",
    "replicate-api-key",
    "smithery-api-key",
    "smtp-password",
    "unsplash-access-key",
    "node-onboarding-state",
];

/// True when `text` holds any six-character run of the stored value.
fn holds_part_of_stored(text: &str) -> bool {
    STORED
        .as_bytes()
        .windows(6)
        .any(|part| text.contains(std::str::from_utf8(part).expect("ascii value")))
}

fn open_store(dir: &tempfile::TempDir) -> PreferencesStore {
    PreferencesStore::open(dir.path().join("preferences.db")).expect("isolated preferences store")
}

/// The made-up credential under `openrouter-api-key`, and a node default.
async fn store_credential_and_node_default(prefs: &PreferencesStore) {
    prefs
        .set("openrouter-api-key", STORED)
        .await
        .expect("store the made-up credential");
    prefs
        .set(
            LOCAL_SELECTION_PREF,
            &json!({ "model": NODE_DEFAULT }).to_string(),
        )
        .await
        .expect("store the node default");
}

#[tokio::test]
async fn side_model_for_a_credential_key_returns_no_part_of_the_stored_value() {
    let dir = tempfile::tempdir().expect("temp dir");
    let prefs = open_store(&dir);
    store_credential_and_node_default(&prefs).await;

    let resolved = resolve_side_model(&prefs, "openrouter-api-key", None).await;
    let shown = format!("{resolved:?}");
    println!("CE42 resolve_side_model(openrouter-api-key) = {shown}");

    assert!(
        !holds_part_of_stored(&shown),
        "the stored credential became the side model"
    );
    assert_eq!(
        resolved.map(|target| target.model).as_deref(),
        Some(NODE_DEFAULT),
        "the call runs on the node default"
    );
}

#[tokio::test]
async fn load_reads_no_credential_key() {
    let dir = tempfile::tempdir().expect("temp dir");
    let prefs = open_store(&dir);
    let mut loaded = Vec::new();
    for key in CREDENTIAL_KEYS {
        assert!(
            is_secret_preference_key(key),
            "{key} is no longer a credential key"
        );
        prefs
            .set(key, STORED)
            .await
            .expect("store the made-up credential");
        if !AgentSelection::load(&prefs, key).await.is_empty() {
            loaded.push(key);
        }
    }
    println!("CE42 credential keys loaded as a selection: {loaded:?}");

    assert!(
        loaded.is_empty(),
        "credential keys loaded as a selection: {loaded:?}"
    );
}

#[tokio::test]
async fn agent_for_a_credential_key_returns_no_part_of_the_stored_value() {
    let dir = tempfile::tempdir().expect("temp dir");
    let prefs = open_store(&dir);
    // A credential value shaped like a selection: its `agent_id` was returned.
    prefs
        .set(
            "acp-agent-settings",
            &json!({ "agent_id": STORED }).to_string(),
        )
        .await
        .expect("store the made-up credential");

    let agent = resolve_agent(&prefs, "acp-agent-settings").await;
    let shown = format!("{agent:?}");
    println!("CE42 resolve_agent(acp-agent-settings) = {shown}");

    assert!(
        !holds_part_of_stored(&shown),
        "the stored credential became the agent id"
    );
}

/// Collects the formatted log lines of the current thread.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("capture lock")
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn the_refusal_writes_one_warn_line_with_the_key_name_only() {
    let dir = tempfile::tempdir().expect("temp dir");
    let prefs = open_store(&dir);
    store_credential_and_node_default(&prefs).await;
    let captured = Captured::default();
    let sink = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(move || sink.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);
    // The capture is thread-local. A callsite first hit by another thread is
    // cached as disabled, so rebuild the cache before the checked call.
    tracing::callsite::rebuild_interest_cache();

    let _ = resolve_side_model(&prefs, "openrouter-api-key", None).await;

    let bytes = captured.0.lock().expect("capture lock").clone();
    let log = String::from_utf8_lossy(&bytes).into_owned();
    let warn_lines: Vec<&str> = log.lines().filter(|line| line.contains(" WARN ")).collect();
    println!(
        "CE42 warn lines for openrouter-api-key: {}",
        warn_lines.len()
    );

    assert_eq!(warn_lines.len(), 1, "one warn line for the refused key");
    assert!(
        warn_lines[0].contains("openrouter-api-key"),
        "the warn line names the key"
    );
    assert!(
        !holds_part_of_stored(&log),
        "a log line holds part of the stored credential"
    );
}

#[tokio::test]
async fn model_keys_of_shipped_apps_still_resolve() {
    let dir = tempfile::tempdir().expect("temp dir");
    let prefs = open_store(&dir);
    store_credential_and_node_default(&prefs).await;
    let cases = [
        (
            "advisor-model",
            "ce42-advisor".to_owned(),
            "ce42-advisor",
            "",
        ),
        (
            "tuition-grading-model",
            json!({ "model": "ce42-grader", "effort": "high" }).to_string(),
            "ce42-grader",
            "high",
        ),
        (
            "auto-title-model",
            json!({ "model": "ce42-titler", "thinking_level": "low" }).to_string(),
            "ce42-titler",
            "low",
        ),
    ];
    for (key, stored, model, effort) in cases {
        assert!(!is_secret_preference_key(key), "{key}");
        prefs
            .set(key, &stored)
            .await
            .expect("store the model choice");
        let resolved = resolve_side_model(&prefs, key, None)
            .await
            .expect("the key resolves");
        assert_eq!(
            (resolved.model.as_str(), resolved.effort.as_str()),
            (model, effort),
            "{key}"
        );
    }
    // A model key nobody has set still falls back to the node default.
    let unset = resolve_side_model(&prefs, "news-brief-model", None)
        .await
        .expect("an unset key falls back");
    assert_eq!(unset.model, NODE_DEFAULT);
}

#[tokio::test]
async fn the_node_default_lanes_are_not_credential_keys_and_still_load() {
    for key in [
        GLOBAL_SELECTION_PREF,
        LOCAL_SELECTION_PREF,
        CLOUD_SELECTION_PREF,
    ] {
        assert!(!is_secret_preference_key(key), "{key}");
    }
    let dir = tempfile::tempdir().expect("temp dir");
    let prefs = open_store(&dir);
    prefs
        .set(GLOBAL_SELECTION_PREF, "ce42-legacy-default")
        .await
        .expect("store the legacy default");
    prefs
        .set(
            CLOUD_SELECTION_PREF,
            &json!({ "model": "ce42-cloud" }).to_string(),
        )
        .await
        .expect("store the cloud lane");

    assert_eq!(load_local(&prefs).await.model, "ce42-legacy-default");
    assert_eq!(load_cloud(&prefs).await.model, "ce42-cloud");
}

/// Model names the fixture Gateway received, in order.
#[derive(Clone, Default)]
struct SeenModels(Arc<Mutex<Vec<String>>>);

/// `POST /v1/chat/completions` of the fixture. Like a real Gateway it names
/// the requested model in its answer and in its refusal.
async fn fixture_completions(
    axum::extract::State(seen): axum::extract::State<SeenModels>,
    axum::Json(body): axum::Json<Value>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let model = body["model"].as_str().unwrap_or_default().to_owned();
    seen.0.lock().expect("fixture lock").push(model.clone());
    let refuse = body["messages"][1]["content"]
        .as_str()
        .is_some_and(|prompt| prompt.contains(REFUSE_PROMPT));
    if refuse {
        // Built apart from the status, so the i18n extractor does not take
        // this fixture text for a sentence Core shows to a person.
        let refusal = format!("fixture gateway has no provider for model {model}");
        return (axum::http::StatusCode::BAD_REQUEST, refusal).into_response();
    }
    axum::Json(json!({
        "choices": [{ "message": { "content": format!("fixture answer from {model}") } }]
    }))
    .into_response()
}

/// Sets `RYU_GATEWAY_URL` and puts the former value back on drop.
struct GatewayUrl(Option<std::ffi::OsString>);

impl GatewayUrl {
    fn set(url: &str) -> Self {
        let previous = std::env::var_os("RYU_GATEWAY_URL");
        std::env::set_var("RYU_GATEWAY_URL", url);
        Self(previous)
    }
}

impl Drop for GatewayUrl {
    fn drop(&mut self) {
        match self.0.take() {
            Some(previous) => std::env::set_var("RYU_GATEWAY_URL", previous),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }
    }
}

/// A loopback stand-in for the Gateway, with Core pointed at it. The fields
/// drop in order: the address and the readiness flag are put back before the
/// lock that serializes every test touching them is released.
struct FixtureGateway {
    seen: SeenModels,
    _url: GatewayUrl,
    _ready: crate::sidecar::gateway::GatewayQuarantineTestGuard,
    _env: std::sync::MutexGuard<'static, ()>,
}

impl FixtureGateway {
    async fn start() -> Self {
        let env = crate::sidecar::gateway::lock_gateway_env();
        let seen = SeenModels::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind the fixture gateway");
        let port = listener.local_addr().expect("fixture address").port();
        let app = axum::Router::new()
            .route(
                "/v1/chat/completions",
                axum::routing::post(fixture_completions),
            )
            .with_state(seen.clone());
        let _server = tokio::spawn(async move { axum::serve(listener, app).await });
        let url = GatewayUrl::set(&format!("http://127.0.0.1:{port}"));
        let ready = crate::sidecar::gateway::quarantine_for_test(false);
        Self {
            seen,
            _url: url,
            _ready: ready,
            _env: env,
        }
    }

    fn seen(&self) -> Vec<String> {
        self.seen.0.lock().expect("fixture lock").clone()
    }
}

/// A bridge for an app that holds only the side-model grant.
fn side_model_bridge(state: &crate::server::ServerState) -> crate::plugin_host::PluginHookBridge {
    crate::plugin_host::PluginHookBridge::new(
        "@ce42/fixture-app".to_owned(),
        HashSet::from(["hook:side-model".to_owned()]),
        state.clone(),
    )
}

/// One `host.sideModel` call through the bridge: whether it failed, and all
/// the text the app gets back (the value and the error).
async fn side_model(bridge: &crate::plugin_host::PluginHookBridge, args: Value) -> (bool, String) {
    match bridge.handle("host.sideModel".to_owned(), args).await {
        InvokeOutcome::Result(result) => (
            result.is_error,
            format!("{} {}", result.value, result.error.unwrap_or_default()),
        ),
        other => panic!("unexpected side-model outcome: {other:?}"),
    }
}

#[tokio::test]
async fn bridge_side_model_with_a_credential_key_shows_no_part_of_the_stored_value() {
    let gateway = FixtureGateway::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    let state = crate::server::isolated_plugin_hook_test_state(dir.path());
    store_credential_and_node_default(&state.preferences).await;
    let bridge = side_model_bridge(&state);

    let (answer_failed, answer) = side_model(
        &bridge,
        json!({ "prompt": ANSWER_PROMPT, "model_pref_key": "openrouter-api-key" }),
    )
    .await;
    let (refusal_failed, refusal) = side_model(
        &bridge,
        json!({ "prompt": REFUSE_PROMPT, "model_pref_key": "openrouter-api-key" }),
    )
    .await;
    let seen = gateway.seen();
    println!("CE42 bridge success text: {answer}");
    println!("CE42 bridge error text: {refusal}");
    println!("CE42 models the fixture gateway received: {seen:?}");

    assert!(!answer_failed, "the fixture answers the first call");
    assert!(refusal_failed, "the fixture refuses the second call");
    assert!(
        !holds_part_of_stored(&answer),
        "the success text holds part of the stored credential"
    );
    assert!(
        !holds_part_of_stored(&refusal),
        "the error text holds part of the stored credential"
    );
    assert_eq!(
        seen,
        [NODE_DEFAULT, NODE_DEFAULT],
        "both calls run on the node default"
    );
}

#[tokio::test]
async fn bridge_side_model_still_resolves_an_apps_own_model_key() {
    let gateway = FixtureGateway::start().await;
    let dir = tempfile::tempdir().expect("temp dir");
    let state = crate::server::isolated_plugin_hook_test_state(dir.path());
    state
        .preferences
        .set("advisor-model", "ce42-advisor")
        .await
        .expect("store the advisor model");
    let bridge = side_model_bridge(&state);

    let (failed, answer) = side_model(
        &bridge,
        json!({ "prompt": ANSWER_PROMPT, "model_pref_key": "advisor-model" }),
    )
    .await;

    assert!(!failed, "the fixture answers: {answer}");
    assert_eq!(gateway.seen(), ["ce42-advisor"]);
    assert!(
        answer.contains("fixture answer from ce42-advisor"),
        "{answer}"
    );
}
