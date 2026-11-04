//! App catalog browse, install-from-URL and hot reload: `merged_plugin_catalog_entries` through `plugin_entry_matches_query`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) async fn merged_plugin_catalog_entries(
    state: &ServerState,
) -> Vec<serde_json::Value> {
    // 1. Loaded built-in / installed plugin manifests — always offline-safe.
    let mut manifest_entries: Vec<serde_json::Value> = {
        let manifests = state.app_manifests.read().await;
        manifests.iter().map(plugin_manifest_to_entry).collect()
    };

    // 1a. Keep every compiled built-in discoverable, including not pre-installed
    // plugins that are not present in `app_manifests` until the user enables
    // them. The merge below is first-writer-wins, so active manifests retain
    // their live state while this fills the marketplace browse gap.
    let active_ids: std::collections::HashSet<String> = manifest_entries
        .iter()
        .filter_map(|entry| entry.get("id").and_then(|id| id.as_str()))
        .map(ToOwned::to_owned)
        .collect();
    manifest_entries.extend(
        crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
            .iter()
            .filter(|manifest| !active_ids.contains(&manifest.id))
            .map(plugin_manifest_to_entry),
    );

    // 1b. Plugins held back by an unmet host floor. They are NOT in
    //     `app_manifests` (that list is what the runtime activates), but a
    //     marketplace that silently omits them is exactly the behaviour this
    //     replaces: the user saw nothing and had no way to learn that updating
    //     would bring the plugin back. Projected through the SAME card function so
    //     they render identically, then stamped `installed_but_incompatible` so the
    //     client greys the card and refuses the install verb rather than offering
    //     one that will 409.
    {
        let incompatible = state.incompatible_manifests.read().await;
        for inc in incompatible.iter() {
            let mut entry = plugin_manifest_to_entry(inc.for_catalog());
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("installed_but_incompatible".to_owned(), json!(true));
                // Authoritative verdict from the load pass. `plugin_manifest_to_entry`
                // recomputes one from `engines`, which agrees today; carrying the
                // load-time verdict keeps the card honest if the two ever diverge
                // (an observed Gateway version arriving after manifests loaded).
                obj.insert("compatibility".to_owned(), json!(inc.verdict()));
            }
            manifest_entries.push(entry);
        }
    }

    // 2. Ryu Marketplace federated source (best-effort; never blanks built-ins).
    let mut marketplace_entries: Vec<serde_json::Value> = Vec::new();
    if let Some(source) = state.catalog_sources.source_by_id(
        crate::catalog_source::CatalogKind::Plugin,
        "ryu-marketplace",
    ) {
        let q = crate::catalog_source::CatalogQuery {
            limit: 40,
            ..Default::default()
        };
        if let Ok(val) = source.search(&state.client, &q).await {
            if let Some(items) = val.get("items").and_then(|v| v.as_array()) {
                marketplace_entries = items
                    .iter()
                    .filter_map(|it| plugin_marketplace_item_to_entry(it, source.id()))
                    .collect();
            }
        }
    }

    // 2b. Read-only compatibility fallback: the old central `marketplace.json`
    // repo, exposed as `ryu-catalog`. New GitHub-backed listings never depend on
    // this path; a fetch failure leaves it empty and never blanks built-ins.
    let mut git_catalog_entries: Vec<serde_json::Value> = Vec::new();
    if let Some(source) = state
        .catalog_sources
        .source_by_id(crate::catalog_source::CatalogKind::Plugin, "ryu-catalog")
    {
        let q = crate::catalog_source::CatalogQuery {
            limit: 100,
            ..Default::default()
        };
        if let Ok(val) = source.search(&state.client, &q).await {
            if let Some(items) = val.get("items").and_then(|v| v.as_array()) {
                git_catalog_entries = items
                    .iter()
                    .filter_map(|it| plugin_marketplace_item_to_entry(it, source.id()))
                    .collect();
            }
        }
    }

    // 3. Legacy remote registry (retained as the lowest-priority compatibility
    // fallback while GitHub-backed listings become the source of record).
    let catalog = state.catalog_client.fetch_catalog().await;
    let registry_entries: Vec<serde_json::Value> = serde_json::to_value(&catalog)
        .ok()
        .and_then(|v| v.get("entries").and_then(|e| e.as_array()).cloned())
        .unwrap_or_default();

    // Dedup by id, first-writer-wins: loaded built-ins > compiled built-in apps >
    // GitHub-backed hosted marketplace > legacy central index > legacy registry.
    // The compiled built-in-app
    // group sits above the remote sources so a not pre-installed Core app is classified
    // from its authoritative fixture (companion `type:"app"`) instead of the open
    // catalog's bare plugin card.
    let merged = merge_plugin_catalog_entries(vec![
        manifest_entries,
        BUILTIN_APP_ENTRIES.clone(),
        marketplace_entries,
        git_catalog_entries,
        registry_entries,
    ]);

    // Drop listings marked `hidden`.
    //
    // Applied AFTER the merge, not before it, and that ordering is the whole point:
    // dedup is first-writer-wins, so a hidden built-in manifest must still be the
    // entry that WINS its id — otherwise a lower-priority remote card for the same
    // plugin would take the slot and the listing would reappear, unhidden and with
    // worse metadata. Suppress the winner; never let a loser be promoted.
    //
    // This is browse-only. `hidden` says "do not offer this in the Store", not "this
    // does not exist": an already-installed hidden app keeps working, keeps its
    // routes, and still shows up in the installed list — which is what makes the
    // flag safe to set on something that is already shipping.
    merged
        .into_iter()
        .filter(|e| e.get("hidden").and_then(serde_json::Value::as_bool) != Some(true))
        .collect()
}

/// Every non-excluded marketplace's plugin listings, in one list, each row stamped
/// with the marketplace it came from.
///
/// The stamp (`catalog_source_id` / `catalog_source_name`) is what makes this a
/// grouped view rather than an undifferentiated pile — the client renders one
/// heading per source and files each row under it. It is a NEW pair of keys rather
/// than a reuse of the existing `source`, which is per-entry provenance
/// (`"built-in"`, a repo host, …) and does not name a browsable marketplace.
///
/// Ordering and dedup are one rule: sources are visited in
/// [`all_plugin_view_sources`] order and the FIRST source to claim an id keeps it.
/// So the unified first-party view — which answers from compiled manifests and a
/// cached catalog, and is the one that knows an app is built in — always wins over
/// a federated source that happens to list the same id, and no listing can appear
/// under two headings.
///
/// Every source is best-effort: one that errors, rate-limits or times out
/// contributes nothing and is logged, exactly as it would when browsed alone. A
/// dead marketplace must not blank the other four.
pub(in crate::server) async fn all_plugin_catalog_entries(
    state: &ServerState,
    query: &str,
    limit: usize,
) -> Vec<serde_json::Value> {
    let needle = query.trim().to_ascii_lowercase();
    let mut out: Vec<serde_json::Value> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for meta in all_plugin_view_sources(state) {
        let entries: Vec<serde_json::Value> = if is_merged_plugin_view(&meta.id) {
            merged_plugin_catalog_entries(state)
                .await
                .into_iter()
                .filter(|e| plugin_entry_matches_query(e, &needle))
                .collect()
        } else {
            let Some(source) = plugin_source_by_id(state, &meta.id).await else {
                continue;
            };
            let q = crate::catalog_source::CatalogQuery {
                query: query.to_string(),
                limit,
                ..Default::default()
            };
            // Bounded, and that bound is the point. `state.client` is a
            // `reqwest::Client::new()` with NO timeout, so a marketplace that
            // accepts the connection and then stops talking hangs its request
            // forever. Browsing that source alone, the cost was one stuck tab the
            // user had chosen; here it is the DEFAULT store page for everyone, and
            // a source is only ever a bonus shelf on it. A slow one is dropped from
            // this render rather than allowed to hold the whole page.
            match tokio::time::timeout(PLUGIN_ALL_SOURCE_TIMEOUT, source.search(&state.client, &q))
                .await
            {
                Ok(Ok(val)) => val
                    .get("items")
                    .and_then(|v| v.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|it| plugin_marketplace_item_to_entry(it, source.id()))
                            .collect()
                    })
                    .unwrap_or_default(),
                Ok(Err(e)) => {
                    tracing::warn!(
                        source = %meta.id,
                        error = %e,
                        "plugin source failed in the all-marketplaces view; skipping it"
                    );
                    continue;
                }
                Err(_) => {
                    tracing::warn!(
                        source = %meta.id,
                        timeout_secs = PLUGIN_ALL_SOURCE_TIMEOUT.as_secs(),
                        "plugin source timed out in the all-marketplaces view; skipping it"
                    );
                    continue;
                }
            }
        };

        for mut entry in entries {
            let Some(id) = entry.get("id").and_then(|v| v.as_str()).map(str::to_owned) else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            if let Some(obj) = entry.as_object_mut() {
                obj.insert("catalog_source_id".to_string(), json!(meta.id));
                obj.insert(
                    "catalog_source_name".to_string(),
                    json!(meta.display_name.clone()),
                );
            }
            out.push(entry);
        }
    }
    out
}

pub(in crate::server) fn plugin_entry_matches_query(
    entry: &serde_json::Value,
    needle: &str,
) -> bool {
    if needle.is_empty() {
        return true;
    }
    let name = entry
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let description = entry
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let id = entry
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    name.contains(needle) || description.contains(needle) || id.contains(needle)
}
