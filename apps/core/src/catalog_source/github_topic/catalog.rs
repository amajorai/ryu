//! The `CatalogSource` implementation for the GitHub-topic source, and the
//! detail view of one community marketplace entry.

use super::*;
use crate::catalog_source::brand_guard::is_protected_brand_name;

impl CatalogSource for GithubTopicSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Plugin
    }

    async fn search(&self, _client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let limit = if q.limit == 0 { 40 } else { q.limit };
        let offset = q
            .cursor
            .as_deref()
            .and_then(|c| c.trim().parse::<usize>().ok())
            .unwrap_or(0);
        match self.records().await {
            Ok(cache) => {
                let needle = q.query.trim().to_ascii_lowercase();
                let type_filter = q.extra_str("github_topic_type").to_ascii_lowercase();
                // Expand marketplace records into their entries FIRST, then apply
                // the filters at the item level. A `ryu-marketplace` repo with a
                // parsed `marketplace.json` contributes one row per entry; one
                // without (or not yet hydrated) degrades to a single repo listing.
                let expanded: Vec<Value> = cache
                    .records
                    .iter()
                    .flat_map(|record| match record.marketplace.as_ref() {
                        Some(marketplace) if !marketplace.entries.is_empty() => marketplace
                            .entries
                            .iter()
                            .map(|entry| marketplace_entry_to_item(record, marketplace, entry))
                            .collect::<Vec<Value>>(),
                        _ => vec![record_to_item(record)],
                    })
                    .collect();
                let item_matches = |item: &Value| {
                    if needle.is_empty() {
                        return true;
                    }
                    let hay = [
                        item.get("name").and_then(Value::as_str).unwrap_or(""),
                        item.get("description")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                        item.get("id").and_then(Value::as_str).unwrap_or(""),
                    ];
                    if hay.iter().any(|s| s.to_ascii_lowercase().contains(&needle)) {
                        return true;
                    }
                    // Topics were matched before the filter moved to the item level
                    // (a repo tagged `ryu-plugin` + `ai` used to answer a search for
                    // "ai"); keep that so the move is not a search regression.
                    item.get("topics")
                        .and_then(Value::as_array)
                        .is_some_and(|topics| {
                            topics.iter().any(|t| {
                                t.as_str()
                                    .is_some_and(|t| t.to_ascii_lowercase().contains(&needle))
                            })
                        })
                };
                let filtered: Vec<Value> = expanded
                    .into_iter()
                    .filter(|item| match type_filter.as_str() {
                        "app" => item.get("type").and_then(Value::as_str) == Some("app"),
                        "plugin" => item.get("type").and_then(Value::as_str) != Some("app"),
                        _ => true,
                    })
                    .filter(item_matches)
                    .collect();
                let total = filtered.len();
                let next_cursor = (offset + limit < total).then(|| (offset + limit).to_string());
                let items: Vec<Value> = filtered.into_iter().skip(offset).take(limit).collect();
                Ok(self.wrap_items(items, &cache.source_url, cache.note.as_deref(), next_cursor))
            }
            // `search` never propagates: an offline store shows an empty section
            // with a note, not an error page.
            Err(e) => Ok(self.wrap_items(
                Vec::new(),
                &self.resolve_api_base(),
                Some(&e.to_string()),
                None,
            )),
        }
    }

    async fn detail(&self, _client: &reqwest::Client, id: &str) -> Result<Value> {
        // Marketplace entries are a distinct id namespace (`ghmp:`), handled by
        // their own detail path. Foreign ids are rejected before any egress (the
        // install probe loop).
        if let Some((owner, repo, entry_name)) = parse_ghmp_id(id) {
            return detail_marketplace_entry(self, &owner, &repo, &entry_name).await;
        }
        if parse_gh_id(id).is_none() {
            anyhow::bail!("`{id}` is not a GitHub-topic catalog id");
        }
        let cache = self.records().await?;
        let record = cache
            .records
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| anyhow::anyhow!("community listing `{id}` not found"))?;

        // Same rule the card uses: the manifest names and icons the listing, GitHub
        // owns its identity. Kept in lockstep with `record_to_item` so opening a
        // card never renames the thing you clicked on.
        let declared = record.manifest.as_ref();
        let declared_name = declared
            .and_then(|m| m.name.clone())
            .unwrap_or_else(|| record.repo.clone());
        let guarded = is_protected_brand_name(&declared_name);
        let mut detail = serde_json::json!({
            "id": record.id,
            "name": guarded_display_name(declared_name, &record.full_name),
            "description": declared
                .and_then(|m| m.description.clone())
                .or_else(|| record.description.clone()),
            "icon": guarded_icon_id(declared.and_then(|m| m.icon.clone()), guarded),
            // No owner-avatar fallback, for the reason spelled out in
            // `record_to_item`: it suppressed the seeded tile on every art-less
            // listing. In lockstep with the card so the hero and the row you clicked
            // paint the same square.
            "iconUrl": declared.and_then(|m| m.icon_url.clone()).filter(|_| !guarded),
            "developer": record.owner,
            "homepage": record.homepage,
            "repositoryUrl": record.html_url,
            "license": record.license,
            "stars": record.stars,
            "topics": record.topics,
            "updatedAt": record.pushed_at,
            "type": if record.is_app { "app" } else { "plugin" },
            "source": self.display_name,
            "sourceUrl": cache.source_url,
            "origin": COMMUNITY_ORIGIN,
            "reviewed": false,
            "provenance": GITHUB_TOPIC_SOURCE_ID,
            "descriptorOnly": true,
            "discoveredFrom": {
                "topic": Self::topic(record.is_app),
                "repositoryUrl": record.html_url,
            },
        });

        // Repository enrichment (README, releases, timestamps, download counts) —
        // best-effort and cached, so a rate-limited GitHub costs a few tabs, not
        // the page. Merged BEFORE the manifest so a manifest-declared value (the
        // publisher's own claim) still wins where the two overlap.
        if let Some(obj) = detail.as_object_mut() {
            let enrichment = crate::catalog_source::github_enrich::enrich_repo(
                &record.id,
                &self.resolve_api_base(),
                &self.request_headers(),
                &record.owner,
                &record.repo,
            )
            .await;
            if let Some(fields) = enrichment.as_object() {
                for (k, v) in fields {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }

        match self.fetch_repo_manifest(record).await {
            Some((manifest, url)) => {
                if let Some(obj) = detail.as_object_mut() {
                    for (k, v) in manifest_display_fields_for_card(&manifest, guarded) {
                        obj.insert(k, v);
                    }
                    for (k, v) in
                        crate::catalog_source::manifest_surface::project_manifest(&manifest)
                    {
                        obj.insert(k, v);
                    }
                    obj.insert("manifestUrl".to_string(), Value::String(url));
                }
            }
            None => {
                if let Some(obj) = detail.as_object_mut() {
                    obj.insert(
                        "enrichmentError".to_string(),
                        Value::String(
                            "No plugin manifest found at the repository root.".to_string(),
                        ),
                    );
                }
            }
        }
        Ok(detail)
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        // A marketplace entry installs from the plugin's OWN repo, never the
        // marketplace's. Same descriptor-only posture as a `gh:` listing: no
        // `raw.manifest`, so install-by-id stays fail-closed for this unsigned
        // source and a real install goes through `POST /api/plugins/install` on
        // the repo URL.
        if let Some((owner, repo, entry_name)) = parse_ghmp_id(id) {
            let cache = self.records().await?;
            let record = cache
                .records
                .iter()
                .find(|r| r.owner == owner && r.repo == repo)
                .ok_or_else(|| {
                    anyhow::anyhow!("community marketplace `{owner}/{repo}` not found")
                })?;
            let marketplace = record.marketplace.as_ref().ok_or_else(|| {
                anyhow::anyhow!("community marketplace `{owner}/{repo}` has no listings")
            })?;
            let entry = marketplace
                .entries
                .iter()
                .find(|e| e.name == entry_name)
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "listing `{entry_name}` not found in marketplace `{owner}/{repo}`"
                    )
                })?;
            let repo_url = entry
                .source_repo
                .clone()
                .unwrap_or_else(|| record.html_url.clone());
            return Ok(InstallDescriptor {
                kind: CatalogKind::Plugin,
                source_id: self.id.clone(),
                repo_id: id.to_string(),
                files: Vec::new(),
                raw: serde_json::json!({
                    "install_source": repo_url,
                    "repo_url": repo_url,
                    "origin": COMMUNITY_ORIGIN,
                    "reviewed": false,
                    "provenance": GITHUB_TOPIC_SOURCE_ID,
                }),
            });
        }
        let (owner, repo) =
            parse_gh_id(id).ok_or_else(|| anyhow::anyhow!("`{id}` is not a GitHub-topic id"))?;
        // DESCRIPTOR-ONLY, and deliberately so: no `raw.manifest` key. That is what
        // makes `resolve_plugin_from_catalog` skip this source fail-closed instead of
        // treating an unsigned third-party repo as an install path. A user who
        // genuinely wants one installs it explicitly via `POST /api/plugins/install`
        // against the repo URL — a per-repo act, not a catalog-wide trust grant.
        Ok(InstallDescriptor {
            kind: CatalogKind::Plugin,
            source_id: self.id.clone(),
            repo_id: id.to_string(),
            files: Vec::new(),
            raw: serde_json::json!({
                "install_source": format!("https://github.com/{owner}/{repo}"),
                "repo_url": format!("https://github.com/{owner}/{repo}"),
                "origin": COMMUNITY_ORIGIN,
                "reviewed": false,
                "provenance": GITHUB_TOPIC_SOURCE_ID,
            }),
        })
    }
}

/// Detail for a marketplace ENTRY (`ghmp:` id): the marketplace's parsed
/// `marketplace.json` entry, attributed to the marketplace it came from and
/// enriched from the plugin's OWN repository when that is a GitHub repo.
///
/// A free function (not a trait method) because it is a helper of the
/// `CatalogSource` impl's `detail` — a trait impl may only contain trait methods.
pub(super) async fn detail_marketplace_entry(
    source: &GithubTopicSource,
    owner: &str,
    repo: &str,
    entry_name: &str,
) -> Result<Value> {
    let cache = source.records().await?;
    let record = cache
        .records
        .iter()
        .find(|r| r.owner == owner && r.repo == repo)
        .ok_or_else(|| anyhow::anyhow!("community marketplace `{owner}/{repo}` not found"))?;
    let marketplace = record
        .marketplace
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("community marketplace `{owner}/{repo}` has no listings"))?;
    let entry = marketplace
        .entries
        .iter()
        .find(|e| e.name == entry_name)
        .ok_or_else(|| {
            anyhow::anyhow!("listing `{entry_name}` not found in marketplace `{owner}/{repo}`")
        })?;

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
    let mut detail = serde_json::json!({
        "id": format!("{GHMP_ID_PREFIX}{owner}/{repo}:{entry_name}"),
        "name": guarded_display_name(declared_name, &qualified),
        "description": entry.description.clone().or_else(|| record.description.clone()),
        "icon": guarded_icon_id(entry.icon.clone(), guarded),
        "iconUrl": entry.icon_url.clone().filter(|_| !guarded),
        "developer": record.owner,
        "homepage": entry.homepage.clone(),
        "repositoryUrl": repo_url,
        "license": record.license,
        "stars": record.stars,
        "topics": record.topics,
        "updatedAt": record.pushed_at,
        "type": if entry.has_companion { "app" } else { "plugin" },
        "source": source.display_name,
        "sourceUrl": cache.source_url,
        "origin": COMMUNITY_ORIGIN,
        "reviewed": false,
        "provenance": GITHUB_TOPIC_SOURCE_ID,
        "descriptorOnly": true,
        "discoveredFrom": {
            "topic": GithubTopicSource::marketplace_topic(),
            "repositoryUrl": record.html_url,
        },
    });

    // Enrich from the plugin's OWN repo (the entry's `source`) when it is a
    // GitHub repo — the same README / releases / manifest lift a normal
    // community listing gets. The marketplace repo is a collection; the code
    // and the README live where `source` points.
    let entry_id = detail["id"].as_str().unwrap_or("").to_string();
    if let Some((src_owner, src_repo)) = crate::catalog_source::split_github_repo(&repo_url) {
        if let Some(obj) = detail.as_object_mut() {
            let enrichment = crate::catalog_source::github_enrich::enrich_repo(
                &entry_id,
                &source.resolve_api_base(),
                &source.request_headers(),
                &src_owner,
                &src_repo,
            )
            .await;
            if let Some(fields) = enrichment.as_object() {
                for (k, v) in fields {
                    obj.insert(k.clone(), v.clone());
                }
            }
        }
        match fetch_repo_manifest_for(&src_owner, &src_repo).await {
            Some((manifest, url)) => {
                if let Some(obj) = detail.as_object_mut() {
                    for (k, v) in manifest_display_fields_for_card(&manifest, guarded) {
                        obj.insert(k, v);
                    }
                    for (k, v) in
                        crate::catalog_source::manifest_surface::project_manifest(&manifest)
                    {
                        obj.insert(k, v);
                    }
                    obj.insert("manifestUrl".to_string(), Value::String(url));
                }
            }
            None => {
                if let Some(obj) = detail.as_object_mut() {
                    obj.insert(
                        "enrichmentError".to_string(),
                        Value::String(
                            "No plugin manifest found at the repository root.".to_string(),
                        ),
                    );
                }
            }
        }
    }
    Ok(detail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn install_descriptor_never_carries_a_manifest() {
        // REGRESSION GUARD. `resolve_plugin_from_catalog` reads `raw["manifest"]`;
        // an absent one is what keeps install-by-id fail-closed for this unsigned
        // source. Do not "helpfully" add it.
        let source = GithubTopicSource::builtin();
        let client = reqwest::Client::new();
        let descriptor = source
            .install_descriptor(&client, "gh:acme/ryu-thing")
            .await
            .unwrap();
        assert!(descriptor.raw.get("manifest").is_none());
        assert!(descriptor.files.is_empty());
        assert_eq!(descriptor.raw["reviewed"], false);
        assert_eq!(descriptor.raw["origin"], COMMUNITY_ORIGIN);
        // A foreign id is refused without touching the network.
        assert!(source
            .install_descriptor(&client, "@ryu/mail")
            .await
            .is_err());
    }
}
