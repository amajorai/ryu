//! Skills catalog — browse and install Agent Skills from the public skills.sh
//! directory. **All logic lives here in Core** so the desktop, mobile, and
//! extension are pure GUI layers over one HTTP API, exactly like the model
//! catalog ([`crate::model_catalog`]).
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): discovering and
//! installing a Skill is "what runs" (orchestration), so it belongs in Core. A
//! freshly installed Skill lands in the universal Agent Skills directory as
//! `~/.claude/skills/<slug>/SKILL.md`, exactly where
//! [`crate::skills::SkillRegistry`] loads from — and the same location Claude
//! Code and the skills CLI read — so it's usable everywhere immediately.
//!
//! Zero setup, no key: the public `skills.sh` CLI talks to two anonymous
//! endpoints (the token-gated `/api/v1` surface is a separate paid product we
//! deliberately don't use):
//! - search:   `GET https://skills.sh/api/search?q=<query>&limit=<n>`
//! - download: `GET https://skills.sh/api/download/<owner>/<repo>/<slug>`
//!
//! Both are overridable via `SKILLS_SH_API_URL` so the source stays swappable.

use anyhow::{Context, Result};
use serde::Serialize;

const GITHUB_CACHE_TTL_SECONDS: u64 = 60 * 60 * 24;

pub mod from_source;

pub(crate) const USER_AGENT: &str = "ryu-core/0.1 (+https://ryu.app)";

/// Base URL for the public skills.sh API. Swappable via `SKILLS_SH_API_URL`.
fn api_base() -> String {
    std::env::var("SKILLS_SH_API_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://skills.sh".to_string())
}

/// Seed queries used to populate the default "featured" view (no search text).
/// Merged + de-duped + sorted by installs so the catalog is never empty on open.
const FEATURED_QUERIES: &[&str] = &[
    "agent",
    "react",
    "next",
    "typescript",
    "python",
    "security",
    "database",
    "testing",
];

/// A single Skill as shown in the left-hand selector list.
#[derive(Debug, Clone, Serialize)]
pub struct SkillCard {
    /// Full id, `owner/repo/slug`, e.g. `"vercel-labs/agent-skills/vercel-react-best-practices"`.
    pub id: String,
    /// Repo source, `owner/repo`.
    pub source: String,
    /// Skill slug (the last id segment).
    pub slug: String,
    /// Human-friendly name (frontmatter name on detail; slug-derived in lists).
    pub name: String,
    /// Lifetime install count from the directory.
    pub installs: u64,
    /// Download count when exposed by the upstream catalog. skills.sh currently
    /// uses installs as the public download-like popularity counter.
    pub downloads: u64,
    /// True when this Skill is already installed in the universal skills dir.
    pub installed: bool,
}

/// One file inside a Skill package.
#[derive(Debug, Clone, Serialize)]
pub struct SkillFile {
    pub path: String,
    pub contents: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SkillAudit {
    pub name: String,
    pub status: String,
    pub url: Option<String>,
    pub summary: Option<String>,
    pub risk_level: Option<String>,
    pub audited_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct SkillDetailMetadata {
    pub installs: Option<String>,
    pub github_stars: Option<String>,
    pub first_seen: Option<String>,
    pub github_created_at: Option<String>,
    pub github_updated_at: Option<String>,
    pub github_pushed_at: Option<String>,
    pub security_audits: Vec<SkillAudit>,
    pub repository_url: Option<String>,
}

/// The full right-hand detail payload for a selected Skill.
#[derive(Debug, Clone, Serialize)]
pub struct SkillDetail {
    pub card: SkillCard,
    /// One-line description from the SKILL.md front-matter.
    pub description: Option<String>,
    /// The SKILL.md body (front-matter stripped) — the "what this does" docs.
    pub readme: Option<String>,
    /// Optional marketplace metadata shown on skills.sh detail pages.
    pub metadata: SkillDetailMetadata,
    /// Every file in the package (SKILL.md + any examples/assets).
    pub files: Vec<SkillFile>,
    /// Link to the Skill's page on skills.sh.
    pub url: String,
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

fn get(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    client.get(url).header("User-Agent", USER_AGENT)
}

#[derive(serde::Deserialize)]
struct SearchResponse {
    #[serde(default)]
    skills: Vec<SearchItem>,
}

#[derive(serde::Deserialize)]
struct SearchItem {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    installs: u64,
    #[serde(default)]
    source: String,
}

/// Derive the slug (last segment) from a full `owner/repo/slug` id.
fn slug_of(id: &str) -> String {
    id.rsplit('/').next().unwrap_or(id).to_string()
}

fn to_card(item: SearchItem, installed_slugs: &std::collections::HashSet<String>) -> SkillCard {
    let slug = slug_of(&item.id);
    let installed = installed_slugs.contains(&slug);
    let name = if item.name.is_empty() {
        slug.clone()
    } else {
        item.name
    };
    SkillCard {
        source: item.source,
        installed,
        name,
        installs: item.installs,
        downloads: item.installs,
        slug,
        id: item.id,
    }
}

/// Search the skills.sh directory. With an empty query we merge a handful of
/// seed searches into a "featured" view sorted by installs so the list is never
/// empty on first open. When `installed_only` is set we filter to installed.
pub async fn search_skills(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
    installed_only: bool,
) -> Result<Vec<SkillCard>> {
    let installed = installed_slugs();
    // skills.sh has no offset/cursor pagination but happily returns large batches
    // (300+ for a search). Clients fetch one generous batch and window it
    // client-side for an infinite-scroll feel, so allow a higher ceiling than the
    // old 40-default implied.
    let limit = limit.clamp(1, 200);

    // The installed view lists what's actually on disk (so it shows Skills that
    // aren't in the current search results), not a filtered search.
    if installed_only {
        return Ok(installed_cards());
    }

    let items = if query.trim().is_empty() {
        featured(client, limit).await?
    } else {
        search_once(client, query.trim(), limit).await?
    };

    Ok(items
        .into_iter()
        .map(|it| to_card(it, &installed))
        .collect())
}

/// Build cards for the installed view by scanning the universal skills directory
/// (both the standard `<slug>/SKILL.md` layout and any legacy flat `<slug>.md`),
/// reading each skill's front-matter for a friendly name, and resolving the full
/// `owner/repo/slug` id from the catalog provenance record when available (so
/// the detail panel can still load it).
fn installed_cards() -> Vec<SkillCard> {
    let provenance = load_provenance();
    let dir = crate::skills::SkillRegistry::skills_dir();
    let mut cards: Vec<SkillCard> = Vec::new();
    for found in crate::skills::scan_skill_dir(&dir) {
        let slug = found.id;
        let contents = std::fs::read_to_string(&found.skill_md).unwrap_or_default();
        let (fm, _) = split_front_matter(&contents);
        let name = front_matter_field(&fm, "name").unwrap_or_else(|| slug.clone());
        // Provenance gives the full id (clickable detail); else fall back to the
        // bare slug so user-authored local skills still appear.
        let id = provenance
            .get(&slug)
            .cloned()
            .unwrap_or_else(|| slug.clone());
        let source = id.rsplitn(2, '/').nth(1).unwrap_or("").to_string();
        cards.push(SkillCard {
            id,
            source,
            slug,
            name,
            installs: 0,
            downloads: 0,
            installed: true,
        });
    }
    cards.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    cards
}

/// One search request against `/api/search`.
async fn search_once(
    client: &reqwest::Client,
    query: &str,
    limit: usize,
) -> Result<Vec<SearchItem>> {
    let url = format!(
        "{}/api/search?q={}&limit={limit}",
        api_base(),
        urlencoding::encode(query)
    );
    let resp = get(client, &url)
        .send()
        .await
        .context("requesting skills search")?;
    if !resp.status().is_success() {
        anyhow::bail!("skills.sh search returned HTTP {}", resp.status());
    }
    let parsed: SearchResponse = resp.json().await.context("parsing skills search")?;
    Ok(parsed.skills)
}

/// Merge several seed searches into a de-duped, install-sorted featured list.
async fn featured(client: &reqwest::Client, limit: usize) -> Result<Vec<SearchItem>> {
    let mut seen = std::collections::HashSet::new();
    let mut merged: Vec<SearchItem> = Vec::new();
    for q in FEATURED_QUERIES {
        // Best-effort per seed: a single failing query shouldn't blank the page.
        if let Ok(items) = search_once(client, q, 20).await {
            for it in items {
                if seen.insert(it.id.clone()) {
                    merged.push(it);
                }
            }
        }
    }
    merged.sort_by(|a, b| b.installs.cmp(&a.installs));
    merged.truncate(limit);
    Ok(merged)
}

// ── Detail ─────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct DownloadResponse {
    #[serde(default)]
    files: Vec<DownloadFile>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct DownloadFile {
    path: String,
    #[serde(default)]
    contents: String,
}

#[derive(serde::Deserialize)]
struct AuditResponse {
    #[serde(default)]
    audits: Vec<AuditItem>,
}

#[derive(serde::Deserialize)]
struct AuditItem {
    provider: String,
    slug: String,
    status: String,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default, rename = "riskLevel")]
    risk_level: Option<String>,
    #[serde(default, rename = "auditedAt")]
    audited_at: Option<String>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct GithubRepo {
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    stargazers_count: Option<u64>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    pushed_at: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct CacheEnvelope<T> {
    fetched_at: u64,
    value: T,
}

#[derive(serde::Deserialize)]
struct GithubTreeResponse {
    #[serde(default)]
    tree: Vec<GithubTreeItem>,
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
struct GithubTreeItem {
    path: String,
    #[serde(rename = "type")]
    kind: String,
}

/// Split a full `owner/repo/slug` id into its three parts. The slug may itself
/// contain a colon (e.g. `react:components`) but never a slash, so the first two
/// segments are always owner + repo.
fn split_id(id: &str) -> Option<(String, String, String)> {
    let mut parts = id.splitn(3, '/');
    let owner = parts.next()?.to_string();
    let repo = parts.next()?.to_string();
    let slug = parts.next()?.to_string();
    if owner.is_empty() || repo.is_empty() || slug.is_empty() {
        return None;
    }
    Some((owner, repo, slug))
}

async fn download(client: &reqwest::Client, id: &str) -> Result<Vec<DownloadFile>> {
    let (owner, repo, slug) = split_id(id).context("skill id must be owner/repo/slug")?;
    let url = format!(
        "{}/api/download/{}/{}/{}",
        api_base(),
        urlencoding::encode(&owner),
        urlencoding::encode(&repo),
        urlencoding::encode(&slug)
    );
    let resp = get(client, &url)
        .send()
        .await
        .context("requesting skill download")?;
    if !resp.status().is_success() {
        anyhow::bail!("skills.sh download returned HTTP {}", resp.status());
    }
    let parsed: DownloadResponse = resp.json().await.context("parsing skill download")?;
    Ok(parsed.files)
}

async fn fetch_page_metadata(client: &reqwest::Client, id: &str) -> SkillDetailMetadata {
    let url = format!("{}/{id}", api_base());
    let Ok(resp) = get(client, &url).send().await else {
        return SkillDetailMetadata::default();
    };
    let Ok(html) = resp.text().await else {
        return SkillDetailMetadata::default();
    };

    let mut metadata = SkillDetailMetadata {
        installs: text_after_label(&html, "Installs"),
        github_stars: text_after_label(&html, "GitHub Stars"),
        first_seen: text_after_label(&html, "First Seen"),
        github_created_at: None,
        github_updated_at: None,
        github_pushed_at: None,
        repository_url: repository_url(&html),
        security_audits: security_audits(&html),
    };

    if metadata.security_audits.is_empty() {
        metadata.security_audits = fetch_audit_metadata(client, id).await;
    }
    enrich_github_metadata(client, id, &mut metadata).await;

    metadata
}

async fn fetch_audit_metadata(client: &reqwest::Client, id: &str) -> Vec<SkillAudit> {
    let url = format!("{}/api/v1/skills/audit/{id}", api_base());
    let Ok(resp) = get(client, &url).send().await else {
        return Vec::new();
    };
    if !resp.status().is_success() {
        return Vec::new();
    }
    let Ok(parsed) = resp.json::<AuditResponse>().await else {
        return Vec::new();
    };
    parsed
        .audits
        .into_iter()
        .map(|audit| SkillAudit {
            name: audit.provider,
            status: audit.status,
            url: Some(format!("{}/{id}/security/{}", api_base(), audit.slug)),
            summary: audit.summary,
            risk_level: audit.risk_level,
            audited_at: audit.audited_at,
        })
        .collect()
}

async fn enrich_github_metadata(
    client: &reqwest::Client,
    id: &str,
    metadata: &mut SkillDetailMetadata,
) {
    let Some((owner, repo, _slug)) = split_id(id) else {
        return;
    };
    let Ok(repo) = cached_github_repo(client, &owner, &repo).await else {
        return;
    };
    if metadata.github_stars.is_none() {
        metadata.github_stars = repo.stargazers_count.map(format_compact_count);
    }
    if metadata.repository_url.is_none() {
        metadata.repository_url = repo.html_url;
    }
    metadata.github_created_at = metadata.github_created_at.take().or(repo.created_at);
    metadata.github_updated_at = metadata.github_updated_at.take().or(repo.updated_at);
    metadata.github_pushed_at = metadata.github_pushed_at.take().or(repo.pushed_at);
}

async fn catalog_card_for_detail(client: &reqwest::Client, id: &str) -> Option<SearchItem> {
    let slug = slug_of(id);
    let items = search_once(client, &slug, 20).await.ok()?;
    if let Some(item) = items.into_iter().find(|item| item.id == id) {
        return Some(item);
    }
    search_once(client, id, 1).await.ok()?.into_iter().next()
}

async fn cached_github_repo(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Result<GithubRepo> {
    let path = github_cache_path(&format!("{owner}__{repo}__repo.json"));
    if let Some(value) = read_fresh_cache::<GithubRepo>(&path) {
        return Ok(value);
    }
    let url = format!("https://api.github.com/repos/{owner}/{repo}");
    let resp = get(client, &url)
        .send()
        .await
        .context("requesting GitHub repo metadata")?;
    if !resp.status().is_success() {
        anyhow::bail!("GitHub repo metadata returned HTTP {}", resp.status());
    }
    let repo = resp
        .json::<GithubRepo>()
        .await
        .context("parsing GitHub repo metadata")?;
    write_cache(&path, &repo);
    Ok(repo)
}

async fn cached_github_tree(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Result<Vec<GithubTreeItem>> {
    let path = github_cache_path(&format!("{owner}__{repo}__tree.json"));
    if let Some(value) = read_fresh_cache::<Vec<GithubTreeItem>>(&path) {
        return Ok(value);
    }
    let url = format!("https://api.github.com/repos/{owner}/{repo}/git/trees/HEAD?recursive=1");
    let resp = get(client, &url)
        .send()
        .await
        .context("requesting GitHub repo tree")?;
    if !resp.status().is_success() {
        anyhow::bail!("GitHub repo tree returned HTTP {}", resp.status());
    }
    let parsed = resp
        .json::<GithubTreeResponse>()
        .await
        .context("parsing GitHub repo tree")?;
    let tree = parsed
        .tree
        .into_iter()
        .filter(|item| item.kind == "blob")
        .collect::<Vec<_>>();
    write_cache(&path, &tree);
    Ok(tree)
}

async fn enrich_file_contents_from_github(
    client: &reqwest::Client,
    id: &str,
    files: Vec<DownloadFile>,
) -> Vec<DownloadFile> {
    if files.iter().all(|file| !file.contents.is_empty()) {
        return files;
    }
    let Some((owner, repo, slug)) = split_id(id) else {
        return files;
    };
    let cache_path = github_cache_path(&format!(
        "{}__{}__{}__files.json",
        owner,
        repo,
        safe_cache_segment(&slug)
    ));
    if let Some(cached) = read_fresh_cache::<Vec<DownloadFile>>(&cache_path) {
        return merge_cached_file_contents(files, cached);
    }
    let Ok(tree) = cached_github_tree(client, &owner, &repo).await else {
        return files;
    };
    let mut enriched = Vec::with_capacity(files.len());
    for mut file in files {
        if file.contents.is_empty() {
            if let Some(repo_path) = find_repo_file_path(&tree, &slug, &file.path) {
                if let Ok(contents) = fetch_github_raw_file(client, &owner, &repo, &repo_path).await
                {
                    file.contents = contents;
                }
            }
        }
        enriched.push(file);
    }
    write_cache(&cache_path, &enriched);
    enriched
}

fn merge_cached_file_contents(
    files: Vec<DownloadFile>,
    cached: Vec<DownloadFile>,
) -> Vec<DownloadFile> {
    let cached_by_path = cached
        .into_iter()
        .map(|file| (file.path.clone(), file.contents))
        .collect::<std::collections::HashMap<_, _>>();
    files
        .into_iter()
        .map(|mut file| {
            if file.contents.is_empty() {
                if let Some(contents) = cached_by_path.get(&file.path) {
                    file.contents = contents.clone();
                }
            }
            file
        })
        .collect()
}

fn find_repo_file_path(tree: &[GithubTreeItem], slug: &str, package_path: &str) -> Option<String> {
    let normalized_package_path = package_path.replace('\\', "/");
    let slug_prefix = format!("{slug}/");
    let suffix = format!("/{slug}/{}", normalized_package_path);
    tree.iter()
        .find(|item| item.path == normalized_package_path)
        .or_else(|| {
            tree.iter().find(|item| {
                item.path.ends_with(&suffix)
                    || (item.path.starts_with(&slug_prefix)
                        && item.path.ends_with(&normalized_package_path))
            })
        })
        .or_else(|| {
            tree.iter().find(|item| {
                item.path
                    .ends_with(&format!("/{}", normalized_package_path))
            })
        })
        .map(|item| item.path.clone())
}

async fn fetch_github_raw_file(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    path: &str,
) -> Result<String> {
    let encoded_path = path
        .split('/')
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/");
    let url = format!("https://raw.githubusercontent.com/{owner}/{repo}/HEAD/{encoded_path}");
    let resp = get(client, &url)
        .send()
        .await
        .context("requesting GitHub raw file")?;
    if !resp.status().is_success() {
        anyhow::bail!("GitHub raw file returned HTTP {}", resp.status());
    }
    let bytes = resp.bytes().await.context("reading GitHub raw file")?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

fn github_cache_path(name: &str) -> std::path::PathBuf {
    crate::paths::ryu_dir()
        .join("cache")
        .join("skills-github")
        .join(safe_cache_segment(name))
}

fn safe_cache_segment(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn read_fresh_cache<T>(path: &std::path::Path) -> Option<T>
where
    T: serde::de::DeserializeOwned,
{
    let raw = std::fs::read_to_string(path).ok()?;
    let envelope = serde_json::from_str::<CacheEnvelope<T>>(&raw).ok()?;
    if now_unix_seconds().saturating_sub(envelope.fetched_at) <= GITHUB_CACHE_TTL_SECONDS {
        Some(envelope.value)
    } else {
        None
    }
}

fn write_cache<T>(path: &std::path::Path, value: &T)
where
    T: Serialize,
{
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let envelope = CacheEnvelope {
        fetched_at: now_unix_seconds(),
        value,
    };
    if let Ok(json) = serde_json::to_string(&envelope) {
        let _ = std::fs::write(path, json);
    }
}

fn format_compact_count(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}K", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn text_after_label(html: &str, label: &str) -> Option<String> {
    let idx = html.find(label)?;
    let after = &html[idx + label.len()..];
    let text = strip_tags(after);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn repository_url(html: &str) -> Option<String> {
    let idx = html.find("Repository")?;
    let after = &html[idx..];
    let href_idx = after.find("href=\"")?;
    let href = &after[href_idx + 6..];
    let end = href.find('"')?;
    let url = href[..end].replace("&amp;", "&");
    // Parse and enforce scheme + exact host, not a substring match: a bare
    // `contains("github.com")` would accept `https://github.com.evil.com/...`,
    // `https://evil.com/?x=github.com`, or even a `javascript:` URL that happens
    // to contain the literal, which a client could bind to an `<a href>` (XSS /
    // phishing). Require https and a github.com (or *.github.com) host.
    let parsed = url::Url::parse(&url).ok()?;
    if parsed.scheme() != "https" {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host == "github.com" || host.ends_with(".github.com") {
        Some(url)
    } else {
        None
    }
}

fn security_audits(html: &str) -> Vec<SkillAudit> {
    let Some(idx) = html.find("Security Audits") else {
        return Vec::new();
    };
    let after = &html[idx..];
    let end = after.find("Browse").unwrap_or(after.len());
    let section = &after[..end];
    let mut audits = Vec::new();
    for marker in section.match_indices("<a ") {
        let anchor = &section[marker.0..];
        let anchor_end = anchor.find("</a>").unwrap_or(anchor.len());
        let anchor = &anchor[..anchor_end];
        let text = strip_tags(anchor);
        let lines: Vec<&str> = text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect();
        let Some(name) = lines.first() else {
            continue;
        };
        let status = lines.get(1).copied().unwrap_or("");
        if ["Gen Agent Trust Hub", "Socket", "Snyk"].contains(name) {
            audits.push(SkillAudit {
                name: (*name).to_string(),
                status: status.to_string(),
                url: href_from_anchor(anchor),
                summary: None,
                risk_level: None,
                audited_at: None,
            });
        }
    }
    audits
}

fn href_from_anchor(anchor: &str) -> Option<String> {
    let href_idx = anchor.find("href=\"")?;
    let href = &anchor[href_idx + 6..];
    let end = href.find('"')?;
    let href = href[..end].replace("&amp;", "&");
    if href.starts_with("http") {
        Some(href)
    } else {
        Some(format!("{}{}", api_base(), href))
    }
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push('\n');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    html_escape(&out)
}

fn html_escape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
}

fn parse_compact_count(value: Option<&str>) -> u64 {
    let Some(raw) = value else {
        return 0;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    let (number, multiplier) = match trimmed.chars().last() {
        Some('K') | Some('k') => (&trimmed[..trimmed.len() - 1], 1_000.0),
        Some('M') | Some('m') => (&trimmed[..trimmed.len() - 1], 1_000_000.0),
        _ => (trimmed, 1.0),
    };
    number
        .replace(',', "")
        .parse::<f64>()
        .map(|n| (n * multiplier).round() as u64)
        .unwrap_or(0)
}

/// Fetch full detail: the SKILL.md docs + front-matter description + file list.
pub async fn skill_detail(client: &reqwest::Client, id: &str) -> Result<SkillDetail> {
    let files = enrich_file_contents_from_github(client, id, download(client, id).await?).await;
    let mut metadata = fetch_page_metadata(client, id).await;
    let slug = slug_of(id);
    let source = id.rsplitn(2, '/').nth(1).unwrap_or(id).to_string();

    let skill_md = files
        .iter()
        .find(|f| f.path.eq_ignore_ascii_case("SKILL.md"))
        .or_else(|| {
            files
                .iter()
                .find(|f| f.path.to_lowercase().ends_with("skill.md"))
        });

    let (description, name, readme) = match skill_md {
        Some(f) => {
            let (fm, body) = split_front_matter(&f.contents);
            (
                front_matter_field(&fm, "description"),
                front_matter_field(&fm, "name").unwrap_or_else(|| slug.clone()),
                Some(body),
            )
        }
        None => (None, slug.clone(), None),
    };

    let installed = installed_slugs().contains(&slug);
    let catalog_installs = catalog_card_for_detail(client, id)
        .await
        .map(|item| item.installs)
        .unwrap_or(0);
    if metadata.installs.is_none() && catalog_installs > 0 {
        metadata.installs = Some(format_compact_count(catalog_installs));
    }
    let installs = catalog_installs.max(parse_compact_count(metadata.installs.as_deref()));
    let card = SkillCard {
        id: id.to_string(),
        source,
        installed,
        installs,
        downloads: installs,
        name,
        slug: slug.clone(),
    };

    Ok(SkillDetail {
        card,
        description,
        readme,
        metadata,
        files: files
            .into_iter()
            .map(|f| SkillFile {
                path: f.path,
                contents: f.contents,
            })
            .collect(),
        url: format!("{}/{id}", api_base()),
    })
}

// ── Install ───────────────────────────────────────────────────────────────

/// Outcome of installing a Skill.
#[derive(Debug, Clone, Serialize)]
pub struct InstallResult {
    pub slug: String,
    pub path: String,
}

/// Download a Skill and write it into the universal Agent Skills directory in the
/// standard one-directory-per-skill layout: `~/.claude/skills/<slug>/SKILL.md`
/// plus every bundled resource at its declared relative path. The
/// [`crate::skills::SkillRegistry`] loads it on next scan, and so do Claude Code
/// and the skills CLI, which read the same directory.
pub async fn install_skill(client: &reqwest::Client, id: &str) -> Result<InstallResult> {
    let files = download(client, id).await?;
    let slug = slug_of(id);

    let has_skill_md = files
        .iter()
        .any(|f| f.path.to_lowercase().ends_with("skill.md"));
    if !has_skill_md {
        anyhow::bail!("package has no SKILL.md — cannot install");
    }

    let skill_dir = crate::skills::SkillRegistry::skills_dir().join(&slug);
    tokio::fs::create_dir_all(&skill_dir)
        .await
        .with_context(|| format!("creating skill dir {}", skill_dir.display()))?;

    // Write the entry doc last (atomically, via tmp+rename) so a concurrent
    // registry reload never observes a half-written SKILL.md.
    let mut skill_md_contents: Option<&str> = None;
    for f in &files {
        if f.path.to_lowercase().ends_with("skill.md") {
            skill_md_contents = Some(&f.contents);
            continue;
        }
        let Some(dest) = safe_join(&skill_dir, &f.path) else {
            tracing::warn!("skipping skill file with unsafe path: {}", f.path);
            continue;
        };
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        tokio::fs::write(&dest, &f.contents)
            .await
            .with_context(|| format!("writing {}", dest.display()))?;
    }

    let dest = skill_dir.join("SKILL.md");
    let tmp = skill_dir.join("SKILL.md.tmp");
    tokio::fs::write(&tmp, skill_md_contents.unwrap_or_default())
        .await
        .with_context(|| format!("writing {}", tmp.display()))?;
    tokio::fs::rename(&tmp, &dest)
        .await
        .with_context(|| format!("rename {} -> {}", tmp.display(), dest.display()))?;

    // Record provenance (slug → full id) so the installed view can deep-link
    // back to the catalog detail for this Skill.
    record_provenance(&slug, id);
    // A skill the user installed *through Ryu* is active by default — it injects
    // on the default chat route (bulk-discovered shared-dir skills do not until
    // the user activates them).
    crate::skills::set_active(&slug, true);

    Ok(InstallResult {
        slug,
        path: dest.to_string_lossy().to_string(),
    })
}

/// Join a package-declared relative path onto `base`, rejecting anything that
/// would escape the skill directory (absolute paths, `..`, drive/root
/// components). Returns `None` for an unsafe or empty path.
fn safe_join(base: &std::path::Path, rel: &str) -> Option<std::path::PathBuf> {
    // Reject a rooted/UNC/drive-qualified path up front (before normalization
    // collapses the leading separators). A UNC `\\server\share` or rooted `/abs`
    // must never be joined onto a skill dir.
    if std::path::Path::new(rel).has_root()
        || rel.starts_with('/')
        || rel.starts_with('\\')
        || rel.contains(':')
    {
        return None;
    }
    let normalized = rel.replace('\\', "/");
    let mut out = base.to_path_buf();
    let mut pushed = false;
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return None;
        }
        // Reject a rooted or drive-qualified segment. On Windows, `PathBuf::push`
        // with a rooted component (`C:/evil`, `\\server\share`, `/abs`) REPLACES
        // the base instead of appending, escaping the skill dir.
        if std::path::Path::new(segment).has_root() || segment.contains(':') {
            return None;
        }
        out.push(segment);
        pushed = true;
    }
    if pushed {
        Some(out)
    } else {
        None
    }
}

// ── Provenance (slug → catalog id) ───────────────────────────────────────────

fn provenance_path() -> std::path::PathBuf {
    crate::paths::ryu_dir().join("skills-catalog-installed.json")
}

fn load_provenance() -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(provenance_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn record_provenance(slug: &str, id: &str) {
    let mut map = load_provenance();
    map.insert(slug.to_string(), id.to_string());
    if let Ok(json) = serde_json::to_string_pretty(&map) {
        let path = provenance_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, json);
    }
}

// ── Installed detection ─────────────────────────────────────────────────────

/// Slugs of Skills currently present in the universal skills directory (either
/// the standard `<slug>/SKILL.md` layout or a legacy flat `<slug>.md`).
fn installed_slugs() -> std::collections::HashSet<String> {
    let dir = crate::skills::SkillRegistry::skills_dir();
    crate::skills::scan_skill_dir(&dir)
        .into_iter()
        .map(|s| s.id)
        .collect()
}

// ── SKILL.md front-matter parsing ────────────────────────────────────────────

/// Split a SKILL.md into `(front_matter_yaml, body)`. Mirrors the model
/// catalog's README handling but returns the YAML block too so we can read
/// `name` / `description` without a YAML dependency.
fn split_front_matter(md: &str) -> (String, String) {
    let trimmed = md.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let fm = rest[..end].to_string();
            let body = rest[end + 4..].trim_start_matches(['\n', '\r']).to_string();
            return (fm, body);
        }
    }
    (String::new(), md.to_string())
}

/// Read a top-level `key: value` string from a YAML front-matter block. Only
/// supports the simple scalar case Skills use for `name`/`description`.
fn front_matter_field(fm: &str, key: &str) -> Option<String> {
    for line in fm.lines() {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(value) = rest.strip_prefix(':') {
                let v = value.trim().trim_matches(['"', '\'']).to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_of_takes_last_segment() {
        assert_eq!(
            slug_of("vercel-labs/agent-skills/find-skills"),
            "find-skills"
        );
        assert_eq!(slug_of("a/b/react:components"), "react:components");
    }

    #[test]
    fn split_id_three_parts() {
        assert_eq!(
            split_id("vercel-labs/agent-skills/find-skills"),
            Some((
                "vercel-labs".into(),
                "agent-skills".into(),
                "find-skills".into()
            ))
        );
        assert_eq!(split_id("only/two"), None);
    }

    #[test]
    fn front_matter_parsing() {
        let md =
            "---\nname: find-skills\ndescription: \"Helps you discover skills\"\n---\n# Body\ntext";
        let (fm, body) = split_front_matter(md);
        assert_eq!(
            front_matter_field(&fm, "name").as_deref(),
            Some("find-skills")
        );
        assert_eq!(
            front_matter_field(&fm, "description").as_deref(),
            Some("Helps you discover skills")
        );
        assert_eq!(body, "# Body\ntext");
    }

    #[test]
    fn front_matter_absent() {
        let (fm, body) = split_front_matter("# Just markdown");
        assert!(fm.is_empty());
        assert_eq!(body, "# Just markdown");
        assert_eq!(front_matter_field(&fm, "name"), None);
    }

    #[test]
    fn safe_join_keeps_paths_inside_base() {
        let base = std::path::Path::new("/skills/alpha");
        assert_eq!(safe_join(base, "SKILL.md"), Some(base.join("SKILL.md")));
        assert_eq!(
            safe_join(base, "references/guide.md"),
            Some(base.join("references").join("guide.md"))
        );
        // Backslashes normalize to the same nested path.
        assert_eq!(
            safe_join(base, "references\\guide.md"),
            Some(base.join("references").join("guide.md"))
        );
    }

    #[test]
    fn safe_join_rejects_traversal_and_empty() {
        let base = std::path::Path::new("/skills/alpha");
        assert_eq!(safe_join(base, "../escape.md"), None);
        assert_eq!(safe_join(base, "a/../../b.md"), None);
        assert_eq!(safe_join(base, ""), None);
        assert_eq!(safe_join(base, "."), None);
    }

    #[test]
    fn safe_join_rejects_drive_and_rooted_segments() {
        let base = std::path::Path::new("/skills/alpha");
        // A drive-qualified path must not escape (on Windows `push` would replace).
        assert_eq!(safe_join(base, "C:/evil.md"), None);
        // A UNC/share path must not escape either.
        assert_eq!(safe_join(base, "\\\\server\\share\\x.md"), None);
    }
}
