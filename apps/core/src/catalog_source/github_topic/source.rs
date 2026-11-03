//! Topic search, refresh and manifest hydration for the source handle.

use super::*;

impl GithubTopicSource {
    pub fn builtin() -> Self {
        Self {
            id: GITHUB_TOPIC_SOURCE_ID.to_string(),
            display_name: "GitHub (community)".to_string(),
            api_base: None,
            token: GITHUB_TOKEN_ENVS.iter().find_map(|key| {
                std::env::var(key)
                    .ok()
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
            }),
        }
    }

    pub(super) fn resolve_api_base(&self) -> String {
        let base = self
            .api_base
            .clone()
            .filter(|u| !u.trim().is_empty())
            .or_else(|| {
                std::env::var(GITHUB_API_BASE_ENV)
                    .ok()
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty())
            })
            .unwrap_or_else(|| GITHUB_API_BASE.to_string());
        base.trim_end_matches('/').to_string()
    }

    /// The token, **only** when talking to the default host. A custom base (a
    /// mirror, an enterprise host, an attacker-supplied env value) must never
    /// receive the user's PAT — the same strict-host rule Smithery's key follows.
    pub(super) fn resolve_token(&self) -> Option<&str> {
        if self.resolve_api_base() != GITHUB_API_BASE {
            return None;
        }
        self.token
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
    }

    pub(super) fn topic(is_app: bool) -> String {
        let (env_key, default) = if is_app {
            (GITHUB_TOPIC_APP_ENV, GITHUB_TOPIC_APP)
        } else {
            (GITHUB_TOPIC_PLUGIN_ENV, GITHUB_TOPIC_PLUGIN)
        };
        std::env::var(env_key)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| default.to_string())
    }

    /// The `ryu-marketplace` topic string, env-overridable like the other two.
    pub(super) fn marketplace_topic() -> String {
        std::env::var(GITHUB_TOPIC_MARKETPLACE_ENV)
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| GITHUB_TOPIC_MARKETPLACE.to_string())
    }

    pub(super) fn cache_ttl() -> std::time::Duration {
        let secs = std::env::var(GITHUB_TOPIC_TTL_ENV)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| *s > 0)
            .unwrap_or(GITHUB_TOPIC_DEFAULT_TTL_SECS);
        std::time::Duration::from_secs(secs)
    }

    pub(super) fn search_url(&self, topic: &str) -> String {
        format!(
            "{}/search/repositories?q={}&sort=stars&order=desc&per_page={}",
            self.resolve_api_base(),
            urlencoding::encode(&format!("topic:{topic}")),
            GITHUB_TOPIC_PER_PAGE,
        )
    }

    pub(super) fn request_headers(&self) -> Vec<(String, String)> {
        let mut headers = vec![
            (
                "Accept".to_string(),
                "application/vnd.github+json".to_string(),
            ),
            ("X-GitHub-Api-Version".to_string(), "2022-11-28".to_string()),
        ];
        if let Some(token) = self.resolve_token() {
            headers.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        headers
    }

    pub(super) async fn fetch_topic(&self, is_app: bool) -> Result<Vec<GithubTopicRecord>> {
        let topic = Self::topic(is_app);
        let url = self.search_url(&topic);
        let bytes = crate::server::guarded_get_bytes_with_headers(&url, &self.request_headers())
            .await
            .map_err(|e| anyhow::anyhow!("fetching GitHub topic `{topic}`: {e}"))?;
        let envelope: GithubSearchEnvelope = serde_json::from_slice(&bytes)
            .map_err(|e| anyhow::anyhow!("parsing GitHub topic `{topic}` results: {e}"))?;
        Ok(envelope
            .items
            .iter()
            .filter_map(|item| repo_item_to_record(item, is_app))
            .collect())
    }

    /// Fetch the `ryu-marketplace` topic — the community MARKETPLACE population.
    /// One extra Search call in the same rate-limit budget as the two below.
    pub(super) async fn fetch_topic_marketplace(&self) -> Result<Vec<GithubTopicRecord>> {
        let topic = Self::marketplace_topic();
        let url = self.search_url(&topic);
        let bytes = crate::server::guarded_get_bytes_with_headers(&url, &self.request_headers())
            .await
            .map_err(|e| anyhow::anyhow!("fetching GitHub topic `{topic}`: {e}"))?;
        let envelope: GithubSearchEnvelope = serde_json::from_slice(&bytes)
            .map_err(|e| anyhow::anyhow!("parsing GitHub topic `{topic}` results: {e}"))?;
        Ok(envelope
            .items
            .iter()
            .filter_map(repo_item_to_marketplace_record)
            .collect())
    }

    pub(super) async fn fetch_records(
        &self,
        previous: Option<&GithubTopicCache>,
    ) -> Result<GithubTopicCache> {
        // Apps first, then plugins, so a repo carrying BOTH topics survives the
        // first-writer-wins dedupe below as ONE row. Which tab that row belongs in
        // is then decided by evidence rather than by this ordering — see
        // `resolve_dual_topic_classification`, which runs after hydration because
        // the evidence is the repo's own manifest.
        let apps = self.fetch_topic(true).await?;
        let plugins = self.fetch_topic(false).await?;
        let marketplaces = self.fetch_topic_marketplace().await?;
        let dual_topic = dual_topic_names(&apps, &plugins);
        // A repo tagged `ryu-marketplace` (often ALSO `ryu-app`/`ryu-plugin` for
        // discoverability) is a COLLECTION, not a single listing: the marketplace
        // classification wins, so its entries render grouped under the marketplace
        // heading instead of the repo appearing twice — once expanded and once as a
        // bare single-plugin row.
        let mut records =
            merge_marketplace_records(dedupe_records(vec![apps, plugins]), marketplaces);
        carry_manifests(&mut records, previous.map(|c| c.records.as_slice()));
        self.hydrate_manifests(&mut records).await;
        self.hydrate_marketplaces(&mut records).await;
        resolve_dual_topic_classification(&mut records, &dual_topic);
        Ok(GithubTopicCache {
            fetched_at: std::time::Instant::now(),
            records,
            source_url: self.resolve_api_base(),
            stale: false,
            note: None,
        })
    }

    /// Fill in each record's [`RepoManifestDisplay`] from the repo's own
    /// `manifest.json`, so a card is titled and iconed the way its author declared
    /// rather than by GitHub's repo slug and owner avatar.
    ///
    /// This is affordable only because of three properties, all load-bearing:
    ///
    /// 1. **`raw.githubusercontent.com` is a CDN**, not the Search API — these
    ///    fetches spend none of the 10 req/min search budget the rest of this
    ///    source is careful with.
    /// 2. **Results are remembered across refreshes**, positive AND negative
    ///    ([`carry_manifests`] + [`MANIFEST_PROBE_TTL_SECS`]). Most listings carry
    ///    no manifest, and a miss costs five fetches; without the negative cache
    ///    the steady-state cost would never amortize.
    /// 3. **The pass is deadline-bounded** ([`MANIFEST_HYDRATE_DEADLINE`]). What it
    ///    does not reach keeps its repo-derived presentation and `manifest_probed_at:
    ///    0`, so the next refresh retries it — a slow GitHub degrades the *cards*,
    ///    never the page.
    pub(super) async fn hydrate_manifests(&self, records: &mut [GithubTopicRecord]) {
        let now = unix_now();
        let pending: Vec<usize> = records
            .iter()
            .enumerate()
            .filter(|(_, r)| r.manifest_probe_is_due(now))
            .map(|(i, _)| i)
            .collect();
        if pending.is_empty() {
            return;
        }
        let probe = async {
            for chunk in pending.chunks(MANIFEST_HYDRATE_CONCURRENCY) {
                // Cloned up front so the borrow of `records` ends before the await —
                // the write-back below needs it mutably.
                let batch: Vec<(usize, GithubTopicRecord)> =
                    chunk.iter().map(|&i| (i, records[i].clone())).collect();
                let probed = futures_util::future::join_all(batch.into_iter().map(
                    |(i, record)| async move { (i, self.fetch_repo_manifest(&record).await) },
                ))
                .await;
                for (i, hit) in probed {
                    records[i].manifest = hit
                        .as_ref()
                        .and_then(|(manifest, _)| RepoManifestDisplay::from_manifest(manifest));
                    // Stamped on a MISS too — that is the negative cache.
                    records[i].manifest_probed_at = now;
                }
            }
        };
        if tokio::time::timeout(MANIFEST_HYDRATE_DEADLINE, probe)
            .await
            .is_err()
        {
            tracing::debug!(
                pending = pending.len(),
                "github-topic: manifest hydration hit its deadline; unhydrated listings retry on the next refresh"
            );
        }
    }

    /// Fill in each collection record's [`GithubMarketplace`] from package folders,
    /// so its entries can render grouped under the collection's name. Same cost
    /// story as [`Self::hydrate_manifests`]: raw CDN fetches, a positive/negative
    /// cross-refresh memory, and a deadline bound — what it does not reach
    /// degrades to a single repo listing on the next card.
    pub(super) async fn hydrate_marketplaces(&self, records: &mut [GithubTopicRecord]) {
        let now = unix_now();
        let pending: Vec<usize> = records
            .iter()
            .enumerate()
            .filter(|(_, r)| r.is_marketplace && r.marketplace_probe_is_due(now))
            .map(|(i, _)| i)
            .collect();
        if pending.is_empty() {
            return;
        }
        let probe = async {
            for chunk in pending.chunks(MANIFEST_HYDRATE_CONCURRENCY) {
                let batch: Vec<(usize, GithubTopicRecord)> =
                    chunk.iter().map(|&i| (i, records[i].clone())).collect();
                let probed = futures_util::future::join_all(batch.into_iter().map(
                    |(i, record)| async move { (i, self.fetch_repo_marketplace(&record).await) },
                ))
                .await;
                for (i, hit) in probed {
                    records[i].marketplace = hit;
                    // Stamped on a MISS too — that is the negative cache.
                    records[i].marketplace_probed_at = now;
                }
            }
        };
        if tokio::time::timeout(MANIFEST_HYDRATE_DEADLINE, probe)
            .await
            .is_err()
        {
            tracing::debug!(
                pending = pending.len(),
                "github-topic: marketplace hydration hit its deadline; unhydrated marketplaces retry on the next refresh"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_custom_api_base_suppresses_the_byok_token() {
        let default_host = GithubTopicSource {
            id: GITHUB_TOPIC_SOURCE_ID.to_string(),
            display_name: "GitHub (community)".to_string(),
            api_base: None,
            token: Some("ghp_secret".to_string()),
        };
        assert_eq!(default_host.resolve_token(), Some("ghp_secret"));

        let mirror = GithubTopicSource {
            api_base: Some("https://ghe.example.com/api/v3".to_string()),
            ..default_host.clone()
        };
        assert!(
            mirror.resolve_token().is_none(),
            "the user's PAT must never be sent to a non-default host"
        );
        assert!(!mirror
            .request_headers()
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("authorization")));
    }

    #[test]
    fn search_url_encodes_the_topic_qualifier() {
        let source = GithubTopicSource::builtin();
        let url = source.search_url("ryu-app");
        assert!(url.starts_with("https://api.github.com/search/repositories?q="));
        assert!(url.contains("topic%3Aryu-app"), "{url}");
        assert!(url.contains("per_page=100"));
    }
}
