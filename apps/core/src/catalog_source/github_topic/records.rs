//! Record-set merges, dual-topic classification, and id parsing.

use super::*;
use crate::catalog_source::brand_guard::is_protected_brand_name;

/// Carry already-probed manifests from the previous record set onto a freshly
/// fetched one, matched by lowercased `full_name`.
///
/// This is what makes hydration cost ~nothing in steady state: a 6h refresh
/// re-fetches the two Search pages, but the manifests it already knows about
/// (including the *misses*) come along for free, so only genuinely new listings
/// and expired probes cost a raw fetch.
pub(crate) fn carry_manifests(
    records: &mut [GithubTopicRecord],
    previous: Option<&[GithubTopicRecord]>,
) {
    let Some(previous) = previous else {
        return;
    };
    let known: std::collections::HashMap<String, &GithubTopicRecord> = previous
        .iter()
        .map(|r| (r.full_name.to_ascii_lowercase(), r))
        .collect();
    for record in records.iter_mut() {
        if let Some(prior) = known.get(&record.full_name.to_ascii_lowercase()) {
            record.manifest = prior.manifest.clone();
            record.manifest_probed_at = prior.manifest_probed_at;
            record.marketplace = prior.marketplace.clone();
            record.marketplace_probed_at = prior.marketplace_probed_at;
        }
    }
}

/// The repos that answered BOTH topic queries, by lowercased `full_name`.
///
/// Publishers routinely tag `ryu-app` AND `ryu-plugin` for discoverability, so this
/// set is not an edge case — it is the population whose tab used to be decided by
/// which query this source happened to run first.
pub(crate) fn dual_topic_names(
    apps: &[GithubTopicRecord],
    plugins: &[GithubTopicRecord],
) -> std::collections::HashSet<String> {
    let app_names: std::collections::HashSet<String> = apps
        .iter()
        .map(|r| r.full_name.to_ascii_lowercase())
        .collect();
    plugins
        .iter()
        .map(|r| r.full_name.to_ascii_lowercase())
        .filter(|n| app_names.contains(n))
        .collect()
}

/// Decide app-vs-plugin for the repos that carried BOTH topics, from the manifest
/// instead of from query order.
///
/// A SINGLE-topic repo is never touched: the publisher answered the question and
/// this must not overrule them. For a dual-tagged repo there is no answer in the
/// topics at all, and the old rule ("apps are queried first, so apps win") meant
/// every such repo landed in the Apps tab — including four-line tool plugins whose
/// own manifest says otherwise.
///
/// The fallback is deliberately today's behaviour: a repo with no manifest, or one
/// whose probe timed out or is negatively cached, stays an app. Classification now
/// depends on a deadline-bounded probe ([`MANIFEST_HYDRATE_DEADLINE`]) with a 7-day
/// negative cache, so the failure mode has to be "unchanged", never "moves to the
/// other tab until the network is better".
pub(crate) fn resolve_dual_topic_classification(
    records: &mut [GithubTopicRecord],
    dual_topic: &std::collections::HashSet<String>,
) {
    if dual_topic.is_empty() {
        return;
    }
    for record in records.iter_mut() {
        // Marketplace records classify per ENTRY (from `hasCompanion`), never from
        // the marketplace repo's own manifest — a collection can hold both kinds.
        if record.is_marketplace {
            continue;
        }
        if !dual_topic.contains(&record.full_name.to_ascii_lowercase()) {
            continue;
        }
        if let Some(manifest) = record.manifest.as_ref() {
            record.is_app = manifest.has_destination;
        }
    }
}

/// Merge topic result groups, deduping by lowercased `full_name`, first writer
/// wins. Called with `[apps, plugins]`, so a repo carrying both topics collapses to
/// the app-topic row — whose classification
/// [`resolve_dual_topic_classification`] then settles from the manifest.
pub(crate) fn dedupe_records(groups: Vec<Vec<GithubTopicRecord>>) -> Vec<GithubTopicRecord> {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<GithubTopicRecord> = Vec::new();
    for group in groups {
        for record in group {
            if seen.insert(record.full_name.to_ascii_lowercase()) {
                out.push(record);
            }
        }
    }
    out
}

/// Fold `ryu-marketplace` records into the app/plugin record set, matched by
/// lowercased `full_name`.
///
/// A repo tagged `ryu-marketplace` — often ALSO `ryu-app`/`ryu-plugin` for
/// discoverability — is a COLLECTION, so the marketplace record REPLACES a
/// single-listing record of the same repo (it expands to its entries under the
/// marketplace heading instead of rendering once as a bare plugin). Pure, so the
/// precedence is unit-testable without a live fetch.
pub(crate) fn merge_marketplace_records(
    mut records: Vec<GithubTopicRecord>,
    marketplaces: Vec<GithubTopicRecord>,
) -> Vec<GithubTopicRecord> {
    for marketplace in marketplaces {
        let key = marketplace.full_name.to_ascii_lowercase();
        if let Some(pos) = records
            .iter()
            .position(|r| r.full_name.to_ascii_lowercase() == key)
        {
            records[pos] = marketplace;
        } else {
            records.push(marketplace);
        }
    }
    records
}

/// Split a `gh:<owner>/<repo>` id. Returns `None` for any foreign id — checked
/// before any network call, so the install-by-id probe loop never touches GitHub
/// for an unrelated plugin.
pub(crate) fn parse_gh_id(id: &str) -> Option<(String, String)> {
    let rest = id.trim().strip_prefix(GH_ID_PREFIX)?;
    let (owner, repo) = rest.split_once('/')?;
    let (owner, repo) = (owner.trim(), repo.trim());
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// Split a `ghmp:<mkt-owner>/<mkt-repo>:<entry-name>` id into its three parts.
/// Returns `None` for any foreign id — checked before any network call, so a
/// marketplace-entry id is rejected in O(1) exactly like a foreign `gh:` one.
/// An entry name must be a single path segment (no `/`), since it becomes part
/// of the id and must never be confused with a repo path.
pub(crate) fn parse_ghmp_id(id: &str) -> Option<(String, String, String)> {
    let rest = id.trim().strip_prefix(GHMP_ID_PREFIX)?;
    let (mkt, entry) = rest.split_once(':')?;
    let (owner, repo) = mkt.split_once('/')?;
    let (owner, repo, entry) = (owner.trim(), repo.trim(), entry.trim());
    if owner.is_empty()
        || repo.is_empty()
        || repo.contains('/')
        || entry.is_empty()
        || entry.contains('/')
    {
        return None;
    }
    Some((owner.to_string(), repo.to_string(), entry.to_string()))
}

/// Project one marketplace entry onto the Plugin-kind card shape that
/// `plugin_marketplace_item_to_entry` reads.
///
/// Same trust posture as [`record_to_item`]: presentation (name, icon, banner)
/// comes from the marketplace's OWN `marketplace.json`, identity (id, owner,
/// developer) from GitHub, and the trust triple (`origin` / `reviewed` /
/// `descriptor_only`) is Core's. Two additions for the grouped shelf:
///
/// - `catalog_source_id` / `catalog_source_name` name the MARKETPLACE this entry
///   came from, so the client renders one sub-heading per marketplace under the
///   "Community Marketplaces" section (the `all` view overwrites these with the
///   browsed source's meta, so the stamp is only meaningful on this feed).
/// - `repo_url` / `install_source` point at the plugin's OWN repository (the
///   entry's `source`), which is what the browse-only link-out / install-from-URL
///   handoff uses — the marketplace repo itself is a collection, not the plugin.
pub(crate) fn marketplace_entry_to_item(
    record: &GithubTopicRecord,
    marketplace: &GithubMarketplace,
    entry: &GithubMarketplaceEntry,
) -> Value {
    let repo_url = entry
        .source_repo
        .clone()
        .unwrap_or_else(|| record.html_url.clone());
    let declared_name = entry
        .display_name
        .clone()
        .unwrap_or_else(|| entry.name.clone());
    let guarded = is_protected_brand_name(&declared_name);
    let qualified = format!(
        "{}/{}",
        record.full_name,
        entry.package_path.as_deref().unwrap_or(&entry.name)
    );
    serde_json::json!({
        "id": format!("{GHMP_ID_PREFIX}{}/{}:{}", record.owner, record.repo, entry.name),
        "name": guarded_display_name(declared_name, &qualified),
        "description": entry.description.clone().unwrap_or_default(),
        "version": entry.version.clone().unwrap_or_default(),
        "install_source": repo_url,
        "url": repo_url,
        "repo_url": repo_url,
        "package_path": entry.package_path.clone(),
        "package": entry.package_path.is_some(),
        "installed": false,
        "type": if entry.has_companion { "app" } else { "plugin" },
        "has_companion": entry.has_companion,
        "developer": record.owner,
        "owner": record.owner,
        "icon": guarded_icon_id(entry.icon.clone(), guarded),
        "icon_url": entry.icon_url.clone().filter(|_| !guarded),
        "icon_dither": entry.icon_dither.clone(),
        "icon_background": entry.icon_background.clone(),
        "banner": entry.banner.clone().filter(|_| !guarded),
        "surface_support": entry.surface_support.clone(),
        "tags": entry.tags.clone(),
        "category": entry.category.clone().unwrap_or_else(|| "Community".to_string()),
        "tagline": entry.tagline.clone().or_else(|| entry.description.clone()),
        "stars": record.stars,
        "license": record.license,
        "pushed_at": record.pushed_at,
        "topics": record.topics,
        // The grouping stamp — the client files this row under the marketplace's
        // heading. Same keys the `all` view stamps per source.
        "catalog_source_id": record.full_name,
        "catalog_source_name": guarded_display_name(marketplace.name.clone(), &record.full_name),
        // The trust triple — identical to any community listing.
        "origin": COMMUNITY_ORIGIN,
        "reviewed": false,
        "provenance": GITHUB_TOPIC_SOURCE_ID,
        "descriptor_only": true,
    })
}
