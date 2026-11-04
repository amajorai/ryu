//! App catalog browse + install-from-URL + hot-reload (#427, #428).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── App catalog browse + install-from-URL + hot-reload (#427, #428) ───────────

/// `GET /api/apps/catalog` — browse installable apps from the remote registry.
///
/// TTL-cached in `ServerState::catalog_client`; falls back to a stale cache or
/// an empty list when the registry is unreachable. Built-in apps are always
/// discoverable via `GET /api/apps`, so an offline machine is never blank.
#[utoipa::path(
    get,
    path = "/api/plugins/catalog",
    tag = "Plugins",
    summary = "List the plugin catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_apps_catalog(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    let entries = merged_plugin_catalog_entries(&state).await;
    Json(json!({ "entries": entries }))
}

/// The active Plugin catalog source (Ryu Marketplace by default, or integrations.sh
/// / a custom mirror). See [`crate::catalog_source`].
pub(in crate::server) async fn active_plugin_source(
    state: &ServerState,
) -> Option<crate::catalog_source::Source> {
    let source = state
        .catalog_sources
        .get_active(
            crate::catalog_source::CatalogKind::Plugin,
            &state.preferences,
        )
        .await?;
    Some(with_github_token(state, source).await)
}

/// The community (GitHub-topic) Plugin source, with the BYOK token injected.
/// Addressed directly by `?origin=community` rather than through the active-source
/// preference: the active source is a single global setting, so selecting the
/// community feed there would blank the first-party Apps/Plugins sections. A
/// per-request selector lets Community coexist as its own store section.
pub(in crate::server) async fn community_plugin_source(
    state: &ServerState,
) -> Option<crate::catalog_source::Source> {
    let source = state.catalog_sources.source_by_id(
        crate::catalog_source::CatalogKind::Plugin,
        crate::catalog_source::GITHUB_TOPIC_SOURCE_ID,
    )?;
    Some(with_github_token(state, source).await)
}

/// The plugin catalog source ids that render as ONE "Ryu Marketplace" view.
///
/// `ryu-marketplace` is the GitHub-backed hosted bridge (commerce metadata,
/// signatures, and buyer downloads); `ryu-catalog` is the read-only compatibility
/// reader for the pre-bridge central marketplace.json index. They are two BACKENDS
/// of a single product surface, and splitting them across two picker rows made the
/// store read as two competing marketplaces. Either id therefore resolves to
/// [`merged_plugin_catalog_entries`], which folds both (plus loaded built-ins and the
/// legacy registry) into one deduped list. See [`PLUGIN_MERGED_VIEW_ID`] for the id
/// the client selects.
pub(in crate::server) const PLUGIN_MERGED_SOURCE_IDS: [&str; 2] =
    ["ryu-marketplace", "ryu-catalog"];

/// The canonical id for the unified first-party view. The active source defaults to
/// the hosted bridge; this stable compatibility id is retained so existing desktop
/// preferences and catalog rows continue to address the same merged view.
pub(in crate::server) const PLUGIN_MERGED_VIEW_ID: &str = "ryu-catalog";

/// True when `id` addresses the unified first-party marketplace view.
pub(in crate::server) fn is_merged_plugin_view(id: &str) -> bool {
    PLUGIN_MERGED_SOURCE_IDS.contains(&id)
}

/// The sentinel `?source=` value meaning "every marketplace at once".
///
/// This is the store's DEFAULT view. A source picker is a reasonable control when
/// the sources are rivals, but they are not: a listing lives on exactly one of them,
/// so picking a source is really picking which subset of the store you are allowed
/// to find — and the only way to answer "is X available?" was to try each row in
/// turn. Under this id every source is browsed and the client groups the results
/// under a heading per marketplace, so the picker narrows an already-complete list
/// instead of being the thing that makes it complete.
///
/// Not a registered source: it never appears in `sources_for`, it cannot be the
/// node's active-source preference, and it resolves to a LIST of real sources at
/// both the browse and detail seams.
pub(in crate::server) const PLUGIN_ALL_SOURCES_ID: &str = "all";

/// Plugin sources the "all" view must not fold in.
///
/// Mirrors the desktop store's own `HIDDEN_PLUGIN_SOURCES`, for the same reasons:
///   - `ryu-marketplace` is the hosted COMMERCE backend, already folded into the
///     merged first-party view — browsing it again would duplicate every paid
///     listing under a second heading;
///   - `github-topic` is the Community feed. It is unreviewed, it is fetched
///     separately via `?origin=community`, and it must never render without the
///     trust notice that section carries. Folding it in here would both duplicate
///     those rows and strip that notice off the copies.
pub(in crate::server) const PLUGIN_ALL_EXCLUDED_SOURCES: [&str; 2] =
    ["ryu-marketplace", "github-topic"];

/// How long one federated source may take before the all-marketplaces view gives up
/// on it. Long enough for a cold git-catalog fetch, short enough that a wedged
/// marketplace cannot hold the store's default page.
pub(in crate::server) const PLUGIN_ALL_SOURCE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(8);

/// The marketplaces the "all" view browses, in display order: the unified
/// first-party view first (it answers offline, from compiled manifests plus a
/// cached catalog), then every other registered, non-excluded plugin source.
pub(in crate::server) fn all_plugin_view_sources(
    state: &ServerState,
) -> Vec<crate::catalog_source::SourceMeta> {
    state
        .catalog_sources
        .sources_for(crate::catalog_source::CatalogKind::Plugin)
        .into_iter()
        .filter(|s| is_all_plugin_view_source(&s.id))
        .collect()
}

/// Whether a registered plugin source id is browsed by the all-marketplaces view.
///
/// Split out as a pure predicate so it is testable without a `ServerState`: which
/// sources this admits is a correctness question (a `github-topic` slipping in
/// would render unreviewed listings with no trust notice), not a plumbing detail.
pub(in crate::server) fn is_all_plugin_view_source(id: &str) -> bool {
    if PLUGIN_ALL_EXCLUDED_SOURCES.contains(&id) {
        return false;
    }
    // Both first-party ids address the SAME merged view. Only the canonical one is
    // browsed, or every first-party listing would appear twice — once per heading.
    !is_merged_plugin_view(id) || id == PLUGIN_MERGED_VIEW_ID
}

/// Resolve which plugin catalog source a browse/detail request addresses.
///
/// Precedence: an explicit `?source=<id>` (validated against the registry) → the
/// node's active-source preference → the built-in primary.
///
/// The explicit selector exists because the active source is ONE node-global
/// preference, while the store renders many independent tabs: picking
/// integrations.sh in one tab used to reassign every other open store tab (and
/// every other client on the node) to a catalog it never asked for. Per-request
/// selection makes the choice belong to the view that made it. An unknown or empty
/// id falls through to the preference rather than erroring, so a stale client that
/// names a removed custom source degrades to the default view.
pub(in crate::server) async fn resolve_plugin_source_id(
    state: &ServerState,
    params: &std::collections::HashMap<String, String>,
) -> String {
    if let Some(requested) = params.get("source").map(String::as_str) {
        let trimmed = requested.trim();
        if !trimmed.is_empty()
            && (is_merged_plugin_view(trimmed)
                || trimmed == PLUGIN_ALL_SOURCES_ID
                || state
                    .catalog_sources
                    .source_by_id(crate::catalog_source::CatalogKind::Plugin, trimmed)
                    .is_some())
        {
            return trimmed.to_string();
        }
    }
    state
        .catalog_sources
        .active_id(
            crate::catalog_source::CatalogKind::Plugin,
            &state.preferences,
        )
        .await
        .unwrap_or_else(|| PLUGIN_MERGED_VIEW_ID.to_string())
}

/// A specific Plugin source by id, with the BYOK GitHub token injected — the
/// per-request counterpart to [`active_plugin_source`].
pub(in crate::server) async fn plugin_source_by_id(
    state: &ServerState,
    id: &str,
) -> Option<crate::catalog_source::Source> {
    let source = state
        .catalog_sources
        .source_by_id(crate::catalog_source::CatalogKind::Plugin, id)?;
    Some(with_github_token(state, source).await)
}

/// Inject the BYOK GitHub personal access token from preferences into a
/// [`crate::catalog_source::Source::GithubTopic`]. Mirrors the Smithery key
/// injection in [`active_mcp_source`]: the token is read at the route (never
/// persisted in the source registry) and the source itself scopes it to the
/// default `api.github.com` host, so a custom base can never harvest it.
pub(in crate::server) async fn with_github_token(
    state: &ServerState,
    source: crate::catalog_source::Source,
) -> crate::catalog_source::Source {
    let crate::catalog_source::Source::GithubTopic(mut s) = source.clone() else {
        return source;
    };
    if let Ok(Some(token)) = state
        .preferences
        .get(crate::catalog_source::GITHUB_TOKEN_PREF)
        .await
    {
        let trimmed = token.trim();
        if !trimmed.is_empty() {
            s.token = Some(trimmed.to_string());
        }
    }
    crate::catalog_source::Source::GithubTopic(s)
}

/// Merged Ryu Marketplace plugin catalog: built-in manifests + marketplace items +
/// legacy registry, deduped by id. Used by `list_apps_catalog` and the marketplace
/// browse path.
/// Catalog entries for every built-in APP — a compiled fixture that claims a UI
/// DESTINATION ([`manifest_declares_destination`]) — derived from `BUILTIN_MANIFESTS`
/// once. They re-classify not pre-installed Core apps (Canvas/Whiteboard/Meetings/Clips/…)
/// that the open git catalog lists as bare plugin cards with empty `kinds`: mapped
/// through `plugin_manifest_to_entry` they carry the explicit `type:"app"` and the
/// `runnables` the preview needs, and (placed above the marketplace/git groups) they
/// win the id dedup.
///
/// This filter and the `type` stamp in `plugin_manifest_to_entry` MUST use the same
/// predicate, and that is why both call the one helper. When this group was
/// companion-only while a non-companion app (Browser/Simulator/CRM/UGC, or a
/// route-claiming app like Dashboards/Drafts/Mission Control) was correctly stamped
/// `type:"app"` elsewhere, the app was still excluded from the group that outranks
/// the remote sources — so the open catalog's bare plugin card won its id and the
/// listing reappeared in the Plugins tab anyway.
///
/// Internal system fixtures (firewall/routing/…) claim no destination and are still
/// excluded, so this never over-exposes non-app plugins in the store.
pub(in crate::server) static BUILTIN_APP_ENTRIES: std::sync::LazyLock<Vec<serde_json::Value>> =
    std::sync::LazyLock::new(|| {
        crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
            .iter()
            .filter(|m| manifest_declares_destination(m))
            .map(plugin_manifest_to_entry)
            .collect()
    });
