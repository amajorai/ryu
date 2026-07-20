//! DAG workflow engine for Ryu Core.
//!
//! A workflow is a directed acyclic graph (DAG) of typed nodes. Nodes are
//! connected by edges that carry data and (optionally) a branch label so a
//! `Condition` node can fork execution down a `true`/`false` path.
//!
//! This module owns the *definition* and *graph* layer:
//!   - [`Workflow`] — the persisted definition (nodes + edges).
//!   - [`NodeKind`] — the typed node kinds. Data/logic (Input, Output, Prompt,
//!     Condition, Transform, SetState, Delay, Note, While, Guardrails, Webhook),
//!     orchestration (SubWorkflow, AgentDelegate, Awakeable), desktop automation
//!     (Recipe, GhostAction), and the **Runnable** nodes that run any executable
//!     Ryu object as a step: Agent, Skill, Mcp, and Plugin.
//!   - [`WorkflowGraph`] — a validated petgraph DAG built from a [`Workflow`].
//!
//! Per the Core-vs-Gateway rule this is **Core**: it decides *what runs*
//! (which node, in what order). It never enforces policy; a `Prompt` node hands
//! its model call to the normal chat routing path.
//!
//! Durable execution lives on this engine directly (Restate was dropped): the
//! in-process topological executor checkpoints file-backed, resumable run state
//! after every node and every `While` loop iteration, so a run survives a Core
//! restart and resumes from the last completed node. See [`durable`] for the
//! engine seam and [`executor`] for the loop/HITL semantics.

pub mod delegation;
pub mod durable;
pub mod channel_send;
pub mod executor;
pub mod notify_user;
pub mod store;
pub mod template;
pub mod templates;
pub mod triggers;

pub use executor::{fail_run, rerun_run, resume_run};

use std::collections::HashMap;

use petgraph::algo::is_cyclic_directed;
use petgraph::graph::{DiGraph, NodeIndex};
use serde::{Deserialize, Serialize};

/// The kind of a workflow node. Each variant carries the config it needs to run.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum NodeKind {
    /// Entry node: surfaces a named value from the run's initial input map.
    Input {
        /// Key to read from the run input. Defaults to the node id when absent.
        #[serde(default)]
        key: Option<String>,
    },
    /// Terminal node: records its incoming value into the run output map.
    Output {
        /// Key to write into the run output. Defaults to the node id when absent.
        #[serde(default)]
        key: Option<String>,
    },
    /// Calls an LLM with a prompt template, hands the model call to chat routing.
    Prompt {
        /// Prompt template. `{{input}}` is replaced with the incoming value.
        prompt: String,
        /// Optional agent id to route to (defaults to the built-in plain LLM).
        #[serde(default)]
        agent_id: Option<String>,
    },
    /// Branches on a boolean expression evaluated against the incoming value.
    Condition {
        /// A simple expression, e.g. `input == "yes"`, `input contains "ok"`,
        /// `input != ""`. See [`executor::eval_condition`].
        expr: String,
    },
    /// Pure data transform on the incoming value.
    Transform {
        /// Operation name: `uppercase`, `lowercase`, `trim`, `json_parse`,
        /// `template` (uses `template` field), or `identity`.
        op: String,
        /// Template body for the `template` op; `{{input}}` is substituted.
        #[serde(default)]
        template: Option<String>,
    },
    /// Invokes a Core tool/sidecar through the MCP registry.
    Tool {
        /// Fully-qualified tool id (`<server>__<tool>`, e.g. `spider__crawl`).
        /// A bare server name with no `__` is rejected at run time.
        name: String,
        /// Free-form JSON args passed to the tool.
        #[serde(default)]
        args: serde_json::Value,
    },
    /// Calls a specific tool on a named MCP server — the explicit two-field form
    /// of [`NodeKind::Tool`]. `server` and `tool` are joined into the
    /// `<server>__<tool>` id the MCP registry expects, so authors pick a server
    /// and a tool separately instead of hand-assembling the compound id. The
    /// upstream `input` and a stable idempotency key are folded into the call
    /// exactly as for a `Tool` node; `args` string leaves are templates
    /// (`{{input}}`, `{{nodes.<id>}}`, `{{state.<key>}}`, `{{trigger.*}}`).
    Mcp {
        /// The MCP server name (e.g. `spider`, `ghost`, `skills`).
        server: String,
        /// The tool name on that server (e.g. `crawl`, `ghost_click`).
        tool: String,
        /// Free-form JSON args passed to the tool.
        #[serde(default)]
        args: serde_json::Value,
    },
    /// Posts the incoming value to an external URL (fire-and-forward webhook).
    Webhook {
        url: String,
        #[serde(default = "default_webhook_method")]
        method: String,
    },
    /// Writes a value into the run's `state` map under `key`, then passes the
    /// incoming input through unchanged to outgoing edges. The `value` is a
    /// template resolved against the current context (so it can capture an
    /// upstream node's output, `{{input}}`, prior state, or a trigger field).
    /// Readable downstream as `{{state.<key>}}`.
    SetState { key: String, value: String },
    /// Pauses execution for a fixed number of milliseconds, as a **durable
    /// timer**. On first reaching the node the executor computes and persists a
    /// `wake_at` instant ([`store::NodeRunState::wake_at`]) and checkpoints
    /// before sleeping, so a Core crash mid-sleep resumes with only the
    /// *remaining* time instead of restarting the full delay (Restate/Temporal
    /// durable-timer parity — the timer is journaled, not an in-memory
    /// `setTimeout`).
    Delay { ms: u64 },
    /// Documentation-only annotation. Carries no behaviour: at run time it
    /// forwards its incoming value unchanged to outgoing edges and produces no
    /// run output. Useful for labelling regions of a canvas.
    Note { text: String },
    /// A guarded loop / branch gate. Evaluates `expr` (the same tiny grammar as
    /// [`NodeKind::Condition`], with `{{...}}` tokens resolved first).
    ///
    /// # Two forms
    ///
    /// **1. Real bounded loop (`body_workflow_id` set).** The node re-executes the
    /// named body workflow as long as `expr` holds, up to
    /// [`executor::MAX_WHILE_ITERATIONS`]. Iteration is implemented as recursion
    /// (each iteration runs as its own [`store::WorkflowRun`] via the same path as
    /// [`NodeKind::SubWorkflow`]), so the outer DAG never gains a cycle and DAG
    /// validation is untouched. The **carry** is the loop variable: it is seeded
    /// with the node's incoming value, the condition is evaluated against the carry
    /// (use the `input` keyword, e.g. `input < 10`), and each iteration's body
    /// output replaces the carry. On exit the node produces the final carry as a
    /// plain data value (a looped `While` is a data node, not a brancher — its
    /// single forward edge should be unlabelled). The iteration counter persists to
    /// the run `state` (keyed `state["__while_<id>"]`) and is checkpointed to disk
    /// after every iteration, so a loop survives a Core restart and resumes from
    /// the persisted iteration.
    ///
    /// **At-least-once, not exactly-once:** a side-effecting body node
    /// (Tool/Webhook/GhostAction/Prompt) interrupted mid-call re-runs on resume.
    /// An `Awakeable` gate inside a loop body is rejected in v1 (the node fails with
    /// a clear error); propagating a mid-loop suspend is future work.
    ///
    /// **2. One-shot branch gate (`body_workflow_id` absent — back-compat).** With
    /// no body the node behaves as a `Condition`-style gate: it evaluates `expr`
    /// once and activates only the matching `true`/`false` outgoing edges. The
    /// per-node counter + [`executor::MAX_WHILE_ITERATIONS`] cap still apply but,
    /// under the single-visit traversal, the gate is reached at most once.
    ///
    /// The on-canvas back-edge loop (author draws body→`While` directly on the
    /// graph) is deferred — v1 ships the explicit `body_workflow_id` form where the
    /// loop body is authored as a separate sub-workflow.
    While {
        expr: String,
        /// When set, the id of the workflow run repeatedly as the loop body. When
        /// absent the node is a one-shot branch gate (back-compat).
        #[serde(default)]
        body_workflow_id: Option<String>,
        /// Optional per-node ceiling on loop iterations. Absent = the engine
        /// default [`executor::MAX_WHILE_ITERATIONS`]. Always clamped to that
        /// hard maximum so a workflow can lower the bound but never raise it past
        /// the safety cap (a runaway-loop backstop). Ignored by the one-shot gate
        /// form (`body_workflow_id` absent), which is reached at most once anyway.
        #[serde(default)]
        max_iterations: Option<u64>,
    },
    /// Routes the incoming text through the Gateway firewall (the moat owns
    /// "what is allowed", per the Core-vs-Gateway rule) and fails the run when a
    /// requested guardrail trips. `checks` is the set of guardrails to enforce
    /// (e.g. `["pii", "jailbreak"]`); on PASS the incoming value is forwarded
    /// unchanged. Core enforces no policy locally — it asks the Gateway.
    Guardrails {
        /// Guardrail names to enforce: `pii`, `jailbreak`, `moderation`. Mapped
        /// to the Gateway firewall's scan categories server-side.
        #[serde(default)]
        checks: Vec<String>,
    },
    /// Runs another persisted workflow by id and forwards its output.
    SubWorkflow { workflow_id: String },
    /// Delegates work to one or more sub-agents that run with a clean context
    /// (no parent history), under a permission preset and depth/concurrency/
    /// token/wall-time caps. Same-depth delegates run concurrently. The node's
    /// output is the JSON array of per-delegate results.
    ///
    /// See [`delegation`] for the engine and presets.
    AgentDelegate {
        /// The sibling delegates to fan out. Each gets the node input appended
        /// to its `task` so the delegate sees upstream context as clean input.
        delegates: Vec<delegation::DelegateSpec>,
        /// Optional caps override (concurrency clamped to the hard max).
        #[serde(default)]
        caps: Option<delegation::DelegationCaps>,
    },
    /// Runs a single configured **agent** on a task, routing through the agent
    /// runner (the agent's full engine / gateway / tool / persona path). The
    /// first-class alternative to a [`NodeKind::Prompt`] node: instead of
    /// authoring a raw LLM prompt you pick an installed agent and hand it a task.
    /// Unlike [`NodeKind::AgentDelegate`] this is a *single* in-context step, not
    /// a clean-context fan-out — use it when a workflow step simply *is* "let
    /// agent X handle this". The `task` template is resolved (`{{input}}` + the
    /// full grammar) before the run; when absent the incoming value is the task.
    /// Per the Core-vs-Gateway rule this decides *what runs* (which agent) →
    /// Core; the agent's own model calls stay gateway-governed.
    Agent {
        /// The configured agent id to run.
        agent_id: String,
        /// Task template; `{{input}}` (+ the full grammar) is resolved before the
        /// run. Absent = the incoming value is used verbatim as the task.
        #[serde(default)]
        task: Option<String>,
    },
    /// Applies an Agent **Skill** to the incoming value. The skill's instruction
    /// body (its `SKILL.md`) is loaded from the skills registry and run as the
    /// system context for the step: instructions + the resolved `task` (default
    /// `{{input}}`) are handed to the chosen agent, or to the default gateway LLM
    /// when no `agent_id` is set. Net-new — skills were injectable instruction
    /// text only until now, never a runnable workflow step. Decides *what runs*
    /// (which skill) → Core; the underlying model call stays gateway-governed.
    Skill {
        /// The installed skill id (its `SKILL.md` stem in the skills registry).
        skill: String,
        /// Optional agent to execute the skill under; defaults to the gateway LLM.
        #[serde(default)]
        agent_id: Option<String>,
        /// Task template appended after the skill body. Absent = `{{input}}`.
        #[serde(default)]
        task: Option<String>,
    },
    /// Invokes a Runnable that an installed **plugin** bundles. The plugin's
    /// manifest is resolved by `plugin_id`, its `runnables` are searched for
    /// `runnable_id`, and the entry is dispatched to that kind's execution path:
    /// a `tool` runnable → the MCP registry, an `agent` runnable → the agent
    /// runner, a `workflow` runnable → a sub-workflow run, a `skill` runnable →
    /// the skill path. Non-executable kinds (companion/channel/engine/policy)
    /// are rejected at run time. This is the object-model bridge — a workflow
    /// step that runs any Runnable an app contributes (`AGENTS.md` Runnable
    /// union). Decides *what runs* → Core; every model call stays
    /// gateway-governed. `args` string leaves are templates.
    Plugin {
        /// Installed plugin id (the manifest `id`, e.g. `com.example.my-app`).
        plugin_id: String,
        /// The bundled runnable's id (must exist in the plugin manifest's
        /// `runnables`).
        runnable_id: String,
        /// Free-form JSON args passed to the resolved runnable.
        #[serde(default)]
        args: serde_json::Value,
    },
    /// A durable pause/human-in-the-loop gate — the **Temporal Signal /
    /// Restate Durable Promise** analogue (an external trigger resumes a
    /// suspended run). When the executor reaches this node it suspends the run
    /// (setting status to `AwaitingInput`) and persists to disk. The run resumes
    /// when an external actor calls the resume endpoint
    /// (`POST /workflows/runs/:run_id/resume`) with a payload; the payload
    /// becomes the node's output and execution continues downstream. A suspend
    /// is never treated as a retryable error, so a `retry` policy on this node
    /// does not re-fire the gate.
    ///
    /// # Core-vs-Gateway
    ///
    /// This node decides *what runs* (suspend vs continue) — it lives in Core.
    /// Whether the resumed action is *allowed* is a Gateway concern and is
    /// evaluated when the resumed step makes its model/tool call.
    ///
    /// # Restate mapping
    ///
    /// In a Restate-backed deployment this node maps to a Restate Awakeable: the
    /// executor registers an Awakeable ID, suspends until the ID is completed by
    /// the resume endpoint calling the Restate `awakeable/resolve` API. In the
    /// `FallbackEngine` (default, no Restate) the same semantics are achieved via
    /// the file-backed run store: the run is persisted with `status =
    /// awaiting_input` and resumed by re-invoking `run_workflow` after the gate's
    /// persisted state is flipped to `Completed`.
    Awakeable {
        /// Human-readable prompt sent back to the caller in the suspended run's
        /// state, so the UI can display what input is expected.
        #[serde(default)]
        prompt: Option<String>,
    },
    /// Replays a ghost **recipe** — a parameterized, recorded native-desktop
    /// automation (ghost-os parity: a frontier model records it once, the
    /// workflow runs it forever). The node feeds `params` to `ghost_run` through
    /// the live ghost engine; each value is a template (`{{input}}`,
    /// `{{nodes.<id>}}`, `{{state.<key>}}`, `{{trigger.*}}`) resolved before
    /// replay, so a recorded "send email" recipe can be driven by upstream data.
    /// Decides *what runs* (which recorded actions) → Core, alongside the engine.
    Recipe {
        /// The installed recipe's name (its `~/.ghost/recipes/<name>.json` stem).
        recipe: String,
        /// Parameter map for `{{param}}` substitution. String values are resolved
        /// as templates against the run context before replay.
        #[serde(default)]
        params: serde_json::Value,
    },
    /// Executes a **single** recorded native-desktop action through the ghost
    /// engine — the per-step node that lets a recorded automation appear in the
    /// canvas as a visible flow (one node per click/type/scroll) rather than one
    /// opaque [`NodeKind::Recipe`]. The executor maps `action` to the matching
    /// ghost MCP action tool (`ghost__ghost_click`, `ghost__ghost_type`, …) — the
    /// same primitives the recipe replay loop calls (`apps/ghost/src/tools/recipes.rs`
    /// `execute_step`), so a node behaves identically to that step inside a replay.
    /// String fields of `target`/`params` are templates (`{{input}}`,
    /// `{{nodes.<id>}}`, `{{state.<key>}}`, `{{trigger.*}}`) resolved before the call.
    /// Decides *what runs* (which recorded action) → Core, alongside the engine.
    GhostAction {
        /// The recorded action verb: `click`, `type`, `scroll`, `press`, `hotkey`,
        /// `focus`, `hover`, `long_press`, `drag`, `double_click`, `window`,
        /// `wait`/`delay`/`sleep`, `screenshot`.
        action: String,
        /// The recorded element locator (`{ query, role, identifier, app, dom_id,
        /// dom_class }`). Empty/absent for screen-relative or app-level actions.
        #[serde(default)]
        target: serde_json::Value,
        /// Action parameters (`{ text }` for type, `{ key }` for press,
        /// `{ direction, amount }` for scroll, `{ keys }` for hotkey, …).
        #[serde(default)]
        params: serde_json::Value,
    },
    /// Ping one or more org/workspace members (and teams) across their devices —
    /// the app inbox, the desktop OS toast, and mobile push. `target` resolves to
    /// a set of member user ids via the control plane (the node's bound org).
    ///
    /// `ack_mode` decides the node's shape:
    /// - `None` (default) → **fire-and-forget**: deliver, emit a JSON receipt as
    ///   the node output, and continue downstream.
    /// - `First | All | Quorum` → **HITL gate**: deliver, then suspend the run
    ///   (`AwaitingInput`) until the ack policy is met; each acking member's inbox
    ///   Ack resumes the run once the threshold is reached.
    ///
    /// `title`/`body` are templates (`{{input}}`, `{{nodes.<id>}}`,
    /// `{{state.<key>}}`, `{{trigger.*}}`) resolved before delivery. Core decides
    /// *what runs* (who to ping, whether to wait) → Core; the control plane owns
    /// *who is a member* → resolved over the gateway key.
    NotifyUser {
        /// Who to ping (org roster / a team / explicit members).
        target: NotifyTargetSpec,
        /// Notification title (template-resolved).
        #[serde(default)]
        title: String,
        /// Notification body (template-resolved).
        #[serde(default)]
        body: String,
        /// Acknowledgement policy. Absent/`none` = fire-and-forget.
        #[serde(default)]
        ack_mode: AckMode,
        /// Optional auto-fail timeout for the ack gate (ms). Unused when
        /// `ack_mode` is `None`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ack_timeout_ms: Option<u64>,
    },
    /// Send a message OUT to an external chat channel (Telegram / Slack /
    /// Discord / any HTTP webhook). Unlike [`NodeKind::NotifyUser`] (which pings
    /// org members through the in-app inbox + OS toast + mobile push), this
    /// delivers to a third-party channel addressed by `recipient` (a Telegram
    /// `chat_id` / `@username`, or ignored for URL-encoded webhooks).
    ///
    /// Placement (Core vs Gateway): this decides *what runs* (fire a message on a
    /// node) → Core. The BYO channel credential (`bot_token` / `webhook_url`) is
    /// carried inline on the node, mirroring the swappable-channel shape of
    /// [`ryu_notify::NotifyTarget`], whose send primitives it reuses.
    ///
    /// `recipient`/`text` are templates (`{{input}}`, `{{nodes.<id>}}`,
    /// `{{state.<key>}}`, `{{trigger.*}}`) resolved before delivery.
    ChannelSend {
        /// Which channel transport to use.
        platform: ChannelPlatform,
        /// Where to send (template-resolved). Telegram `chat_id`/`@username`;
        /// ignored for `webhook` (the URL already encodes the destination).
        #[serde(default)]
        recipient: String,
        /// The message body (template-resolved).
        #[serde(default)]
        text: String,
        /// Telegram Bot API token. Required for `platform = "telegram"`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        bot_token: Option<String>,
        /// Incoming-webhook URL. Required for `slack` / `discord` / `webhook`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        webhook_url: Option<String>,
    },
}

/// The channel transport a [`NodeKind::ChannelSend`] node delivers through.
/// Slack and Discord both post to their respective incoming-webhook URLs (Core
/// sends a `text`+`content` body that fits either), so they share the webhook
/// path; Telegram is a direct Bot API `sendMessage`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChannelPlatform {
    Telegram,
    Slack,
    Discord,
    /// Any generic HTTP JSON webhook.
    Webhook,
}

/// Who a [`NodeKind::NotifyUser`] node pings. Resolved to member user ids against
/// the node's bound organization via the control plane.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotifyTargetSpec {
    /// Every member of the node's bound organization.
    Org,
    /// Every member of a specific team within the org.
    Team { team_id: String },
    /// A hand-picked set of member user ids (no roster lookup needed).
    Members { user_ids: Vec<String> },
}

/// The acknowledgement policy of a [`NodeKind::NotifyUser`] HITL gate.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum AckMode {
    /// Fire-and-forget: deliver and continue immediately (no gate).
    #[default]
    None,
    /// Resume as soon as any one targeted member acknowledges.
    First,
    /// Resume only once every targeted member acknowledges.
    All,
    /// Resume once at least `n` members acknowledge.
    Quorum { n: u32 },
}

fn default_webhook_method() -> String {
    "POST".to_string()
}

/// A Temporal-style retry policy for a single node. Optional and opt-in: a node
/// with no policy runs exactly once (the historical behaviour). When present, a
/// retryable error re-runs the node up to `max_attempts` times with exponential
/// backoff between attempts.
///
/// The attempt counter persists in [`store::NodeRunState::attempts`], so the
/// budget is *total* across a Core restart, not per-process. The budget is **per
/// unique node per run**: a `While` loop body is a separate sub-run each
/// iteration, so each iteration spends its own independent budget. An
/// `Awakeable` suspend is never a retryable error. Per the Core-vs-Gateway rule
/// this is **Core**: it decides *what runs* (whether to re-run a step), not policy.
///
/// Defaults (mirroring Temporal's `RetryPolicy`): `backoff_coefficient = 2.0`,
/// `initial_interval_ms = 100`, `max_interval_ms = 60_000`. `max_attempts`
/// defaults to 1 so a bare `"retry": {}` is inert until a caller raises it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RetryPolicy {
    /// Maximum total execution attempts (retries = `max_attempts - 1`). Clamped
    /// to at least 1 at run time. Default 1 (run once, no retries).
    pub max_attempts: u32,
    /// Backoff before the first retry, in milliseconds. Default 100.
    pub initial_interval_ms: u64,
    /// Multiplicative backoff growth per retry. Default 2.0 (exponential):
    /// `interval(n) = min(initial * coefficient^(n-1), max_interval)`.
    pub backoff_coefficient: f64,
    /// Ceiling on the computed backoff interval, in milliseconds. Default 60_000.
    pub max_interval_ms: u64,
    /// Optional bounded jitter as a fraction of the computed backoff, in
    /// `[0.0, 1.0]`. The actual sleep is scattered by `±(jitter_fraction * r)`
    /// to avoid retry storms. Default 0.0 (no jitter); out-of-range = ignored.
    #[serde(default)]
    pub jitter_fraction: f64,
    /// Error substrings (case-insensitive) that must NOT be retried — a fast
    /// fail for known-unrecoverable errors. Substring match, not regex. Default
    /// empty (every error is retryable until the budget is spent).
    #[serde(default)]
    pub non_retryable_errors: Vec<String>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 1,
            initial_interval_ms: 100,
            backoff_coefficient: 2.0,
            max_interval_ms: 60_000,
            jitter_fraction: 0.0,
            non_retryable_errors: Vec::new(),
        }
    }
}

/// A single node in a workflow definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowNode {
    pub id: String,
    #[serde(flatten)]
    pub kind: NodeKind,
    /// Optional Temporal-style retry policy. Absent = run once (back-compat).
    /// Orthogonal to `kind`: any node type may carry one, though it is most
    /// useful on side-effecting nodes (Tool/Webhook/Prompt/GhostAction).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry: Option<RetryPolicy>,
    /// Optional per-node wall-clock execution timeout, in milliseconds (the
    /// Temporal `StartToClose` analogue). When set, a single attempt that
    /// exceeds it is cancelled and surfaced as a *retryable* "timed out" error,
    /// so it composes with `retry`. Absent = unbounded (back-compat).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// A directed edge between two nodes, optionally gated on a branch label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowEdge {
    pub from: String,
    pub to: String,
    /// Branch label. For a `Condition` source, `"true"`/`"false"` selects the
    /// edge to follow. `None` is an unconditional edge.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
}

/// How a workflow is fired. A workflow may declare any number of triggers; the
/// `create_workflow` handler reconciles them into external resources (scheduler
/// jobs, Composio subscriptions) idempotently on every save.
///
/// Per the Core-vs-Gateway rule this is **Core**: it decides *when* a workflow
/// runs. The trigger declaration carries no policy.
///
/// # Why there is no MCP / skill / plugin / app / integration *trigger* arm
///
/// Steps can already *invoke* all of those ([`NodeKind::Mcp`]/[`NodeKind::Tool`],
/// [`NodeKind::Skill`], [`NodeKind::Plugin`], [`NodeKind::Agent`]). A *trigger*,
/// though, needs a source that can **deliver an event to Core**, and only event
/// sources qualify:
/// - **Composio** delivers via a subscription webhook (`composio_triggers`).
/// - A generic **[`WorkflowTrigger::Webhook`]** covers *any* other integration,
///   app, or service that can POST — the universal "beyond Composio" path
///   (`POST /api/workflows/:id/webhook`, HMAC-authenticated per-trigger secret).
///
/// The remaining candidates have no event source to hang a trigger on: skills are
/// instruction text (they emit nothing), there is no plugin runtime yet
/// (design-only, `AGENTS.md` §4), and the MCP servers in the registry are
/// request/response with no push. Adding trigger arms for those would be dead UI
/// wired to nothing. When one genuinely needs to poll, that is already expressible
/// as `Schedule` + a `Tool`/`Mcp` step + a `Condition` (poll-and-diff) — no new
/// trigger kind required. Revisit only when a real push source appears (e.g. MCP
/// resource-subscriptions, or a plugin runtime that emits events).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WorkflowTrigger {
    /// Run only on explicit user action (the canvas "Run now" button or the
    /// `POST /workflows/:id/run` endpoint). No external resource is created.
    Manual,
    /// Run on a schedule. Exactly one of `cron`/`every` should be set; `cron`
    /// wins when both are present. Reconciled into a `ScheduledJob` whose target
    /// is `JobTarget::Workflow`.
    Schedule {
        #[serde(default)]
        cron: Option<String>,
        #[serde(default)]
        every: Option<String>,
        /// When true, each scheduled firing waits for a human-in-the-loop
        /// approval (an inbox request, see [`crate::approvals`]) before the
        /// workflow runs. Off by default (autonomous).
        #[serde(default)]
        require_approval: bool,
    },
    /// Run when an HTTP POST hits the workflow's public ingress URL. The URL is a
    /// status surface exposed via the existing webhook-ingress seam; `secret`
    /// (when set) is the HMAC signing secret the caller must use.
    Webhook {
        #[serde(default)]
        secret: Option<String>,
    },
    /// Run when a Composio event fires. Reconciled into a Composio trigger
    /// subscription (`composio_triggers`) whose `target_kind` is `workflow`.
    Composio {
        toolkit: String,
        trigger_slug: String,
        #[serde(default)]
        connected_account_id: Option<String>,
    },
}

/// A persisted workflow definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
    /// How this workflow is fired. Empty/absent means manual-only (back-compat).
    #[serde(default)]
    pub triggers: Vec<WorkflowTrigger>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Errors raised while building or validating a [`WorkflowGraph`].
#[derive(Debug)]
pub enum GraphError {
    /// An edge endpoint named a node id that does not exist.
    UnknownNode(String),
    /// The graph is not acyclic.
    Cyclic,
    /// Two nodes share the same id.
    DuplicateNode(String),
}

/// A validated DAG built from a [`Workflow`]. Wraps a petgraph [`DiGraph`] and
/// keeps the id↔index mapping needed by the executor.
#[derive(Debug)]
pub struct WorkflowGraph {
    pub graph: DiGraph<WorkflowNode, EdgeData>,
    pub index_by_id: HashMap<String, NodeIndex>,
}

/// Payload carried on a graph edge.
#[derive(Debug, Clone)]
pub struct EdgeData {
    pub branch: Option<String>,
}

impl WorkflowGraph {
    /// Build and validate a DAG from a workflow definition.
    ///
    /// Validates that every edge endpoint exists, node ids are unique, and the
    /// resulting graph is acyclic.
    pub fn build(workflow: &Workflow) -> Result<Self, GraphError> {
        let mut graph: DiGraph<WorkflowNode, EdgeData> = DiGraph::new();
        let mut index_by_id: HashMap<String, NodeIndex> = HashMap::new();

        for node in &workflow.nodes {
            if index_by_id.contains_key(&node.id) {
                return Err(GraphError::DuplicateNode(node.id.clone()));
            }
            let idx = graph.add_node(node.clone());
            index_by_id.insert(node.id.clone(), idx);
        }

        for edge in &workflow.edges {
            let from = *index_by_id
                .get(&edge.from)
                .ok_or_else(|| GraphError::UnknownNode(edge.from.clone()))?;
            let to = *index_by_id
                .get(&edge.to)
                .ok_or_else(|| GraphError::UnknownNode(edge.to.clone()))?;
            graph.add_edge(
                from,
                to,
                EdgeData {
                    branch: edge.branch.clone(),
                },
            );
        }

        if is_cyclic_directed(&graph) {
            return Err(GraphError::Cyclic);
        }

        Ok(Self { graph, index_by_id })
    }

    /// Node indices with no incoming edges (entry points of the DAG).
    pub fn roots(&self) -> Vec<NodeIndex> {
        self.graph
            .node_indices()
            .filter(|&n| {
                self.graph
                    .neighbors_directed(n, petgraph::Direction::Incoming)
                    .next()
                    .is_none()
            })
            .collect()
    }
}

impl std::fmt::Display for GraphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownNode(id) => write!(f, "edge references unknown node id: {id}"),
            Self::Cyclic => write!(f, "workflow contains a cycle; a DAG must be acyclic"),
            Self::DuplicateNode(id) => write!(f, "duplicate node id: {id}"),
        }
    }
}

impl std::error::Error for GraphError {}

/// Validate, stamp, persist, and reconcile a workflow definition — the single
/// write path shared by the REST `create_workflow` handler and the chat-driven
/// [`crate::runnable::workflow_builder`] tools, so both behave identically
/// (including Composio trigger reconciliation; no chat-vs-canvas drift).
///
/// Steps: reject an invalid DAG, mint a `wf_…` id when empty, stamp
/// `created_at`/`updated_at`, write the file, then reconcile declared triggers
/// into external resources (scheduler jobs + Composio subscriptions). The
/// reconcile step is best-effort — it never fails the save, mirroring the prior
/// handler behaviour. Returns the persisted workflow (with its final id/stamps).
pub async fn persist_workflow(mut workflow: Workflow) -> Result<Workflow, String> {
    // Validate the DAG before persisting so callers never store a broken graph.
    WorkflowGraph::build(&workflow).map_err(|e| e.to_string())?;

    if workflow.id.is_empty() {
        workflow.id = format!("wf_{}", uuid::Uuid::new_v4().simple());
    }
    let now = chrono::Utc::now().to_rfc3339();
    if workflow.created_at.is_none() {
        workflow.created_at = Some(now.clone());
    }
    workflow.updated_at = Some(now);

    backfill_webhook_secrets(&mut workflow);

    store::save_workflow(&workflow).map_err(|e| e.to_string())?;
    reconcile_triggers(&workflow).await;
    Ok(workflow)
}

/// Ensure every `Webhook` trigger carries a signing secret so the endpoint can
/// actually fire. A secret-less webhook trigger is a **dead endpoint** — the
/// inbound dispatcher fail-closes on `NoSecret` (an unauthenticated public
/// trigger is a forgery vector), so a workflow created without one (e.g. via the
/// NL builder or the API) would never run.
///
/// Idempotent and non-clobbering: a user-set secret is left untouched; an empty
/// secret first reuses the previously-stored secret for this workflow (so a
/// re-save from a stale client never rotates it), and only mints a fresh
/// high-entropy secret when none exists yet. The value is surfaced back to the
/// canvas trigger panel (read-only) so the caller can sign with it.
fn backfill_webhook_secrets(workflow: &mut Workflow) {
    let has_empty_webhook = workflow.triggers.iter().any(|t| {
        matches!(t, WorkflowTrigger::Webhook { secret }
            if secret.as_deref().map(str::trim).unwrap_or("").is_empty())
    });
    if !has_empty_webhook {
        return;
    }

    // The secret already stored for this workflow (if any), reused so a re-save
    // that omits the secret preserves it rather than rotating it.
    let prior_secret = if workflow.id.is_empty() {
        None
    } else {
        store::load_workflow(&workflow.id).ok().and_then(|prior| {
            prior.triggers.iter().find_map(|t| match t {
                WorkflowTrigger::Webhook { secret } => secret
                    .as_ref()
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty()),
                _ => None,
            })
        })
    };

    for trigger in &mut workflow.triggers {
        if let WorkflowTrigger::Webhook { secret } = trigger {
            let empty = secret.as_deref().map(str::trim).unwrap_or("").is_empty();
            if empty {
                *secret = Some(prior_secret.clone().unwrap_or_else(generate_webhook_secret));
            }
        }
    }
}

/// Mint a fresh high-entropy webhook signing secret (256 bits of UUIDv4 entropy
/// as hex, matching the hex the HMAC verifier keys on). Dependency-light: reuses
/// the `uuid` crate already used to mint workflow ids.
fn generate_webhook_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Reconcile a workflow's declared triggers into the external resources that
/// fire it. Idempotent and best-effort (logs and swallows errors):
///   - Schedule triggers → deterministic `wf-sched-<id>-*` scheduler jobs.
///   - Composio triggers → workflow-target Composio subscriptions.
/// Manual / Webhook declare no external resource here.
pub async fn reconcile_triggers(workflow: &Workflow) {
    // Schedules are local + fast, so reconcile inline.
    triggers::apply_schedule_reconcile(&workflow.id, &workflow.name, &workflow.triggers);

    // A webhook trigger is only reachable on a laptop once Core has registered
    // with the managed relay (which mints the token `relay_inbound_url` composes).
    // Ensure that registration + subscription is live so a trigger created after
    // boot resolves its public URL without a Core restart. Spawned so the network
    // register (up to ~20s) never blocks the save; idempotent server- and
    // client-side, and a no-op for the non-relay tunnel backends.
    let has_webhook = workflow
        .triggers
        .iter()
        .any(|t| matches!(t, WorkflowTrigger::Webhook { .. }));
    if has_webhook {
        tokio::spawn(crate::webhook_ingress::ensure_relay_started_after_save());
    }

    // Composio reconcile makes a network call per subscription; keep it
    // best-effort and inline so a save reflects the declared set, but never let
    // it surface an error to the caller.
    let Some(store) = crate::composio_triggers::global() else {
        return;
    };
    // Replace the workflow's existing composio subs with the declared set
    // (simplest convergent strategy: drop all, re-create the current ones).
    if let Err(e) = store.delete_for_workflow(&workflow.id).await {
        tracing::warn!(workflow = %workflow.id, error = %e, "clearing prior composio workflow subs");
    }
    for trigger in &workflow.triggers {
        if let WorkflowTrigger::Composio {
            toolkit,
            trigger_slug,
            connected_account_id,
        } = trigger
        {
            let Some(account) = connected_account_id.as_deref() else {
                tracing::warn!(
                    workflow = %workflow.id,
                    slug = %trigger_slug,
                    "composio workflow trigger missing connected_account_id; skipping subscribe"
                );
                continue;
            };
            if let Err(e) = store
                .subscribe_workflow(
                    &workflow.id,
                    toolkit,
                    trigger_slug,
                    account,
                    serde_json::json!({}),
                )
                .await
            {
                tracing::warn!(workflow = %workflow.id, slug = %trigger_slug, error = %e, "composio workflow subscribe failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn webhook_workflow(secret: Option<&str>) -> Workflow {
        Workflow {
            id: String::new(), // empty id → backfill skips the prior-secret disk lookup
            name: "wh".into(),
            description: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            triggers: vec![WorkflowTrigger::Webhook {
                secret: secret.map(str::to_owned),
            }],
            created_at: None,
            updated_at: None,
        }
    }

    fn first_webhook_secret(wf: &Workflow) -> Option<String> {
        wf.triggers.iter().find_map(|t| match t {
            WorkflowTrigger::Webhook { secret } => secret.clone(),
            _ => None,
        })
    }

    #[test]
    fn backfill_generates_secret_when_absent() {
        let mut wf = webhook_workflow(None);
        backfill_webhook_secrets(&mut wf);
        let secret = first_webhook_secret(&wf).expect("a secret was generated");
        assert!(!secret.trim().is_empty(), "generated secret is non-empty");
        assert!(secret.len() >= 32, "generated secret has real entropy");
    }

    #[test]
    fn backfill_generates_secret_when_blank() {
        let mut wf = webhook_workflow(Some("   "));
        backfill_webhook_secrets(&mut wf);
        let secret = first_webhook_secret(&wf).expect("a secret was generated");
        assert!(!secret.trim().is_empty());
    }

    #[test]
    fn backfill_preserves_user_secret() {
        let mut wf = webhook_workflow(Some("user-set-secret"));
        backfill_webhook_secrets(&mut wf);
        assert_eq!(
            first_webhook_secret(&wf).as_deref(),
            Some("user-set-secret"),
            "a user-set secret is never clobbered"
        );
    }

    #[test]
    fn backfill_is_noop_without_webhook_trigger() {
        let mut wf = Workflow {
            id: String::new(),
            name: "n".into(),
            description: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            triggers: vec![WorkflowTrigger::Manual],
            created_at: None,
            updated_at: None,
        };
        backfill_webhook_secrets(&mut wf);
        assert!(matches!(wf.triggers[0], WorkflowTrigger::Manual));
    }

    fn node(id: &str, kind: NodeKind) -> WorkflowNode {
        WorkflowNode {
            id: id.to_string(),
            retry: None,
            timeout_ms: None,
            kind,
        }
    }

    fn linear_workflow() -> Workflow {
        Workflow {
            id: "wf1".into(),
            name: "linear".into(),
            description: None,
            nodes: vec![
                node("in", NodeKind::Input { key: None }),
                node(
                    "up",
                    NodeKind::Transform {
                        op: "uppercase".into(),
                        template: None,
                    },
                ),
                node("out", NodeKind::Output { key: None }),
            ],
            edges: vec![
                WorkflowEdge {
                    from: "in".into(),
                    to: "up".into(),
                    branch: None,
                },
                WorkflowEdge {
                    from: "up".into(),
                    to: "out".into(),
                    branch: None,
                },
            ],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn builds_linear_dag() {
        let g = WorkflowGraph::build(&linear_workflow()).expect("should build");
        assert_eq!(g.graph.node_count(), 3);
        assert_eq!(g.graph.edge_count(), 2);
        let roots = g.roots();
        assert_eq!(roots.len(), 1);
    }

    #[test]
    fn rejects_cycle() {
        let mut wf = linear_workflow();
        wf.edges.push(WorkflowEdge {
            from: "out".into(),
            to: "in".into(),
            branch: None,
        });
        let err = WorkflowGraph::build(&wf).expect_err("cycle must be rejected");
        assert!(matches!(err, GraphError::Cyclic));
    }

    #[test]
    fn rejects_unknown_edge() {
        let mut wf = linear_workflow();
        wf.edges.push(WorkflowEdge {
            from: "in".into(),
            to: "ghost".into(),
            branch: None,
        });
        let err = WorkflowGraph::build(&wf).expect_err("unknown node must be rejected");
        assert!(matches!(err, GraphError::UnknownNode(_)));
    }

    #[test]
    fn rejects_duplicate_node() {
        let mut wf = linear_workflow();
        wf.nodes.push(node("in", NodeKind::Output { key: None }));
        let err = WorkflowGraph::build(&wf).expect_err("dup must be rejected");
        assert!(matches!(err, GraphError::DuplicateNode(_)));
    }
}
