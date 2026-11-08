//! Resolving verbs against the enabled providers, the resolution cache
//! generation, and the registry rows the facade lists.

use super::*;

/// Bumped whenever anything that could change a capability's resolution changes:
/// the user's provider selection, or the set of enabled plugins. The registry caches
/// resolved verbs against this value so the enabled-set join (a plugin-store read
/// plus a manifest clone) does not run on every single tool call and every tool
/// listing.
///
/// Correctness over cheapness: the counter is bumped by the *mutators*, so a stale
/// read is only possible if a new mutation path forgets to call [`invalidate`]. The
/// failure that matters — "I picked Tavily but calls still go to Exa" — is covered
/// directly, because `PUT /api/capabilities/bindings` bumps it.
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Invalidate every cached capability resolution. Call from any path that changes
/// the provider selection or the enabled plugin set.
pub fn invalidate() {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// The current resolution generation, for cache validity checks.
pub fn generation() -> u64 {
    GENERATION.load(std::sync::atomic::Ordering::Relaxed)
}

/// A verb the facade can currently serve: the canonical contract plus the concrete
/// provider tool it forwards to.
#[derive(Clone)]
pub struct ResolvedVerb {
    /// The canonical verb.
    pub verb: &'static Verb,
    /// The bound provider's app id (surfaced to the model in the response envelope,
    /// so a swap is observable when it matters — e.g. differing result quality).
    pub provider_id: String,
    /// The provider's declared mapping for this verb.
    pub binding: CapabilityToolBinding,
}

/// Resolve every verb the facade can serve over `enabled` (the ENABLED manifest set —
/// the same set the binding registry's invariants are stated over) with the user's
/// `config` overrides applied.
///
/// A capability that does not resolve (unprovided, or ambiguous and not selectable)
/// contributes no verbs, and a bound provider that does not declare a verb does not
/// get that verb advertised. Both are silent by design: the facade is feature
/// detection, not an error surface.
pub fn resolve_verbs(enabled: &[PluginManifest], config: &BindingConfig) -> Vec<ResolvedVerb> {
    let registry = BindingRegistry::new(config, enabled);
    // Resolve each capability once — the table has many verbs per capability.
    let mut bound: BTreeMap<
        &'static str,
        Option<(String, &crate::plugin_manifest::ProvidesEntry)>,
    > = BTreeMap::new();
    let mut out = Vec::new();
    for verb in verbs() {
        let entry = bound.entry(verb.capability).or_insert_with(|| {
            registry
                .resolve_provider(verb.capability)
                .ok()
                .map(|(m, p)| (m.id.clone(), p))
        });
        let Some((provider_id, provides)) = entry.as_ref() else {
            continue;
        };
        let Some(binding) = provides.tools.get(verb.id).or_else(|| {
            provides.tools.iter().find_map(|(id, binding)| {
                (super::super::canonical_tool_id(id) == verb.id).then_some(binding)
            })
        }) else {
            continue;
        };
        // A verb bound to a Core-reserved tool (`ryu_api.*`, `routines.*`) is never
        // served: it would run that Core tool behind the verb's own approval.
        if super::super::provider_target_guard::binding_targets_core(binding) {
            continue;
        }
        out.push(ResolvedVerb {
            verb,
            provider_id: provider_id.clone(),
            binding: binding.clone(),
        });
    }
    out
}

/// Effect metadata belongs to the canonical verb, not the selected provider's
/// spelling. Keep unknown future verbs unclassified until their effects are reviewed.
pub(super) fn verb_annotations(id: &str) -> Option<Value> {
    match id {
        // Types a vault value into a page that may submit it: a mutation, so
        // read-only and trial agents never reach it.
        "browser.fill_credential" => {
            return Some(
                json!({ "readOnlyHint": false, "destructiveHint": true, "openWorldHint": true }),
            )
        }
        // Account metadata from Core; nothing leaves the node.
        "browser.list_credentials" => {
            return Some(
                json!({ "readOnlyHint": true, "destructiveHint": false, "openWorldHint": false }),
            )
        }
        _ => {}
    }
    let read_only = match id {
        "web.search"
        | "web.extract"
        | "decision.predict"
        | "decision.predict_multimodal"
        | "browser.snapshot"
        | "browser.screenshot"
        | "browser.tabs"
        | "browser.context"
        | "computer.capture"
        | "memory.search"
        | "memory.context"
        | "verify.claim"
        | "verify.scopes" => true,
        "web.crawl"
        | "browser.navigate"
        | "browser.click"
        | "browser.type"
        | "browser.scroll"
        | "browser.annotate"
        | "browser.clear_annotations"
        | "browser.hover"
        | "browser.click_at"
        | "browser.key"
        | "browser.drag"
        | "computer.click"
        | "computer.type"
        | "computer.key"
        | "computer.scroll"
        | "computer.focus_app"
        | "memory.store"
        | "memory.sync"
        | "memory.forget" => false,
        _ => return None,
    };
    // Input and navigation can submit forms or trigger page handlers. Conservatively
    // classify them as mutations; read-only/trial agents must not reach those effects.
    Some(json!({ "readOnlyHint": read_only, "destructiveHint": !read_only }))
}

/// The registry rows for a set of resolved verbs.
pub fn tools(resolved: &[ResolvedVerb]) -> Vec<RegistryTool> {
    resolved.iter().map(|r| verb_row(r.verb)).collect()
}

pub(super) fn verb_row(verb: &'static Verb) -> RegistryTool {
    RegistryTool {
        id: verb.id.to_owned(),
        server: verb.server.to_owned(),
        name: verb.name.to_owned(),
        description: Some(verb.description.to_owned()),
        input_schema: Some((verb.schema)()),
        annotations: verb_annotations(verb.id),
        ..Default::default()
    }
}

/// The registry rows of the `computer.*` and `browser.*` verbs the session
/// Box serves (Core's own provider, [`core_machine_providers`]) that no
/// enabled provider in `provided` already serves. Listed when the node serves
/// machine verbs from session Boxes, so a node without a local display
/// provider still offers them: each call then runs on the conversation's Box.
pub fn session_box_tools(provided: &[&str]) -> Vec<RegistryTool> {
    let served: Vec<&'static str> = core_machine_providers()
        .into_iter()
        .map(|(_, capability, _)| capability)
        .collect();
    verbs()
        .iter()
        .filter(|verb| served.contains(&verb.capability) && !provided.contains(&verb.id))
        .map(verb_row)
        .collect()
}
