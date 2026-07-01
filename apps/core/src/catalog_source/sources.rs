//! Concrete [`CatalogSource`] implementations and their enum-dispatch wrapper.
//!
//! Dispatch design: the project has no `async-trait` dep, so a trait with
//! native `async fn` methods is *not* object-safe (`Box<dyn CatalogSource>`
//! won't compile). Instead we store sources heterogeneously in a small closed
//! [`Source`] enum and match-dispatch each call. Custom model sources collapse
//! into `Hf` with a `base_url` override — no new variant needed.

use anyhow::{bail, Result};
use serde_json::Value;

use super::{CatalogKind, CatalogQuery, CatalogSource, DescriptorFile, InstallDescriptor};
use crate::model_catalog::HfEndpoint;

/// The Hugging Face model source (also the shape custom HF-compatible model
/// sources reuse via `base_url`). search/detail delegate to the existing
/// `model_catalog` helpers; `install_descriptor` returns a handoff pointing at
/// the HF resolve URL — it never downloads (Core owns the privileged install).
#[derive(Clone)]
pub struct HfSource {
    /// Stable source id (e.g. `"huggingface"` for the builtin, or a custom id).
    pub id: String,
    /// Human-facing name shown in the source picker.
    pub display_name: String,
    /// Optional HF-compatible API base override for custom sources. `None` =
    /// the builtin default host wired into `model_catalog`. Full custom fetch
    /// is the next unit (#460); for now this rides on the descriptor `raw`.
    pub base_url: Option<String>,
}

impl HfSource {
    /// The builtin Hugging Face source (the default active model source).
    pub fn builtin() -> Self {
        Self {
            id: "huggingface".to_string(),
            display_name: "Hugging Face".to_string(),
            base_url: None,
        }
    }

    /// The builtin ModelScope source — a second, HF-compatible model source
    /// proving the seam carries more than one endpoint (#460). Its `base_url`
    /// records the ModelScope API base so the listing shows where it points.
    pub fn modelscope() -> Self {
        Self {
            id: "modelscope".to_string(),
            display_name: "ModelScope".to_string(),
            base_url: Some(HfEndpoint::modelscope().api_base),
        }
    }

    /// Resolve this source's HTTP endpoint: the builtin HF host when no
    /// `base_url` override is set, the ModelScope endpoint for the builtin
    /// ModelScope id, else a custom HF-compatible base URL.
    pub fn endpoint(&self) -> HfEndpoint {
        match &self.base_url {
            None => HfEndpoint::huggingface(),
            Some(base) if self.id == "modelscope" => {
                // Builtin ModelScope: use the dedicated constructor so host +
                // api_base stay paired even though only api_base is recorded.
                let _ = base;
                HfEndpoint::modelscope()
            }
            Some(base) => HfEndpoint::from_base_url(base),
        }
    }
}

impl CatalogSource for HfSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Model
    }

    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        // Per-kind params ride in `extra`: HF understands `task`, `author`, and
        // the weight `format` facet (defaults to GGUF).
        let task = q.extra_str("task");
        let author = q.extra_str("author");
        let sort = crate::model_catalog::CatalogSort::parse(q.extra_str("sort"));
        let format = crate::model_format::ModelFormat::from_wire(q.extra_str("format"));
        crate::model_catalog::search_models_json(
            client,
            &self.endpoint(),
            &q.query,
            sort,
            format,
            q.limit,
            false,
            task,
            author,
            q.cursor.as_deref().filter(|s| !s.is_empty()),
        )
        .await
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        // The federated detail path stays GGUF (seam snapshots are out of scope);
        // the main /api/models route carries the format facet for snapshots.
        crate::model_catalog::model_detail_json(
            client,
            &self.endpoint(),
            id,
            crate::model_format::ModelFormat::Gguf,
        )
        .await
    }

    async fn install_descriptor(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        // Source returns a descriptor only — Core performs the verified install.
        // Reuse the public detail (it already builds `resolve/main` file URLs)
        // and normalize its `files` array into descriptor files.
        let detail = self.detail(client, id).await?;
        let mut files = Vec::new();
        if let Some(arr) = detail.get("files").and_then(|f| f.as_array()) {
            for f in arr {
                let Some(url) = f.get("url").and_then(|u| u.as_str()) else {
                    continue;
                };
                let dest = f
                    .get("rfilename")
                    .or_else(|| f.get("filename"))
                    .and_then(|n| n.as_str())
                    .map(str::to_string)
                    .unwrap_or_else(|| url.rsplit('/').next().unwrap_or(url).to_string());
                let sha256 = f
                    .get("sha256")
                    .and_then(|s| s.as_str())
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                files.push(DescriptorFile {
                    url: url.to_string(),
                    sha256,
                    dest_filename: dest,
                });
            }
        }
        Ok(InstallDescriptor {
            kind: CatalogKind::Model,
            source_id: self.id.clone(),
            repo_id: id.to_string(),
            files,
            raw: detail,
        })
    }
}

/// A generic Ryu **model-index** source (#461). Unlike [`HfSource`] (which
/// talks the Hugging Face Hub API), this source points at a single JSON URL
/// that returns a flat list of downloadable GGUF entries:
///
/// ```json
/// [ { "name": "model-Q4_K_M.gguf", "download_url": "https://…/model.gguf",
///     "sha": "<hex-sha256>", "size": 3221225472 } ]
/// ```
///
/// The index is fetched + parsed; entries are mapped into the same
/// [`crate::model_catalog::ModelCard`] / `GgufFile`-shaped JSON the desktop
/// already renders, so no client change is needed. `install_descriptor`
/// returns one [`DescriptorFile`] per entry pointing at `download_url` (with
/// `sha`); Core performs the verified download. The source never downloads.
///
/// Discrimination from an HF-compatible base: a custom Model source whose
/// `base_url` ends in `.json` is wired as a `ModelIndex`; any other base is an
/// HF-compatible endpoint (see `registry.rs`).
#[derive(Clone)]
pub struct ModelIndexSource {
    pub id: String,
    pub display_name: String,
    /// The HTTPS URL returning the model-index JSON array.
    pub index_url: String,
}

/// One parsed entry from a model-index JSON document.
#[derive(Debug, Clone, serde::Deserialize)]
struct IndexEntry {
    /// File name (also the install destination + the entry id). Required.
    name: String,
    /// Direct HTTPS download URL for the GGUF. Required.
    download_url: String,
    /// Expected SHA-256 (hex). Optional; empty disables verification.
    #[serde(default)]
    sha: Option<String>,
    /// Size in bytes, when the index publishes it. Optional.
    #[serde(default)]
    size: Option<u64>,
}

impl ModelIndexSource {
    /// Fetch + parse the index JSON into entries. Surfaces a clear error on an
    /// unreachable URL, a non-2xx status, or a malformed body (AC3: never panic).
    async fn fetch_entries(&self, _client: &reqwest::Client) -> Result<Vec<IndexEntry>> {
        // The index URL is user-supplied (custom source / startup load), so it
        // must be SSRF-guarded at fetch time, not just add-time: resolve + screen
        // IPs, pin the client, disable redirects. (The passed `client` is unused;
        // the guard builds its own pinned client.)
        let body = crate::server::guarded_get_bytes(&self.index_url)
            .await
            .map_err(|e| anyhow::anyhow!("fetching model index {}: {e}", self.index_url))?;
        parse_index(&body)
            .map_err(|e| anyhow::anyhow!("parsing model index {}: {e}", self.index_url))
    }

    /// Build the descriptor for a single resolved entry (shared by
    /// `install_descriptor` and the focused test).
    fn entry_to_descriptor(&self, entry: &IndexEntry) -> InstallDescriptor {
        let sha256 = entry
            .sha
            .as_deref()
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        InstallDescriptor {
            kind: CatalogKind::Model,
            source_id: self.id.clone(),
            repo_id: entry.name.clone(),
            files: vec![DescriptorFile {
                url: entry.download_url.clone(),
                sha256,
                dest_filename: entry.name.clone(),
            }],
            raw: self.entry_to_detail(entry),
        }
    }

    /// Map one index entry into the model-card / GGUF-file JSON shape the desktop
    /// catalog already renders (`model_catalog::ModelCard` + `GgufFile` fields),
    /// so a model-index source needs zero client changes.
    fn entry_to_detail(&self, entry: &IndexEntry) -> Value {
        let size_human = entry
            .size
            .map(crate::model_catalog::device::human_bytes)
            .unwrap_or_default();
        serde_json::json!({
            "card": {
                "id": entry.name,
                "author": self.display_name,
                "name": entry.name,
                "downloads": 0,
                "likes": 0,
                "pipeline_tag": serde_json::Value::Null,
                "tags": [],
                "gated": false,
                "last_modified": serde_json::Value::Null,
                "created_at": serde_json::Value::Null,
                "installed": false,
            },
            "readme": serde_json::Value::Null,
            "files": [{
                "filename": entry.name,
                "quant": serde_json::Value::Null,
                "size_bytes": entry.size,
                "size_human": size_human,
                "sha256": entry.sha,
                "url": entry.download_url,
                "installed": false,
                "fit": "unknown",
                "fit_label": "",
            }],
            "stats": serde_json::Value::Null,
            "stats_api_key_present": false,
        })
    }
}

impl CatalogSource for ModelIndexSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Model
    }

    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let entries = self.fetch_entries(client).await?;
        let needle = q.query.trim().to_lowercase();
        let cards: Vec<Value> = entries
            .iter()
            .filter(|e| needle.is_empty() || e.name.to_lowercase().contains(&needle))
            .take(if q.limit == 0 { usize::MAX } else { q.limit })
            .map(|e| {
                serde_json::json!({
                    "id": e.name,
                    "author": self.display_name,
                    "name": e.name,
                    "downloads": 0,
                    "likes": 0,
                    "pipeline_tag": serde_json::Value::Null,
                    "tags": [],
                    "gated": false,
                    "last_modified": serde_json::Value::Null,
                    "created_at": serde_json::Value::Null,
                    "installed": false,
                })
            })
            .collect();
        // Same `{ models, next_cursor }` envelope as the HF list path. The index
        // is a single flat document, so there is no pagination cursor.
        Ok(serde_json::json!({ "models": cards, "next_cursor": serde_json::Value::Null }))
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let entries = self.fetch_entries(client).await?;
        let entry = entries
            .iter()
            .find(|e| e.name == id)
            .ok_or_else(|| anyhow::anyhow!("model `{id}` not found in index {}", self.index_url))?;
        Ok(self.entry_to_detail(entry))
    }

    async fn install_descriptor(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        let entries = self.fetch_entries(client).await?;
        let entry = entries
            .iter()
            .find(|e| e.name == id)
            .ok_or_else(|| anyhow::anyhow!("model `{id}` not found in index {}", self.index_url))?;
        // Source returns a descriptor only — Core performs the verified install.
        Ok(self.entry_to_descriptor(entry))
    }
}

/// Parse a model-index JSON document (a flat array of entries) from raw bytes.
fn parse_index(bytes: &[u8]) -> Result<Vec<IndexEntry>> {
    Ok(serde_json::from_slice(bytes)?)
}

/// The built-in **skills.sh** source (#463): the primary Skill source. Its
/// search/detail delegate to the existing [`crate::skills_catalog`] helpers
/// (the public, no-key skills.sh directory), and install (handled in the route
/// via [`Source::install_skill`]) reuses `skills_catalog::install_skill`.
///
/// `install_descriptor` here is a thin no-file handoff: skills are not a single
/// checksummed file download (they write a directory tree), so the descriptor
/// carries `files: []` and stashes the skill id in `repo_id`; Core's
/// source-aware skill-install route resolves the real install path.
#[derive(Clone)]
pub struct SkillsShSource {
    pub id: String,
    pub display_name: String,
}

impl SkillsShSource {
    /// The builtin skills.sh source (the default active Skill source).
    pub fn builtin() -> Self {
        Self {
            id: "skills-sh".to_string(),
            display_name: "skills.sh".to_string(),
        }
    }
}

impl CatalogSource for SkillsShSource {
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
        // Per-kind param: `installed_only` rides in `extra` (the route forwards it).
        let installed_only = matches!(q.extra_str("installed_only"), "true" | "1");
        let limit = if q.limit == 0 { 40 } else { q.limit };
        let cards =
            crate::skills_catalog::search_skills(client, &q.query, limit, installed_only).await?;
        Ok(serde_json::json!({ "skills": cards }))
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let detail = crate::skills_catalog::skill_detail(client, id).await?;
        Ok(serde_json::to_value(detail)?)
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        // Skills install via a directory write, not a single file download, so the
        // descriptor carries no files; the source-aware route performs the install.
        Ok(InstallDescriptor {
            kind: CatalogKind::Skill,
            source_id: self.id.clone(),
            repo_id: id.to_string(),
            files: Vec::new(),
            raw: serde_json::Value::Null,
        })
    }
}

/// A generic Claude **plugin-marketplace** source (#463): given a github repo or
/// URL that contains a `.claude-plugin/marketplace.json`, it fetches the
/// manifest, enumerates its plugins, and flattens each plugin's bundled skills
/// into the catalog. Installing a chosen skill runs through Unit #462's
/// [`crate::skills_catalog::from_source::install_from_source`] fetcher against the
/// plugin's `source` repo (scoped to the skill's `skills/<name>` subdir).
///
/// ## The `marketplace.json` shape we parse
///
/// This is the Claude Code plugin-marketplace manifest. We read the subset that
/// matters for surfacing installable skills (unknown fields are ignored):
///
/// ```json
/// {
///   "name": "my-marketplace",
///   "owner": { "name": "Acme" },
///   "plugins": [
///     {
///       "name": "code-tools",
///       "description": "…",
///       "source": "owner/repo",                  // or { "source": "github", "repo": "owner/repo" }
///       "skills": ["./skills/foo", "skills/bar"]   // optional; explicit skill paths
///     }
///   ]
/// }
/// ```
///
/// - `plugins[].source` may be a bare `owner/repo` / git URL string, or an object
///   with a `repo`/`url` field (the Claude marketplace "source object" form). It
///   is the repo the skill is fetched from.
/// - `plugins[].skills` is an optional list of skill paths within that repo. When
///   present, each entry becomes one installable catalog item. When **absent**,
///   the plugin itself is surfaced as a single item (the repo is assumed to be a
///   skill / to carry a `skills/` dir that #462's walker discovers).
///
/// The synthetic catalog **id** for an item is `<plugin>/<skill-leaf>` (or just
/// `<plugin>` when the plugin has no explicit skills), so detail/install can map
/// it back to the right plugin + skill path.
#[derive(Clone)]
pub struct MarketplaceSource {
    pub id: String,
    pub display_name: String,
    /// The repo/URL hosting `.claude-plugin/marketplace.json` (the custom
    /// source's `base_url`).
    pub repo_url: String,
}

/// One plugin entry parsed from a marketplace manifest.
#[derive(Debug, Clone, serde::Deserialize)]
struct MarketplacePlugin {
    name: String,
    #[serde(default)]
    description: Option<String>,
    /// The repo the plugin (and its skills) are fetched from. A string
    /// (`owner/repo` or a git URL) or an object with `repo`/`url`.
    #[serde(default)]
    source: serde_json::Value,
    /// Optional explicit skill paths within the plugin repo.
    #[serde(default)]
    skills: Vec<serde_json::Value>,
}

/// The marketplace manifest (only the fields we surface).
#[derive(Debug, Clone, serde::Deserialize)]
struct MarketplaceManifest {
    #[serde(default)]
    plugins: Vec<MarketplacePlugin>,
}

/// One flattened installable item: a plugin (+ optional skill leaf) resolved to a
/// fetchable source string for #462's installer.
#[derive(Debug, Clone)]
pub struct MarketplaceItem {
    /// Synthetic catalog id: `<plugin>` or `<plugin>/<skill-leaf>`.
    pub id: String,
    /// Plugin name (the item's `source` column / owner).
    pub plugin: String,
    /// Optional skill description from the plugin.
    pub description: Option<String>,
    /// The `install_from_source`-compatible source string (repo or repo + subdir).
    pub install_source: String,
}

impl MarketplaceSource {
    /// Resolve the raw `marketplace.json` URL for the configured repo/URL. Accepts
    /// `owner/repo`, a `https://github.com/owner/repo[/...]` URL, or a direct URL
    /// already pointing at a `.json` file.
    fn manifest_url(&self) -> String {
        marketplace_manifest_url(&self.repo_url)
    }

    /// Fetch + parse the manifest, then flatten every plugin's skills into items.
    async fn fetch_items(&self, _client: &reqwest::Client) -> Result<Vec<MarketplaceItem>> {
        let url = self.manifest_url();
        // The manifest URL derives from a user-supplied repo/URL (custom source /
        // startup load), so SSRF-guard it at fetch time: resolve + screen IPs, pin
        // the client, disable redirects. (The passed `client` is unused; the guard
        // builds its own pinned client.)
        let body = crate::server::guarded_get_bytes(&url)
            .await
            .map_err(|e| anyhow::anyhow!("fetching marketplace manifest {url}: {e}"))?;
        let manifest = parse_marketplace(&body)
            .map_err(|e| anyhow::anyhow!("parsing marketplace manifest {url}: {e}"))?;
        Ok(flatten_plugins(&manifest))
    }

    fn item_to_card(&self, item: &MarketplaceItem) -> Value {
        serde_json::json!({
            "id": item.id,
            "source": self.display_name,
            "slug": item.id.rsplit('/').next().unwrap_or(&item.id),
            "name": item.id.rsplit('/').next().unwrap_or(&item.id),
            "installs": 0,
            "installed": false,
        })
    }
}

impl CatalogSource for MarketplaceSource {
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
        let items = self.fetch_items(client).await?;
        let needle = q.query.trim().to_lowercase();
        let cards: Vec<Value> = items
            .iter()
            .filter(|it| needle.is_empty() || it.id.to_lowercase().contains(&needle))
            .map(|it| self.item_to_card(it))
            .collect();
        Ok(serde_json::json!({ "skills": cards }))
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let items = self.fetch_items(client).await?;
        let item = items.iter().find(|it| it.id == id).ok_or_else(|| {
            anyhow::anyhow!("skill `{id}` not found in marketplace {}", self.repo_url)
        })?;
        let slug = item.id.rsplit('/').next().unwrap_or(&item.id).to_string();
        Ok(serde_json::json!({
            "card": {
                "id": item.id,
                "source": self.display_name,
                "slug": slug,
                "name": slug,
                "installs": 0,
                "installed": false,
            },
            "description": item.description,
            "readme": serde_json::Value::Null,
            "files": [],
            "url": item.install_source,
        }))
    }

    async fn install_descriptor(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        // Resolve the item so the route knows which source string to feed #462's
        // fetcher; carry it in `raw.install_source`. No files (directory install).
        let items = self.fetch_items(client).await?;
        let item = items.iter().find(|it| it.id == id).ok_or_else(|| {
            anyhow::anyhow!("skill `{id}` not found in marketplace {}", self.repo_url)
        })?;
        Ok(InstallDescriptor {
            kind: CatalogKind::Skill,
            source_id: self.id.clone(),
            repo_id: item.id.clone(),
            files: Vec::new(),
            raw: serde_json::json!({ "install_source": item.install_source }),
        })
    }
}

/// Build the raw `marketplace.json` URL for a repo/URL reference.
fn marketplace_manifest_url(repo: &str) -> String {
    let repo = repo.trim();
    // Already a direct .json URL.
    if repo.to_ascii_lowercase().ends_with(".json") {
        return repo.to_string();
    }
    // github.com/owner/repo[/...] → raw HEAD path.
    if let Some(rest) = repo
        .strip_prefix("https://github.com/")
        .or_else(|| repo.strip_prefix("http://github.com/"))
    {
        let mut it = rest.trim_end_matches('/').split('/');
        if let (Some(owner), Some(name)) = (it.next(), it.next()) {
            let name = name.strip_suffix(".git").unwrap_or(name);
            return format!(
                "https://raw.githubusercontent.com/{owner}/{name}/HEAD/.claude-plugin/marketplace.json"
            );
        }
    }
    // owner/repo shorthand.
    let parts: Vec<&str> = repo.split('/').collect();
    if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() {
        let name = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
        return format!(
            "https://raw.githubusercontent.com/{}/{name}/HEAD/.claude-plugin/marketplace.json",
            parts[0]
        );
    }
    // Fallback: assume the repo URL is a directory; append the manifest path.
    format!(
        "{}/.claude-plugin/marketplace.json",
        repo.trim_end_matches('/')
    )
}

/// Parse a marketplace manifest from raw bytes (never panics on bad input).
fn parse_marketplace(bytes: &[u8]) -> Result<MarketplaceManifest> {
    Ok(serde_json::from_slice(bytes)?)
}

/// Read a plugin `source` value into an `install_from_source`-compatible string.
/// Accepts a bare string (`owner/repo` or git URL) or an object carrying a
/// `repo`/`url`/`source` string field.
fn plugin_source_string(source: &serde_json::Value) -> Option<String> {
    match source {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        serde_json::Value::Object(map) => map
            .get("repo")
            .or_else(|| map.get("url"))
            .or_else(|| map.get("source"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string()),
        _ => None,
    }
}

/// Flatten a manifest's plugins into installable items. Each plugin with explicit
/// `skills` paths yields one item per skill (id `<plugin>/<leaf>`, source scoped
/// to that subdir); a plugin without skills yields a single `<plugin>` item.
/// Plugins whose `source` can't be resolved are skipped.
fn flatten_plugins(manifest: &MarketplaceManifest) -> Vec<MarketplaceItem> {
    let mut out = Vec::new();
    for plugin in &manifest.plugins {
        let Some(repo) = plugin_source_string(&plugin.source) else {
            continue;
        };
        let skill_paths: Vec<String> = plugin
            .skills
            .iter()
            .filter_map(|s| {
                s.as_str()
                    .map(|p| p.trim_start_matches("./").trim().to_string())
            })
            .filter(|p| !p.is_empty())
            .collect();
        if skill_paths.is_empty() {
            out.push(MarketplaceItem {
                id: plugin.name.clone(),
                plugin: plugin.name.clone(),
                description: plugin.description.clone(),
                install_source: repo.clone(),
            });
            continue;
        }
        for path in skill_paths {
            let leaf = path.rsplit('/').next().unwrap_or(&path).to_string();
            out.push(MarketplaceItem {
                id: format!("{}/{leaf}", plugin.name),
                plugin: plugin.name.clone(),
                description: plugin.description.clone(),
                // #462's parser accepts `owner/repo` + a github tree subdir URL.
                // Build a github `/tree/HEAD/<path>` URL when the repo resolves to
                // one; otherwise hand the bare repo (the walker finds the skill).
                install_source: scoped_source(&repo, &path),
            });
        }
    }
    out
}

/// Build an `install_from_source` string scoped to a skill subdir. For an
/// `owner/repo` / github repo we use the `tree/HEAD/<subdir>` URL form #462
/// understands; for other source strings we fall back to the bare repo (the
/// directory walker locates the skill).
fn scoped_source(repo: &str, subdir: &str) -> String {
    let r = repo.trim();
    // github URL.
    if let Some(rest) = r
        .strip_prefix("https://github.com/")
        .or_else(|| r.strip_prefix("http://github.com/"))
    {
        let mut it = rest.trim_end_matches('/').split('/');
        if let (Some(owner), Some(name)) = (it.next(), it.next()) {
            let name = name.strip_suffix(".git").unwrap_or(name);
            return format!("https://github.com/{owner}/{name}/tree/HEAD/{subdir}");
        }
    }
    // owner/repo shorthand.
    let parts: Vec<&str> = r.split('/').collect();
    if parts.len() == 2 && !parts[0].is_empty() && !parts[1].is_empty() && !r.contains(' ') {
        let name = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
        return format!("https://github.com/{}/{name}/tree/HEAD/{subdir}", parts[0]);
    }
    r.to_string()
}

/// The built-in **official MCP registry** source (#464): the primary Mcp source.
/// Its search/detail delegate to [`crate::mcp_catalog`] (the
/// `registry.modelcontextprotocol.io` `/v0.1/servers` endpoint), and install
/// (handled in the route via [`Source::install_mcp`]) resolves a validated
/// `mcp.json` entry the MCP registry then hot-loads.
///
/// `install_descriptor` here is a thin no-file handoff: an MCP install does not
/// download a checksummed artifact, it writes a server entry (a launch command
/// for stdio, or a URL for a remote) into `~/.ryu/mcp.json`. So the descriptor
/// carries `files: []`, stashes the server id in `repo_id`, and records the
/// resolved install plan in `raw` so the route can surface the command before
/// writing it. The source itself never executes or launches anything.
#[derive(Clone)]
pub struct OfficialMcpSource {
    pub id: String,
    pub display_name: String,
    /// Optional registry base override for a custom MCP registry mirror. `None`
    /// uses the official default (or `RYU_MCP_REGISTRY_URL`).
    pub base_url: Option<String>,
}

impl OfficialMcpSource {
    /// The builtin official-registry source (the default active Mcp source).
    pub fn builtin() -> Self {
        Self {
            id: "mcp-registry".to_string(),
            display_name: "MCP Registry".to_string(),
            base_url: None,
        }
    }
}

impl CatalogSource for OfficialMcpSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Mcp
    }

    async fn search(&self, _client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let limit = if q.limit == 0 { 40 } else { q.limit };
        crate::mcp_catalog::search_servers_json(
            self.base_url.as_deref(),
            &q.query,
            limit,
            q.cursor.as_deref().filter(|s| !s.is_empty()),
        )
        .await
    }

    async fn detail(&self, _client: &reqwest::Client, id: &str) -> Result<Value> {
        crate::mcp_catalog::server_detail_json(self.base_url.as_deref(), id).await
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        // MCP installs write an mcp.json entry, not a single file download, so the
        // descriptor carries no files; the resolved plan rides in `raw` so the
        // route can surface the launch command. The source never launches it.
        let plan = crate::mcp_catalog::plan_install(self.base_url.as_deref(), id).await?;
        let raw = match &plan.entry {
            crate::mcp_catalog::McpEntryPlan::Stdio { command, args } => serde_json::json!({
                "server_name": plan.server_name,
                "kind": "stdio",
                "command": command,
                "args": args,
                "description": plan.description,
            }),
            crate::mcp_catalog::McpEntryPlan::Remote { url } => serde_json::json!({
                "server_name": plan.server_name,
                "kind": "remote",
                "url": url,
                "description": plan.description,
            }),
        };
        Ok(InstallDescriptor {
            kind: CatalogKind::Mcp,
            source_id: self.id.clone(),
            repo_id: id.to_string(),
            files: Vec::new(),
            raw,
        })
    }
}

// ── Smithery MCP source (#465) ───────────────────────────────────────────────

/// The fixed Smithery registry host. The BYOK API key is **only ever** attached
/// to requests to this host (mirrors `hf_auth`'s strict-host rule) so a custom
/// base URL can never harvest the user's key. Smithery is therefore builtin-only
/// (no `base_url` override); see `registry.rs`.
const SMITHERY_REGISTRY_BASE: &str = "https://registry.smithery.ai";

/// Preferences key the desktop writes the Smithery API key into (BYOK). Falls
/// back to the `SMITHERY_API_KEY` env var for headless setups. "Nothing
/// hardcoded": the key is user-supplied, never baked in.
pub const SMITHERY_API_KEY_PREF: &str = "smithery-api-key";

/// The **Smithery** MCP source (#465): search/detail/install against Smithery's
/// registry (`registry.smithery.ai`). Smithery's API is **not** the official
/// `server.json` shape — it is `{ servers: [{ qualifiedName, displayName,
/// description, useCount, isDeployed }] }` for the list and `{ qualifiedName,
/// displayName, deploymentUrl, connections: [{ type, url, … }] }` for the detail.
/// Most Smithery servers are hosted (a `deploymentUrl` / an `http` connection →
/// a [`crate::mcp_catalog::McpEntryPlan::Remote`]). Either way the install reuses
/// #464's [`crate::mcp_catalog::plan_from_server`] for the exact same validation,
/// and the route writes the entry **disabled**.
///
/// API key handling (BYOK): the key is read preferences-first
/// ([`SMITHERY_API_KEY_PREF`], injected by the route) then `SMITHERY_API_KEY`
/// env, and attached only to the fixed Smithery host. When absent, fetches
/// degrade to a clear error (detail / install) or an empty, labelled result
/// (search) — never a panic.
#[derive(Clone)]
pub struct SmitherySource {
    pub id: String,
    pub display_name: String,
    /// The BYOK API key (env fallback at construction; the route overrides with
    /// the preference). `None` ⇒ degrade gracefully. Never logged.
    pub api_key: Option<String>,
}

/// One server entry from Smithery's list endpoint.
#[derive(Debug, Clone, serde::Deserialize)]
struct SmitheryListServer {
    #[serde(rename = "qualifiedName")]
    qualified_name: String,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "useCount")]
    use_count: Option<u64>,
    #[serde(default, rename = "isDeployed")]
    is_deployed: Option<bool>,
}

/// Smithery's list envelope.
#[derive(Debug, Clone, serde::Deserialize)]
struct SmitheryListEnvelope {
    #[serde(default)]
    servers: Vec<SmitheryListServer>,
}

/// One connection on a Smithery server detail.
#[derive(Debug, Clone, serde::Deserialize)]
struct SmitheryConnection {
    /// `http` (hosted) or `stdio` (local launch).
    #[serde(default, rename = "type")]
    connection_type: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// Smithery's get-server detail shape.
#[derive(Debug, Clone, serde::Deserialize)]
struct SmitheryServerDetail {
    #[serde(rename = "qualifiedName")]
    qualified_name: String,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default, rename = "deploymentUrl")]
    deployment_url: Option<String>,
    #[serde(default)]
    connections: Vec<SmitheryConnection>,
}

impl SmitherySource {
    /// The builtin Smithery source. `api_key` is seeded from the env fallback;
    /// the route injects the user's preference before a fetch. Keeping it
    /// builtin-only enforces the strict-host key rule (no custom base URL).
    pub fn builtin() -> Self {
        Self {
            id: "smithery".to_string(),
            display_name: "Smithery".to_string(),
            api_key: std::env::var("SMITHERY_API_KEY")
                .ok()
                .map(|k| k.trim().to_string())
                .filter(|k| !k.is_empty()),
        }
    }

    /// Resolve the Smithery API key: an explicitly-supplied value (e.g. from
    /// `extra["api_key"]`) first, else the construction-time key.
    fn resolved_key<'a>(&'a self, override_key: Option<&'a str>) -> Option<&'a str> {
        override_key
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .or(self.api_key.as_deref())
    }

    /// Fetch + parse one page of the list endpoint. Requires a key; without one
    /// it returns a clear error the caller turns into an empty search result.
    async fn fetch_list(
        &self,
        key: Option<&str>,
        q: &str,
        limit: usize,
    ) -> Result<Vec<SmitheryListServer>> {
        let key = key.ok_or_else(|| {
            anyhow::anyhow!(
                "Smithery requires an API key (set it in Settings or the SMITHERY_API_KEY env)"
            )
        })?;
        let mut url = format!("{SMITHERY_REGISTRY_BASE}/servers?pageSize={}", limit.max(1));
        let needle = q.trim();
        if !needle.is_empty() {
            url.push_str(&format!("&q={}", urlencode_component(needle)));
        }
        let body = crate::server::guarded_get_bytes_with_bearer(&url, Some(key))
            .await
            .map_err(|e| anyhow::anyhow!("fetching Smithery registry {url}: {e}"))?;
        let env: SmitheryListEnvelope = serde_json::from_slice(&body)
            .map_err(|e| anyhow::anyhow!("parsing Smithery registry {url}: {e}"))?;
        Ok(env.servers)
    }

    /// Fetch + parse a single server's detail. Requires a key.
    async fn fetch_detail(&self, key: Option<&str>, id: &str) -> Result<SmitheryServerDetail> {
        let key = key.ok_or_else(|| {
            anyhow::anyhow!(
                "Smithery requires an API key (set it in Settings or the SMITHERY_API_KEY env)"
            )
        })?;
        let url = format!(
            "{SMITHERY_REGISTRY_BASE}/servers/{}",
            urlencode_path(id.trim())
        );
        let body = crate::server::guarded_get_bytes_with_bearer(&url, Some(key))
            .await
            .map_err(|e| anyhow::anyhow!("fetching Smithery server {url}: {e}"))?;
        serde_json::from_slice(&body)
            .map_err(|e| anyhow::anyhow!("parsing Smithery server {url}: {e}"))
    }

    /// Map a Smithery detail into the canonical [`crate::mcp_catalog::ServerJson`]
    /// so install reuses #464's validated plan builder. Prefers a hosted endpoint
    /// (`deploymentUrl` or an `http` connection → remote); a stdio-only server
    /// carries no package identifier in Smithery's API, so we cannot synthesize a
    /// safe launch command and report that clearly.
    fn detail_to_server_json(
        detail: &SmitheryServerDetail,
    ) -> Result<crate::mcp_catalog::ServerJson> {
        let hosted_url = detail
            .deployment_url
            .as_deref()
            .filter(|u| !u.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                detail
                    .connections
                    .iter()
                    .find(|c| {
                        c.connection_type
                            .as_deref()
                            .map(|t| {
                                t.eq_ignore_ascii_case("http")
                                    || t.eq_ignore_ascii_case("streamable-http")
                            })
                            .unwrap_or(false)
                    })
                    .and_then(|c| c.url.clone())
                    .filter(|u| !u.trim().is_empty())
            })
            .or_else(|| {
                detail
                    .connections
                    .iter()
                    .find_map(|c| c.url.clone())
                    .filter(|u| !u.trim().is_empty())
            });
        let description = detail
            .description
            .clone()
            .or_else(|| detail.display_name.clone());
        match hosted_url {
            Some(url) => Ok(crate::mcp_catalog::ServerJson::remote(
                detail.qualified_name.clone(),
                description,
                url,
            )),
            None => bail!(
                "Smithery server `{}` has no installable hosted URL (stdio-only servers carry no package identifier)",
                detail.qualified_name
            ),
        }
    }

    fn list_server_to_card(&self, s: &SmitheryListServer) -> Value {
        serde_json::json!({
            "id": s.qualified_name,
            "name": s.display_name.clone().unwrap_or_else(|| s.qualified_name.clone()),
            "description": s.description,
            "version": serde_json::Value::Null,
            "has_packages": false,
            "has_remotes": s.is_deployed.unwrap_or(false),
            "transports": ["http"],
            "use_count": s.use_count,
            "installed": false,
        })
    }
}

impl CatalogSource for SmitherySource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Mcp
    }

    async fn search(&self, _client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let limit = if q.limit == 0 { 40 } else { q.limit };
        let pref = q.extra_str("api_key");
        let key = self.resolved_key(if pref.is_empty() { None } else { Some(pref) });
        match self.fetch_list(key, &q.query, limit).await {
            Ok(servers) => {
                let cards: Vec<Value> = servers
                    .iter()
                    .map(|s| self.list_server_to_card(s))
                    .collect();
                Ok(serde_json::json!({ "servers": cards, "next_cursor": serde_json::Value::Null }))
            }
            // Degrade to an empty, labelled result (e.g. no key) rather than error
            // out the whole list response — never panic.
            Err(e) => Ok(serde_json::json!({
                "servers": [],
                "next_cursor": serde_json::Value::Null,
                "note": e.to_string(),
            })),
        }
    }

    async fn detail(&self, _client: &reqwest::Client, id: &str) -> Result<Value> {
        let key = self.resolved_key(None);
        let detail = self.fetch_detail(key, id).await?;
        let server = Self::detail_to_server_json(&detail)?;
        Ok(crate::mcp_catalog::server_to_detail(&server))
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        let key = self.resolved_key(None);
        let detail = self.fetch_detail(key, id).await?;
        let server = Self::detail_to_server_json(&detail)?;
        let plan = crate::mcp_catalog::plan_from_server(&server)?;
        Ok(mcp_plan_descriptor(&self.id, id, &plan))
    }
}

// ── Ryu-hosted curated MCP source (#465) ─────────────────────────────────────

/// Env/pref override for the Ryu-hosted curated MCP index URL ("nothing
/// hardcoded"). When unset, the built-in static curated list is used.
pub const RYU_HOSTED_MCP_INDEX_ENV: &str = "RYU_HOSTED_MCP_INDEX_URL";

/// A small built-in curated MCP index in the **official `server.json` envelope**
/// shape, so it reuses #464's [`crate::mcp_catalog::parse_server_list`] +
/// [`crate::mcp_catalog::plan_from_server`] wholesale. Well-known reference MCP
/// servers; kept tiny and conservative.
const RYU_HOSTED_CURATED_INDEX: &str = r#"{
  "servers": [
    {
      "name": "io.modelcontextprotocol/filesystem",
      "description": "Reference filesystem MCP server (read/write within allowed dirs).",
      "version": "latest",
      "packages": [
        { "registry_type": "npm", "identifier": "@modelcontextprotocol/server-filesystem",
          "version": "latest", "transport": { "type": "stdio" } }
      ]
    },
    {
      "name": "io.modelcontextprotocol/memory",
      "description": "Reference knowledge-graph memory MCP server.",
      "version": "latest",
      "packages": [
        { "registry_type": "npm", "identifier": "@modelcontextprotocol/server-memory",
          "version": "latest", "transport": { "type": "stdio" } }
      ]
    },
    {
      "name": "io.modelcontextprotocol/sequential-thinking",
      "description": "Reference sequential-thinking MCP server.",
      "version": "latest",
      "packages": [
        { "registry_type": "npm", "identifier": "@modelcontextprotocol/server-sequential-thinking",
          "version": "latest", "transport": { "type": "stdio" } }
      ]
    },
    {
      "name": "io.modelcontextprotocol/fetch",
      "description": "Reference web-fetch MCP server (Python).",
      "version": "latest",
      "packages": [
        { "registry_type": "pypi", "identifier": "mcp-server-fetch",
          "transport": { "type": "stdio" } }
      ]
    }
  ]
}"#;

/// The **Ryu-hosted** curated MCP source (#465): a curated set of MCP servers
/// from a Ryu-hosted index JSON. The hosted endpoint may not exist yet, so the
/// index URL is swappable ([`RYU_HOSTED_MCP_INDEX_ENV`] / a custom source's
/// `base_url`) and defaults to a small built-in [`RYU_HOSTED_CURATED_INDEX`].
/// The index is the official `server.json` envelope shape, so search/detail/
/// install reuse #464's parser + plan builder wholesale. On any fetch/parse
/// failure of a remote index it degrades to the built-in static list — never a
/// panic.
#[derive(Clone)]
pub struct RyuHostedMcpSource {
    pub id: String,
    pub display_name: String,
    /// Optional remote index URL override. `None` ⇒ env or built-in static list.
    pub index_url: Option<String>,
}

impl RyuHostedMcpSource {
    /// The builtin Ryu-hosted source.
    pub fn builtin() -> Self {
        Self {
            id: "ryu-hosted".to_string(),
            display_name: "Ryu Hosted".to_string(),
            index_url: None,
        }
    }

    /// Resolve the index URL: an explicit `index_url` (custom source), else the
    /// env override, else `None` (use the built-in static list).
    fn resolve_index_url(&self) -> Option<String> {
        self.index_url
            .clone()
            .filter(|u| !u.trim().is_empty())
            .or_else(|| {
                std::env::var(RYU_HOSTED_MCP_INDEX_ENV)
                    .ok()
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty())
            })
    }

    /// Load curated servers: fetch + parse the remote index when configured, else
    /// the built-in static list. A remote fetch/parse failure falls back to the
    /// static list (never panics, never errors out the catalog).
    async fn load_servers(&self) -> Vec<crate::mcp_catalog::ServerJson> {
        if let Some(url) = self.resolve_index_url() {
            match crate::server::guarded_get_bytes(&url).await {
                Ok(body) => match crate::mcp_catalog::parse_server_list(&body) {
                    Ok(servers) => return servers,
                    Err(e) => tracing::warn!(
                        "Ryu-hosted MCP index {url} parse failed, using built-in list: {e:#}"
                    ),
                },
                Err(e) => tracing::warn!(
                    "Ryu-hosted MCP index {url} fetch failed, using built-in list: {e:#}"
                ),
            }
        }
        // Built-in static list — guaranteed to parse (it is a const literal).
        crate::mcp_catalog::parse_server_list(RYU_HOSTED_CURATED_INDEX.as_bytes())
            .unwrap_or_default()
    }
}

impl CatalogSource for RyuHostedMcpSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Mcp
    }

    async fn search(&self, _client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let servers = self.load_servers().await;
        let needle = q.query.trim().to_ascii_lowercase();
        let cards: Vec<Value> = servers
            .iter()
            .filter(|s| {
                needle.is_empty()
                    || s.name.to_ascii_lowercase().contains(&needle)
                    || s.description
                        .as_deref()
                        .is_some_and(|d| d.to_ascii_lowercase().contains(&needle))
            })
            .map(crate::mcp_catalog::server_to_card)
            .collect();
        Ok(serde_json::json!({ "servers": cards, "next_cursor": serde_json::Value::Null }))
    }

    async fn detail(&self, _client: &reqwest::Client, id: &str) -> Result<Value> {
        let servers = self.load_servers().await;
        let server = servers
            .iter()
            .find(|s| s.name == id)
            .ok_or_else(|| anyhow::anyhow!("MCP server `{id}` not found in Ryu-hosted index"))?;
        Ok(crate::mcp_catalog::server_to_detail(server))
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        let servers = self.load_servers().await;
        let server = servers
            .iter()
            .find(|s| s.name == id)
            .ok_or_else(|| anyhow::anyhow!("MCP server `{id}` not found in Ryu-hosted index"))?;
        let plan = crate::mcp_catalog::plan_from_server(server)?;
        Ok(mcp_plan_descriptor(&self.id, id, &plan))
    }
}

/// Build the no-file [`InstallDescriptor`] for a resolved MCP [`InstallPlan`],
/// stashing the resolved launch command / remote URL in `raw` so the route can
/// surface it before writing the disabled entry (shared by all Mcp sources #465).
fn mcp_plan_descriptor(
    source_id: &str,
    repo_id: &str,
    plan: &crate::mcp_catalog::InstallPlan,
) -> InstallDescriptor {
    let raw = match &plan.entry {
        crate::mcp_catalog::McpEntryPlan::Stdio { command, args } => serde_json::json!({
            "server_name": plan.server_name,
            "kind": "stdio",
            "command": command,
            "args": args,
            "description": plan.description,
        }),
        crate::mcp_catalog::McpEntryPlan::Remote { url } => serde_json::json!({
            "server_name": plan.server_name,
            "kind": "remote",
            "url": url,
            "description": plan.description,
        }),
    };
    InstallDescriptor {
        kind: CatalogKind::Mcp,
        source_id: source_id.to_string(),
        repo_id: repo_id.to_string(),
        files: Vec::new(),
        raw,
    }
}

/// Percent-encode a query-component value (Smithery `q`).
fn urlencode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Percent-encode a path-segment value (a Smithery `qualifiedName`), preserving
/// the `/` and `@` real qualified names contain.
fn urlencode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b'@' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A degenerate, **un-pointed** source used only where there is genuinely no
/// upstream catalog to query: a user-added custom Skill/Mcp source with no base
/// URL, and the redundant `ryu-apps` plugin placeholder (the real plugin catalog
/// is [`RyuMarketplaceSource`], the registered primary for `Plugin`).
///
/// The real per-kind install paths are NOT here — they live on the concrete
/// sources and the route consumers: model installs go through
/// [`HfSource`]/[`ModelIndexSource`] + [`crate::model_catalog::install_from_descriptor`],
/// skills through [`Source::install_skill`] → [`crate::skills_catalog`], MCP
/// through [`Source::install_mcp`] → `~/.ryu/mcp.json`, plugins through the
/// marketplace source + the app/plugin lifecycle. A `StubSource` is never the
/// active source on a path that reaches a real installer, so search/detail/
/// install here return an actionable "this source points nowhere" message rather
/// than pretending an install is forthcoming.
#[derive(Clone)]
pub struct StubSource {
    pub id: String,
    pub display_name: String,
    pub kind: CatalogKind,
}

impl StubSource {
    /// The shared, actionable explanation for why this source can't serve
    /// anything: it has no upstream URL configured.
    fn unconfigured_note(&self) -> String {
        format!(
            "{} source `{}` has no upstream configured; add a registry or marketplace base URL for this source, or switch to a built-in source",
            self.kind, self.id
        )
    }
}

impl CatalogSource for StubSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        self.kind
    }

    async fn search(&self, _client: &reqwest::Client, _q: &CatalogQuery) -> Result<Value> {
        Ok(serde_json::json!({
            "items": [],
            "note": self.unconfigured_note(),
        }))
    }

    async fn detail(&self, _client: &reqwest::Client, _id: &str) -> Result<Value> {
        Ok(serde_json::json!({
            "note": self.unconfigured_note(),
        }))
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        _id: &str,
    ) -> Result<InstallDescriptor> {
        bail!("{}", self.unconfigured_note())
    }
}

// ── Ryu Marketplace source (#467) ────────────────────────────────────────────

/// Env override for the Ryu Marketplace API base URL ("nothing hardcoded").
/// Defaults to the localhost control-plane server in dev.
pub const RYU_MARKETPLACE_API_ENV: &str = "RYU_MARKETPLACE_API_URL";

/// The dev default base URL: the `apps/server` Hono control plane on :3000.
const RYU_MARKETPLACE_DEFAULT_BASE: &str = "http://localhost:3000";

/// Env var carrying a control-plane bearer (Better Auth / OAuth session token)
/// to forward on the marketplace install handoff so a PAID item's entitlement
/// check (#491) can resolve the buyer org + its license. This is the
/// *fallback*/headless path; the live desktop install threads the caller's
/// bearer per-request via [`with_buyer_token`] (env vars are fixed at spawn and
/// cannot carry a live, expiring session token). Unset ⇒ anonymous install
/// (fine for free items; a paid item is denied 402). Nothing hardcoded.
const RYU_MARKETPLACE_TOKEN_ENV: &str = "RYU_MARKETPLACE_TOKEN";

tokio::task_local! {
    /// The authenticated buyer's bearer for the current install request, set by
    /// the install handler from the inbound `Authorization` header. Per-request
    /// and dynamic (an env var cannot carry a live session token to a
    /// long-running Core). `None` ⇒ no header on this request.
    static BUYER_TOKEN: Option<String>;
}

/// Run `fut` with `token` bound as the current request's buyer bearer, so a
/// nested `RyuMarketplaceSource::fetch_detail` forwards it to the install
/// handoff. The install handlers wrap their `install_descriptor` / install call
/// in this; `token` is the trimmed `Authorization: Bearer …` value (or `None`).
pub async fn with_buyer_token<F, T>(token: Option<String>, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    let token = token
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    BUYER_TOKEN.scope(token, fut).await
}

/// Resolve the optional buyer bearer to forward to the marketplace install
/// handoff: the per-request task-local first (the live desktop path), else the
/// `RYU_MARKETPLACE_TOKEN` env fallback (headless). `None` ⇒ anonymous.
fn marketplace_buyer_token() -> Option<String> {
    let from_request = BUYER_TOKEN
        .try_with(|t| t.clone())
        .ok()
        .flatten()
        .filter(|t| !t.is_empty());
    if from_request.is_some() {
        return from_request;
    }
    std::env::var(RYU_MARKETPLACE_TOKEN_ENV)
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// The **Ryu Marketplace** federated catalog source (#467). One source type
/// that spans **all four kinds**: a [`kind`](Self::kind) field discriminates,
/// and the source is registered once per kind in `builtin_sources`. It fetches
/// the first-party marketplace API (`GET /api/marketplace/catalog{,/detail}`)
/// over a **plain reqwest client** (the endpoint is trusted first-party, and is
/// localhost in dev, so it must NOT go through the SSRF `guarded_get` that
/// blocks loopback) and maps each item onto Core's per-kind install path.
///
/// Cross-kind design (the crux): unlike every other `Source` variant (whose
/// variant == its kind), this one variant serves 4 kinds, so **every method
/// branches on `self.kind`**:
/// - `search` normalizes the server's flat `{ items }` into the per-kind
///   envelope each tab renders (`{ models }` / `{ skills }` / `{ servers }` /
///   `{ items }`), keyed on `self.kind`.
/// - `install_descriptor` maps the item's `descriptor` to the right handoff:
///   model → `files[]`; skill → `raw.install_source`; mcp → the plan in `raw`;
///   plugin → the manifest in `raw` (no Core install path yet).
/// - the enum-level `install_skill` / `install_mcp` guard on `self.kind` and
///   return `Ok(None)` for the wrong kind so a model-kind marketplace source is
///   never wrongly installed down the skill path.
///
/// Degrades gracefully: an unreachable server makes `search` return an empty,
/// labelled per-kind envelope (with a `note`); `detail` / `install_descriptor`
/// return a clear error. Never panics.
#[derive(Clone)]
pub struct RyuMarketplaceSource {
    pub id: String,
    pub display_name: String,
    pub kind: CatalogKind,
    /// Optional base URL override. `None` ⇒ env (`RYU_MARKETPLACE_API_URL`) or
    /// the localhost dev default.
    pub base_url: Option<String>,
}

/// One catalog card from the marketplace `GET /catalog` response.
#[derive(Debug, Clone, serde::Deserialize)]
struct MarketplaceCard {
    id: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default, rename = "installSource")]
    install_source: Option<String>,
}

/// The marketplace `GET /catalog` envelope.
#[derive(Debug, Clone, serde::Deserialize)]
struct MarketplaceListEnvelope {
    #[serde(default)]
    items: Vec<MarketplaceCard>,
}

impl RyuMarketplaceSource {
    /// The builtin Ryu Marketplace source for a given kind. The same id/name is
    /// reused across kinds (the registry keys by kind + id, so this is safe).
    pub fn builtin(kind: CatalogKind) -> Self {
        Self {
            id: "ryu-marketplace".to_string(),
            display_name: "Ryu Marketplace".to_string(),
            kind,
            base_url: None,
        }
    }

    /// Resolve the API base URL: an explicit `base_url`, else the env override,
    /// else the localhost dev default. Trailing slash trimmed.
    fn resolve_base(&self) -> String {
        let raw = self
            .base_url
            .clone()
            .filter(|u| !u.trim().is_empty())
            .or_else(|| {
                std::env::var(RYU_MARKETPLACE_API_ENV)
                    .ok()
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty())
            })
            .unwrap_or_else(|| RYU_MARKETPLACE_DEFAULT_BASE.to_string());
        raw.trim_end_matches('/').to_string()
    }

    /// Fetch the search results for this source's kind. A plain (non-guarded)
    /// reqwest GET against the trusted first-party endpoint — `guarded_get`
    /// would block the localhost dev URL.
    async fn fetch_cards(
        &self,
        client: &reqwest::Client,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MarketplaceCard>> {
        let url = format!(
            "{}/api/marketplace/catalog?kind={}&query={}&limit={}",
            self.resolve_base(),
            self.kind.as_str(),
            urlencode_component(query.trim()),
            limit.max(1),
        );
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("fetching Ryu Marketplace {url}: {e}"))?;
        if !resp.status().is_success() {
            bail!("Ryu Marketplace {url} returned status {}", resp.status());
        }
        let env: MarketplaceListEnvelope = resp
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("parsing Ryu Marketplace {url}: {e}"))?;
        Ok(env.items)
    }

    /// Fetch one item's detail (manifest + descriptor) for this source's kind.
    ///
    /// `catalog/detail` is the install handoff AND the install-time entitlement
    /// seam (#491): for a PAID item the control plane returns `402 Payment
    /// Required` unless the caller's org holds an active license. So when a buyer
    /// bearer is present — the per-request token threaded from the install
    /// handler's `Authorization` header via [`with_buyer_token`], else the
    /// `RYU_MARKETPLACE_TOKEN` headless fallback — it is forwarded so a licensed
    /// org's install succeeds. A 402 is surfaced as a clear "requires purchase"
    /// error (never a generic not-found), carrying the server's actionable reason.
    async fn fetch_detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let url = format!(
            "{}/api/marketplace/catalog/detail?kind={}&id={}",
            self.resolve_base(),
            self.kind.as_str(),
            urlencode_path(id.trim()),
        );
        let mut req = client.get(&url);
        if let Some(token) = marketplace_buyer_token() {
            req = req.bearer_auth(token);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("fetching Ryu Marketplace detail {url}: {e}"))?;
        // 402 Payment Required: a paid item the buyer org is not licensed for.
        // Surface the server's actionable purchase reason verbatim.
        if resp.status() == reqwest::StatusCode::PAYMENT_REQUIRED {
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            let reason = body
                .get("error")
                .and_then(|e| e.as_str())
                .unwrap_or("this is a paid item; purchase a license before installing")
                .to_string();
            bail!("cannot install `{id}`: {reason}");
        }
        if !resp.status().is_success() {
            bail!(
                "Ryu Marketplace item `{id}` not found ({} from {url})",
                resp.status()
            );
        }
        resp.json()
            .await
            .map_err(|e| anyhow::anyhow!("parsing Ryu Marketplace detail {url}: {e}"))
    }

    /// Verify-on-install (#468): reject a tampered manifest before any install
    /// work. The detail document carries the Gateway-issued `signature` (over the
    /// canonical `manifest`) and the `signingPublicKey` it was produced with.
    /// We ask the Gateway's `/v1/manifests/verify` to check them.
    ///
    /// Trust policy (CLAUDE.md "nothing hardcoded"):
    /// - When `RYU_MARKETPLACE_PUBLIC_KEY` is set, that pinned key is the verifier
    ///   (real prod tamper-resistance, independent of a gateway key rotation).
    /// - Else NO key is sent and the Gateway verifies with its own resident
    ///   verifying key (dev / same-gateway-signed-and-verifies path).
    ///
    /// The manifest-supplied `signingPublicKey` is NEVER used as the trust anchor:
    /// trusting it would be self-attested signing (a tamperer ships their own key
    /// + a matching signature and "passes"). That field is for display / rotation
    /// cross-checks only.
    ///
    /// Fail policy (mirrors the lifecycle grant seam):
    /// - signature present + invalid  -> reject (the tamper case).
    /// - signature absent             -> allow (unsigned seed items; logged).
    /// - gateway unreachable          -> reject (fail closed) when a signature is
    ///   present, so a tampered manifest cannot install merely because the
    ///   verifier is down.
    async fn verify_manifest_signature(
        &self,
        client: &reqwest::Client,
        id: &str,
        detail: &Value,
    ) -> Result<()> {
        let signature = detail
            .get("signature")
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty());
        let Some(signature) = signature else {
            // Unsigned (e.g. a first-party seed item): allow, but log so it is
            // visible. Absent != tampered.
            tracing::warn!(
                id,
                kind = self.kind.as_str(),
                "Ryu Marketplace item has no signature; installing unverified (unsigned item)"
            );
            return Ok(());
        };

        let manifest = detail.get("manifest").cloned().unwrap_or(Value::Null);
        // Only a pinned, operator-configured key is trusted. If unset, send no key
        // so the Gateway verifies with its own resident key. The manifest's own
        // `signingPublicKey` is deliberately NOT used (self-attestation bypass).
        let public_key = std::env::var("RYU_MARKETPLACE_PUBLIC_KEY")
            .ok()
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty());

        let gateway = crate::sidecar::gateway::gateway_url();
        let url = format!("{}/v1/manifests/verify", gateway.trim_end_matches('/'));
        let mut payload = serde_json::Map::new();
        payload.insert("manifest".to_string(), manifest);
        payload.insert(
            "signature".to_string(),
            Value::String(signature.to_string()),
        );
        if let Some(pk) = public_key {
            payload.insert("public_key".to_string(), Value::String(pk));
        }

        let resp = client
            .post(&url)
            .json(&Value::Object(payload))
            .send()
            .await
            .map_err(|e| {
                anyhow::anyhow!(
                    "signature verification unreachable for `{id}` ({url}): {e}; refusing install"
                )
            })?;
        if !resp.status().is_success() {
            bail!(
                "signature verification failed for `{id}`: gateway returned {}",
                resp.status()
            );
        }
        let body: Value = resp
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("parsing verify response for `{id}`: {e}"))?;
        if body.get("valid").and_then(|v| v.as_bool()) == Some(true) {
            Ok(())
        } else {
            bail!("manifest signature is invalid for `{id}`; refusing install (tampered manifest)")
        }
    }

    /// The empty, per-kind search envelope keyed on `self.kind`, with a `note`
    /// explaining the degrade. Mirrors Smithery's tolerant-search behavior.
    fn empty_envelope(&self, note: &str) -> Value {
        let cards: Vec<Value> = Vec::new();
        self.wrap_envelope(cards, Some(note))
    }

    /// Wrap a list of per-kind cards in the envelope the matching desktop tab
    /// expects: model `{ models }`, skill `{ skills }`, mcp `{ servers }`,
    /// plugin `{ items }`.
    fn wrap_envelope(&self, cards: Vec<Value>, note: Option<&str>) -> Value {
        let key = match self.kind {
            CatalogKind::Model => "models",
            CatalogKind::Skill => "skills",
            CatalogKind::Mcp => "servers",
            CatalogKind::Plugin => "items",
            CatalogKind::Knowledge => "concepts",
        };
        let mut obj = serde_json::Map::new();
        obj.insert(key.to_string(), Value::Array(cards));
        obj.insert("next_cursor".to_string(), Value::Null);
        if let Some(n) = note {
            obj.insert("note".to_string(), Value::String(n.to_string()));
        }
        Value::Object(obj)
    }

    /// Map one marketplace card into the per-kind card JSON each tab renders.
    fn card_to_value(&self, card: &MarketplaceCard) -> Value {
        match self.kind {
            CatalogKind::Model => serde_json::json!({
                "id": card.id,
                "author": card.author.clone().unwrap_or_else(|| self.display_name.clone()),
                "name": card.name,
                "downloads": 0,
                "likes": 0,
                "pipeline_tag": Value::Null,
                "tags": [],
                "gated": false,
                "last_modified": Value::Null,
                "created_at": Value::Null,
                "installed": false,
            }),
            CatalogKind::Skill => serde_json::json!({
                "id": card.id,
                "source": self.display_name,
                "slug": card.id.rsplit('/').next().unwrap_or(&card.id),
                "name": card.name,
                "description": card.description,
                "installs": 0,
                "installed": false,
            }),
            CatalogKind::Mcp => serde_json::json!({
                "id": card.id,
                "name": card.name,
                "description": card.description,
                "version": card.version,
                "has_packages": false,
                "has_remotes": false,
                "transports": [],
                "installed": false,
            }),
            CatalogKind::Plugin => serde_json::json!({
                "id": card.id,
                "name": card.name,
                "description": card.description,
                "author": card.author,
                "version": card.version,
                "install_source": card.install_source,
                "installed": false,
            }),
            CatalogKind::Knowledge => serde_json::json!({
                "id": card.id,
                "name": card.name,
                "description": card.description,
                "author": card.author,
                "version": card.version,
                "install_source": card.install_source,
                "installed": false,
            }),
        }
    }

    /// Build the per-kind [`InstallDescriptor`] from a fetched detail document.
    /// Reads the server-stored `descriptor` object and maps it onto the same
    /// handoff shape the existing per-kind install routes consume.
    fn detail_to_descriptor(&self, id: &str, detail: &Value) -> Result<InstallDescriptor> {
        let descriptor = detail.get("descriptor").cloned().unwrap_or(Value::Null);
        match self.kind {
            CatalogKind::Model => {
                // Model: descriptor carries a `files: [{ url, sha256?,
                // dest_filename }]` list Core's `install_from_descriptor` reads.
                let mut files = Vec::new();
                if let Some(arr) = descriptor.get("files").and_then(|f| f.as_array()) {
                    for f in arr {
                        let Some(url) = f.get("url").and_then(|u| u.as_str()) else {
                            continue;
                        };
                        let dest = f
                            .get("dest_filename")
                            .and_then(|n| n.as_str())
                            .map(str::to_string)
                            .unwrap_or_else(|| url.rsplit('/').next().unwrap_or(url).to_string());
                        let sha256 = f
                            .get("sha256")
                            .and_then(|s| s.as_str())
                            .filter(|s| !s.is_empty())
                            .map(str::to_string);
                        files.push(DescriptorFile {
                            url: url.to_string(),
                            sha256,
                            dest_filename: dest,
                        });
                    }
                }
                if files.is_empty() {
                    bail!(
                        "Ryu Marketplace model `{id}` has no downloadable files in its descriptor"
                    );
                }
                Ok(InstallDescriptor {
                    kind: CatalogKind::Model,
                    source_id: self.id.clone(),
                    repo_id: id.to_string(),
                    files,
                    raw: detail.clone(),
                })
            }
            CatalogKind::Skill => {
                // Skill: descriptor carries an `install_source` repo string the
                // route feeds to Unit #462's from-source fetcher (no files).
                let install_source = descriptor
                    .get("install_source")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        anyhow::anyhow!("Ryu Marketplace skill `{id}` has no install_source")
                    })?
                    .to_string();
                Ok(InstallDescriptor {
                    kind: CatalogKind::Skill,
                    source_id: self.id.clone(),
                    repo_id: id.to_string(),
                    files: Vec::new(),
                    raw: serde_json::json!({ "install_source": install_source }),
                })
            }
            CatalogKind::Mcp => {
                // Mcp: descriptor is the resolved stdio/remote plan; carry it in
                // `raw` (the route reads `install_mcp`, below, for the plan).
                Ok(InstallDescriptor {
                    kind: CatalogKind::Mcp,
                    source_id: self.id.clone(),
                    repo_id: id.to_string(),
                    files: Vec::new(),
                    raw: descriptor,
                })
            }
            CatalogKind::Plugin => {
                // Plugin: no Core install path yet — surface the manifest only.
                Ok(InstallDescriptor {
                    kind: CatalogKind::Plugin,
                    source_id: self.id.clone(),
                    repo_id: id.to_string(),
                    files: Vec::new(),
                    raw: detail.clone(),
                })
            }
            CatalogKind::Knowledge => {
                // Knowledge: the descriptor carries the OKF bundle git source
                // (`{ source_url, ref?, bundle_id? }`); Core's privileged install
                // path clones + ingests it via `ingest_okf_bundle`. Surface the
                // server-stored descriptor when present, else the whole detail.
                Ok(InstallDescriptor {
                    kind: CatalogKind::Knowledge,
                    source_id: self.id.clone(),
                    repo_id: id.to_string(),
                    files: Vec::new(),
                    raw: if descriptor.is_null() {
                        detail.clone()
                    } else {
                        descriptor
                    },
                })
            }
        }
    }

    /// Resolve an MCP [`crate::mcp_catalog::InstallPlan`] from a fetched detail's
    /// descriptor (used by `install_mcp`). Mirrors the official source's plan:
    /// a `remote` descriptor → a Remote entry; a `stdio` descriptor → reuse
    /// #464's validated `plan_from_server` via a synthesized `ServerJson`.
    fn detail_to_mcp_plan(
        &self,
        id: &str,
        detail: &Value,
    ) -> Result<crate::mcp_catalog::InstallPlan> {
        let descriptor = detail.get("descriptor").unwrap_or(&Value::Null);
        let server_name = descriptor
            .get("server_name")
            .and_then(|v| v.as_str())
            .unwrap_or(id)
            .to_string();
        let description = descriptor
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let entry_kind = descriptor
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        match entry_kind {
            "remote" => {
                let url = descriptor
                    .get("url")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        anyhow::anyhow!("Ryu Marketplace mcp `{id}` remote descriptor has no url")
                    })?
                    .to_string();
                let server = crate::mcp_catalog::ServerJson::remote(server_name, description, url);
                crate::mcp_catalog::plan_from_server(&server)
            }
            "stdio" => {
                // Reuse #464's validated plan builder via a synthesized npm
                // package server so the same identifier / version validation runs
                // (no hand-built launch command). Marketplace stdio descriptors
                // therefore carry an npm `identifier` (+ optional `version`); a
                // non-npm stdio server is published as a hosted `remote` instead.
                let identifier = descriptor
                    .get("identifier")
                    .or_else(|| descriptor.get("package"))
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| {
                        anyhow::anyhow!(
                            "Ryu Marketplace mcp `{id}` stdio descriptor has no npm `identifier`"
                        )
                    })?
                    .to_string();
                let version = descriptor
                    .get("version")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string);
                let server = crate::mcp_catalog::ServerJson::npm_stdio(
                    server_name,
                    description,
                    identifier,
                    version,
                );
                crate::mcp_catalog::plan_from_server(&server)
            }
            other => bail!("Ryu Marketplace mcp `{id}` has unsupported descriptor kind `{other}`"),
        }
    }
}

impl CatalogSource for RyuMarketplaceSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        self.kind
    }

    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let limit = if q.limit == 0 { 40 } else { q.limit };
        match self.fetch_cards(client, &q.query, limit).await {
            Ok(cards) => {
                let values: Vec<Value> = cards.iter().map(|c| self.card_to_value(c)).collect();
                Ok(self.wrap_envelope(values, None))
            }
            // Degrade to an empty, labelled per-kind envelope (server unreachable
            // in dev, etc.) rather than erroring out the whole list — never panic.
            Err(e) => Ok(self.empty_envelope(&e.to_string())),
        }
    }

    /// Detail proxies the marketplace server payload verbatim (`{ id, kind, name,
    /// description, author, version, manifest, descriptor, installSource }`).
    /// Unlike the sibling sources, it does NOT re-map into a per-kind client-render
    /// shape (model `{card, files}`, skill `{card, readme, …}`): no Core-internal
    /// consumer reads `detail()` (install resolves the `descriptor` via
    /// `install_descriptor` / `install_mcp`, a separate fetch), and the per-kind
    /// client-render mapping is owned by the desktop/CLI clients (#469/#470). So
    /// proxying the raw payload is the deliberate first-party choice here.
    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        self.fetch_detail(client, id).await
    }

    async fn install_descriptor(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        let detail = self.fetch_detail(client, id).await?;
        // Verify-on-install (#468): reject a tampered manifest before mapping it
        // onto an install descriptor.
        self.verify_manifest_signature(client, id, &detail).await?;
        self.detail_to_descriptor(id, &detail)
    }
}

// ── OKF knowledge-bundle source (Knowledge kind) ─────────────────────────────

/// A **knowledge-bundle** source backing the `Knowledge` catalog kind. It points
/// at one Open Knowledge Format (OKF) bundle — a git-shippable directory of
/// markdown *concepts* — hosted at a git URL (`https://…`) or, in tests, a local
/// directory path. The opaque config shape (the shared contract) is
/// `{ format: "okf", source_url, ref? }`: `source_url` is the bundle location and
/// the optional `ref` is a git branch/tag/commit.
///
/// Seam discipline (Core vs Gateway): like every other source, this one only
/// resolves **descriptors**. `search`/`detail` load the bundle via the
/// [`crate::okf`] parser to list its concepts, and `install_descriptor` hands
/// Core the `{ source_url, ref, bundle_id }` it needs to clone + ingest the
/// bundle through the retrieval layer (`ingest_okf_bundle`) — the source itself
/// never writes to the index.
#[derive(Clone)]
pub struct OkfBundleSource {
    pub id: String,
    pub display_name: String,
    /// The OKF bundle location: a git URL (`https://…`) or a local directory.
    pub source_url: String,
    /// Optional git ref (branch/tag/commit). `None` ⇒ the default branch.
    pub git_ref: Option<String>,
}

impl OkfBundleSource {
    /// Load the configured bundle: a local directory via
    /// [`crate::okf::Bundle::from_dir`] (sync, off-thread), else a git clone via
    /// [`crate::okf::Bundle::from_git`]. Permissive parsing per the OKF contract —
    /// malformed concept files become bundle warnings, not a hard failure.
    pub async fn load_bundle(&self) -> Result<crate::okf::Bundle> {
        let url = self.source_url.trim().to_string();
        let path = std::path::Path::new(&url);
        if path.is_dir() {
            let p = path.to_path_buf();
            tokio::task::spawn_blocking(move || crate::okf::Bundle::from_dir(p))
                .await
                .map_err(|e| anyhow::anyhow!("loading OKF bundle task panicked: {e}"))?
        } else {
            crate::okf::Bundle::from_git(&url, self.git_ref.as_deref()).await
        }
    }

    /// Map one concept into a knowledge catalog card (the `id` is the concept's
    /// bundle-relative `file_path`, so detail can resolve it back).
    fn concept_to_card(&self, concept: &crate::okf::Concept) -> Value {
        serde_json::json!({
            "id": concept.file_path,
            "type": concept.type_,
            "title": concept.title.clone().unwrap_or_else(|| concept.file_path.clone()),
            "description": concept.description,
            "resource": concept.resource,
            "tags": concept.tags,
            "installed": false,
        })
    }

    /// The descriptor Core needs to clone + ingest this bundle. `id` is ignored
    /// (a knowledge source installs its whole bundle, not a single concept).
    fn bundle_descriptor(&self) -> InstallDescriptor {
        InstallDescriptor {
            kind: CatalogKind::Knowledge,
            source_id: self.id.clone(),
            repo_id: self.source_url.clone(),
            files: Vec::new(),
            raw: serde_json::json!({
                "format": "okf",
                "source_url": self.source_url,
                "ref": self.git_ref,
                "bundle_id": self.id,
            }),
        }
    }
}

impl CatalogSource for OkfBundleSource {
    fn id(&self) -> &str {
        &self.id
    }
    fn display_name(&self) -> &str {
        &self.display_name
    }
    fn kind(&self) -> CatalogKind {
        CatalogKind::Knowledge
    }

    async fn search(&self, _client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        // Loading the bundle can fail (unreachable git, etc.); degrade to an
        // empty, labelled envelope rather than erroring the whole list.
        let bundle = match self.load_bundle().await {
            Ok(b) => b,
            Err(e) => {
                return Ok(serde_json::json!({
                    "concepts": [],
                    "next_cursor": serde_json::Value::Null,
                    "note": e.to_string(),
                }));
            }
        };
        let needle = q.query.trim().to_ascii_lowercase();
        let limit = if q.limit == 0 { usize::MAX } else { q.limit };
        let concepts: Vec<Value> = bundle
            .concepts
            .iter()
            .filter(|c| {
                needle.is_empty()
                    || c.file_path.to_ascii_lowercase().contains(&needle)
                    || c.type_.to_ascii_lowercase().contains(&needle)
                    || c.title
                        .as_deref()
                        .is_some_and(|t| t.to_ascii_lowercase().contains(&needle))
                    || c.description
                        .as_deref()
                        .is_some_and(|d| d.to_ascii_lowercase().contains(&needle))
                    || c.tags
                        .iter()
                        .any(|t| t.to_ascii_lowercase().contains(&needle))
            })
            .take(limit)
            .map(|c| self.concept_to_card(c))
            .collect();
        Ok(serde_json::json!({
            "concepts": concepts,
            "next_cursor": serde_json::Value::Null,
        }))
    }

    async fn detail(&self, _client: &reqwest::Client, id: &str) -> Result<Value> {
        let bundle = self.load_bundle().await?;
        let concept = bundle
            .concepts
            .iter()
            .find(|c| c.file_path == id)
            .ok_or_else(|| {
                anyhow::anyhow!("concept `{id}` not found in OKF bundle {}", self.source_url)
            })?;
        // Serialize the concept verbatim (type/title/description/tags/body/links)
        // so a client can render it without a second fetch.
        Ok(serde_json::to_value(concept)?)
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        _id: &str,
    ) -> Result<InstallDescriptor> {
        // Descriptor only — Core clones + ingests the bundle in the privileged
        // install path. The descriptor carries the git source the route needs.
        Ok(self.bundle_descriptor())
    }
}

/// Closed enum of concrete sources, dispatched by match. This is the
/// object-safe substitute for `dyn CatalogSource` (no `async-trait` dep).
#[derive(Clone)]
pub enum Source {
    Hf(HfSource),
    ModelIndex(ModelIndexSource),
    SkillsSh(SkillsShSource),
    Marketplace(MarketplaceSource),
    OfficialMcp(OfficialMcpSource),
    Smithery(SmitherySource),
    RyuHostedMcp(RyuHostedMcpSource),
    RyuMarketplace(RyuMarketplaceSource),
    OkfBundle(OkfBundleSource),
    Stub(StubSource),
}

impl Source {
    pub fn id(&self) -> &str {
        match self {
            Source::Hf(s) => s.id(),
            Source::ModelIndex(s) => s.id(),
            Source::SkillsSh(s) => s.id(),
            Source::Marketplace(s) => s.id(),
            Source::OfficialMcp(s) => s.id(),
            Source::Smithery(s) => s.id(),
            Source::RyuHostedMcp(s) => s.id(),
            Source::RyuMarketplace(s) => s.id(),
            Source::OkfBundle(s) => s.id(),
            Source::Stub(s) => s.id(),
        }
    }
    pub fn display_name(&self) -> &str {
        match self {
            Source::Hf(s) => s.display_name(),
            Source::ModelIndex(s) => s.display_name(),
            Source::SkillsSh(s) => s.display_name(),
            Source::Marketplace(s) => s.display_name(),
            Source::OfficialMcp(s) => s.display_name(),
            Source::Smithery(s) => s.display_name(),
            Source::RyuHostedMcp(s) => s.display_name(),
            Source::RyuMarketplace(s) => s.display_name(),
            Source::OkfBundle(s) => s.display_name(),
            Source::Stub(s) => s.display_name(),
        }
    }
    pub fn kind(&self) -> CatalogKind {
        match self {
            Source::Hf(s) => s.kind(),
            Source::ModelIndex(s) => s.kind(),
            Source::SkillsSh(s) => s.kind(),
            Source::Marketplace(s) => s.kind(),
            Source::OfficialMcp(s) => s.kind(),
            Source::Smithery(s) => s.kind(),
            Source::RyuHostedMcp(s) => s.kind(),
            Source::RyuMarketplace(s) => s.kind(),
            Source::OkfBundle(s) => s.kind(),
            Source::Stub(s) => s.kind(),
        }
    }
    /// The base URL for custom model sources, if any (surfaced in the `GET`
    /// listing so a client can show where a custom source points). For an HF
    /// source this is the HF-compatible API base; for a model-index source it
    /// is the index JSON URL.
    pub fn base_url(&self) -> Option<&str> {
        match self {
            Source::Hf(s) => s.base_url.as_deref(),
            Source::ModelIndex(s) => Some(&s.index_url),
            Source::Marketplace(s) => Some(&s.repo_url),
            Source::OfficialMcp(s) => s.base_url.as_deref(),
            // Smithery is host-fixed (the API key is strict-host scoped) so it
            // surfaces no base URL. Ryu-hosted surfaces its (optional) index URL.
            Source::RyuHostedMcp(s) => s.index_url.as_deref(),
            // Ryu Marketplace surfaces its (optional) API base override.
            Source::RyuMarketplace(s) => s.base_url.as_deref(),
            // A knowledge bundle surfaces its OKF source URL (git/local).
            Source::OkfBundle(s) => Some(&s.source_url),
            Source::Smithery(_) | Source::SkillsSh(_) | Source::Stub(_) => None,
        }
    }

    pub async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        match self {
            Source::Hf(s) => s.search(client, q).await,
            Source::ModelIndex(s) => s.search(client, q).await,
            Source::SkillsSh(s) => s.search(client, q).await,
            Source::Marketplace(s) => s.search(client, q).await,
            Source::OfficialMcp(s) => s.search(client, q).await,
            Source::Smithery(s) => s.search(client, q).await,
            Source::RyuHostedMcp(s) => s.search(client, q).await,
            Source::RyuMarketplace(s) => s.search(client, q).await,
            Source::OkfBundle(s) => s.search(client, q).await,
            Source::Stub(s) => s.search(client, q).await,
        }
    }
    pub async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        match self {
            Source::Hf(s) => s.detail(client, id).await,
            Source::ModelIndex(s) => s.detail(client, id).await,
            Source::SkillsSh(s) => s.detail(client, id).await,
            Source::Marketplace(s) => s.detail(client, id).await,
            Source::OfficialMcp(s) => s.detail(client, id).await,
            Source::Smithery(s) => s.detail(client, id).await,
            Source::RyuHostedMcp(s) => s.detail(client, id).await,
            Source::RyuMarketplace(s) => s.detail(client, id).await,
            Source::OkfBundle(s) => s.detail(client, id).await,
            Source::Stub(s) => s.detail(client, id).await,
        }
    }
    pub async fn install_descriptor(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        match self {
            Source::Hf(s) => s.install_descriptor(client, id).await,
            Source::ModelIndex(s) => s.install_descriptor(client, id).await,
            Source::SkillsSh(s) => s.install_descriptor(client, id).await,
            Source::Marketplace(s) => s.install_descriptor(client, id).await,
            Source::OfficialMcp(s) => s.install_descriptor(client, id).await,
            Source::Smithery(s) => s.install_descriptor(client, id).await,
            Source::RyuHostedMcp(s) => s.install_descriptor(client, id).await,
            Source::RyuMarketplace(s) => s.install_descriptor(client, id).await,
            Source::OkfBundle(s) => s.install_descriptor(client, id).await,
            Source::Stub(s) => s.install_descriptor(client, id).await,
        }
    }

    /// Source-aware MCP install (#464). An MCP install is not a file download; it
    /// resolves a validated launch command (stdio) or remote URL and writes a
    /// `~/.ryu/mcp.json` entry the [`crate::sidecar::mcp::McpRegistry`] then
    /// hot-loads. The privileged write itself lives in Core's route; here we only
    /// resolve the install plan (never launch). Returns `Ok(None)` for a non-MCP
    /// source so the caller can fall back to another install path.
    pub async fn install_mcp(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<Option<crate::mcp_catalog::InstallPlan>> {
        match self {
            Source::OfficialMcp(s) => Ok(Some(
                crate::mcp_catalog::plan_install(s.base_url.as_deref(), id).await?,
            )),
            // Smithery + Ryu-hosted resolve their own server data, then reuse
            // #464's `plan_from_server` for identical validation. The route's
            // write-disabled + hot-reload path is keyed on the returned plan.
            Source::Smithery(s) => {
                let key = s.resolved_key(None);
                let detail = s.fetch_detail(key, id).await?;
                let server = SmitherySource::detail_to_server_json(&detail)?;
                Ok(Some(crate::mcp_catalog::plan_from_server(&server)?))
            }
            Source::RyuHostedMcp(s) => {
                let servers = s.load_servers().await;
                let server = servers.iter().find(|sv| sv.name == id).ok_or_else(|| {
                    anyhow::anyhow!("MCP server `{id}` not found in Ryu-hosted index")
                })?;
                Ok(Some(crate::mcp_catalog::plan_from_server(server)?))
            }
            // Ryu Marketplace spans 4 kinds: only an Mcp-kind source resolves an
            // MCP plan. A model/skill/plugin marketplace source returns None so
            // the route never installs it down the MCP path (the crux guard).
            Source::RyuMarketplace(s) if s.kind == CatalogKind::Mcp => {
                let detail = s.fetch_detail(_client, id).await?;
                // Verify-on-install (#468) on the MCP path too (it bypasses
                // install_descriptor), so a tampered MCP manifest is rejected.
                s.verify_manifest_signature(_client, id, &detail).await?;
                Ok(Some(s.detail_to_mcp_plan(id, &detail)?))
            }
            _ => Ok(None),
        }
    }

    /// Source-aware Skill install (#463). Skills are not a single checksummed
    /// file download, so the seam's [`install_descriptor`](Self::install_descriptor)
    /// can't carry them; instead Core's skill-install route dispatches here:
    /// - **skills.sh**: reuse the existing
    ///   [`crate::skills_catalog::install_skill`] (the `owner/repo/slug` path).
    /// - **marketplace**: resolve the item's repo+subdir source string and run it
    ///   through Unit #462's
    ///   [`crate::skills_catalog::from_source::install_from_source`] fetcher.
    ///
    /// Returns `Ok(None)` for a non-skill source so the caller can fall back to
    /// the file-descriptor install path.
    pub async fn install_skill(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Result<Option<crate::skills_catalog::InstallResult>> {
        match self {
            Source::SkillsSh(_) => Ok(Some(
                crate::skills_catalog::install_skill(client, id).await?,
            )),
            Source::Marketplace(s) => {
                let descriptor = s.install_descriptor(client, id).await?;
                let install_source = descriptor
                    .raw
                    .get("install_source")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        anyhow::anyhow!("marketplace item `{id}` has no install source")
                    })?
                    .to_string();
                Ok(Some(
                    crate::skills_catalog::from_source::install_from_source(
                        client,
                        &install_source,
                    )
                    .await?,
                ))
            }
            // Ryu Marketplace spans 4 kinds: only a Skill-kind source installs a
            // skill. A model/mcp/plugin marketplace source returns None so the
            // route never installs it down the skill path (the crux guard). The
            // descriptor's `install_source` feeds Unit #462's from-source fetcher.
            Source::RyuMarketplace(s) if s.kind == CatalogKind::Skill => {
                let descriptor = s.install_descriptor(client, id).await?;
                let install_source = descriptor
                    .raw
                    .get("install_source")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        anyhow::anyhow!("marketplace skill `{id}` has no install source")
                    })?
                    .to_string();
                Ok(Some(
                    crate::skills_catalog::from_source::install_from_source(
                        client,
                        &install_source,
                    )
                    .await?,
                ))
            }
            _ => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_INDEX: &str = r#"[
        { "name": "gemma-4-E2B-it-Q4_K_M.gguf",
          "download_url": "https://models.example/gemma-q4.gguf",
          "sha": "abc123", "size": 3221225472 },
        { "name": "phi-mini-Q8_0.gguf",
          "download_url": "https://models.example/phi-q8.gguf",
          "size": 4000000000 }
    ]"#;

    fn source() -> ModelIndexSource {
        ModelIndexSource {
            id: "my-index".to_string(),
            display_name: "My Models".to_string(),
            index_url: "https://models.example/index.json".to_string(),
        }
    }

    #[test]
    fn parses_index_into_cards_and_descriptors() {
        let entries = parse_index(SAMPLE_INDEX.as_bytes()).expect("parse index");
        assert_eq!(entries.len(), 2);

        let src = source();

        // First entry: full detail card maps to the desktop ModelCard/GgufFile shape.
        let detail = src.entry_to_detail(&entries[0]);
        assert_eq!(detail["card"]["id"], "gemma-4-E2B-it-Q4_K_M.gguf");
        assert_eq!(detail["card"]["author"], "My Models");
        let file0 = &detail["files"][0];
        assert_eq!(file0["url"], "https://models.example/gemma-q4.gguf");
        assert_eq!(file0["sha256"], "abc123");
        assert_eq!(file0["size_bytes"], 3_221_225_472u64);
        assert!(file0["size_human"].as_str().is_some_and(|s| !s.is_empty()));

        // Descriptor carries url + sha + dest_filename; no download happens here.
        let d0 = src.entry_to_descriptor(&entries[0]);
        assert_eq!(d0.kind, CatalogKind::Model);
        assert_eq!(d0.repo_id, "gemma-4-E2B-it-Q4_K_M.gguf");
        assert_eq!(d0.files.len(), 1);
        assert_eq!(d0.files[0].url, "https://models.example/gemma-q4.gguf");
        assert_eq!(d0.files[0].sha256.as_deref(), Some("abc123"));
        assert_eq!(d0.files[0].dest_filename, "gemma-4-E2B-it-Q4_K_M.gguf");

        // Second entry: missing sha → None (verification disabled, never panics).
        let d1 = src.entry_to_descriptor(&entries[1]);
        assert_eq!(d1.files[0].sha256, None);
        assert_eq!(d1.files[0].dest_filename, "phi-mini-Q8_0.gguf");
    }

    #[test]
    fn rejects_malformed_index() {
        assert!(parse_index(b"not json").is_err());
        // Missing required fields (name/download_url) is a parse error, not a panic.
        assert!(parse_index(br#"[{ "size": 1 }]"#).is_err());
    }

    // ── Marketplace adapter (#463) ────────────────────────────────────────────

    const SAMPLE_MARKETPLACE: &str = r#"{
        "name": "acme-marketplace",
        "owner": { "name": "Acme" },
        "plugins": [
            {
                "name": "code-tools",
                "description": "Coding helpers",
                "source": "acme/code-tools",
                "skills": ["./skills/lint", "skills/format"]
            },
            {
                "name": "solo-skill",
                "description": "A single skill repo",
                "source": { "source": "github", "repo": "acme/solo" }
            },
            {
                "name": "broken",
                "description": "no resolvable source"
            }
        ]
    }"#;

    #[test]
    fn marketplace_manifest_url_forms() {
        assert_eq!(
            marketplace_manifest_url("owner/repo"),
            "https://raw.githubusercontent.com/owner/repo/HEAD/.claude-plugin/marketplace.json"
        );
        assert_eq!(
            marketplace_manifest_url("https://github.com/owner/repo"),
            "https://raw.githubusercontent.com/owner/repo/HEAD/.claude-plugin/marketplace.json"
        );
        assert_eq!(
            marketplace_manifest_url("https://github.com/owner/repo.git"),
            "https://raw.githubusercontent.com/owner/repo/HEAD/.claude-plugin/marketplace.json"
        );
        // A direct .json URL is used verbatim.
        assert_eq!(
            marketplace_manifest_url("https://example.com/custom/marketplace.json"),
            "https://example.com/custom/marketplace.json"
        );
    }

    #[test]
    fn flattens_plugins_into_skill_items() {
        let manifest = parse_marketplace(SAMPLE_MARKETPLACE.as_bytes()).expect("parse");
        let items = flatten_plugins(&manifest);
        // 2 skills from code-tools + 1 from solo-skill; broken (no source) skipped.
        assert_eq!(items.len(), 3);

        let lint = items
            .iter()
            .find(|i| i.id == "code-tools/lint")
            .expect("lint item");
        assert_eq!(lint.plugin, "code-tools");
        assert_eq!(
            lint.install_source,
            "https://github.com/acme/code-tools/tree/HEAD/skills/lint"
        );
        assert_eq!(lint.description.as_deref(), Some("Coding helpers"));

        // The `./` prefix is stripped before building the subdir URL.
        let fmt = items
            .iter()
            .find(|i| i.id == "code-tools/format")
            .expect("format item");
        assert_eq!(
            fmt.install_source,
            "https://github.com/acme/code-tools/tree/HEAD/skills/format"
        );

        // A plugin with no explicit skills surfaces as a single item at the repo root.
        let solo = items
            .iter()
            .find(|i| i.id == "solo-skill")
            .expect("solo item");
        assert_eq!(solo.install_source, "acme/solo");

        // The broken plugin (unresolvable source) is skipped, never panics.
        assert!(!items.iter().any(|i| i.plugin == "broken"));
    }

    #[test]
    fn rejects_malformed_marketplace() {
        assert!(parse_marketplace(b"not json").is_err());
        // An empty object parses (no plugins) rather than panicking.
        let empty = parse_marketplace(b"{}").expect("empty object parses");
        assert!(flatten_plugins(&empty).is_empty());
    }

    #[test]
    fn plugin_source_string_handles_string_and_object() {
        assert_eq!(
            plugin_source_string(&serde_json::json!("owner/repo")).as_deref(),
            Some("owner/repo")
        );
        assert_eq!(
            plugin_source_string(&serde_json::json!({ "repo": "owner/repo" })).as_deref(),
            Some("owner/repo")
        );
        assert_eq!(
            plugin_source_string(&serde_json::json!({ "url": "https://example.com/r.git" }))
                .as_deref(),
            Some("https://example.com/r.git")
        );
        assert_eq!(plugin_source_string(&serde_json::json!(null)), None);
        assert_eq!(plugin_source_string(&serde_json::json!({})), None);
    }

    // ── Smithery + Ryu-hosted MCP sources (#465) ──────────────────────────────

    const SAMPLE_SMITHERY_DETAIL: &str = r#"{
        "qualifiedName": "@acme/weather",
        "displayName": "Weather",
        "description": "Hosted weather MCP server",
        "deploymentUrl": "https://server.smithery.ai/@acme/weather/mcp",
        "connections": [
            { "type": "http", "url": "https://server.smithery.ai/@acme/weather/mcp" }
        ]
    }"#;

    #[test]
    fn smithery_detail_maps_to_remote_plan() {
        let detail: SmitheryServerDetail =
            serde_json::from_str(SAMPLE_SMITHERY_DETAIL).expect("parse smithery detail");
        let server = SmitherySource::detail_to_server_json(&detail).expect("map to server json");
        // Reuses #464's validated plan builder → a Remote entry with the hosted URL.
        let plan = crate::mcp_catalog::plan_from_server(&server).expect("plan");
        assert_eq!(plan.server_name, "@acme/weather");
        assert_eq!(
            plan.entry,
            crate::mcp_catalog::McpEntryPlan::Remote {
                url: "https://server.smithery.ai/@acme/weather/mcp".to_string(),
            }
        );
    }

    #[test]
    fn smithery_stdio_only_server_reports_no_installable_url() {
        // A server with no deploymentUrl and no connection url cannot be installed
        // (Smithery's API carries no package identifier for stdio) — a clear error,
        // never a panic.
        let detail = SmitheryServerDetail {
            qualified_name: "@acme/local".to_string(),
            display_name: Some("Local".to_string()),
            description: None,
            deployment_url: None,
            connections: vec![SmitheryConnection {
                connection_type: Some("stdio".to_string()),
                url: None,
            }],
        };
        assert!(SmitherySource::detail_to_server_json(&detail).is_err());
    }

    #[test]
    fn smithery_bad_list_json_degrades_to_empty_note() {
        // Tolerant parse: a malformed list body is a serde error inside fetch_list,
        // and search turns any error into an empty, labelled result (never panics).
        let bad: std::result::Result<SmitheryListEnvelope, _> = serde_json::from_slice(b"not json");
        assert!(bad.is_err());
    }

    #[test]
    fn smithery_search_without_key_is_empty_with_note() {
        // No key (and no env): search degrades to `{ servers: [], note }`.
        let src = SmitherySource {
            id: "smithery".to_string(),
            display_name: "Smithery".to_string(),
            api_key: None,
        };
        let client = reqwest::Client::new();
        let q = CatalogQuery::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let value = rt.block_on(src.search(&client, &q)).expect("search ok");
        assert_eq!(value["servers"].as_array().map(Vec::len), Some(0));
        assert!(value["note"]
            .as_str()
            .is_some_and(|n| n.contains("API key")));
    }

    #[test]
    fn ryu_hosted_static_list_is_non_empty_and_all_plannable() {
        // The built-in curated index parses (it is the official server.json
        // envelope shape) and every entry maps to a valid InstallPlan via #464.
        let servers = crate::mcp_catalog::parse_server_list(RYU_HOSTED_CURATED_INDEX.as_bytes())
            .expect("curated index parses");
        assert!(!servers.is_empty());
        for server in &servers {
            let plan = crate::mcp_catalog::plan_from_server(server)
                .unwrap_or_else(|e| panic!("server {} should plan: {e}", server.name));
            // All curated entries are stdio npm/pypi packages.
            assert!(matches!(
                plan.entry,
                crate::mcp_catalog::McpEntryPlan::Stdio { .. }
            ));
        }
    }

    // ── Ryu Marketplace source (#467) ─────────────────────────────────────────

    #[test]
    fn ryu_marketplace_search_unreachable_degrades_per_kind() {
        // An unreachable base URL must NOT error the list: search degrades to the
        // correct per-kind envelope with a note (mirrors smithery_search_without_key).
        // A short connect timeout keeps the test fast (TEST-NET-1 never answers).
        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_millis(200))
            .timeout(std::time::Duration::from_millis(500))
            .build()
            .unwrap();
        let q = CatalogQuery::default();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        // A guaranteed-unreachable base (RFC 5737 TEST-NET-1, port closed).
        let base = "http://192.0.2.1:1".to_string();
        let cases = [
            (CatalogKind::Model, "models"),
            (CatalogKind::Skill, "skills"),
            (CatalogKind::Mcp, "servers"),
            (CatalogKind::Plugin, "items"),
        ];
        for (kind, key) in cases {
            let src = RyuMarketplaceSource {
                id: "ryu-marketplace".to_string(),
                display_name: "Ryu Marketplace".to_string(),
                kind,
                base_url: Some(base.clone()),
            };
            let value = rt.block_on(src.search(&client, &q)).expect("search ok");
            assert_eq!(
                value[key].as_array().map(Vec::len),
                Some(0),
                "kind {kind} should have an empty `{key}` array"
            );
            assert!(
                value["note"].as_str().is_some(),
                "kind {kind} should carry a degrade note"
            );
        }
    }

    #[test]
    fn ryu_marketplace_search_envelope_maps_cards_per_kind() {
        // The happy path: a server `/catalog` body deserializes into cards, each
        // maps via `card_to_value`, and `wrap_envelope` emits the per-kind key the
        // matching desktop tab reads (models/skills/servers/items).
        const BODY: &str = r#"{ "kind": "skill", "items": [
            { "id": "owner/foo", "name": "Foo Skill", "description": "does foo",
              "author": "Acme", "version": "1.0.0", "installSource": "owner/foo" }
        ] }"#;
        let env: MarketplaceListEnvelope = serde_json::from_str(BODY).expect("parse catalog body");
        assert_eq!(env.items.len(), 1);

        let cases = [
            (CatalogKind::Model, "models"),
            (CatalogKind::Skill, "skills"),
            (CatalogKind::Mcp, "servers"),
            (CatalogKind::Plugin, "items"),
        ];
        for (kind, key) in cases {
            let src = RyuMarketplaceSource::builtin(kind);
            let cards: Vec<Value> = env.items.iter().map(|c| src.card_to_value(c)).collect();
            let value = src.wrap_envelope(cards, None);
            let arr = value[key].as_array().expect("per-kind array present");
            assert_eq!(arr.len(), 1, "kind {kind} → key `{key}`");
            assert_eq!(arr[0]["id"], "owner/foo");
            assert_eq!(arr[0]["name"], "Foo Skill");
            // No `note` on the success path.
            assert!(value.get("note").is_none());
        }
    }

    #[test]
    fn ryu_marketplace_resolve_base_prefers_explicit_then_default() {
        // Explicit base wins and is trailing-slash-trimmed.
        let src = RyuMarketplaceSource {
            id: "ryu-marketplace".to_string(),
            display_name: "Ryu Marketplace".to_string(),
            kind: CatalogKind::Skill,
            base_url: Some("https://market.example/".to_string()),
        };
        assert_eq!(src.resolve_base(), "https://market.example");

        // With no explicit base and no env override, the localhost dev default.
        if std::env::var(RYU_MARKETPLACE_API_ENV).is_err() {
            let default_src = RyuMarketplaceSource::builtin(CatalogKind::Plugin);
            assert_eq!(default_src.resolve_base(), RYU_MARKETPLACE_DEFAULT_BASE);
        }
    }

    #[test]
    fn ryu_marketplace_descriptor_maps_per_kind() {
        let client_id = "ryu-marketplace";
        // Skill: descriptor.install_source → raw.install_source (no files).
        let skill = RyuMarketplaceSource::builtin(CatalogKind::Skill);
        let skill_detail = serde_json::json!({
            "descriptor": { "install_source": "owner/repo/tree/HEAD/skills/foo" }
        });
        let d = skill
            .detail_to_descriptor("owner/foo", &skill_detail)
            .expect("skill descriptor");
        assert_eq!(d.kind, CatalogKind::Skill);
        assert_eq!(d.source_id, client_id);
        assert!(d.files.is_empty());
        assert_eq!(
            d.raw.get("install_source").and_then(|v| v.as_str()),
            Some("owner/repo/tree/HEAD/skills/foo")
        );

        // Model: descriptor.files → DescriptorFile list.
        let model = RyuMarketplaceSource::builtin(CatalogKind::Model);
        let model_detail = serde_json::json!({
            "descriptor": { "files": [
                { "url": "https://m.example/x.gguf", "sha256": "abc", "dest_filename": "x.gguf" }
            ] }
        });
        let dm = model
            .detail_to_descriptor("x", &model_detail)
            .expect("model descriptor");
        assert_eq!(dm.files.len(), 1);
        assert_eq!(dm.files[0].url, "https://m.example/x.gguf");
        assert_eq!(dm.files[0].sha256.as_deref(), Some("abc"));

        // Mcp: a stdio npm descriptor maps through #464's validated plan builder.
        let mcp = RyuMarketplaceSource::builtin(CatalogKind::Mcp);
        let mcp_detail = serde_json::json!({
            "descriptor": {
                "kind": "stdio",
                "server_name": "io.acme/mem",
                "identifier": "@modelcontextprotocol/server-memory",
                "version": "latest"
            }
        });
        let plan = mcp
            .detail_to_mcp_plan("io.acme/mem", &mcp_detail)
            .expect("mcp plan");
        assert_eq!(plan.server_name, "io.acme/mem");
        assert!(matches!(
            plan.entry,
            crate::mcp_catalog::McpEntryPlan::Stdio { .. }
        ));
    }

    #[tokio::test]
    async fn verify_on_install_allows_unsigned_item() {
        // Verify-on-install (#468): an item with no signature (e.g. a first-party
        // seed) is allowed without any gateway call. Absent != tampered. This
        // exercises the early-return branch with no network access.
        let src = RyuMarketplaceSource::builtin(CatalogKind::Skill);
        let client = reqwest::Client::new();
        let detail = serde_json::json!({
            "manifest": { "id": "owner/skill", "version": "1.0.0" }
            // no `signature` field
        });
        let r = src
            .verify_manifest_signature(&client, "owner/skill", &detail)
            .await;
        assert!(r.is_ok(), "unsigned item should install unverified");
    }

    // ── OKF knowledge-bundle source (Knowledge kind) ──────────────────────────

    /// Write a tiny OKF bundle (two concepts + a non-conforming file) into a temp
    /// dir for the local-path source tests.
    fn write_sample_bundle() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::write(
            dir.path().join("orders.md"),
            "---\ntype: BigQuery Table\ntitle: Orders\ndescription: The orders fact table\ntags: [sales, warehouse]\n---\n# Schema\nSee [revenue](/metrics/revenue.md).\n",
        )
        .unwrap();
        let metrics = dir.path().join("metrics");
        std::fs::create_dir_all(&metrics).unwrap();
        std::fs::write(
            metrics.join("revenue.md"),
            "---\ntype: Metric\ntitle: Revenue\n---\nTotal revenue.\n",
        )
        .unwrap();
        // A file with no frontmatter is skipped (permissive), never a hard fail.
        std::fs::write(dir.path().join("README.md"), "just prose, no frontmatter\n").unwrap();
        dir
    }

    fn okf_source(path: &std::path::Path) -> OkfBundleSource {
        OkfBundleSource {
            id: "team-kb".to_string(),
            display_name: "Team Knowledge".to_string(),
            source_url: path.to_string_lossy().to_string(),
            git_ref: None,
        }
    }

    #[tokio::test]
    async fn okf_source_search_lists_concepts_and_filters() {
        let dir = write_sample_bundle();
        let src = okf_source(dir.path());
        let client = reqwest::Client::new();

        // Unfiltered: both conforming concepts, README skipped (no frontmatter).
        let all = src
            .search(&client, &CatalogQuery::default())
            .await
            .expect("search");
        let concepts = all["concepts"].as_array().expect("concepts array");
        assert_eq!(concepts.len(), 2);

        // Filter by a tag substring → only the orders table.
        let q = CatalogQuery {
            query: "warehouse".to_string(),
            ..Default::default()
        };
        let filtered = src.search(&client, &q).await.expect("search");
        let arr = filtered["concepts"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["id"], "orders.md");
        assert_eq!(arr[0]["type"], "BigQuery Table");
    }

    #[tokio::test]
    async fn okf_source_detail_resolves_concept_and_descriptor_is_bundle() {
        let dir = write_sample_bundle();
        let src = okf_source(dir.path());
        let client = reqwest::Client::new();

        // Detail resolves the concept by its bundle-relative file_path.
        let detail = src
            .detail(&client, "metrics/revenue.md")
            .await
            .expect("detail");
        assert_eq!(detail["type"], "Metric");
        assert_eq!(detail["title"], "Revenue");

        // A missing concept is a clear error, never a panic.
        assert!(src.detail(&client, "nope.md").await.is_err());

        // install_descriptor returns the WHOLE-bundle handoff (no files), with the
        // OKF git source Core needs to clone + ingest. `id` is ignored.
        let d = src
            .install_descriptor(&client, "ignored")
            .await
            .expect("descriptor");
        assert_eq!(d.kind, CatalogKind::Knowledge);
        assert_eq!(d.source_id, "team-kb");
        assert!(d.files.is_empty());
        assert_eq!(d.raw["format"], "okf");
        assert_eq!(d.raw["source_url"], src.source_url);
        assert_eq!(d.raw["bundle_id"], "team-kb");
    }

    #[tokio::test]
    async fn okf_source_search_unreachable_degrades_to_empty_note() {
        // A non-existent local path is treated as a git URL; the clone fails and
        // search degrades to an empty, labelled envelope (never panics/errors).
        let src = OkfBundleSource {
            id: "broken".to_string(),
            display_name: "Broken".to_string(),
            source_url: "/this/path/does/not/exist-okf".to_string(),
            git_ref: None,
        };
        let client = reqwest::Client::new();
        let value = src
            .search(&client, &CatalogQuery::default())
            .await
            .expect("search degrades");
        assert_eq!(value["concepts"].as_array().map(Vec::len), Some(0));
        assert!(value["note"].as_str().is_some());
    }

    #[test]
    fn ryu_hosted_default_index_url_is_built_in() {
        // With no explicit index_url and no env override, the source uses the
        // built-in static list (resolve_index_url is None).
        let src = RyuHostedMcpSource::builtin();
        // Note: this reads the env var; in CI it is unset, so expect None.
        if std::env::var(RYU_HOSTED_MCP_INDEX_ENV).is_err() {
            assert!(src.resolve_index_url().is_none());
        }
    }
}
