//! Shipped registry hook → production program builder → real deny-by-default sandbox.
//! The local capability fixture does not exercise HostBridge consent or AppState.
use super::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

struct Bridge {
    store: Mutex<HashMap<String, String>>,
    calls: Mutex<Vec<(String, Value)>>,
    refuse: Mutex<bool>,
}
impl crate::tool_exec::SandboxBridge for Bridge {
    fn handle(
        &self,
        path: String,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = crate::tool_exec::InvokeOutcome> + Send + '_>,
    > {
        Box::pin(async move {
            self.calls
                .lock()
                .unwrap()
                .push((path.clone(), args.clone()));
            let key = args
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let value = match path.as_str() {
                "host.storage_get" => self
                    .store
                    .lock()
                    .unwrap()
                    .get(&key)
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null),
                "host.storage_set" => {
                    if *self.refuse.lock().unwrap() {
                        json!(false)
                    } else {
                        self.store
                            .lock()
                            .unwrap()
                            .insert(key, args["value"].as_str().unwrap().to_owned());
                        json!(true)
                    }
                }
                "host.storage_delete" => {
                    if *self.refuse.lock().unwrap() {
                        json!(false)
                    } else {
                        self.store.lock().unwrap().remove(&key);
                        json!(true)
                    }
                }
                "host.log" => Value::Null,
                other => panic!("unexpected capability {other}: {args}"),
            };
            crate::tool_exec::InvokeOutcome::Result(crate::tool_exec::ToolInvokeResult {
                value,
                is_error: false,
                error: None,
            })
        })
    }
}
fn shipped(plugin: &str, hook_id: &str) -> crate::plugin_manifest::TurnHookContribution {
    crate::plugin_manifest::PluginManifestLoader::load()
        .into_iter()
        .find(|manifest| manifest.id == plugin)
        .expect("shipped plugin registry entry")
        .contributes
        .expect("contributions")
        .turn_hooks
        .into_iter()
        .find(|hook| hook.id == hook_id)
        .expect("shipped hydrated hook")
}
async fn run(
    hook: &crate::plugin_manifest::TurnHookContribution,
    input: &str,
    bridge: Arc<Bridge>,
) -> HookDirective {
    assert!(
        tool_exec::is_available(),
        "real sandbox runtime is required for this proof"
    );
    assert!(phase_matches(&hook.on, ON_PRE_USER_TURN));
    let ctx = HookContext {
        conversation_id: Some("fixture-chat".into()),
        input: Some(input.into()),
        transcript: vec![HookMessage {
            role: "user".into(),
            content: input.into(),
        }],
        ..Default::default()
    };
    assert_eq!(
        gate_without_storage(hook.run_when.as_ref().expect("command gate"), &ctx),
        GateVerdict::Run
    );
    let program = build_hook_program(&ctx, &hook.code);
    let invoker = Arc::new(SandboxToolInvoker::bridge(bridge));
    match tool_exec::run_sandboxed(program, invoker, "ryu").await {
        ExecOutcome::Completed {
            result,
            is_error,
            error,
            ..
        } => {
            assert!(!is_error, "hook failed: {error:?}");
            parse_directive(result.as_ref())
        }
        ExecOutcome::Paused { .. } => panic!("unexpected pause"),
    }
}
fn text(directive: HookDirective) -> String {
    match directive {
        HookDirective::Handled { text, .. } => text,
        other => panic!("expected handled, got {other:?}"),
    }
}
#[tokio::test]
async fn shipped_recap_mute_clear_refusal_and_retry_roundtrip_real_sandbox() {
    let hook = shipped("@ryu/recap", "recap.command");
    let bridge = Arc::new(Bridge {
        store: Mutex::new(HashMap::from([(
            "fixture-chat".into(),
            json!({ "entries": [{ "turn": 1, "text": "old recap" }], "muted": false }).to_string(),
        )])),
        calls: Mutex::new(Vec::new()),
        refuse: Mutex::new(true),
    });
    let existing = bridge.store.lock().unwrap()["fixture-chat"].clone();
    bridge
        .store
        .lock()
        .unwrap()
        .insert("fixture-chat".into(), "invalid cached JSON".into());
    *bridge.refuse.lock().unwrap() = false;
    assert!(text(run(&hook, "/recap off", bridge.clone()).await).contains("Couldn't save"));
    assert_eq!(
        bridge.store.lock().unwrap()["fixture-chat"],
        "invalid cached JSON"
    );
    assert!(!bridge
        .calls
        .lock()
        .unwrap()
        .iter()
        .any(|(path, _)| path == "host.storage_set"));
    bridge
        .store
        .lock()
        .unwrap()
        .insert("fixture-chat".into(), existing);
    *bridge.refuse.lock().unwrap() = true;
    assert!(text(run(&hook, "/recap off", bridge.clone()).await).contains("Couldn't save"));
    assert_eq!(
        serde_json::from_str::<Value>(&bridge.store.lock().unwrap()["fixture-chat"]).unwrap()
            ["muted"],
        false
    );
    *bridge.refuse.lock().unwrap() = false;
    assert!(text(run(&hook, "/recap off", bridge.clone()).await).contains("are off"));
    assert_eq!(
        serde_json::from_str::<Value>(&bridge.store.lock().unwrap()["fixture-chat"]).unwrap()
            ["muted"],
        true
    );
    *bridge.refuse.lock().unwrap() = true;
    assert!(text(run(&hook, "/recap clear", bridge.clone()).await).contains("Couldn't clear"));
    assert!(bridge.store.lock().unwrap().contains_key("fixture-chat"));
    *bridge.refuse.lock().unwrap() = false;
    assert!(text(run(&hook, "/recap clear", bridge.clone()).await).contains("Cleared"));
    assert!(bridge.store.lock().unwrap().is_empty());
    let calls = bridge.calls.lock().unwrap();
    assert!(calls
        .iter()
        .filter(|(path, _)| path.starts_with("host.storage_"))
        .all(|(_, args)| args["key"] == "fixture-chat"));
    assert_eq!(
        calls
            .iter()
            .filter(|(path, _)| path == "host.storage_set")
            .count(),
        2
    );
}
#[tokio::test]
async fn shipped_security_clear_refusal_and_retry_roundtrip_real_sandbox() {
    let hook = shipped("@ryu/security-scanner", "security-scanner.command");
    let bridge = Arc::new(Bridge {
        store: Mutex::new(HashMap::from([(
            "fixture-chat".into(),
            "existing-report".into(),
        )])),
        calls: Mutex::new(Vec::new()),
        refuse: Mutex::new(true),
    });
    assert!(
        text(run(&hook, "/security-clear", bridge.clone()).await).contains("could not be cleared")
    );
    assert_eq!(
        bridge.store.lock().unwrap()["fixture-chat"],
        "existing-report"
    );
    *bridge.refuse.lock().unwrap() = false;
    assert!(text(run(&hook, "/security-clear", bridge.clone()).await).contains("state cleared"));
    assert!(bridge.store.lock().unwrap().is_empty());
    assert_eq!(
        bridge
            .calls
            .lock()
            .unwrap()
            .iter()
            .filter(|(path, args)| path == "host.storage_delete" && args["key"] == "fixture-chat")
            .count(),
        2
    );
}
