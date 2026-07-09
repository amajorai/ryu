//! The plugin turn-hook runtime.
//!
//! This is the code-execution layer that makes features like double-check and
//! goal **real installable plugins** rather than hardcoded Core endpoints. A
//! plugin declares a `post_assistant_turn` hook (`contributes.turn_hooks` in its
//! `plugin.json`); the hook is plugin-authored JS run in the **same deny-by-default
//! Deno sandbox** the PTC tool-exec uses ([`crate::tool_exec`]). The hook reaches
//! Core only through capability-gated host functions:
//!
//! - `host.sideModel({ prompt, system?, model?, model_pref_key?, effort? })` →
//!   one non-streaming gateway completion (grant `hook:side-model`). The model is
//!   resolved swappably (explicit → pref key → env → local default), never
//!   hardcoded; the call is gateway-governed inside `call_side_model`.
//! - `host.runAgent({ task, agent_id?, preset?, wall_time_secs?, max_tokens? })` →
//!   spawn ONE full sub-agent with a clean context and return its final text
//!   (grant `hook:run-agent`). Routes through the delegation engine
//!   ([`crate::workflow::delegation`]): with a live agent runner the sub-agent runs
//!   the real chat path (its own engine, tools, MCP, Gateway routing), so it can
//!   gather actual evidence instead of judging from the transcript. This is the
//!   "proof of work" primitive that the `io.ryu.proof` plugin builds on.
//! - `host.storage.{get,set,delete,keys}(key, value?)` → the plugin's own
//!   namespaced KV ([`crate::plugin_storage`]), grant `storage:kv`.
//! - `host.log(...)` → captured logs.
//!
//! The hook returns a **directive** the chat path applies:
//! `{kind:"none"}` | `{kind:"note", text}` (surface to the user, not in history)
//! | `{kind:"continue", text}` (inject a follow-up user turn and loop).
//!
//! Placement (Core vs Gateway): a turn hook decides *what runs next* → Core. Any
//! model call it makes still routes through the Gateway. The sandbox grants
//! capabilities; the Gateway governs every model call.
//!
//! Availability: the sandbox needs the Deno binary on PATH. When it is absent the
//! runtime no-ops (logged), so chat is never blocked — same graceful-degrade
//! posture as the Python `external_runtime` plugins.

mod bridge;

pub use bridge::PluginHookBridge;

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;

use crate::server::ServerState;
use crate::tool_exec::{self, ExecOutcome, SandboxToolInvoker};

/// One message in the turn context handed to a hook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookMessage {
    pub role: String,
    pub content: String,
}

/// The context a `post_assistant_turn` hook receives (serialized to the sandbox
/// global `ctx`).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HookContext {
    /// The conversation id (also the natural storage key for per-conversation
    /// plugin state, e.g. the goal plugin keys its condition by this).
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// The agent that produced the turn.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Recent transcript (oldest → newest), so a hook can review the last answer.
    #[serde(default)]
    pub transcript: Vec<HookMessage>,
    /// Per-request plugin flags set by the client (e.g. a composer toggle):
    /// `{ "io.ryu.double-check": true }`. A hook reads its own flag to decide
    /// whether to act this turn.
    #[serde(default)]
    pub flags: std::collections::HashMap<String, bool>,
}

/// What a hook asks the chat path to do after the assistant turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HookDirective {
    /// Do nothing.
    None,
    /// Surface `text` to the user out-of-band (not added to chat history).
    Note { text: String },
    /// Inject `text` as a follow-up user turn and run another assistant turn
    /// (the goal-loop primitive). Capped server-side by the chat path.
    Continue { text: String },
}

impl Default for HookDirective {
    fn default() -> Self {
        HookDirective::None
    }
}

/// A single enabled hook resolved from a plugin manifest.
#[derive(Debug, Clone)]
pub struct HookPlugin {
    /// The owning plugin id (also the storage namespace owner).
    pub plugin_id: String,
    /// Hook contribution id (for logging).
    pub hook_id: String,
    /// The turn boundary this fires on (today `"post_assistant_turn"`).
    pub on: String,
    /// The JS hook body.
    pub code: String,
    /// The capabilities the plugin was granted (its manifest `permission_grants`).
    pub grants: HashSet<String>,
    /// Optional cheap pre-gate (from the manifest). Evaluated in Rust before the
    /// sandbox spawn so an idle hook never pays for a Deno process.
    pub run_when: Option<crate::plugin_manifest::HookMatch>,
}

/// The turn boundary string for the post-assistant-turn hook.
pub const ON_POST_ASSISTANT_TURN: &str = "post_assistant_turn";

/// A hard cap on how many `continue` directives a single chat request may apply
/// (the server-side analog of the old client `MAX_GOAL_TURNS`). The chat path
/// enforces this; exported here so the cap lives in one place.
pub const MAX_CONTINUE_TURNS: u32 = 25;

/// Collect every hook from currently **enabled** plugins. Read live (cheap, once
/// per assistant turn) so an enable/disable takes effect immediately without a
/// refresh dance. Returns an empty vec when no plugins contribute hooks.
pub async fn collect_enabled_hooks(state: &ServerState) -> Vec<HookPlugin> {
    let enabled_ids: HashSet<String> = match state.app_store.list().await {
        Ok(records) => records
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| r.id)
            .collect(),
        Err(e) => {
            tracing::warn!("plugin_host: could not list plugins: {e}");
            return Vec::new();
        }
    };
    if enabled_ids.is_empty() {
        return Vec::new();
    }

    // Read from the already-loaded, hot-updated manifest set (no disk re-read).
    let manifests = state.app_manifests.read().await;
    let mut hooks = Vec::new();
    for manifest in manifests.iter() {
        if !enabled_ids.contains(&manifest.id) {
            continue;
        }
        let Some(contributes) = &manifest.contributes else {
            continue;
        };
        if contributes.turn_hooks.is_empty() {
            continue;
        }
        let grants: HashSet<String> = manifest.permission_grants.iter().cloned().collect();
        for hook in &contributes.turn_hooks {
            hooks.push(HookPlugin {
                plugin_id: manifest.id.clone(),
                hook_id: hook.id.clone(),
                on: hook.on.clone(),
                code: hook.code.clone(),
                grants: grants.clone(),
                run_when: hook.run_when.clone(),
            });
        }
    }
    hooks
}

/// Run every enabled `post_assistant_turn` hook against `ctx` and collect their
/// non-`None` directives (in plugin order). Fail-open: a hook that errors or
/// times out is skipped, never blocking the turn.
pub async fn dispatch_turn_hooks(state: &ServerState, ctx: &HookContext) -> Vec<HookDirective> {
    if !tool_exec::is_available() {
        tracing::debug!("plugin_host: code-exec backend unavailable; skipping turn hooks");
        return Vec::new();
    }
    let hooks = collect_enabled_hooks(state).await;
    run_hooks(state, ctx, &hooks).await
}

/// Run a pre-collected set of hooks against `ctx`. Lets the chat-path wrapper
/// collect hooks once (cheap gate) and reuse the set across a continue loop.
pub async fn run_hooks(
    state: &ServerState,
    ctx: &HookContext,
    hooks: &[HookPlugin],
) -> Vec<HookDirective> {
    let mut directives = Vec::new();
    for hook in hooks {
        if hook.on != ON_POST_ASSISTANT_TURN {
            continue;
        }
        // Cheap pre-gate: skip the sandbox spawn when the hook provably can't act
        // this turn. This is what makes default-on hooks free on the hot path.
        if !hook_should_run(state, hook, ctx).await {
            continue;
        }
        let directive = run_hook(state, hook, ctx).await;
        if !matches!(directive, HookDirective::None) {
            directives.push(directive);
        }
    }
    directives
}

/// Evaluate a hook's declarative `match` gate in Rust, before any sandbox spawn.
/// No `match` (or an all-empty one) → always run. Otherwise the present
/// conditions are OR-ed: a matching composer flag, a matching slash-command
/// prefix on the last user turn, or existing per-conversation plugin state each
/// wake the hook. Fail-open: any lookup error resolves to "run" so a gate glitch
/// never silently disables a feature.
async fn hook_should_run(state: &ServerState, hook: &HookPlugin, ctx: &HookContext) -> bool {
    let Some(m) = &hook.run_when else {
        return true;
    };
    // Decide everything that does not need a storage read first (pure + tested).
    match gate_without_storage(m, ctx) {
        GateVerdict::Run => true,
        GateVerdict::Skip => false,
        GateVerdict::CheckStateful => {
            let Some(conv) = ctx.conversation_id.as_deref().filter(|c| !c.is_empty()) else {
                return false;
            };
            let Some(store) = crate::plugin_storage::global() else {
                return false;
            };
            match store.get(&hook.plugin_id, "default", conv).await {
                Ok(Some(_)) => true,
                Ok(None) => false,
                // Fail-open on a storage error: run rather than silently drop.
                Err(_) => true,
            }
        }
    }
}

/// The pure (storage-free) part of the gate. Separated so the flag/command logic
/// is unit-testable without a [`ServerState`].
#[derive(Debug, PartialEq)]
enum GateVerdict {
    /// A flag/command condition matched (or no condition was declared): run now.
    Run,
    /// Conditions were declared, none matched, and no stateful check applies: skip.
    Skip,
    /// Nothing matched yet but the hook is stateful — the caller must read the KV.
    CheckStateful,
}

fn gate_without_storage(m: &crate::plugin_manifest::HookMatch, ctx: &HookContext) -> GateVerdict {
    let mut declared = false;

    if let Some(flag) = m.flag.as_deref().filter(|f| !f.is_empty()) {
        declared = true;
        if ctx.flags.get(flag).copied().unwrap_or(false) {
            return GateVerdict::Run;
        }
    }

    if !m.commands.is_empty() {
        declared = true;
        if let Some(last_user) = ctx.transcript.iter().rev().find(|msg| msg.role == "user") {
            let text = last_user.content.trim();
            if m.commands.iter().any(|c| text.starts_with(c.as_str())) {
                return GateVerdict::Run;
            }
        }
    }

    if m.stateful {
        return GateVerdict::CheckStateful;
    }

    // A match block with no recognised condition means "always run".
    if declared {
        GateVerdict::Skip
    } else {
        GateVerdict::Run
    }
}

/// Run one hook in the sandbox and parse its directive. Any failure (Deno
/// missing, hook threw, unparseable result, a Pause we don't support) degrades to
/// [`HookDirective::None`].
pub async fn run_hook(state: &ServerState, hook: &HookPlugin, ctx: &HookContext) -> HookDirective {
    let program = build_hook_program(ctx, &hook.code);
    let bridge = Arc::new(PluginHookBridge::new(
        hook.plugin_id.clone(),
        hook.grants.clone(),
        state.clone(),
    ));
    let invoker = Arc::new(SandboxToolInvoker::bridge(bridge));
    let agent_id = ctx
        .agent_id
        .clone()
        .unwrap_or_else(|| "plugin-host".to_string());

    match tool_exec::run_sandboxed(program, invoker, &agent_id).await {
        ExecOutcome::Completed {
            result,
            is_error,
            error,
            ..
        } => {
            if is_error {
                tracing::warn!(
                    "plugin_host: hook {}::{} errored: {}",
                    hook.plugin_id,
                    hook.hook_id,
                    error.unwrap_or_default()
                );
                return HookDirective::None;
            }
            parse_directive(result.as_ref())
        }
        ExecOutcome::Paused { .. } => {
            tracing::warn!(
                "plugin_host: hook {}::{} paused (unsupported for hooks); ignoring",
                hook.plugin_id,
                hook.hook_id
            );
            HookDirective::None
        }
    }
}

/// Parse the hook's returned value into a directive. A missing/`null`/unparseable
/// value (or an explicit `{kind:"none"}`) → [`HookDirective::None`].
fn parse_directive(value: Option<&serde_json::Value>) -> HookDirective {
    let Some(v) = value else {
        return HookDirective::None;
    };
    serde_json::from_value::<HookDirective>(v.clone()).unwrap_or(HookDirective::None)
}

/// Build the sandbox program: inject `ctx` + define the `host` capability facade
/// over the sandbox `tools` proxy, then the plugin's hook body (which `return`s a
/// directive). The body runs inside the substrate's async IIFE, so a bare
/// `return` reports the directive as the program's final value.
fn build_hook_program(ctx: &HookContext, entry_code: &str) -> String {
    let ctx_json = serde_json::to_string(ctx).unwrap_or_else(|_| "{}".to_string());
    format!(
        r#"const ctx = {ctx};
const host = {{
  sideModel: (a) => tools.host.sideModel(a ?? {{}}),
  runAgent: (a) => tools.host.runAgent(a ?? {{}}),
  storage: {{
    get: (k, ns) => tools.host.storage_get({{ key: String(k), namespace: ns }}),
    set: (k, v, ns) => tools.host.storage_set({{ key: String(k), value: typeof v === "string" ? v : JSON.stringify(v), namespace: ns }}),
    delete: (k, ns) => tools.host.storage_delete({{ key: String(k), namespace: ns }}),
    keys: (ns) => tools.host.storage_keys({{ namespace: ns }}),
  }},
  log: (...a) => console.log(...a),
}};
{entry}
"#,
        ctx = ctx_json,
        entry = entry_code,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_directive_handles_each_variant() {
        assert_eq!(parse_directive(None), HookDirective::None);
        assert_eq!(
            parse_directive(Some(&json!({ "kind": "none" }))),
            HookDirective::None
        );
        assert_eq!(
            parse_directive(Some(&json!({ "kind": "note", "text": "looks good" }))),
            HookDirective::Note {
                text: "looks good".into()
            }
        );
        assert_eq!(
            parse_directive(Some(&json!({ "kind": "continue", "text": "keep going" }))),
            HookDirective::Continue {
                text: "keep going".into()
            }
        );
        // Garbage / unknown shape → None (fail-safe, never loops on noise).
        assert_eq!(
            parse_directive(Some(&json!({ "kind": "explode" }))),
            HookDirective::None
        );
        assert_eq!(
            parse_directive(Some(&json!("nonsense"))),
            HookDirective::None
        );
    }

    #[test]
    fn build_program_injects_ctx_and_host_facade() {
        let ctx = HookContext {
            conversation_id: Some("conv-1".into()),
            agent_id: Some("ryu".into()),
            transcript: vec![HookMessage {
                role: "assistant".into(),
                content: "hi".into(),
            }],
            ..Default::default()
        };
        let program = build_hook_program(&ctx, "return { kind: 'note', text: 'x' };");
        assert!(program.contains("const ctx = "));
        assert!(program.contains("conv-1"));
        assert!(program.contains("host.sideModel") || program.contains("sideModel:"));
        assert!(program.contains("tools.host.sideModel"));
        assert!(program.contains("return { kind: 'note', text: 'x' };"));
    }

    #[test]
    fn directive_default_is_none() {
        assert_eq!(HookDirective::default(), HookDirective::None);
    }

    // ── Cheap pre-gate (`match`) ──────────────────────────────────────────────

    use crate::plugin_manifest::HookMatch;

    fn ctx_with(user: Option<&str>, flags: &[(&str, bool)]) -> HookContext {
        let mut transcript = Vec::new();
        if let Some(u) = user {
            transcript.push(HookMessage {
                role: "user".into(),
                content: u.into(),
            });
        }
        transcript.push(HookMessage {
            role: "assistant".into(),
            content: "…".into(),
        });
        HookContext {
            conversation_id: Some("c1".into()),
            transcript,
            flags: flags.iter().map(|(k, v)| (k.to_string(), *v)).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn gate_flag_on_runs_off_skips() {
        let m = HookMatch {
            flag: Some("io.ryu.double-check".into()),
            ..Default::default()
        };
        assert_eq!(
            gate_without_storage(&m, &ctx_with(None, &[("io.ryu.double-check", true)])),
            GateVerdict::Run
        );
        // Off / absent flag → skip (double-check must not spawn Deno every turn).
        assert_eq!(
            gate_without_storage(&m, &ctx_with(None, &[("io.ryu.double-check", false)])),
            GateVerdict::Skip
        );
        assert_eq!(
            gate_without_storage(&m, &ctx_with(None, &[])),
            GateVerdict::Skip
        );
    }

    #[test]
    fn gate_command_prefix_matches_last_user_turn() {
        let m = HookMatch {
            commands: vec!["/goal".into()],
            stateful: true,
            ..Default::default()
        };
        // `/goal write tests` → the command wakes it immediately.
        assert_eq!(
            gate_without_storage(&m, &ctx_with(Some("/goal write tests"), &[])),
            GateVerdict::Run
        );
        // `/goal clear` also starts with `/goal`.
        assert_eq!(
            gate_without_storage(&m, &ctx_with(Some("/goal clear"), &[])),
            GateVerdict::Run
        );
        // No command this turn but the hook is stateful → defer to the KV read.
        assert_eq!(
            gate_without_storage(&m, &ctx_with(Some("hello"), &[])),
            GateVerdict::CheckStateful
        );
    }

    #[test]
    fn gate_command_does_not_match_unrelated_slash() {
        let m = HookMatch {
            commands: vec!["/goal".into()],
            ..Default::default()
        };
        // `/proof …` is a different plugin's command; goal must not wake for it,
        // and with no stateful flag that means Skip.
        assert_eq!(
            gate_without_storage(&m, &ctx_with(Some("/proof the build passes"), &[])),
            GateVerdict::Skip
        );
    }

    #[test]
    fn gate_empty_or_absent_always_runs() {
        // An empty match block is "always run" (backward compatible).
        assert_eq!(
            gate_without_storage(&HookMatch::default(), &ctx_with(None, &[])),
            GateVerdict::Run
        );
    }

    // ── Live sandbox tests (run only when the Deno binary is on PATH) ──────────
    //
    // These execute the ACTUAL shipped fixture hook JS in the real deny-by-default
    // Deno sandbox, with a test bridge standing in for the host capabilities. They
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

    async fn run_fixture(
        plugin_id: &str,
        ctx: HookContext,
        side_value: serde_json::Value,
    ) -> HookDirective {
        let code = fixture_hook(plugin_id);
        let program = build_hook_program(&ctx, &code);
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

    #[tokio::test]
    async fn live_double_check_fixture_returns_note() {
        if !tool_exec::is_available() {
            eprintln!("skipping live deno test: deno not on PATH");
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
        };
        let directive = run_fixture(
            "io.ryu.double-check",
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
        let directive = run_fixture("io.ryu.double-check", ctx, serde_json::json!("unused")).await;
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
        let directive = run_fixture("io.ryu.goal", ctx, serde_json::Value::Null).await;
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
        let directive = run_fixture("io.ryu.proof", ctx, serde_json::Value::Null).await;
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
        let directive = run_fixture("io.ryu.proof", ctx, serde_json::Value::Null).await;
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
            flags: std::iter::once(("com.ryuhq.advisor".to_string(), true)).collect(),
        };
        let directive = run_fixture(
            "com.ryuhq.advisor",
            ctx,
            serde_json::json!("A global is not request-safe; use a signed cookie or a store."),
        )
        .await;
        assert_eq!(
            directive,
            HookDirective::Note {
                text: "Advisor: A global is not request-safe; use a signed cookie or a store."
                    .into()
            }
        );
    }

    #[tokio::test]
    async fn live_security_guidance_flags_pattern_and_review() {
        if !tool_exec::is_available() {
            return;
        }
        // Toggle on + the last answer contains an unsafe pattern (yaml.load) →
        // the hook must return a note combining the pattern warning and the
        // side-model review text.
        let ctx = HookContext {
            conversation_id: Some("c1".into()),
            agent_id: Some("ryu".into()),
            transcript: vec![
                HookMessage {
                    role: "user".into(),
                    content: "load the config".into(),
                },
                HookMessage {
                    role: "assistant".into(),
                    content: "cfg = yaml.load(open('c.yml'))".into(),
                },
            ],
            flags: std::iter::once(("io.ryu.security-guidance".to_string(), true)).collect(),
        };
        let directive = run_fixture(
            "io.ryu.security-guidance",
            ctx,
            serde_json::json!("Use yaml.safe_load; yaml.load allows arbitrary code execution."),
        )
        .await;
        match directive {
            HookDirective::Note { text } => {
                assert!(text.contains("Pattern warnings"), "note: {text}");
                assert!(text.contains("yaml.safe_load"), "note: {text}");
            }
            other => panic!("expected a security note, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn live_security_guidance_off_is_none() {
        if !tool_exec::is_available() {
            return;
        }
        // No toggle and no `/security` command → the hook short-circuits to None.
        let ctx = HookContext {
            conversation_id: Some("c1".into()),
            transcript: vec![HookMessage {
                role: "assistant".into(),
                content: "cfg = yaml.load(f)".into(),
            }],
            ..Default::default()
        };
        let directive =
            run_fixture("io.ryu.security-guidance", ctx, serde_json::json!("unused")).await;
        assert_eq!(directive, HookDirective::None);
    }

    #[tokio::test]
    async fn live_advisor_off_is_none() {
        if !tool_exec::is_available() {
            return;
        }
        // No toggle and no `/advisor` command → the hook must short-circuit.
        let ctx = HookContext {
            conversation_id: Some("c1".into()),
            transcript: vec![HookMessage {
                role: "assistant".into(),
                content: "hi".into(),
            }],
            ..Default::default()
        };
        let directive = run_fixture("com.ryuhq.advisor", ctx, serde_json::json!("unused")).await;
        assert_eq!(directive, HookDirective::None);
    }

    #[tokio::test]
    async fn live_advisor_slash_command_continues() {
        if !tool_exec::is_available() {
            return;
        }
        // A `/advisor` message consults the advisor and injects its advice as a
        // follow-up turn so the assistant acts on it.
        let ctx = HookContext {
            conversation_id: Some("c1".into()),
            transcript: vec![HookMessage {
                role: "user".into(),
                content: "/advisor is this the right approach?".into(),
            }],
            ..Default::default()
        };
        let directive = run_fixture(
            "com.ryuhq.advisor",
            ctx,
            serde_json::json!("Reconsider the data model first."),
        )
        .await;
        assert_eq!(
            directive,
            HookDirective::Continue {
                text: "An expert advisor reviewed the whole conversation and gave this advice. \
                       Give it serious weight and act on it in your next response:\n\nReconsider \
                       the data model first."
                    .into()
            }
        );
    }
}
