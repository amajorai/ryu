//! The **CatalogSource seam** (#459): one adapter every catalog — model, skill,
//! MCP, plugin, knowledge, agent — routes through.
//!
//! The design rule (Core vs Gateway): a *source* only returns **descriptors**
//! of what could be installed. Core keeps the privileged install path
//! (download → checksum-verify → record provenance). The types here *enforce*
//! that split: `install_descriptor` hands back an [`InstallDescriptor`], it
//! never downloads. Swapping the source for a kind (e.g. Hugging Face →
//! ModelScope, or a custom HF-compatible mirror) is a config/registry change,
//! never a code change — "nothing hardcoded".
//!
//! No `async-trait` dependency is used: the trait declares native `async fn`
//! methods (not object-safe), and heterogeneous storage is done via the closed
//! [`sources::Source`] enum, match-dispatched. See `sources.rs`.

pub(crate) mod agent_registry;
mod github_enrich;
mod github_topic;
pub(crate) mod license;
pub(crate) mod manifest_surface;
mod registry;
pub(crate) mod skill_registries;
pub(crate) mod sources;

pub use github_topic::{
    GithubTopicSource, COMMUNITY_ORIGIN, GITHUB_TOKEN_PREF, GITHUB_TOPIC_SOURCE_ID,
};

/// Default GitHub REST base for repo enrichment. Fixed (not configurable) so a
/// BYOK token can never be sent to a host the user did not intend — the same rule
/// [`GithubTopicSource`] applies to its own token.
const GITHUB_API_BASE: &str = "https://api.github.com";

/// Split a GitHub repo reference into `(owner, repo)`.
///
/// Accepts the forms a marketplace listing actually carries: a bare `owner/repo`
/// slug, an `https://github.com/owner/repo` URL (with or without a trailing
/// `.git`/path), and the `git@github.com:owner/repo` SSH form. Returns `None` for
/// anything else — including a non-GitHub host, because the enrichment below only
/// speaks the GitHub REST API and pointing it at another host would leak the token.
pub fn split_github_repo(reference: &str) -> Option<(String, String)> {
    let trimmed = reference.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Reduce every accepted form to a `owner/repo[/…]` path.
    let path = if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        rest
    } else {
        let without_scheme = trimmed
            .strip_prefix("https://")
            .or_else(|| trimmed.strip_prefix("http://"))
            .unwrap_or(trimmed);
        match without_scheme.strip_prefix("github.com/") {
            Some(rest) => rest,
            None => {
                // A scheme we did not recognize, or an absolute filesystem path —
                // neither is a GitHub repo, and an absolute path would otherwise
                // parse as a slug (`/local/path` → `local/path`).
                if without_scheme.contains("://") || without_scheme.starts_with('/') {
                    return None;
                }
                // A bare `owner/repo` slug. GitHub owner names are alphanumerics and
                // hyphens only, so a dot in the FIRST segment means this is a
                // hostname for another forge, not an owner. A dot in a LATER segment
                // is a legitimate repo name (`vercel/next.js`), so the check must be
                // first-segment-only rather than "contains a dot anywhere".
                if without_scheme
                    .split('/')
                    .next()
                    .is_some_and(|s| s.contains('.'))
                {
                    return None;
                }
                without_scheme
            }
        }
    };
    let mut parts = path.split('/').filter(|s| !s.is_empty());
    let owner = parts.next()?;
    let repo = parts.next()?.trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// Repo enrichment (README, release/tag history, stars, timestamps) for any listing
/// that names a GitHub repository — not just the Community feed.
///
/// The first-party catalogs ship the manifest's own fields and nothing else, so a
/// listing there rendered a detail page with a single Overview tab while a Community
/// listing (which goes through [`GithubTopicSource::detail`]) got README / Versions /
/// Health. Same repositories, different depth of page, for no reason the user can
/// see. This exposes the identical, cached, best-effort fetch to the first-party
/// path so the tab set is a property of the LISTING, not of which feed found it.
///
/// `cache_id` keys the shared enrichment cache — pass the catalog entry id so two
/// listings never share an entry. Returns an empty object when `repo_reference` is
/// not a GitHub repo or GitHub is unreachable: never fatal, by contract.
pub async fn enrich_github_repo(
    cache_id: &str,
    repo_reference: &str,
    token: Option<&str>,
) -> serde_json::Value {
    let Some((owner, repo)) = split_github_repo(repo_reference) else {
        return serde_json::Value::Object(serde_json::Map::new());
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        headers.push(("Authorization".to_string(), format!("Bearer {token}")));
    }
    github_enrich::enrich_repo(cache_id, GITHUB_API_BASE, &headers, &owner, &repo).await
}

/// The detail payload for ONE published version of a listing, read from its repo
/// at that version's tag.
///
/// Only signals that live IN THE REPOSITORY are returned — README, licence,
/// description, engines, surfaces, declared permissions. Repository health (stars,
/// open issues, archived, last-updated) is current-state and is deliberately
/// omitted rather than filled with today's numbers: a per-version card that
/// silently mixes "as of that tag" with "as of now" reads as authoritative and is
/// not. Returns `None` for a non-GitHub reference or a tag with no readable
/// manifest, which is normal for tags predating packaging.
pub async fn github_version_detail(repo_reference: &str, tag: &str) -> Option<serde_json::Value> {
    let (owner, repo) = split_github_repo(repo_reference)?;
    github_enrich::version_detail(&owner, &repo, tag).await
}

/// Channels a listing publishes, each with the tag it currently resolves to.
///
/// Empty for a non-GitHub reference or a repo with no releases — the caller shows
/// no picker rather than an empty one.
pub async fn github_listing_channels(
    repo_reference: &str,
    token: Option<&str>,
) -> Vec<(String, String)> {
    let Some((owner, repo)) = split_github_repo(repo_reference) else {
        return Vec::new();
    };
    let mut headers: Vec<(String, String)> = Vec::new();
    if let Some(token) = token.map(str::trim).filter(|t| !t.is_empty()) {
        headers.push(("Authorization".to_string(), format!("Bearer {token}")));
    }
    github_enrich::listing_channels(GITHUB_API_BASE, &headers, &owner, &repo).await
}

pub use registry::{CatalogSourceRegistry, CustomSourceSpec, SourceMeta};
pub use sources::{
    integration_brand_slug, integrations_sh_brands, mark_cheapest_options, parse_provider_pins,
    rank_managed_providers, with_buyer_token, with_install_session, HfSource, IntegrationBrand,
    IntegrationConnection, IntegrationOption, IntegrationPrice, IntegrationsShSource,
    MarketplaceSource, ModelIndexSource, OfficialMcpSource, OkfBundleSource, RyuHostedMcpSource,
    RyuMarketplaceSource, SkillsShSource, SmitherySource, Source, SourceAuth, StubSource,
    INTEGRATION_PROVIDER_PINS_PREF, RYU_MARKETPLACE_API_ENV, SMITHERY_API_KEY_PREF,
};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// The six catalogs that share the seam. Serializes lowercase so
/// `?kind=model` round-trips through query params and the persistence key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CatalogKind {
    Model,
    Skill,
    Mcp,
    Plugin,
    /// Open Knowledge Format (OKF) bundles — git-shippable directories of
    /// markdown concepts, ingested into the retrieval layer on install.
    Knowledge,
    /// User-published **agent definitions**: the portable template
    /// [`crate::agents::AgentTemplate`] that `GET /api/agents/:id/export`
    /// already produces (instructions, model/engine preference, declared tool
    /// and skill dependencies). Installing one materialises a local agent
    /// through the SAME import path, after
    /// [`crate::agents::AgentTemplate::sanitize_for_untrusted_install`] strips
    /// everything that would bind the installer's credentials or widen a grant.
    ///
    /// Distinct from the desktop's "Agents" store tab, which lists ACP *runtime*
    /// agents (Claude Code, Codex) — those are engines, not definitions.
    Agent,
}

impl CatalogKind {
    /// Every kind, for registry iteration and the per-kind AC.
    pub const ALL: [CatalogKind; 6] = [
        CatalogKind::Model,
        CatalogKind::Skill,
        CatalogKind::Mcp,
        CatalogKind::Plugin,
        CatalogKind::Knowledge,
        CatalogKind::Agent,
    ];

    /// Lowercase wire form (also the persistence-key suffix).
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogKind::Model => "model",
            CatalogKind::Skill => "skill",
            CatalogKind::Mcp => "mcp",
            CatalogKind::Plugin => "plugin",
            CatalogKind::Knowledge => "knowledge",
            CatalogKind::Agent => "agent",
        }
    }
}

impl fmt::Display for CatalogKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for CatalogKind {
    type Err = anyhow::Error;
    fn from_str(s: &str) -> Result<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "model" => Ok(CatalogKind::Model),
            "skill" => Ok(CatalogKind::Skill),
            "mcp" => Ok(CatalogKind::Mcp),
            "plugin" => Ok(CatalogKind::Plugin),
            "knowledge" => Ok(CatalogKind::Knowledge),
            "agent" => Ok(CatalogKind::Agent),
            other => bail!("unknown catalog kind `{other}`"),
        }
    }
}

/// A normalized search request. Common fields are first-class; per-kind params
/// (HF `task`/`author`, future skill filters) ride along in `extra` so the
/// trait signature stays stable as kinds gain knobs.
#[derive(Debug, Clone, Default)]
pub struct CatalogQuery {
    pub query: String,
    pub limit: usize,
    pub cursor: Option<String>,
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl CatalogQuery {
    /// Read a string-valued `extra` param, defaulting to `""`.
    pub fn extra_str(&self, key: &str) -> &str {
        self.extra.get(key).and_then(|v| v.as_str()).unwrap_or("")
    }
}

/// A search `cursor` the source cannot have issued. Routes answer it with 400
/// (see `server::catalog_search_error_status`) instead of silently restarting
/// at the first page, matching the control plane's `/catalog` contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidCatalogCursor;

impl fmt::Display for InvalidCatalogCursor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("`cursor` must come from a previous `next_cursor`")
    }
}

impl std::error::Error for InvalidCatalogCursor {}

/// Largest page the Ryu Marketplace `/catalog` serves (`CATALOG_MAX_LIMIT` in
/// `packages/api/src/lib/marketplace-release.ts`).
pub const MARKETPLACE_CATALOG_MAX_LIMIT: usize = 100;
/// Deepest row offset the Marketplace `/catalog` accepts (`CATALOG_MAX_OFFSET`).
pub const MARKETPLACE_CATALOG_MAX_OFFSET: u64 = 5000;

/// Parse a Ryu Marketplace catalog cursor with the control plane's rules: the
/// cursor is opaque to clients but is a decimal row offset of at most nine
/// digits and at most [`MARKETPLACE_CATALOG_MAX_OFFSET`]. Absent or blank means
/// the first page.
pub fn parse_marketplace_cursor(
    raw: Option<&str>,
) -> std::result::Result<Option<u64>, InvalidCatalogCursor> {
    let raw = raw.map(str::trim).unwrap_or_default();
    if raw.is_empty() {
        return Ok(None);
    }
    if raw.len() > 9 || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(InvalidCatalogCursor);
    }
    let offset: u64 = raw.parse().map_err(|_| InvalidCatalogCursor)?;
    if offset > MARKETPLACE_CATALOG_MAX_OFFSET {
        return Err(InvalidCatalogCursor);
    }
    Ok(Some(offset))
}

/// One downloadable artifact a source points Core at. The source supplies the
/// URL (+ optional checksum); Core does the verified download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DescriptorFile {
    pub url: String,
    pub sha256: Option<String>,
    pub dest_filename: String,
}

/// The source → Core install handoff: *what* to install, never the install
/// itself. Generic across kinds (`files` may be empty for non-file kinds;
/// `raw` carries the source's native payload for richer kinds later).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallDescriptor {
    pub kind: CatalogKind,
    pub source_id: String,
    pub repo_id: String,
    pub files: Vec<DescriptorFile>,
    pub raw: serde_json::Value,
}

/// The seam every catalog routes through. A source resolves descriptors; it
/// must **not** download or mutate local state (that is Core's privileged
/// install path). Methods use native `async fn` — see the module note on why
/// there is no `dyn` / `async-trait`.
pub trait CatalogSource {
    /// Stable, machine id for this source (e.g. `"huggingface"`).
    fn id(&self) -> &str;
    /// Human-facing name for the source picker.
    fn display_name(&self) -> &str;
    /// Which catalog this source serves.
    fn kind(&self) -> CatalogKind;

    /// Search the upstream catalog, returning a source-shaped JSON page.
    async fn search(
        &self,
        client: &reqwest::Client,
        query: &CatalogQuery,
    ) -> Result<serde_json::Value>;

    /// Fetch a single item's detail payload.
    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<serde_json::Value>;

    /// Resolve *what to install* for `id` — a descriptor, never a download.
    async fn install_descriptor(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_kind_as_str_and_display_agree_and_cover_all() {
        for k in CatalogKind::ALL {
            // Display delegates to as_str, so the two must be byte-identical.
            assert_eq!(k.to_string(), k.as_str());
            // Every wire form round-trips back through FromStr.
            assert_eq!(k.as_str().parse::<CatalogKind>().unwrap(), k);
        }
        assert_eq!(CatalogKind::ALL.len(), 6);
    }

    #[test]
    fn catalog_kind_from_str_is_trimmed_case_insensitive() {
        assert_eq!(
            "  MODEL ".parse::<CatalogKind>().unwrap(),
            CatalogKind::Model
        );
        assert_eq!("Skill".parse::<CatalogKind>().unwrap(), CatalogKind::Skill);
        assert_eq!(
            "knowledge".parse::<CatalogKind>().unwrap(),
            CatalogKind::Knowledge
        );
        assert_eq!("agent".parse::<CatalogKind>().unwrap(), CatalogKind::Agent);
        // An unknown kind errors (not a silent default) and names the offender.
        let err = "wat".parse::<CatalogKind>().unwrap_err().to_string();
        assert!(err.contains("wat"), "error should name the bad kind: {err}");
    }

    #[test]
    fn catalog_kind_serde_is_lowercase() {
        assert_eq!(serde_json::to_string(&CatalogKind::Mcp).unwrap(), "\"mcp\"");
        let k: CatalogKind = serde_json::from_str("\"plugin\"").unwrap();
        assert_eq!(k, CatalogKind::Plugin);
    }

    #[test]
    fn split_github_repo_accepts_every_form_a_listing_carries() {
        for reference in [
            "amajorai/ryu-marketplace",
            "https://github.com/amajorai/ryu-marketplace",
            "http://github.com/amajorai/ryu-marketplace",
            "https://github.com/amajorai/ryu-marketplace.git",
            "git@github.com:amajorai/ryu-marketplace.git",
            // A deep path (the install_source of a plugin inside the repo) still
            // resolves to the repo it lives in — that is what gets enriched.
            "https://github.com/amajorai/ryu-marketplace/tree/main/plugins/browser",
            "  amajorai/ryu-marketplace  ",
        ] {
            assert_eq!(
                split_github_repo(reference),
                Some(("amajorai".to_string(), "ryu-marketplace".to_string())),
                "should resolve `{reference}`"
            );
        }
    }

    /// A dot is only a "this is another forge's hostname" signal in the FIRST
    /// segment; plenty of real repositories have one in their name.
    #[test]
    fn split_github_repo_keeps_a_dotted_repo_name() {
        assert_eq!(
            split_github_repo("vercel/next.js"),
            Some(("vercel".to_string(), "next.js".to_string()))
        );
    }

    /// The enrichment call sends a BYOK GitHub token, so anything that is not a
    /// github.com repo must resolve to `None` rather than being treated as a slug —
    /// otherwise a listing could name another host and receive the token.
    #[test]
    fn split_github_repo_rejects_non_github_and_incomplete_references() {
        for reference in [
            "",
            "   ",
            "amajorai",
            "https://gitlab.com/amajorai/ryu-marketplace",
            "https://evil.example.com/amajorai/ryu-marketplace",
            "git@gitlab.com:amajorai/ryu-marketplace.git",
            "ssh://github.com.evil.test/a/b",
            "/local/path",
        ] {
            assert_eq!(
                split_github_repo(reference),
                None,
                "should reject `{reference}`"
            );
        }
    }

    #[tokio::test]
    async fn enrich_github_repo_is_empty_for_a_non_github_reference() {
        // No network call is made at all for a reference that cannot be split, so
        // this stays a pure unit test while pinning the never-fatal contract.
        let value = enrich_github_repo("cache-key", "https://gitlab.com/a/b", None).await;
        assert_eq!(value, serde_json::json!({}));
    }

    #[test]
    fn catalog_query_extra_str_reads_or_defaults_empty() {
        let mut q = CatalogQuery::default();
        assert_eq!(q.extra_str("task"), "", "absent key defaults to empty");
        q.extra
            .insert("task".into(), serde_json::json!("text-generation"));
        assert_eq!(q.extra_str("task"), "text-generation");
        // A non-string value is treated as absent (empty), never panics.
        q.extra.insert("n".into(), serde_json::json!(42));
        assert_eq!(q.extra_str("n"), "");
    }
}
