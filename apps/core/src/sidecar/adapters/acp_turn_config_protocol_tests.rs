use super::*;

fn native_discovery_fixture() -> (
    crate::pi_config::native_accounts::NativeAccounts,
    crate::pi_config::accounts::AccountVault,
    tempfile::TempDir,
) {
    let directory = tempfile::tempdir().unwrap();
    let vault = crate::pi_config::accounts::AccountVault::in_memory().unwrap();
    let accounts = crate::pi_config::native_accounts::NativeAccounts::new(
        vault.clone(),
        directory.path(),
        &directory.path().join("kiro-cli.exe"),
    )
    .unwrap();
    (accounts, vault, directory)
}

fn connect_native_discovery_fixture(
    accounts: &crate::pi_config::native_accounts::NativeAccounts,
    vault: &crate::pi_config::accounts::AccountVault,
    label: &str,
) -> String {
    use crate::pi_config::native_accounts::SCOPE;
    let account = accounts.create(label).unwrap();
    let previous = vault
        .credential(SCOPE, &account.account_id)
        .unwrap()
        .unwrap();
    let mut connected = previous.clone();
    connected["state"] = serde_json::json!("connected");
    connected["identity"] = serde_json::json!({"subject": label, "issuer": "fixture"});
    connected["credentialRevision"] = serde_json::json!(1);
    assert!(vault
        .replace_credential(SCOPE, &account.account_id, &previous, connected)
        .unwrap());
    account.account_id
}

#[test]
fn native_discovery_masks_ambient_credentials_in_actual_child() {
    // Poison only an owned subprocess, never the shared test environment.
    // Its normal production ACP probe then launches the actual JSON-RPC child.
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child.args([
        "--exact",
        "sidecar::adapters::acp::turn_config_protocol_tests::native_discovery_uses_one_selected_identity_and_actual_child_home",
        "--test-threads=1",
        "--nocapture",
    ]);
    for name in super::UNSCOPED_ACP_BRIDGE_CREDENTIALS {
        child.env(name, "fixture-ambient-core-secret");
    }
    let output = child.output().expect("launch the owned ACP proof harness");
    assert!(
        output.status.success(),
        "actual credential isolation failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test]
async fn native_discovery_uses_one_selected_identity_and_actual_child_home() {
    let (accounts, vault, directory) = native_discovery_fixture();
    let a = connect_native_discovery_fixture(&accounts, &vault, "A");
    let b = connect_native_discovery_fixture(&accounts, &vault, "B");
    let node = resolve_in_path("node").expect("Node is required for ACP wire tests");
    // Faithful direct-npm script shape under a user-chosen data-directory
    // name containing another vendor's name must still launch this agent.
    let installed = directory
        .path()
        .join("codex-acp-host/node_modules/@fixture/native-acp");
    std::fs::create_dir_all(&installed).unwrap();
    let script = installed.join("native-discovery.js");
    let observed = directory.path().join("observed-home.json");
    std::fs::write(
        &script,
        r#"
const fs=require('fs');
const rl=require('readline').createInterface({input:process.stdin});
const denied=JSON.parse(process.argv[3]);
fs.writeFileSync(process.argv[2],JSON.stringify({home:process.env.HOME,
 denied:Object.fromEntries(denied.map(key=>[key,process.env[key]??null])),
 scoped:process.env.RYU_MCP_SESSION_CAPABILITY,path:process.env.PATH}));
rl.on('line',line=>{
 const m=JSON.parse(line);
 const result=m.method==='initialize'
  ? {protocolVersion:1,agentCapabilities:{}}
  : {sessionId:'probe'};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
});
"#,
    )
    .unwrap();
    let spawn = acp_stdio_spawn_json(
        "native-discovery-fixture",
        node,
        vec![
            script.to_string_lossy().into_owned(),
            observed.to_string_lossy().into_owned(),
            serde_json::to_string(&super::UNSCOPED_ACP_BRIDGE_CREDENTIALS).unwrap(),
        ],
        vec![(
            "RYU_MCP_SESSION_CAPABILITY".to_owned(),
            "fixture-scoped-capability".to_owned(),
        )],
    )
    .unwrap();
    let mut keys = Vec::new();
    for selected in [&a, &b, &a] {
        accounts.select(selected).unwrap();
        let expected = accounts.capture(selected).unwrap();
        let (key, environment) = native_probe_context_for_accounts(&accounts).unwrap();
        assert_eq!(environment.as_ref().unwrap()["HOME"], expected.env["HOME"]);
        // A later picker change must not change the already captured probe.
        accounts
            .select(if selected == &a { &b } else { &a })
            .unwrap();
        probe_acp_config_uncached_with_environment(
            spawn.clone(),
            directory.path().to_path_buf(),
            Default::default(),
            environment,
        )
        .await
        .unwrap();
        let actual: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&observed).unwrap()).unwrap();
        assert_eq!(actual["home"], expected.env["HOME"]);
        for name in super::UNSCOPED_ACP_BRIDGE_CREDENTIALS {
            assert_eq!(
                actual["denied"][name], "",
                "actual ACP child must mask {name}"
            );
        }
        assert_eq!(actual["scoped"], "fixture-scoped-capability");
        assert!(!actual["path"].as_str().unwrap().is_empty());
        keys.push(key);
    }
    assert_ne!(keys[0], keys[1]);
    assert_eq!(keys[0], keys[2]);
}

#[test]
fn native_discovery_signed_out_fallback_does_not_hide_invalid_selection() {
    use crate::pi_config::native_accounts::SCOPE;
    let (accounts, vault, _directory) = native_discovery_fixture();
    let (signed_out_key, environment) = native_probe_context_for_accounts(&accounts).unwrap();
    let signed_out_home = environment.unwrap()["HOME"].clone();
    let account = connect_native_discovery_fixture(&accounts, &vault, "A");
    accounts.select(&account).unwrap();
    let (connected_key, environment) = native_probe_context_for_accounts(&accounts).unwrap();
    assert_ne!(signed_out_key, connected_key);
    assert_ne!(signed_out_home, environment.unwrap()["HOME"]);
    let previous = vault.credential(SCOPE, &account).unwrap().unwrap();
    let mut rotated = previous.clone();
    rotated["credentialRevision"] = serde_json::json!(2);
    assert!(vault
        .replace_credential(SCOPE, &account, &previous, rotated)
        .unwrap());
    let (rotated_key, _) = native_probe_context_for_accounts(&accounts).unwrap();
    assert_ne!(
        connected_key, rotated_key,
        "credential revisions invalidate discovery"
    );
    let previous = vault.credential(SCOPE, &account).unwrap().unwrap();
    let mut disconnected = previous.clone();
    disconnected["state"] = serde_json::json!("disconnected");
    assert!(vault
        .replace_credential(SCOPE, &account, &previous, disconnected)
        .unwrap());
    let error = native_probe_context_for_accounts(&accounts).unwrap_err();
    assert!(error.to_string().contains("not verified"));
    // The signed-out helper never silently re-reads a now-selected account.
    assert_eq!(
        accounts.signed_out_discovery_env().unwrap()["HOME"],
        signed_out_home
    );
}

#[tokio::test]
async fn discovery_retains_login_methods_when_session_requires_authentication() {
    let (native, _vault, _native_directory) = native_discovery_fixture();
    let (_, signed_out_environment) = native_probe_context_for_accounts(&native).unwrap();
    let node = resolve_in_path("node").expect("Node is required for ACP wire tests");
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("auth-required.js");
    std::fs::write(&script, r#"
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line);
 const response=m.method==='initialize'
  ? {result:{protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:'vendor-login',name:'Vendor login'}]}}
  : {error:{code:Number(process.argv[2]),message:'Session rejected'}};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...response})+'\n');
});
"#).unwrap();
    for code in [ACP_AUTH_REQUIRED_CODE, -32603] {
        let spawn = acp_stdio_spawn_json(
            "auth-proof",
            node.clone(),
            vec![script.to_string_lossy().into_owned(), code.to_string()],
            vec![],
        )
        .unwrap();
        let result = probe_acp_config_uncached_with_environment(
            spawn,
            dir.path().to_path_buf(),
            Default::default(),
            signed_out_environment.clone(),
        )
        .await;
        if code == ACP_AUTH_REQUIRED_CODE {
            let config = result.expect("login-required discovery remains available");
            assert_eq!(config["authenticationRequired"], true);
            assert_eq!(config["authMethods"][0]["id"], "vendor-login");
            assert_eq!(config["agentCapabilities"]["loadSession"], true);
            assert!(config["models"].is_null());
            assert!(config["modes"].is_null());
            assert!(config["configOptions"].is_null());
        } else {
            assert!(result.is_err(), "non-auth session errors must stay visible");
        }
    }
}

/// The probe feeds the desktop pickers, so it must advertise the same
/// `session.configOptions.boolean` capability as a live instance (3.x agents
/// withhold boolean options otherwise), and it must read `models` with 0.11's
/// lenient serde so one malformed entry cannot fail the whole acp-config.
#[tokio::test]
async fn probe_advertises_boolean_config_options_and_normalizes_models() {
    let node = resolve_in_path("node").expect("Node is required for ACP wire tests");
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("probe-caps.js");
    std::fs::write(
        &script,
        r#"
let boolean=false;
const rl=require('readline').createInterface({input:process.stdin});
rl.on('line',line=>{
 const m=JSON.parse(line);
 if(m.id===undefined)return;
 let result;
 if(m.method==='initialize'){
  const caps=m.params.clientCapabilities||{};
  boolean=!!(caps.session&&caps.session.configOptions&&caps.session.configOptions.boolean);
  result={protocolVersion:1,agentCapabilities:{}};
 }else{
  result={sessionId:'probe',
   configOptions:boolean?[{id:'brave',name:'Brave',type:'boolean',currentValue:false}]:[],
   models:{currentModelId:'a',availableModels:[{modelId:'a',name:'A'},{modelId:'b'}],extra:1}};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n');
});
"#,
    )
    .unwrap();
    let spawn = acp_stdio_spawn_json(
        "probe-caps",
        node,
        vec![script.to_string_lossy().into_owned()],
        vec![],
    )
    .unwrap();
    let config = probe_acp_config_uncached_with_environment(
        spawn,
        dir.path().to_path_buf(),
        Default::default(),
        None,
    )
    .await
    .unwrap();
    let options = config["configOptions"].as_array().unwrap();
    assert!(
        options
            .iter()
            .any(|option| option["id"] == "brave" && option["type"] == "boolean"),
        "{config}"
    );
    assert_eq!(
        config["models"],
        serde_json::json!({
            "currentModelId": "a",
            "availableModels": [{"modelId": "a", "name": "A"}]
        })
    );
}

#[test]
fn resume_requires_the_same_captured_account_identity() {
    let binding = serde_json::json!({ ACP_ACCOUNT_BINDING_KEY: "kiro:account-a" });
    assert!(resume_account_matches(&binding, Some("kiro:account-a")));
    assert!(!resume_account_matches(&binding, Some("kiro:account-b")));
    assert!(!resume_account_matches(&binding, None));
    assert!(!resume_account_matches(
        &serde_json::json!({}),
        Some("kiro:account-a")
    ));
    assert!(resume_account_matches(&serde_json::json!({}), None));
    assert!(!resume_account_matches(
        &serde_json::json!({ ACP_ACCOUNT_BINDING_KEY: 12 }),
        None
    ));
    let native = serde_json::json!({ ACP_ACCOUNT_BINDING_KEY:"kiro:account-a:home-a:epoch-a:1" });
    assert!(resume_account_matches(
        &native,
        Some("kiro:account-a:home-a:epoch-a:2")
    ));
    assert!(!resume_account_matches(
        &native,
        Some("kiro:account-b:home-a:epoch-a:2")
    ));
    assert!(!resume_account_matches(
        &native,
        Some("kiro:account-a:home-b:epoch-a:2")
    ));
    assert!(!resume_account_matches(
        &native,
        Some("kiro:account-a:home-a:epoch-b:2")
    ));
}

const AGENT: &str = r#"
const rl = require('readline').createInterface({input:process.stdin});
const fs = require('fs');
rl.on('line', line => {
  const m=JSON.parse(line);
  fs.appendFileSync(process.argv[2], JSON.stringify(m)+'\n');
  let result={};
  let error;
  if(m.method==='initialize') result={protocolVersion:1,agentCapabilities:{}};
  else if(m.method==='session/set_model') error={code:-32601,message:'Unsupported legacy model method'};
  else if(m.method==='session/set_config_option') {
    if(m.params.value==='rejected') error={code:-32602,message:'Invalid model'};
    else result={configOptions:[{id:'model',name:'Model',category:'model',type:'select',currentValue:m.params.value,options:[{value:m.params.value,name:'Selected'}]}]};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,...(error?{error}:{result})})+'\n');
});
"#;

async fn run_config(explicit: bool, rejected: bool) -> (Vec<String>, Vec<AcpEvent>) {
    let model = if rejected { "rejected" } else { "chosen" };
    let turn = AcpTurnConfig {
        session_mode: None,
        config_options: if explicit {
            vec![("model".into(), model.into())]
        } else {
            vec![]
        },
        model_id: Some(model.into()),
        agent_effort: None,
        interactive: true,
    };
    let trusted = WorkspaceAutonomy {
        trusted: true,
        is_claude_code: false,
    };
    run_turn_config(turn, trusted).await
}

async fn run_turn_config(
    turn: AcpTurnConfig,
    workspace: WorkspaceAutonomy,
) -> (Vec<String>, Vec<AcpEvent>) {
    let node = resolve_in_path("node").expect("Node is required for ACP wire regression tests");
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("agent.js");
    let log = dir.path().join("requests.jsonl");
    std::fs::write(&script, AGENT).unwrap();
    let agent = AcpSpawn::new(McpServer::Stdio(McpServerStdio::new("fake", node).args(
        vec![
            script.to_string_lossy().into_owned(),
            log.to_string_lossy().into_owned(),
        ],
    )))
    .into_agent()
    .unwrap();
    let (tx, mut rx) = mpsc::unbounded_channel();
    tokio::time::timeout(
        Duration::from_secs(20),
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| async move {
                cx.send_request(ryu_initialize_request())
                    .block_task()
                    .await?;
                apply_turn_config(cx, SessionId::new("session"), &turn, &workspace, &tx).await;
                Ok(())
            }),
    )
    .await
    .expect("fake agent responded")
    .expect("connection succeeded");
    let methods = std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|line| {
            serde_json::from_str::<serde_json::Value>(line).unwrap()["method"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    let mut events = vec![];
    while let Ok(event) = rx.try_recv() {
        events.push(event);
    }
    (methods, events)
}

#[tokio::test]
async fn untrusted_workspace_refuses_permission_skipping_mode() {
    let turn = AcpTurnConfig {
        session_mode: Some("bypassPermissions".into()),
        ..AcpTurnConfig::default()
    };
    let untrusted = WorkspaceAutonomy {
        trusted: false,
        is_claude_code: true,
    };
    let (methods, events) = run_turn_config(turn, untrusted).await;
    assert_eq!(methods, ["initialize"], "set_mode must not reach the agent");
    assert!(events.iter().any(|event| matches!(
        event,
        AcpEvent::ConfigWarning { field, requested, .. }
            if field == WORKSPACE_TRUST_WARNING_FIELD && requested == "bypassPermissions"
    )));
}

#[tokio::test]
async fn trusted_workspace_forwards_permission_skipping_mode() {
    let turn = AcpTurnConfig {
        session_mode: Some("bypassPermissions".into()),
        ..AcpTurnConfig::default()
    };
    let trusted = WorkspaceAutonomy {
        trusted: true,
        is_claude_code: true,
    };
    let (methods, _) = run_turn_config(turn, trusted).await;
    assert_eq!(methods, ["initialize", "session/set_mode"]);
}

#[tokio::test]
async fn explicit_model_config_does_not_send_legacy_model_method() {
    let (methods, events) = run_config(true, false).await;
    assert_eq!(methods, ["initialize", "session/set_config_option"]);
    assert!(events.iter().any(|event| matches!(event, AcpEvent::ConfigOptions(options) if options[0]["currentValue"] == "chosen")));
}

#[tokio::test]
async fn legacy_model_fallback_publishes_replacement_options() {
    let (methods, events) = run_config(false, false).await;
    assert_eq!(
        methods,
        [
            "initialize",
            "session/set_model",
            "session/set_config_option"
        ]
    );
    assert!(events.iter().any(|event| matches!(event, AcpEvent::ConfigOptions(options) if options[0]["currentValue"] == "chosen")));
}

#[tokio::test]
async fn rejected_explicit_model_emits_warning_without_legacy_retry() {
    let (methods, events) = run_config(true, true).await;
    assert_eq!(methods, ["initialize", "session/set_config_option"]);
    assert!(events.iter().any(|event| matches!(event, AcpEvent::ConfigWarning { field, requested, .. } if field == "model" && requested == "rejected")));
    assert!(!events
        .iter()
        .any(|event| matches!(event, AcpEvent::ConfigOptions(_))));
}
