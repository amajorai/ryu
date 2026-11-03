//! Live sandbox runs of the shipped hook fixtures: helpers and turn hooks.

use super::*;

// ── Live sandbox tests (run whenever the JS sandbox is built) ──────────────
//
// These execute the ACTUAL shipped fixture hook JS in the real deny-by-default
// JS sandbox, with a test bridge standing in for the host capabilities. They
// prove the whole runtime end-to-end: program build (shim + ctx + entry) →
// sandbox exec → capability calls round-trip the bridge → directive parsed.

/// A canned host bridge: returns `side_value` for `host.sideModel`, records
/// `host.storage_set` writes, and serves `host.storage_get` from that record.
struct TestBridge {
    side_value: serde_json::Value,
    store: std::sync::Mutex<std::collections::HashMap<String, String>>,
}

impl crate::tool_exec::SandboxBridge for TestBridge {
    fn handle(
        &self,
        path: String,
        args: serde_json::Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = crate::tool_exec::InvokeOutcome> + Send + '_>,
    > {
        let method = path.strip_prefix("host.").unwrap_or(&path).to_string();
        Box::pin(async move {
            use crate::tool_exec::{InvokeOutcome, ToolInvokeResult};
            let key = args
                .get("key")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let value = match method.as_str() {
                "sideModel" | "runAgent" => self.side_value.clone(),
                "storage_get" => self
                    .store
                    .lock()
                    .unwrap()
                    .get(&key)
                    .map(|s| serde_json::json!(s))
                    .unwrap_or(serde_json::Value::Null),
                "storage_set" => {
                    let v = args
                        .get("value")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    self.store.lock().unwrap().insert(key, v);
                    serde_json::json!(true)
                }
                "storage_delete" => {
                    self.store.lock().unwrap().remove(&key);
                    serde_json::json!(true)
                }
                "next" => serde_json::json!({
                    "kind": "note",
                    "text": "downstream"
                }),
                _ => serde_json::Value::Null,
            };
            InvokeOutcome::Result(ToolInvokeResult {
                value,
                is_error: false,
                error: None,
            })
        })
    }
}

fn fixture_hook(plugin_id: &str) -> String {
    let manifests = crate::plugin_manifest::PluginManifestLoader::load();
    let m = manifests
        .iter()
        .find(|m| m.id == plugin_id)
        .unwrap_or_else(|| panic!("fixture {plugin_id} must load"));
    m.contributes
        .as_ref()
        .expect("contributes")
        .turn_hooks
        .first()
        .expect("a turn hook")
        .code
        .clone()
}

/// Read a specific hook's JS from a package manifest WITHOUT going through
/// `BUILTIN_MANIFESTS`. Lets a plugin be tested while staying UN-registered as
/// a builtin (so e.g. the tool-firewall never makes the hot tool-dispatch path
/// pay a lookup on installs that didn't opt in). Picks the hook by `hook_id`.
///
/// Reads `plugins-store/{plugins,lsp,external_plugins}/<plugin>/manifest.json` — the single source of truth.
/// There is no longer a `plugin_manifest/fixtures/<plugin>.manifest.json` copy to
/// read: Core `include_str!`s the package manifests directly. Anchored at
/// `CARGO_MANIFEST_DIR` rather than the CWD so the path does not depend on where
/// the test runner was invoked from.
///
/// The hook body lives in `hooks/<name>.js` next to the manifest, so this
/// hydrates from the package directory — the same resolution the loader performs
/// for any on-disk plugin. A bare `serde_json::from_str` here would yield an
/// empty `code` and the test would silently assert against nothing.
pub(super) fn fixture_hook_from_file(plugin: &str, hook_id: &str) -> String {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../generated/ryu-runtime/plugins-store/plugins")
        .join(plugin);
    let path = dir.join("manifest.json");
    let display = path.display().to_string();
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {display}: {e}"));
    let mut manifest: crate::plugin_manifest::PluginManifest =
        serde_json::from_str(&raw).unwrap_or_else(|e| panic!("parse {display}: {e}"));
    crate::plugin_manifest::hydrate_manifest_code_files(&mut manifest, Some(&dir))
        .unwrap_or_else(|e| panic!("hydrate {display}: {e}"));
    manifest
        .contributes
        .expect("contributes")
        .turn_hooks
        .into_iter()
        .find(|h| h.id == hook_id)
        .unwrap_or_else(|| panic!("hook {hook_id} in {plugin}"))
        .code
}

/// Run raw hook `code` in the real sandbox with the canned [`TestBridge`].
pub(super) async fn run_code(
    code: &str,
    ctx: HookContext,
    side_value: serde_json::Value,
) -> HookDirective {
    let program = build_hook_program(&ctx, code);
    let bridge = std::sync::Arc::new(TestBridge {
        side_value,
        store: std::sync::Mutex::new(std::collections::HashMap::new()),
    });
    let invoker = std::sync::Arc::new(SandboxToolInvoker::bridge(bridge));
    match tool_exec::run_sandboxed(program, invoker, "ryu").await {
        ExecOutcome::Completed {
            result,
            is_error,
            error,
            ..
        } => {
            assert!(!is_error, "hook errored: {error:?}");
            parse_directive(result.as_ref())
        }
        ExecOutcome::Paused { .. } => panic!("unexpected pause"),
    }
}

async fn run_middleware_code(code: &str, ctx: HookContext) -> HookDirective {
    let program = build_middleware_hook_program(&ctx, code);
    let bridge = std::sync::Arc::new(TestBridge {
        side_value: serde_json::Value::Null,
        store: std::sync::Mutex::new(std::collections::HashMap::new()),
    });
    let invoker = std::sync::Arc::new(SandboxToolInvoker::bridge(bridge));
    match tool_exec::run_sandboxed(program, invoker, "ryu").await {
        ExecOutcome::Completed {
            result,
            is_error,
            error,
            ..
        } => {
            assert!(!is_error, "middleware hook errored: {error:?}");
            parse_directive(result.as_ref())
        }
        ExecOutcome::Paused { .. } => panic!("unexpected pause"),
    }
}

pub(super) async fn run_fixture(
    plugin_id: &str,
    ctx: HookContext,
    side_value: serde_json::Value,
) -> HookDirective {
    run_code(&fixture_hook(plugin_id), ctx, side_value).await
}

#[tokio::test]
async fn live_double_check_fixture_returns_note() {
    if !tool_exec::is_available() {
        eprintln!("skipping live sandbox test: the JS sandbox is unavailable");
        return;
    }
    let ctx = HookContext {
        conversation_id: Some("c1".into()),
        agent_id: Some("ryu".into()),
        transcript: vec![
            HookMessage {
                role: "user".into(),
                content: "What is 2+2?".into(),
            },
            HookMessage {
                role: "assistant".into(),
                content: "5".into(),
            },
        ],
        flags: std::iter::once(("io.ryu.double-check".to_string(), true)).collect(),
        ..Default::default()
    };
    let directive = run_fixture(
        "@ryu/double-check",
        ctx,
        serde_json::json!("Wrong: 2+2 is 4."),
    )
    .await;
    assert_eq!(
        directive,
        HookDirective::Note {
            text: "Wrong: 2+2 is 4.".into()
        }
    );
}

#[tokio::test]
async fn live_function_hook_can_inspect_the_downstream_directive() {
    if !tool_exec::is_available() {
        eprintln!("skipping live sandbox test: the JS sandbox is unavailable");
        return;
    }
    let directive = run_middleware_code(
        "const result = await next({ ...ctx, event: { forwarded: true } });\nreturn { kind: 'note', text: result.text + ':wrapped' };",
        HookContext::default(),
    )
    .await;
    assert_eq!(
        directive,
        HookDirective::Note {
            text: "downstream:wrapped".into()
        }
    );
}

#[tokio::test]
async fn live_double_check_off_flag_is_none() {
    if !tool_exec::is_available() {
        return;
    }
    // Flag absent → the shipped hook must short-circuit to None (no review).
    let ctx = HookContext {
        conversation_id: Some("c1".into()),
        transcript: vec![HookMessage {
            role: "assistant".into(),
            content: "hi".into(),
        }],
        ..Default::default()
    };
    let directive = run_fixture("@ryu/double-check", ctx, serde_json::json!("unused")).await;
    assert_eq!(directive, HookDirective::None);
}

#[tokio::test]
async fn live_goal_fixture_set_command_continues() {
    if !tool_exec::is_available() {
        return;
    }
    // A `/goal <cond>` user message must set the goal and return a continue.
    let ctx = HookContext {
        conversation_id: Some("c1".into()),
        transcript: vec![HookMessage {
            role: "user".into(),
            content: "/goal write a haiku".into(),
        }],
        ..Default::default()
    };
    let directive = run_fixture("@ryu/goal", ctx, serde_json::Value::Null).await;
    assert_eq!(
        directive,
        HookDirective::Continue {
            text: "Begin working toward this goal: write a haiku".into()
        }
    );
}

#[tokio::test]
async fn live_proof_fixture_set_command_continues() {
    if !tool_exec::is_available() {
        return;
    }
    // A `/proof <cond>` user message must set the goal and kick off work,
    // exactly like `/goal` — the difference is what the *later* rounds do
    // (spawn a verifier agent), which the bridge covers.
    let ctx = HookContext {
        conversation_id: Some("c1".into()),
        transcript: vec![HookMessage {
            role: "user".into(),
            content: "/proof the build passes".into(),
        }],
        ..Default::default()
    };
    let directive = run_fixture("@ryu/proof", ctx, serde_json::Value::Null).await;
    assert_eq!(
        directive,
        HookDirective::Continue {
            text: "Begin working toward this goal: the build passes".into()
        }
    );
}

#[tokio::test]
async fn live_proof_fixture_clear_command_notes() {
    if !tool_exec::is_available() {
        return;
    }
    // `/proof clear` must stop the loop and surface a note, never continue.
    let ctx = HookContext {
        conversation_id: Some("c1".into()),
        transcript: vec![HookMessage {
            role: "user".into(),
            content: "/proof clear".into(),
        }],
        ..Default::default()
    };
    let directive = run_fixture("@ryu/proof", ctx, serde_json::Value::Null).await;
    assert_eq!(
        directive,
        HookDirective::Note {
            text: "Proof goal cleared.".into()
        }
    );
}

#[tokio::test]
async fn live_advisor_fixture_toggled_returns_note() {
    if !tool_exec::is_available() {
        return;
    }
    // With the composer toggle on, the advisor consults the stronger model on
    // the full conversation and surfaces its advice as an out-of-band note.
    let ctx = HookContext {
        conversation_id: Some("c1".into()),
        agent_id: Some("ryu".into()),
        transcript: vec![
            HookMessage {
                role: "user".into(),
                content: "How should I store sessions?".into(),
            },
            HookMessage {
                role: "assistant".into(),
                content: "Put them in a global variable.".into(),
            },
        ],
        flags: std::iter::once(("@ryu/advisor".to_string(), true)).collect(),
        ..Default::default()
    };
    let directive = run_fixture(
        "@ryu/advisor",
        ctx,
        serde_json::json!("A global is not request-safe; use a signed cookie or a store."),
    )
    .await;
    assert_eq!(
        directive,
        HookDirective::Note {
            text: "Advisor: A global is not request-safe; use a signed cookie or a store.".into()
        }
    );
}
