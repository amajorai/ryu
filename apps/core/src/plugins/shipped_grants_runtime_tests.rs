//! Exact authored packages through the real Core lifecycle and a local Gateway HTTP fixture.
//! This proves persisted approval/revocation gates, not provider or device execution.
use super::{lifecycle, PluginStore};
use crate::plugin_manifest::{PluginManifest, PluginManifestLoader};
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

const TEST: &str =
    "plugins::shipped_grants_runtime_tests::shipped_package_grants_fail_closed_revoke_and_retry";
const PACKAGES: &[(&str, &str)] = &[
    (
        "plugins/functiongemma",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/functiongemma/manifest.json"),
    ),
    (
        "plugins/jina-reader",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/jina-reader/manifest.json"),
    ),
    (
        "plugins/kill-switch",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/kill-switch/manifest.json"),
    ),
    (
        "plugins/needle3",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/needle3/manifest.json"),
    ),
    (
        "external_plugins/cloudflare-browser-run",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/external_plugins/cloudflare-browser-run/manifest.json"
        ),
    ),
    (
        "external_plugins/composio-connect",
        include_str!("../../../../generated/ryu-runtime/plugins-store/external_plugins/composio-connect/manifest.json"),
    ),
    (
        "external_plugins/kernel",
        include_str!("../../../../generated/ryu-runtime/plugins-store/external_plugins/kernel/manifest.json"),
    ),
    (
        "external_plugins/steel",
        include_str!("../../../../generated/ryu-runtime/plugins-store/external_plugins/steel/manifest.json"),
    ),
    (
        "plugins/browser-use",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/browser-use/manifest.json"),
    ),
    (
        "plugins/action-summary",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/action-summary/manifest.json"),
    ),
    (
        "plugins/advisor",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/advisor/manifest.json"),
    ),
    (
        "plugins/agent-comms",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agent-comms/manifest.json"),
    ),
    (
        "plugins/agentation",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agentation/manifest.json"),
    ),
    (
        "plugins/agentbrowser",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/agentbrowser/manifest.json"),
    ),
    (
        "plugins/auto-continue",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/auto-continue/manifest.json"),
    ),
    (
        "plugins/bitwarden",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/bitwarden/manifest.json"),
    ),
    (
        "plugins/brave",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/brave/manifest.json"),
    ),
    (
        "plugins/chat-title",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/chat-title/manifest.json"),
    ),
    (
        "plugins/chatgpt-web",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/chatgpt-web/manifest.json"),
    ),
    (
        "plugins/cloudflare-clef",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/cloudflare-clef/manifest.json"),
    ),
    (
        "plugins/codex-computer-use",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/codex-computer-use/manifest.json"),
    ),
    (
        "plugins/deepseek",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/deepseek/manifest.json"),
    ),
    (
        "plugins/docs",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/docs/manifest.json"),
    ),
    (
        "plugins/double-check",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/double-check/manifest.json"),
    ),
    (
        "plugins/dynamic-workflows",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/dynamic-workflows/manifest.json"),
    ),
    (
        "plugins/effort-escalator",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/effort-escalator/manifest.json"),
    ),
    (
        "plugins/ego-browser",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ego-browser/manifest.json"),
    ),
    (
        "plugins/exa",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/exa/manifest.json"),
    ),
    (
        "plugins/expect",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/expect/manifest.json"),
    ),
    (
        "plugins/firecrawl",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/firecrawl/manifest.json"),
    ),
    (
        "plugins/ghost",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ghost/manifest.json"),
    ),
    (
        "plugins/goal",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/goal/manifest.json"),
    ),
    (
        "plugins/honcho",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/honcho/manifest.json"),
    ),
    (
        "plugins/laya",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/laya/manifest.json"),
    ),
    (
        "plugins/llm-wiki",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/llm-wiki/manifest.json"),
    ),
    (
        "plugins/no-ai-slop",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/no-ai-slop/manifest.json"),
    ),
    (
        "plugins/no-more-mistakes",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/no-more-mistakes/manifest.json"),
    ),
    (
        "plugins/polite-prompts",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/polite-prompts/manifest.json"),
    ),
    (
        "plugins/observer-agents",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/observer-agents/manifest.json"),
    ),
    (
        "plugins/parallel",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/parallel/manifest.json"),
    ),
    (
        "plugins/pi-subagent",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/pi-subagent/manifest.json"),
    ),
    (
        "plugins/plan-continue",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/plan-continue/manifest.json"),
    ),
    (
        "plugins/proof",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/proof/manifest.json"),
    ),
    (
        "plugins/recap",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/recap/manifest.json"),
    ),
    (
        "plugins/reactions",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/reactions/manifest.json"),
    ),
    (
        "plugins/receipts",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/receipts/manifest.json"),
    ),
    (
        "plugins/just-bash",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/just-bash/manifest.json"),
    ),
    (
        "plugins/ripgrep",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/ripgrep/manifest.json"),
    ),
    (
        "plugins/rtk",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/rtk/manifest.json"),
    ),
    (
        "plugins/rules",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/rules/manifest.json"),
    ),
    (
        "plugins/sample",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/sample/manifest.json"),
    ),
    (
        "plugins/sample-widget",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/sample-widget/manifest.json"),
    ),
    (
        "plugins/scrapling",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/scrapling/manifest.json"),
    ),
    (
        "plugins/security-guidance",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/security-guidance/manifest.json"),
    ),
    (
        "plugins/security-scanner",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/security-scanner/manifest.json"),
    ),
    (
        "plugins/serper",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/serper/manifest.json"),
    ),
    (
        "plugins/spider",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/spider/manifest.json"),
    ),
    (
        "plugins/spidercloud",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/spidercloud/manifest.json"),
    ),
    (
        "plugins/tavily",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/tavily/manifest.json"),
    ),
    (
        "plugins/tokenmaxxing",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/tokenmaxxing/manifest.json"),
    ),
    (
        "plugins/toolsmith-example",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/toolsmith-example/manifest.json"),
    ),
    (
        "plugins/usage-pacer",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/usage-pacer/manifest.json"),
    ),
    (
        "plugins/zvec-grep",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/zvec-grep/manifest.json"),
    ),
];

#[derive(Clone)]
struct Gateway {
    mode: Arc<Mutex<&'static str>>,
    target: Arc<Mutex<String>>,
    requests: Arc<Mutex<Vec<Value>>>,
}
fn package_body(root: &std::path::Path, relative: &str) -> Result<String, String> {
    let path = std::path::Path::new(relative);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(format!("invalid package body path: {relative}"));
    }
    let resolved = root
        .join(path)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !resolved.starts_with(root) {
        return Err(format!("package body escapes its package root: {relative}"));
    }
    std::fs::read_to_string(resolved).map_err(|error| error.to_string())
}

fn open_store(path: &std::path::Path) -> PluginStore {
    let conn = rusqlite::Connection::open(path).unwrap();
    PluginStore::migrate(&conn).unwrap();
    PluginStore::record_verified_official_packages(&conn).unwrap();
    PluginStore {
        conn: Arc::new(tokio::sync::Mutex::new(conn)),
    }
}

async fn validate(
    State(gateway): State<Gateway>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    gateway.requests.lock().unwrap().push(body.clone());
    let grants = body["grants"].as_array().unwrap().clone();
    let target = body["app_id"].as_str().unwrap() == *gateway.target.lock().unwrap();
    let mode = *gateway.mode.lock().unwrap();
    if !target || mode == "allow" {
        return (
            StatusCode::OK,
            Json(json!({"approved":grants,"denied":[],"all_approved":true})),
        );
    }
    match mode {
        "deny" => (
            StatusCode::OK,
            Json(json!({"approved":[],"denied":grants,"all_approved":false})),
        ),
        "unavailable" => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"local fixture unavailable"})),
        ),
        "malformed" => (StatusCode::OK, Json(json!({"approved":grants,"denied":[]}))),
        "forged" => (
            StatusCode::OK,
            Json(json!({"approved":["undeclared:fixture"],"denied":[],"all_approved":true})),
        ),
        _ => panic!("unknown fixture mode"),
    }
}

#[tokio::test]
async fn shipped_package_grants_fail_closed_revoke_and_retry() {
    if std::env::var_os("RYU_SHIPPED_GRANTS_CHILD").is_none() {
        let dir = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", TEST, "--nocapture"])
            .env("RYU_SHIPPED_GRANTS_CHILD", "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RUST_MIN_STACK", "16777216")
            .env_remove("RYU_STUB_GRANT_VALIDATION")
            .status()
            .unwrap();
        assert!(status.success(), "isolated grant lifecycle matrix failed");
        return;
    }
    assert!(std::env::var_os("RYU_STUB_GRANT_VALIDATION").is_none());
    let gateway = Gateway {
        mode: Arc::new(Mutex::new("allow")),
        target: Arc::new(Mutex::new(String::new())),
        requests: Arc::new(Mutex::new(Vec::new())),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/v1/grants/validate", post(validate))
        .with_state(gateway.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    // Real user binding configuration selects the shipped providers for required
    // capability dependencies; unrelated installed alternatives stay disabled.
    super::binding::set_active_config(super::binding::BindingConfig {
        overrides: std::collections::BTreeMap::from([
            ("rag".into(), "@ryu/rag".into()),
            ("engines".into(), "@ryu/engines".into()),
            ("browser.session".into(), "@ryu/browser".into()),
        ]),
    });
    let loaded = PluginManifestLoader::load();
    let mut covered = 0;
    let mut incoming_seen = std::collections::HashSet::new();
    for (package, authored) in PACKAGES {
        let package_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../generated/ryu-runtime/plugins-store")
            .join(package)
            .canonicalize()
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(package_root.join("manifest.json")).unwrap(),
            *authored,
            "{package}: compiled fixture must match its authored package manifest"
        );
        assert!(package_body(&package_root, "../manifest.json").is_err());
        assert!(package_body(&package_root, "/manifest.json").is_err());
        let manifest = PluginManifest::parse_and_validate_with_code(authored, |relative| {
            package_body(&package_root, relative)
        })
        .unwrap();
        assert!(!manifest.permission_grants.is_empty(), "{package}");
        let incoming_grants: Option<&[&str]> = match manifest.id.as_str() {
            "@ryu/functiongemma" | "@ryu/needle3" => Some(&["tool:http-egress:127.0.0.1"]),
            "@ryu/jina-reader" => Some(&["tool:http-egress:r.jina.ai", "tool:execute"]),
            "@ryu/kill-switch" => Some(&["execution:control"]),
            _ => None,
        };
        if let Some(grants) = incoming_grants {
            assert_eq!(
                manifest
                    .permission_grants
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>(),
                grants,
                "{package}: exact incoming declarations must be exercised"
            );
        }
        let mut all = loaded.clone();
        all.retain(|entry| entry.id != manifest.id);
        all.push(manifest.clone());
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("plugins.db");
        let store = open_store(&path);
        for entry in &all {
            lifecycle::install_app(&store, entry).await.unwrap();
        }
        *gateway.target.lock().unwrap() = manifest.id.clone();
        for mode in ["deny", "unavailable", "malformed", "forged"] {
            *gateway.mode.lock().unwrap() = mode;
            gateway.requests.lock().unwrap().clear();
            let result = lifecycle::enable_app(&store, &manifest, &all, &url, None, &client).await;
            assert!(result.is_err(), "{package}: {mode} must refuse");
            for record in store.list_all_records().await.unwrap() {
                assert!(
                    !record.enabled && record.approved_grants.is_empty(),
                    "{package}: {mode} changed {}",
                    record.id
                );
            }
            let requests = gateway.requests.lock().unwrap();
            let target_request = requests
                .iter()
                .find(|request| request["app_id"] == manifest.id)
                .unwrap_or_else(|| {
                    panic!("{package}: refusal happened before target grant gate: {result:?}")
                });
            assert_eq!(target_request["grants"], json!(manifest.permission_grants));
        }
        *gateway.mode.lock().unwrap() = "allow";
        let outcome = lifecycle::enable_app(&store, &manifest, &all, &url, None, &client)
            .await
            .unwrap();
        assert!(outcome.target.enabled);
        assert_eq!(outcome.target.approved_grants, manifest.permission_grants);
        let reopened = open_store(&path);
        let approved = reopened.get_record(&manifest.id).await.unwrap().unwrap();
        assert!(approved.enabled);
        assert_eq!(
            approved.approved_grants, manifest.permission_grants,
            "{package}: approval must survive a new store handle"
        );
        lifecycle::set_app_grants(&store, &manifest, &[], &url, None, &client)
            .await
            .unwrap();
        let reopened = open_store(&path);
        let revoked = reopened.get_record(&manifest.id).await.unwrap().unwrap();
        assert!(revoked.enabled && revoked.approved_grants.is_empty());
        *gateway.mode.lock().unwrap() = "deny";
        assert!(lifecycle::set_app_grants(
            &store,
            &manifest,
            &manifest.permission_grants,
            &url,
            None,
            &client
        )
        .await
        .is_err());
        assert!(store
            .get_record(&manifest.id)
            .await
            .unwrap()
            .unwrap()
            .approved_grants
            .is_empty());
        *gateway.mode.lock().unwrap() = "allow";
        let restored = lifecycle::set_app_grants(
            &store,
            &manifest,
            &manifest.permission_grants,
            &url,
            None,
            &client,
        )
        .await
        .unwrap();
        assert_eq!(restored.approved_grants, manifest.permission_grants);
        let reopened = open_store(&path);
        assert_eq!(
            reopened
                .get_record(&manifest.id)
                .await
                .unwrap()
                .unwrap()
                .approved_grants,
            manifest.permission_grants,
            "{package}: restored approval must be persisted"
        );
        let before = gateway.requests.lock().unwrap().len();
        assert!(lifecycle::set_app_grants(
            &store,
            &manifest,
            &["undeclared:fixture".into()],
            &url,
            None,
            &client
        )
        .await
        .is_err());
        assert_eq!(
            gateway.requests.lock().unwrap().len(),
            before,
            "undeclared grant must be rejected before Gateway dispatch"
        );
        lifecycle::disable_app(&store, &manifest.id, &all, false, true)
            .await
            .unwrap();
        let reopened = open_store(&path);
        let disabled = reopened.get_record(&manifest.id).await.unwrap().unwrap();
        assert!(!disabled.enabled && disabled.approved_grants.is_empty());
        assert!(lifecycle::set_app_grants(
            &store,
            &manifest,
            &manifest.permission_grants,
            &url,
            None,
            &client
        )
        .await
        .is_err());
        *gateway.mode.lock().unwrap() = "allow";
        let retried = lifecycle::enable_app(&store, &manifest, &all, &url, None, &client)
            .await
            .unwrap();
        assert!(retried.target.enabled);
        let reopened = open_store(&path);
        let retried_record = reopened.get_record(&manifest.id).await.unwrap().unwrap();
        assert!(retried_record.enabled);
        assert_eq!(retried_record.approved_grants, manifest.permission_grants);
        if incoming_grants.is_some() {
            assert!(incoming_seen.insert(manifest.id.clone()));
            println!("incoming grants {package}: exact declarations refused/approved/persisted/revoked/restored/retried; no tool, model, process or provider execution");
        }
        covered += manifest.permission_grants.len();
        println!(
            "verified grants {package}: {}",
            manifest.permission_grants.len()
        );
    }
    assert_eq!(PACKAGES.len(), 63);
    assert_eq!(covered, 122);
    assert_eq!(
        incoming_seen,
        [
            "@ryu/functiongemma",
            "@ryu/jina-reader",
            "@ryu/kill-switch",
            "@ryu/needle3"
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    );
    task.abort();
}
