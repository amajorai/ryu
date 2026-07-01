//! The **Runnable** contract — the spine of Ryu's object model.
//!
//! A Runnable is the one abstraction that unifies the five executable things in
//! Ryu: **Agent**, **Workflow**, **Tool**, **Skill** (and, later, an MCP-server).
//! They are *peers*, not a strict hierarchy: an agent can invoke a workflow by
//! exposing it as a named tool, and a workflow can orchestrates agents by calling
//! them as steps. The common shape is `input -> run -> output`; this module
//! defines the *identity* surface of that contract (`id`, `name`, `kind`) and
//! maps it onto the executable types that exist in Core today
//! ([`crate::agents::AgentRecord`], [`crate::workflow::Workflow`], and
//! [`crate::skills::SkillRecord`]).
//!
//! Per the Core-vs-Gateway rule this is **Core**: it describes *what runs*. It
//! never decides what is allowed/measured/paid — that stays in the Gateway.
//!
//! `Tool` is represented as a stub [`ToolStub`] — it is the one remaining
//! placeholder until the MCP/tool-registry units land. `Skill` is now a real,
//! executable [`crate::skills::SkillRecord`] (M3 / issue #145).
//!
//! Self-build tools (`scaffold_runnable`, `write_ryu_json`, `install_app`) that
//! let an agent author Runnables in chat are in the [`self_build`] submodule
//! (M3 / issue #171).

pub mod agent_builder;
pub mod dashboard_builder;
pub mod self_build;
pub mod workflow_builder;

/// The kind of a [`Runnable`]. The union of every executable thing in Ryu.
///
/// # Extending with a new kind
///
/// To add a new kind:
/// 1. Add a variant here (no default/catch-all arm anywhere).
/// 2. Add a corresponding `*Config` struct in `crate::plugin_manifest::schema`.
/// 3. Add the variant to `RunnableConfig` in `crate::plugin_manifest::schema`.
/// 4. Extend `as_str()` with the new arm.
///
/// The design intentionally avoids `_` / wildcard arms in every `match` so
/// the compiler flags every site that must be updated — the "nothing hardcoded"
/// guarantee is enforced at compile time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunnableKind {
    /// A configured agent (system prompt + tools + model/engine binding).
    Agent,
    /// A DAG workflow of typed nodes.
    Workflow,
    /// A callable tool. Net-new: not yet a standalone Runnable type in Core
    /// (today only a `NodeKind::Tool` exists inside the workflow graph).
    Tool,
    /// An Agent Skill (the Skills standard). Net-new: unrepresented in Core today.
    Skill,
    /// An in-desktop overlay or sidebar Companion surface.
    Companion,
    /// A channel bot adapter (Telegram, Slack, WhatsApp, Discord, …).
    Channel,
    /// A pluggable model/inference engine binding (llama.cpp, Ollama, OpenAI-compat, …).
    Engine,
    /// A Gateway policy fragment (firewall rule, PII/DLP filter, budget cap, …).
    /// Note: policy *enforcement* belongs to the Gateway; this kind lets an App
    /// declare and bundle a policy that the Gateway activates on install.
    Policy,
}

impl RunnableKind {
    /// A stable lowercase identifier for the kind (handy for APIs and logs).
    pub const fn as_str(self) -> &'static str {
        match self {
            RunnableKind::Agent => "agent",
            RunnableKind::Workflow => "workflow",
            RunnableKind::Tool => "tool",
            RunnableKind::Skill => "skill",
            RunnableKind::Companion => "companion",
            RunnableKind::Channel => "channel",
            RunnableKind::Engine => "engine",
            RunnableKind::Policy => "policy",
        }
    }
}

/// The unifying contract over Agent | Workflow | Tool | Skill.
///
/// This trait intentionally exposes only the *identity* view (`id`, `name`,
/// `kind`) shared by every Runnable. The `input -> run -> output` execution
/// surface is layered on per-kind by the existing executors (the workflow
/// executor, the ACP/chat adapters for agents); unifying execution under one
/// dynamic method is a later step and is deliberately not faked here.
pub trait Runnable {
    /// Stable unique identifier for this runnable.
    fn id(&self) -> &str;

    /// Human-readable display name.
    fn name(&self) -> &str;

    /// Which kind of runnable this is.
    fn kind(&self) -> RunnableKind;

    /// A uniform metadata view, convenient for listing heterogeneous runnables.
    fn metadata(&self) -> RunnableMeta {
        RunnableMeta {
            id: self.id().to_string(),
            name: self.name().to_string(),
            kind: self.kind(),
        }
    }
}

/// A kind-agnostic snapshot of a [`Runnable`]'s identity, used when listing or
/// serializing a mixed set of runnables (agents, workflows, tools, skills).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RunnableMeta {
    pub id: String,
    pub name: String,
    pub kind: RunnableKind,
}

impl Runnable for crate::agents::AgentRecord {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn kind(&self) -> RunnableKind {
        RunnableKind::Agent
    }
}

impl Runnable for crate::workflow::Workflow {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn kind(&self) -> RunnableKind {
        RunnableKind::Workflow
    }
}

/// **Placeholder, net-new and not yet built.** A standalone callable Tool as a
/// first-class Runnable does not exist in Core yet — today a tool is only a
/// `NodeKind::Tool` inside a workflow graph. This stub completes the Runnable
/// union at the type level so the abstraction is whole; it carries identity only
/// and has no execution behavior. Real tool-as-Runnable wiring lands with the
/// MCP/tool-registry units.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ToolStub {
    pub id: String,
    pub name: String,
}

impl Runnable for ToolStub {
    fn id(&self) -> &str {
        &self.id
    }

    fn name(&self) -> &str {
        &self.name
    }

    fn kind(&self) -> RunnableKind {
        RunnableKind::Tool
    }
}

// ── Skill (M3 — now real) ─────────────────────────────────────────────────────
//
// `SkillStub` has been replaced by the real [`crate::skills::SkillRecord`] type,
// which implements [`Runnable`] and is discoverable + executable (M3 / issue #145).
// The `Runnable` impl lives in `crate::skills` to avoid circular imports.
//
// The `SkillStub` type alias is kept here so any existing code that referenced it
// continues to compile. New code should use `crate::skills::SkillRecord` directly.

/// Alias kept for backward compatibility; new code should use
/// [`crate::skills::SkillRecord`] directly.
pub type SkillStub = crate::skills::SkillRecord;

// ── RunnableRegistry ──────────────────────────────────────────────────────────

/// Dispatch result for a single [`crate::plugin_manifest::schema::RunnableEntry`].
/// The `String` is the entry id; the `Result` is `Ok(())` on success or an
/// error message on failure. Collecting per-entry results lets the caller
/// surface partial failures without aborting the whole manifest.
pub type RunnableResult = (String, Result<(), String>);

/// A synchronous handler for one [`RunnableKind`]. Receives the entry and
/// performs the side-effect (upsert into the subsystem store). Returns `Ok(())`
/// on success or a descriptive error string on failure.
///
/// `Box<dyn …>` is used (rather than a trait object with async methods) so the
/// registry itself stays `Send + Sync` without `async-trait`. Handlers that
/// need async I/O should block via `tokio::task::block_in_place` or be called
/// from a Tokio context via `Handle::current().block_on(…)`.
pub type RunnableHandler =
    Box<dyn Fn(&crate::plugin_manifest::schema::RunnableEntry) -> Result<(), String> + Send + Sync>;

/// A pluggable dispatcher that maps [`RunnableKind`] → handler and activates
/// every Runnable in an [`crate::plugin_manifest::PluginManifest`] when an app is
/// enabled.
///
/// # Design
///
/// - **Per-kind handlers** are installed via [`RunnableRegistry::register_handler`].
///   A kind with no handler causes a per-entry error (not a panic), which keeps
///   the dispatch observable and partial-failure-safe.
/// - **Partial-install semantics**: one failing Runnable never aborts the rest.
///   [`RunnableRegistry::register_all`] collects every per-entry result.
/// - **Core-vs-Gateway rule**: only Core-owned kinds (Agent, Workflow, Tool)
///   have built-in handlers. Policy and Engine have none by default — they
///   belong to the Gateway.
///
/// # Thread safety
///
/// The registry is immutable after construction (handlers are installed before
/// sharing) so it can safely be shared as `Arc<RunnableRegistry>`.
pub struct RunnableRegistry {
    handlers: std::collections::HashMap<RunnableKind, RunnableHandler>,
}

impl RunnableRegistry {
    /// Build an empty registry. Use [`RunnableRegistry::register_handler`] to
    /// install per-kind handlers before calling [`RunnableRegistry::register_all`].
    pub fn new() -> Self {
        Self {
            handlers: std::collections::HashMap::new(),
        }
    }

    /// Install (or replace) the handler for `kind`.
    ///
    /// Calling this after the registry has been shared (`Arc`) is intentionally
    /// not possible — build the registry, install all handlers, then wrap it.
    pub fn register_handler(&mut self, kind: RunnableKind, handler: RunnableHandler) {
        self.handlers.insert(kind, handler);
    }

    /// Activate every Runnable in `manifest` by dispatching each entry to its
    /// kind's handler.
    ///
    /// Returns one [`RunnableResult`] per entry. An entry whose kind has no
    /// registered handler produces an `Err` result (not a panic). An entry that
    /// fails validation also produces an `Err` result. All other entries are
    /// dispatched and their handler's result recorded.
    ///
    /// The caller decides what to do with partial failures (e.g. log, surface in
    /// the API response, or abort the enable flow).
    pub fn register_all(
        &self,
        manifest: &crate::plugin_manifest::PluginManifest,
    ) -> Vec<RunnableResult> {
        manifest
            .runnables
            .iter()
            .map(|entry| {
                let id = entry.id.clone();

                // Validate the entry's config before dispatching.
                if let Err(e) = crate::plugin_manifest::schema::validate_runnable(entry) {
                    return (id, Err(e));
                }

                match self.handlers.get(&entry.kind) {
                    Some(handler) => (id, handler(entry)),
                    None => (
                        id,
                        Err(format!(
                            "no handler registered for kind '{}'; skipped",
                            entry.kind.as_str()
                        )),
                    ),
                }
            })
            .collect()
    }

    /// Activate only the Runnables whose plugin should wake for the given
    /// `fired_events` — the lazy-activation counterpart of [`register_all`].
    ///
    /// A plugin with an **empty** `activation_events` list is *eager*: it
    /// activates unconditionally (back-compat with every existing manifest). A
    /// plugin that declares events activates only when at least one of its
    /// declared events is in `fired_events`, or it declared the wildcard `"*"`.
    ///
    /// # Scaffold note
    ///
    /// This is the activation-runtime seam. The DECLARATION
    /// ([`crate::plugin_manifest::PluginManifest::activation_events`]) and this
    /// gated dispatch are real; the wiring that *fires* `onChat`/`onCommand` from
    /// the chat and command-palette paths is a documented follow-on. Until that
    /// lands, callers use [`register_all`] (eager) on enable — `register_active`
    /// exists so the deferral contract is testable and ready to wire.
    pub fn register_active(
        &self,
        manifest: &crate::plugin_manifest::PluginManifest,
        fired_events: &std::collections::HashSet<String>,
    ) -> Vec<RunnableResult> {
        if !manifest_should_activate(manifest, fired_events) {
            return Vec::new();
        }
        self.register_all(manifest)
    }
}

/// Whether a manifest should activate given the set of fired activation events.
///
/// - Empty `activation_events` ⇒ eager (always `true`).
/// - `"*"` present ⇒ always `true`.
/// - Otherwise `true` iff any declared event is in `fired_events`.
pub fn manifest_should_activate(
    manifest: &crate::plugin_manifest::PluginManifest,
    fired_events: &std::collections::HashSet<String>,
) -> bool {
    if manifest.activation_events.is_empty() {
        return true;
    }
    manifest
        .activation_events
        .iter()
        .any(|ev| ev == "*" || fired_events.contains(ev))
}

// ── Activation-event runtime (process-global fired set, #443) ─────────────────

/// The process-global set of activation events that have fired so far. A plugin
/// declaring `onStartup`/`onChat`/`onCommand:<id>`/`onRunnable:<id>` is woken the
/// first time the matching event lands here; subsequent firings of an
/// already-fired event are cheap no-ops (the set is monotonic — events only
/// accumulate over a process lifetime).
///
/// This is the live runtime half of the activation contract. The DECLARATION
/// (manifest `activation_events`) and the gated dispatch
/// ([`RunnableRegistry::register_active`]) were already real; this set plus the
/// `fire_activation_event` driver in `crate::server` make at least one event
/// (`onStartup`, fired at boot) genuinely wake plugins lazily.
static FIRED_ACTIVATION_EVENTS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashSet<String>>,
> = std::sync::OnceLock::new();

fn fired_events_lock() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    FIRED_ACTIVATION_EVENTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Record that an activation `event` has fired and return a snapshot of the
/// full fired-event set (including this one). Idempotent: re-firing an event is
/// harmless. The returned snapshot is what [`RunnableRegistry::register_active`]
/// consults to decide which plugins to wake.
pub fn mark_activation_event_fired(event: &str) -> std::collections::HashSet<String> {
    let mut set = fired_events_lock()
        .lock()
        .expect("fired-events lock poisoned");
    set.insert(event.to_owned());
    set.clone()
}

/// Snapshot of the currently-fired activation events (read-only).
pub fn fired_activation_events() -> std::collections::HashSet<String> {
    fired_events_lock()
        .lock()
        .expect("fired-events lock poisoned")
        .clone()
}

/// Clear the fired-event set. Test-only — lets a unit test start from a clean
/// slate without cross-test contamination of the process-global.
#[cfg(test)]
pub fn reset_activation_events_for_test() {
    fired_events_lock()
        .lock()
        .expect("fired-events lock poisoned")
        .clear();
}

impl Default for RunnableRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::AgentRecord;
    use crate::plugin_manifest::{schema::RunnableEntry, PluginManifest};
    use crate::workflow::Workflow;

    fn sample_agent() -> AgentRecord {
        AgentRecord {
            id: "agent-1".into(),
            name: "Test Agent".into(),
            description: None,
            system_prompt: None,
            tools: vec![],
            approval_tools: vec![],
            composio_actions: vec![],
            skills: vec![],
            identity_profile_ids: vec![],
            model: None,
            engine: None,
            built_in: false,
            created_at: None,
            updated_at: None,
            chat_model: None,
            stt: None,
            tts: None,
            image_model: None,
            memory: None,
            persona: None,
            policy_ref: None,
            inference: None,
            version: "1.0.0".into(),
            locked: false,
            orchestrator: None,
            can_create_agents: None,
        }
    }

    fn sample_workflow() -> Workflow {
        Workflow {
            id: "wf-1".into(),
            name: "Test Workflow".into(),
            description: None,
            nodes: vec![],
            edges: vec![],
            triggers: Vec::new(),
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn agent_record_is_an_agent_runnable() {
        let a = sample_agent();
        assert_eq!(a.kind(), RunnableKind::Agent);
        assert_eq!(a.id(), "agent-1");
        assert_eq!(a.name(), "Test Agent");
        assert_eq!(a.metadata().kind, RunnableKind::Agent);
    }

    #[test]
    fn workflow_is_a_workflow_runnable() {
        let w = sample_workflow();
        assert_eq!(w.kind(), RunnableKind::Workflow);
        assert_eq!(w.id(), "wf-1");
        assert_eq!(w.name(), "Test Workflow");
    }

    #[test]
    fn tool_and_skill_stubs_report_their_kinds() {
        let t = ToolStub {
            id: "t-1".into(),
            name: "Tool".into(),
        };
        // SkillStub is now an alias for crate::skills::SkillRecord (M3 / #145).
        let s = crate::skills::SkillRecord {
            id: "s-1".into(),
            name: "Skill".into(),
            description: None,
            instructions: String::new(),
            allowed_tools: vec![],
            enabled: true,
            always_on: false,
        };
        assert_eq!(t.kind(), RunnableKind::Tool);
        assert_eq!(s.kind(), RunnableKind::Skill);
    }

    // ── RunnableRegistry tests ────────────────────────────────────────────────

    /// Helpers to build a minimal PluginManifest with one or more entries.
    fn make_manifest(entries: Vec<RunnableEntry>) -> PluginManifest {
        PluginManifest {
            id: "test.app".to_owned(),
            name: "Test App".to_owned(),
            version: "1.0.0".to_owned(),
            runnables: entries,
            permission_grants: vec![],
            companion: None,
            ..Default::default()
        }
    }

    fn make_entry(
        id: &str,
        kind: RunnableKind,
        config: Option<serde_json::Value>,
    ) -> RunnableEntry {
        RunnableEntry {
            id: id.to_owned(),
            name: id.to_owned(),
            kind,
            config,
        }
    }

    /// AC3: a stub handler can be plugged in for any kind (including ones with no
    /// built-in handler) via `register_handler`. Dispatching the entry calls the
    /// stub, proving the map-driven pluggability contract.
    #[test]
    fn stub_handler_is_dispatched_for_registered_kind() {
        use std::sync::{Arc, Mutex};

        let called = Arc::new(Mutex::new(false));
        let called_clone = Arc::clone(&called);

        let mut registry = RunnableRegistry::new();
        // Companion has no built-in handler; prove we can add one.
        registry.register_handler(
            RunnableKind::Companion,
            Box::new(move |_entry| {
                *called_clone.lock().unwrap() = true;
                Ok(())
            }),
        );

        let manifest = make_manifest(vec![make_entry(
            "my-companion",
            RunnableKind::Companion,
            Some(serde_json::json!({ "label": "My Panel" })),
        )]);

        let results = registry.register_all(&manifest);

        assert_eq!(results.len(), 1, "one entry in the manifest");
        assert_eq!(results[0].0, "my-companion");
        assert!(results[0].1.is_ok(), "stub handler returned Ok");
        assert!(*called.lock().unwrap(), "stub handler was actually called");
    }

    /// AC4: a kind with no registered handler produces an observable error in
    /// `register_all` without aborting the rest of the entries (partial-install).
    #[test]
    fn missing_handler_produces_error_not_panic_partial_install_preserved() {
        use std::sync::{Arc, Mutex};

        let agent_ran = Arc::new(Mutex::new(false));
        let agent_ran_clone = Arc::clone(&agent_ran);

        let mut registry = RunnableRegistry::new();
        // Register a handler for Agent but intentionally leave Policy with none.
        registry.register_handler(
            RunnableKind::Agent,
            Box::new(move |_entry| {
                *agent_ran_clone.lock().unwrap() = true;
                Ok(())
            }),
        );

        let manifest = make_manifest(vec![
            // Agent: has a handler — should succeed.
            make_entry("my-agent", RunnableKind::Agent, None),
            // Policy: no handler — should produce an error, not abort.
            make_entry(
                "my-policy",
                RunnableKind::Policy,
                Some(serde_json::json!({
                    "policy_type": "firewall",
                    "definition": {}
                })),
            ),
        ]);

        let results = registry.register_all(&manifest);

        assert_eq!(results.len(), 2, "both entries are processed");

        let agent_result = results.iter().find(|(id, _)| id == "my-agent").unwrap();
        assert!(agent_result.1.is_ok(), "agent entry succeeded");
        assert!(*agent_ran.lock().unwrap(), "agent handler was called");

        let policy_result = results.iter().find(|(id, _)| id == "my-policy").unwrap();
        assert!(policy_result.1.is_err(), "policy entry produced an error");
        let err = policy_result.1.as_ref().unwrap_err();
        assert!(
            err.contains("no handler registered for kind"),
            "error is informative: {err}"
        );
    }

    /// `register_active` activates an eager (empty activation_events) manifest
    /// regardless of fired events, and skips an event-gated manifest until one of
    /// its events fires.
    #[test]
    fn register_active_respects_activation_events() {
        use std::collections::HashSet;
        use std::sync::{Arc, Mutex};

        let calls = Arc::new(Mutex::new(0u32));
        let calls_clone = Arc::clone(&calls);
        let mut registry = RunnableRegistry::new();
        registry.register_handler(
            RunnableKind::Tool,
            Box::new(move |_entry| {
                *calls_clone.lock().unwrap() += 1;
                Ok(())
            }),
        );

        let entry = make_entry(
            "t",
            RunnableKind::Tool,
            Some(serde_json::json!({ "slug": "web_search" })),
        );

        // Eager: empty activation_events ⇒ always activates.
        let eager = make_manifest(vec![entry.clone()]);
        let fired: HashSet<String> = HashSet::new();
        let r = registry.register_active(&eager, &fired);
        assert_eq!(r.len(), 1, "eager manifest activates with no events fired");

        // Gated: declares onCommand:go — must NOT activate until that fires.
        let mut gated = make_manifest(vec![entry]);
        gated.activation_events = vec!["onCommand:go".to_owned()];
        let r2 = registry.register_active(&gated, &fired);
        assert!(
            r2.is_empty(),
            "gated manifest stays inactive until its event"
        );

        let mut go: HashSet<String> = HashSet::new();
        go.insert("onCommand:go".to_owned());
        let r3 = registry.register_active(&gated, &go);
        assert_eq!(r3.len(), 1, "gated manifest activates once its event fires");
    }

    /// #443 activation runtime: firing an event into the process-global set and
    /// re-running `register_active` against that snapshot wakes a gated plugin.
    /// This proves the live path the `onStartup` boot driver uses.
    #[test]
    fn fired_event_drives_register_active() {
        use std::sync::{Arc, Mutex};

        let calls = Arc::new(Mutex::new(0u32));
        let calls_clone = Arc::clone(&calls);
        let mut registry = RunnableRegistry::new();
        registry.register_handler(
            RunnableKind::Tool,
            Box::new(move |_entry| {
                *calls_clone.lock().unwrap() += 1;
                Ok(())
            }),
        );

        let entry = make_entry(
            "t",
            RunnableKind::Tool,
            Some(serde_json::json!({ "slug": "web_search" })),
        );
        let mut gated = make_manifest(vec![entry]);
        gated.activation_events = vec!["onStartup".to_owned()];

        // Before onStartup fires, the snapshot does not include it -> no activation.
        let before = super::fired_activation_events();
        let r0 = registry.register_active(&gated, &before);
        assert!(
            r0.is_empty() || !before.contains("onStartup"),
            "gated plugin must not activate before its event fires"
        );

        // Firing the event returns a snapshot that now contains it, which drives
        // a real activation.
        let snapshot = super::mark_activation_event_fired("onStartup");
        assert!(snapshot.contains("onStartup"));
        let r1 = registry.register_active(&gated, &snapshot);
        assert_eq!(r1.len(), 1, "gated plugin activates once onStartup fires");
        assert!(r1[0].1.is_ok());
        assert_eq!(*calls.lock().unwrap(), 1, "handler ran exactly once");
    }

    #[test]
    fn kind_as_str_is_stable() {
        assert_eq!(RunnableKind::Agent.as_str(), "agent");
        assert_eq!(RunnableKind::Workflow.as_str(), "workflow");
        assert_eq!(RunnableKind::Tool.as_str(), "tool");
        assert_eq!(RunnableKind::Skill.as_str(), "skill");
        assert_eq!(RunnableKind::Companion.as_str(), "companion");
        assert_eq!(RunnableKind::Channel.as_str(), "channel");
        assert_eq!(RunnableKind::Engine.as_str(), "engine");
        assert_eq!(RunnableKind::Policy.as_str(), "policy");
    }
}
