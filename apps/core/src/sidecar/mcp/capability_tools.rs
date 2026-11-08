//! The **capability tool facade** — stable, provider-independent tool ids for the
//! hot-swappable layers (search, extract, crawl, browser, computer-use, memory,
//! verification).
//!
//! ## Why this exists
//!
//! The capability binding registry (`crate::plugins::binding`) already lets a
//! capability's provider be swapped: `provides`/`requires` edges resolve to a
//! concrete app id, overridable per capability. What it does NOT do is keep the
//! *model-visible tool surface* stable — binding lowers to a dependency-graph edge,
//! not to a tool route. So swapping Exa for Tavily used to rename `exa.search` to
//! `tavily.search` and reshape its arguments, breaking every agent allowlist and
//! every prompt that named the tool.
//!
//! This module closes that gap the way Hermes does: one canonical verb per thing an
//! agent actually wants to do (`web.search`, `browser.navigate`, `memory.store`,
//! …), registered as reserved built-in tools. At call time the facade resolves the
//! capability's bound provider, renames the arguments per the provider's manifest,
//! re-enters dispatch on the provider's own tool, and normalizes the response back
//! into the canonical shape. Swap the provider and neither the tool id, its schema,
//! nor its result shape changes.
//!
//! ## What lives where
//!
//! * The **verb table** (`capability_tools/table.rs`) is the canonical contract:
//!   ids, descriptions, input schemas, and the capability each verb belongs to. It
//!   is generic mechanism — it names capabilities only, never a provider app id,
//!   port, or vendor.
//! * A **provider** declares, in its manifest's `provides[].tools`, which of its own
//!   tools serves each verb plus the argument/response mapping
//!   ([`CapabilityToolBinding`]). A provider that omits a verb simply does not serve
//!   it, and the facade does not advertise that verb while it is bound.
//! * `mcp::mod` owns the enabled-set gathering and the dispatch re-entry, because
//!   only the registry can call another tool.
//!
//! ## Invariants
//!
//! * Provider-native ids (`exa.search`, `spider.crawl`) stay registered. The facade
//!   is purely additive, so existing agents and allowlists are untouched.
//! * The facade adds no authority **relative to a direct tool call**: the re-entered
//!   call is the provider's own tool, gated by the provider's own grants exactly as
//!   calling that tool by its native id would be. The agent-facing boundary is the
//!   per-agent tool allowlist, checked here on the stable verb id — which is the
//!   point, since that permission then survives a provider swap.
//!
//!   Stated precisely, because it is an asymmetry worth knowing about: the facade
//!   does NOT check [`ProvidesEntry::grant`], while the HTTP capability broker
//!   (`sidecar::ext_proxy`) does. That is deliberate — `grant` expresses
//!   *plugin → plugin* authority, and the broker's caller is another plugin that
//!   declares `requires.capabilities`. A facade caller is an agent, which has no
//!   grant set to check against; gating on one would refuse every facade call.
//!   The consequence to keep in view is that a privileged verb is only as safe as
//!   the allowlist, so a genuinely dangerous capability should not become a verb at
//!   all. `browser.eval` (arbitrary JS in a page carrying the user's live session)
//!   was left OUT of the table for exactly this reason, on an app that ships
//!   pre-installed.
//! * A verb is only listed when its capability resolves over the ENABLED set AND the
//!   bound provider declares that verb — feature detection, never a tool that errors
//!   on first use.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use super::RegistryTool;
use crate::plugin_manifest::{CapabilityResponseMap, CapabilityToolBinding, PluginManifest};
use crate::plugins::binding::{BindingConfig, BindingRegistry};

/// Reserved server name for the web layers (search / extract / crawl).
pub const SERVER_WEB: &str = "web";
/// Reserved server name for browser control.
pub const SERVER_BROWSER: &str = "browser";
/// Reserved server name for computer (desktop) control.
pub const SERVER_COMPUTER: &str = "computer";
/// Reserved server name for the memory layer.
pub const SERVER_MEMORY: &str = "memory";
/// Reserved server name for typed decision models.
pub const SERVER_DECISION: &str = "decision";
/// Reserved server name for the claim-verification layer.
pub const SERVER_VERIFY: &str = "verify";

/// Capability name for web search.
pub const CAP_WEB_SEARCH: &str = "web.search";
/// Capability name for single-page content extraction.
pub const CAP_WEB_EXTRACT: &str = "web.extract";
/// Capability name for multi-page crawling.
pub const CAP_WEB_CRAWL: &str = "web.crawl";
/// Capability name for browser control.
pub const CAP_BROWSER: &str = "browser.control";
/// Capability name for desktop/computer control.
pub const CAP_COMPUTER: &str = "computer.control";
/// Capability name for the memory layer.
pub const CAP_MEMORY: &str = "memory";
/// Capability name for the typed decision-model layer.
pub const CAP_DECISION_TYPED: &str = "decision.typed";
/// Capability name for the claim-verification layer.
pub const CAP_VERIFY: &str = "verify.claim";

/// Every reserved server name this module owns. Used by the registry's
/// `contains_server` / summary paths so a plugin cannot squat one.
pub const SERVERS: &[&str] = &[
    SERVER_WEB,
    SERVER_BROWSER,
    SERVER_COMPUTER,
    SERVER_MEMORY,
    SERVER_DECISION,
    SERVER_VERIFY,
];

/// Whether `name` is one of the facade's reserved server names.
pub fn is_server(name: &str) -> bool {
    SERVERS.contains(&name)
}

/// One-line description of a reserved server, for the `GET /api/mcp/servers`
/// listing. `None` for a name the facade does not own.
pub fn server_description(name: &str) -> Option<&'static str> {
    match name {
        SERVER_WEB => Some(
            "Swappable web layer: search, extract, and crawl. The tools stay the same; which \
             provider serves them (Exa, Tavily, Spider, …) is selected in the layer picker.",
        ),
        SERVER_BROWSER => Some(
            "Swappable browser layer: navigate, snapshot, context, annotate, click, type, screenshot and \
             coordinate input. Backed by \
             whichever browser provider is selected (local Chromium or a cloud browser).",
        ),
        SERVER_COMPUTER => Some(
            "Swappable computer-use layer: capture the screen and drive mouse/keyboard through \
             the selected desktop-control provider.",
        ),
        SERVER_MEMORY => Some(
            "Swappable memory layer: search, store, and forget durable facts. The built-in store \
             is always available; an external provider can be selected alongside it.",
        ),
        SERVER_DECISION => Some(
            "Swappable typed-decision model layer: ask choice, score, or boolean questions about \
             a text or JSON state and receive structured answers.",
        ),
        SERVER_VERIFY => Some(
            "Swappable verification layer: check a claim against a source of truth and get a \
             verdict (proved, refuted, undecided, inconsistent, or unverifiable) with the \
             evidence that decided it. Which checker answers is selected in the layer picker.",
        ),
        _ => None,
    }
}

/// One canonical capability verb — a stable tool the model sees regardless of which
/// provider is bound.
pub struct Verb {
    /// Fully-qualified tool id (`<server>.<name>`), e.g. `"web.search"`.
    pub id: &'static str,
    /// The reserved server this verb belongs to.
    pub server: &'static str,
    /// The bare tool name within the server.
    pub name: &'static str,
    /// The capability whose bound provider serves it.
    pub capability: &'static str,
    /// Model-facing description. Deliberately provider-neutral.
    pub description: &'static str,
    /// Builds the canonical input schema.
    pub schema: fn() -> Value,
}

mod defaults;
mod mapping;
mod resolve;
mod schemas;
mod schemas_machine;
mod table;

pub use defaults::*;
pub use mapping::*;
pub use resolve::*;
pub use schemas::*;
use schemas_machine::*;
pub use table::*;

/// Look up a verb by its fully-qualified id.
pub fn verb_by_id(id: &str) -> Option<&'static Verb> {
    let normalized = super::canonical_tool_id(id);
    verbs().iter().find(|v| v.id == normalized)
}

/// Whether `id` is a machine verb: a `computer.*` or `browser.*` verb, which a
/// conversation with a session Box runs on that Box instead of the node.
pub fn is_machine_verb(id: &str) -> bool {
    verb_by_id(id).is_some_and(|verb| MACHINE_CAPABILITIES.contains(&verb.capability))
}

/// Capabilities where "swap the provider" changes WHICH MACHINE is acted on, not
/// merely who answers. Every provider of one of these must say what it drives.
pub const MACHINE_CAPABILITIES: [&str; 2] = [CAP_COMPUTER, CAP_BROWSER];

/// The machine-control providers Core serves itself rather than through a
/// plugin manifest, as `(provider id, capability, target)`: the session Box,
/// which runs `computer.*` and `browser.*` on a conversation's own Box screen.
pub fn core_machine_providers(
) -> Vec<(String, &'static str, crate::plugin_manifest::ProviderTarget)> {
    let descriptor = super::box_desktop::provider_descriptor();
    descriptor
        .capabilities
        .iter()
        .map(|capability| (descriptor.id.to_owned(), *capability, descriptor.target))
        .collect()
}

#[cfg(test)]
mod tests;
