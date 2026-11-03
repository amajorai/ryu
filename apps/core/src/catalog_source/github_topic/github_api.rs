//! GitHub Search payload shapes, the source handle, and repo-hit normalisation.

use super::*;

#[derive(Debug, Default, serde::Deserialize)]
pub(super) struct GithubSearchEnvelope {
    #[serde(default)]
    pub(super) items: Vec<GithubRepoItem>,
}

#[derive(Debug, Default, serde::Deserialize)]
pub(super) struct GithubRepoItem {
    #[serde(default)]
    pub(super) full_name: String,
    #[serde(default)]
    pub(super) description: Option<String>,
    #[serde(default)]
    pub(super) html_url: String,
    #[serde(default)]
    pub(super) stargazers_count: u64,
    #[serde(default)]
    pub(super) owner: GithubOwner,
    #[serde(default)]
    pub(super) topics: Vec<String>,
    #[serde(default)]
    pub(super) license: Option<GithubLicense>,
    #[serde(default)]
    pub(super) archived: bool,
    #[serde(default)]
    pub(super) fork: bool,
    #[serde(default)]
    pub(super) pushed_at: Option<String>,
    #[serde(default)]
    pub(super) homepage: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
pub(super) struct GithubOwner {
    #[serde(default)]
    pub(super) login: String,
    #[serde(default)]
    pub(super) avatar_url: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
pub(super) struct GithubLicense {
    #[serde(default)]
    pub(super) spdx_id: Option<String>,
    #[serde(default)]
    pub(super) name: Option<String>,
}

/// Built-in GitHub-topic discovery source for the Plugin/App catalog.
///
/// Not `#[derive(Debug)]` on purpose: it holds a bearer token, and a derived
/// `Debug` would leak it through any `tracing` line that prints the enclosing
/// `Source`. See the hand-written redacting impl below.
#[derive(Clone)]
pub struct GithubTopicSource {
    pub id: String,
    pub display_name: String,
    /// API base override. `None` = the builtin `api.github.com`.
    pub api_base: Option<String>,
    /// BYOK personal access token. Seeded from env in [`Self::builtin`]; the route
    /// overrides it from the preferences store. Never logged, and only ever sent to
    /// the default host.
    pub token: Option<String>,
}

impl std::fmt::Debug for GithubTopicSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GithubTopicSource")
            .field("id", &self.id)
            .field("api_base", &self.api_base)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Probe one repo's manifest paths over the raw CDN. First hit wins; all missing
/// is not an error. Shared by the single-repo path and the marketplace-entry
/// detail path (which probes the entry's OWN plugin repo).
pub(super) async fn fetch_repo_manifest_for(owner: &str, repo: &str) -> Option<(Value, String)> {
    for path in REPO_MANIFEST_PATHS {
        let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}");
        let Ok(bytes) = crate::server::guarded_get_bytes(&url).await else {
            continue;
        };
        // Parsed as a loose `Value`, never as `PluginManifest`: a strict parse
        // would reject a slightly-off third-party manifest and lose the card.
        if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
            if value.is_object() {
                return Some((value, url));
            }
        }
    }
    None
}

/// Normalize one GitHub repo hit. Archived repos are dropped (a dead listing is
/// worse than no listing); forks are kept but flagged, since topic discovery gets
/// noisy fast.
pub(super) fn repo_item_to_record(
    item: &GithubRepoItem,
    is_app: bool,
) -> Option<GithubTopicRecord> {
    if item.archived {
        return None;
    }
    let full_name = item.full_name.trim();
    let (owner, repo) = match full_name.split_once('/') {
        Some((o, r)) if !o.is_empty() && !r.is_empty() => (o.to_string(), r.to_string()),
        _ => return None,
    };
    Some(GithubTopicRecord {
        id: format!("{GH_ID_PREFIX}{owner}/{repo}"),
        owner: owner.clone(),
        repo: repo.clone(),
        full_name: full_name.to_string(),
        description: item
            .description
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(truncate_description),
        stars: item.stargazers_count,
        html_url: sanitize_url(&item.html_url)
            .unwrap_or_else(|| format!("https://github.com/{full_name}")),
        avatar_url: item.owner.avatar_url.as_deref().and_then(sanitize_url),
        topics: item.topics.clone(),
        license: item
            .license
            .as_ref()
            .and_then(|l| l.spdx_id.clone().or_else(|| l.name.clone()))
            .filter(|l| !l.is_empty() && l != "NOASSERTION"),
        pushed_at: item.pushed_at.clone(),
        // Homepage is publisher-controlled, so it goes through the http(s)
        // allowlist before it can ever reach an `<a href>`.
        homepage: item.homepage.as_deref().and_then(sanitize_url),
        is_fork: item.fork,
        is_app,
        // Hydrated separately: a Search hit carries repo metadata only, never the
        // repo's manifest. See `hydrate_manifests`.
        manifest: None,
        manifest_probed_at: 0,
        is_marketplace: false,
        // Hydrated separately too: see `hydrate_marketplaces`.
        marketplace: None,
        marketplace_probed_at: 0,
    })
}

/// A record discovered under the `ryu-marketplace` topic — the same normalization
/// as [`repo_item_to_record`], flagged as a collection. App-vs-plugin is decided
/// per ENTRY (from its `hasCompanion`), not from the query: the marketplace topic
/// says nothing about it, and a repo can collect both kinds.
pub(super) fn repo_item_to_marketplace_record(item: &GithubRepoItem) -> Option<GithubTopicRecord> {
    let mut record = repo_item_to_record(item, false)?;
    record.is_marketplace = true;
    Some(record)
}

/// Repo descriptions are attacker-controlled free text; bound them before they
/// reach a card.
pub(super) const MAX_DESCRIPTION_CHARS: usize = 300;
pub(super) const MAX_URL_CHARS: usize = 500;

pub(super) fn truncate_description(value: &str) -> String {
    if value.chars().count() <= MAX_DESCRIPTION_CHARS {
        return value.to_string();
    }
    let mut out: String = value.chars().take(MAX_DESCRIPTION_CHARS).collect();
    out.push('…');
    out
}

/// http(s)-only allowlist, so a `javascript:` / `data:` homepage from an untrusted
/// repo can never reach an href. Mirrors `sources::http_url`.
pub(crate) fn sanitize_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")).then(|| trimmed.to_string())
}

/// Unix seconds, saturating to `0` on a pre-epoch clock.
pub(crate) fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
