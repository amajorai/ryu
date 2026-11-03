//! Hook inputs and outputs: the turn context, directives and hook descriptors.

use super::*;

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
