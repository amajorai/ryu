//! Repository enrichment for the GitHub-topic discovery source — the raw signals
//! the store's detail page renders as README / Versions / Health tabs.
//!
//! [`github_topic`](super::github_topic) turns two GitHub topics into a browsable
//! catalog from **search results alone** (name, description, stars, license,
//! `pushed_at`). That is enough for a card, but a detail page that claims to say
//! how trustworthy a listing is needs more: the README, the release history, when
//! the repo was created, whether issues are even open, how many times its release
//! assets were downloaded. This module fetches exactly that, and nothing else.
//!
//! Three rules hold everywhere below, because this talks to an **untrusted host**
//! on the user's behalf:
//!
//! - **Best-effort, never fatal.** Every fetch degrades to `None`. A rate-limited
//!   or offline GitHub must render a detail page with fewer tabs, never an error.
//! - **Bounded.** The README is truncated to [`MAX_README_BYTES`] and the release
//!   list to [`RELEASES_PER_PAGE`]; both ride inside a detail payload that crosses
//!   into a renderer, so neither may be unbounded.
//! - **Cached per repo.** A detail view costs at most two rate-limited API calls
//!   (repo meta + releases) plus one CDN read (README). [`ENRICH_TTL_SECS`] keeps
//!   re-opening the same listing free, and the cache is keyed by the `gh:` id so
//!   two repos never share an entry.
//!
//! Nothing here is ever used for install: the GitHub-topic source stays
//! descriptor-only. This is display material for the reading path.

use futures_util::{stream, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

/// README paths tried, in order. First hit wins; all missing is not an error.
const REPO_README_PATHS: [&str; 6] = [
    "README.md",
    "readme.md",
    "README.markdown",
    "README.rst",
    "README",
    "docs/README.md",
];

/// Cap on the README carried in a detail payload. Long-form plugin READMEs run
/// tens of KB; 256 KB is generous and still bounds what a hostile repo can push
/// into the renderer.
const MAX_README_BYTES: usize = 256 * 1024;

/// Release rows fetched for the Versions tab. GitHub returns newest first, so the
/// window is the recent history — which is what a version list wants.
const RELEASES_PER_PAGE: usize = 20;

/// Cap on a single release's notes. Release bodies are occasionally enormous
/// (generated changelogs); the tab shows a summary, not a monograph.
const MAX_RELEASE_NOTES_BYTES: usize = 8 * 1024;

/// Enrichment TTL. Shorter than the topic-list TTL because a detail view is a
/// deliberate, low-frequency act and fresher release data is worth more there.
const ENRICH_TTL_SECS: u64 = 60 * 60;

static ENRICH_CACHE: OnceLock<tokio::sync::Mutex<HashMap<String, CacheEntry>>> = OnceLock::new();

#[derive(Clone)]
struct CacheEntry {
    fetched_at: std::time::Instant,
    value: Value,
}

/// The subset of `GET /repos/{owner}/{repo}` the detail page reads. Deliberately
/// small: everything here is either rendered or scored, nothing is stored.
#[derive(Debug, Default, serde::Deserialize)]
struct GithubRepoMeta {
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    pushed_at: Option<String>,
    #[serde(default)]
    open_issues_count: u64,
    #[serde(default)]
    subscribers_count: u64,
    #[serde(default)]
    forks_count: u64,
    #[serde(default)]
    stargazers_count: u64,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    disabled: bool,
    #[serde(default)]
    has_issues: bool,
    #[serde(default)]
    default_branch: Option<String>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubReleaseItem {
    #[serde(default)]
    tag_name: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GithubReleaseAsset>,
}

#[derive(Debug, Default, serde::Deserialize)]
struct GithubReleaseAsset {
    #[serde(default)]
    download_count: u64,
    #[serde(default)]
    name: Option<String>,
}

/// Release metadata is downloaded too, but it is not an installable artifact.
/// Counting signatures, checksums, manifests and prose inflates popularity once
/// per platform without representing a real app/plugin download.
fn is_downloadable_release_asset(asset: &GithubReleaseAsset) -> bool {
    let Some(name) = asset.name.as_deref() else {
        return false;
    };
    let name = name.trim().to_ascii_lowercase();
    if name.is_empty() {
        return false;
    }
    ![
        ".asc", ".json", ".md", ".sha1", ".sha256", ".sha512", ".sig", ".txt", ".yaml", ".yml",
    ]
    .iter()
    .any(|suffix| name.ends_with(suffix))
}

/// A git tag, the fallback when a repo publishes no GitHub Releases. Many plugin
/// repos tag versions without ever cutting a release, and a Versions tab that
/// went blank for them would misread as "never versioned".
#[derive(Debug, Default, serde::Deserialize)]
struct GithubTagItem {
    #[serde(default)]
    name: Option<String>,
}

/// Truncate on a char boundary, appending an ellipsis marker when cut. Byte
/// slicing a UTF-8 README mid-codepoint would panic, so the boundary walk is
/// load-bearing, not defensive.
fn truncate_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n\n…", &text[..end])
}

/// Best-effort README read over `raw.githubusercontent.com` — a CDN, so this
/// costs nothing against the API rate limit. Returns `(markdown, raw_url)`.
async fn fetch_readme(owner: &str, repo: &str) -> Option<(String, String)> {
    fetch_readme_at(owner, repo, "HEAD").await
}

/// The README as it stood at `git_ref` (a tag, branch or sha).
///
/// This is what makes a PER-VERSION view possible at all: the raw host serves any
/// ref, so an old tag's README is one substitution away — `HEAD` was simply
/// hardcoded. Note this covers only the checks whose evidence lives IN THE REPO.
/// Stars, open issues and the archived flag are current-state facts GitHub reports
/// as of now and cannot be reconstructed for a past tag by any means.
async fn fetch_readme_at(owner: &str, repo: &str, git_ref: &str) -> Option<(String, String)> {
    for path in REPO_README_PATHS {
        let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/{git_ref}/{path}");
        let Ok(bytes) = crate::server::guarded_get_bytes(&url).await else {
            continue;
        };
        if bytes.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        return Some((truncate_utf8(trimmed, MAX_README_BYTES), url));
    }
    None
}

/// Candidate manifest locations inside a listing's repo, most specific first.
const REPO_MANIFEST_PATHS: [&str; 7] = [
    "manifest.json",
    "plugin.json",
    "ryu.json",
    ".ryu-plugin/manifest.json",
    ".ryu-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
];

/// The listing's manifest as it stood at `git_ref`.
async fn fetch_manifest_at(owner: &str, repo: &str, git_ref: &str) -> Option<serde_json::Value> {
    for path in REPO_MANIFEST_PATHS {
        let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/{git_ref}/{path}");
        let Ok(bytes) = crate::server::guarded_get_bytes(&url).await else {
            continue;
        };
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            return Some(value);
        }
    }
    None
}

/// Build the detail payload for ONE published version, from the repo contents at
/// that version's tag.
///
/// **Read the honesty constraint before using this.** Only the checks whose
/// evidence lives in the repository can be graded historically: the README, the
/// declared licence/description/engines/surfaces, and the manifest-shaped signals
/// derived from them. Repository HEALTH — stars, open issues, archived/disabled,
/// "last updated" — is current-state, reported by GitHub as of now, and is
/// deliberately LEFT OUT rather than filled with today's values. Mixing the two
/// would produce a card that looks like "the grade at that version" while half of
/// it silently describes today, which is worse than showing nothing.
///
/// Returns `None` when the tag has no readable manifest, which is the normal case
/// for a tag predating the listing being packaged.
pub async fn version_detail(owner: &str, repo: &str, tag: &str) -> Option<serde_json::Value> {
    let manifest = fetch_manifest_at(owner, repo, tag).await?;
    let readme = fetch_readme_at(owner, repo, tag).await;
    let (stability, stability_known) = manifest_stability(&manifest);

    let mut out = serde_json::Map::new();
    out.insert(
        "version".into(),
        manifest
            .get("version")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    if let Some((text, url)) = readme {
        out.insert("readme".into(), serde_json::Value::String(text));
        out.insert("readmeUrl".into(), serde_json::Value::String(url));
    }
    let display = super::github_topic::manifest_display_fields(&manifest);
    for key in ["description", "license"] {
        if let Some(v) = display.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    for key in ["engines", "surfaces", "targets", "permissions"] {
        if let Some(v) = manifest.get(key) {
            out.insert(key.to_string(), v.clone());
        }
    }
    if let Some(surface_support) =
        super::manifest_surface::project_manifest(&manifest).get("surfaceSupport")
    {
        out.insert("surfaceSupport".to_owned(), surface_support.clone());
    }
    out.insert(
        "stability".into(),
        stability.map_or(Value::Null, Value::String),
    );
    out.insert("stabilityKnown".into(), Value::Bool(stability_known));
    // Names the ref this was read at, so a client can never present it as anything
    // other than a point-in-time snapshot.
    out.insert("atRef".into(), serde_json::Value::String(tag.to_string()));
    Some(serde_json::Value::Object(out))
}

/// Fetch `GET /repos/{owner}/{repo}`. One rate-limited call, worth it: it is the
/// only source of `created_at`, `open_issues_count`, and the archived/disabled
/// flags the health checks read.
async fn fetch_repo_meta(
    api_base: &str,
    headers: &[(String, String)],
    owner: &str,
    repo: &str,
) -> Option<GithubRepoMeta> {
    let url = format!("{api_base}/repos/{owner}/{repo}");
    let bytes = crate::server::guarded_get_bytes_with_headers(&url, headers)
        .await
        .ok()?;
    serde_json::from_slice::<GithubRepoMeta>(&bytes).ok()
}

/// Fetch the recent releases, newest first. Drafts are dropped (they are not
/// public versions); prereleases are kept but flagged so the tab can mark them.
async fn fetch_releases(
    api_base: &str,
    headers: &[(String, String)],
    owner: &str,
    repo: &str,
) -> Option<Vec<GithubReleaseItem>> {
    let url = format!("{api_base}/repos/{owner}/{repo}/releases?per_page={RELEASES_PER_PAGE}");
    let bytes = crate::server::guarded_get_bytes_with_headers(&url, headers)
        .await
        .ok()?;
    let releases: Vec<GithubReleaseItem> = serde_json::from_slice(&bytes).ok()?;
    Some(releases.into_iter().filter(|r| !r.draft).collect())
}

/// Every release channel a listing publishes, plus the tag each channel currently
/// resolves to.
///
/// This is what makes a per-listing channel picker honest: it offers only the
/// channels that actually have a build, so nobody selects `nightly` and is then
/// told there is nothing there. Resolution itself is
/// [`crate::update::pick_version_for_channel`], the SAME rule Core applies to its
/// own builds — channel read off the tag, semver maximum within the channel, and
/// never a cross-channel fallback.
/// Cached for [`ENRICH_TTL_SECS`] against the same rate limit the enrichment read
/// protects itself from, and for a sharper reason: this drives a PICKER, so it is
/// read every time a listing's detail opens, not only when someone expands a tab.
/// Unauthenticated GitHub allows 60 requests an hour, and a failed read here
/// renders as "no channels" — so re-hammering a rate-limited API would make the
/// picker flicker in and out of existence as the limit was hit and released.
/// A failed result is cached too, exactly as `enrich_repo` caches an empty one.
pub async fn listing_channels(
    api_base: &str,
    headers: &[(String, String)],
    owner: &str,
    repo: &str,
) -> Vec<(String, String)> {
    let cache_key = format!("channels:{owner}/{repo}");
    let lock = ENRICH_CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    {
        let guard = lock.lock().await;
        if let Some(entry) = guard.get(&cache_key) {
            if entry.fetched_at.elapsed() < std::time::Duration::from_secs(ENRICH_TTL_SECS) {
                return channels_from_cache(&entry.value);
            }
        }
    }

    let channels = match fetch_releases(api_base, headers, owner, repo).await {
        Some(releases) => {
            let tags: Vec<&str> = releases
                .iter()
                .filter_map(|r| r.tag_name.as_deref())
                .collect();
            crate::update::channels_available(&tags)
                .into_iter()
                .filter_map(|channel| {
                    crate::update::pick_version_for_channel(&tags, &channel)
                        .map(|tag| (channel, tag.to_string()))
                })
                .collect()
        }
        None => Vec::new(),
    };

    let mut guard = lock.lock().await;
    guard.insert(
        cache_key,
        CacheEntry {
            fetched_at: std::time::Instant::now(),
            value: Value::Array(
                channels
                    .iter()
                    .map(|(channel, tag)| serde_json::json!({ "channel": channel, "tag": tag }))
                    .collect(),
            ),
        },
    );
    channels
}

/// Read back the cached channel rows. Shape errors resolve to "no channels" —
/// the same thing an unreachable GitHub produces — rather than a partial list
/// that would read as authoritative.
fn channels_from_cache(value: &Value) -> Vec<(String, String)> {
    value
        .as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some((
                        row.get("channel")?.as_str()?.to_string(),
                        row.get("tag")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Fetch git tags — the Versions fallback for a repo that tags but never
/// releases. Only reached when the releases list came back empty.
async fn fetch_tags(
    api_base: &str,
    headers: &[(String, String)],
    owner: &str,
    repo: &str,
) -> Option<Vec<GithubTagItem>> {
    let url = format!("{api_base}/repos/{owner}/{repo}/tags?per_page={RELEASES_PER_PAGE}");
    let bytes = crate::server::guarded_get_bytes_with_headers(&url, headers)
        .await
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Project one release onto the wire shape the Versions tab reads. `downloads` is
/// the summed asset download count — the closest thing GitHub offers to an
/// install count for a repo-published plugin.
fn release_to_value(release: &GithubReleaseItem) -> Option<Value> {
    let version = release
        .tag_name
        .as_deref()
        .or(release.name.as_deref())
        .map(str::trim)
        .filter(|v| !v.is_empty())?;
    let downloads: u64 = release
        .assets
        .iter()
        .filter(|asset| is_downloadable_release_asset(asset))
        .map(|asset| asset.download_count)
        .sum();
    Some(serde_json::json!({
        "version": version,
        "name": release.name.as_deref().map(str::trim).filter(|n| !n.is_empty()),
        "notes": release
            .body
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(|b| truncate_utf8(b, MAX_RELEASE_NOTES_BYTES)),
        "publishedAt": release.published_at,
        "url": release.html_url.as_deref().and_then(super::github_topic::sanitize_url),
        "prerelease": release.prerelease,
        "downloads": downloads,
    }))
}

/// Read the maturity posture from a manifest that was successfully loaded at a
/// historical ref. An omitted/empty field is the manifest's stable default; a
/// missing manifest is different and remains unavailable to the renderer.
fn manifest_stability(manifest: &Value) -> (Option<String>, bool) {
    let Some(object) = manifest.as_object() else {
        return (None, false);
    };
    let stability = object
        .get("stability")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "stable".to_owned());
    (Some(stability), true)
}

/// Add the historical maturity pair to one release/tag row. This is deliberately
/// additive: a release with no readable manifest remains useful in the Versions
/// tab, but the UI can say that its stability is unavailable instead of guessing.
async fn add_version_stability(owner: &str, repo: &str, tag: &str, value: &mut Value) {
    let manifest = fetch_manifest_at(owner, repo, tag).await;
    let (stability, known) = manifest
        .as_ref()
        .map(manifest_stability)
        .unwrap_or((None, false));
    let Some(object) = value.as_object_mut() else {
        return;
    };
    object.insert(
        "stability".to_owned(),
        stability.map_or(Value::Null, Value::String),
    );
    object.insert("stabilityKnown".to_owned(), Value::Bool(known));
}

/// Fetch every enrichment signal for one repo and merge them into a single JSON
/// object the detail payload spreads in. Returns an **empty object** (never an
/// error) when GitHub is unreachable, so the caller can merge unconditionally.
async fn fetch_enrichment(
    api_base: &str,
    headers: &[(String, String)],
    owner: &str,
    repo: &str,
) -> Value {
    // Three independent reads, run concurrently: one CDN read plus two API calls.
    // Serializing them would triple the detail page's time-to-render for no gain.
    let (readme, meta, releases) = tokio::join!(
        fetch_readme(owner, repo),
        fetch_repo_meta(api_base, headers, owner, repo),
        fetch_releases(api_base, headers, owner, repo),
    );

    let mut out = serde_json::Map::new();

    if let Some((markdown, url)) = readme {
        out.insert("readme".to_string(), Value::String(markdown));
        out.insert("readmeUrl".to_string(), Value::String(url));
    }

    if let Some(meta) = meta {
        out.insert(
            "createdAt".to_string(),
            meta.created_at.map_or(Value::Null, Value::String),
        );
        out.insert(
            "updatedAt".to_string(),
            meta.pushed_at
                .or(meta.updated_at)
                .map_or(Value::Null, Value::String),
        );
        out.insert("openIssues".to_string(), meta.open_issues_count.into());
        out.insert("watchers".to_string(), meta.subscribers_count.into());
        out.insert("forks".to_string(), meta.forks_count.into());
        out.insert("stars".to_string(), meta.stargazers_count.into());
        out.insert("archived".to_string(), Value::Bool(meta.archived));
        out.insert("disabled".to_string(), Value::Bool(meta.disabled));
        out.insert("issuesEnabled".to_string(), Value::Bool(meta.has_issues));
        if let Some(branch) = meta.default_branch.filter(|b| !b.is_empty()) {
            out.insert("defaultBranch".to_string(), Value::String(branch));
        }
    }

    let mut versions: Vec<Value> = Vec::new();
    if let Some(releases) = releases.as_deref() {
        let release_rows: Vec<(usize, Value, String)> = releases
            .iter()
            .enumerate()
            .filter_map(|(index, release)| {
                let value = release_to_value(release)?;
                let tag = release
                    .tag_name
                    .as_deref()
                    .or(release.name.as_deref())
                    .map(str::trim)
                    .filter(|tag| !tag.is_empty())?
                    .to_owned();
                Some((index, value, tag))
            })
            .collect();
        let mut indexed = stream::iter(release_rows)
            .map(|(index, mut value, tag)| async move {
                add_version_stability(owner, repo, &tag, &mut value).await;
                (index, value)
            })
            .buffer_unordered(4)
            .collect::<Vec<_>>()
            .await;
        indexed.sort_unstable_by_key(|(index, _)| *index);
        versions = indexed.into_iter().map(|(_, value)| value).collect();
    }

    // A repo that tags without cutting releases still has a version history.
    if versions.is_empty() && releases.is_some() {
        if let Some(tags) = fetch_tags(api_base, headers, owner, repo).await {
            let tag_rows: Vec<(usize, String)> = tags
                .iter()
                .enumerate()
                .filter_map(|(index, tag)| {
                    let name = tag
                        .name
                        .as_deref()
                        .map(str::trim)
                        .filter(|n| !n.is_empty())?
                        .to_owned();
                    Some((index, name))
                })
                .collect();
            let mut indexed = stream::iter(tag_rows)
                .map(|(index, name)| async move {
                    let mut value = serde_json::json!({
                        "version": name.clone(),
                        "name": Value::Null,
                        "notes": Value::Null,
                        "publishedAt": Value::Null,
                        "url": format!("https://github.com/{owner}/{repo}/releases/tag/{name}"),
                        "prerelease": false,
                        "downloads": 0,
                        "tagOnly": true,
                    });
                    add_version_stability(owner, repo, &name, &mut value).await;
                    (index, value)
                })
                .buffer_unordered(4)
                .collect::<Vec<_>>()
                .await;
            indexed.sort_unstable_by_key(|(index, _)| *index);
            versions = indexed.into_iter().map(|(_, value)| value).collect();
        }
    }

    if !versions.is_empty() {
        let downloads: u64 = versions
            .iter()
            .filter_map(|v| v.get("downloads").and_then(Value::as_u64))
            .sum();
        out.insert("downloads".to_string(), downloads.into());
        out.insert("versions".to_string(), Value::Array(versions));
    }

    Value::Object(out)
}

/// Cached enrichment for one `gh:<owner>/<repo>` listing.
///
/// The cache is keyed by `id` and holds the merged object, so a second detail
/// view inside [`ENRICH_TTL_SECS`] makes no network calls at all. A failed fetch
/// caches its empty result too — deliberately: a rate-limited GitHub should not
/// be re-hammered once per detail open.
pub(crate) async fn enrich_repo(
    id: &str,
    api_base: &str,
    headers: &[(String, String)],
    owner: &str,
    repo: &str,
) -> Value {
    let lock = ENRICH_CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    {
        let guard = lock.lock().await;
        if let Some(entry) = guard.get(id) {
            if entry.fetched_at.elapsed() < std::time::Duration::from_secs(ENRICH_TTL_SECS) {
                return entry.value.clone();
            }
        }
    }
    let value = fetch_enrichment(api_base, headers, owner, repo).await;
    let mut guard = lock.lock().await;
    guard.insert(
        id.to_string(),
        CacheEntry {
            fetched_at: std::time::Instant::now(),
            value: value.clone(),
        },
    );
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_utf8_leaves_short_text_alone() {
        assert_eq!(truncate_utf8("hello", 64), "hello");
    }

    #[test]
    fn truncate_utf8_never_splits_a_codepoint() {
        // Each `é` is two bytes, so a 5-byte cap lands mid-codepoint on the third.
        let text = "ééé";
        let cut = truncate_utf8(text, 5);
        assert!(cut.starts_with("éé"), "should keep whole codepoints: {cut}");
        assert!(cut.ends_with('…'), "should mark the truncation: {cut}");
    }

    #[test]
    fn release_to_value_sums_asset_downloads() {
        let release = GithubReleaseItem {
            tag_name: Some("v1.2.0".to_string()),
            name: Some("1.2.0".to_string()),
            assets: vec![
                GithubReleaseAsset {
                    download_count: 7,
                    name: Some("app-macos.dmg".to_string()),
                },
                GithubReleaseAsset {
                    download_count: 5,
                    name: Some("app-windows.exe".to_string()),
                },
            ],
            ..Default::default()
        };
        let value = release_to_value(&release).expect("a tagged release projects");
        assert_eq!(value["version"], "v1.2.0");
        assert_eq!(value["downloads"], 12);
        assert_eq!(value["prerelease"], false);
    }

    #[test]
    fn manifest_stability_normalizes_known_and_default_values() {
        assert_eq!(
            manifest_stability(&serde_json::json!({ "stability": " Beta " })),
            (Some("beta".to_owned()), true)
        );
        assert_eq!(
            manifest_stability(&serde_json::json!({})),
            (Some("stable".to_owned()), true)
        );
        assert_eq!(manifest_stability(&Value::Null), (None, false));
    }

    #[test]
    fn release_without_a_tag_or_name_is_dropped() {
        let release = GithubReleaseItem {
            tag_name: Some("   ".to_string()),
            ..Default::default()
        };
        assert!(release_to_value(&release).is_none());
    }

    #[test]
    fn release_url_is_scheme_checked() {
        let release = GithubReleaseItem {
            tag_name: Some("v1".to_string()),
            html_url: Some("javascript:alert(1)".to_string()),
            ..Default::default()
        };
        let value = release_to_value(&release).expect("projects");
        assert_eq!(
            value["url"],
            Value::Null,
            "a non-http(s) release URL must not reach the renderer"
        );
    }

    #[test]
    fn release_notes_are_capped() {
        let release = GithubReleaseItem {
            tag_name: Some("v1".to_string()),
            body: Some("x".repeat(MAX_RELEASE_NOTES_BYTES * 2)),
            ..Default::default()
        };
        let value = release_to_value(&release).expect("projects");
        let notes = value["notes"].as_str().expect("notes present");
        assert!(
            notes.len() <= MAX_RELEASE_NOTES_BYTES + 8,
            "release notes must be bounded, got {}",
            notes.len()
        );
    }
}
