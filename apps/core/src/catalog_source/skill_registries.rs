//! The non-skills.sh **Skill** catalog registries.
//!
//! `skills.sh` ([`super::sources::SkillsShSource`]) was the only place Ryu could
//! browse skills from. This module adds the rest of the ecosystem, so the Skills
//! tab's source picker lists every public registry rather than one:
//!
//! | Source | Index | Install carries |
//! |---|---|---|
//! | [`GithubTapSource`] | `GET /repos/<repo>/git/trees/HEAD?recursive=1` | a repo subdir |
//! | [`WellKnownSource`] | `GET <base>/.well-known/skills/index.json` | a `SKILL.md` URL |
//! | [`BrowseShSource`] | `GET https://browse.sh/api/skills` | inline `skillMd` |
//! | [`ClawHubSource`] | `GET https://clawhub.ai/api/v1/skills` | inline markdown |
//! | [`LobeHubSource`] | `GET https://chat-agents.lobehub.com/index.json` | synthesized |
//!
//! ## Two install shapes, not one
//!
//! A git-backed registry (a GitHub tap) names a directory, so it installs through
//! [`from_source::install_from_source`] and the whole skill tree — scripts,
//! references, assets — comes along. The other three serve the **markdown itself**
//! and expose no fetchable repo, so they install through
//! [`from_source::install_skill_md_text`]. That is a real fidelity difference, not
//! an implementation detail: a content-served skill is only ever its `SKILL.md`,
//! so a skill that shells out to a bundled script cannot be delivered that way.
//! Prefer the tap when a registry offers both.
//!
//! ## Trust is a property of the registry
//!
//! Every card carries a `trust_level`. It describes **who may publish to the
//! source**, never whether a given skill was reviewed:
//!
//! - `"trusted"` — a vendor repo we pin by name (`anthropics/skills` et al). Only
//!   that vendor can change it.
//! - `"community"` — open publish. Anyone can put anything there.
//!
//! ClawHub is deliberately hardcoded to `"community"` in [`ClawHubSource`]
//! regardless of an entry's stars or install count, and the reason is on the
//! record: 341 malicious skills were found on it in Feb 2026. It is also, by a
//! wide margin, the largest registry here — so it is the one where a popularity
//! signal is most likely to be mistaken for a safety signal. Do not add a
//! promotion path from `"community"` to `"trusted"` based on engagement metrics.
//!
//! ## Rate limits
//!
//! GitHub's unauthenticated API allows 60 requests/hour, and a tap costs one
//! request per *search*. With several taps registered that budget is gone in
//! minutes, so every tree fetch goes through the shared 24h disk cache in
//! [`crate::skills_catalog`] (`read_fresh_cache`/`read_stale_cache`/`write_cache`)
//! and a search on a warm cache makes no network call at all. If GitHub is down,
//! the last known tree remains browseable and an already-installed skill remains
//! usable; a first install still fails closed when its bytes cannot be fetched.
//! `GITHUB_TOKEN`, when set, is sent to raise the ceiling — it is never required.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{CatalogKind, CatalogQuery, CatalogSource, InstallDescriptor};
use crate::server::guarded_get_bytes_with_headers;
use crate::skills_catalog::{self, from_source, InstallResult, SkillCard};

/// Trust label for a vendor repo we pin by name.
pub(crate) const TRUST_TRUSTED: &str = "trusted";
/// Trust label for an open-publish registry.
pub(crate) const TRUST_COMMUNITY: &str = "community";

// ── shared helpers ───────────────────────────────────────────────────────────

/// The fixed request headers for a GitHub tap.
///
/// Unauthenticated GitHub is 60 req/hour; a token raises it to 5,000. The token
/// is strictly an optimization — every tap works without one. The actual GET is
/// made by Core's shared SSRF-guarded client below; keeping the header assembly
/// separate prevents a future caller from accidentally attaching the token to an
/// unvalidated URL.
fn github_headers() -> Vec<(String, String)> {
    let mut headers = vec![(
        "Accept".to_string(),
        "application/vnd.github+json".to_string(),
    )];
    match std::env::var("GITHUB_TOKEN") {
        Ok(token) if !token.trim().is_empty() => {
            headers.push((
                "Authorization".to_string(),
                format!("Bearer {}", token.trim()),
            ));
        }
        _ => {}
    }
    headers
}

/// Fetch and deserialize JSON, with the source id in the error for triage.
async fn fetch_json<T: serde::de::DeserializeOwned>(
    _client: &reqwest::Client,
    url: &str,
    who: &str,
) -> Result<T> {
    let bytes = crate::server::guarded_get_bytes(url)
        .await
        .with_context(|| format!("requesting {who} ({url})"))?;
    serde_json::from_slice(&bytes).with_context(|| format!("decoding {who} response"))
}

/// Fetch plain text (a `SKILL.md` body).
async fn fetch_text(client: &reqwest::Client, url: &str, who: &str) -> Result<String> {
    let _ = client;
    let bytes = crate::server::guarded_get_bytes(url)
        .await
        .with_context(|| format!("requesting {who} ({url})"))?;
    String::from_utf8(bytes).with_context(|| format!("reading {who} body"))
}

/// Case-insensitive match of a query against a card's searchable text.
///
/// Registries differ on whether they filter server-side (skills.sh does, the
/// bulk-index ones do not), so filtering is done here uniformly against the same
/// fields for every source.
fn matches_query(query: &str, haystacks: &[&str]) -> bool {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return true;
    }
    haystacks
        .iter()
        .any(|h| h.to_lowercase().contains(q.as_str()))
}

const ROOT_SKILL_PATH: &str = ".";

/// Derive the directory containing a `SKILL.md` blob. A repository-root
/// `SKILL.md` is represented by `.` so it can travel through the same cached
/// path and pack-resolution contracts as nested skills.
fn skill_dir_from_blob_path(path: &str) -> Option<String> {
    let name = path.rsplit('/').next().unwrap_or_default();
    if !name.eq_ignore_ascii_case("SKILL.md") {
        return None;
    }
    Some(
        path.rsplit_once('/')
            .map(|(dir, _)| dir.to_string())
            .filter(|dir| !dir.is_empty())
            .unwrap_or_else(|| ROOT_SKILL_PATH.to_string()),
    )
}

/// Turn a slug into a human-facing title (`pdf-forms` -> `Pdf Forms`).
fn humanize(slug: &str) -> String {
    slug.split(['-', '_', '/'])
        .filter(|s| !s.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Build one card, resolving `installed` against the on-disk skills dir.
#[allow(clippy::too_many_arguments)]
fn card(
    id: impl Into<String>,
    source: impl Into<String>,
    slug: impl Into<String>,
    name: impl Into<String>,
    description: Option<String>,
    installs: u64,
    trust: &str,
    installed: &std::collections::HashSet<String>,
) -> SkillCard {
    let slug = slug.into();
    SkillCard {
        id: id.into(),
        source: source.into(),
        installed: installed.contains(&slug),
        slug,
        name: name.into(),
        description: description.filter(|d| !d.trim().is_empty()),
        installs,
        downloads: installs,
        trust_level: Some(trust.to_string()),
    }
}

/// Wrap cards in the envelope every Skill source returns, applying the limit.
fn envelope(mut cards: Vec<SkillCard>, limit: usize) -> Value {
    let limit = if limit == 0 { 40 } else { limit };
    cards.truncate(limit);
    json!({ "skills": cards })
}

/// The detail payload shape shared with `skills_catalog::skill_detail`.
#[allow(clippy::too_many_arguments)]
fn detail_value(card: SkillCard, markdown: &str, url: String, repo_url: Option<String>) -> Value {
    let (description, readme) = split_front_matter(markdown);
    json!({
        "card": card,
        "description": description,
        "readme": readme,
        "metadata": {
            "installs": null,
            "github_stars": null,
            "first_seen": null,
            "github_created_at": null,
            "github_updated_at": null,
            "github_pushed_at": null,
            "security_audits": [],
            "repository_url": repo_url,
        },
        "files": [{ "path": "SKILL.md", "contents": markdown }],
        "url": url,
    })
}

/// Split a `SKILL.md` into its front-matter `description` and its body.
///
/// Deliberately tolerant: a registry that serves hand-written markdown will not
/// always have well-formed front matter, and a missing `description` must degrade
/// to "no description", never to a failed detail fetch.
fn split_front_matter(markdown: &str) -> (Option<String>, Option<String>) {
    let trimmed = markdown.trim_start();
    if !trimmed.starts_with("---") {
        return (None, Some(markdown.to_string()));
    }
    let rest = &trimmed[3..];
    let Some(end) = rest.find("\n---") else {
        return (None, Some(markdown.to_string()));
    };
    let front = &rest[..end];
    let body = rest[end + 4..].trim_start_matches('\n').to_string();

    let mut description: Option<String> = None;
    for line in front.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("description") {
            let value = value.trim().trim_matches(['"', '\'']).trim();
            if !value.is_empty() {
                description = Some(value.to_string());
            }
            break;
        }
    }
    (description, Some(body))
}

/// The no-file descriptor every Skill source hands back: skills write a directory
/// tree rather than one checksummed download, so the route performs the install.
fn skill_descriptor(source_id: &str, id: &str) -> InstallDescriptor {
    InstallDescriptor {
        kind: CatalogKind::Skill,
        source_id: source_id.to_string(),
        repo_id: id.to_string(),
        files: Vec::new(),
        raw: Value::Null,
    }
}

// ── GitHub taps ──────────────────────────────────────────────────────────────

/// A **GitHub tap**: a repo that holds skills as `skills/<name>/SKILL.md`.
///
/// This is the source type that puts vendor skills in the Skills tab — Anthropic,
/// OpenAI, Hugging Face, NVIDIA. Browsing reads the repo's git tree; installing
/// hands the skill's subdirectory to the existing from-source fetcher, so the
/// bytes are pulled **from the vendor's own repo at install time** and Ryu never
/// mirrors, caches, or redistributes them. That matters for
/// `anthropics/skills`, whose per-skill `LICENSE.txt` is proprietary and forbids
/// redistribution — indexing and linking is fine, vendoring the bodies is not.
#[derive(Clone)]
pub struct GithubTapSource {
    pub id: String,
    pub display_name: String,
    /// `owner/repo`.
    pub repo: String,
    /// Trust label for cards from this tap.
    pub trust: String,
    /// API base override for **tests only**, set in-process.
    ///
    /// Deliberately NOT readable from an env var: this source attaches
    /// `GITHUB_TOKEN`, and an env-settable host would let anything that can set
    /// the environment redirect that token to a server of its choosing. Same
    /// rule, and same reason, as the fixed `GITHUB_API_BASE` in the parent module.
    pub api_base: Option<String>,
}

/// One entry of the git-tree response we keep.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct TreeResponse {
    #[serde(default)]
    tree: Vec<TreeEntry>,
    #[serde(default)]
    truncated: bool,
}

impl GithubTapSource {
    pub fn new(
        id: impl Into<String>,
        display_name: impl Into<String>,
        repo: impl Into<String>,
        trust: &str,
    ) -> Self {
        Self {
            id: id.into(),
            display_name: display_name.into(),
            repo: repo.into(),
            trust: trust.to_string(),
            api_base: None,
        }
    }

    pub(crate) fn api_base(&self) -> String {
        self.api_base
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| super::GITHUB_API_BASE.to_string())
    }

    /// The repo's skill directories, from cache when warm.
    ///
    /// One recursive tree call covers a whole repo, which is what keeps a tap
    /// inside GitHub's 60 req/hour unauthenticated budget. A `truncated` response
    /// (very large repos) is used as-is rather than paged: the alternative is
    /// dozens of calls, and every skills repo we tap is far below the limit.
    ///
    /// `pub(crate)`: skill **packs** (`skills_catalog::packs`) reuse exactly this
    /// tree walk to enumerate a repo's member skills — a pack is a repo whose
    /// `SKILL.md` dirs are its members, the same layout this tap indexes.
    pub(crate) async fn skill_paths(&self, client: &reqwest::Client) -> Result<Vec<String>> {
        // v2 invalidates pre-root-support caches. Without this, a previously
        // browsed root-skill repository would stay invisible until its 24h TTL
        // elapsed after an upgrade.
        let cache = skills_catalog::github_cache_path(&format!("tap-v2-{}", self.repo));
        if let Some(cached) = skills_catalog::read_fresh_cache::<Vec<String>>(&cache) {
            return Ok(cached);
        }

        let url = format!(
            "{}/repos/{}/git/trees/HEAD?recursive=1",
            self.api_base(),
            self.repo
        );
        let fetched = async {
            let _ = client;
            let bytes = guarded_get_bytes_with_headers(&url, &github_headers())
                .await
                .with_context(|| format!("requesting git tree for {}", self.repo))?;
            let tree: TreeResponse = serde_json::from_slice(&bytes)
                .with_context(|| format!("decoding git tree for {}", self.repo))?;
            if tree.truncated {
                tracing::warn!(
                    repo = %self.repo,
                    "git tree truncated; some skills may be missing from this tap"
                );
            }

            // A skill is any directory holding a SKILL.md. Derive them from the blob
            // entries rather than the tree entries so a directory that merely looks
            // like a skill (no SKILL.md) is never listed. A root SKILL.md is a valid
            // single-skill repository and is represented by `.`.
            let mut paths: Vec<String> = tree
                .tree
                .iter()
                .filter(|e| e.kind == "blob")
                .filter_map(|e| skill_dir_from_blob_path(&e.path))
                .collect();
            paths.sort();
            paths.dedup();
            Ok::<Vec<String>, anyhow::Error>(paths)
        }
        .await;
        match fetched {
            Ok(paths) => {
                skills_catalog::write_cache(&cache, &paths);
                Ok(paths)
            }
            Err(error) => {
                if let Some(cached) = skills_catalog::read_stale_cache::<Vec<String>>(&cache) {
                    tracing::warn!(
                        repo = %self.repo,
                        error = %error,
                        "GitHub skill tap unavailable; using stale cached paths"
                    );
                    Ok(cached)
                } else {
                    Err(error)
                }
            }
        }
    }

    /// `<owner>/<repo>/<leaf>` — the id shape the Skill card contract documents.
    fn id_for(&self, path: &str) -> String {
        let leaf = if path == ROOT_SKILL_PATH {
            self.repo.rsplit('/').next().unwrap_or(&self.repo)
        } else {
            path.rsplit('/').next().unwrap_or(path)
        };
        format!("{}/{leaf}", self.repo)
    }

    /// Resolve a catalog id back to its repo path.
    ///
    /// The id only carries the leaf, so a repo with the same skill name under two
    /// prefixes resolves to the first match — acceptable because a skills repo
    /// cannot have two skills of the same name installed anyway (they collide on
    /// the destination directory).
    async fn path_for(&self, client: &reqwest::Client, id: &str) -> Result<String> {
        let leaf = skills_catalog::slug_of(id);
        let paths = self.skill_paths(client).await?;
        paths
            .into_iter()
            .find(|p| {
                let candidate = if p == ROOT_SKILL_PATH {
                    self.repo.rsplit('/').next().unwrap_or(&self.repo)
                } else {
                    p.rsplit('/').next().unwrap_or(p)
                };
                candidate == leaf
            })
            .ok_or_else(|| anyhow::anyhow!("`{leaf}` not found in {}", self.repo))
    }

    fn raw_url(&self, path: &str) -> String {
        let skill_md_path = if path == ROOT_SKILL_PATH {
            "SKILL.md".to_string()
        } else {
            format!("{path}/SKILL.md")
        };
        format!(
            "https://raw.githubusercontent.com/{}/HEAD/{skill_md_path}",
            self.repo,
        )
    }

    /// The from-source spec for installing one skill of this tap.
    ///
    /// `HEAD` is a valid ref for codeload's tarball endpoint, so the default
    /// branch resolves without an extra API call to look it up.
    fn install_source(&self, path: &str) -> String {
        if path == ROOT_SKILL_PATH {
            format!("https://github.com/{}", self.repo)
        } else {
            format!("https://github.com/{}/tree/HEAD/{path}", self.repo)
        }
    }

    pub async fn install(&self, client: &reqwest::Client, id: &str) -> Result<InstallResult> {
        let path = match self.path_for(client, id).await {
            Ok(path) => path,
            Err(error) => {
                if let Some(local) = self.local_install_fallback(id) {
                    tracing::warn!(
                        repo = %self.repo,
                        id,
                        error = %error,
                        "GitHub skill tap unavailable; keeping the existing local skill"
                    );
                    return Ok(local);
                }
                return Err(error);
            }
        };
        match from_source::install_from_source(client, &self.install_source(&path)).await {
            Ok(result) => {
                skills_catalog::record_provenance(&result.slug, id);
                Ok(result)
            }
            Err(error) => self
                .local_install_fallback(id)
                .map(|local| {
                    tracing::warn!(
                        repo = %self.repo,
                        id,
                        error = %error,
                        "GitHub skill download unavailable; keeping the existing local skill"
                    );
                    local
                })
                .ok_or(error),
        }
    }

    /// Reuse the same catalog skill already on disk when GitHub is unavailable.
    /// Provenance is required because different repositories can share a slug.
    fn local_install_fallback(&self, id: &str) -> Option<InstallResult> {
        let slug = skills_catalog::slug_of(id);
        let path = ryu_skills::SkillRegistry::skills_dir()
            .join(&slug)
            .join("SKILL.md");
        if !path.is_file() || !skills_catalog::skill_provenance_matches(&slug, id) {
            return None;
        }
        Some(InstallResult {
            artifact_fingerprint: None,
            slug,
            path: path.to_string_lossy().into_owned(),
        })
    }
}

impl CatalogSource for GithubTapSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Skill
    }

    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let installed = skills_catalog::installed_slugs();
        let paths = self.skill_paths(client).await?;
        let cards: Vec<SkillCard> = paths
            .iter()
            .filter(|path| {
                let leaf = if path.as_str() == ROOT_SKILL_PATH {
                    self.repo.rsplit('/').next().unwrap_or(&self.repo)
                } else {
                    path.rsplit('/').next().unwrap_or(path)
                };
                matches_query(&q.query, &[path.as_str(), leaf, &self.repo])
            })
            .map(|path| {
                let leaf = if path.as_str() == ROOT_SKILL_PATH {
                    self.repo.rsplit('/').next().unwrap_or(&self.repo)
                } else {
                    path.rsplit('/').next().unwrap_or(path)
                };
                card(
                    self.id_for(path),
                    self.repo.clone(),
                    leaf,
                    humanize(leaf),
                    // The tree carries no descriptions, and fetching one SKILL.md
                    // per card would be a request per row. Detail fills it in.
                    None,
                    0,
                    &self.trust,
                    &installed,
                )
            })
            .collect();
        Ok(envelope(cards, q.limit))
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let path = self.path_for(client, id).await?;
        let leaf = if path == ROOT_SKILL_PATH {
            self.repo
                .rsplit('/')
                .next()
                .unwrap_or(&self.repo)
                .to_string()
        } else {
            path.rsplit('/').next().unwrap_or(&path).to_string()
        };
        let markdown = fetch_text(client, &self.raw_url(&path), "GitHub raw SKILL.md").await?;
        let installed = skills_catalog::installed_slugs();
        let (description, _) = split_front_matter(&markdown);
        let card = card(
            id,
            self.repo.clone(),
            &leaf,
            humanize(&leaf),
            description,
            0,
            &self.trust,
            &installed,
        );
        Ok(detail_value(
            card,
            &markdown,
            self.install_source(&path),
            Some(format!("https://github.com/{}", self.repo)),
        ))
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        Ok(skill_descriptor(&self.id, id))
    }
}

// ── /.well-known/skills/index.json ───────────────────────────────────────────

/// The **well-known** discovery protocol: any domain may publish
/// `/.well-known/skills/index.json` and serve each skill at
/// `<base>/<name>/SKILL.md`.
///
/// This is the open end of the system — it is how a site ships skills for its own
/// API without asking any registry for permission. Because the operator of the
/// domain is whoever the user pointed at, cards are always `"community"`.
#[derive(Clone)]
pub struct WellKnownSource {
    pub id: String,
    pub display_name: String,
    /// The site base, e.g. `https://mintlify.com/docs`.
    pub base_url: String,
}

#[derive(Debug, Deserialize)]
struct WellKnownIndex {
    #[serde(default)]
    skills: Vec<WellKnownEntry>,
}

#[derive(Debug, Deserialize)]
struct WellKnownEntry {
    name: String,
    #[serde(default)]
    description: Option<String>,
}

impl WellKnownSource {
    pub fn new(
        id: impl Into<String>,
        display_name: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            display_name: display_name.into(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// True when a base URL points at a well-known skills index.
    ///
    /// This is the discrimination the registry uses to tell a well-known site
    /// from a Claude plugin marketplace, both of which are just "a URL" in a
    /// custom source spec.
    pub fn is_well_known_url(url: &str) -> bool {
        url.split(['?', '#'])
            .next()
            .unwrap_or(url)
            .contains("/.well-known/skills")
    }

    /// Normalize either the index URL or the site base into the site base.
    pub fn base_from_url(url: &str) -> String {
        let clean = url.split(['?', '#']).next().unwrap_or(url);
        match clean.find("/.well-known/skills") {
            Some(idx) => clean[..idx].trim_end_matches('/').to_string(),
            None => clean.trim_end_matches('/').to_string(),
        }
    }

    fn index_url(&self) -> String {
        format!("{}/.well-known/skills/index.json", self.base_url)
    }

    fn skill_md_url(&self, name: &str) -> String {
        format!("{}/{name}/SKILL.md", self.base_url)
    }

    fn host(&self) -> String {
        self.base_url
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or(&self.base_url)
            .to_string()
    }

    pub async fn install(&self, client: &reqwest::Client, id: &str) -> Result<InstallResult> {
        let name = skills_catalog::slug_of(id);
        let markdown = fetch_text(client, &self.skill_md_url(&name), "well-known SKILL.md").await?;
        from_source::install_skill_md_text(&name, &markdown).await
    }
}

impl CatalogSource for WellKnownSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Skill
    }

    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let index: WellKnownIndex =
            fetch_json(client, &self.index_url(), "well-known skills index").await?;
        let installed = skills_catalog::installed_slugs();
        let host = self.host();
        let cards: Vec<SkillCard> = index
            .skills
            .into_iter()
            .filter(|e| {
                matches_query(
                    &q.query,
                    &[&e.name, e.description.as_deref().unwrap_or_default()],
                )
            })
            .map(|e| {
                card(
                    format!("{host}/{}", e.name),
                    host.clone(),
                    &e.name,
                    humanize(&e.name),
                    e.description,
                    0,
                    TRUST_COMMUNITY,
                    &installed,
                )
            })
            .collect();
        Ok(envelope(cards, q.limit))
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let name = skills_catalog::slug_of(id);
        let markdown = fetch_text(client, &self.skill_md_url(&name), "well-known SKILL.md").await?;
        let installed = skills_catalog::installed_slugs();
        let (description, _) = split_front_matter(&markdown);
        let card = card(
            id,
            self.host(),
            &name,
            humanize(&name),
            description,
            0,
            TRUST_COMMUNITY,
            &installed,
        );
        Ok(detail_value(
            card,
            &markdown,
            self.skill_md_url(&name),
            Some(self.base_url.clone()),
        ))
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        Ok(skill_descriptor(&self.id, id))
    }
}

// ── browse.sh ────────────────────────────────────────────────────────────────

/// **browse.sh** (Browserbase): skills for driving specific websites. The whole
/// catalog comes back in one call, and detail carries the `SKILL.md` inline.
#[derive(Clone)]
pub struct BrowseShSource {
    pub id: String,
    pub display_name: String,
    pub api_base: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BrowseShList {
    #[serde(default)]
    skills: Vec<BrowseShItem>,
}

#[derive(Debug, Deserialize)]
struct BrowseShItem {
    #[serde(default)]
    hostname: String,
    #[serde(default)]
    task: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct BrowseShDetail {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    domain: Option<String>,
    /// The markdown, served inline.
    #[serde(rename = "skillMd", default)]
    skill_md: Option<String>,
    /// CDN fallback when the inline body is absent.
    #[serde(rename = "skillMdUrl", default)]
    skill_md_url: Option<String>,
    #[serde(rename = "installCount", default)]
    install_count: u64,
}

impl BrowseShSource {
    pub fn builtin() -> Self {
        Self {
            id: "browse-sh".to_string(),
            display_name: "browse.sh".to_string(),
            api_base: None,
        }
    }

    pub(crate) fn api_base(&self) -> String {
        self.api_base
            .clone()
            .or_else(|| std::env::var("BROWSE_SH_API_URL").ok())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://browse.sh".to_string())
    }

    /// Detail is addressed by `<hostname>/<task>`, which is exactly the id we mint.
    fn detail_url(&self, id: &str) -> String {
        format!("{}/api/skills/{}", self.api_base(), id)
    }

    async fn markdown(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Result<(BrowseShDetail, String)> {
        let detail: BrowseShDetail =
            fetch_json(client, &self.detail_url(id), "browse.sh skill detail").await?;
        let markdown = match detail.skill_md.clone().filter(|s| !s.trim().is_empty()) {
            Some(inline) => inline,
            None => {
                let url = detail
                    .skill_md_url
                    .clone()
                    .ok_or_else(|| anyhow::anyhow!("browse.sh skill `{id}` has no SKILL.md"))?;
                fetch_text(client, &url, "browse.sh SKILL.md").await?
            }
        };
        Ok((detail, markdown))
    }

    pub async fn install(&self, client: &reqwest::Client, id: &str) -> Result<InstallResult> {
        let (detail, markdown) = self.markdown(client, id).await?;
        let name = detail
            .name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| skills_catalog::slug_of(id));
        from_source::install_skill_md_text(&name, &markdown).await
    }
}

impl CatalogSource for BrowseShSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Skill
    }

    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let url = format!("{}/api/skills", self.api_base());
        let list: BrowseShList = fetch_json(client, &url, "browse.sh catalog").await?;
        let installed = skills_catalog::installed_slugs();
        let cards: Vec<SkillCard> = list
            .skills
            .into_iter()
            .filter(|item| {
                let tags = item.tags.join(" ");
                matches_query(
                    &q.query,
                    &[
                        &item.name,
                        &item.hostname,
                        item.title.as_deref().unwrap_or_default(),
                        item.description.as_deref().unwrap_or_default(),
                        item.category.as_deref().unwrap_or_default(),
                        &tags,
                    ],
                )
            })
            .map(|item| {
                let id = format!("{}/{}", item.hostname, item.task);
                let name = item
                    .title
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| humanize(&item.name));
                card(
                    id,
                    item.hostname.clone(),
                    item.name.clone(),
                    name,
                    item.description,
                    0,
                    TRUST_COMMUNITY,
                    &installed,
                )
            })
            .collect();
        Ok(envelope(cards, q.limit))
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let (detail, markdown) = self.markdown(client, id).await?;
        let installed = skills_catalog::installed_slugs();
        let (description, _) = split_front_matter(&markdown);
        let name = detail
            .name
            .clone()
            .unwrap_or_else(|| skills_catalog::slug_of(id));
        let card = card(
            id,
            detail.domain.clone().unwrap_or_default(),
            &name,
            humanize(&name),
            description,
            detail.install_count,
            TRUST_COMMUNITY,
            &installed,
        );
        Ok(detail_value(
            card,
            &markdown,
            format!("{}/{}", self.api_base(), id),
            None,
        ))
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        Ok(skill_descriptor(&self.id, id))
    }
}

// ── ClawHub ──────────────────────────────────────────────────────────────────

/// **ClawHub**: by far the largest public skills registry, and open-publish.
///
/// Its detail payload returns the full `SKILL.md` as `skill.description`, so a
/// skill installs without a repo. See the module note on why cards from here are
/// pinned to `"community"` no matter how popular an entry is.
#[derive(Clone)]
pub struct ClawHubSource {
    pub id: String,
    pub display_name: String,
    pub api_base: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClawHubList {
    #[serde(default)]
    items: Vec<ClawHubItem>,
}

#[derive(Debug, Deserialize)]
struct ClawHubItem {
    slug: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    stats: ClawHubStats,
}

#[derive(Debug, Default, Deserialize)]
struct ClawHubStats {
    #[serde(default)]
    installs: u64,
    #[serde(default)]
    downloads: u64,
}

#[derive(Debug, Deserialize)]
struct ClawHubDetail {
    #[serde(default)]
    skill: Option<ClawHubDetailSkill>,
}

#[derive(Debug, Deserialize)]
struct ClawHubDetailSkill {
    #[serde(default)]
    slug: Option<String>,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    /// ClawHub puts the whole `SKILL.md` document in this field, front matter
    /// included — it is not a one-line description.
    #[serde(default)]
    description: Option<String>,
}

impl ClawHubSource {
    pub fn builtin() -> Self {
        Self {
            id: "clawhub".to_string(),
            display_name: "ClawHub".to_string(),
            api_base: None,
        }
    }

    pub(crate) fn api_base(&self) -> String {
        self.api_base
            .clone()
            .or_else(|| std::env::var("CLAWHUB_API_URL").ok())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://clawhub.ai".to_string())
    }

    async fn detail_skill(
        &self,
        client: &reqwest::Client,
        slug: &str,
    ) -> Result<ClawHubDetailSkill> {
        let url = format!("{}/api/v1/skills/{slug}", self.api_base());
        let detail: ClawHubDetail = fetch_json(client, &url, "ClawHub skill detail").await?;
        detail
            .skill
            .ok_or_else(|| anyhow::anyhow!("ClawHub skill `{slug}` returned no payload"))
    }

    pub async fn install(&self, client: &reqwest::Client, id: &str) -> Result<InstallResult> {
        let slug = skills_catalog::slug_of(id);
        let skill = self.detail_skill(client, &slug).await?;
        let markdown = skill
            .description
            .filter(|d| !d.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("ClawHub skill `{slug}` has no SKILL.md body"))?;
        from_source::install_skill_md_text(&slug, &markdown).await
    }
}

impl CatalogSource for ClawHubSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Skill
    }

    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        // ClawHub paginates by opaque cursor, not offset, so a deep walk would be
        // hundreds of sequential requests. Pull one generous page and filter it
        // here; `limit` then trims to what the client asked for.
        const PAGE: usize = 200;
        let mut url = format!("{}/api/v1/skills?limit={PAGE}", self.api_base());
        if !q.query.trim().is_empty() {
            url.push_str(&format!(
                "&q={}",
                urlencoding::encode(q.query.trim()).into_owned()
            ));
        }
        let list: ClawHubList = fetch_json(client, &url, "ClawHub catalog").await?;
        let installed = skills_catalog::installed_slugs();
        let cards: Vec<SkillCard> = list
            .items
            .into_iter()
            .filter(|item| {
                // Filter locally too: `q` is best-effort upstream, so this keeps
                // results honest whether or not ClawHub applied it.
                let topics = item.topics.join(" ");
                matches_query(
                    &q.query,
                    &[
                        &item.slug,
                        item.display_name.as_deref().unwrap_or_default(),
                        item.summary.as_deref().unwrap_or_default(),
                        &topics,
                    ],
                )
            })
            .map(|item| {
                let installs = item.stats.installs.max(item.stats.downloads);
                let name = item
                    .display_name
                    .clone()
                    .filter(|n| !n.trim().is_empty())
                    .unwrap_or_else(|| humanize(&item.slug));
                card(
                    format!("clawhub/{}", item.slug),
                    "clawhub.ai",
                    item.slug.clone(),
                    name,
                    item.summary,
                    installs,
                    TRUST_COMMUNITY,
                    &installed,
                )
            })
            .collect();
        Ok(envelope(cards, q.limit))
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let slug = skills_catalog::slug_of(id);
        let skill = self.detail_skill(client, &slug).await?;
        let markdown = skill.description.clone().unwrap_or_default();
        let installed = skills_catalog::installed_slugs();
        let (front_description, _) = split_front_matter(&markdown);
        let name = skill
            .display_name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| humanize(&slug));
        let card = card(
            id,
            "clawhub.ai",
            skill.slug.clone().unwrap_or_else(|| slug.clone()),
            name,
            skill.summary.clone().or(front_description),
            0,
            TRUST_COMMUNITY,
            &installed,
        );
        Ok(detail_value(
            card,
            &markdown,
            format!("{}/skills/{slug}", self.api_base()),
            None,
        ))
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        Ok(skill_descriptor(&self.id, id))
    }
}

// ── LobeHub ──────────────────────────────────────────────────────────────────

/// **LobeHub**'s agent catalog. These are system-prompt agents rather than Agent
/// Skills, so each one is converted into a `SKILL.md` at fetch time: the agent's
/// `systemRole` becomes the body and its `meta` becomes the front matter.
///
/// The conversion is lossy by nature — an agent is a persona, a skill is a
/// procedure — so these are the least "native" entries in the Skills tab. They
/// are included because the catalog is large, well-described, and the conversion
/// is exactly what Hermes does with the same source.
#[derive(Clone)]
pub struct LobeHubSource {
    pub id: String,
    pub display_name: String,
    pub api_base: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LobeHubIndex {
    #[serde(default)]
    agents: Vec<LobeHubAgent>,
}

#[derive(Debug, Deserialize)]
struct LobeHubAgent {
    identifier: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    meta: LobeHubMeta,
}

#[derive(Debug, Default, Deserialize)]
struct LobeHubMeta {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    category: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LobeHubAgentDetail {
    #[serde(default)]
    meta: LobeHubMeta,
    #[serde(default)]
    config: LobeHubConfig,
}

#[derive(Debug, Default, Deserialize)]
struct LobeHubConfig {
    #[serde(rename = "systemRole", default)]
    system_role: Option<String>,
}

impl LobeHubSource {
    pub fn builtin() -> Self {
        Self {
            id: "lobehub".to_string(),
            display_name: "LobeHub".to_string(),
            api_base: None,
        }
    }

    pub(crate) fn api_base(&self) -> String {
        self.api_base
            .clone()
            .or_else(|| std::env::var("LOBEHUB_AGENTS_URL").ok())
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "https://chat-agents.lobehub.com".to_string())
    }

    /// Build a `SKILL.md` from a LobeHub agent.
    ///
    /// Front-matter values are single-quoted with inner quotes doubled, because a
    /// LobeHub description is free text that routinely contains `:` and `"` — both
    /// of which produce invalid YAML if interpolated raw.
    fn to_skill_md(identifier: &str, meta: &LobeHubMeta, system_role: &str) -> String {
        let description = meta
            .description
            .clone()
            .filter(|d| !d.trim().is_empty())
            .unwrap_or_else(|| format!("LobeHub agent `{identifier}`."));
        let quoted = format!("'{}'", description.replace('\'', "''"));
        let title = meta.title.clone().unwrap_or_else(|| humanize(identifier));
        format!(
            "---\nname: {identifier}\ndescription: {quoted}\n---\n\n# {title}\n\n{}\n",
            system_role.trim()
        )
    }

    async fn agent_detail(
        &self,
        client: &reqwest::Client,
        identifier: &str,
    ) -> Result<LobeHubAgentDetail> {
        let url = format!("{}/{identifier}.json", self.api_base());
        fetch_json(client, &url, "LobeHub agent").await
    }

    pub async fn install(&self, client: &reqwest::Client, id: &str) -> Result<InstallResult> {
        let identifier = skills_catalog::slug_of(id);
        let detail = self.agent_detail(client, &identifier).await?;
        let system_role = detail
            .config
            .system_role
            .clone()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("LobeHub agent `{identifier}` has no system prompt"))?;
        let markdown = Self::to_skill_md(&identifier, &detail.meta, &system_role);
        from_source::install_skill_md_text(&identifier, &markdown).await
    }
}

impl CatalogSource for LobeHubSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Skill
    }

    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let url = format!("{}/index.json", self.api_base());
        let index: LobeHubIndex = fetch_json(client, &url, "LobeHub agent index").await?;
        let installed = skills_catalog::installed_slugs();
        let cards: Vec<SkillCard> = index
            .agents
            .into_iter()
            .filter(|agent| {
                let tags = agent.meta.tags.join(" ");
                matches_query(
                    &q.query,
                    &[
                        &agent.identifier,
                        agent.meta.title.as_deref().unwrap_or_default(),
                        agent.meta.description.as_deref().unwrap_or_default(),
                        agent.meta.category.as_deref().unwrap_or_default(),
                        &tags,
                    ],
                )
            })
            .map(|agent| {
                let name = agent
                    .meta
                    .title
                    .clone()
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| humanize(&agent.identifier));
                card(
                    format!("lobehub/{}", agent.identifier),
                    agent
                        .author
                        .clone()
                        .unwrap_or_else(|| "lobehub".to_string()),
                    agent.identifier.clone(),
                    name,
                    agent.meta.description.clone(),
                    0,
                    TRUST_COMMUNITY,
                    &installed,
                )
            })
            .collect();
        Ok(envelope(cards, q.limit))
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let identifier = skills_catalog::slug_of(id);
        let detail = self.agent_detail(client, &identifier).await?;
        let system_role = detail.config.system_role.clone().unwrap_or_default();
        let markdown = Self::to_skill_md(&identifier, &detail.meta, &system_role);
        let installed = skills_catalog::installed_slugs();
        let name = detail
            .meta
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| humanize(&identifier));
        let card = card(
            id,
            "lobehub",
            &identifier,
            name,
            detail.meta.description.clone(),
            0,
            TRUST_COMMUNITY,
            &installed,
        );
        Ok(detail_value(
            card,
            &markdown,
            format!("https://lobehub.com/agent/{identifier}"),
            None,
        ))
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        Ok(skill_descriptor(&self.id, id))
    }
}

// ── the built-in tap set ─────────────────────────────────────────────────────

/// The vendor/community GitHub repos registered as built-in taps.
///
/// `(source id, display name, owner/repo, trust)`. Vendor-owned repos are
/// `"trusted"` because only that vendor can publish to them; an
/// anyone-can-PR list is `"community"` even when it is well curated.
pub(crate) const GITHUB_TAPS: &[(&str, &str, &str, &str)] = &[
    (
        "gh-anthropic",
        "Anthropic Skills",
        "anthropics/skills",
        TRUST_TRUSTED,
    ),
    ("gh-openai", "OpenAI Skills", "openai/skills", TRUST_TRUSTED),
    (
        "gh-huggingface",
        "Hugging Face Skills",
        "huggingface/skills",
        TRUST_TRUSTED,
    ),
    ("gh-nvidia", "NVIDIA Skills", "nvidia/skills", TRUST_TRUSTED),
    (
        "gh-minimax",
        "MiniMax Skills",
        "minimax-ai/cli",
        TRUST_TRUSTED,
    ),
    (
        "gh-voltagent",
        "Awesome Agent Skills",
        "voltagent/awesome-agent-skills",
        TRUST_COMMUNITY,
    ),
    ("gh-gstack", "gstack", "garrytan/gstack", TRUST_COMMUNITY),
];

/// Build every built-in GitHub tap source.
pub(crate) fn github_taps() -> Vec<GithubTapSource> {
    GITHUB_TAPS
        .iter()
        .map(|(id, name, repo, trust)| GithubTapSource::new(*id, *name, *repo, trust))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn humanize_titles_a_slug() {
        assert_eq!(humanize("pdf"), "Pdf");
        assert_eq!(humanize("frontend-design"), "Frontend Design");
        assert_eq!(humanize("web_artifacts_builder"), "Web Artifacts Builder");
    }

    #[test]
    fn matches_query_is_case_insensitive_and_empty_matches_all() {
        assert!(matches_query("", &["anything"]));
        assert!(matches_query("PDF", &["skills/pdf"]));
        assert!(!matches_query("xlsx", &["skills/pdf"]));
    }

    #[test]
    fn split_front_matter_extracts_description_and_body() {
        let md = "---\nname: pdf\ndescription: Work with PDF files\n---\n\n# PDF\n\nBody.\n";
        let (description, body) = split_front_matter(md);
        assert_eq!(description.as_deref(), Some("Work with PDF files"));
        assert!(body.unwrap().starts_with("# PDF"));
    }

    #[test]
    fn split_front_matter_tolerates_missing_front_matter() {
        let (description, body) = split_front_matter("# Just a doc\n");
        assert!(description.is_none());
        assert_eq!(body.as_deref(), Some("# Just a doc\n"));
    }

    #[test]
    fn split_front_matter_strips_quotes_from_description() {
        let md = "---\ndescription: \"Quoted text\"\n---\nBody";
        assert_eq!(split_front_matter(md).0.as_deref(), Some("Quoted text"));
    }

    #[test]
    fn tap_id_is_owner_repo_leaf() {
        let tap = GithubTapSource::new("gh-anthropic", "Anthropic", "anthropics/skills", "trusted");
        assert_eq!(tap.id_for("skills/pdf"), "anthropics/skills/pdf");
        assert_eq!(
            tap.install_source("skills/pdf"),
            "https://github.com/anthropics/skills/tree/HEAD/skills/pdf"
        );
    }

    #[test]
    fn root_skill_uses_repo_name_and_repo_source() {
        let tap = GithubTapSource::new("gh-unlazy", "Unlazy", "Leonxlnx/unlazy", "trusted");
        assert_eq!(tap.id_for(ROOT_SKILL_PATH), "Leonxlnx/unlazy/unlazy");
        assert_eq!(
            tap.raw_url(ROOT_SKILL_PATH),
            "https://raw.githubusercontent.com/Leonxlnx/unlazy/HEAD/SKILL.md"
        );
        assert_eq!(
            tap.install_source(ROOT_SKILL_PATH),
            "https://github.com/Leonxlnx/unlazy"
        );
    }

    #[test]
    fn root_skill_blob_is_a_pack_member() {
        assert_eq!(
            skill_dir_from_blob_path("SKILL.md"),
            Some(ROOT_SKILL_PATH.into())
        );
        assert_eq!(skill_dir_from_blob_path("references/method.md"), None);
        assert_eq!(
            skill_dir_from_blob_path("skills/pdf/SKILL.md"),
            Some("skills/pdf".into())
        );
    }

    #[test]
    fn well_known_url_detection_and_base_normalization() {
        assert!(WellKnownSource::is_well_known_url(
            "https://mintlify.com/docs/.well-known/skills/index.json"
        ));
        assert!(!WellKnownSource::is_well_known_url(
            "https://github.com/owner/repo"
        ));
        assert_eq!(
            WellKnownSource::base_from_url(
                "https://mintlify.com/docs/.well-known/skills/index.json"
            ),
            "https://mintlify.com/docs"
        );
        assert_eq!(
            WellKnownSource::base_from_url("https://example.com/site/"),
            "https://example.com/site"
        );
    }

    #[test]
    fn well_known_builds_index_and_skill_urls() {
        let source = WellKnownSource::new("wk", "Example", "https://example.com/docs/");
        assert_eq!(
            source.index_url(),
            "https://example.com/docs/.well-known/skills/index.json"
        );
        assert_eq!(
            source.skill_md_url("search"),
            "https://example.com/docs/search/SKILL.md"
        );
        assert_eq!(source.host(), "example.com");
    }

    #[test]
    fn lobehub_conversion_escapes_yaml_hostile_descriptions() {
        let meta = LobeHubMeta {
            title: Some("Turtle Soup".to_string()),
            // Both a colon and an apostrophe: raw interpolation would be invalid YAML.
            description: Some("A host: it's tricky".to_string()),
            tags: vec![],
            category: None,
        };
        let md = LobeHubSource::to_skill_md("lateral-thinking", &meta, "You are a host.");
        assert!(md.starts_with("---\nname: lateral-thinking\n"));
        assert!(md.contains("description: 'A host: it''s tricky'"));
        assert!(md.trim_end().ends_with("You are a host."));
        // Round-trips through the same parser the detail path uses.
        let (description, _) = split_front_matter(&md);
        assert!(description.is_some());
    }

    #[test]
    fn every_builtin_tap_has_a_unique_id_and_owner_repo() {
        let taps = github_taps();
        let mut ids: Vec<&str> = taps.iter().map(|t| t.id.as_str()).collect();
        ids.sort_unstable();
        let count = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate tap id");
        for tap in &taps {
            assert_eq!(
                tap.repo.split('/').count(),
                2,
                "tap `{}` repo must be owner/repo, got `{}`",
                tap.id,
                tap.repo
            );
        }
    }

    // ── live smoke tests ─────────────────────────────────────────────────────
    //
    // `#[ignore]` so the normal suite stays offline and deterministic. These are
    // the only check that each adapter's field names still match what the
    // registry actually serves — a unit test over a hand-written fixture cannot
    // catch an upstream rename, and every one of these APIs is undocumented and
    // free to change without notice. Run them when touching this module:
    //
    //   cargo test -p ryu-core --bin ryu-core skill_registries -- --ignored
    //
    // A failure here means the registry changed, not that the code regressed.

    fn client() -> reqwest::Client {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(45))
            .build()
            .expect("http client")
    }

    fn query(q: &str, limit: usize) -> CatalogQuery {
        CatalogQuery {
            query: q.to_string(),
            limit,
            ..Default::default()
        }
    }

    /// Assert a search envelope carried usable cards.
    fn assert_cards(value: &Value, who: &str) -> Vec<Value> {
        let cards = value["skills"]
            .as_array()
            .unwrap_or_else(|| panic!("{who}: no `skills` array in {value}"))
            .clone();
        assert!(!cards.is_empty(), "{who}: search returned zero cards");
        for card in &cards {
            assert!(
                card["id"].as_str().is_some_and(|s| !s.is_empty()),
                "{who}: card without an id: {card}"
            );
            assert!(
                card["name"].as_str().is_some_and(|s| !s.is_empty()),
                "{who}: card without a name: {card}"
            );
            assert!(
                card["trust_level"].as_str().is_some(),
                "{who}: card without a trust level: {card}"
            );
        }
        cards
    }

    #[tokio::test]
    #[ignore = "network"]
    async fn live_github_tap_lists_and_details_anthropic_document_skills() {
        let tap = GithubTapSource::new(
            "gh-anthropic",
            "Anthropic Skills",
            "anthropics/skills",
            TRUST_TRUSTED,
        );
        let client = client();
        let value = tap.search(&client, &query("", 200)).await.expect("search");
        let cards = assert_cards(&value, "anthropics/skills");

        // The five the Skills tab is expected to surface.
        let ids: Vec<&str> = cards.iter().filter_map(|c| c["id"].as_str()).collect();
        for want in ["pdf", "xlsx", "pptx", "docx", "frontend-design"] {
            assert!(
                ids.contains(&format!("anthropics/skills/{want}").as_str()),
                "missing `{want}` in {ids:?}"
            );
        }

        // Detail must resolve the id back to a real SKILL.md.
        let detail = tap
            .detail(&client, "anthropics/skills/pdf")
            .await
            .expect("detail");
        assert_eq!(detail["card"]["trust_level"], TRUST_TRUSTED);
        let readme = detail["readme"].as_str().unwrap_or_default();
        assert!(!readme.trim().is_empty(), "pdf SKILL.md body was empty");
        assert!(
            detail["description"].as_str().is_some(),
            "pdf SKILL.md had no front-matter description"
        );
    }

    #[tokio::test]
    #[ignore = "network"]
    async fn live_browse_sh_lists_and_serves_markdown() {
        let source = BrowseShSource::builtin();
        let client = client();
        let value = source
            .search(&client, &query("", 25))
            .await
            .expect("search");
        let cards = assert_cards(&value, "browse.sh");

        let id = cards[0]["id"].as_str().expect("id").to_string();
        let detail = source.detail(&client, &id).await.expect("detail");
        assert!(
            !detail["files"][0]["contents"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .is_empty(),
            "browse.sh served an empty SKILL.md for {id}"
        );
    }

    #[tokio::test]
    #[ignore = "network"]
    async fn live_clawhub_lists_and_detail_carries_the_skill_md() {
        let source = ClawHubSource::builtin();
        let client = client();
        let value = source
            .search(&client, &query("", 25))
            .await
            .expect("search");
        let cards = assert_cards(&value, "clawhub");
        for card in &cards {
            assert_eq!(
                card["trust_level"], TRUST_COMMUNITY,
                "ClawHub must never emit a non-community trust level"
            );
        }

        let slug = cards[0]["slug"].as_str().expect("slug").to_string();
        let skill = source.detail_skill(&client, &slug).await.expect("detail");
        assert!(
            skill
                .description
                .as_deref()
                .is_some_and(|d| !d.trim().is_empty()),
            "ClawHub detail for `{slug}` carried no SKILL.md body"
        );
    }

    #[tokio::test]
    #[ignore = "network"]
    async fn live_lobehub_index_and_agent_convert_to_a_skill() {
        let source = LobeHubSource::builtin();
        let client = client();
        let value = source
            .search(&client, &query("", 25))
            .await
            .expect("search");
        let cards = assert_cards(&value, "lobehub");

        let id = cards[0]["id"].as_str().expect("id").to_string();
        let detail = source.detail(&client, &id).await.expect("detail");
        let markdown = detail["files"][0]["contents"].as_str().unwrap_or_default();
        assert!(
            markdown.starts_with("---\nname: "),
            "converted agent is not a SKILL.md: {markdown:.80}"
        );
        // The conversion must survive the parser the detail path uses.
        assert!(split_front_matter(markdown).0.is_some());
    }

    #[tokio::test]
    #[ignore = "network"]
    async fn live_well_known_reads_a_published_index() {
        // Mintlify publishes the discovery protocol at its docs base. The guarded
        // fetch follows no redirects, so this is the canonical host (the bare
        // `mintlify.com` answers 307 to `www.mintlify.com`).
        let source =
            WellKnownSource::new("wk-mintlify", "Mintlify", "https://www.mintlify.com/docs");
        let client = client();
        let value = source
            .search(&client, &query("", 25))
            .await
            .expect("search");
        assert_cards(&value, "well-known");
    }

    #[test]
    fn envelope_applies_the_limit() {
        let installed = std::collections::HashSet::new();
        let cards: Vec<SkillCard> = (0..10)
            .map(|i| {
                card(
                    format!("o/r/s{i}"),
                    "o/r",
                    format!("s{i}"),
                    "S",
                    None,
                    0,
                    TRUST_COMMUNITY,
                    &installed,
                )
            })
            .collect();
        let value = envelope(cards, 3);
        assert_eq!(value["skills"].as_array().unwrap().len(), 3);
    }
}
