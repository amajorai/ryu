//! The plugin turn-hook runtime.
//!
//! This is the code-execution layer that makes features like double-check and
//! goal **real installable plugins** rather than hardcoded Core endpoints. A
//! plugin declares a `post_assistant_turn` hook (`contributes.turn_hooks` in its
//! `manifest.json`); the hook is plugin-authored JS run in the **same deny-by-default
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
//!   "proof of work" primitive that the `proof` plugin builds on.
//! - `host.storage.{get,set,delete,keys,compareAndSet}(key, value?)` → the plugin's own
//!   namespaced KV ([`crate::plugin_storage`]), grant `storage:kv`.
//! - `host.spaces.{ensureSpace,createDoc,getDoc,updateDoc,listDocs,deleteDoc}` →
//!   the plugin's OWN Space documents (`kind = app:<plugin id>`, so it can never
//!   read or write a page/database/whiteboard or another app's doc), grant
//!   `spaces:docs`. `ensureSpace({name})` is what makes the rest reachable from a
//!   hook at all: every other method needs a `space_id`, ids are uuids, and a
//!   headless caller has no route parameter to read one from. Writes go through
//!   the ordinary document path, so a hook's ledger is flattened, re-embedded and
//!   retrievable like anything else in the Space.
//! - `host.log(...)` → captured logs.
//!
//! The hook returns a **directive** the chat path applies:
//! `{kind:"none"}` | `{kind:"note", text}` (surface to the user, not in history)
//! | `{kind:"continue", text}` (inject a follow-up user turn and loop) |
//! `{kind:"replace", text}` (a `pre_user_turn` hook rewrites the outgoing user
//! message before it reaches the model — the auto-expand prompt-improver).
//!
//! Placement (Core vs Gateway): a turn hook decides *what runs next* → Core. Any
//! model call it makes still routes through the Gateway. The sandbox grants
//! capabilities; the Gateway governs every model call.
//!
//! Availability: the sandbox needs the Deno binary on PATH. When it is absent the
//! runtime no-ops (logged), so chat is never blocked — same graceful-degrade
//! posture as the Python `external_runtime` plugins.

pub mod action_stream;
mod bridge;

pub use action_stream::ActionFrameProbe;
pub use bridge::{dispatch_path_for, PluginHookBridge};

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

/// A normalized action observed in the shared assistant stream.
///
/// Action hooks receive one of these for thinking/reasoning and tool-call
/// boundaries, so a plugin can describe what the model is doing without
/// coupling itself to a provider-specific stream format.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HookAction {
    pub id: String,
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Value>,
    pub status: String,
    pub sequence: u64,
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
    /// Verified user principal for this turn, when the request came from an
    /// authenticated interactive caller. Plugins use it only for tenant-scoped
    /// storage and notifications; it is never model-supplied.
    #[serde(default)]
    pub caller_user_id: Option<String>,
    /// Recent transcript (oldest → newest), so a hook can review the last answer.
    #[serde(default)]
    pub transcript: Vec<HookMessage>,
    /// Per-request plugin flags set by the client (e.g. a composer toggle):
    /// `{ "io.ryu.double-check": true }`. A hook reads its own flag to decide
    /// whether to act this turn.
    #[serde(default)]
    pub flags: std::collections::HashMap<String, bool>,
    /// The pending outgoing user message, set only for a `pre_user_turn` hook (it
    /// has not been sent to the model or persisted yet). A pre-turn hook reads
    /// `ctx.input` and may return a [`HookDirective::Replace`] to rewrite it (e.g.
    /// the auto-expand prompt-improver). `None` for `post_assistant_turn` hooks,
    /// which read the already-persisted `transcript` instead.
    #[serde(default)]
    pub input: Option<String>,
    /// The normalized streamed action for an [`ON_ACTION`] hook. This is
    /// intentionally separate from `tool_name`/`tool_input`: action hooks also
    /// observe thinking boundaries and may run before a tool result exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<HookAction>,
    /// The tool being called — set for `pre_tool_use` / `post_tool_use` hooks.
    /// `tool_name` is the fully-qualified tool id, `tool_input` its arguments, and
    /// `tool_output` the result (only on `post_tool_use`). A tool hook reads these
    /// to decide whether to allow ([`HookDirective::None`]) or block
    /// ([`HookDirective::Deny`]) the call, or to annotate the result.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_output: Option<serde_json::Value>,
    /// The final text output of a finished sub-agent — set for `subagent_stop`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    /// A free-form event payload for observation phases (`notification`,
    /// `session_end`, `subagent_stop`, `model_select`, `session_tree`) — e.g. the
    /// alert being fanned out, or `{model, thinking_level, source}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<serde_json::Value>,
    /// The full outbound message array — set only for [`ON_CONTEXT`] on the
    /// message-array plane (OpenAI-compat / local engine / SDK app), where a hook
    /// may return [`HookDirective::Rewrite`] to replace it wholesale.
    ///
    /// Raw provider-shaped JSON, not [`HookMessage`]: it carries multimodal parts
    /// and tool rows that a `{role, content}` struct cannot represent. `None` on
    /// the ACP plane, which has no array — there the flattened prompt is in
    /// [`Self::input`] instead. A `context` hook branches on which one is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<serde_json::Value>>,
    /// The exact project-instructions block Core assembled for this turn. This is
    /// populated only for [`ON_CONTEXT`] so a context plugin can mirror or remove
    /// the AGENTS.md injection without parsing the surrounding system prompt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_instructions: Option<String>,
    /// Normalized project rule records discovered for the active working folder.
    /// Core supplies file metadata/content; a context plugin decides which records
    /// apply and whether to inject them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_rules: Option<Vec<serde_json::Value>>,
    /// The turns about to be dropped by compaction, and the summary that replaced
    /// them — set for [`ON_SESSION_BEFORE_COMPACT`] and [`ON_SESSION_COMPACT`]
    /// respectively. A `session_compact` hook may rewrite the summary with
    /// [`HookDirective::Replace`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dropped: Option<Vec<HookMessage>>,
}

/// Resolve the storage namespace used by both sandbox bridges and Core-owned
/// projections of plugin state. An authenticated caller gets a private tenant
/// prefix; an agent-less flow with no active account keeps the historical
/// node-wide namespace. The active local account is the fallback when the request
/// transport cannot carry a verified user JWT (for example the desktop's local
/// node bearer).
pub(crate) fn storage_namespace_for_tenant(tenant: Option<&str>, namespace: &str) -> String {
    let active_user_id = crate::auth::load_accounts().active_user_id;
    let tenant = tenant
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| active_user_id.as_deref());
    match tenant {
        Some(user_id) => format!("tenant:{user_id}:{namespace}"),
        None => namespace.to_owned(),
    }
}

/// What a hook asks the chat path to do after the assistant turn.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HookDirective {
    /// Do nothing.
    None,
    /// Surface `text` to the user out-of-band (not added to chat history).
    Note { text: String },
    /// Surface a first-person tool intent together with its plain-language
    /// summary. Action observers use this to keep the approval question above
    /// the explanation without pretending the observer itself is the gate.
    ToolApproval { question: String, summary: String },
    /// Inject `text` as a follow-up user turn and run another assistant turn
    /// (the goal-loop primitive). Capped server-side by the chat path.
    Continue { text: String },
    /// Replace the pending outgoing user message with `text` **before** it reaches
    /// the model (a `pre_user_turn` directive; ignored on the post-turn path). The
    /// rewritten text is what gets sent and persisted — the auto-expand plugin uses
    /// this to swap a raw prompt for its improved form.
    Replace {
        text: String,
        /// On the ACP `context` phase, discard the pooled session and send the
        /// rewritten full prompt through a fresh session for this turn. The field
        /// defaults false so existing hook payloads retain pooled-session behavior.
        #[serde(default)]
        fresh_session: bool,
    },
    /// Inject `text` as **additional context** into the current turn (additive, not
    /// a replacement) — appended to the outgoing user message so the model sees it.
    /// Emitted by `session_start` (setup context) and `pre_user_turn` (per-message
    /// context), mirroring Claude Code's `UserPromptSubmit`/`SessionStart` context.
    Inject { text: String },
    /// Block the pending tool call (a `pre_tool_use` directive). `reason` is
    /// returned to the model as the tool's error result, so it can adapt instead of
    /// treating the call as done — this is the plugin-authored tool firewall.
    Deny { reason: String },
    /// Replace the tool's result with `output` **before the model sees it** (a
    /// [`ON_TOOL_RESULT`] directive; ignored on every other phase).
    ///
    /// This is the redaction/narrowing primitive: a hook reads `ctx.tool_output`
    /// and returns a rewritten value, so secrets, PII or an oversized payload
    /// never enter the transcript. `Deny` blocks a call from happening;
    /// `Transform` reshapes what a call that already happened reports back.
    ///
    /// `Transform` directives are chained in priority order. Each subsequent
    /// `tool_result` hook receives the latest transformed value, never the raw
    /// result that entered the phase, so a later policy cannot restore an earlier
    /// redaction.
    ///
    /// The downstream detached `post_tool_use` observers DO see the rewritten
    /// output, not the original: the rewrite is a security boundary, so the raw
    /// value must not be handed to every other installed plugin after it.
    Transform { output: serde_json::Value },
    /// Replace the ENTIRE outbound message array before it reaches the model (an
    /// [`ON_CONTEXT`] directive on the message-array plane; ignored elsewhere).
    ///
    /// Carried as raw JSON rather than [`HookMessage`] on purpose: the outbound
    /// array holds multimodal content (`image_url` parts) and tool rows that a
    /// `{role, content}` struct would silently drop, so a hook that rewrote one
    /// message would destroy every image in the window.
    ///
    /// On the ACP plane there is no array to replace — Ryu sends one flattened
    /// prompt string — so a hook targets that plane with [`Replace`] instead.
    /// Returning `Rewrite` on the ACP plane is ignored rather than guessed at.
    ///
    /// [`Replace`]: HookDirective::Replace
    Rewrite { messages: Vec<serde_json::Value> },
    /// Fully handle the user's turn: `text` becomes the assistant reply and **no
    /// model call is made** (an [`ON_PRE_USER_TURN`] directive; ignored elsewhere).
    ///
    /// This is the piece [`Replace`] and [`Inject`] could not express — both still
    /// run the turn, they only reshape the prompt. `Handled` ends it. That is what
    /// makes a plugin able to own a slash command, answer from cache, or refuse a
    /// prompt outright without burning a model call.
    ///
    /// The reply is persisted like any assistant message so a reload is faithful.
    /// First writer wins: once one hook handles a turn, later hooks do not run, so
    /// two plugins cannot both claim the same prompt.
    ///
    /// [`Replace`]: HookDirective::Replace
    /// [`Inject`]: HookDirective::Inject
    Handled { text: String },
    /// Select a different model for the current turn before an ACP session or
    /// gateway request is created. Only honoured during `pre_model_select`; the
    /// first non-empty selection wins, so independently installed policy plugins
    /// cannot silently chain model rewrites.
    SelectModel {
        model: String,
        /// Provider-agnostic reasoning effort carried into the downstream
        /// request contract; this is not merely explanatory metadata.
        #[serde(default)]
        effort: Option<String>,
        /// ACP session config options to apply for this turn. Values are kept as
        /// strings because ACP distinguishes boolean values by their exact
        /// `"true"`/`"false"` spellings at the transport boundary.
        #[serde(default)]
        acp_config: Option<std::collections::HashMap<String, String>>,
        #[serde(default)]
        reason: Option<String>,
    },
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
    /// The turn boundary this fires on (`"post_assistant_turn"` or
    /// `"pre_user_turn"`).
    pub on: String,
    /// Higher-priority hooks run first; ties are deterministic.
    pub priority: i32,
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

/// The turn boundary string for the pre-user-turn hook: fires **before** the user
/// message is sent to the model, so a hook can rewrite the outgoing prompt (via
/// [`HookDirective::Replace`]). This is the prompt-transform phase the auto-expand
/// plugin uses.
pub const ON_PRE_USER_TURN: &str = "pre_user_turn";

/// Fires after the agent binding is resolved but before either model transport is
/// opened. This is the one awaited hook phase allowed to select a per-turn model.
pub const ON_PRE_MODEL_SELECT: &str = "pre_model_select";

/// Fires for normalized thinking and tool-call actions observed in the shared
/// assistant stream. This is an out-of-band observation hook: a directive is
/// never allowed to block or rewrite the model stream.
pub const ON_ACTION: &str = "action";

// ── Claude-Code-style hook phases (the extended set) ─────────────────────────
//
// Each maps to a Claude Code hook event. On-chat-path phases (session_start,
// stop) fire inside `server::run_chat_with_hooks`; off-path phases (pre/post
// tool use, subagent_stop, session_end, notification) fire at their own sites
// through the process-global dispatcher ([`global`]).

/// Fires on the FIRST turn of a conversation (Claude's `SessionStart`). A hook
/// can [`HookDirective::Inject`] setup context or [`HookDirective::Note`].
pub const ON_SESSION_START: &str = "session_start";

/// Alias for [`ON_POST_ASSISTANT_TURN`] (Claude's `Stop`) — accepted so a plugin
/// authored against Claude's naming works unchanged. Normalised by
/// [`phase_matches`].
pub const ON_STOP: &str = "stop";

/// Fires **before** a tool call executes (Claude's `PreToolUse`), at the shared
/// tool-dispatch core. Awaited: a [`HookDirective::Deny`] blocks the call.
pub const ON_PRE_TOOL_USE: &str = "pre_tool_use";

/// Fires **after** a tool call returns (Claude's `PostToolUse`). Observation-only
/// (detached, fail-open) — directives are not applied to the result.
///
/// Deliberately distinct from [`ON_TOOL_RESULT`]: this phase stays detached so an
/// observing plugin (logging, telemetry, the tool-firewall's audit half) costs the
/// hot path exactly nothing. A plugin that needs to *change* the result declares
/// `tool_result` instead and opts into the awaited path.
pub const ON_POST_TOOL_USE: &str = "post_tool_use";

/// Fires **after** a tool call returns, **awaited**, and may rewrite the result
/// before the model sees it via [`HookDirective::Transform`] (Pi's `tool_result`,
/// Eve's `toolResultFrom`).
///
/// Split from [`ON_POST_TOOL_USE`] on purpose. Rewriting requires the tool
/// dispatch to *wait* for the sandbox, so it costs latency; observation does not.
/// Keeping them as two phases means the cost is paid only by sessions that
/// actually installed a rewriting plugin — a plugin declaring only
/// `post_tool_use` keeps its current zero-latency detached behaviour, and the
/// DB-free `any_manifest_declares` gate means a node with no `tool_result` plugin
/// loaded never even looks at the plugin store on the tool hot path.
pub const ON_TOOL_RESULT: &str = "tool_result";

/// Fires when a delegated sub-agent finishes (Claude's `SubagentStop`).
/// Observation-only (detached).
pub const ON_SUBAGENT_STOP: &str = "subagent_stop";

/// Fires when a conversation is deleted (Claude's `SessionEnd`). Observation-only
/// (runs before the delete so the transcript is still readable).
pub const ON_SESSION_END: &str = "session_end";

/// Fires when a notification is fanned out (Claude's `Notification`).
/// Observation-only (detached). Node-level: no chat context.
pub const ON_NOTIFICATION: &str = "notification";

/// Fires for each admitted/departed delegated agent. The event payload is the
/// deliberately narrow `{run_id, agent_id, active_count, transition_id}` carrier
/// emitted by the delegation engine; it contains no work or machine context.
pub const ON_DELEGATION_LIFECYCLE: &str = "delegation_lifecycle";

// ── Pi-parity phases (the message plane) ─────────────────────────────────────
//
// Mirrors of Pi's own extension lifecycle, but implemented as RYU-NATIVE phases
// at Ryu's own dispatch sites — deliberately NOT proxied out of Pi. A proxy would
// only ever fire for Pi-routed turns, silently doing nothing for Claude, Codex,
// or any other ACP agent. Firing them from Core means one plugin governs every
// agent.

/// Fires immediately **before** the assembled context leaves Ryu for the model,
/// and may rewrite it (Pi's `context`). This is the context-engineering phase.
///
/// It spans TWO structurally different planes and a hook must handle both:
///
/// - **OpenAI-compat / local-engine / SDK plane** — Ryu owns a real message array
///   (`oai_messages`). [`HookContext::messages`] is populated and a hook returns
///   [`HookDirective::Rewrite`] to replace the whole array. Multimodal content
///   survives because the array is carried as raw JSON, not as lossy
///   [`HookMessage`]s.
/// - **ACP plane (Claude / Codex / managed Pi)** — there is no array to rewrite.
///   Ryu flattens the whole window into ONE prompt string (`build_acp_prompt`) and
///   sends a single text block, so [`HookContext::input`] carries that string and a
///   hook returns [`HookDirective::Replace`] instead.
///
/// A hook that only understands one plane must check which field is set rather
/// than assume; returning the wrong directive for the plane is ignored.
pub const ON_CONTEXT: &str = "context";

/// Fires when an assistant message is finalized, **before** it is persisted, and
/// may replace its text via [`HookDirective::Replace`] (Pi's `message_end`).
///
/// Distinct from [`ON_POST_ASSISTANT_TURN`], which runs after persistence and can
/// only append a note or continue the loop. A `Replace` here must rewrite the
/// persisted content AND the sealed parts, or a reload would disagree with what
/// the user saw.
pub const ON_MESSAGE_END: &str = "message_end";

/// Fires **before** Ryu drops older turns to fit the context window (Pi's
/// `session_before_compact`). Observation + veto-ish: a hook sees what is about to
/// be dropped.
pub const ON_SESSION_BEFORE_COMPACT: &str = "session_before_compact";

/// Fires **after** the dropped turns have been summarized (Pi's `session_compact`),
/// and may rewrite the summary text via [`HookDirective::Replace`] before it is
/// merged back into the window.
///
/// Note this is RYU's compaction, not Pi's. Pi auto-compacting inside its own turn
/// loop is invisible to Core; these phases fire at Ryu's own `context_window`
/// sites, which cover BOTH the OpenAI-compat plane and the short-term replay Ryu
/// assembles for ACP agents.
pub const ON_SESSION_COMPACT: &str = "session_compact";

/// Fires when the active model or thinking/effort level changes (Pi's
/// `model_select` / `thinking_level_select`). Observation-only — no directive can
/// change a model, so this reports rather than intercepts. The payload rides in
/// [`HookContext::event`].
pub const ON_MODEL_SELECT: &str = "model_select";

/// Fires when the conversation's message tree branches — an edit or regenerate
/// that inserts a sibling and repoints the active leaf (Pi's `session_before_fork`
/// / `session_tree`). Observation-only. Payload rides in [`HookContext::event`].
pub const ON_SESSION_TREE: &str = "session_tree";

// ── Kernel lifecycle phases (Core subsystems, not apps) ──────────────────────
//
// These are the non-chat counterpart to the app events below, and the split is not
// arbitrary. `workflows`, `approvals`, `activity` and `timeline` have an apps-store
// package, but it is a UI shell over a Core subsystem: the workflow executor IS
// `crate::workflow`, in this process, with no sidecar. There is nothing to emit
// FROM, so their lifecycles are Core hook phases fired at Core's own sites.
//
// This is also what keeps the satellite rule intact. A phase named for the host
// primitive (`workflow_run_finished`) names no app, so nothing about it couples Core
// to a package. Had these been app events, Core would have had to emit on some app's
// behalf — i.e. hardcode an app id in the kernel, the exact thing the ext-proxy and
// kernel-capability seams exist to prevent.

/// Fires when a workflow run **starts** — once per run as a user understands it, not
/// once per resume or nested sub-workflow. Observation-only. Payload rides in
/// [`HookContext::event`]: `{run_id, workflow_id, workflow_name}`.
pub const ON_WORKFLOW_RUN_STARTED: &str = "workflow_run_started";

/// Fires when a workflow run **completes successfully**. Observation-only. Payload:
/// `{run_id, workflow_id, workflow_name, status, error, output}`.
///
/// A run suspended at an approval gate does NOT fire this — it has not finished, it
/// is waiting on a human, and will fire when it resumes and terminates.
pub const ON_WORKFLOW_RUN_FINISHED: &str = "workflow_run_finished";

/// Fires when a workflow run **fails**, including a failure to start at all and a
/// run failed by a rejected/expired approval gate. Observation-only. Same payload
/// shape as [`ON_WORKFLOW_RUN_FINISHED`], with `error` populated.
///
/// Split from the success phase rather than folded into it with a status field
/// because "tell me when something breaks" is the overwhelmingly common
/// subscription, and making it a phase means such a hook never spawns a sandbox on a
/// successful run.
pub const ON_WORKFLOW_RUN_FAILED: &str = "workflow_run_failed";

/// Fire a workflow-run lifecycle hook DETACHED, with `payload` in
/// [`HookContext::event`].
///
/// Detached for the same reason [`ON_POST_TOOL_USE`] is: the executor is the hot
/// path for every automation on the node, and a hook must not be able to slow a run
/// down — let alone fail one. Callers are sync-friendly (this spawns rather than
/// awaiting), which is what lets it be called from the executor without
/// restructuring it.
pub fn fire_workflow_run_event(phase: &'static str, payload: serde_json::Value) {
    tokio::spawn(async move {
        let ctx = HookContext {
            event: Some(payload),
            ..Default::default()
        };
        let _ = dispatch_global(phase, ctx).await;
    });
}

// ── App events (plugin-declared phases) ──────────────────────────────────────
//
// Every phase above is a Core-owned constant. An **app event** is the open half of
// the same mechanism: a plugin declares `contributes.hook_events` (see
// [`crate::plugin_manifest::HookEventContribution`]), its sidecar raises the event
// through the `events.emit` kernel capability, and Core dispatches it here as a
// phase named `<owning plugin id>#<event name>`.
//
// That naming is not cosmetic. Core phases are bare words and app events always
// carry a `/`, so the two namespaces cannot collide and `phase_matches` needs no
// special case — an app event flows through the exact same `dispatch_phase` path
// every built-in phase uses. The only thing app events need on top is a narrower
// directive policy, below.

/// Directives an **app-event** hook may return.
///
/// An app event fires with no turn in flight — a meeting ended, a workflow run
/// failed — so most of the [`HookDirective`] vocabulary is meaningless here:
/// there is no outgoing user message to [`Replace`], no context to [`Inject`] into
/// and no turn to [`Continue`]. Applying one would mean silently mutating whatever
/// chat happened to be open, which is not what the hook asked for and not something
/// the user could predict.
///
/// So an app-event hook is observation-plus-notification: [`None`] or [`Note`].
/// Anything else is dropped with a log rather than an error, because the hook is
/// otherwise well-formed and failing the whole dispatch would punish the plugin for
/// a directive that simply has no meaning in this position.
///
/// A plugin that genuinely wants an app event to *drive a conversation* has the
/// right tool already: react to the event with a workflow (a
/// [`crate::workflow::WorkflowTrigger::Event`]), which owns its own run context.
///
/// [`None`]: HookDirective::None
/// [`Note`]: HookDirective::Note
/// [`Replace`]: HookDirective::Replace
/// [`Inject`]: HookDirective::Inject
/// [`Continue`]: HookDirective::Continue
fn app_event_directive_allowed(directive: &HookDirective) -> bool {
    matches!(directive, HookDirective::None | HookDirective::Note { .. })
}

/// The maximum serialized size of an app-event payload, in bytes.
///
/// The payload is forwarded verbatim into every consumer's sandbox, so an
/// unbounded one is an amplification channel: a single emit would be copied into N
/// Deno processes. 64 KiB is far above any real event and far below anything that
/// makes fan-out expensive.
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 64 * 1024;

/// Dispatch an **app event** to every enabled plugin whose hook declares it.
///
/// Detached-style semantics (fail-open, never blocks the emitter) matching the
/// [`ON_POST_TOOL_USE`] precedent, with directives filtered by
/// [`app_event_directive_allowed`]. Returns the surviving directives so the emit
/// handler can report how many consumers acted.
///
/// Authorization is NOT checked here — this is the dispatch primitive, and the emit
/// seam (`events.emit`) is what proves the caller owns the event. Anything reaching
/// this function is already authorized.
pub async fn dispatch_app_event(
    state: &ServerState,
    event: &str,
    ctx: &HookContext,
) -> Vec<HookDirective> {
    let directives = dispatch_phase(state, event, ctx).await;
    let total = directives.len();
    let kept: Vec<HookDirective> = directives
        .into_iter()
        .filter(app_event_directive_allowed)
        .collect();
    if kept.len() != total {
        tracing::debug!(
            event,
            dropped = total - kept.len(),
            "plugin_host: dropped app-event directives that have no meaning off the chat path"
        );
    }
    kept
}

/// Surface a [`HookDirective::Note`] returned by an app-event hook.
///
/// On the chat path a note is rendered out-of-band next to the answer. An app event
/// has no answer to sit beside, so the note goes to the **unified activity feed** —
/// the one place a user already looks for "something happened while I wasn't
/// watching", and the same sink a fired monitor alert lands in.
///
/// Deliberately NOT the notification fan-out: that reaches configured channels
/// (Telegram, email, push), and a hook firing on every `x.updated` event would turn
/// into a pager. An app-event hook that genuinely warrants pushing to a human has
/// the `notify.fanout` capability for it.
///
/// Best-effort — a feed write failure is logged, never propagated to the emitter.
pub async fn notify_app_event_note(state: &ServerState, event: &str, text: &str) {
    let item = ryu_activity::ActivityItem::new("plugin_hook_note", "plugins", event.to_owned())
        .with_body(Some(text.to_owned()))
        .with_level(ryu_activity::ActivityLevel::Info)
        .with_metadata(serde_json::json!({ "event": event }));
    if let Err(e) = state.activity.record(item).await {
        tracing::warn!("plugin_host: failed to record app-event note on activity feed: {e:#}");
    }
}

/// Every app event declared by a currently **enabled** plugin, as
/// `(event, owning plugin id, contribution)`.
///
/// The catalog behind the event picker in the workflow builder and the consumer
/// docs. Reads the live manifest set, so an enable/disable is reflected without a
/// refresh — same posture as [`collect_enabled_hooks`].
pub async fn collect_declared_events(
    state: &ServerState,
) -> Vec<(String, crate::plugin_manifest::HookEventContribution)> {
    let enabled_ids: HashSet<String> = match state.app_store.list().await {
        Ok(records) => records
            .into_iter()
            .filter(|r| r.enabled)
            .map(|r| r.id)
            .collect(),
        Err(e) => {
            tracing::warn!("plugin_host: could not list plugins for event catalog: {e}");
            return Vec::new();
        }
    };
    let manifests = state.app_manifests.read().await;
    let mut events = Vec::new();
    for manifest in manifests.iter() {
        if !enabled_ids.contains(&manifest.id) {
            continue;
        }
        let Some(contributes) = &manifest.contributes else {
            continue;
        };
        for event in &contributes.hook_events {
            events.push((manifest.id.clone(), event.clone()));
        }
    }
    events
}

/// Whether `plugin_id` declared `event` in its manifest — the authorization
/// predicate behind the emit seam.
///
/// Two conditions, and both matter. The namespace half of the event id must be
/// `plugin_id` (so an app cannot emit into another app's namespace even if it
/// declares the row), and the event must actually appear in that manifest's
/// `hook_events` (so an app cannot emit an event it never published a contract
/// for). Fail-closed: an unknown plugin, a missing `contributes`, or an
/// undeclared event all return `false`.
pub async fn may_emit_event(state: &ServerState, plugin_id: &str, event: &str) -> bool {
    let Some((owner, _)) = crate::plugin_manifest::split_hook_event_id(event) else {
        return false;
    };
    if owner != plugin_id {
        return false;
    }
    let manifests = state.app_manifests.read().await;
    manifests
        .iter()
        .find(|m| m.id == plugin_id)
        .and_then(|m| m.contributes.as_ref())
        .is_some_and(|c| c.hook_events.iter().any(|e| e.id == event))
}

/// Whether a hook declared for `hook_on` should run in `phase`. Exact match,
/// except [`ON_STOP`] is treated as an alias of [`ON_POST_ASSISTANT_TURN`].
///
/// App-event phases need no clause here: they are exact-matched like everything
/// else, and their mandatory `/` keeps them from ever colliding with a Core phase
/// name.
pub fn phase_matches(hook_on: &str, phase: &str) -> bool {
    hook_on == phase || (phase == ON_POST_ASSISTANT_TURN && hook_on == ON_STOP)
}

/// A hard cap on how many `continue` directives a single chat request may apply
/// (the server-side analog of the old client `MAX_GOAL_TURNS`). The chat path
/// enforces this; exported here so the cap lives in one place.
pub const MAX_CONTINUE_TURNS: u32 = 25;

pub(crate) fn hook_policy_allows(
    policy: Option<&crate::governance::HookPolicyOverride>,
    trusted_by_default: bool,
) -> bool {
    let enabled = policy.and_then(|value| value.enabled).unwrap_or(true);
    let trusted = policy
        .and_then(|value| value.trusted)
        .unwrap_or(trusted_by_default);
    enabled && trusted
}

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
    let hook_overrides = match state.app_store.effective_hook_overrides().await {
        Ok(overrides) => overrides,
        Err(error) => {
            tracing::warn!("plugin_host: could not read hook policy: {error}");
            return Vec::new();
        }
    };

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
            let hook_key = format!("{}::{}", manifest.id, hook.id);
            let trusted_by_default =
                crate::plugins::builtins::is_compiled_in_manifest(&manifest.id);
            if !hook_policy_allows(hook_overrides.get(&hook_key), trusted_by_default) {
                continue;
            }
            hooks.push(HookPlugin {
                plugin_id: manifest.id.clone(),
                hook_id: hook.id.clone(),
                on: hook.on.clone(),
                priority: hook.priority,
                code: hook.code.clone(),
                grants: grants.clone(),
                run_when: hook.run_when.clone(),
            });
        }
    }
    hooks.sort_by(|left, right| {
        right
            .priority
            .cmp(&left.priority)
            .then_with(|| left.plugin_id.cmp(&right.plugin_id))
            .then_with(|| left.hook_id.cmp(&right.hook_id))
    });
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
    run_hooks(state, ctx, &hooks, ON_POST_ASSISTANT_TURN).await
}

/// Does any **loaded** manifest declare a hook for `phase`? Cheap and DB-free
/// (reads only the in-memory manifest set). The off-path dispatchers call this to
/// return instantly when no plugin could possibly handle a phase — so e.g. a tool
/// call pays nothing on the hot path unless a tool-hook plugin is actually loaded.
pub async fn any_manifest_declares(state: &ServerState, phase: &str) -> bool {
    let manifests = state.app_manifests.read().await;
    manifests.iter().any(|m| {
        m.contributes
            .as_ref()
            .is_some_and(|c| c.turn_hooks.iter().any(|h| phase_matches(&h.on, phase)))
    })
}

/// Collect enabled hooks and run those for `phase`. The one entry point the
/// process-global dispatcher uses. Fail-open + DB-free fast path: returns empty
/// without touching the plugin store when no loaded manifest declares `phase`.
pub async fn dispatch_phase(
    state: &ServerState,
    phase: &str,
    ctx: &HookContext,
) -> Vec<HookDirective> {
    if !tool_exec::is_available() {
        return Vec::new();
    }
    if !any_manifest_declares(state, phase).await {
        return Vec::new();
    }
    let hooks = collect_enabled_hooks(state).await;
    run_hooks(state, ctx, &hooks, phase).await
}

/// Run `tool_result` hooks as a sequential transform pipeline. The first hook
/// may inspect the real result; every later hook sees the output produced so far.
/// This is separate from [`dispatch_phase`], whose observation semantics return a
/// collection of independent directives.
pub async fn dispatch_tool_result_phase(
    state: &ServerState,
    ctx: &HookContext,
) -> Option<serde_json::Value> {
    if !tool_exec::is_available() || !any_manifest_declares(state, ON_TOOL_RESULT).await {
        return None;
    }
    let hooks = collect_enabled_hooks(state).await;
    let mut current = ctx.tool_output.clone()?;
    let mut transformed = false;
    for hook in hooks {
        if !phase_matches(&hook.on, ON_TOOL_RESULT) {
            continue;
        }
        let mut hook_ctx = ctx.clone();
        hook_ctx.tool_output = Some(current.clone());
        if !hook_should_run(state, &hook, &hook_ctx).await {
            continue;
        }
        if let HookDirective::Transform { output } = run_hook(state, &hook, &hook_ctx).await {
            current = output;
            transformed = true;
        }
    }
    transformed.then_some(current)
}

/// Process-global hook dispatcher. Installed once at boot (`main.rs`) so code
/// paths that have no [`ServerState`] in scope — the shared tool-dispatch core,
/// the delegation engine, the notification fan-out — can still fire hooks.
/// Mirrors [`crate::plugin_storage::global`].
pub trait HookDispatch: Send + Sync {
    fn dispatch<'a>(
        &'a self,
        phase: &'a str,
        ctx: HookContext,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Vec<HookDirective>> + Send + 'a>>;

    fn dispatch_tool_result<'a>(
        &'a self,
        ctx: HookContext,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<serde_json::Value>> + Send + 'a>>
    {
        Box::pin(async move {
            self.dispatch(ON_TOOL_RESULT, ctx)
                .await
                .into_iter()
                .find_map(|directive| match directive {
                    HookDirective::Transform { output } => Some(output),
                    _ => None,
                })
        })
    }
}

static GLOBAL: std::sync::OnceLock<Arc<dyn HookDispatch>> = std::sync::OnceLock::new();

/// Install the global dispatcher (idempotent; first writer wins).
pub fn set_global(dispatcher: Arc<dyn HookDispatch>) -> bool {
    GLOBAL.set(dispatcher).is_ok()
}

/// Fire the hooks for `phase` through the global dispatcher. Returns an empty vec
/// when no dispatcher is installed (e.g. unit tests) so callers stay fail-open.
/// Awaited callers (`pre_tool_use`) act on the returned directives; detached
/// callers ignore them.
pub async fn dispatch_global(phase: &str, ctx: HookContext) -> Vec<HookDirective> {
    match GLOBAL.get() {
        Some(d) => d.dispatch(phase, ctx).await,
        None => Vec::new(),
    }
}

/// Run the global tool-result transform pipeline. No dispatcher means no
/// rewrite, preserving the fail-open behavior used by every hook phase.
pub async fn dispatch_global_tool_result(ctx: HookContext) -> Option<serde_json::Value> {
    match GLOBAL.get() {
        Some(dispatcher) => dispatcher.dispatch_tool_result(ctx).await,
        None => None,
    }
}

/// Run a pre-collected set of hooks for one phase against `ctx`. Lets the
/// chat-path wrapper collect hooks once (cheap gate) and reuse the set across the
/// pre-turn transform and the post-turn continue loop. `phase` is one of
/// [`ON_PRE_USER_TURN`] / [`ON_POST_ASSISTANT_TURN`]; hooks on other boundaries
/// are skipped.
pub async fn run_hooks(
    state: &ServerState,
    ctx: &HookContext,
    hooks: &[HookPlugin],
    phase: &str,
) -> Vec<HookDirective> {
    let mut directives = Vec::new();
    for hook in hooks {
        if !phase_matches(&hook.on, phase) {
            continue;
        }
        // Cheap pre-gate: skip the sandbox spawn when the hook provably can't act
        // this turn. This is what makes pre-installed hooks free on the hot path.
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
            let namespace = storage_namespace_for_tenant(ctx.caller_user_id.as_deref(), "default");
            match store.get(&hook.plugin_id, &namespace, conv).await {
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

    if !m.tools.is_empty() {
        declared = true;
        if let Some(name) = ctx.tool_name.as_deref() {
            if m.tools.iter().any(|pat| glob_match(pat, name)) {
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

/// A minimal glob for tool-name gates: supports a single leading and/or trailing
/// `*`. `"*"` matches everything, `"bash*"` a prefix, `"*write"` a suffix,
/// `"*edit*"` a substring, anything else an exact match. Deliberately tiny — this
/// is a spawn-avoidance gate, not a full matcher.
fn glob_match(pattern: &str, name: &str) -> bool {
    match (pattern.strip_prefix('*'), pattern.strip_suffix('*')) {
        _ if pattern == "*" => true,
        (Some(rest), Some(_)) => {
            // both ends starred: substring (rest still has trailing '*')
            let inner = rest.strip_suffix('*').unwrap_or(rest);
            name.contains(inner)
        }
        (Some(suffix), None) => name.ends_with(suffix),
        (None, Some(prefix)) => name.starts_with(prefix),
        (None, None) => pattern == name,
    }
}

/// Run one hook in the sandbox and parse its directive. Any failure (Deno
/// missing, hook threw, unparseable result, a Pause we don't support) degrades to
/// [`HookDirective::None`].
pub async fn run_hook(state: &ServerState, hook: &HookPlugin, ctx: &HookContext) -> HookDirective {
    // Hold the plugin's read lease across the sandbox call. A concurrent disable
    // waits for this work before unregistering the plugin's contributions; a
    // hook collected before disable but not started yet is refused instead of
    // running against a stale generation.
    let Some(_runtime_lease) = state.plugin_runtime.acquire(&hook.plugin_id).await else {
        return HookDirective::None;
    };
    let program = build_hook_program(ctx, &hook.code);
    let bridge = Arc::new(PluginHookBridge::new_with_tenant(
        hook.plugin_id.clone(),
        hook.grants.clone(),
        state.clone(),
        ctx.caller_user_id.clone(),
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
  runFanout: (a) => tools.host.runFanout(a ?? {{}}),
  notify: (a) => tools.host.notify(a ?? {{}}),
  setConversationTitle: (a) => tools.host.setConversationTitle(a ?? {{}}),
  getPreference: (a) => tools.host.getPreference(a ?? {{}}),
  background: {{
    list: (a) => tools.host.background_list(a ?? {{}}),
    stop: (a) => tools.host.background_stop(a ?? {{}}),
  }},
  usage: (a) => tools.host.usageSnapshot(a ?? {{}}),
  storage: {{
    get: (k, ns) => tools.host.storage_get({{ key: String(k), namespace: ns }}),
    set: (k, v, ns) => tools.host.storage_set({{ key: String(k), value: typeof v === "string" ? v : JSON.stringify(v), namespace: ns }}),
    delete: (k, ns) => tools.host.storage_delete({{ key: String(k), namespace: ns }}),
    keys: (ns) => tools.host.storage_keys({{ namespace: ns }}),
    compareAndSet: (k, expected, v, ns) => tools.host.storage_compare_and_set({{ key: String(k), expected: expected == null ? null : String(expected), value: v == null ? null : (typeof v === "string" ? v : JSON.stringify(v)), namespace: ns }}),
  }},
  spaces: {{
    ensureSpace: (a) => tools.host.spaces_ensure_space(a ?? {{}}),
    createDoc: (a) => tools.host.spaces_create_doc(a ?? {{}}),
    getDoc: (a) => tools.host.spaces_get_doc(a ?? {{}}),
    updateDoc: (a) => tools.host.spaces_update_doc(a ?? {{}}),
    listDocs: (a) => tools.host.spaces_list_docs(a ?? {{}}),
    deleteDoc: (a) => tools.host.spaces_delete_doc(a ?? {{}}),
  }},
  crypto: {{
    seal: (v) => tools.host.crypto_seal({{ value: typeof v === "string" ? v : JSON.stringify(v) }}),
    open: (v) => tools.host.crypto_open({{ value: String(v) }}),
    status: () => tools.host.crypto_status({{}}),
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

    #[test]
    fn hook_policy_requires_explicit_trust_for_third_party_hooks() {
        assert!(!hook_policy_allows(None, false));
        assert!(hook_policy_allows(None, true));
        assert!(hook_policy_allows(
            Some(&crate::governance::HookPolicyOverride {
                enabled: None,
                trusted: Some(true),
            }),
            false
        ));
    }

    #[test]
    fn hook_policy_keeps_enable_and_trust_as_independent_gates() {
        assert!(!hook_policy_allows(
            Some(&crate::governance::HookPolicyOverride {
                enabled: Some(false),
                trusted: Some(true),
            }),
            true
        ));
        assert!(!hook_policy_allows(
            Some(&crate::governance::HookPolicyOverride {
                enabled: Some(true),
                trusted: Some(false),
            }),
            true
        ));
    }
    use serde_json::json;

    /// An app event fires with no turn in flight, so only the directives that mean
    /// something off the chat path survive. Getting this wrong would let a hook
    /// reacting to "a meeting ended" silently inject text into whatever chat happened
    /// to be open.
    #[test]
    fn app_event_hooks_may_only_observe_or_note() {
        assert!(app_event_directive_allowed(&HookDirective::None));
        assert!(app_event_directive_allowed(&HookDirective::Note {
            text: "meeting summarized".into()
        }));

        for turn_only in [
            HookDirective::Continue {
                text: "keep going".into(),
            },
            HookDirective::Replace {
                text: "rewritten".into(),
                fresh_session: false,
            },
            HookDirective::Inject {
                text: "context".into(),
            },
        ] {
            assert!(
                !app_event_directive_allowed(&turn_only),
                "{turn_only:?} has no meaning off the chat path and must be dropped"
            );
        }
    }

    /// An app-event phase must route through the ordinary exact-match dispatch, and
    /// must never be captured by the one alias `phase_matches` implements.
    #[test]
    fn app_event_phases_match_exactly_and_never_alias() {
        assert!(phase_matches(
            "com.acme.meet/meeting.ended",
            "com.acme.meet/meeting.ended"
        ));
        assert!(!phase_matches(
            "com.acme.meet/meeting.ended",
            "com.acme.meet/meeting.started"
        ));
        // The `stop` → `post_assistant_turn` alias must not drag an app event in.
        assert!(!phase_matches(
            "com.acme.meet/meeting.ended",
            ON_POST_ASSISTANT_TURN
        ));
        assert!(!phase_matches(ON_STOP, "com.acme.meet/meeting.ended"));
    }

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
            parse_directive(Some(&json!({
                "kind": "tool_approval",
                "question": "Can I run the tests?",
                "summary": "I will run the test suite to verify the change."
            }))),
            HookDirective::ToolApproval {
                question: "Can I run the tests?".into(),
                summary: "I will run the test suite to verify the change.".into(),
            }
        );
        assert_eq!(
            parse_directive(Some(&json!({ "kind": "continue", "text": "keep going" }))),
            HookDirective::Continue {
                text: "keep going".into()
            }
        );
        // Old hook payloads omit the ACP session flag and must remain pooled.
        assert_eq!(
            parse_directive(Some(&json!({ "kind": "replace", "text": "rewrite" }))),
            HookDirective::Replace {
                text: "rewrite".into(),
                fresh_session: false,
            }
        );
        assert_eq!(
            parse_directive(Some(
                &json!({ "kind": "replace", "text": "rewrite", "fresh_session": true }),
            )),
            HookDirective::Replace {
                text: "rewrite".into(),
                fresh_session: true,
            }
        );
        assert_eq!(
            parse_directive(Some(&json!({ "kind": "deny", "reason": "no" }))),
            HookDirective::Deny {
                reason: "no".into()
            }
        );
        // `transform` carries an arbitrary JSON result, not text — a tool result is
        // a structured value, so redaction must be able to return an object.
        assert_eq!(
            parse_directive(Some(
                &json!({ "kind": "transform", "output": { "content": "[redacted]" } })
            )),
            HookDirective::Transform {
                output: json!({ "content": "[redacted]" })
            }
        );
        assert_eq!(
            parse_directive(Some(
                &json!({ "kind": "transform", "output": "plain string" })
            )),
            HookDirective::Transform {
                output: json!("plain string")
            }
        );
        assert_eq!(
            parse_directive(Some(&json!({
                "kind": "select_model",
                "model": "opus",
                "acp_config": { "fast_mode": "true" }
            }))),
            HookDirective::SelectModel {
                model: "opus".into(),
                effort: None,
                acp_config: Some(std::collections::HashMap::from([(
                    "fast_mode".into(),
                    "true".into(),
                )])),
                reason: None,
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
        // A `transform` with no `output` is malformed — it must NOT silently become
        // a rewrite to null, which would erase the real tool result.
        assert_eq!(
            parse_directive(Some(&json!({ "kind": "transform" }))),
            HookDirective::None
        );
    }

    #[test]
    fn tool_result_is_a_distinct_phase_from_post_tool_use() {
        // The split is what keeps observation detached (zero latency) while rewrite
        // is awaited. If these ever aliased, every `post_tool_use` observer would
        // start costing the tool hot path a sandbox spawn.
        assert_ne!(ON_TOOL_RESULT, ON_POST_TOOL_USE);
        assert!(!phase_matches(ON_POST_TOOL_USE, ON_TOOL_RESULT));
        assert!(!phase_matches(ON_TOOL_RESULT, ON_POST_TOOL_USE));
        assert!(phase_matches(ON_TOOL_RESULT, ON_TOOL_RESULT));
        // `stop` stays an alias of post_assistant_turn and must not leak into the
        // tool phases.
        assert!(!phase_matches(ON_STOP, ON_TOOL_RESULT));
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
        assert!(program.contains("notify: (a) => tools.host.notify(a ?? {}),"));
        assert!(program.contains("return { kind: 'note', text: 'x' };"));
    }

    #[test]
    fn delegation_lifecycle_is_an_exact_match_phase() {
        assert!(phase_matches(
            ON_DELEGATION_LIFECYCLE,
            ON_DELEGATION_LIFECYCLE
        ));
        assert!(!phase_matches(ON_DELEGATION_LIFECYCLE, ON_NOTIFICATION));
        assert!(!phase_matches(
            ON_DELEGATION_LIFECYCLE,
            ON_POST_ASSISTANT_TURN
        ));
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
    fn tenant_namespace_is_shared_by_bridge_and_core_projections() {
        assert_eq!(
            storage_namespace_for_tenant(Some("user-42"), "default"),
            "tenant:user-42:default"
        );
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
    fn glob_match_supports_wildcards() {
        assert!(glob_match("*", "anything"));
        assert!(glob_match("bash", "bash"));
        assert!(!glob_match("bash", "bashx"));
        assert!(glob_match("bash*", "bash.run"));
        assert!(!glob_match("bash*", "sh"));
        assert!(glob_match("*write", "fs.write"));
        assert!(glob_match("*edit*", "editor.do_edit"));
        assert!(!glob_match("*edit*", "read_only"));
    }

    #[test]
    fn gate_tools_matches_tool_name() {
        let m = HookMatch {
            tools: vec!["bash*".into(), "*delete*".into()],
            ..Default::default()
        };
        let ctx = |name: &str| HookContext {
            tool_name: Some(name.into()),
            ..Default::default()
        };
        assert_eq!(gate_without_storage(&m, &ctx("bash.run")), GateVerdict::Run);
        assert_eq!(
            gate_without_storage(&m, &ctx("fs.delete_file")),
            GateVerdict::Run
        );
        // A tool the firewall doesn't watch → skip (no sandbox spawn).
        assert_eq!(
            gate_without_storage(&m, &ctx("web_fetch")),
            GateVerdict::Skip
        );
        // No tool name in context (a non-tool phase) → skip.
        assert_eq!(
            gate_without_storage(&m, &HookContext::default()),
            GateVerdict::Skip
        );
    }

    #[test]
    fn phase_matches_treats_stop_as_post_assistant_turn() {
        assert!(phase_matches(ON_STOP, ON_POST_ASSISTANT_TURN));
        assert!(phase_matches(
            ON_POST_ASSISTANT_TURN,
            ON_POST_ASSISTANT_TURN
        ));
        assert!(!phase_matches(ON_STOP, ON_PRE_USER_TURN));
        assert!(!phase_matches(ON_PRE_TOOL_USE, ON_POST_TOOL_USE));
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
    fn fixture_hook_from_file(plugin: &str, hook_id: &str) -> String {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../plugins-store/plugins")
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
    async fn run_code(
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

    async fn run_fixture(
        plugin_id: &str,
        ctx: HookContext,
        side_value: serde_json::Value,
    ) -> HookDirective {
        run_code(&fixture_hook(plugin_id), ctx, side_value).await
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
                text: "Advisor: A global is not request-safe; use a signed cookie or a store."
                    .into()
            }
        );
    }

    #[tokio::test]
    async fn live_security_scanner_clear_command_handles() {
        if !tool_exec::is_available() {
            return;
        }
        let ctx = HookContext {
            conversation_id: Some("security-scanner-clear".into()),
            input: Some("/security-clear".into()),
            transcript: vec![HookMessage {
                role: "user".into(),
                content: "/security-clear".into(),
            }],
            ..Default::default()
        };
        let directive = run_fixture("@ryu/security-scanner", ctx, serde_json::Value::Null).await;
        assert_eq!(
            directive,
            HookDirective::Handled {
                text: "Security Scanner state cleared for this conversation.".into()
            }
        );
    }

    #[tokio::test]
    async fn live_security_scanner_auto_review_flags_pattern() {
        if !tool_exec::is_available() {
            return;
        }
        let ctx = HookContext {
            conversation_id: Some("security-scanner-review".into()),
            agent_id: Some("ryu".into()),
            transcript: vec![
                HookMessage {
                    role: "user".into(),
                    content: "load the config".into(),
                },
                HookMessage {
                    role: "assistant".into(),
                    content: "The generated configuration loader is shown below. It must be reviewed carefully before deployment. cfg = yaml.load(open('config.yml')) and the resulting object is passed to the application configuration layer.".into(),
                },
            ],
            flags: std::iter::once((
                "io.ryu.security-scanner.auto-review".to_string(),
                true,
            ))
            .collect(),
            ..Default::default()
        };
        let code = fixture_hook_from_file("security-scanner", "security-scanner.auto-review");
        let directive = run_code(&code, ctx, serde_json::json!("RESULT: clean")).await;
        match directive {
            HookDirective::Note { text } => {
                assert!(text.contains("Static signals"), "note: {text}");
                assert!(text.contains("YAML"), "note: {text}");
            }
            other => panic!("expected a security scanner note, got {other:?}"),
        }
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
            ..Default::default()
        };
        let directive = run_fixture(
            "@ryu/security-guidance",
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
            run_fixture("@ryu/security-guidance", ctx, serde_json::json!("unused")).await;
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
        let directive = run_fixture("@ryu/advisor", ctx, serde_json::json!("unused")).await;
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
            "@ryu/advisor",
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

    #[tokio::test]
    async fn live_auto_expand_toggle_replaces_input() {
        if !tool_exec::is_available() {
            return;
        }
        // Toggle on → the pending user message is rewritten via the side model and
        // returned as a `replace` directive (the improved prompt is sent instead).
        let ctx = HookContext {
            conversation_id: Some("c1".into()),
            input: Some("fix login".into()),
            flags: std::iter::once(("@ryu/auto-expand".to_string(), true)).collect(),
            ..Default::default()
        };
        let directive = run_fixture(
            "@ryu/auto-expand",
            ctx,
            serde_json::json!("Investigate and fix the login bug: ..."),
        )
        .await;
        assert_eq!(
            directive,
            HookDirective::Replace {
                text: "Investigate and fix the login bug: ...".into(),
                fresh_session: false,
            }
        );
    }

    #[tokio::test]
    async fn live_auto_expand_off_is_none() {
        if !tool_exec::is_available() {
            return;
        }
        // Toggle off and no `/expand` command → no rewrite (the gate would also
        // skip the spawn in production; here we prove the hook self-guards too).
        let ctx = HookContext {
            conversation_id: Some("c1".into()),
            input: Some("just a normal message".into()),
            ..Default::default()
        };
        let directive = run_fixture("@ryu/auto-expand", ctx, serde_json::json!("unused")).await;
        assert_eq!(directive, HookDirective::None);
    }

    #[tokio::test]
    async fn live_auto_expand_slash_command_replaces_stripped_prompt() {
        if !tool_exec::is_available() {
            return;
        }
        // `/expand <prompt>` expands just `<prompt>` (the command prefix stripped),
        // even with the toggle off — the all-surfaces on-demand path.
        let ctx = HookContext {
            conversation_id: Some("c1".into()),
            input: Some("/expand write tests".into()),
            ..Default::default()
        };
        let directive = run_fixture(
            "@ryu/auto-expand",
            ctx,
            serde_json::json!("Write a comprehensive unit test suite for ..."),
        )
        .await;
        assert_eq!(
            directive,
            HookDirective::Replace {
                text: "Write a comprehensive unit test suite for ...".into(),
                fresh_session: false,
            }
        );
    }

    // ── Extended Claude-Code-style phases ────────────────────────────────────

    #[tokio::test]
    async fn live_session_start_injects_context() {
        if !tool_exec::is_available() {
            return;
        }
        // SessionStart reference: injects the current date/time as additive context.
        let ctx = HookContext {
            conversation_id: Some("c1".into()),
            input: Some("what day is it?".into()),
            ..Default::default()
        };
        let directive = run_fixture("@ryu/session-context", ctx, serde_json::json!("")).await;
        match directive {
            HookDirective::Inject { text } => {
                assert!(text.contains("Session context"), "inject: {text}");
                assert!(text.contains("current date"), "inject: {text}");
            }
            other => panic!("expected an Inject directive, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn live_tool_firewall_denies_destructive() {
        if !tool_exec::is_available() {
            return;
        }
        // PreToolUse: a destructive command in the tool args → Deny.
        let code = fixture_hook_from_file("tool-firewall", "tool-firewall.pre");
        let ctx = HookContext {
            tool_name: Some("bash".into()),
            tool_input: Some(serde_json::json!({ "command": "rm -rf /" })),
            ..Default::default()
        };
        let directive = run_code(&code, ctx, serde_json::json!("unused")).await;
        match directive {
            HookDirective::Deny { reason } => assert!(reason.contains("destructive"), "{reason}"),
            other => panic!("expected Deny, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn live_tool_firewall_allows_safe() {
        if !tool_exec::is_available() {
            return;
        }
        // PreToolUse: a safe command → None (allow).
        let code = fixture_hook_from_file("tool-firewall", "tool-firewall.pre");
        let ctx = HookContext {
            tool_name: Some("bash".into()),
            tool_input: Some(serde_json::json!({ "command": "ls -la" })),
            ..Default::default()
        };
        let directive = run_code(&code, ctx, serde_json::json!("unused")).await;
        assert_eq!(directive, HookDirective::None);
    }

    #[tokio::test]
    async fn live_tool_firewall_post_observes_output() {
        if !tool_exec::is_available() {
            return;
        }
        // PostToolUse: reads tool_output (observation).
        let code = fixture_hook_from_file("tool-firewall", "tool-firewall.post");
        let ctx = HookContext {
            tool_name: Some("web_fetch".into()),
            tool_output: Some(serde_json::json!({ "status": 200 })),
            ..Default::default()
        };
        let directive = run_code(&code, ctx, serde_json::json!("unused")).await;
        match directive {
            HookDirective::Note { text } => assert!(text.contains("web_fetch"), "{text}"),
            other => panic!("expected Note, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn live_observer_hooks_read_their_context() {
        if !tool_exec::is_available() {
            return;
        }
        // subagent_stop reads ctx.output + ctx.event.
        let code = fixture_hook_from_file("hook-observers", "observers.subagent-stop");
        let ctx = HookContext {
            output: Some("did the thing".into()),
            event: Some(serde_json::json!({ "id": "task-7" })),
            ..Default::default()
        };
        match run_code(&code, ctx, serde_json::json!("x")).await {
            HookDirective::Note { text } => {
                assert!(
                    text.contains("task-7") && text.contains("did the thing"),
                    "{text}"
                );
            }
            other => panic!("expected Note, got {other:?}"),
        }
        // notification reads ctx.event.title.
        let code = fixture_hook_from_file("hook-observers", "observers.notification");
        let ctx = HookContext {
            event: Some(serde_json::json!({ "title": "Price dropped" })),
            ..Default::default()
        };
        match run_code(&code, ctx, serde_json::json!("x")).await {
            HookDirective::Note { text } => assert!(text.contains("Price dropped"), "{text}"),
            other => panic!("expected Note, got {other:?}"),
        }
    }
}
