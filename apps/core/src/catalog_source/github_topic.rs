//! GitHub-topic discovery source (Plugin kind, **descriptor-only**).
//!
//! Anyone can publish a Ryu app or plugin by pushing a public GitHub repo and
//! tagging it with the `ryu-app` / `ryu-plugin` topic. This source turns those
//! two topics into a browsable catalog. It is deliberately the *least trusted*
//! Plugin source in the registry, and its shape encodes that:
//!
//! - **No `raw.manifest` in the install descriptor.** `resolve_plugin_from_catalog`
//!   parses `descriptor.raw["manifest"]` into a `PluginManifest` and skips a source
//!   that can't produce one — so omitting it keeps install-by-id *fail-closed*. If a
//!   future refactor "helpfully" carried the repo's `plugin.json` here, every
//!   topic-squatting repo would become an unsigned install path. The unit test
//!   `install_descriptor_never_carries_a_manifest` is the regression guard.
//! - **Every card is stamped `origin:"community"` + `reviewed:false`.** That is the
//!   one discriminator the store's trust notice keys on; see
//!   `packages/marketplace/src/catalog/apps-catalog-section.tsx` (`isCommunityEntry`).
//! - **Never lift runnable code.** Manifest enrichment in `detail` copies an
//!   allowlist of display fields only — `ui_code` / `backend_code` / `*_sha256`
//!   are dropped, mirroring the trust ladder in `gate_plugin_ui_code`.
//! - **Ids are namespaced `gh:<owner>/<repo>`.** Core's install path probes *every*
//!   registered Plugin source for *every* install-by-id, so a foreign id must be
//!   rejected in O(1), before any network call, or an unrelated install burns the
//!   GitHub Search rate-limit budget.
//!
//! "Nothing hardcoded": the API base, both topic strings, and the cache TTL are all
//! env-overridable. The BYOK personal access token is host-scoped — it is only ever
//! attached to the *default* `api.github.com` base, never to a custom one.

use anyhow::Result;
use serde_json::Value;
use std::sync::OnceLock;

use super::{CatalogKind, CatalogQuery, CatalogSource, InstallDescriptor};

/// Default GitHub REST base. Overridable for a mirror/enterprise host — which
/// **suppresses the token** (see [`GithubTopicSource::resolve_token`]).
const GITHUB_API_BASE: &str = "https://api.github.com";
const GITHUB_API_BASE_ENV: &str = "RYU_GITHUB_API_URL";

/// The two discovery topics. A repo carrying `ryu-app` is classified as an app
/// (it ships a companion UI surface); `ryu-plugin` is everything else.
const GITHUB_TOPIC_APP: &str = "ryu-app";
const GITHUB_TOPIC_PLUGIN: &str = "ryu-plugin";
const GITHUB_TOPIC_APP_ENV: &str = "RYU_GITHUB_TOPIC_APP";
const GITHUB_TOPIC_PLUGIN_ENV: &str = "RYU_GITHUB_TOPIC_PLUGIN";

const GITHUB_TOPIC_TTL_ENV: &str = "RYU_GITHUB_TOPIC_CACHE_TTL_SECS";
/// 6h. One refresh costs 2 Search API calls; the unauthenticated Search budget is
/// 10 req/min (30 authenticated) in a bucket separate from the 60/hr core limit, so
/// this plus stale-serve keeps discovery far inside budget however often the store
/// is opened.
const GITHUB_TOPIC_DEFAULT_TTL_SECS: u64 = 6 * 60 * 60;

/// GitHub's `per_page` ceiling for the Search API.
const GITHUB_TOPIC_PER_PAGE: usize = 100;

/// Preferences key holding the BYOK GitHub personal access token. Mirrors
/// `SMITHERY_API_KEY_PREF`: the route reads the pref and rewrites the source
/// before use, so the token never lives in the persisted registry.
pub const GITHUB_TOKEN_PREF: &str = "github-api-token";

/// Env fallbacks for the token, in order. `RYU_GITHUB_TOKEN` is the documented
/// primary so an ambient CI `GITHUB_TOKEN` is never the surprising default.
const GITHUB_TOKEN_ENVS: [&str; 2] = ["RYU_GITHUB_TOKEN", "GITHUB_TOKEN"];

/// The `origin` discriminator stamped on every card. The store's trust notice and
/// its "Community" section filter both key on this exact string — it must stay in
/// sync with `isCommunityEntry` in `@ryu/marketplace`.
pub const COMMUNITY_ORIGIN: &str = "community";

/// Stable source id, also the `?origin=community` browse dispatch target.
pub const GITHUB_TOPIC_SOURCE_ID: &str = "github-topic";

/// `gh:` id namespace. Guarantees no collision with a real plugin id in
/// `merge_plugin_catalog_entries` and makes foreign-id rejection free.
const GH_ID_PREFIX: &str = "gh:";

/// Manifest paths tried (in order) when enriching a detail view. First hit wins;
/// all missing is NOT an error.
const REPO_MANIFEST_PATHS: [&str; 5] = [
    // `manifest.json` is the canonical name (MANIFEST_FILE_NAMES[0]); the older
    // `plugin.json` / `ryu.json` stay for third-party repos that predate the
    // rename, matching the loader's own back-compat order.
    "manifest.json",
    "plugin.json",
    "ryu.json",
    ".ryu-plugin/manifest.json",
    ".ryu-plugin/plugin.json",
];

/// Display fields lifted from a third-party manifest. Everything outside this
/// allowlist is dropped — in particular `ui_code`, `backend_code`, and any
/// `*_sha256`, which must never travel from an unsigned source.
const MANIFEST_DISPLAY_KEYS: [&str; 4] = ["version", "description", "category", "icon"];

static GITHUB_TOPIC_CACHE: OnceLock<tokio::sync::Mutex<Option<GithubTopicCache>>> = OnceLock::new();

#[derive(Clone)]
struct GithubTopicCache {
    fetched_at: std::time::Instant,
    records: Vec<GithubTopicRecord>,
    source_url: String,
    /// True when this copy was served past its TTL because the refresh failed
    /// (offline, or a 403/429 rate limit). The note explains it to the user.
    stale: bool,
    note: Option<String>,
}

/// Disk envelope so a cold start while offline or rate-limited is not blank.
/// (`Instant` doesn't survive a restart; this does.)
#[derive(serde::Serialize, serde::Deserialize)]
struct DiskCacheEnvelope {
    fetched_at: u64,
    records: Vec<GithubTopicRecord>,
    source_url: String,
}

/// A normalized topic hit. Deliberately much smaller than GitHub's repo payload so
/// the cache is cheap and stable across upstream schema drift.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(crate) struct GithubTopicRecord {
    /// `gh:<owner>/<repo>`.
    id: String,
    owner: String,
    repo: String,
    full_name: String,
    #[serde(default)]
    description: Option<String>,
    stars: u64,
    html_url: String,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    is_fork: bool,
    /// Which topic query produced this row — the ground truth for app-vs-plugin.
    /// The repo's own `topics` array is publisher-controlled and is NOT trusted here.
    is_app: bool,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubSearchEnvelope {
    #[serde(default)]
    items: Vec<GithubRepoItem>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubRepoItem {
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    stargazers_count: u64,
    #[serde(default)]
    owner: GithubOwner,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    license: Option<GithubLicense>,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    fork: bool,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubOwner {
    #[serde(default)]
    login: String,
    #[serde(default)]
    avatar_url: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubLicense {
    #[serde(default)]
    spdx_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
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

    fn resolve_api_base(&self) -> String {
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
    fn resolve_token(&self) -> Option<&str> {
        if self.resolve_api_base() != GITHUB_API_BASE {
            return None;
        }
        self.token.as_deref().map(str::trim).filter(|t| !t.is_empty())
    }

    fn topic(is_app: bool) -> String {
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

    fn cache_ttl() -> std::time::Duration {
        let secs = std::env::var(GITHUB_TOPIC_TTL_ENV)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .filter(|s| *s > 0)
            .unwrap_or(GITHUB_TOPIC_DEFAULT_TTL_SECS);
        std::time::Duration::from_secs(secs)
    }

    fn search_url(&self, topic: &str) -> String {
        format!(
            "{}/search/repositories?q={}&sort=stars&order=desc&per_page={}",
            self.resolve_api_base(),
            urlencoding::encode(&format!("topic:{topic}")),
            GITHUB_TOPIC_PER_PAGE,
        )
    }

    fn request_headers(&self) -> Vec<(String, String)> {
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

    async fn fetch_topic(&self, is_app: bool) -> Result<Vec<GithubTopicRecord>> {
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

    async fn fetch_records(&self) -> Result<GithubTopicCache> {
        // Apps first, then plugins, so a repo carrying BOTH topics is classified as
        // an app by the first-writer-wins dedupe below.
        let apps = self.fetch_topic(true).await?;
        let plugins = self.fetch_topic(false).await?;
        Ok(GithubTopicCache {
            fetched_at: std::time::Instant::now(),
            records: dedupe_records(vec![apps, plugins]),
            source_url: self.resolve_api_base(),
            stale: false,
            note: None,
        })
    }

    fn disk_cache_path() -> std::path::PathBuf {
        crate::paths::ryu_dir()
            .join("cache")
            .join("github-topic")
            .join("topics.json")
    }

    fn read_disk_cache() -> Option<GithubTopicCache> {
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

    fn write_disk_cache(cache: &GithubTopicCache) {
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
    async fn records(&self) -> Result<GithubTopicCache> {
        let lock = GITHUB_TOPIC_CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
        let mut guard = lock.lock().await;
        if let Some(cache) = guard.as_ref() {
            if !cache.stale && cache.fetched_at.elapsed() < Self::cache_ttl() {
                return Ok(cache.clone());
            }
        }
        match self.fetch_records().await {
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

    fn wrap_items(
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
    async fn fetch_repo_manifest(&self, record: &GithubTopicRecord) -> Option<(Value, String)> {
        for path in REPO_MANIFEST_PATHS {
            let url = format!(
                "https://raw.githubusercontent.com/{}/{}/HEAD/{}",
                record.owner, record.repo, path
            );
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
}

const OFFLINE_NOTE: &str = "Showing cached community listings — GitHub is unreachable.";

fn stale_note(err: &str) -> String {
    let lower = err.to_ascii_lowercase();
    if lower.contains("403") || lower.contains("429") {
        "GitHub rate limit reached — showing cached community listings.".to_string()
    } else {
        OFFLINE_NOTE.to_string()
    }
}

/// Normalize one GitHub repo hit. Archived repos are dropped (a dead listing is
/// worse than no listing); forks are kept but flagged, since topic discovery gets
/// noisy fast.
fn repo_item_to_record(item: &GithubRepoItem, is_app: bool) -> Option<GithubTopicRecord> {
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
    })
}

/// Repo descriptions are attacker-controlled free text; bound them before they
/// reach a card.
const MAX_DESCRIPTION_CHARS: usize = 300;

fn truncate_description(value: &str) -> String {
    if value.chars().count() <= MAX_DESCRIPTION_CHARS {
        return value.to_string();
    }
    let mut out: String = value.chars().take(MAX_DESCRIPTION_CHARS).collect();
    out.push('…');
    out
}

/// http(s)-only allowlist, so a `javascript:` / `data:` homepage from an untrusted
/// repo can never reach an href. Mirrors `sources::http_url`.
fn sanitize_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let lower = trimmed.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")).then(|| trimmed.to_string())
}

/// Merge topic result groups, deduping by lowercased `full_name`, first writer
/// wins. Called with `[apps, plugins]`, so a repo carrying both topics lands as
/// an app.
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

/// Project one record onto the Plugin-kind card shape that
/// `plugin_marketplace_item_to_entry` reads.
pub(crate) fn record_to_item(record: &GithubTopicRecord) -> Value {
    let mut topics = record.topics.clone();
    if record.is_fork {
        topics.push("fork".to_string());
    }
    serde_json::json!({
        "id": record.id,
        "name": record.repo,
        "description": record.description.clone().unwrap_or_default(),
        // A GitHub repo has no version until its manifest is read in `detail`.
        "version": "",
        "install_source": record.html_url,
        "url": record.html_url,
        "repo_url": record.html_url,
        "installed": false,
        "type": if record.is_app { "app" } else { "plugin" },
        "has_companion": record.is_app,
        "developer": record.owner,
        "owner": record.owner,
        "icon_url": record.avatar_url,
        "category": "Community",
        "tagline": record.description,
        "stars": record.stars,
        "license": record.license,
        "pushed_at": record.pushed_at,
        "topics": topics,
        // The trust triple. `origin` drives the store's Community section + notice;
        // `reviewed:false` says nobody vetted this; `descriptor_only` collapses the
        // Install CTA to a link-out.
        "origin": COMMUNITY_ORIGIN,
        "reviewed": false,
        "provenance": GITHUB_TOPIC_SOURCE_ID,
        "descriptor_only": true,
    })
}

/// Lift the display-only allowlist off a third-party manifest. **Never** copies
/// `ui_code`, `backend_code`, or any `*_sha256`: an unsigned source must not be
/// able to move runnable code, and the manifest's own `id` is surfaced as
/// `manifest_id` (never as the entry id) so an id-squatting repo cannot
/// masquerade as an installed plugin.
pub(crate) fn manifest_display_fields(manifest: &Value) -> serde_json::Map<String, Value> {
    let mut out = serde_json::Map::new();
    let Some(obj) = manifest.as_object() else {
        return out;
    };
    if let Some(id) = obj.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        out.insert("manifestId".to_string(), Value::String(id.to_string()));
    }
    if let Some(name) = obj.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
        out.insert("manifestName".to_string(), Value::String(name.to_string()));
    }
    for key in MANIFEST_DISPLAY_KEYS {
        if let Some(v) = obj.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            out.insert(key.to_string(), Value::String(v.to_string()));
        }
    }
    if let Some(url) = obj
        .get("homepage")
        .or_else(|| obj.get("icon_url"))
        .and_then(|v| v.as_str())
        .and_then(sanitize_url)
    {
        let key = if obj.get("homepage").is_some() {
            "homepage"
        } else {
            "iconUrl"
        };
        out.insert(key.to_string(), Value::String(url));
    }
    for key in ["requires", "targets"] {
        if let Some(v) = obj.get(key).filter(|v| !v.is_null()) {
            out.insert(key.to_string(), v.clone());
        }
    }
    // Runnable *kinds* only — the shapes, never their code.
    if let Some(runnables) = obj.get("runnables").and_then(|v| v.as_array()) {
        let kinds: Vec<Value> = runnables
            .iter()
            .filter_map(|r| r.get("kind").and_then(|v| v.as_str()))
            .map(|k| Value::String(k.to_string()))
            .collect();
        if !kinds.is_empty() {
            out.insert("runnableKinds".to_string(), Value::Array(kinds));
        }
    }
    out
}

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
                let filtered: Vec<Value> = cache
                    .records
                    .iter()
                    .filter(|record| match type_filter.as_str() {
                        "app" => record.is_app,
                        "plugin" => !record.is_app,
                        _ => true,
                    })
                    .filter(|record| {
                        needle.is_empty()
                            || record.full_name.to_ascii_lowercase().contains(&needle)
                            || record
                                .description
                                .as_deref()
                                .is_some_and(|d| d.to_ascii_lowercase().contains(&needle))
                            || record
                                .topics
                                .iter()
                                .any(|t| t.to_ascii_lowercase().contains(&needle))
                    })
                    .map(record_to_item)
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
        // Foreign ids are rejected before any egress (the install probe loop).
        if parse_gh_id(id).is_none() {
            anyhow::bail!("`{id}` is not a GitHub-topic catalog id");
        }
        let cache = self.records().await?;
        let record = cache
            .records
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| anyhow::anyhow!("community listing `{id}` not found"))?;

        let mut detail = serde_json::json!({
            "id": record.id,
            "name": record.repo,
            "description": record.description,
            "iconUrl": record.avatar_url,
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

        match self.fetch_repo_manifest(record).await {
            Some((manifest, url)) => {
                if let Some(obj) = detail.as_object_mut() {
                    for (k, v) in manifest_display_fields(&manifest) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(full_name: &str, stars: u64) -> GithubRepoItem {
        GithubRepoItem {
            full_name: full_name.to_string(),
            description: Some("a thing".to_string()),
            html_url: format!("https://github.com/{full_name}"),
            stargazers_count: stars,
            owner: GithubOwner {
                login: full_name.split('/').next().unwrap_or("").to_string(),
                avatar_url: Some("https://avatars.githubusercontent.com/u/1".to_string()),
            },
            topics: vec!["ryu-plugin".to_string()],
            license: Some(GithubLicense {
                spdx_id: Some("MIT".to_string()),
                name: Some("MIT License".to_string()),
            }),
            archived: false,
            fork: false,
            pushed_at: Some("2026-07-01T00:00:00Z".to_string()),
            homepage: None,
        }
    }

    #[test]
    fn search_envelope_parses_and_normalizes() {
        let raw = br#"{
            "total_count": 1,
            "incomplete_results": false,
            "items": [{
                "full_name": "acme/ryu-thing",
                "name": "ryu-thing",
                "description": "does a thing",
                "html_url": "https://github.com/acme/ryu-thing",
                "stargazers_count": 128,
                "owner": { "login": "acme", "avatar_url": "https://avatars.githubusercontent.com/u/9" },
                "topics": ["ryu-plugin", "ai"],
                "license": { "spdx_id": "Apache-2.0" },
                "archived": false,
                "fork": false,
                "pushed_at": "2026-07-20T10:00:00Z",
                "unknown_future_field": 42
            }]
        }"#;
        let envelope: GithubSearchEnvelope = serde_json::from_slice(raw).unwrap();
        let records: Vec<GithubTopicRecord> = envelope
            .items
            .iter()
            .filter_map(|i| repo_item_to_record(i, false))
            .collect();
        assert_eq!(records.len(), 1);
        let r = &records[0];
        assert_eq!(r.id, "gh:acme/ryu-thing");
        assert_eq!(r.owner, "acme");
        assert_eq!(r.repo, "ryu-thing");
        assert_eq!(r.stars, 128);
        assert_eq!(r.license.as_deref(), Some("Apache-2.0"));
        assert!(!r.is_app);
    }

    #[test]
    fn archived_repos_are_dropped_forks_are_kept_and_flagged() {
        let mut archived = repo("dead/repo", 3);
        archived.archived = true;
        assert!(repo_item_to_record(&archived, false).is_none());

        let mut forked = repo("acme/fork", 1);
        forked.fork = true;
        let record = repo_item_to_record(&forked, false).unwrap();
        assert!(record.is_fork);
        let item = record_to_item(&record);
        let topics: Vec<&str> = item["topics"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(topics.contains(&"fork"));
    }

    #[test]
    fn both_topics_classify_as_app_and_dedupe_by_full_name() {
        let as_app = repo_item_to_record(&repo("acme/dual", 5), true).unwrap();
        let as_plugin = repo_item_to_record(&repo("ACME/Dual", 5), false).unwrap();
        let other = repo_item_to_record(&repo("other/one", 1), false).unwrap();
        // Apps group first — the same repo discovered under both topics collapses
        // to ONE app row.
        let merged = dedupe_records(vec![vec![as_app], vec![as_plugin, other]]);
        assert_eq!(merged.len(), 2);
        assert!(merged[0].is_app, "the app-topic hit must win the dedupe");
        assert_eq!(merged[0].full_name, "acme/dual");
    }

    #[test]
    fn app_vs_plugin_comes_from_the_matched_query_not_the_topics_array() {
        // The repo's own `topics` say "ryu-plugin", but it was found under the
        // app topic — the query is the ground truth (topics are publisher-controlled).
        let record = repo_item_to_record(&repo("acme/claims-plugin", 2), true).unwrap();
        let item = record_to_item(&record);
        assert_eq!(item["type"], "app");
        assert_eq!(item["has_companion"], true);
    }

    #[test]
    fn card_carries_the_unreviewed_trust_triple() {
        let record = repo_item_to_record(&repo("acme/thing", 7), false).unwrap();
        let item = record_to_item(&record);
        assert_eq!(item["origin"], COMMUNITY_ORIGIN);
        assert_eq!(item["reviewed"], false);
        assert_eq!(item["provenance"], GITHUB_TOPIC_SOURCE_ID);
        assert_eq!(item["descriptor_only"], true);
        assert_eq!(item["stars"], 7);
        // A repo has no version until its manifest is read in `detail`.
        assert_eq!(item["version"], "");
        // And a card is never a manifest carrier.
        assert!(item.get("manifest").is_none());
    }

    #[test]
    fn gh_ids_parse_and_foreign_ids_are_rejected() {
        assert_eq!(
            parse_gh_id("gh:acme/ryu-thing"),
            Some(("acme".to_string(), "ryu-thing".to_string()))
        );
        for foreign in [
            "com.ryu.mail",
            "acme/ryu-thing",
            "gh:acme",
            "gh:/thing",
            "gh:acme/",
            "gh:acme/a/b",
            "",
        ] {
            assert!(
                parse_gh_id(foreign).is_none(),
                "`{foreign}` must not parse as a github-topic id"
            );
        }
    }

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
            .install_descriptor(&client, "com.ryu.mail")
            .await
            .is_err());
    }

    #[test]
    fn manifest_enrichment_lifts_the_allowlist_and_drops_runnable_code() {
        let manifest = serde_json::json!({
            "id": "com.acme.thing",
            "name": "Thing",
            "version": "1.2.3",
            "description": "a thing",
            "category": "Productivity",
            "ui_code": "<script>alert(1)</script>",
            "ui_code_sha256": "deadbeef",
            "backend_code": "require('child_process').exec('rm -rf /')",
            "backend_sha256": "cafebabe",
            "artifact_url": "https://evil.example/x.tgz",
            "runnables": [{ "kind": "companion", "id": "ui", "name": "UI" }],
        });
        let lifted = manifest_display_fields(&manifest);
        assert_eq!(lifted["version"], "1.2.3");
        assert_eq!(lifted["category"], "Productivity");
        // The manifest's claimed id is disclosed SEPARATELY, never as the entry id.
        assert_eq!(lifted["manifestId"], "com.acme.thing");
        assert!(lifted.get("id").is_none());
        for forbidden in [
            "ui_code",
            "ui_code_sha256",
            "backend_code",
            "backend_sha256",
            "artifact_url",
        ] {
            assert!(
                lifted.get(forbidden).is_none(),
                "`{forbidden}` must never travel from an unsigned source"
            );
        }
        // Runnable KINDS only — the shapes, never their code.
        assert_eq!(lifted["runnableKinds"], serde_json::json!(["companion"]));
    }

    #[test]
    fn hostile_urls_are_rejected_before_they_reach_an_href() {
        let mut hostile = repo("acme/evil", 0);
        hostile.homepage = Some("javascript:alert(1)".to_string());
        hostile.html_url = "data:text/html,pwned".to_string();
        let record = repo_item_to_record(&hostile, false).unwrap();
        assert!(record.homepage.is_none());
        // A non-http html_url falls back to the canonical github URL.
        assert_eq!(record.html_url, "https://github.com/acme/evil");
    }

    #[test]
    fn descriptions_are_bounded() {
        let mut wordy = repo("acme/wordy", 0);
        wordy.description = Some("x".repeat(5000));
        let record = repo_item_to_record(&wordy, false).unwrap();
        let description = record.description.unwrap();
        assert!(description.chars().count() <= MAX_DESCRIPTION_CHARS + 1);
    }

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
    fn debug_redacts_the_token() {
        let source = GithubTopicSource {
            id: GITHUB_TOPIC_SOURCE_ID.to_string(),
            display_name: "GitHub (community)".to_string(),
            api_base: None,
            token: Some("ghp_supersecret".to_string()),
        };
        let rendered = format!("{source:?}");
        assert!(!rendered.contains("ghp_supersecret"), "{rendered}");
        assert!(rendered.contains("redacted"), "{rendered}");
    }

    #[test]
    fn stale_note_names_the_rate_limit() {
        assert!(stale_note("https://api.github.com/... returned HTTP 403 Forbidden")
            .contains("rate limit"));
        assert!(stale_note("dns error").contains("cached"));
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
