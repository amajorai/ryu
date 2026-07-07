//! The **CatalogSource seam** (#459): one adapter every catalog — model, skill,
//! MCP, plugin — routes through.
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

mod registry;
mod sources;

pub use registry::{CatalogSourceRegistry, CustomSourceSpec, SourceMeta};
pub use sources::{
    with_buyer_token, HfSource, IntegrationsShSource, MarketplaceSource, ModelIndexSource,
    OfficialMcpSource, OkfBundleSource, RyuHostedMcpSource, RyuMarketplaceSource, SkillsShSource,
    SmitherySource, Source, StubSource, RYU_MARKETPLACE_API_ENV, SMITHERY_API_KEY_PREF,
};

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// The five catalogs that share the seam. Serializes lowercase so
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
}

impl CatalogKind {
    /// Every kind, for registry iteration and the per-kind AC.
    pub const ALL: [CatalogKind; 5] = [
        CatalogKind::Model,
        CatalogKind::Skill,
        CatalogKind::Mcp,
        CatalogKind::Plugin,
        CatalogKind::Knowledge,
    ];

    /// Lowercase wire form (also the persistence-key suffix).
    pub fn as_str(&self) -> &'static str {
        match self {
            CatalogKind::Model => "model",
            CatalogKind::Skill => "skill",
            CatalogKind::Mcp => "mcp",
            CatalogKind::Plugin => "plugin",
            CatalogKind::Knowledge => "knowledge",
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
