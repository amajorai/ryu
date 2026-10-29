//! The plugin turn-hook runtime.
//!
//! This is the code-execution layer that makes features like double-check and
//! goal **real installable plugins** rather than hardcoded Core endpoints. A
//! plugin declares a `post_assistant_turn` hook (`contributes.turn_hooks` in its
//! `manifest.json`); the hook is plugin-authored JS run in the **same deny-by-default
//! JS sandbox** the PTC tool-exec uses ([`crate::tool_exec`]). The hook reaches
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
//! Availability: the sandbox is built in (`js-sandbox`). In a build without it the
//! runtime no-ops (logged), so chat is never blocked — same graceful-degrade
//! posture as the Python `external_runtime` plugins.

pub mod action_stream;
pub mod breaker;
mod bridge;
pub(crate) use bridge::node_owner_or_admin;

pub use action_stream::ActionFrameProbe;
pub use bridge::{dispatch_path_for, PluginHookBridge};

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
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
    /// The verified caller carried only inside Core. It is skipped when the
    /// context is serialized into the sandbox, but lets host mutations enforce
    /// the same organization/resource ACL as the originating request.
    #[serde(skip)]
    pub(crate) verified_caller: Option<crate::identity_verify::VerifiedCaller>,
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
    /// A typed channel button action on this inbound turn. The action payload is
    /// user-controlled input; hooks must still apply their normal authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel_action: Option<ryu_channel_contracts::ChannelActionEvent>,
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
    /// Attach native, channel-neutral buttons to the reply for channel surfaces
    /// that support them. The normal reply text remains the message body.
    InteractiveMessage {
        markup: ryu_channel_contracts::InteractiveMarkup,
    },
    /// Replace the pending outgoing user message with `text` **before** it reaches
    /// the model (a `pre_user_turn` directive; ignored on the post-turn path). The
    /// rewritten text is what gets sent and persisted — the auto-expand plugin uses
    /// this to swap a raw prompt for its improved form.
    Replace {
        text: String,
        /// Deprecated and ignored. It once let an ACP `context` hook discard the
        /// pooled session every turn, which threw away the agent's prompt cache;
        /// Core now keeps the session and sends only the appended text with the
        /// latest turn. Still parsed so older hook payloads deserialize.
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
    /// Replace the outbound message array before it reaches the model (an
    /// [`ON_CONTEXT`] directive on the message-array plane; ignored elsewhere).
    /// Every row before the newest user message must be returned unchanged —
    /// that prefix is what provider prompt caches reuse — or the rewrite is
    /// ignored; see [`ON_CONTEXT`].
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
    Handled {
        text: String,
        /// Optional buttons for channel turns answered without a model call.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        interactive_markup: Option<ryu_channel_contracts::InteractiveMarkup>,
    },
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
    /// How this hook composes with other hooks in the same phase.
    pub mode: crate::plugin_manifest::HookMode,
    /// Higher-priority hooks run first; ties are deterministic.
    pub priority: i32,
    /// The JS hook body.
    pub code: String,
    /// The installed plugin's current operator-approved capabilities.
    pub grants: HashSet<String>,
    /// Optional cheap pre-gate (from the manifest). Evaluated in Rust before the
    /// sandbox run so an idle hook never pays for an instance.
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
///
/// On both planes a hook may change only the LATEST message. The system prompt
/// and earlier turns are the provider prompt-cache prefix, so a `Rewrite` must
/// keep every row before the newest user message byte-identical and an ACP
/// `Replace` must keep the built prompt as its exact prefix (append-only); a
/// directive that edits the frozen prefix is ignored and the original is sent.
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
/// `{run_id, workflow_id, workflow_name, status, error, output}`. For an ad-hoc
/// script run (`sr-…`) `error` and `output` are omitted: only the plugin scope
/// that started it may read its result (`host.workflowRunStatus`).
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

/// Fires when a user activates an app-backed action on one of the plugin's
/// declarative views (a `ViewAction` with no declarative `http` handler). The
/// shell relays the intent through `view.action` on the host bridge and Core runs
/// **only the owning plugin's** `view_action` hooks — never another plugin's.
///
/// The intent rides in [`HookContext::event`]:
/// `{source: "view_action", view_id, action_id, intent, payload, values, item}`.
/// Like an app event there is no turn in flight, so only [`HookDirective::None`]
/// and [`HookDirective::Note`] are meaningful; a `Note` is the hook's success
/// message and `None` means the hook declined the intent (see
/// [`dispatch_view_action`]).
pub const ON_VIEW_ACTION: &str = "view_action";

/// Fires after a plugin's version changes — a successful update or a rollback —
/// so the plugin can migrate its own storage. It runs **only the updated
/// plugin's own** hooks, from the NEW manifest, awaited, with the grants the
/// plugin already holds (typically `storage:kv` for `host.storage`). Payload in
/// [`HookContext::event`]: `{source: "plugin_update", plugin_id, from_version,
/// to_version, reason}` where `reason` is `"update"` or `"rollback"`.
///
/// A plugin that is disabled when its version changes has no active hooks, so
/// this phase does not fire for it; a migration must therefore tolerate data
/// written by any earlier version (compare a stored schema marker rather than
/// trusting `from_version` alone). Only `None`/`Note` are meaningful here.
pub const ON_PLUGIN_UPDATE: &str = "plugin_update";

/// Build the `ctx.event` payload for a [`ON_PLUGIN_UPDATE`] hook. Every field is
/// set by Core, so a hook can trust it.
pub fn plugin_update_event(
    plugin_id: &str,
    from_version: &str,
    to_version: &str,
    reason: &str,
) -> serde_json::Value {
    serde_json::json!({
        "source": ON_PLUGIN_UPDATE,
        "plugin_id": plugin_id,
        "from_version": from_version,
        "to_version": to_version,
        "reason": reason,
    })
}

/// The `plugin_update` hooks `plugin_id` owns, in dispatch order. Pure so the
/// own-plugin-only guarantee is unit-testable.
pub fn plugin_update_hooks_for(hooks: Vec<HookPlugin>, plugin_id: &str) -> Vec<HookPlugin> {
    hooks
        .into_iter()
        .filter(|hook| hook.plugin_id == plugin_id && phase_matches(&hook.on, ON_PLUGIN_UPDATE))
        .collect()
}

/// Run `plugin_id`'s own [`ON_PLUGIN_UPDATE`] hooks after its version changed.
/// Fail-open (a failing migration hook is logged, never undoes the update) and
/// filtered to the app-event directive policy. Returns the surviving directives.
pub async fn dispatch_plugin_update(
    state: &ServerState,
    plugin_id: &str,
    from_version: &str,
    to_version: &str,
    reason: &str,
) -> Vec<HookDirective> {
    if !tool_exec::is_available() || !any_manifest_declares(state, ON_PLUGIN_UPDATE).await {
        return Vec::new();
    }
    let hooks = plugin_update_hooks_for(collect_enabled_hooks(state).await, plugin_id);
    if hooks.is_empty() {
        return Vec::new();
    }
    let ctx = HookContext {
        event: Some(plugin_update_event(
            plugin_id,
            from_version,
            to_version,
            reason,
        )),
        ..Default::default()
    };
    run_hooks(state, &ctx, &hooks, ON_PLUGIN_UPDATE)
        .await
        .into_iter()
        .filter(app_event_directive_allowed)
        .collect()
}

/// Fire a workflow-run lifecycle hook DETACHED, with `payload` in
/// [`HookContext::event`].
///
/// Detached for the same reason [`ON_POST_TOOL_USE`] is: the executor is the hot
/// path for every automation on the node, and a hook must not be able to slow a run
/// down — let alone fail one. Callers are sync-friendly (this spawns rather than
/// awaiting), which is what lets it be called from the executor without
/// restructuring it.
pub fn fire_workflow_run_event(phase: &'static str, payload: serde_json::Value) {
    let payload = redact_script_run_event(payload);
    // A hook's tool calls are sub-turns of the run's turn: carry its streak
    // attribution across the spawn.
    let attribution = crate::profile_activity::current_attribution();
    tokio::spawn(crate::profile_activity::with_attribution(
        attribution,
        async move {
            let ctx = HookContext {
                event: Some(payload),
                ..Default::default()
            };
            let _ = dispatch_global(phase, ctx).await;
        },
    ));
}

/// Strip the result and error text from a lifecycle payload for an ad-hoc
/// script run (`sr-…`). Those runs belong to the plugin + agent + conversation
/// that started them and are read back only through a scoped
/// `host.workflowRunStatus`; a global observer hook still learns that the run
/// started and ended, but not what it produced.
fn redact_script_run_event(mut payload: serde_json::Value) -> serde_json::Value {
    let is_script_run = payload
        .get("run_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| id.starts_with(crate::workflow::script::SCRIPT_RUN_PREFIX));
    if is_script_run {
        if let Some(fields) = payload.as_object_mut() {
            fields.remove("output");
            fields.remove("error");
        }
    }
    payload
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
/// sandbox runs. 64 KiB is far above any real event and far below anything that
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
/// into a pager. An app-event hook that genuinely warrants telling a human uses
/// `host.notify` (the `notifications:send` grant: one bounded notification for the
/// active user); an app's sidecar uses the `notify.deliver` kernel capability, which
/// needs `notifications:send-to-user` to reach anyone but the active user. The
/// external-channel `notify.fanout` capability is NOT available to hooks or other
/// apps: it stays pinned to `@ryu/monitors`.
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

/// An activity-feed row an app attaches to an `events.emit` call (the body's
/// `activity` field). The app owns the wording; Core owns attribution: `source` is
/// derived from the authenticated caller, never read from here.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AppEventActivity {
    /// The row's class (`meeting`, `quest`, …), `[a-z0-9_.-]{1,64}`.
    pub kind: String,
    /// The row's headline.
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    /// `info` | `success` | `warning` (default `info`).
    #[serde(default)]
    pub level: Option<String>,
    /// A small JSON object of ids the desktop can deep-link with.
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

const MAX_ACTIVITY_TITLE_BYTES: usize = 512;
const MAX_ACTIVITY_BODY_BYTES: usize = 4 * 1024;
const MAX_ACTIVITY_METADATA_BYTES: usize = 4 * 1024;

/// The activity source an app's rows are attributed to: the name half of a scoped
/// id (`@ryu/meetings` → `meetings`), or a flat id verbatim. Derived from the
/// authenticated caller so it matches the per-app source the feed already filters on.
#[must_use]
pub fn activity_source_for(plugin_id: &str) -> &str {
    plugin_id.rsplit('/').next().unwrap_or(plugin_id)
}

/// Build the [`ryu_activity::ActivityItem`] for an app's `events.emit` activity hint,
/// or explain why the hint is refused. Pure, so the bounds and the attribution rule
/// are unit-testable.
///
/// # Errors
/// A malformed kind, an empty/oversized title, an oversized body, an unknown level,
/// or metadata that is not a small JSON object.
pub fn app_event_activity_item(
    plugin_id: &str,
    event: &str,
    hint: &AppEventActivity,
) -> Result<ryu_activity::ActivityItem, String> {
    let kind_ok = !hint.kind.is_empty()
        && hint.kind.len() <= 64
        && hint
            .kind
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-'));
    if !kind_ok {
        return Err("activity.kind must match [a-z0-9_.-]{1,64}".to_owned());
    }
    let title = hint.title.trim();
    if title.is_empty() || title.len() > MAX_ACTIVITY_TITLE_BYTES {
        return Err("activity.title must be 1..=512 bytes".to_owned());
    }
    if hint
        .body
        .as_ref()
        .is_some_and(|b| b.len() > MAX_ACTIVITY_BODY_BYTES)
    {
        return Err("activity.body exceeds 4 KiB".to_owned());
    }
    let level = match hint.level.as_deref().unwrap_or("info") {
        "info" => ryu_activity::ActivityLevel::Info,
        "success" => ryu_activity::ActivityLevel::Success,
        "warning" => ryu_activity::ActivityLevel::Warning,
        other => return Err(format!("activity.level '{other}' is not supported")),
    };
    let mut metadata = match &hint.metadata {
        None => serde_json::json!({}),
        Some(v @ serde_json::Value::Object(_)) => {
            if serde_json::to_vec(v).map_or(usize::MAX, |b| b.len()) > MAX_ACTIVITY_METADATA_BYTES {
                return Err("activity.metadata exceeds 4 KiB".to_owned());
            }
            v.clone()
        }
        Some(_) => return Err("activity.metadata must be a JSON object".to_owned()),
    };
    metadata["event"] = serde_json::Value::String(event.to_owned());
    Ok(ryu_activity::ActivityItem::new(
        hint.kind.clone(),
        activity_source_for(plugin_id),
        title.to_owned(),
    )
    .with_body(hint.body.clone())
    .with_level(level)
    .with_metadata(metadata))
}

/// Record an app's `events.emit` activity hint on the unified activity feed.
/// Best-effort: a refused hint or a failed write is logged, never propagated.
pub async fn record_app_event_activity(
    state: &ServerState,
    plugin_id: &str,
    event: &str,
    hint: &AppEventActivity,
) {
    match app_event_activity_item(plugin_id, event, hint) {
        Ok(item) => {
            if let Err(e) = state.activity.record(item).await {
                tracing::warn!(plugin = %plugin_id, event, "activity: failed to record app event: {e:#}");
            }
        }
        Err(reason) => {
            tracing::warn!(plugin = %plugin_id, event, "events.emit: activity hint refused: {reason}");
        }
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
    // Kernel events (`core#…`) are Core-originated only. The loader already makes
    // them undeclarable (and the owner id unclaimable); this is the runtime belt.
    if owner == crate::plugin_manifest::KERNEL_EVENT_OWNER || owner != plugin_id {
        return false;
    }
    let manifests = state.app_manifests.read().await;
    manifests
        .iter()
        .find(|m| m.id == plugin_id)
        .and_then(|m| m.contributes.as_ref())
        .is_some_and(|c| c.hook_events.iter().any(|e| e.id == event))
}

// ── View actions (the `view_action` phase) ──────────────────────────────────

/// What relaying one `view.action` intent to the owning plugin produced.
#[derive(Debug, Clone, PartialEq)]
pub enum ViewActionOutcome {
    /// The plugin declares no enabled `view_action` hook.
    NoHandler,
    /// The sandbox backend that runs hooks is not available on this node.
    Unavailable,
    /// Every matching hook ran and returned [`HookDirective::None`].
    Declined { hook_ids: Vec<String> },
    /// At least one hook acted; `messages` are its `Note` texts (possibly empty).
    Handled {
        hook_ids: Vec<String>,
        messages: Vec<String>,
    },
}

/// The `view_action` hooks `plugin_id` owns, in dispatch order. Pure so the
/// own-plugin-only guarantee is unit-testable: another plugin's hook on the same
/// phase is never selected.
pub fn view_action_hooks_for(hooks: Vec<HookPlugin>, plugin_id: &str) -> Vec<HookPlugin> {
    hooks
        .into_iter()
        .filter(|hook| hook.plugin_id == plugin_id && phase_matches(&hook.on, ON_VIEW_ACTION))
        .collect()
}

/// Build the `ctx.event` payload for a `view_action` hook from the relayed
/// `view.action` args. Only the documented fields are forwarded, and `source` is
/// always set by Core so a hook can trust it.
pub fn view_action_event(args: &serde_json::Value) -> serde_json::Value {
    let field = |key: &str| args.get(key).cloned().unwrap_or(serde_json::Value::Null);
    serde_json::json!({
        "source": ON_VIEW_ACTION,
        "view_id": field("view_id"),
        "action_id": field("action_id"),
        "intent": field("intent"),
        "payload": field("payload"),
        "values": field("values"),
        "item": field("item"),
    })
}

/// Fold the directives returned by `view_action` hooks into an outcome. Only
/// `None`/`Note` are meaningful off the chat path (the app-event policy); any
/// other directive still counts as "acted" but contributes no message.
pub fn view_action_outcome(
    hook_ids: Vec<String>,
    directives: &[HookDirective],
) -> ViewActionOutcome {
    if hook_ids.is_empty() {
        return ViewActionOutcome::NoHandler;
    }
    let acted: Vec<&HookDirective> = directives
        .iter()
        .filter(|directive| !matches!(directive, HookDirective::None))
        .collect();
    if acted.is_empty() {
        return ViewActionOutcome::Declined { hook_ids };
    }
    let messages = acted
        .into_iter()
        .filter_map(|directive| match directive {
            HookDirective::Note { text } if !text.trim().is_empty() => Some(text.clone()),
            _ => None,
        })
        .collect();
    ViewActionOutcome::Handled { hook_ids, messages }
}

/// Relay a `view.action` intent to `plugin_id`'s own `view_action` hooks.
///
/// * **Own hooks only** — `plugin_id` comes from the HTTP path, never the body.
/// * **No privilege gain** — each hook runs with the intersection of its manifest
///   grants and the Gateway-approved grants the caller already validated.
/// * The verified caller is carried so the hook's storage/notifications stay
///   tenant-scoped exactly as on the chat path.
pub async fn dispatch_view_action(
    state: &ServerState,
    plugin_id: &str,
    approved_grants: &HashSet<String>,
    caller: Option<crate::identity_verify::VerifiedCaller>,
    args: &serde_json::Value,
) -> ViewActionOutcome {
    let mut hooks = view_action_hooks_for(collect_enabled_hooks(state).await, plugin_id);
    if hooks.is_empty() {
        return ViewActionOutcome::NoHandler;
    }
    if !tool_exec::is_available() {
        return ViewActionOutcome::Unavailable;
    }
    for hook in &mut hooks {
        hook.grants.retain(|grant| approved_grants.contains(grant));
    }
    let ctx = HookContext {
        caller_user_id: caller.as_ref().map(|c| c.user_id.clone()),
        verified_caller: caller,
        event: Some(view_action_event(args)),
        ..Default::default()
    };
    let hook_ids = hooks.iter().map(|hook| hook.hook_id.clone()).collect();
    let directives = run_hooks(state, &ctx, &hooks, ON_VIEW_ACTION).await;
    view_action_outcome(hook_ids, &directives)
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

/// A saved approval cannot outlive the app's current declaration ceiling.
pub(crate) async fn current_approved_grants(
    state: &ServerState,
    plugin_id: &str,
    approved: &[String],
) -> HashSet<String> {
    let manifests = state.app_manifests.read().await;
    manifests
        .iter()
        .find(|manifest| manifest.id == plugin_id)
        .map(|manifest| {
            manifest
                .approved_permission_grants(approved)
                .into_iter()
                .collect()
        })
        .unwrap_or_default()
}

/// Collect hooks with live approvals intersected with their current declarations.
pub async fn collect_enabled_hooks(state: &ServerState) -> Vec<HookPlugin> {
    let enabled_ids: std::collections::HashMap<String, Vec<String>> =
        match state.app_store.list().await {
            Ok(records) => records
                .into_iter()
                .filter(|r| r.enabled)
                .map(|r| (r.id, r.approved_grants))
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
    collect_hooks_from_manifests(&manifests, &enabled_ids, &hook_overrides)
}

fn collect_hooks_from_manifests(
    manifests: &[crate::plugin_manifest::PluginManifest],
    enabled_ids: &std::collections::HashMap<String, Vec<String>>,
    hook_overrides: &std::collections::BTreeMap<String, crate::governance::HookPolicyOverride>,
) -> Vec<HookPlugin> {
    let mut hooks = Vec::new();
    for manifest in manifests.iter() {
        let Some(approved_grants) = enabled_ids.get(&manifest.id) else {
            continue;
        };
        let Some(contributes) = &manifest.contributes else {
            continue;
        };
        if contributes.turn_hooks.is_empty() {
            continue;
        }
        let grants: HashSet<String> = manifest
            .approved_permission_grants(approved_grants)
            .into_iter()
            .collect();
        for hook in &contributes.turn_hooks {
            let hook_key = format!("{}::{}", manifest.id, hook.id);
            let trusted_by_default = crate::plugins::builtins::is_exact_compiled_manifest(manifest);
            if !hook_policy_allows(hook_overrides.get(&hook_key), trusted_by_default) {
                continue;
            }
            hooks.push(HookPlugin {
                plugin_id: manifest.id.clone(),
                hook_id: hook.id.clone(),
                on: hook.on.clone(),
                mode: hook.mode.unwrap_or_default(),
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

    let mut middleware_ctx = ctx.clone();
    middleware_ctx.tool_output = Some(current.clone());
    if let HookDirective::Transform { output } =
        run_middleware_chain(state, &hooks, ON_TOOL_RESULT, &middleware_ctx).await
    {
        current = output;
        transformed = true;
    }

    for hook in hooks {
        if hook.mode != crate::plugin_manifest::HookMode::Directive
            || !phase_matches(&hook.on, ON_TOOL_RESULT)
        {
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

/// The continuation exposed to a middleware hook. It stays inside Core: the
/// sandbox can ask to continue, but it never receives another plugin's bridge or
/// source code.
type MiddlewareNext =
    Arc<dyn Fn(HookContext) -> Pin<Box<dyn Future<Output = HookDirective> + Send>> + Send + Sync>;

/// Request-owned fields that a middleware hook may observe but must not rewrite
/// for the next plugin. In particular, `caller_user_id` is the tenant boundary
/// used by the host bridge's namespaced storage.
#[derive(Clone)]
struct MiddlewareIdentity {
    agent_id: Option<String>,
    caller_user_id: Option<String>,
    conversation_id: Option<String>,
    flags: std::collections::HashMap<String, bool>,
    verified_caller: Option<crate::identity_verify::VerifiedCaller>,
}

impl From<&HookContext> for MiddlewareIdentity {
    fn from(ctx: &HookContext) -> Self {
        Self {
            agent_id: ctx.agent_id.clone(),
            caller_user_id: ctx.caller_user_id.clone(),
            conversation_id: ctx.conversation_id.clone(),
            flags: ctx.flags.clone(),
            verified_caller: ctx.verified_caller.clone(),
        }
    }
}

fn preserve_middleware_identity(
    identity: &MiddlewareIdentity,
    mut ctx: HookContext,
) -> HookContext {
    ctx.agent_id = identity.agent_id.clone();
    ctx.caller_user_id = identity.caller_user_id.clone();
    ctx.conversation_id = identity.conversation_id.clone();
    ctx.flags = identity.flags.clone();
    ctx.verified_caller = identity.verified_caller.clone();
    ctx
}

enum MiddlewareRun {
    Returned(HookDirective),
    Failed,
}

/// Run the middleware hooks for one phase as an onion. The first hook in the
/// deterministic priority order is the outermost layer. A skipped gate and a
/// failed hook route around that layer; an explicit return without `next` owns
/// the result, matching the Koa-style semantics the function-hook pattern is
/// designed for.
async fn run_middleware_chain(
    state: &ServerState,
    hooks: &[HookPlugin],
    phase: &str,
    ctx: &HookContext,
) -> HookDirective {
    if !hooks.iter().any(|hook| {
        hook.mode == crate::plugin_manifest::HookMode::Middleware && phase_matches(&hook.on, phase)
    }) {
        return HookDirective::None;
    }
    let hooks = Arc::new(hooks.to_vec());
    run_middleware_at(
        state.clone(),
        hooks,
        phase.to_owned(),
        0,
        Arc::new(MiddlewareIdentity::from(ctx)),
        ctx.clone(),
    )
    .await
}

fn run_middleware_at(
    state: ServerState,
    hooks: Arc<Vec<HookPlugin>>,
    phase: String,
    start: usize,
    identity: Arc<MiddlewareIdentity>,
    ctx: HookContext,
) -> Pin<Box<dyn Future<Output = HookDirective> + Send>> {
    Box::pin(async move {
        let Some(index) = (start..hooks.len()).find(|index| {
            let hook = &hooks[*index];
            hook.mode == crate::plugin_manifest::HookMode::Middleware
                && phase_matches(&hook.on, &phase)
        }) else {
            return HookDirective::None;
        };
        let hook = hooks[index].clone();
        if !hook_should_run(&state, &hook, &ctx).await {
            return run_middleware_at(state, hooks, phase, index + 1, identity, ctx).await;
        }

        let next_state = state.clone();
        let next_hooks = hooks.clone();
        let next_phase = phase.clone();
        let next_identity = identity.clone();
        let next: MiddlewareNext = Arc::new(move |next_ctx| {
            let next_ctx = preserve_middleware_identity(&next_identity, next_ctx);
            run_middleware_at(
                next_state.clone(),
                next_hooks.clone(),
                next_phase.clone(),
                index + 1,
                next_identity.clone(),
                next_ctx,
            )
        });

        match run_middleware_hook(&state, &hook, &ctx, next).await {
            MiddlewareRun::Returned(directive) => directive,
            // A broken middleware link must not silence the hooks below it. This is
            // the fail-open equivalent of the normal directive-hook runner.
            MiddlewareRun::Failed => {
                run_middleware_at(state, hooks, phase, index + 1, identity, ctx).await
            }
        }
    })
}

fn restrict_hook_grants(declared: &HashSet<String>, approved: &[String]) -> HashSet<String> {
    declared
        .iter()
        .filter(|grant| approved.contains(grant))
        .cloned()
        .collect()
}

async fn current_hook_grants(state: &ServerState, hook: &HookPlugin) -> Option<HashSet<String>> {
    match state.app_store.get_record(&hook.plugin_id).await {
        Ok(Some(record)) if record.enabled => {
            Some(restrict_hook_grants(&hook.grants, &record.approved_grants))
        }
        Ok(_) => None,
        Err(error) => {
            tracing::warn!(plugin = %hook.plugin_id, %error, "plugin_host: could not verify current hook grants");
            None
        }
    }
}

async fn run_middleware_hook(
    state: &ServerState,
    hook: &HookPlugin,
    ctx: &HookContext,
    next: MiddlewareNext,
) -> MiddlewareRun {
    let Some(_runtime_lease) = state.plugin_runtime.acquire(&hook.plugin_id).await else {
        return MiddlewareRun::Failed;
    };
    let Some(grants) = current_hook_grants(state, hook).await else {
        return MiddlewareRun::Failed;
    };
    let Some(breaker_permit) = breaker::allow(&hook.plugin_id, &hook.hook_id) else {
        return MiddlewareRun::Failed;
    };
    let program = build_middleware_hook_program(ctx, &hook.code);
    let bridge = Arc::new(
        PluginHookBridge::new_for_request(
            hook.plugin_id.clone(),
            grants,
            state.clone(),
            ctx.verified_caller.clone(),
            ctx.conversation_id.clone(),
        )
        .with_calling_agent(ctx.agent_id.clone())
        .with_middleware_next(next),
    );
    let invoker = Arc::new(SandboxToolInvoker::bridge(bridge));
    let agent_id = ctx
        .agent_id
        .clone()
        .unwrap_or_else(|| "plugin-host".to_string());

    match tool_exec::run_sandboxed_warm(program, invoker, &agent_id, &hook.plugin_id).await {
        ExecOutcome::Completed {
            result: _,
            logs,
            is_error,
            error,
        } if is_error => {
            emit_hook_logs(hook, &logs);
            let error = error.unwrap_or_default();
            tracing::warn!(
                "plugin_host: middleware hook {}::{} errored: {}",
                hook.plugin_id,
                hook.hook_id,
                error
            );
            breaker_permit.record_failure(&error);
            MiddlewareRun::Failed
        }
        ExecOutcome::Completed { result, logs, .. } => {
            emit_hook_logs(hook, &logs);
            breaker_permit.record_success();
            MiddlewareRun::Returned(parse_directive(result.as_ref()))
        }
        ExecOutcome::Paused { .. } => {
            tracing::warn!(
                "plugin_host: middleware hook {}::{} paused (unsupported for hooks); ignoring",
                hook.plugin_id,
                hook.hook_id
            );
            breaker_permit.record_failure("paused (unsupported)");
            MiddlewareRun::Failed
        }
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
    let middleware = run_middleware_chain(state, hooks, phase, ctx).await;
    if !matches!(middleware, HookDirective::None) {
        directives.push(middleware);
    }
    // Directive hooks of one phase are independent plugins, and each run is a
    // separate sandbox process, so they run concurrently: the turn waits for the
    // slowest hook instead of the sum of all of them. `join_all` keeps hook order,
    // so the directives come back exactly as a sequential loop would return them.
    let runs = hooks
        .iter()
        .filter(|hook| {
            hook.mode == crate::plugin_manifest::HookMode::Directive
                && phase_matches(&hook.on, phase)
        })
        .map(|hook| async move {
            // Cheap pre-gate: skip the sandbox spawn when the hook provably can't
            // act this turn. This is what makes pre-installed hooks free on the
            // hot path.
            if hook_should_run(state, hook, ctx).await {
                run_hook(state, hook, ctx).await
            } else {
                HookDirective::None
            }
        });
    directives.extend(
        futures_util::future::join_all(runs)
            .await
            .into_iter()
            .filter(|directive| !matches!(directive, HookDirective::None)),
    );
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
            if let Some(cadence) = &m.reply_cadence {
                if reply_cadence_due(&state.preferences, cadence, ctx, &hook.grants).await {
                    return true;
                }
            }
            if !m.stateful {
                return false;
            }
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
    /// Nothing matched yet but a condition needs a read — the plugin's KV state
    /// or the preferences behind a reply cadence — so the caller decides.
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

    if m.stateful || m.reply_cadence.is_some() {
        return GateVerdict::CheckStateful;
    }

    // A match block with no recognised condition means "always run".
    if declared {
        GateVerdict::Skip
    } else {
        GateVerdict::Run
    }
}

/// Read the preferences behind a [`ReplyCadence`] and decide whether this turn
/// is due. A preference that cannot be read counts as unset; a credential key is
/// never read and makes the gate run the hook (fail-open, like the KV gate).
async fn reply_cadence_due(
    preferences: &crate::server::preferences::PreferencesStore,
    cadence: &crate::plugin_manifest::ReplyCadence,
    ctx: &HookContext,
    grants: &HashSet<String>,
) -> bool {
    // Match the bridge's preference capability before observing node state.
    if !grants.contains("preferences:read") {
        return reply_cadence_matches(
            cadence,
            ctx.transcript
                .iter()
                .filter(|m| m.role == "assistant")
                .count(),
            None,
            None,
            None,
        );
    }
    async fn read(
        preferences: &crate::server::preferences::PreferencesStore,
        key: Option<&str>,
    ) -> Result<Option<String>, ()> {
        let Some(key) = key.filter(|key| !key.is_empty()) else {
            return Ok(None);
        };
        if crate::server::preferences::is_secret_preference_key(key) {
            return Err(());
        }
        Ok(preferences.get(key).await.ok().flatten())
    }
    let (Ok(enabled), Ok(every), Ok(first)) = (
        read(preferences, cadence.enabled_pref.as_deref()).await,
        read(preferences, cadence.every_pref.as_deref()).await,
        read(preferences, cadence.first_pref.as_deref()).await,
    ) else {
        return true;
    };
    let replies = ctx
        .transcript
        .iter()
        .filter(|message| message.role == "assistant")
        .count();
    reply_cadence_matches(
        cadence,
        replies,
        enabled.as_deref(),
        every.as_deref(),
        first.as_deref(),
    )
}

/// The pure cadence rule, written to agree with a hook body that reads the same
/// preferences with JavaScript's `parseInt`: leading integer, below 1 or
/// unreadable falls back to the default, above 100 clamps to 100.
fn reply_cadence_matches(
    cadence: &crate::plugin_manifest::ReplyCadence,
    replies: usize,
    enabled: Option<&str>,
    every: Option<&str>,
    first: Option<&str>,
) -> bool {
    if enabled == Some("false") || replies == 0 {
        return false;
    }
    let fallback = cadence.every_default.clamp(1, 100) as usize;
    let every = every
        .filter(|value| !value.is_empty())
        .and_then(leading_integer)
        .filter(|n| *n >= 1)
        .map_or(fallback, |n| n.min(100) as usize);
    let first_on = cadence.first_reply && first != Some("false");
    (replies == 1 && first_on) || replies % every == 0
}

/// `parseInt`-style: optional whitespace and sign, then the leading digits.
fn leading_integer(value: &str) -> Option<i64> {
    let trimmed = value.trim_start();
    let (sign, digits) = match trimmed.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, trimmed.strip_prefix('+').unwrap_or(trimmed)),
    };
    let end = digits
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(digits.len());
    digits[..end].parse::<i64>().ok().map(|n| sign * n)
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

/// Run one hook in the sandbox and parse its directive. Any failure (sandbox
/// unavailable, hook threw, unparseable result, a Pause we don't support) degrades to
/// [`HookDirective::None`].
pub async fn run_hook(state: &ServerState, hook: &HookPlugin, ctx: &HookContext) -> HookDirective {
    if hook.mode == crate::plugin_manifest::HookMode::Middleware {
        let next: MiddlewareNext = Arc::new(|_ctx| Box::pin(async { HookDirective::None }));
        return match run_middleware_hook(state, hook, ctx, next).await {
            MiddlewareRun::Returned(directive) => directive,
            MiddlewareRun::Failed => HookDirective::None,
        };
    }

    // Hold the plugin's read lease across the sandbox call. A concurrent disable
    // waits for this work before unregistering the plugin's contributions; a
    // hook collected before disable but not started yet is refused instead of
    // running against a stale generation.
    let Some(_runtime_lease) = state.plugin_runtime.acquire(&hook.plugin_id).await else {
        return HookDirective::None;
    };
    let Some(grants) = current_hook_grants(state, hook).await else {
        return HookDirective::None;
    };
    let Some(breaker_permit) = breaker::allow(&hook.plugin_id, &hook.hook_id) else {
        return HookDirective::None;
    };
    let program = build_hook_program(ctx, &hook.code);
    let bridge = Arc::new(
        PluginHookBridge::new_for_request(
            hook.plugin_id.clone(),
            grants,
            state.clone(),
            ctx.verified_caller.clone(),
            ctx.conversation_id.clone(),
        )
        .with_calling_agent(ctx.agent_id.clone()),
    );
    let invoker = Arc::new(SandboxToolInvoker::bridge(bridge));
    let agent_id = ctx
        .agent_id
        .clone()
        .unwrap_or_else(|| "plugin-host".to_string());

    match tool_exec::run_sandboxed_warm(program, invoker, &agent_id, &hook.plugin_id).await {
        ExecOutcome::Completed {
            result,
            logs,
            is_error,
            error,
        } => {
            emit_hook_logs(hook, &logs);
            if is_error {
                let error = error.unwrap_or_default();
                tracing::warn!(
                    "plugin_host: hook {}::{} errored: {}",
                    hook.plugin_id,
                    hook.hook_id,
                    error
                );
                breaker_permit.record_failure(&error);
                return HookDirective::None;
            }
            breaker_permit.record_success();
            parse_directive(result.as_ref())
        }
        ExecOutcome::Paused { .. } => {
            tracing::warn!(
                "plugin_host: hook {}::{} paused (unsupported for hooks); ignoring",
                hook.plugin_id,
                hook.hook_id
            );
            breaker_permit.record_failure("paused (unsupported)");
            HookDirective::None
        }
    }
}

/// Most `host.log` lines surfaced per hook run.
const MAX_HOOK_LOG_LINES: usize = 20;
/// Longest `host.log` line surfaced (in chars); longer lines are truncated.
const MAX_HOOK_LOG_LINE_CHARS: usize = 1024;

/// Bounded view of a hook run's captured `host.log` output: at most
/// [`MAX_HOOK_LOG_LINES`] lines of at most [`MAX_HOOK_LOG_LINE_CHARS`] chars,
/// control characters (other than tab) stripped so a hook cannot forge log
/// lines. Returns the kept lines and how many were dropped.
fn bounded_hook_logs(logs: &[String]) -> (Vec<String>, usize) {
    let kept = logs
        .iter()
        .take(MAX_HOOK_LOG_LINES)
        .map(|line| {
            let mut out: String = line
                .chars()
                .filter(|c| *c == '\t' || !c.is_control())
                .take(MAX_HOOK_LOG_LINE_CHARS)
                .collect();
            if line.chars().count() > MAX_HOOK_LOG_LINE_CHARS {
                out.push('…');
            }
            out
        })
        .collect();
    (kept, logs.len().saturating_sub(MAX_HOOK_LOG_LINES))
}

/// Surface a hook's captured `host.log` lines through tracing, tagged with the
/// plugin and hook id, so hook authors can debug from the Core log.
fn emit_hook_logs(hook: &HookPlugin, logs: &[String]) {
    if logs.is_empty() {
        return;
    }
    let (lines, dropped) = bounded_hook_logs(logs);
    for line in lines {
        tracing::info!(
            target: "ryu_core::plugin_hook_log",
            plugin = %hook.plugin_id,
            hook = %hook.hook_id,
            "{line}"
        );
    }
    if dropped > 0 {
        tracing::info!(
            target: "ryu_core::plugin_hook_log",
            plugin = %hook.plugin_id,
            hook = %hook.hook_id,
            dropped,
            "host.log output truncated"
        );
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
    build_hook_program_inner(ctx, entry_code, false)
}

/// Build a middleware hook program. The user function receives a Core-mediated
/// `next` continuation; the continuation calls back into the bridge, which owns
/// the remaining hook chain and its per-plugin capability boundaries.
fn build_middleware_hook_program(ctx: &HookContext, entry_code: &str) -> String {
    let entry = format!(
        "const __ryu_function_hook = async (ctx, host, next) => {{ {entry_code} }};\nreturn await __ryu_function_hook(ctx, host, (nextCtx) => tools.host.next({{ context: nextCtx ?? ctx }}));"
    );
    build_hook_program_inner(ctx, &entry, true)
}

fn build_hook_program_inner(ctx: &HookContext, entry_code: &str, freeze_context: bool) -> String {
    let ctx_json = serde_json::to_string(ctx).unwrap_or_else(|_| "{}".to_string());
    let ctx_expression = if freeze_context {
        format!("__ryu_deep_freeze({ctx_json})")
    } else {
        ctx_json
    };
    format!(
        r#"const __ryu_deep_freeze = (value) => {{
  if (value && typeof value === "object" && !Object.isFrozen(value)) {{
    for (const child of Object.values(value)) __ryu_deep_freeze(child);
    Object.freeze(value);
  }}
  return value;
}};
const ctx = {ctx};
const host = {{
  sideModel: (a) => tools.host.sideModel(a ?? {{}}),
  runAgent: (a) => tools.host.runAgent(a ?? {{}}),
  runFanout: (a) => tools.host.runFanout(a ?? {{}}),
  reactions: {{
    add: (a) => tools.host.addMessageReaction(a ?? {{}}),
  }},
  notify: (a) => tools.host.notify(a ?? {{}}),
  setConversationTitle: (a) => tools.host.setConversationTitle(a ?? {{}}),
  getPreference: (a) => tools.host.getPreference(a ?? {{}}),
  background: {{
    list: (a) => tools.host.background_list(a ?? {{}}),
    stop: (a) => tools.host.background_stop(a ?? {{}}),
  }},
  usage: (a) => tools.host.usageSnapshot(a ?? {{}}),
  subscriptions: {{
    list: (a) => tools.host.subscriptions_list(a ?? {{}}),
    usage: (a) => tools.host.subscriptions_usage(a ?? {{}}),
  }},
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
    createDatabase: (a) => tools.host.spaces_create_database(a ?? {{}}),
    listDatabases: (a) => tools.host.spaces_list_databases(a ?? {{}}),
    getDatabase: (a) => tools.host.spaces_get_database(a ?? {{}}),
    updateDatabase: (a) => tools.host.spaces_update_database(a ?? {{}}),
    queryDatabase: (a) => tools.host.spaces_query_database(a ?? {{}}),
    deleteDatabase: (a) => tools.host.spaces_delete_database(a ?? {{}}),
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
        ctx = ctx_expression,
        entry = entry_code,
    )
}

#[cfg(test)]
mod hooks_runtime_tests;

#[cfg(test)]
mod agent_comms_delivery_runtime_test;

#[cfg(test)]
mod agent_comms_storage_bridge_test;

#[cfg(test)]
mod chat_title_runtime_test;

#[cfg(test)]
mod agent_react_runtime_test;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_run_lifecycle_events_carry_no_result_or_error() {
        let script_run = serde_json::json!({
            "run_id": "sr-0123", "workflow_id": "script-abc", "status": "completed",
            "error": "agent said: secret", "output": { "result": "secret" },
        });
        let redacted = redact_script_run_event(script_run);
        assert_eq!(
            redacted,
            serde_json::json!({
                "run_id": "sr-0123", "workflow_id": "script-abc", "status": "completed",
            })
        );

        // User workflow runs keep their full payload.
        let workflow_run = serde_json::json!({
            "run_id": "run-1", "status": "failed", "error": "boom", "output": { "k": "v" },
        });
        assert_eq!(redact_script_run_event(workflow_run.clone()), workflow_run);
    }

    #[test]
    fn hook_logs_are_bounded_and_sanitized() {
        let mut logs: Vec<String> = (0..MAX_HOOK_LOG_LINES + 5)
            .map(|i| format!("line {i}"))
            .collect();
        logs[0] = format!(
            "forged\nINFO other\u{1b}[31m{}",
            "x".repeat(MAX_HOOK_LOG_LINE_CHARS * 2)
        );
        let (kept, dropped) = bounded_hook_logs(&logs);
        assert_eq!(kept.len(), MAX_HOOK_LOG_LINES);
        assert_eq!(dropped, 5);
        assert!(!kept[0].contains('\n') && !kept[0].contains('\u{1b}'));
        assert!(kept[0].ends_with('…'));
        assert_eq!(kept[0].chars().count(), MAX_HOOK_LOG_LINE_CHARS + 1);
        assert_eq!(kept[1], "line 1");
    }

    fn view_hook(plugin_id: &str, hook_id: &str, on: &str) -> HookPlugin {
        HookPlugin {
            plugin_id: plugin_id.to_owned(),
            hook_id: hook_id.to_owned(),
            on: on.to_owned(),
            mode: crate::plugin_manifest::HookMode::default(),
            priority: 0,
            code: "return null;".to_owned(),
            grants: HashSet::new(),
            run_when: None,
        }
    }

    #[test]
    fn plugin_update_selects_only_the_updated_plugins_hooks() {
        let hooks = vec![
            view_hook("@acme/tasks", "migrate", ON_PLUGIN_UPDATE),
            view_hook("@acme/tasks", "title", ON_POST_ASSISTANT_TURN),
            view_hook("@other/app", "spy", ON_PLUGIN_UPDATE),
        ];
        let ids: Vec<String> = plugin_update_hooks_for(hooks, "@acme/tasks")
            .into_iter()
            .map(|hook| hook.hook_id)
            .collect();
        assert_eq!(ids, vec!["migrate"]);
        let event = plugin_update_event("@acme/tasks", "1.0.0", "2.0.0", "rollback");
        assert_eq!(event["source"], ON_PLUGIN_UPDATE);
        assert_eq!(event["from_version"], "1.0.0");
        assert_eq!(event["to_version"], "2.0.0");
        assert_eq!(event["reason"], "rollback");
    }

    #[test]
    fn view_action_selects_only_the_owning_plugins_view_hooks() {
        let hooks = vec![
            view_hook("@acme/tasks", "on-view", ON_VIEW_ACTION),
            view_hook("@acme/tasks", "title", ON_POST_ASSISTANT_TURN),
            view_hook("@other/app", "steal", ON_VIEW_ACTION),
        ];
        let selected = view_action_hooks_for(hooks, "@acme/tasks");
        let ids: Vec<&str> = selected.iter().map(|h| h.hook_id.as_str()).collect();
        assert_eq!(ids, vec!["on-view"]);
        assert!(view_action_hooks_for(
            vec![view_hook("@other/app", "steal", ON_VIEW_ACTION)],
            "@acme/tasks"
        )
        .is_empty());
    }

    #[test]
    fn view_action_event_forwards_only_documented_fields() {
        let event = view_action_event(&serde_json::json!({
            "view_id": "board",
            "action_id": "archive",
            "intent": "archive",
            "payload": { "id": 7 },
            "item": { "id": "7" },
            "source": "spoofed",
            "extra": true,
        }));
        assert_eq!(event["source"], ON_VIEW_ACTION);
        assert_eq!(event["view_id"], "board");
        assert_eq!(event["action_id"], "archive");
        assert_eq!(event["payload"]["id"], 7);
        assert_eq!(event["values"], serde_json::Value::Null);
        assert!(event.get("extra").is_none());
    }

    #[test]
    fn view_action_outcome_distinguishes_missing_declined_and_handled() {
        assert_eq!(
            view_action_outcome(vec![], &[]),
            ViewActionOutcome::NoHandler
        );
        assert_eq!(
            view_action_outcome(vec!["h".to_owned()], &[]),
            ViewActionOutcome::Declined {
                hook_ids: vec!["h".to_owned()]
            }
        );
        assert_eq!(
            view_action_outcome(
                vec!["h".to_owned()],
                &[
                    HookDirective::Note {
                        text: "Archived".to_owned()
                    },
                    HookDirective::Note {
                        text: "  ".to_owned()
                    },
                ]
            ),
            ViewActionOutcome::Handled {
                hook_ids: vec!["h".to_owned()],
                messages: vec!["Archived".to_owned()],
            }
        );
    }

    #[test]
    fn hook_grants_never_use_unapproved_declared_capabilities() {
        let declared = HashSet::from(["storage:kv".to_string(), "preferences:read".to_string()]);
        assert_eq!(
            restrict_hook_grants(
                &declared,
                &[
                    "preferences:read".to_string(),
                    "hook:side-model".to_string()
                ]
            ),
            HashSet::from(["preferences:read".to_string()])
        );
        assert!(restrict_hook_grants(&declared, &[]).is_empty());
        assert_eq!(
            restrict_hook_grants(&declared, &["storage:kv".to_string()]),
            HashSet::from(["storage:kv".to_string()])
        );
    }
    #[test]
    fn hook_collection_uses_current_approved_grants_and_exact_compiled_trust() {
        let original = crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
            .into_iter()
            .find(|m| {
                m.contributes
                    .as_ref()
                    .is_some_and(|c| !c.turn_hooks.is_empty())
            })
            .expect("compiled hook manifest");
        let mut enabled = std::collections::HashMap::from([(
            original.id.clone(),
            vec![original
                .permission_grants
                .first()
                .expect("declared hook grant")
                .clone()],
        )]);
        let overrides = std::collections::BTreeMap::new();
        let trusted =
            collect_hooks_from_manifests(std::slice::from_ref(&original), &enabled, &overrides);
        assert!(!trusted.is_empty());
        assert!(trusted
            .iter()
            .all(|h| h.grants == HashSet::from([original.permission_grants[0].clone()])));
        enabled.insert(original.id.clone(), Vec::new());
        let revoked =
            collect_hooks_from_manifests(std::slice::from_ref(&original), &enabled, &overrides);
        assert!(revoked.iter().all(|h| h.grants.is_empty()));
        let mut changed = original.clone();
        changed.permission_grants.push("hook:run-agent".to_owned());
        assert!(
            collect_hooks_from_manifests(std::slice::from_ref(&changed), &enabled, &overrides)
                .is_empty()
        );
        let overrides = changed
            .contributes
            .as_ref()
            .unwrap()
            .turn_hooks
            .iter()
            .map(|h| {
                (
                    format!("{}::{}", changed.id, h.id),
                    crate::governance::HookPolicyOverride {
                        enabled: Some(true),
                        trusted: Some(true),
                    },
                )
            })
            .collect();
        let explicitly_trusted =
            collect_hooks_from_manifests(std::slice::from_ref(&changed), &enabled, &overrides);
        assert!(!explicitly_trusted.is_empty());
        assert!(explicitly_trusted.iter().all(|h| h.grants.is_empty()));
        enabled.clear();
        assert!(collect_hooks_from_manifests(&[changed], &enabled, &overrides).is_empty());
    }

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
    fn hint(kind: &str, title: &str) -> AppEventActivity {
        AppEventActivity {
            kind: kind.to_owned(),
            title: title.to_owned(),
            body: None,
            level: None,
            metadata: None,
        }
    }

    #[test]
    fn app_event_activity_is_attributed_to_the_authenticated_caller() {
        let mut h = hint("meeting", "Meeting started: Standup");
        h.level = Some("success".to_owned());
        h.metadata = Some(serde_json::json!({ "meeting_id": "mtg_1" }));
        let item =
            app_event_activity_item("@ryu/meetings", "@ryu/meetings#meeting.started", &h).unwrap();
        assert_eq!(item.source, "meetings");
        assert_eq!(item.kind, "meeting");
        assert_eq!(item.title, "Meeting started: Standup");
        assert_eq!(item.level, ryu_activity::ActivityLevel::Success);
        assert_eq!(item.metadata["meeting_id"], "mtg_1");
        assert_eq!(item.metadata["event"], "@ryu/meetings#meeting.started");
        assert_eq!(activity_source_for("com.acme.flat"), "com.acme.flat");
    }

    #[test]
    fn app_event_activity_hint_is_bounded() {
        for bad in [
            hint("Meeting", "t"),
            hint("", "t"),
            hint("meeting", "   "),
            hint("meeting", &"x".repeat(513)),
            AppEventActivity {
                body: Some("x".repeat(5000)),
                ..hint("meeting", "t")
            },
            AppEventActivity {
                level: Some("panic".to_owned()),
                ..hint("meeting", "t")
            },
            AppEventActivity {
                metadata: Some(serde_json::json!(["not", "an", "object"])),
                ..hint("meeting", "t")
            },
        ] {
            assert!(app_event_activity_item("@ryu/meetings", "e#x", &bad).is_err());
        }
    }

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
    fn channel_actions_and_interactive_directives_cross_the_hook_boundary() {
        let action = ryu_channel_contracts::ChannelActionEvent {
            action_id: "review.approve".into(),
            label: "Approve".into(),
            payload: json!({ "requestId": "req-42" }),
        };
        let context = HookContext {
            channel_action: Some(action),
            ..Default::default()
        };
        let context_json = serde_json::to_value(context).unwrap();
        assert_eq!(context_json["channel_action"]["actionId"], "review.approve");
        assert_eq!(
            context_json["channel_action"]["payload"]["requestId"],
            "req-42"
        );

        let markup = json!({
            "layout": "inline",
            "rows": [[{
                "label": "Approve",
                "action": {
                    "type": "callback",
                    "actionId": "review.approve",
                    "payload": { "requestId": "req-42" }
                }
            }]]
        });
        assert_eq!(
            parse_directive(Some(
                &json!({ "kind": "interactive_message", "markup": markup })
            )),
            HookDirective::InteractiveMessage {
                markup: serde_json::from_value(markup).unwrap(),
            }
        );
        assert!(matches!(
            parse_directive(Some(&json!({
                "kind": "handled",
                "text": "Approval recorded.",
                "interactive_markup": {
                    "layout": "reply_keyboard",
                    "rows": [[{
                        "label": "View status",
                        "action": { "type": "reply" }
                    }]]
                }
            }))),
            HookDirective::Handled {
                interactive_markup: Some(_),
                ..
            }
        ));
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
    fn middleware_program_injects_a_core_owned_next_continuation() {
        let program = build_middleware_hook_program(
            &HookContext::default(),
            "return await next({ ...ctx, event: { forwarded: true } });",
        );
        assert!(program.contains("__ryu_function_hook"));
        assert!(program.contains("__ryu_deep_freeze"));
        assert!(program.contains("(ctx, host, next)"));
        assert!(program.contains("tools.host.next"));
        assert!(program.contains("event: { forwarded: true }"));
    }

    #[test]
    fn middleware_next_preserves_request_identity_and_plugin_flags() {
        let root = HookContext {
            agent_id: Some("agent-a".into()),
            caller_user_id: Some("user-a".into()),
            conversation_id: Some("conversation-a".into()),
            flags: std::iter::once(("plugin-a".to_owned(), true)).collect(),
            ..Default::default()
        };
        let identity = MiddlewareIdentity::from(&root);
        let candidate = HookContext {
            agent_id: Some("agent-b".into()),
            caller_user_id: Some("user-b".into()),
            conversation_id: Some("conversation-b".into()),
            flags: std::iter::once(("plugin-b".to_owned(), true)).collect(),
            event: Some(json!({ "rewritten": true })),
            ..Default::default()
        };
        let forwarded = preserve_middleware_identity(&identity, candidate);
        assert_eq!(forwarded.agent_id.as_deref(), Some("agent-a"));
        assert_eq!(forwarded.caller_user_id.as_deref(), Some("user-a"));
        assert_eq!(forwarded.conversation_id.as_deref(), Some("conversation-a"));
        assert_eq!(forwarded.flags.get("plugin-a"), Some(&true));
        assert_eq!(forwarded.event, Some(json!({ "rewritten": true })));
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

    fn cadence(first_reply: bool) -> crate::plugin_manifest::ReplyCadence {
        crate::plugin_manifest::ReplyCadence {
            every_pref: Some("auto-title-every-n".into()),
            every_default: 5,
            first_reply,
            first_pref: Some("auto-title-on-first-turn".into()),
            enabled_pref: Some("auto-title-enabled".into()),
        }
    }

    #[tokio::test]
    async fn cadence_requires_approved_preference_read_before_observing_settings() {
        let directory = tempfile::tempdir().unwrap();
        let preferences = crate::server::preferences::PreferencesStore::open(
            directory.path().join("preferences.db"),
        )
        .unwrap();
        let cadence = cadence(true);
        let context = ctx_with(Some("fixture"), &[]);
        let unapproved = HashSet::new();
        preferences
            .set("auto-title-enabled", "false")
            .await
            .unwrap();
        assert!(reply_cadence_due(&preferences, &cadence, &context, &unapproved).await);
        let approved = HashSet::from(["preferences:read".to_owned()]);
        assert!(!reply_cadence_due(&preferences, &cadence, &context, &approved).await);
        preferences.set("auto-title-enabled", "true").await.unwrap();
        assert!(reply_cadence_due(&preferences, &cadence, &context, &unapproved).await);
        assert!(reply_cadence_due(&preferences, &cadence, &context, &approved).await);
    }

    /// Mirrors `chat-title`'s `rename.js`: the gate may only skip a turn the hook
    /// itself would have returned `none` for.
    #[test]
    fn reply_cadence_agrees_with_the_chat_title_hook() {
        let c = cadence(true);
        // No completed reply yet, or turned off: never.
        assert!(!reply_cadence_matches(&c, 0, None, None, None));
        assert!(!reply_cadence_matches(&c, 5, Some("false"), None, None));
        // First reply, then every 5th by default.
        assert!(reply_cadence_matches(&c, 1, None, None, None));
        assert!(!reply_cadence_matches(&c, 2, None, None, None));
        assert!(reply_cadence_matches(&c, 5, None, None, None));
        assert!(reply_cadence_matches(&c, 10, Some("true"), None, None));
        // First-reply trigger switched off.
        assert!(!reply_cadence_matches(&c, 1, None, None, Some("false")));
        // parseInt semantics for N.
        assert!(reply_cadence_matches(&c, 3, None, Some("3"), None));
        assert!(reply_cadence_matches(&c, 7, None, Some("7 turns"), None));
        assert!(
            reply_cadence_matches(&c, 5, None, Some("0"), None),
            "below 1 -> default"
        );
        assert!(
            reply_cadence_matches(&c, 5, None, Some("abc"), None),
            "NaN -> default"
        );
        assert!(
            reply_cadence_matches(&c, 5, None, Some(""), None),
            "empty -> default"
        );
        assert!(
            reply_cadence_matches(&c, 100, None, Some("250"), None),
            "clamped to 100"
        );
        assert!(!reply_cadence_matches(&c, 250, None, Some("250"), None));
        assert!(
            reply_cadence_matches(&c, 4, None, Some("1"), None),
            "every turn"
        );
        // A hook that never runs on the first reply.
        assert!(!reply_cadence_matches(&cadence(false), 1, None, None, None));
    }

    #[test]
    fn a_reply_cadence_defers_to_the_stored_gate() {
        let m = HookMatch {
            reply_cadence: Some(cadence(true)),
            ..Default::default()
        };
        assert_eq!(
            gate_without_storage(&m, &ctx_with(None, &[])),
            GateVerdict::CheckStateful
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
        // Off / absent flag → skip (double-check must not run a sandbox every turn).
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
    fn fixture_hook_from_file(plugin: &str, hook_id: &str) -> String {
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
                text: "Security Scanner state cleared for this conversation.".into(),
                interactive_markup: None,
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
