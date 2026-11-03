//! The phase names a hook can declare in its `on` field.

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
