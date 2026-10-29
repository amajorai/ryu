//! The shipped `verify.*` adapters through Core's JS sandbox and MCP HTTP transport.
//! The `ryu-reasoning mcp` stdio server is replaced only by a local protocol endpoint
//! that answers in the same text-envelope shape. No solver, model or policy store is
//! claimed by this proof; it pins the verdict mapping (every solver outcome, and the
//! headline folded from mixed findings), scope selection, failure reporting and grant
//! gate between the canonical verbs and the provider, plus the host-callback env the
//! real stdio server is spawned with.
use super::*;
use axum::{extract::State, routing::post, Json, Router};
use std::sync::Arc;
const RAW: &str = include_str!("../../../../../../generated/ryu-runtime/apps-store/reasoning/manifest.json");
const CLAIM_ADAPTER: &str =
    include_str!("../../../../../../generated/ryu-runtime/apps-store/reasoning/adapters/verify.claim.js");
const SCOPES_ADAPTER: &str =
    include_str!("../../../../../../generated/ryu-runtime/apps-store/reasoning/adapters/verify.scopes.js");
const CHECK_HOOK: &str = include_str!("../../../../../../generated/ryu-runtime/apps-store/reasoning/hooks/check.js");
const CHILD: &str = "RYU_REASONING_VERIFY_CANONICAL_CHILD";
const TEST: &str = "sidecar::mcp::tests::reasoning_verify_capabilities_runtime::shipped_verify_adapters_map_verdicts_scopes_failures_and_grants";
/// `(solver result, finding verdicts, notes, canonical headline, canonical claim verdicts)`.
///
/// Single findings pin the per-outcome mapping. Mixed findings pin the headline: a
/// contradiction anywhere refutes, and `proved` needs every part proved with nothing
/// skipped, so a solver `valid` over a partly untranslatable answer is not a pass.
const VERDICT_TABLE: &[(&str, &[&str], &[&str], &str, &[&str])] = &[
    ("valid", &["valid"], &[], "proved", &["proved"]),
    ("invalid", &["invalid"], &[], "refuted", &["refuted"]),
    (
        "satisfiable",
        &["satisfiable"],
        &[],
        "undecided",
        &["undecided"],
    ),
    (
        "impossible",
        &["impossible"],
        &[],
        "inconsistent",
        &["inconsistent"],
    ),
    (
        "no_translations",
        &["no_translations"],
        &[],
        "unverifiable",
        &["unverifiable"],
    ),
    (
        "translation_ambiguous",
        &["translation_ambiguous"],
        &[],
        "unverifiable",
        &["unverifiable"],
    ),
    (
        "too_complex",
        &["too_complex"],
        &[],
        "unverifiable",
        &["unverifiable"],
    ),
    ("no_translations", &[], &[], "unverifiable", &[]),
    (
        "valid",
        &["valid", "no_translations"],
        &[],
        "unverifiable",
        &["proved", "unverifiable"],
    ),
    (
        "valid",
        &["valid"],
        &["Skipped \"bonuses are paid in March\": no variable for bonus timing"],
        "unverifiable",
        &["proved"],
    ),
    (
        "invalid",
        &["valid", "invalid"],
        &[],
        "refuted",
        &["proved", "refuted"],
    ),
    (
        "satisfiable",
        &["valid", "satisfiable"],
        &[],
        "undecided",
        &["proved", "undecided"],
    ),
    (
        "valid",
        &["valid", "valid"],
        &[],
        "proved",
        &["proved", "proved"],
    ),
];

#[derive(Default)]
struct Fixture {
    calls: Vec<Value>,
    /// How many policies `policies` reports.
    policies: usize,
    /// `check` answers with a tool error instead of a report.
    check_fails: bool,
    /// The aggregate `result` a `check` report carries.
    check_result: &'static str,
    /// One finding per verdict, in order.
    check_findings: &'static [&'static str],
    /// The report's `notes` (skipped sentences, facts and rules).
    check_notes: &'static [&'static str],
}
type Shared = Arc<tokio::sync::Mutex<Fixture>>;

#[tokio::test]
async fn shipped_verify_adapters_map_verdicts_scopes_failures_and_grants() {
    if std::env::var_os(CHILD).is_none() {
        let dir = tempfile::tempdir().unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .args(["--exact", TEST, "--nocapture"])
            .env(CHILD, "1")
            .env("RUST_MIN_STACK", "16777216")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", dir.path())
            .env("RYU_ALLOW_GATEWAY_FALLBACK", "1")
            .env("RYU_EXEC_APPROVAL_MODE", "off")
            .env_remove("RYU_GATEWAY_REMOTE");
        for key in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            child.env_remove(key);
        }
        assert!(
            child.status().unwrap().success(),
            "isolated reasoning verify fixture failed"
        );
        return;
    }
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
    std::env::remove_var("RYU_GATEWAY_TOKEN");
    let state: Shared = Arc::new(tokio::sync::Mutex::new(Fixture {
        policies: 1,
        check_result: "invalid",
        check_findings: &["invalid"],
        ..Fixture::default()
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let _allowed = allow_discovery_test_host(address);
    let app = Router::new()
        .route("/mcp", post(endpoint))
        .with_state(state.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let mut raw: Value = serde_json::from_str(RAW).unwrap();
    assert_eq!(raw["mcp_servers"]["reasoning"]["command"], "ryu-reasoning");
    raw["mcp_servers"]["reasoning"] =
        serde_json::json!({"type":"streamable-http","url":format!("http://{address}/mcp")});
    let manifest =
        PluginManifest::parse_and_validate_with_code(&raw.to_string(), adapter_body).unwrap();
    let store = Arc::new(crate::plugins::PluginStore::open_in_memory().unwrap());
    store.insert(&manifest.id, &manifest.version).await.unwrap();
    let mut approved = manifest.permission_grants.clone();
    approved.push(GRANT_MCP_SERVER.to_owned());
    store.set_enabled(&manifest.id, &approved).await.unwrap();
    let manifests = Arc::new(TokioRwLock::new(vec![manifest.clone()]));
    let registry = Arc::new(McpRegistry::empty().with_self_build(manifests.clone(), store.clone()));
    let tier = crate::plugins::builtins::tier_for_manifest(&manifest);
    assert_eq!(
        register_manifest_mcp_servers(&registry, &manifest, tier, &approved),
        ["reasoning"]
    );
    let runtime = crate::plugins::runtime::PluginRuntime::new();
    registry.set_plugin_runtime(runtime.clone());
    runtime.begin_activation(&manifest.id).await.commit();

    // Production spawns the manifest's own stdio `ryu-reasoning mcp`, not this
    // fixture, and its prose check needs the host model callback. The config every
    // spawn path lowers must carry the owner's host contract; the stored
    // registration (what the server listing summarizes) must not.
    let shipped = PluginManifest::parse_and_validate_with_code(RAW, adapter_body).unwrap();
    let mut stdio = mcp_server_config_from_decl(&shipped.mcp_servers["reasoning"]);
    stdio.owner_plugin_id = Some(shipped.id.clone());
    stdio.owner_server_name = Some("reasoning".to_owned());
    let spawned = McpRegistry::from_servers(std::collections::BTreeMap::from([(
        "reasoning".to_owned(),
        stdio.clone(),
    )]))
    .with_self_build(Arc::new(TokioRwLock::new(vec![shipped])), store.clone());
    spawned.set_plugin_runtime(runtime.clone());
    let (lowered, lease) = spawned
        .active_server_config("reasoning", stdio)
        .await
        .unwrap();
    let McpTarget::Stdio(command) = lowered.to_target().unwrap() else {
        panic!("the shipped reasoning MCP server is stdio");
    };
    drop(lease);
    assert_eq!(command.args, ["mcp"]);
    let env: std::collections::BTreeMap<String, String> = command.env.into_iter().collect();
    assert_eq!(env["RYU_EXT_PLUGIN_ID"], "@ryu/reasoning");
    assert_eq!(
        env["RYU_EXT_TOKEN"],
        crate::sidecar::ext_proxy::ext_token(None, "@ryu/reasoning")
    );
    assert_eq!(
        env["RYU_CORE_PORT"],
        crate::sidecar::cli_shims::core_port_string()
    );
    assert!(spawned.servers.read().unwrap()["reasoning"].env.is_empty());

    set_global_registry(registry.clone());
    // No override: the reasoning app is the layer's declared default provider.
    crate::plugins::binding::set_active_config(crate::plugins::binding::BindingConfig::default());

    // The per-agent allowlist is checked on the stable verb, before any provider call.
    let denied = registry
        .call_tool(
            "verify.claim",
            serde_json::json!({"claim":"x"}),
            Some(&["web.search".into()]),
        )
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("not in this agent's allowlist"));
    assert!(state.lock().await.calls.is_empty());

    // An explicit scope goes straight to `check`; the solver verdict and its evidence
    // come back in the canonical vocabulary.
    let refuted = registry
        .call_tool(
            "verify.claim",
            serde_json::json!({"claim":"Managers get 30 days","question":"How many days?","scope":"hr"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(refuted["provider"], "@ryu/reasoning", "{refuted}");
    assert_eq!(refuted["verdict"], "refuted", "{refuted}");
    assert_eq!(refuted["provider_verdict"], "invalid");
    assert_eq!(refuted["scope"], serde_json::json!({"id":"hr","version":3}));
    assert_eq!(refuted["claims"][0]["verdict"], "refuted");
    assert_eq!(refuted["claims"][0]["claim"], "Managers get 30 days");
    assert_eq!(refuted["claims"][0]["evidence"][0]["id"], "rule-1");
    assert_eq!(
        refuted["claims"][0]["counterexample"],
        serde_json::json!({"vacation_days":30})
    );
    {
        let fixture = state.lock().await;
        assert_eq!(fixture.calls.len(), 1);
        assert_eq!(fixture.calls[0]["name"], "check");
        assert_eq!(
            fixture.calls[0]["arguments"],
            serde_json::json!({"policy_id":"hr","question":"How many days?","answer":"Managers get 30 days"})
        );
    }

    // No scope and exactly one policy: that policy is used.
    let before = state.lock().await.calls.len();
    let defaulted = registry
        .call_tool("verify.claim", serde_json::json!({"claim":"x"}), None)
        .await
        .unwrap();
    assert_eq!(defaulted["verdict"], "refuted", "{defaulted}");
    {
        let fixture = state.lock().await;
        let names: Vec<_> = fixture.calls[before..]
            .iter()
            .map(|c| c["name"].clone())
            .collect();
        assert_eq!(names, ["policies", "check"]);
        assert_eq!(fixture.calls[before + 1]["arguments"]["policy_id"], "hr");
    }

    // No scope and several policies: unverifiable plus the choices, and no check runs.
    state.lock().await.policies = 2;
    let before = state.lock().await.calls.len();
    let ambiguous = registry
        .call_tool("verify.claim", serde_json::json!({"claim":"x"}), None)
        .await
        .unwrap();
    assert_eq!(ambiguous["verdict"], "unverifiable", "{ambiguous}");
    assert_eq!(ambiguous["scopes"].as_array().unwrap().len(), 2);
    {
        let fixture = state.lock().await;
        assert_eq!(fixture.calls.len(), before + 1);
        assert_eq!(fixture.calls[before]["name"], "policies");
    }

    // A tool error is reported as unverifiable with its reason, never as a verdict.
    state.lock().await.check_fails = true;
    let failed = registry
        .call_tool(
            "verify.claim",
            serde_json::json!({"claim":"x","scope":"missing"}),
            None,
        )
        .await
        .unwrap();
    assert_eq!(failed["verdict"], "unverifiable", "{failed}");
    assert!(failed["reason"]
        .as_str()
        .unwrap()
        .contains("no policy with the id 'missing'"));
    state.lock().await.check_fails = false;

    for &(result, findings, notes, headline, parts) in VERDICT_TABLE {
        {
            let mut fixture = state.lock().await;
            fixture.check_result = result;
            fixture.check_findings = findings;
            fixture.check_notes = notes;
        }
        let checked = registry
            .call_tool(
                "verify.claim",
                serde_json::json!({"claim":"x","scope":"hr"}),
                None,
            )
            .await
            .unwrap();
        assert_eq!(checked["verdict"], headline, "{checked}");
        assert_eq!(checked["provider_verdict"], result, "{checked}");
        let claims: Vec<&str> = checked["claims"]
            .as_array()
            .unwrap()
            .iter()
            .map(|claim| claim["verdict"].as_str().unwrap())
            .collect();
        assert_eq!(claims, parts, "{checked}");
        assert_eq!(
            checked["reason"].is_string(),
            headline == "unverifiable",
            "{checked}"
        );
        assert_eq!(checked["notes"], serde_json::json!(notes), "{checked}");
    }
    {
        let mut fixture = state.lock().await;
        fixture.check_result = "invalid";
        fixture.check_findings = &["invalid"];
        fixture.check_notes = &[];
    }

    let scopes = registry
        .call_tool("verify.scopes", serde_json::json!({}), None)
        .await
        .unwrap();
    assert_eq!(scopes["provider"], "@ryu/reasoning", "{scopes}");
    assert_eq!(
        scopes["scopes"],
        serde_json::json!([
            {"id":"hr","name":"HR handbook","description":"Leave rules","version":3},
            {"id":"refunds","name":"Refunds","description":"","version":1}
        ])
    );

    // The adapter path hard-errors without `tool:execute`, before reaching the provider.
    manifests.write().await[0]
        .permission_grants
        .retain(|grant| grant != "tool:execute");
    approved.retain(|grant| grant != "tool:execute");
    store.set_enabled(&manifest.id, &approved).await.unwrap();
    let before = state.lock().await.calls.len();
    let denied = registry
        .call_tool(
            "verify.claim",
            serde_json::json!({"claim":"x","scope":"hr"}),
            None,
        )
        .await
        .unwrap_err();
    assert!(denied.to_string().contains("tool:execute"), "{denied}");
    assert_eq!(state.lock().await.calls.len(), before);
    assert!(registry.deregister_server(&manifest.id, "reasoning"));
    server.abort();
}

fn text_envelope(value: &Value, is_error: bool) -> Value {
    serde_json::json!({
        "content": [{"type":"text","text":serde_json::to_string_pretty(value).unwrap()}],
        "isError": is_error
    })
}

/// The resolver Core uses for a built-in: the compiled-in body for each declared
/// `code_file`, so the test reads the same paths the public mirror vendors.
fn adapter_body(path: &str) -> Result<String, String> {
    match path {
        "adapters/verify.claim.js" => Ok(CLAIM_ADAPTER.to_owned()),
        "adapters/verify.scopes.js" => Ok(SCOPES_ADAPTER.to_owned()),
        "hooks/check.js" => Ok(CHECK_HOOK.to_owned()),
        other => Err(format!("unexpected reasoning fragment {other}")),
    }
}

/// One solver finding. The first is the refuted manager-leave claim the earlier
/// assertions read; only an `invalid` finding carries a counterexample.
fn finding(index: usize, verdict: &str) -> Value {
    let statement = if index == 0 {
        "Managers get 30 days".to_owned()
    } else {
        format!("Part {}", index + 1)
    };
    let mut finding = serde_json::json!({
        "verdict": verdict,
        "claim": "vacation_days == 30",
        "claim_statement": statement,
        "responsible": [{"id":"rule-1","statement":"Managers get at most 28 days","expression":"vacation_days <= 28","origin":"policy"}],
        "unstated_assumptions": [],
        "suggestions": [],
        "detail": "The policy caps manager leave at 28 days."
    });
    if verdict == "invalid" {
        finding["counterexample"] = serde_json::json!({"vacation_days":30});
    }
    finding
}

fn tool_result(fixture: &Fixture, params: &Value) -> Value {
    match params["name"].as_str().unwrap_or("") {
        "policies" => {
            let all = serde_json::json!([
                {"id":"hr","name":"HR handbook","description":"Leave rules","version":3,"variables":[],"rules":[]},
                {"id":"refunds","name":"Refunds","version":1,"variables":[],"rules":[]}
            ]);
            let listed: Vec<Value> = all
                .as_array()
                .unwrap()
                .iter()
                .take(fixture.policies)
                .cloned()
                .collect();
            text_envelope(&serde_json::json!({"policies":listed}), false)
        }
        "check" if fixture.check_fails => text_envelope(
            &serde_json::json!({"error":"no policy with the id 'missing' — call `policies` to list them"}),
            true,
        ),
        "check" => text_envelope(
            &serde_json::json!({
                "policy_id": params["arguments"]["policy_id"],
                "policy_version": 3,
                "result": fixture.check_result,
                "findings": fixture
                    .check_findings
                    .iter()
                    .enumerate()
                    .map(|(index, verdict)| finding(index, verdict))
                    .collect::<Vec<_>>(),
                "premises": [],
                "notes": fixture.check_notes,
                "elapsed_ms": 1
            }),
            false,
        ),
        _ => text_envelope(&serde_json::json!({"error":"unknown tool"}), true),
    }
}

async fn endpoint(State(state): State<Shared>, Json(rpc): Json<Value>) -> Json<Value> {
    let result = match rpc["method"].as_str().unwrap() {
        "server/discover" => {
            return Json(
                serde_json::json!({"jsonrpc":"2.0","id":rpc["id"],"error":{"code":-32601,"message":"Legacy fixture does not implement server/discover"}}),
            );
        }
        "initialize" => {
            serde_json::json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"local-reasoning-protocol-fixture","version":"1"}})
        }
        "tools/list" => serde_json::json!({"tools":[]}),
        "tools/call" => {
            let mut fixture = state.lock().await;
            fixture.calls.push(rpc["params"].clone());
            tool_result(&fixture, &rpc["params"])
        }
        "notifications/initialized" => serde_json::json!({}),
        _ => {
            return Json(
                serde_json::json!({"jsonrpc":"2.0","id":rpc["id"],"error":{"code":-32601,"message":"Unknown fixture method"}}),
            )
        }
    };
    Json(serde_json::json!({"jsonrpc":"2.0","id":rpc["id"],"result":result}))
}
