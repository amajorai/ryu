//! [`NodeKind`]: the typed node kinds of a workflow and the config each one
//! carries. The longer per-variant notes live beside this file in
//! `node_kind/*.md` and are attached with `#[doc = include_str!(..)]`.

use super::*;

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
        /// Fully-qualified tool id (`<server>.<tool>`, e.g. `spider.crawl`).
        /// A bare server name with no namespace separator is rejected at run time.
        name: String,
        /// Free-form JSON args passed to the tool.
        #[serde(default)]
        args: serde_json::Value,
    },
    /// Calls a specific tool on a named MCP server — the explicit two-field form
    /// of [`NodeKind::Tool`]. `server` and `tool` are joined into the
    /// `<server>.<tool>` id the MCP registry expects, so authors pick a server
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
    #[doc = include_str!("node_kind/while.md")]
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
    /// Routes the incoming text through the Gateway firewall (the Gateway owns
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
    #[doc = include_str!("node_kind/for_each.md")]
    ForEach {
        /// The workflow run once per item.
        body_workflow_id: String,
        /// Template producing the JSON array to map over. Absent = `{{input}}`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        items: Option<String>,
        /// How many items run at once. Absent = the engine default.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_concurrency: Option<u32>,
    },
    /// Explicit fan-out of N different sub-workflows that all receive the node
    /// input (or their own `input` template), joined into one JSON object keyed
    /// by branch id. Branches run as durable child runs, up to `max_concurrency`
    /// at once, and finished branches are checkpointed exactly like
    /// [`NodeKind::ForEach`] items. A failed branch fails the node.
    Parallel {
        /// The branches to run. Ids must be unique and match `[A-Za-z0-9_-]+`.
        branches: Vec<ParallelBranch>,
        /// How many branches run at once. Absent = the engine default.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_concurrency: Option<u32>,
    },
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
    /// Workflows as code: a JavaScript body that orchestrates sub-agents with
    /// `agent()`, `parallel()`, `pipeline()`, and `phase()`, reading the node
    /// input as `args` and returning the node output. Runs in the Deno sandbox;
    /// every finished `agent()` result is checkpointed, so a resumed run replays
    /// them and only runs what never finished. See [`script`].
    Script {
        /// The script body (an async function body; `return` sets the output).
        code: String,
        /// Agent every `agent()` call runs as. When set, calls cannot pick another.
        #[serde(default)]
        agent_id: Option<String>,
        /// Preset for `agent()` calls that do not name one (default `research`).
        #[serde(default)]
        preset: Option<delegation::PermissionPreset>,
        /// Whether `agent()` calls may use a mutating preset (`code_write`).
        /// Ad-hoc script runs record the starting plugin's
        /// `hook:run-agent:write` grant here, so a resumed run keeps the same
        /// limit. Absent: authored workflows allow it, while ad-hoc (`script-`)
        /// workflows saved before this field existed do not.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        allow_mutation: Option<bool>,
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
    #[doc = include_str!("node_kind/awakeable.md")]
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
    /// ghost MCP action tool (`ghost.ghost_click`, `ghost.ghost_type`, …) — the
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
    #[doc = include_str!("node_kind/notify_user.md")]
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
    #[doc = include_str!("node_kind/channel_send.md")]
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
    #[doc = include_str!("node_kind/code.md")]
    Code {
        /// Source language.
        language: ryu_code_runner::CodeLanguage,
        /// Run the program or only check it.
        #[serde(default)]
        mode: ryu_code_runner::CodeMode,
        /// Program source.
        source: String,
        /// Lean/Bend: the program argument template. Defaults to `{{input}}`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        input: Option<String>,
        /// BAML: the function to call in `run` mode.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        function: Option<String>,
        /// BAML: the function's named arguments (string values are templates).
        #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
        args: serde_json::Value,
        /// BAML: the model the gateway-routed `Ryu` client requests. Defaults to
        /// the workflow default model.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
}

fn default_webhook_method() -> String {
    "POST".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_kinds_round_trip_through_their_tagged_wire_form() {
        let webhook: NodeKind = serde_json::from_value(
            serde_json::json!({ "type": "webhook", "url": "https://example.com" }),
        )
        .expect("webhook node deserializes");
        assert_eq!(
            webhook,
            NodeKind::Webhook {
                url: "https://example.com".into(),
                method: "POST".into(),
            }
        );
        let guardrails = NodeKind::Guardrails {
            checks: vec!["pii".into()],
        };
        let wire = serde_json::to_value(&guardrails).expect("serializes");
        assert_eq!(
            wire,
            serde_json::json!({ "type": "guardrails", "checks": ["pii"] })
        );
        assert_eq!(
            serde_json::from_value::<NodeKind>(wire).expect("round trip"),
            guardrails
        );
    }
}
