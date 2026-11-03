//! The disk cache, the cached refresh, and the per-repo manifest probes.

use super::*;

pub(super) const OFFLINE_NOTE: &str = "Showing cached community listings — GitHub is unreachable.";

pub(super) fn stale_note(err: &str) -> String {
    let lower = err.to_ascii_lowercase();
    if lower.contains("403") || lower.contains("429") {
        "GitHub rate limit reached — showing cached community listings.".to_string()
    } else {
        OFFLINE_NOTE.to_string()
    }
}

impl GithubTopicSource {
    pub(super) fn disk_cache_path() -> std::path::PathBuf {
        crate::paths::cache_dir()
            .join("github-topic")
            .join("topics.json")
    }

    pub(super) fn read_disk_cache() -> Option<GithubTopicCache> {
        let raw = std::fs::read_to_string(Self::disk_cache_path()).ok()?;
        let envelope: DiskCacheEnvelope = serde_json::from_str(&raw).ok()?;
        if envelope.records.is_empty() {
            return None;
        }
        Some(GithubTopicCache {
            fetched_at: std::time::Instant::now(),
            records: envelope.records,
            source_url: envelope.source_url,
            stale: true,
            note: Some(OFFLINE_NOTE.to_string()),
        })
    }

    pub(super) fn write_disk_cache(cache: &GithubTopicCache) {
        let path = Self::disk_cache_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let envelope = DiskCacheEnvelope {
            fetched_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
            records: cache.records.clone(),
            source_url: cache.source_url.clone(),
        };
        if let Ok(json) = serde_json::to_string(&envelope) {
            let _ = std::fs::write(path, json);
        }
    }

    /// Cached records with **graceful degradation**: inside the TTL the warm copy is
    /// returned; on a refresh failure the last-good copy is served past its TTL
    /// (flagged `stale`, with a human note) rather than blanking the section. Only a
    /// process that has never fetched successfully — and has no disk copy — errors.
    pub(super) async fn records(&self) -> Result<GithubTopicCache> {
        let lock = GITHUB_TOPIC_CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
        let mut guard = lock.lock().await;
        if let Some(cache) = guard.as_ref() {
            if !cache.stale && cache.fetched_at.elapsed() < Self::cache_ttl() {
                return Ok(cache.clone());
            }
        }
        // The warm copy is handed to the refresh so its already-probed manifests
        // (hits AND misses) carry over instead of being re-fetched.
        match self.fetch_records(guard.as_ref()).await {
            Ok(cache) => {
                Self::write_disk_cache(&cache);
                *guard = Some(cache.clone());
                Ok(cache)
            }
            Err(err) => {
                // Last-good wins over an error: an unreachable/rate-limited GitHub
                // must degrade to a slightly-stale list, never to an empty store.
                if let Some(cache) = guard.as_ref() {
                    let mut stale = cache.clone();
                    stale.stale = true;
                    stale.note = Some(stale_note(&err.to_string()));
                    return Ok(stale);
                }
                if let Some(mut cache) = Self::read_disk_cache() {
                    cache.note = Some(stale_note(&err.to_string()));
                    *guard = Some(cache.clone());
                    return Ok(cache);
                }
                Err(err)
            }
        }
    }

    pub(super) fn wrap_items(
        &self,
        items: Vec<Value>,
        source_url: &str,
        note: Option<&str>,
        next_cursor: Option<String>,
    ) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("items".to_string(), Value::Array(items));
        obj.insert(
            "next_cursor".to_string(),
            next_cursor.map_or(Value::Null, Value::String),
        );
        obj.insert(
            "source_url".to_string(),
            Value::String(source_url.to_string()),
        );
        obj.insert(
            "cache_ttl_seconds".to_string(),
            Value::Number(Self::cache_ttl().as_secs().into()),
        );
        if let Some(note) = note {
            obj.insert("note".to_string(), Value::String(note.to_string()));
        }
        Value::Object(obj)
    }

    /// Best-effort manifest enrichment over `raw.githubusercontent.com` (a CDN — not
    /// on the Search API's rate-limit budget). Returns `(manifest_value, raw_url)`.
    pub(super) async fn fetch_repo_manifest(
        &self,
        record: &GithubTopicRecord,
    ) -> Option<(Value, String)> {
        fetch_repo_manifest_for(&record.owner, &record.repo).await
    }

    /// Best-effort portable-package enrichment for a `ryu-marketplace` repo.
    /// The Git tree is the collection index: every folder containing
    /// `ryu.package.json` becomes one card. No generated marketplace.json is
    /// consulted on the new path.
    pub(super) async fn fetch_repo_marketplace(
        &self,
        record: &GithubTopicRecord,
    ) -> Option<GithubMarketplace> {
        let tree_url = format!(
            "{}/repos/{}/git/trees/HEAD?recursive=1",
            self.resolve_api_base(),
            record.full_name
        );
        if let Ok(bytes) =
            crate::server::guarded_get_bytes_with_headers(&tree_url, &self.request_headers()).await
        {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                let mut entries = Vec::new();
                if let Some(tree) = value.get("tree").and_then(Value::as_array) {
                    for path in tree
                        .iter()
                        .filter_map(|entry| {
                            let obj = entry.as_object()?;
                            let path = obj.get("path")?.as_str()?;
                            (obj.get("type").and_then(Value::as_str) == Some("blob")
                                && (path == PACKAGE_MANIFEST_FILE
                                    || path.ends_with(&format!("/{PACKAGE_MANIFEST_FILE}"))))
                            .then_some(path.to_string())
                        })
                        .take(200)
                    {
                        let package_path = path
                            .strip_suffix(&format!("/{PACKAGE_MANIFEST_FILE}"))
                            .or_else(|| path.strip_suffix(PACKAGE_MANIFEST_FILE))
                            .unwrap_or_default()
                            .to_string();
                        let raw_url = format!(
                            "https://raw.githubusercontent.com/{}/{}/HEAD/{}",
                            record.owner, record.repo, path
                        );
                        let Ok(package_bytes) = crate::server::guarded_get_bytes(&raw_url).await
                        else {
                            continue;
                        };
                        let Ok(manifest) = serde_json::from_slice::<Value>(&package_bytes) else {
                            continue;
                        };
                        let package_url = if package_path.is_empty() {
                            format!("https://github.com/{}/tree/HEAD", record.full_name)
                        } else {
                            format!(
                                "https://github.com/{}/tree/HEAD/{}",
                                record.full_name, package_path
                            )
                        };
                        if let Some(entry) = GithubMarketplaceEntry::from_package_manifest(
                            &manifest,
                            package_path,
                            package_url,
                        ) {
                            entries.push(entry);
                        }
                    }
                }
                if !entries.is_empty() {
                    return Some(GithubMarketplace {
                        name: record.full_name.clone(),
                        entries,
                    });
                }
            }
        }
        // Compatibility fallback for old community repositories. This path is
        // intentionally read-only and is never generated or written by Ryu.
        for path in REPO_MARKETPLACE_PATHS {
            let url = format!(
                "https://raw.githubusercontent.com/{}/{}/HEAD/{}",
                record.owner, record.repo, path
            );
            let Ok(bytes) = crate::server::guarded_get_bytes(&url).await else {
                continue;
            };
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(marketplace) =
                    GithubMarketplace::from_manifest(&value, &record.full_name)
                {
                    return Some(marketplace);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_note_names_the_rate_limit() {
        assert!(
            stale_note("https://api.github.com/... returned HTTP 403 Forbidden")
                .contains("rate limit")
        );
        assert!(stale_note("dns error").contains("cached"));
    }

    #[test]
    fn wrap_items_reports_the_cursor_source_ttl_and_note() {
        let source = GithubTopicSource::builtin();
        let wrapped = source.wrap_items(
            vec![serde_json::json!({ "id": "gh:acme/thing" })],
            "https://api.github.com/search/repositories",
            Some(OFFLINE_NOTE),
            None,
        );
        assert_eq!(wrapped["items"][0]["id"], "gh:acme/thing");
        assert!(wrapped["next_cursor"].is_null());
        assert_eq!(
            wrapped["source_url"],
            "https://api.github.com/search/repositories"
        );
        assert_eq!(
            wrapped["cache_ttl_seconds"].as_u64(),
            Some(GithubTopicSource::cache_ttl().as_secs())
        );
        assert_eq!(wrapped["note"], OFFLINE_NOTE);
        let bare = source.wrap_items(Vec::new(), "u", None, Some("2".to_string()));
        assert_eq!(bare["next_cursor"], "2");
        assert!(bare.get("note").is_none());
    }
}
