use super::*;

/// Incoming request body from the UI (matches Vercel AI SDK v6 UIMessage format).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatStreamRequest {
    /// Messages in `{ role, content }` form — the UI sends these as UIMessage parts.
    #[serde(default)]
    pub messages: Vec<UiMessage>,
    /// Which agent to route to. The id is resolved against the [`AcpAgentRegistry`]
    /// (`find_by_prefix`) and the agent's stored binding decides the adapter:
    ///   "zeroclaw*"    → ZeroClaw, local OpenAI-compatible server (port 42617)
    ///   "openclaw"     → OpenClaw, native ACP bridge (`openclaw acp`)
    ///   "hermes"       → Hermes Agent, native ACP (`hermes acp`)
    ///   "acp:*"        → an ACP subprocess agent (Claude Code, Codex, Gemini, Pi,
    ///                    and the self-fetching ACP-registry agents)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Presentation guidance for the flagship Ryu assistant. Missing values
    /// default to everyday language; this never changes capabilities or policy.
    #[serde(default)]
    pub response_mode: RyuResponseMode,
    /// OpenAI-compatible model pin selected for this turn. ACP model selection
    /// uses [`Self::acp_model`] instead; keeping both fields lets the same
    /// composer target either transport without silently dropping the pin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Server-resolved context handoff for this turn (a model change summarized
    /// the earlier history; see `context_handoff`). Never accepted from the wire.
    #[serde(skip)]
    pub context_handoff: Option<context_handoff::ContextHandoff>,
    /// Server-captured incarnation before any history or agent preparation awaits.
    /// Outer None means uncaptured; Some(None) means an ephemeral target.
    #[serde(skip)]
    pub acp_conversation_generation: Option<Option<String>>,

    /// Optional durable harness session binding. Core resolves this to the
    /// session's conversation and runnable before loading history, so external
    /// callers cannot accidentally run a different agent inside the session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Saved chats explicitly attached to this turn through an `@Chat` mention.
    /// Core loads their recent transcript as read-only labeled context; the ids
    /// are never treated as routing targets or merged into this conversation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub referenced_conversation_ids: Vec<String>,
    /// Optional server-validated Composio connection scope used by the
    /// onboarding profile builder. `None` preserves normal agent behavior;
    /// `Some(empty)` deliberately denies every Composio action for a profile
    /// that selected no connected accounts.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub composio_connection_scope: Option<Vec<ComposioConnectionBinding>>,
    /// Optional server-owned conversation search ceiling for profile bootstrap.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub profile_conversation_scope: Option<Vec<String>>,
    /// Opt-in long-term (cross-session) memory (spec unit U11). When `true`,
    /// prior durable facts for this user/agent are injected as context and the
    /// current turn is recorded for future sessions. Defaults to `false` per
    /// the privacy-by-default principle.
    #[serde(default)]
    pub enable_long_term: bool,
    /// User-selected working directory for this run (M1 git-native workspace).
    /// With `worktree_isolation`, Core allocates a per-run git worktree from it so
    /// the agent never mutates the user's main checkout mid-run; without, the ACP
    /// session is rooted here instead of the Core process cwd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// All source folders in the selected desktop project. The first folder is
    /// `cwd`; remaining folders become additional ACP workspace roots.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace_folders: Vec<String>,
    /// When `true` (and `cwd` resolves to a git repo), Core creates an isolated
    /// `ryu/run-<id>` worktree for the ACP session and removes it on completion.
    /// Defaults to `false` — non-git directories or opt-out callers get the plain
    /// `cwd` (or `current_dir()` when `cwd` is absent) passed directly.
    #[serde(default)]
    pub worktree_isolation: bool,
    /// Git branch active at run start (M1). Populated by clients that track the
    /// active workspace; stored on the conversation row for the runs list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Per-run worktree path (M1). Set by clients that create a dedicated
    /// worktree for this run; stored for later resume/apply. When worktree
    /// isolation is active, Core overwrites this with the allocated worktree path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// Desired isolated-worktree branch name (M1, persistent-session). Applied only
    /// when Core *creates* the conversation's worktree (first turn, or after apply),
    /// sanitized and made collision-safe; ignored when an existing worktree is
    /// reused. `None` ⇒ auto-named `ryu/run-<id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    /// The selected Ryu-local project environment. Setup/cleanup hooks are used
    /// only for newly-created isolated worktrees; variables also reach the ACP child.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_environment: Option<ProjectEnvironmentRequest>,
    /// Published cloud template. Credentials and execution policy are resolved by Core.
    #[serde(
        default,
        rename = "cloudEnvironmentId",
        skip_serializing_if = "Option::is_none"
    )]
    pub cloud_environment_id: Option<String>,
    #[serde(skip)]
    pub(crate) cloud_authorization: Option<Arc<crate::server::ResolvedAuthorization>>,
    #[serde(skip)]
    pub(crate) cloud_task_context: Option<crate::server::cloud_tasks::CloudTaskContext>,
    /// True when this chat request originates from the context companion
    /// (screen-capture path, M7 / #199). When set, Core forwards the
    /// `x-ryu-companion-source: true` header to the Gateway so Gateway DLP/PII
    /// redaction fires unconditionally before the provider call.
    #[serde(default)]
    pub companion_source: bool,
    /// Client-owned tool schemas (currently browser tools). Core offers these to
    /// compatible providers only when the caller also grants browser-context
    /// consent; execution remains on the client boundary.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub client_tools: Vec<Value>,
    /// Per-turn consent gate for page-derived context and client tool results.
    #[serde(default)]
    pub browser_context_consent: bool,
    /// Browser surface metadata used for audit/session linking, never as a route.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub browser_surface: Option<String>,
    /// Route this specific message to a particular agent within a multi-agent
    /// conversation (#414). When set, Core validates the agent is a participant
    /// in the conversation (auto-adding it if needed) and uses that agent's
    /// config for this turn. When absent, the conversation's primary `agent_id`
    /// governs routing (backward compatible).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_agent_id: Option<String>,
    /// Route this message to an **agent team** (a named collection of agents +
    /// a coordination strategy). When set, the request is dispatched to
    /// [`route_team_chat_stream`] instead of the single-agent path: the team's
    /// members are run per the team's coordination strategy (broadcast /
    /// round-robin / debate-synthesis / router) and their replies are merged
    /// into one attributed SSE stream. `agent_id`/`target_agent_id` are ignored
    /// when this is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// Route this message to a **workflow** (a DAG of typed nodes) via
    /// [`route_workflow_chat_stream`] instead of the single-agent / team paths: the
    /// user message is its initial input, per-node progress streams back as
    /// `data-ryu-workflow` parts, and the run's output is the assistant reply. Only
    /// workflows accepting chat input (`crate::workflow::accepts_chat_input`) run
    /// here; others get an error stream. Overrides `agent_id`/`target_agent_id`/`team_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_id: Option<String>,
    /// Whether to persist this turn to the conversation store (default `true`).
    /// The team orchestrator sets `false` on per-member sub-requests so member
    /// replies are *not* double-persisted: it records the user turn once plus one
    /// combined assistant turn attributed to the team, so the streamed view and a
    /// later reload match.
    #[serde(default = "default_persist")]
    pub persist: bool,
    /// Core-owned one-shot runtime request. Keep the transcript and permission
    /// scope, but release the ACP process after this turn rather than pooling it.
    #[serde(skip)]
    pub fresh_session: bool,
    /// Skip persisting the incoming user turn but still persist the assistant
    /// reply. Set by the version-tree edit/regenerate re-run: the edit route already
    /// created the user sibling (and pointed the active leaf at it), or a regenerate
    /// has no new user turn, so re-appending the last user message would duplicate
    /// it. Default `false` (normal turns append it). Independent of `persist`:
    /// `persist = false` skips the whole turn; this skips only the user row.
    #[serde(default)]
    pub skip_user_append: bool,
    /// Opaque one-shot ticket for a Core-validated widget follow-up. The wire
    /// value is only a lookup handle; provenance is recovered server-side.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widget_follow_up_ticket: Option<String>,
    /// Core-verified widget provenance. Never deserialized from the client.
    #[serde(skip)]
    pub widget_provenance: Option<crate::server::widgets::VerifiedWidgetProvenance>,
    /// Core-owned next-turn target accepted from the running agent. This is
    /// populated after the normal model-router pass and is emitted as a data
    /// part by the selected stream adapter; clients cannot provide it.
    #[serde(skip)]
    pub agent_control_applied: Option<crate::agent_control::AgentControlApplied>,
    /// Per-request inference / sampling override (temperature, top_p, top_k, …).
    /// Merged on top of the agent's stored [`crate::agents::AgentRecord::inference`]
    /// defaults (request wins per field) and applied to the OpenAI-compat body,
    /// translated for the bound engine. `None` leaves the agent defaults in force.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inference: Option<crate::inference::SamplingConfig>,
    /// Internal caller-owned ceiling for generated output. Unlike `inference`,
    /// this is never relaxed by an agent's stored defaults: routing takes the
    /// stricter of the two values. Used by delegated turns so a registered agent
    /// cannot escape the fan-out budget through its own configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens_cap: Option<u32>,
    /// ACP session **permission mode** to apply for this turn (e.g. `plan`,
    /// `acceptEdits`, `bypassPermissions`). Agent-reported via `session/new`
    /// (see `GET /api/agents/:id/acp-config`); Ryu hardcodes no mode strings.
    /// Re-applied each turn since ACP sessions are per-turn. Ignored by non-ACP
    /// routes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_mode: Option<String>,
    /// ACP session **config options** to apply for this turn, as
    /// `{ config_id: value_id }` — e.g. a reasoning-effort / `thought_level`
    /// selector. Agent-reported; applied via `session/set_config_option`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_config: Option<std::collections::HashMap<String, String>>,
    /// ACP session **model** id to select for this turn (unstable ACP
    /// capability; ignored if the agent doesn't advertise model selection).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_model: Option<String>,
    /// Core set this when the model/effort came from a node lane default. Lane
    /// defaults are resolved per request and must not rewrite the shared Pi
    /// configuration; explicit composer picks retain their historical behavior.
    #[serde(skip)]
    pub lane_default: bool,
    /// True for programmatic background work (sub-agent fan-out, background worker,
    /// scheduled/triggered run), not a user-facing turn. Sent to the Gateway as
    /// `x-ryu-priority: background` so the local-engine admission queue serves
    /// interactive turns first when the resident engine's batch slots are full.
    /// Default `false` (interactive). NB: only Core-made gateway calls (default /
    /// openai-compat route) carry it; ACP agents (Pi/flagship) call providers
    /// themselves, so they get concurrency limiting but default-interactive priority
    /// (same ACP egress-bypass class as the other `x-ryu-*` headers).
    #[serde(default)]
    pub background: bool,
    /// Per-request plugin flags set by the client (e.g. a composer toggle):
    /// `{ "io.ryu.double-check": true }`. The plugin turn-hook runtime
    /// ([`crate::plugin_host`]) passes these to each `post_assistant_turn` hook so
    /// a plugin reads its own flag to decide whether to act this turn. Empty by
    /// default (no hook acts on a flag it cannot see).
    #[serde(default)]
    pub plugin_flags: std::collections::HashMap<String, bool>,
    /// Output style for THIS turn: an explicit one-turn override of the agent's
    /// persisted personality profile (the desktop editor saves the profile on the
    /// agent; API callers may still need a deliberate, ephemeral override).
    /// Per-turn is the point: upstream Claude Code reads the style once at session
    /// start and needs `/clear`; Ryu resolves it at turn assembly (design §7.1), so
    /// a switch applies on the next message with no reload or new conversation. An
    /// unknown id (style deleted or plugin disabled since the picker's last fetch)
    /// falls through to the next tier instead of erroring: losing the styling beats
    /// losing the turn. A plugin style with `force-for-plugin: true` overrides this
    /// (design §5); the field is a *preference*, not a guarantee.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_style: Option<String>,
    /// Verified human author of this turn's user message: the Better Auth user id
    /// from the request's user JWT (`crate::identity_verify`). SERVER-SET ONLY:
    /// `chat_stream` stamps it from the verified caller and `#[serde(skip)]` keeps
    /// it off the wire, so a client body can never set or spoof it. Threaded into
    /// the user-row `append_message` so each persisted message records who sent it,
    /// distinct from `agent_id` (the AI agent). `None` in the single-tenant /
    /// loopback (anonymous) flow, preserving current behavior.
    #[serde(skip)]
    pub author_user_id: Option<String>,
    /// Full verified caller kept inside Core for hook-side authorization. It is
    /// never serialized into an adapter request or exposed to the model.
    #[serde(skip)]
    pub verified_caller: Option<crate::identity_verify::VerifiedCaller>,
    /// Opaque UUID shared by the realtime join and this HTTP mutation. Core
    /// validates and stamps it only for local-echo correlation, never for auth.
    #[serde(skip)]
    pub client_id: Option<String>,
    /// Connector-supplied sender display name (e.g. Telegram first name, Discord
    /// username) for group/channel chats. SERVER-SET ONLY (`#[serde(skip)]`): a
    /// client body can neither set nor spoof it. Unlike `author_user_id` it is NOT
    /// a verified identity and never used for auth; it reaches the user-row
    /// `append_message` only so a multi-participant thread can record who said
    /// what. `None` for 1:1 / anonymous turns.
    #[serde(skip)]
    pub author_name: Option<String>,
    /// Verified raw user JWT for the server-owned ACP/Pi child process. This is
    /// never accepted from or serialized to the client; `chat_stream` copies it
    /// from the authenticated request extension so the child can preserve the
    /// same caller partition for background-process operations.
    #[serde(skip)]
    pub user_jwt: Option<String>,
    /// Core-only ceiling for a management-issued public A2A principal. The A2A
    /// API constructs this after authentication; request JSON cannot set it.
    #[serde(skip)]
    pub(crate) public_agent_policy: Option<PublicAgentRunPolicy>,
    /// Core-only read-only tool ceiling for an app-started streaming `agent.run`
    /// whose app holds `hook:run-agent` but not `hook:run-agent:write`
    /// (`server::plugin_bridge_api::plugin_bridge_stream`). When set, the turn runs
    /// only on a Core-governed route, is offered only `readOnlyHint: true` tools,
    /// and gets no client or Composio tools. Request JSON cannot set or read it.
    #[serde(skip)]
    pub(crate) read_only_tools: bool,
    /// Core-only restriction for a turn spoken by an unverified outside party (an
    /// inbound phone caller the line does not list as trusted). Only the voice
    /// session sets it, from the Gateway's `caller_trusted: false` start frame;
    /// request JSON can neither set nor clear it. Such a turn keeps only
    /// the tools in [`UNTRUSTED_CALLER_TOOL_ALLOWLIST`], runs on a route where
    /// Core or its Gateway hop decides every tool call, and leaves the owner's
    /// memory, personalization, skills and connected accounts out of context.
    #[serde(skip)]
    pub(crate) untrusted_caller: bool,
    /// Core-only final resource authorization. This is populated by the HTTP
    /// chat entry point and intentionally absent for agent-less internal work.
    /// It is never serialized into an adapter request or exposed to a model.
    #[serde(skip)]
    pub(crate) agent_resource_authorization: Option<Arc<AgentResourceAuthorization>>,
    /// Context that changes from turn to turn (recalled memory, provider prefetch,
    /// referenced chats), assembled by `route_chat_stream` and delivered after the
    /// stable prefix instead of inside the system block. SERVER-SET ONLY.
    ///
    /// Kept out of the system block because providers cache a prompt by its
    /// prefix: a system block that changes every turn misses the cache from the
    /// first token, on every turn, for the whole conversation.
    #[serde(skip)]
    pub(crate) turn_context: Option<String>,
    /// The part of [`Self::turn_context`] chosen for this turn's message (memory
    /// provider prefetch, auto-recall, referenced chats), without the recent-memory
    /// window. A live ACP session keeps its own transcript, so its later turns get
    /// only this: the recent-memory window already arrived with its first prompt.
    /// SERVER-SET ONLY.
    #[serde(skip)]
    pub(crate) turn_query_context: Option<String>,
}
