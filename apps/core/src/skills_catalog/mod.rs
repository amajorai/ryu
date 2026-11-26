//! Skills catalog — browse and install Agent Skills from the public skills.sh
//! directory. **All logic lives here in Core** so the desktop, mobile, and
//! extension are pure GUI layers over one HTTP API, exactly like the model
//! catalog ([`crate::model_catalog`]).
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): discovering and
//! installing a Skill is "what runs" (orchestration), so it belongs in Core. A
//! freshly installed Skill lands in the universal Agent Skills directory as
//! `~/.claude/skills/<slug>/SKILL.md`, exactly where
//! [`ryu_skills::SkillRegistry`] loads from — and the same location Claude
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

pub mod default_skills;
pub mod distribution;
pub mod from_source;
pub mod packs;
pub mod plugin_skills;
pub(crate) mod public_stats;
pub mod system_skills;

// The detail and install code lives in `detail.rs`, `detail_page.rs` and `install.rs`.
// Each starts with `use super::*;`, so the imports above and the items of this file
// reach them exactly as they did in the single file.
mod detail;
mod detail_page;
mod install;
#[cfg(test)]
mod tests;

use detail::*;
pub use detail_page::*;
pub use install::*;

pub(crate) const USER_AGENT: &str = "ryu-core/0.1 (+https://ryu.app)";

/// Base URL for the public skills.sh API. Swappable via `SKILLS_SH_API_URL`.
fn api_base() -> String {
    std::env::var("SKILLS_SH_API_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://skills.sh".to_string())
}

pub(crate) fn uses_public_catalog() -> bool {
    api_base().trim_end_matches('/') == "https://skills.sh"
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
    /// One-line "what this does", when the source can supply it without a
    /// per-card round trip.
    ///
    /// Populated for INSTALLED cards (read straight out of the on-disk SKILL.md
    /// front matter, which is already being parsed here for `name`) and for the
    /// detail card. `None` for a browse result, because `skills.sh`'s
    /// `/api/search` returns only `id`/`name`/`installs`/`source` — filling it
    /// there would mean one extra HTTP request per card. Clients fall back to the
    /// source + install count, which is what they showed for every card before.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Lifetime install count from the directory.
    pub installs: u64,
    /// Download count when exposed by the upstream catalog. skills.sh currently
    /// uses installs as the public download-like popularity counter.
    pub downloads: u64,
    /// True when this Skill is already installed in the universal skills dir.
    pub installed: bool,
    /// How much the *source* vouches for this entry: `"builtin"`, `"trusted"`
    /// (a first-party/vendor repo the source curates) or `"community"` (anyone
    /// can publish). `None` when the source makes no claim.
    ///
    /// This is a property of the REGISTRY, not an audit of the skill: a
    /// community registry is open-publish, so everything it serves is
    /// `"community"` regardless of how popular the entry is. Clients render it
    /// as a badge so an open-publish registry can never be mistaken for a
    /// curated one — see the ClawHub note in `catalog_source::skill_registries`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_level: Option<String>,
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

pub(crate) fn get(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
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
    /// Not returned by skills.sh `/api/search` today — accepted so a source that
    /// does supply it (or a future skills.sh) flows straight through to the card
    /// without a Core change.
    #[serde(default)]
    description: Option<String>,
}

/// Derive the slug (last segment) from a full `owner/repo/slug` id.
pub(crate) fn slug_of(id: &str) -> String {
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
        // `#[serde(default)]` on SearchItem, so this is `None` against today's
        // skills.sh (its search payload carries no description) and starts
        // populating browse cards for free the day any source adds the field.
        description: item.description.filter(|d| !d.trim().is_empty()),
        // skills.sh is open-publish (anyone can index a public repo), so every
        // browse card it serves is community-trust.
        trust_level: Some("community".to_string()),
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
    let mut cards: Vec<SkillCard> = Vec::new();
    for found in ryu_skills::scan_all_skill_dirs() {
        let slug = found.id;
        let contents = std::fs::read_to_string(&found.skill_md).unwrap_or_default();
        let (fm, _) = split_front_matter(&contents);
        let name = front_matter_field(&fm, "name").unwrap_or_else(|| slug.clone());
        // The front matter is already open and already being read for `name`, so
        // the one-line description is free here — and it is the only place a
        // description exists without a network round trip.
        let description = front_matter_field(&fm, "description");
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
            description,
            // Already on disk: the user accepted it, so the registry's claim is
            // no longer the relevant signal.
            trust_level: None,
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
// ── Provenance (slug → catalog id) ───────────────────────────────────────────

fn provenance_path() -> std::path::PathBuf {
    crate::paths::state_path("skills-catalog-installed.json")
}

fn load_provenance() -> std::collections::HashMap<String, String> {
    std::fs::read_to_string(provenance_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub(crate) fn record_provenance(slug: &str, id: &str) {
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

pub(crate) fn skill_provenance_matches(slug: &str, id: &str) -> bool {
    load_provenance()
        .get(slug)
        .is_some_and(|installed_id| installed_id == id)
}

// ── Installed detection ─────────────────────────────────────────────────────

/// Slugs of Skills currently present in any standard skills root — `~/.claude/skills`
/// or the vendor-neutral `~/.agents/skills` (standard `<slug>/SKILL.md` layout, or
/// a legacy flat `<slug>.md` in the primary root).
pub(crate) fn installed_slugs() -> std::collections::HashSet<String> {
    ryu_skills::scan_all_skill_dirs()
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
