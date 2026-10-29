//! Hydrated marketplace web providers through canonical registry dispatch.
//! Origins are redirected to loopback and plaintext credential refusal is checked
//! before secrets are removed. Existing native HTTP suites separately prove secret
//! projection; this matrix never forwards provider secrets to a plaintext fixture.
use super::*;
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};
use std::sync::Arc;

const CHILD: &str = "RYU_WEB_CAPABILITIES_REGISTRY_CHILD";
const TEST_NAME: &str = "sidecar::mcp::tests::web_capabilities_runtime::hydrated_web_providers_dispatch_canonical_requests_and_failures";
const TOKEN: &str = "web-runtime-synthetic-token";
const PAGE: &str = "https://fixture.invalid/page";
const PACKAGES: &[(&str, &str)] = &[
    (
        "brave",
        include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/brave/manifest.json"),
    ),
    (
        "exa",
        include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/exa/manifest.json"),
    ),
    (
        "tavily",
        include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/tavily/manifest.json"),
    ),
    (
        "firecrawl",
        include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/firecrawl/manifest.json"),
    ),
    (
        "serper",
        include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/serper/manifest.json"),
    ),
    (
        "parallel",
        include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/parallel/manifest.json"),
    ),
    (
        "deepseek",
        include_str!("../../../../../../generated/ryu-runtime/plugins-store/plugins/deepseek/manifest.json"),
    ),
];

#[derive(Default)]
struct WebFixture {
    requests: Vec<Value>,
    unavailable: bool,
}
type Shared = Arc<tokio::sync::Mutex<WebFixture>>;

#[tokio::test]
async fn hydrated_web_providers_dispatch_canonical_requests_and_failures() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let mut process = std::process::Command::new(std::env::current_exe().unwrap());
        process
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(CHILD, "1")
            .env("RUST_MIN_STACK", "16777216")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_PLUGIN_ENV_ALLOWLIST")
            .env_remove("RYU_GATEWAY_REMOTE");
        for provider in [
            "BRAVE",
            "EXA",
            "TAVILY",
            "FIRECRAWL",
            "SERPER",
            "PARALLEL",
            "DEEPSEEK",
        ] {
            process.env(format!("RYU_{provider}_API_KEY"), TOKEN);
        }
        for proxy in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            process.env_remove(proxy);
        }
        assert!(
            process.status().unwrap().success(),
            "isolated canonical web matrix failed"
        );
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let state: Shared = Arc::new(tokio::sync::Mutex::new(WebFixture::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .fallback(web_fixture)
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    let mut hydrated = Vec::new();
    for (package, raw) in PACKAGES {
        let mut manifest = PluginManifest::parse_and_validate_with_code(raw, |path| {
            // Read only the package's actual author fragments. No replacement JS.
            std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../generated/ryu-runtime/plugins-store/plugins")
                    .join(package)
                    .join(path),
            )
            .map_err(|error| error.to_string())
        })
        .unwrap();
        for runnable in &mut manifest.runnables {
            let Some(config) = runnable.config.as_mut() else {
                continue;
            };
            if config["backend"] != "http" {
                continue;
            }
            let remote = config["url"].as_str().unwrap().to_owned();
            let url = reqwest::Url::parse(&remote).unwrap();
            assert_eq!(url.scheme(), "https");
            if let Some(headers) = config.get("secret_headers").and_then(Value::as_object) {
                for template in headers.values() {
                    assert!(template
                        .as_str()
                        .unwrap()
                        .contains(&format!("env:RYU_{}_API_KEY", package.to_uppercase())));
                }
            }
            let slug = config["slug"].as_str().unwrap().to_owned();
            config["url"] = Value::String(format!(
                "http://{address}/{package}/{slug}{}",
                url.path().replace("%7B", "{").replace("%7D", "}")
            ));
        }
        manifest
            .permission_grants
            .retain(|grant| !grant.starts_with("tool:http-egress:"));
        manifest
            .permission_grants
            .push("tool:http-egress:127.0.0.1".into());
        store.insert(&manifest.id, &manifest.version).await.unwrap();
        store
            .set_enabled(&manifest.id, &manifest.permission_grants)
            .await
            .unwrap();
        hydrated.push(manifest);
    }
    let manifests = Arc::new(TokioRwLock::new(hydrated));
    let registry = Arc::new(McpRegistry::empty().with_self_build(manifests.clone(), store.clone()));
    for manifest in manifests.read().await.iter() {
        for runnable in &manifest.runnables {
            if let Some(slug) = runnable
                .config
                .as_ref()
                .and_then(|config| config["slug"].as_str())
            {
                registry.register_app_tool(slug.into(), slug.into(), None);
            }
        }
    }
    set_global_registry(registry.clone());
    // Localization changes compiled bytes. Shared provider credentials must not
    // inherit the original manifest's authority in the installed fixture copy.
    assert!(std::env::var_os("RYU_PLUGIN_ENV_ALLOWLIST").is_none());
    for (package, verb, _, arguments, expected_request) in cases()
        .into_iter()
        .filter(|(_, verb, _, _, _)| *verb == "web.search")
        .take(7)
    {
        crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
            overrides: [(verb.to_owned(), format!("@ryu/{package}"))]
                .into_iter()
                .collect(),
        });
        let before = state.lock().await.requests.len();
        let result = registry
            .call_tool(verb, arguments, Some(&[verb.into()]))
            .await
            .unwrap();
        assert_eq!(result["provider"], format!("@ryu/{package}"));
        assert!(!result.to_string().contains(TOKEN));
        let fixture = state.lock().await;
        assert_eq!(fixture.requests.len(), before + 1);
        let request = &fixture.requests[before];
        for field in ["path", "method", "body", "query"] {
            assert_eq!(request[field], expected_request[field], "{package} {field}");
        }
        assert_eq!(request["authorization"], Value::Null);
        assert_eq!(request["provider_key"], Value::Null);
    }
    assert_eq!(state.lock().await.requests.len(), 7);
    // Explicitly approve only this child's synthetic provider variables through
    // the supported operator policy. Approval does not override HTTPS refusal.
    let allowlist = [
        "BRAVE",
        "EXA",
        "TAVILY",
        "FIRECRAWL",
        "SERPER",
        "PARALLEL",
        "DEEPSEEK",
    ]
    .map(|provider| format!("RYU_{provider}_API_KEY"))
    .join(",");
    std::env::set_var("RYU_PLUGIN_ENV_ALLOWLIST", &allowlist);
    let before_https_refusal = state.lock().await.requests.len();
    // Real registry rejects every explicitly approved credential over plaintext.
    for (package, verb, _, arguments, _) in cases()
        .into_iter()
        .filter(|(_, verb, _, _, _)| *verb == "web.search")
        .take(7)
    {
        crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
            overrides: [(verb.to_owned(), format!("@ryu/{package}"))]
                .into_iter()
                .collect(),
        });
        let error = registry
            .call_tool(verb, arguments, Some(&[verb.into()]))
            .await
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("secret headers require an HTTPS destination"),
            "{package}: {error}"
        );
    }
    assert_eq!(state.lock().await.requests.len(), before_https_refusal);
    assert_eq!(
        std::env::var("RYU_PLUGIN_ENV_ALLOWLIST").unwrap(),
        allowlist
    );
    std::env::remove_var("RYU_PLUGIN_ENV_ALLOWLIST");
    // Retain authored secret_headers. Revocation must take effect through the
    // actual dispatch provenance filter, never manual header removal in tests.
    // Switch among the actual declared canonical providers; no fabricated verbs.
    for (package, verb, _slug, arguments, expected_request) in cases() {
        let id = format!("@ryu/{package}");
        crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig {
            overrides: [(verb.to_owned(), id.clone())].into_iter().collect(),
        });
        assert!(registry
            .capability_verbs()
            .await
            .iter()
            .any(|resolved| resolved.verb.id == verb && resolved.provider_id == id));
        let before = state.lock().await.requests.len();
        let denied = registry
            .call_tool(verb, arguments.clone(), Some(&["web.unlisted".into()]))
            .await
            .unwrap_err();
        assert!(denied.to_string().contains("not in this agent's allowlist"));
        assert_eq!(state.lock().await.requests.len(), before);
        let result = registry
            .call_tool(verb, arguments.clone(), Some(&[verb.into()]))
            .await
            .unwrap();
        assert_eq!(result["provider"], id);
        // Pathless single-record extract providers return no URL to map.
        if !matches!(package, "serper" | "deepseek") || verb != "web.extract" {
            assert_eq!(
                result["results"][0]["url"], PAGE,
                "{package} {verb}: {result}"
            );
        }
        assert_eq!(result["results"].as_array().unwrap().len(), 1);
        if verb == "web.search" {
            assert_eq!(result["results"][0]["title"], "Fixture page");
            assert_eq!(result["results"][0]["snippet"], "Fixture text");
        } else {
            assert_eq!(result["results"][0]["content"], "Fixture text");
        }
        assert_eq!(result["results"][0]["raw"], raw_item(package, verb));
        if verb == "web.crawl" {
            assert_eq!(result["status"], "completed");
            assert_eq!(result["complete"], true);
        }
        let requests = state.lock().await.requests.clone();
        let request = &requests[before];
        assert_eq!(request["path"], expected_request["path"]);
        assert_eq!(request["method"], expected_request["method"]);
        assert_eq!(request["body"], expected_request["body"]);
        assert_eq!(request["query"], expected_request["query"]);
        assert_eq!(request["authorization"], Value::Null);
        assert_eq!(request["provider_key"], Value::Null);
        let count = if verb == "web.crawl" { 2 } else { 1 };
        assert_eq!(requests.len(), before + count);
        if count == 2 {
            assert_eq!(
                requests[before + 1]["path"],
                "/firecrawl/firecrawl.crawl_status/v2/crawl/fixture-job"
            );
            assert_eq!(requests[before + 1]["method"], "GET");
            assert_eq!(requests[before + 1]["query"], Value::Null);
        }
        // A 503 is preserved as a failure envelope and never calls a free fallback.
        state.lock().await.unavailable = true;
        let failed = registry
            .call_tool(verb, arguments.clone(), None)
            .await
            .unwrap();
        assert_eq!(failed["provider"], id);
        // Every provider, including Serper scrape's pathless field mapper, surfaces
        // the failure envelope under `raw` rather than as a content-less result.
        assert!(
            failed.get("results").is_none(),
            "{package} {verb}: {failed}"
        );
        let raw = &failed["raw"];
        assert_eq!(raw["status"], 503, "{package} {verb}: {failed}");
        assert_eq!(
            raw["body"],
            serde_json::json!({"error":"fixture unavailable"})
        );
        assert_eq!(state.lock().await.requests.len(), before + count + 1);
        state.lock().await.unavailable = false;
        let retried = registry
            .call_tool(verb, arguments.clone(), None)
            .await
            .unwrap();
        assert_eq!(retried, result);
        // Remove both sources of authority so changing manifest provenance cannot
        // accidentally leave a Community-tier approval grant authorizing egress.
        let index = manifests
            .read()
            .await
            .iter()
            .position(|manifest| manifest.id == id)
            .unwrap();
        let grants = manifests.read().await[index].permission_grants.clone();
        manifests.write().await[index]
            .permission_grants
            .retain(|grant| grant != "tool:http-egress:127.0.0.1");
        let remaining: Vec<_> = grants
            .iter()
            .filter(|grant| grant.as_str() != "tool:http-egress:127.0.0.1")
            .cloned()
            .collect();
        store.set_enabled(&id, &remaining).await.unwrap();
        let before_denial = state.lock().await.requests.len();
        let grant_error = registry.call_tool(verb, arguments, None).await.unwrap_err();
        assert!(
            grant_error.to_string().contains("not granted"),
            "{package} {verb}: {grant_error}"
        );
        assert_eq!(state.lock().await.requests.len(), before_denial);
        manifests.write().await[index].permission_grants = grants.clone();
        store.set_enabled(&id, &grants).await.unwrap();
    }
    server.abort();
}

fn cases() -> Vec<(&'static str, &'static str, &'static str, Value, Value)> {
    let mut cases = Vec::new();
    for (package, path, body, query) in [
        (
            "brave",
            "/brave/brave.search/res/v1/web/search",
            Value::Null,
            serde_json::json!({"q":"fixture","count":"2"}),
        ),
        (
            "exa",
            "/exa/exa.search/search",
            serde_json::json!({"query":"fixture","numResults":2,"contents":{"text":true}}),
            Value::Null,
        ),
        (
            "tavily",
            "/tavily/tavily.search/search",
            serde_json::json!({"query":"fixture","max_results":2,"search_depth":"basic"}),
            Value::Null,
        ),
        (
            "firecrawl",
            "/firecrawl/firecrawl.search/v2/search",
            serde_json::json!({"query":"fixture","limit":2}),
            Value::Null,
        ),
        (
            "serper",
            "/serper/serper.search/search",
            serde_json::json!({"q":"fixture","num":2}),
            Value::Null,
        ),
        (
            "parallel",
            "/parallel/parallel.search/v1/search",
            serde_json::json!({"objective":"fixture","search_queries":["fixture"],"mode":"basic"}),
            Value::Null,
        ),
        (
            "deepseek",
            "/deepseek/deepseek.search/v1/tools/search",
            serde_json::json!({"query":"fixture","count":2}),
            Value::Null,
        ),
    ] {
        cases.push((package, "web.search", "search", serde_json::json!({"query":"fixture","limit":2}), serde_json::json!({"method":if package == "brave" {"GET"} else {"POST"},"path":path,"body":body,"query":query})));
    }
    // Omitted canonical limit follows each shipped provider's declared defaults.
    let defaults = cases.clone();
    for (package, verb, slug, _, mut request) in defaults {
        match package {
            "brave" => {
                request["query"].as_object_mut().unwrap().remove("count");
            }
            "exa" => request["body"]["numResults"] = serde_json::json!(10),
            "tavily" => request["body"]["max_results"] = serde_json::json!(10),
            "serper" => request["body"]["num"] = serde_json::json!(10),
            "firecrawl" => {
                request["body"].as_object_mut().unwrap().remove("limit");
            }
            "parallel" => {}
            "deepseek" => request["body"]["count"] = serde_json::json!(10),
            _ => unreachable!(),
        }
        cases.push((
            package,
            verb,
            slug,
            serde_json::json!({"query":"fixture"}),
            request,
        ));
    }
    for (package, path, body) in [
        (
            "tavily",
            "/tavily/tavily.extract/extract",
            // Tavily's extract `format` accepts the canonical `text` value.
            serde_json::json!({"urls":[PAGE],"format":"text"}),
        ),
        (
            "serper",
            "/serper/serper.scrape/",
            serde_json::json!({"url":PAGE,"includeMarkdown":true}),
        ),
        (
            "parallel",
            "/parallel/parallel.extract/v1/extract",
            serde_json::json!({"urls":[PAGE],"advanced_settings":{"full_content":true}}),
        ),
        (
            "firecrawl",
            "/firecrawl/firecrawl.scrape/v2/scrape",
            serde_json::json!({"url":PAGE}),
        ),
        (
            "deepseek",
            "/deepseek/deepseek.fetch/v1/tools/fetch",
            // Canonical `format` is dropped: DeepSeek always answers in markdown.
            serde_json::json!({"url":PAGE}),
        ),
    ] {
        cases.push((
            package,
            "web.extract",
            "extract",
            serde_json::json!({"url":PAGE,"format":"text"}),
            serde_json::json!({"method":"POST","path":path,"body":body,"query":null}),
        ));
    }
    cases.push(("firecrawl", "web.crawl", "crawl", serde_json::json!({"url":PAGE,"depth":0,"limit":1}), serde_json::json!({"method":"POST","path":"/firecrawl/firecrawl.crawl_start/v2/crawl","body":{"url":PAGE,"maxDiscoveryDepth":0,"limit":1},"query":null})));
    cases
}

fn raw_item(package: &str, verb: &str) -> Value {
    if verb == "web.search" {
        match package {
            "brave" | "firecrawl" => {
                serde_json::json!({"title":"Fixture page","url":PAGE,"description":"Fixture text"})
            }
            "exa" => serde_json::json!({"title":"Fixture page","url":PAGE,"text":"Fixture text"}),
            "tavily" => {
                serde_json::json!({"title":"Fixture page","url":PAGE,"content":"Fixture text"})
            }
            "serper" => {
                serde_json::json!({"title":"Fixture page","link":PAGE,"snippet":"Fixture text"})
            }
            "parallel" => {
                serde_json::json!({"title":"Fixture page","url":PAGE,"excerpts":["Fixture text"]})
            }
            "deepseek" => {
                serde_json::json!({"title":"Fixture page","url":PAGE,"summary":"Fixture text"})
            }
            _ => unreachable!(),
        }
    } else {
        match package {
            "tavily" => serde_json::json!({"url":PAGE,"raw_content":"Fixture text"}),
            "serper" => serde_json::json!({"text":"Fixture text","markdown":"Fixture text"}),
            "parallel" => serde_json::json!({"url":PAGE,"full_content":"Fixture text"}),
            "deepseek" => serde_json::json!({"title":"Fixture page","content":"Fixture text"}),
            "firecrawl" => {
                serde_json::json!({"metadata":{"sourceURL":PAGE,"title":["Fixture page"]},"markdown":"Fixture text"})
            }
            _ => unreachable!(),
        }
    }
}

async fn web_fixture(State(state): State<Shared>, request: Request<Body>) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    let query = parts
        .uri
        .query()
        .map(|query| {
            serde_json::to_value(
                url::form_urlencoded::parse(query.as_bytes())
                    .into_owned()
                    .collect::<std::collections::BTreeMap<_, _>>(),
            )
            .unwrap()
        })
        .unwrap_or(Value::Null);
    let mut guard = state.lock().await;
    guard.requests.push(serde_json::json!({"method":parts.method.as_str(),"path":parts.uri.path(),"query":query,"body":body,"authorization":parts.headers.get("authorization").and_then(|value| value.to_str().ok()),"provider_key":parts.headers.get("x-api-key").or_else(|| parts.headers.get("x-subscription-token")).and_then(|value| value.to_str().ok())}));
    if guard.unavailable {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error":"fixture unavailable"})),
        )
            .into_response();
    }
    drop(guard);
    let path = parts.uri.path();
    let package = path.split('/').nth(1).unwrap();
    let extract = path.contains(".extract") || path.contains(".scrape") || path.contains(".fetch");
    let item = raw_item(
        package,
        if extract || path.contains(".crawl") {
            "web.extract"
        } else {
            "web.search"
        },
    );
    let payload = if path.contains(".crawl_start") {
        serde_json::json!({"success":true,"id":"fixture-job"})
    } else if path.contains(".crawl_status") {
        serde_json::json!({"success":true,"status":"completed","total":1,"data":[item]})
    } else {
        match package {
            "brave" => serde_json::json!({"web":{"results":[item]}}),
            "serper" | "deepseek" if extract => item,
            "serper" => serde_json::json!({"organic":[item]}),
            "firecrawl" if extract => serde_json::json!({"success":true,"data":item}),
            "firecrawl" => serde_json::json!({"success":true,"data":{"web":[item]}}),
            _ => serde_json::json!({"results":[item]}),
        }
    };
    Json(payload).into_response()
}
