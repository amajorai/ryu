//! The **Runnable** kind discriminant and identity metadata — the pure-data
//! spine of Ryu's object model.
//!
//! This is the *identity* slice of Core's `crate::runnable` module: the enum
//! that names every executable thing in Ryu and the kind-agnostic metadata view.
//! The executable `Runnable` trait and its impls (on `AgentRecord`,
//! `SkillRecord`, `Workflow`) stay in Core because they are coupled to Core's
//! execution types; only the serde shapes a `manifest.json` author needs live here
//! so they have exactly one definition every consumer (Core and the SDK) shares.
//!
//! Every shape derives [`schemars::JsonSchema`] so the manifest schema can be
//! emitted for languages that validate manifests without an FFI binding.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// The kind of a Runnable. The union of every executable thing in Ryu.
///
/// # Extending with a new kind
///
/// To add a new kind:
/// 1. Add a variant here (no default/catch-all arm anywhere).
/// 2. Add a corresponding `*Config` struct in the `schema` module.
/// 3. Add the variant to the `validate_runnable` match in `schema`.
/// 4. Extend `as_str()` with the new arm.
///
/// The design intentionally avoids `_` / wildcard arms in every `match` so the
/// compiler flags every site that must be updated — the "nothing hardcoded"
/// guarantee is enforced at compile time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
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

/// A kind-agnostic snapshot of a Runnable's identity, used when listing or
/// serializing a mixed set of runnables (agents, workflows, tools, skills).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct RunnableMeta {
    pub id: String,
    pub name: String,
    pub kind: RunnableKind,
}
