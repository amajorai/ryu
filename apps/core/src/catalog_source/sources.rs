//! Concrete [`CatalogSource`] implementations and their enum-dispatch wrapper.
//!
//! Dispatch design: the project has no `async-trait` dep, so a trait with
//! native `async fn` methods is *not* object-safe (`Box<dyn CatalogSource>`
//! won't compile). Instead we store sources heterogeneously in a small closed
//! [`Source`] enum and match-dispatch each call. Custom model sources collapse
//! into `Hf` with a `base_url` override — no new variant needed.

use anyhow::{bail, Context, Result};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use super::agent_registry::AgentRegistrySource;
use super::github_topic::GithubTopicSource;
use super::skill_registries::{
    BrowseShSource, ClawHubSource, GithubTapSource, LobeHubSource, WellKnownSource,
};
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

    async fn guarded_client(&self) -> Result<reqwest::Client> {
        let endpoint = self.endpoint();
        let (client, _) = crate::server::guarded_client(&endpoint.api_base)
            .await
            .map_err(|error| anyhow::anyhow!(error))?;
        Ok(client)
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

    async fn search(&self, _client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let client = self.guarded_client().await?;
        // Per-kind params ride in `extra`: HF understands `task`, `author`, and
        // the weight `format` facet (defaults to GGUF).
        let task = q.extra_str("task");
        let author = q.extra_str("author");
        let sort = crate::model_catalog::CatalogSort::parse(q.extra_str("sort"));
        let format = crate::model_format::ModelFormat::from_wire(q.extra_str("format"));
        crate::model_catalog::search_models_json(
            &client,
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

    async fn detail(&self, _client: &reqwest::Client, id: &str) -> Result<Value> {
        let client = self.guarded_client().await?;
        // The federated detail path stays GGUF (seam snapshots are out of scope);
        // the main /api/models route carries the format facet for snapshots.
        crate::model_catalog::model_detail_json(
            &client,
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
    /// The catalog kind this git marketplace serves. A Claude plugin
    /// marketplace can be surfaced as a Skill catalog (each plugin's `skills`
    /// paths become items) or a Plugin catalog (each plugin becomes an item);
    /// the kind drives the search envelope key and the install descriptor kind.
    pub kind: CatalogKind,
    /// Optional auth for a PRIVATE marketplace (shadcn model): a bearer token
    /// and/or arbitrary headers, each value a literal or a `${ENV_VAR}` template
    /// resolved from `std::env` at fetch time. Never resolved at rest, never
    /// logged. `None` ⇒ a public marketplace fetched with no credentials.
    pub auth: Option<SourceAuth>,
}

/// Auth attached to a PRIVATE custom marketplace (Phase 5c), modelled on
/// shadcn's `headers: { Authorization: "Bearer ${TOKEN}" }`. Each value may be a
/// literal or a `${ENV_VAR}` template; templates are resolved from `std::env`
/// **at fetch time only** (never persisted resolved). The persisted shape stores
/// the template/literal the user supplied — the strong recommendation is env
/// indirection so no secret is ever written to disk.
///
/// Security invariants (scrutinised by review):
/// - `Debug` is hand-written to **redact** every value, so a literal token never
///   leaks through a spec/source debug print or a `tracing` line.
/// - resolution goes through `std::env::var` ONLY (no arbitrary memory read); an
///   unset referenced var **fails closed** (no fetch) rather than sending a
///   literal `${VAR}` or an empty credential.
/// - the token/header value is never echoed in any API response (listings carry
///   only a redacted `hasAuth` boolean).
#[derive(Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct SourceAuth {
    /// Optional bearer token. Sent as `Authorization: Bearer <resolved>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bearer: Option<String>,
    /// Arbitrary extra request headers (name → value). Values may be
    /// `${ENV_VAR}` templates. A `BTreeMap` keeps the persisted order stable.
    #[serde(default, skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub headers: std::collections::BTreeMap<String, String>,
}

impl SourceAuth {
    /// True when this carries any credential material (bearer or a header). Used
    /// to surface a redacted `hasAuth` flag without exposing the value.
    fn is_present(&self) -> bool {
        self.bearer.as_ref().is_some_and(|b| !b.trim().is_empty()) || !self.headers.is_empty()
    }

    /// Resolve the concrete request headers to attach, interpolating any
    /// `${ENV_VAR}` templates from the process environment **now**. Fails closed:
    /// a referenced-but-unset env var, or a bearer that resolves empty, returns
    /// `Err` so the caller never fetches with an unresolved/empty credential. The
    /// returned values are transient (never stored, never logged).
    pub(crate) fn resolve_headers(&self) -> Result<Vec<(String, String)>> {
        // A value still in its sealed envelope here is one Core could not open
        // (missing or wrong key): never send ciphertext as a credential.
        if self
            .bearer
            .iter()
            .chain(self.headers.values())
            .any(|value| ryu_crypto::looks_sealed(value))
        {
            bail!(
                "custom marketplace credential is sealed and could not be opened; refusing to fetch (fail-closed)"
            );
        }
        let mut out = Vec::new();
        if let Some(bearer) = &self.bearer {
            let token = interpolate_env(bearer)?;
            let token = token.trim();
            if token.is_empty() {
                bail!(
                    "custom marketplace bearer token resolved to empty; refusing to fetch (fail-closed)"
                );
            }
            out.push(("Authorization".to_string(), format!("Bearer {token}")));
        }
        for (name, value) in &self.headers {
            if name.trim().is_empty() {
                continue;
            }
            let resolved = interpolate_env(value)?;
            out.push((name.clone(), resolved));
        }
        Ok(out)
    }
}

// Redacting Debug: `CustomSourceSpec` derives `Debug`, so without this a literal
// token would leak through any spec/source debug print. Values are NEVER shown.
impl std::fmt::Debug for SourceAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceAuth")
            .field("bearer", &self.bearer.as_ref().map(|_| "<redacted>"))
            .field(
                "headers",
                &self
                    .headers
                    .keys()
                    .map(|k| (k.as_str(), "<redacted>"))
                    .collect::<Vec<_>>(),
            )
            .finish()
    }
}

/// Interpolate `${ENV_VAR}` occurrences in `input` from `std::env::var`,
/// resolving at call time. Non-recursive: only the text BEFORE each placeholder
/// and the literal env value are emitted, so a resolved value that itself
/// contains `${OTHER}` is never re-expanded (no injection via env contents).
/// A referenced-but-unset variable returns `Err` (fail-closed) so a caller never
/// sends a literal `${VAR}`. Only `std::env::var` is consulted — never arbitrary
/// process memory.
fn interpolate_env(input: &str) -> Result<String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            // Unterminated `${…`: refuse rather than emit something that looks
            // unresolved (fail-closed on a malformed template).
            bail!("unterminated `${{` in custom marketplace auth; refusing to fetch");
        };
        let var = after[..end].trim();
        if var.is_empty() {
            bail!("empty `${{}}` placeholder in custom marketplace auth; refusing to fetch");
        }
        let val = std::env::var(var).map_err(|_| {
            anyhow::anyhow!(
                "environment variable `{var}` referenced by a custom marketplace auth is not set; refusing to fetch (fail-closed)"
            )
        })?;
        out.push_str(&val);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// `deprecated` is display-only, so a malformed value from a third-party
/// `marketplace.json` or a hosted card (a number, an array, …) is ignored rather
/// than failing the entry — and with it the whole index/envelope, which is
/// parsed as one `Vec`. Only the documented shapes (`bool`, message string,
/// `{message, replacement}` object) are read; an array is rejected explicitly
/// because serde would otherwise accept `[]` as an empty notice. Mirrors
/// `cleanManifestDeprecation` in `packages/api/src/routers/marketplace.ts`.
fn lenient_deprecation<'de, D>(
    deserializer: D,
) -> Result<Option<crate::plugin_manifest::Deprecation>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = <Value as serde::Deserialize>::deserialize(deserializer)?;
    Ok(match value {
        Value::Bool(_) | Value::String(_) | Value::Object(_) => serde_json::from_value(value).ok(),
        Value::Null | Value::Number(_) | Value::Array(_) => None,
    })
}

/// One plugin entry parsed from a marketplace manifest.
///
/// Beyond the fields needed to resolve installable items (`name`, `source`,
/// `skills`), this pulls the optional **rich metadata** the Claude plugin-entry
/// standard and Ryu extensions may carry (`homepage`, `author`, `category`,
/// `version`, `license`, `keywords`, plus Ryu-ext `iconUrl`/`screenshots`/
/// `tagline`/`examplePrompts`/`privacyPolicyUrl`/`termsOfServiceUrl`/`setup`).
/// Every added field has a serde default so an older/sparser marketplace entry
/// still parses (parsing tolerance preserved). Unknown fields are ignored.
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
    /// How finished this listing is: `alpha`, `beta`, `rc`, … Absent or `stable`
    /// means finished, and renders no badge.
    ///
    /// A free-form STRING, not an enum, and deliberately so: an unrecognised level
    /// renders verbatim rather than being dropped, so publishing a `canary` tier
    /// needs no client release. That is the same tolerance the surfaces work
    /// settled on — an unknown value from a newer index must degrade, never break.
    ///
    /// Sits beside `hidden` because both are visibility controls the published
    /// index owns: a listing graduates from beta by flipping this and re-mirroring,
    /// with no Core release. Absent ⇒ stable, so nothing already published gains a
    /// badge it never asked for.
    #[serde(default)]
    stability: Option<String>,
    /// Hide this entry from the catalog without removing it.
    ///
    /// The published `marketplace.json` is the LIVE control point: flipping this
    /// in the marketplace repo hides a listing for every already-shipped client on
    /// its next fetch — no re-mirror, no Core release, no redeploy. That is the
    /// whole point of putting it here rather than gating at generation time, where
    /// changing your mind would mean cutting a new build.
    ///
    /// Absent ⇒ visible, so every existing index keeps working unchanged and an
    /// older Core that predates this field simply shows everything, which is the
    /// safe direction for a field whose job is to REMOVE things.
    #[serde(default)]
    hidden: bool,
    /// Deprecation notice, in any shape the plugin manifest accepts (`true`, a
    /// message string, or `{message, replacement}`). Like `stability` and
    /// `hidden`, the published index owns it, so a listing can be deprecated for
    /// every shipped client by re-publishing the index. Unlike `hidden` the
    /// listing stays visible — the point is to tell people, not to vanish.
    /// Absent ⇒ current.
    #[serde(default, deserialize_with = "lenient_deprecation")]
    deprecated: Option<crate::plugin_manifest::Deprecation>,
    /// Whether the author allows remixes (manifest `allowRemix`, which the index
    /// generator resolves to a boolean). Absent ⇒ allowed, so an index published
    /// before the field existed reads as remixable, matching the manifest default.
    /// Kept as raw JSON so a malformed value from an untrusted index is ignored
    /// rather than failing the whole index parse; only `false` opts out.
    #[serde(default, rename = "allowRemix")]
    allow_remix: Option<Value>,
    // ── Rich metadata (Phase 1.5) ─────────────────────────────────────────────
    /// Pretty display name (Claude/Codex `displayName`). `name` stays the
    /// kebab-case identity; this is what the card/detail renders when present.
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    repository: Option<String>,
    /// Claude `author` — a bare string or an object with a `name` field.
    #[serde(default)]
    author: Option<serde_json::Value>,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default, rename = "iconUrl")]
    icon_url: Option<String>,
    /// Icon-primitive glyph id for the card (Ryu ext: `icon`) — see the manifest's
    /// `icon`. Distinct from the raster `iconUrl`.
    #[serde(default)]
    icon: Option<String>,
    /// Dithered-gradient background for the card's icon square (Ryu ext:
    /// `iconDither`). Raw JSON `{ from, to?, direction? }`, untrusted — the render
    /// layer validates + falls back.
    #[serde(default, rename = "iconDither")]
    icon_dither: Option<serde_json::Value>,
    /// A theme listing's own palette (Ryu ext: `themePreview`), when the card
    /// declares one — the same swatch the desktop Appearance tab paints. Pure
    /// colour strings, untrusted like every card field; the render layer validates
    /// + falls back. Lets a theme marketplace author declare its swatch without
    /// shipping an image.
    #[serde(default, rename = "themePreview")]
    theme_preview: Option<serde_json::Value>,
    /// True when this entry ships a Companion UI surface, so the browse client
    /// classifies it as an "app" (not a plugin). A git marketplace card carries no
    /// runnables, so this explicit flag is how a remote card discloses app-ness that
    /// a local manifest derives from its `companion` runnable.
    #[serde(default, rename = "hasCompanion")]
    has_companion: bool,
    #[serde(default, rename = "iconBackground")]
    icon_background: Option<String>,
    #[serde(default, rename = "accentColor")]
    accent_color: Option<String>,
    #[serde(default)]
    banner: Option<serde_json::Value>,
    #[serde(default)]
    developer: Option<String>,
    #[serde(default)]
    screenshots: Vec<String>,
    #[serde(default)]
    tagline: Option<String>,
    #[serde(default, rename = "examplePrompts")]
    example_prompts: Vec<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    #[serde(default, rename = "privacyPolicyUrl")]
    privacy_policy_url: Option<String>,
    #[serde(default, rename = "termsOfServiceUrl")]
    terms_of_service_url: Option<String>,
    #[serde(default)]
    setup: Option<serde_json::Value>,
    #[serde(default)]
    external: bool,
    #[serde(default)]
    layers: Vec<serde_json::Value>,
    // ── Dependency + surface contract ─────────────────────────────────────────
    /// The plugins this entry depends on (`{ apps: [{ id, min_version }] }`) and
    /// the host surfaces it targets — mirrored from the plugin's manifest by the
    /// marketplace author, so a card can disclose the install closure up front.
    ///
    /// Both are carried as RAW JSON / plain strings rather than the typed
    /// `Requires` / `Surface`: a git marketplace is untrusted third-party data, and
    /// one entry with a typo'd surface token must not fail the parse of the WHOLE
    /// marketplace. The typed contract is enforced where it is load-bearing — on
    /// the real `manifest.json` at install time, by the manifest loader and the
    /// install-closure resolver.
    #[serde(default)]
    requires: Option<serde_json::Value>,
    /// Optional per-surface support map from a custom marketplace entry. Kept
    /// raw here; `manifest_surface` produces the bounded display projection.
    #[serde(default)]
    surfaces: Option<serde_json::Value>,
    #[serde(default)]
    targets: Vec<String>,
}

/// The rich detail metadata carried from a [`MarketplacePlugin`] onto each
/// resolved [`MarketplaceItem`], so [`MarketplaceSource::detail`] can surface it
/// under the marketplace **detail** contract keys. All optional/additive.
#[derive(Debug, Clone, Default)]
struct MarketplaceItemMeta {
    stability: Option<String>,
    allow_remix: Option<bool>,
    deprecated: Option<crate::plugin_manifest::DeprecationNotice>,
    display_name: Option<String>,
    homepage: Option<String>,
    repository: Option<String>,
    author: Option<serde_json::Value>,
    category: Option<String>,
    version: Option<String>,
    license: Option<String>,
    keywords: Vec<String>,
    icon_url: Option<String>,
    icon: Option<String>,
    icon_dither: Option<serde_json::Value>,
    has_companion: bool,
    icon_background: Option<String>,
    theme_preview: Option<serde_json::Value>,
    accent_color: Option<String>,
    banner: Option<serde_json::Value>,
    developer: Option<String>,
    screenshots: Vec<String>,
    tagline: Option<String>,
    example_prompts: Vec<String>,
    capabilities: Vec<String>,
    privacy_policy_url: Option<String>,
    terms_of_service_url: Option<String>,
    setup: Option<serde_json::Value>,
    external: bool,
    layers: Vec<serde_json::Value>,
    requires: Option<serde_json::Value>,
    targets: Vec<String>,
    surface_support: Vec<serde_json::Value>,
}

impl MarketplacePlugin {
    /// Snapshot this plugin's rich metadata for carriage onto its items.
    fn meta(&self) -> MarketplaceItemMeta {
        MarketplaceItemMeta {
            display_name: self.display_name.clone(),
            homepage: self.homepage.clone(),
            repository: self.repository.clone(),
            author: self.author.clone(),
            category: self.category.clone(),
            version: self.version.clone(),
            license: self.license.clone(),
            keywords: self.keywords.clone(),
            icon_url: self.icon_url.clone(),
            icon: self.icon.clone(),
            icon_dither: self.icon_dither.clone(),
            has_companion: self.has_companion,
            icon_background: self.icon_background.clone(),
            theme_preview: self.theme_preview.clone(),
            accent_color: self.accent_color.clone(),
            banner: self.banner.clone(),
            developer: self.developer.clone(),
            screenshots: self.screenshots.clone(),
            stability: self.stability.clone(),
            allow_remix: self.allow_remix.as_ref().and_then(Value::as_bool),
            deprecated: self
                .deprecated
                .as_ref()
                .and_then(crate::plugin_manifest::Deprecation::notice),
            tagline: self.tagline.clone(),
            example_prompts: self.example_prompts.clone(),
            capabilities: self.capabilities.clone(),
            privacy_policy_url: self.privacy_policy_url.clone(),
            terms_of_service_url: self.terms_of_service_url.clone(),
            setup: self.setup.clone(),
            external: self.external,
            layers: scrub_marketplace_layers(&self.layers),
            requires: self.requires.clone(),
            targets: self.targets.clone(),
            surface_support: super::manifest_surface::project_surface_support(&serde_json::json!({
                "surfaces": self.surfaces.clone(),
                "targets": self.targets.clone(),
            })),
        }
    }
}

/// Extract the `developer` display string from a Claude `author` value (a bare
/// string, or an object's `name` field). Returns `None` for any other shape.
fn author_developer_string(author: &serde_json::Value) -> Option<String> {
    match author {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        serde_json::Value::Object(map) => map
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

/// Keep only the non-executable layer summary a marketplace publisher may show.
/// The signed manifest remains the authority for actual bindings; custom
/// marketplace JSON can only describe the public capability name, target, and
/// verbs that the card renders.
fn scrub_marketplace_layers(value: &[serde_json::Value]) -> Vec<serde_json::Value> {
    value
        .iter()
        .filter_map(|layer| {
            let object = layer.as_object()?;
            let capability = object
                .get("capability")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)?;
            let mut projected = serde_json::Map::new();
            projected.insert("capability".to_owned(), Value::String(capability.clone()));
            if let Some(title) = object
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                projected.insert("title".to_owned(), Value::String(title.to_owned()));
            }
            projected.insert(
                "toolkit".to_owned(),
                Value::Bool(
                    capability == "browser.control"
                        || capability == "computer.control"
                        || capability.starts_with("web."),
                ),
            );
            if let Some(selectable) = object.get("selectable").and_then(Value::as_bool) {
                projected.insert("selectable".to_owned(), Value::Bool(selectable));
            }
            if let Some(target) = object
                .get("target")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                projected.insert("target".to_owned(), Value::String(target.to_owned()));
            }
            if let Some(verbs) = object.get("verbs").and_then(Value::as_array) {
                let verbs = verbs
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_owned)
                    .take(32)
                    .map(Value::String)
                    .collect::<Vec<_>>();
                if !verbs.is_empty() {
                    projected.insert("verbs".to_owned(), Value::Array(verbs));
                }
            }
            Some(Value::Object(projected))
        })
        .take(16)
        .collect()
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
    /// Rich detail metadata carried from the source plugin entry (Phase 1.5).
    meta: MarketplaceItemMeta,
}

impl MarketplaceSource {
    /// Build a git-marketplace source serving `kind`. `repo_url` is the repo/URL
    /// hosting `.claude-plugin/marketplace.json`.
    pub fn new(
        id: impl Into<String>,
        display_name: impl Into<String>,
        repo_url: impl Into<String>,
        kind: CatalogKind,
    ) -> Self {
        Self {
            id: id.into(),
            display_name: display_name.into(),
            repo_url: repo_url.into(),
            kind,
            auth: None,
        }
    }

    /// Attach optional private-marketplace [`SourceAuth`] (Phase 5c). Chained off
    /// [`new`](Self::new) so the public (no-auth) path stays a single call.
    pub fn with_auth(mut self, auth: Option<SourceAuth>) -> Self {
        self.auth = auth;
        self
    }

    /// Fetch + parse the manifest, then resolve items per this source's kind.
    ///
    /// The repo reference resolves to candidate manifest URLs ([`MANIFEST_PATHS`]:
    /// `.ryu-plugin/` → `.agents/plugins/` → `.claude-plugin/`); each is tried in
    /// order until one fetches + parses, so a Ryu-native, vendor-neutral, or
    /// Claude/Codex-legacy marketplace repo all resolve.
    ///
    /// The manifest shape is identical across paths, but the installable UNIT
    /// differs by kind:
    /// - **Skill**: each plugin is flattened into one item per declared skill
    ///   (`<plugin>/<leaf>`, source scoped to the skill subdir) via
    ///   [`flatten_plugins`] — a skill marketplace sells individual skills.
    /// - **Plugin / other code kinds**: each plugin entry is ONE item at the repo
    ///   root ([`plugins_as_items`]); the plugin's bundled skills/mcp/tools ride
    ///   *inside* the plugin, they are not separate installables. Flattening here
    ///   would wrongly advertise a skill leaf as a plugin and install the subdir.
    async fn fetch_items(&self, _client: &reqwest::Client) -> Result<Vec<MarketplaceItem>> {
        // Classify the repo reference into where its `marketplace.json` lives
        // ([`marketplace_location`]): local path (read from disk), github
        // shorthand/URL or direct `.json` URL (https candidates), or any other
        // git URL (clone). Every REMOTE fetch stays behind the SSRF guard +
        // clone screen; a local path is user-local and reads straight from disk.
        let location = marketplace_location(&self.repo_url)
            .map_err(|e| anyhow::anyhow!("marketplace `{}`: {e}", self.repo_url))?;
        let manifest = match location {
            MarketplaceLocation::Local(dir) => {
                let bytes = read_marketplace_from_dir(&dir)?;
                parse_marketplace(&bytes).map_err(|e| {
                    anyhow::anyhow!("parsing marketplace manifest {}: {e}", dir.display())
                })?
            }
            MarketplaceLocation::Http(urls) => {
                // Resolve private-marketplace auth headers ONCE, before any fetch. A
                // referenced-but-unset `${ENV}` fails closed here (no candidate is
                // fetched) rather than sending an unresolved/empty credential.
                let headers = match &self.auth {
                    Some(auth) => Some(auth.resolve_headers()?),
                    None => None,
                };
                let mut last_err: Option<anyhow::Error> = None;
                let mut manifest: Option<MarketplaceManifest> = None;
                for url in &urls {
                    let fetched = match &headers {
                        Some(h) => crate::server::guarded_get_bytes_with_headers(url, h).await,
                        None => crate::server::guarded_get_bytes(url).await,
                    };
                    match fetched {
                        Ok(body) => match parse_marketplace(&body) {
                            Ok(m) => {
                                manifest = Some(m);
                                break;
                            }
                            Err(e) => {
                                last_err = Some(anyhow::anyhow!(
                                    "parsing marketplace manifest {url}: {e}"
                                ));
                            }
                        },
                        Err(e) => {
                            last_err =
                                Some(anyhow::anyhow!("fetching marketplace manifest {url}: {e}"));
                        }
                    }
                }
                manifest.ok_or_else(|| {
                    last_err.unwrap_or_else(|| {
                        anyhow::anyhow!("no marketplace manifest found for {}", self.repo_url)
                    })
                })?
            }
            MarketplaceLocation::Git(url) => {
                let bytes = clone_marketplace_manifest(&url).await?;
                parse_marketplace(&bytes)
                    .map_err(|e| anyhow::anyhow!("parsing marketplace manifest {url}: {e}"))?
            }
        };
        // Pass the marketplace repo as item-resolution context so a relative
        // `./` source or a Cursor repo-local bare subfolder resolves within THIS
        // marketplace (a git-subdir / local path), not as a standalone repo.
        Ok(match self.kind {
            CatalogKind::Skill => flatten_plugins(&manifest, &self.repo_url),
            _ => plugins_as_items(&manifest, &self.repo_url),
        })
    }

    /// Map one flattened item into the per-kind card JSON the matching desktop
    /// tab renders. Skill keeps the original `{ id, source, slug, name, installs,
    /// installed }` shape (back-compat: the skills tab depends on it); other
    /// kinds emit a generic card carrying the fields the plugin browse route's
    /// mapper reads (`id`, `name`, `description`, `install_source`).
    fn item_to_card(&self, item: &MarketplaceItem) -> Value {
        let leaf = item.id.rsplit('/').next().unwrap_or(&item.id);
        // Prefer the plugin's pretty `displayName`; fall back to the kebab id leaf.
        let name = item.meta.display_name.as_deref().unwrap_or(leaf);
        match self.kind {
            CatalogKind::Skill => serde_json::json!({
                "id": item.id,
                "source": self.display_name,
                "slug": leaf,
                "name": name,
                "installs": 0,
                "installed": false,
            }),
            _ => {
                let mut card = serde_json::json!({
                    "id": item.id,
                    "source": self.display_name,
                    "name": name,
                    "description": item.description,
                    "install_source": item.install_source,
                    "installed": false,
                });
                // Dependency + surface disclosure, when the entry declared it. Only
                // emitted when non-empty: an absent `requires` means no
                // dependencies, and an EMPTY `targets` means every surface, so
                // emitting `[]` would read as "no surfaces".
                if let Some(obj) = card.as_object_mut() {
                    if let Some(requires) = item.meta.requires.clone().filter(|v| !v.is_null()) {
                        obj.insert("requires".to_owned(), requires);
                    }
                    if !item.meta.targets.is_empty() {
                        obj.insert("targets".to_owned(), serde_json::json!(item.meta.targets));
                    }
                    if !item.meta.surface_support.is_empty() {
                        obj.insert(
                            "surface_support".to_owned(),
                            serde_json::json!(item.meta.surface_support),
                        );
                    }
                    // Snake_case presentation keys for the browse card + hero.
                    if let Some(icon) = &item.meta.icon_url {
                        obj.insert("icon_url".to_owned(), serde_json::json!(icon));
                    }
                    if let Some(icon) = &item.meta.icon {
                        obj.insert("icon".to_owned(), serde_json::json!(icon));
                    }
                    if let Some(dither) = &item.meta.icon_dither {
                        obj.insert("icon_dither".to_owned(), dither.clone());
                    }
                    // A theme listing's palette — see `MarketplacePlugin::theme_preview`.
                    if let Some(preview) = &item.meta.theme_preview {
                        obj.insert("theme_preview".to_owned(), preview.clone());
                    }
                    // App-ness signal: emitted only when true so the browse client can
                    // classify a Companion-shipping remote card as an "app".
                    if item.meta.has_companion {
                        obj.insert("has_companion".to_owned(), serde_json::json!(true));
                    }
                    if let Some(bg) = &item.meta.icon_background {
                        obj.insert("icon_background".to_owned(), serde_json::json!(bg));
                    }
                    if let Some(accent) = &item.meta.accent_color {
                        obj.insert("accent_color".to_owned(), serde_json::json!(accent));
                    }
                    if let Some(banner) = &item.meta.banner {
                        obj.insert("banner".to_owned(), banner.clone());
                    }
                    if let Some(category) = &item.meta.category {
                        obj.insert("category".to_owned(), serde_json::json!(category));
                    }
                    if let Some(dev) = item
                        .meta
                        .developer
                        .clone()
                        .or_else(|| item.meta.author.as_ref().and_then(author_developer_string))
                    {
                        obj.insert("developer".to_owned(), serde_json::json!(dev));
                    }
                    // Emitted only when it says something: absent/"stable" means
                    // finished, and a card must not sprout a badge for that.
                    if let Some(stability) = item
                        .meta
                        .stability
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("stable"))
                    {
                        obj.insert(
                            "stability".to_owned(),
                            serde_json::json!(stability.to_ascii_lowercase()),
                        );
                    }
                    if let Some(notice) = &item.meta.deprecated {
                        obj.insert("deprecated".to_owned(), serde_json::json!(notice));
                    }
                    obj.insert(
                        "allow_remix".to_owned(),
                        serde_json::json!(item.meta.allow_remix.unwrap_or(true)),
                    );
                    if let Some(tagline) = &item.meta.tagline {
                        obj.insert("tagline".to_owned(), serde_json::json!(tagline));
                    }
                    if let Some(homepage) = item.meta.homepage.as_deref().and_then(http_url) {
                        obj.insert("homepage".to_owned(), serde_json::json!(homepage));
                    }
                    if let Some(repository) = item.meta.repository.as_deref().and_then(http_url) {
                        obj.insert("repository_url".to_owned(), serde_json::json!(repository));
                    }
                    if let Some(license) = &item.meta.license {
                        obj.insert("license".to_owned(), serde_json::json!(license));
                    }
                    if !item.meta.keywords.is_empty() {
                        obj.insert("keywords".to_owned(), serde_json::json!(item.meta.keywords));
                    }
                    if !item.meta.screenshots.is_empty() {
                        obj.insert(
                            "screenshots".to_owned(),
                            serde_json::json!(item.meta.screenshots),
                        );
                    }
                    if !item.meta.layers.is_empty() {
                        obj.insert("layers".to_owned(), serde_json::json!(item.meta.layers));
                    }
                    if item.meta.external {
                        obj.insert("external".to_owned(), serde_json::json!(true));
                    }
                }
                card
            }
        }
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
        self.kind
    }

    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let items = self.fetch_items(client).await?;
        let needle = q.query.trim().to_lowercase();
        let cards: Vec<Value> = items
            .iter()
            .filter(|it| needle.is_empty() || it.id.to_lowercase().contains(&needle))
            .map(|it| self.item_to_card(it))
            .collect();
        let mut obj = serde_json::Map::new();
        obj.insert(envelope_key(self.kind).to_string(), Value::Array(cards));
        Ok(Value::Object(obj))
    }

    async fn detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        let items = self.fetch_items(client).await?;
        let item = items.iter().find(|it| it.id == id).ok_or_else(|| {
            anyhow::anyhow!("item `{id}` not found in marketplace {}", self.repo_url)
        })?;
        let leaf = item.id.rsplit('/').next().unwrap_or(&item.id);
        let mut detail = serde_json::Map::new();
        // Existing git-marketplace detail envelope (unchanged, back-compat).
        detail.insert("card".to_owned(), self.item_to_card(item));
        detail.insert(
            "description".to_owned(),
            serde_json::to_value(&item.description).unwrap_or(serde_json::Value::Null),
        );
        detail.insert("readme".to_owned(), serde_json::Value::Null);
        detail.insert("files".to_owned(), serde_json::Value::Array(vec![]));
        detail.insert(
            "url".to_owned(),
            serde_json::Value::String(item.install_source.clone()),
        );
        // Rich marketplace-detail contract keys (Phase 1.5): id + name always;
        // every other key only when the parsed plugin entry carried the data
        // (never invents data). Aligns with the built-in and Ryu-Mongo shapes.
        detail.insert("id".to_owned(), serde_json::json!(item.id));
        let meta = &item.meta;
        detail.insert(
            "name".to_owned(),
            serde_json::json!(meta.display_name.as_deref().unwrap_or(leaf)),
        );
        if let Some(tagline) = &meta.tagline {
            detail.insert("tagline".to_owned(), serde_json::json!(tagline));
        }
        if let Some(icon) = &meta.icon_url {
            detail.insert("iconUrl".to_owned(), serde_json::json!(icon));
        }
        if let Some(bg) = &meta.icon_background {
            detail.insert("iconBackground".to_owned(), serde_json::json!(bg));
        }
        if let Some(accent) = &meta.accent_color {
            detail.insert("accentColor".to_owned(), serde_json::json!(accent));
        }
        if let Some(banner) = &meta.banner {
            detail.insert("banner".to_owned(), banner.clone());
        }
        if !meta.screenshots.is_empty() {
            detail.insert(
                "screenshots".to_owned(),
                serde_json::json!(meta.screenshots),
            );
        }
        // Prefer an explicitly declared `developer`; fall back to the author string.
        if let Some(dev) = meta
            .developer
            .clone()
            .or_else(|| meta.author.as_ref().and_then(author_developer_string))
        {
            detail.insert("developer".to_owned(), serde_json::json!(dev));
        }
        if let Some(category) = &meta.category {
            detail.insert("category".to_owned(), serde_json::json!(category));
        }
        if let Some(notice) = &meta.deprecated {
            detail.insert("deprecated".to_owned(), serde_json::json!(notice));
        }
        if let Some(version) = &meta.version {
            detail.insert("version".to_owned(), serde_json::json!(version));
        }
        // URL fields from a git marketplace are untrusted publisher input rendered
        // as <a href> in the desktop dialog, so allowlist http(s) before emitting —
        // blocks a `javascript:`/`data:` homepage/policy URL becoming stored XSS.
        if let Some(site) = meta.homepage.as_deref().and_then(http_url) {
            detail.insert("website".to_owned(), serde_json::json!(site));
        }
        if let Some(repository) = meta.repository.as_deref().and_then(http_url) {
            detail.insert("repositoryUrl".to_owned(), serde_json::json!(repository));
        }
        if let Some(license) = &meta.license {
            detail.insert("license".to_owned(), serde_json::json!(license));
        }
        if !meta.keywords.is_empty() {
            detail.insert("keywords".to_owned(), serde_json::json!(meta.keywords));
        }
        if let Some(privacy) = meta.privacy_policy_url.as_deref().and_then(http_url) {
            detail.insert("privacyPolicyUrl".to_owned(), serde_json::json!(privacy));
        }
        if let Some(terms) = meta.terms_of_service_url.as_deref().and_then(http_url) {
            detail.insert("termsOfServiceUrl".to_owned(), serde_json::json!(terms));
        }
        if !meta.capabilities.is_empty() {
            detail.insert(
                "capabilities".to_owned(),
                serde_json::json!(meta.capabilities),
            );
        }
        // The install closure this plugin pulls in, and the surfaces it runs on.
        // Same emit rule as the card: absent `requires` = no dependencies, empty
        // `targets` = every surface (so never emit an empty list).
        if let Some(requires) = meta.requires.clone().filter(|v| !v.is_null()) {
            detail.insert("requires".to_owned(), requires);
        }
        if !meta.targets.is_empty() {
            detail.insert("targets".to_owned(), serde_json::json!(meta.targets));
        }
        if !meta.surface_support.is_empty() {
            detail.insert(
                "surfaceSupport".to_owned(),
                serde_json::json!(meta.surface_support),
            );
        }
        if !meta.example_prompts.is_empty() {
            detail.insert(
                "examplePrompts".to_owned(),
                serde_json::json!(meta.example_prompts),
            );
        }
        if let Some(setup) = &meta.setup {
            detail.insert("setup".to_owned(), setup.clone());
        }
        if item.meta.external {
            detail.insert("external".to_owned(), serde_json::json!(true));
        }
        if !item.meta.layers.is_empty() {
            detail.insert("layers".to_owned(), serde_json::json!(item.meta.layers));
        }
        Ok(serde_json::Value::Object(detail))
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
            anyhow::anyhow!("item `{id}` not found in marketplace {}", self.repo_url)
        })?;
        Ok(InstallDescriptor {
            kind: self.kind,
            source_id: self.id.clone(),
            repo_id: item.id.clone(),
            files: Vec::new(),
            raw: serde_json::json!({ "install_source": item.install_source }),
        })
    }
}

/// Return `s` only when it is an http(s) URL. An allowlist that blocks
/// `javascript:`/`data:` values a git marketplace could inject into an href.
fn http_url(s: &str) -> Option<&str> {
    let t = s.trim();
    let lower = t.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")).then_some(t)
}

/// Manifest paths tried, in order, when resolving a repo reference to a
/// `marketplace.json`. Ryu's own convention first, then the vendor-neutral
/// cross-tool path, then the Claude/Codex and Cursor paths for ecosystem compat —
/// so any existing Claude, Codex, or Cursor marketplace repo Just Works, while a
/// Ryu-authored repo carries Ryu's own branding.
const MANIFEST_PATHS: [&str; 4] = [
    ".ryu-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    ".cursor-plugin/marketplace.json",
];

/// The `https://raw.githubusercontent.com/{owner}/{name}/HEAD/` base for a
/// `owner/repo` shorthand or a `github.com/owner/repo[/…]` URL, else `None`.
fn github_raw_head_base(repo: &str) -> Option<String> {
    let repo = repo.trim();
    let rest = repo
        .strip_prefix("https://github.com/")
        .or_else(|| repo.strip_prefix("http://github.com/"))
        .unwrap_or(repo);
    let mut it = rest.trim_end_matches('/').split('/');
    let (owner, name) = (it.next()?, it.next()?);
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    let name = name.strip_suffix(".git").unwrap_or(name);
    Some(format!(
        "https://raw.githubusercontent.com/{owner}/{name}/HEAD/"
    ))
}

/// Build the candidate raw `marketplace.json` URLs for a repo/URL reference, in
/// resolution order. A direct `.json` URL is used verbatim (single candidate);
/// an `owner/repo` / github URL / bare directory expands to one URL per
/// [`MANIFEST_PATHS`] entry. `fetch_items` tries each until one fetches + parses.
fn marketplace_manifest_urls(repo: &str) -> Vec<String> {
    let repo = repo.trim();
    // Already a direct .json URL.
    if repo.to_ascii_lowercase().ends_with(".json") {
        return vec![repo.to_string()];
    }
    let base =
        github_raw_head_base(repo).unwrap_or_else(|| format!("{}/", repo.trim_end_matches('/')));
    MANIFEST_PATHS
        .iter()
        .map(|path| format!("{base}{path}"))
        .collect()
}

/// Where a custom marketplace's `marketplace.json` lives, resolved from the
/// user-supplied repo reference.
#[derive(Debug)]
pub(crate) enum MarketplaceLocation {
    /// Candidate https URLs, fetched in order (github raw / direct `.json` URL).
    Http(Vec<String>),
    /// A local directory (or a direct `.json` file) read from disk.
    Local(PathBuf),
    /// A git repo cloned to a temp checkout (any host); the manifest is read
    /// from the checkout. A private repo works through the user's own git
    /// credentials (SSH keys, credential helpers) — no token is embedded.
    Git(String),
}

/// Resolve a local marketplace path: expand a leading `~/` to the user's home
/// directory and resolve a relative reference against the process CWD.
pub(crate) fn expand_local_path(repo: &str) -> PathBuf {
    let trimmed = repo.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(trimmed));
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(&path))
            .unwrap_or(path)
    }
}

/// True when a marketplace repo reference names a local filesystem path rather
/// than a git repo/URL: an existing directory or `.json` file, or a path-shaped
/// string (`/…`, `./…`, `../…`, `~/…`). Local paths are user-local, so they
/// carry no outbound-fetch / SSRF surface.
pub(crate) fn is_local_marketplace_ref(repo: &str) -> bool {
    let repo = repo.trim();
    if repo.is_empty() {
        return false;
    }
    if repo.starts_with('/')
        || repo.starts_with("./")
        || repo.starts_with("../")
        || repo.starts_with("~/")
    {
        return true;
    }
    let path = Path::new(repo);
    path.is_absolute()
        || path.is_dir()
        || (path.is_file() && repo.to_ascii_lowercase().ends_with(".json"))
}

/// Classify a user-supplied marketplace repo reference into where its
/// `marketplace.json` lives:
/// - a local filesystem path → read from disk,
/// - a github `owner/repo` shorthand or `github.com` URL → raw https candidates,
/// - a direct `.json` URL → the URL itself (verbatim),
/// - any other git URL (`https://` on gitlab/bitbucket/self-hosted hosts, plus
///   `git@` / `ssh://`) → `git clone` (matching how Claude treats a non-github
///   URL as a git repo; a web-hosted manifest needs the direct `.json` form).
pub(crate) fn marketplace_location(repo: &str) -> Result<MarketplaceLocation> {
    let repo = repo.trim();
    if repo.is_empty() {
        anyhow::bail!("marketplace reference must not be empty");
    }
    // git@ / ssh:// — any host, clone it.
    if repo.starts_with("git@") || repo.starts_with("ssh://") {
        return Ok(MarketplaceLocation::Git(repo.to_string()));
    }
    // Explicit http(s) URL.
    if repo.starts_with("https://") || repo.starts_with("http://") {
        // A direct .json URL is used verbatim (a single candidate).
        if repo.to_ascii_lowercase().ends_with(".json") {
            return Ok(MarketplaceLocation::Http(vec![repo.to_string()]));
        }
        // A github URL → raw.githubusercontent.com candidates over HTTP (works
        // with the private-marketplace auth headers).
        if github_raw_head_base(repo).is_some() {
            return Ok(MarketplaceLocation::Http(marketplace_manifest_urls(repo)));
        }
        // Any other git host → clone (git speaks every host).
        return Ok(MarketplaceLocation::Git(repo.to_string()));
    }
    // Local filesystem path forms (existing dir, or a path-shaped string).
    if is_local_marketplace_ref(repo) {
        return Ok(MarketplaceLocation::Local(expand_local_path(repo)));
    }
    // owner/repo shorthand → github raw candidates.
    if github_raw_head_base(repo).is_some() {
        return Ok(MarketplaceLocation::Http(marketplace_manifest_urls(repo)));
    }
    anyhow::bail!(
        "unrecognized marketplace reference `{repo}` (expected owner/repo, a https git URL, a git@/ssh URL, or a local path)"
    )
}

/// Read `marketplace.json` from a local directory or `.json` file, in
/// [`MANIFEST_PATHS`] order (first hit wins) when reading a directory. A direct
/// `.json` file path is read verbatim.
fn read_marketplace_from_dir(dir: &Path) -> Result<Vec<u8>> {
    if dir.is_file() {
        let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if name.to_ascii_lowercase().ends_with(".json") {
            return std::fs::read(dir).with_context(|| format!("reading {}", dir.display()));
        }
        anyhow::bail!(
            "local marketplace path is not a directory: {}",
            dir.display()
        );
    }
    for path in MANIFEST_PATHS {
        let candidate = dir.join(path);
        if candidate.is_file() {
            return std::fs::read(&candidate)
                .with_context(|| format!("reading {}", candidate.display()));
        }
    }
    anyhow::bail!(
        "no marketplace.json under {} (looked for {})",
        dir.display(),
        MANIFEST_PATHS.join(", ")
    )
}

/// Clone a git marketplace repo and read its `marketplace.json` from the
/// checkout. Reuses the install path's SSRF-screened, env-scrubbed, no-prompt
/// `git clone`; private repos work through the user's own git credentials (SSH
/// keys, credential helpers). The temp checkout is removed after reading.
async fn clone_marketplace_manifest(url: &str) -> Result<Vec<u8>> {
    let work = crate::skills_catalog::from_source::temp_workdir()?;
    let checkout = crate::skills_catalog::from_source::git_clone(url, &work).await?;
    let result = read_marketplace_from_dir(&checkout);
    let _ = std::fs::remove_dir_all(&work);
    result
}

/// Extract `(host, project_path)` from a gitlab repo URL (`gitlab.com`,
/// `www.gitlab.com`, or a `<group>.gitlab.com` self-hosted instance). The
/// project path keeps its subgroup slashes and a trailing `.git` is stripped.
/// Returns `None` for a non-gitlab host or a path without `group/repo`.
fn gitlab_host_project(repo: &str) -> Option<(String, String)> {
    let url = url::Url::parse(repo.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let is_gitlab =
        host == "gitlab.com" || host == "www.gitlab.com" || host.ends_with(".gitlab.com");
    if !is_gitlab {
        return None;
    }
    let segments: Vec<String> = url
        .path_segments()
        .map(|it| {
            it.filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    // gitlab project paths may include subgroups and a `-` marker before a
    // `/tree/` / `/blob/` segment; the project is everything before that marker.
    let project_segs: Vec<String> = segments
        .iter()
        .take_while(|s| s.as_str() != "-")
        .cloned()
        .collect();
    if project_segs.len() < 2 {
        return None;
    }
    let mut project = project_segs.join("/");
    if let Some(stripped) = project.strip_suffix(".git") {
        project = stripped.to_string();
    }
    Some((host, project))
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

/// Map each manifest plugin to ONE installable item at its repo root — the
/// plugin-kind resolution. The plugin's bundled skills/mcp/tools stay inside the
/// plugin (they are not separate catalog items). Plugins whose `source` can't be
/// resolved are skipped. Contrast [`flatten_plugins`], which the Skill kind uses
/// to sell each declared skill individually.
fn plugins_as_items(manifest: &MarketplaceManifest, repo_context: &str) -> Vec<MarketplaceItem> {
    manifest
        .plugins
        .iter()
        .filter(|plugin| !plugin.hidden)
        .filter_map(|plugin| {
            let repo = plugin_source_string(&plugin.source)?;
            Some(MarketplaceItem {
                id: plugin.name.clone(),
                plugin: plugin.name.clone(),
                description: plugin.description.clone(),
                // Cursor repo-local subfolder → git-subdir of the marketplace repo.
                install_source: resolve_marketplace_source(&repo, repo_context),
                meta: plugin.meta(),
            })
        })
        .collect()
}

/// Flatten a manifest's plugins into installable items. Each plugin with explicit
/// `skills` paths yields one item per skill (id `<plugin>/<leaf>`, source scoped
/// to that subdir); a plugin without skills yields a single `<plugin>` item.
/// Plugins whose `source` can't be resolved are skipped.
fn flatten_plugins(manifest: &MarketplaceManifest, repo_context: &str) -> Vec<MarketplaceItem> {
    let mut out = Vec::new();
    for plugin in &manifest.plugins {
        // Both readers must honour `hidden`, or a listing hidden from the Plugins
        // tab would still be sold as an individual Skill from the same index.
        if plugin.hidden {
            continue;
        }
        let Some(raw) = plugin_source_string(&plugin.source) else {
            continue;
        };
        // Cursor repo-local subfolder → git-subdir of the marketplace repo.
        let repo = resolve_marketplace_source(&raw, repo_context);
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
                meta: plugin.meta(),
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
                install_source: subdir_source(&repo, &path),
                meta: plugin.meta(),
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
    // Local-path marketplace → a subdirectory of the local checkout.
    if is_local_marketplace_ref(r) {
        return expand_local_path(r)
            .join(subdir)
            .to_string_lossy()
            .to_string();
    }
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
    // gitlab URL → the `/-/tree/HEAD/<subdir>` archive form.
    if let Some((host, project)) = gitlab_host_project(r) {
        return format!("https://{host}/{project}/-/tree/HEAD/{subdir}");
    }
    r.to_string()
}

/// Extract `(owner, repo)` from a repo reference: an `owner/repo` shorthand or a
/// `github.com/owner/repo[/…]` URL (a trailing `.git` is stripped). Returns
/// `None` for anything else (a direct `.json` URL, a non-github host, …), which
/// is how [`resolve_marketplace_source`] degrades a repo-local source to its
/// bare string when the marketplace repo isn't a github repo.
fn github_owner_repo(repo: &str) -> Option<(String, String)> {
    let repo = repo.trim();
    let rest = repo
        .strip_prefix("https://github.com/")
        .or_else(|| repo.strip_prefix("http://github.com/"))
        .unwrap_or(repo);
    // Reject anything that still carries a scheme (a non-github URL) or a space.
    if rest.contains("://") || rest.contains(' ') {
        return None;
    }
    let mut it = rest.trim_end_matches('/').split('/');
    let owner = it.next()?;
    let name = it.next()?;
    if owner.is_empty() || name.is_empty() {
        return None;
    }
    // A github owner never contains a dot; a `.`-carrying first segment is a bare
    // host (`example.com/x`), not `owner/repo`.
    if owner.contains('.') {
        return None;
    }
    let name = name.strip_suffix(".git").unwrap_or(name);
    Some((owner.to_string(), name.to_string()))
}

/// True when a plugin `source` is a **Cursor repo-local subfolder** (Phase 5d) —
/// a single bare path segment (e.g. `"teaching"`) rather than an `owner/repo`
/// shorthand, a URL, or the sentinel `"builtin"`. The discriminator (per the
/// task): no owner slash, no URL scheme, no `.`-host. A value with a `/` is left
/// as-is so an `owner/repo` is never mistaken for a local subfolder.
fn is_local_subdir_source(source: &str) -> bool {
    let s = source.trim();
    !s.is_empty()
        && !s.eq_ignore_ascii_case("builtin")
        && !s.contains("://")
        && !s.contains('/')
        && !s.contains('.')
        && !s.contains(' ')
}

/// Resolve a plugin `source` value in the context of the marketplace `repo`.
/// A marketplace-relative source — a Claude/Codex `./` path, or a Cursor
/// repo-local bare subfolder (`is_local_subdir_source`) — resolves within the
/// marketplace repo itself:
/// - a local-path marketplace → a path inside the local checkout,
/// - a github marketplace → a github `tree/HEAD/<path>` URL,
/// - a gitlab marketplace → a gitlab `/-/tree/HEAD/<path>` URL,
/// - any other git host → the bare source (the installer's walker finds it).
/// An `owner/repo`, an absolute URL, or `"builtin"` is returned unchanged.
fn resolve_marketplace_source(source: &str, repo_context: &str) -> String {
    let source = source.trim();
    if source.is_empty() {
        return source.to_string();
    }
    let is_relative = source.starts_with("./") || is_local_subdir_source(source);
    if !is_relative {
        return source.to_string();
    }
    let rel = source.trim_start_matches("./");
    // Local-path marketplace → a path inside the local checkout.
    if is_local_marketplace_ref(repo_context) {
        return expand_local_path(repo_context)
            .join(rel)
            .to_string_lossy()
            .to_string();
    }
    // github marketplace → a `tree/HEAD/<path>` URL of the marketplace repo.
    if let Some((owner, name)) = github_owner_repo(repo_context) {
        return format!("https://github.com/{owner}/{name}/tree/HEAD/{rel}");
    }
    // gitlab marketplace → the `/-/tree/HEAD/<path>` archive form.
    if let Some((host, project)) = gitlab_host_project(repo_context) {
        return format!("https://{host}/{project}/-/tree/HEAD/{rel}");
    }
    // Some other git host → degrade to the bare source string; the directory
    // walker locates the skill in the cloned checkout.
    source.to_string()
}

/// Build an `install_from_source` string for a skill `subdir` under an
/// already-resolved `repo`. When `repo` is itself a github `tree/HEAD/<local>`
/// URL (a resolved Cursor repo-local plugin), the skill nests beneath it;
/// otherwise this is [`scoped_source`] (owner/repo or github URL → tree URL).
fn subdir_source(repo: &str, subdir: &str) -> String {
    if repo.contains("/tree/HEAD/") {
        return format!("{}/{subdir}", repo.trim_end_matches('/'));
    }
    scoped_source(repo, subdir)
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
        let plan = crate::mcp_catalog::verify_and_plan(&server).await?;
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
      "version": "2026.8.31",
      "packages": [
        { "registry_type": "npm", "identifier": "@modelcontextprotocol/server-filesystem",
          "version": "2026.8.31", "transport": { "type": "stdio" } }
      ]
    },
    {
      "name": "io.modelcontextprotocol/memory",
      "description": "Reference knowledge-graph memory MCP server.",
      "version": "2026.8.31",
      "packages": [
        { "registry_type": "npm", "identifier": "@modelcontextprotocol/server-memory",
          "version": "2026.8.31", "transport": { "type": "stdio" } }
      ]
    },
    {
      "name": "io.modelcontextprotocol/sequential-thinking",
      "description": "Reference sequential-thinking MCP server.",
      "version": "2026.8.31",
      "packages": [
        { "registry_type": "npm", "identifier": "@modelcontextprotocol/server-sequential-thinking",
          "version": "2026.8.31", "transport": { "type": "stdio" } }
      ]
    },
    {
      "name": "io.modelcontextprotocol/fetch",
      "description": "Reference web-fetch MCP server (Python).",
      "version": "2026.8.18",
      "packages": [
        { "registry_type": "pypi", "identifier": "mcp-server-fetch",
          "version": "2026.8.18", "transport": { "type": "stdio" } }
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
        let plan = crate::mcp_catalog::verify_and_plan(server).await?;
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
pub(crate) fn urlencode_component(s: &str) -> String {
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
pub(crate) fn urlencode_path(s: &str) -> String {
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
/// A shipped build hits the hosted Ryu marketplace by default; a self-host or
/// local dev overrides this (e.g. `RYU_MARKETPLACE_API_URL=http://localhost:3000`).
pub const RYU_MARKETPLACE_API_ENV: &str = "RYU_MARKETPLACE_API_URL";

/// The default base URL: the hosted Ryu control plane (`apps/server`) that
/// serves `GET /api/marketplace/*` in production. A non-localhost default so an
/// installed build reaches the real marketplace out of the box; overridable via
/// [`RYU_MARKETPLACE_API_ENV`] for self-host / local dev (point it at
/// `http://localhost:3000`). The caller appends `/api/marketplace/...`, so this
/// carries no `/api` suffix.
const RYU_MARKETPLACE_DEFAULT_BASE: &str = "https://api.ryuhq.com";

/// Env var carrying a control-plane bearer (Better Auth / OAuth session token)
/// to forward on the marketplace install handoff for optional account-aware
/// Marketplace operations. This is the
/// *fallback*/headless path; the live desktop install threads the caller's
/// bearer per-request via [`with_buyer_token`] (env vars are fixed at spawn and
/// cannot carry a live, expiring session token). Unset ⇒ anonymous install.
/// Nothing hardcoded.
const RYU_MARKETPLACE_TOKEN_ENV: &str = "RYU_MARKETPLACE_TOKEN";

/// Header carrying a short-lived control-plane install session redeemed from a
/// private Marketplace share code. It is intentionally separate from the
/// caller's account bearer: the session is scoped to one release and audience,
/// while the bearer remains the caller's normal identity/entitlement proof.
const RYU_MARKETPLACE_INSTALL_SESSION_HEADER: &str = "x-ryu-marketplace-install-session";

tokio::task_local! {
    /// The authenticated buyer's bearer for the current install request, set by
    /// the install handler from the inbound `Authorization` header. Per-request
    /// and dynamic (an env var cannot carry a live session token to a
    /// long-running Core). `None` ⇒ no header on this request.
    static BUYER_TOKEN: Option<String>;

    /// The short-lived release-scoped session for a private package install.
    /// `None` is the normal public/paid Marketplace path.
    static INSTALL_SESSION: Option<String>;
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

/// Run `fut` with a private package install session bound to this request.
/// Session material is never persisted in Core; it is forwarded only to the
/// first-party Marketplace detail/archive routes below.
pub async fn with_install_session<F, T>(session: Option<String>, fut: F) -> T
where
    F: std::future::Future<Output = T>,
{
    let session = session
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    INSTALL_SESSION.scope(session, fut).await
}

/// Resolve the optional buyer bearer to forward to the marketplace install
/// handoff: the per-request task-local first (the live desktop path), else the
/// `RYU_MARKETPLACE_TOKEN` env fallback (headless). `None` ⇒ anonymous.
pub(super) fn marketplace_buyer_token() -> Option<String> {
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

/// Resolve the current private-package install session. There is deliberately
/// no environment fallback: unlike a headless buyer bearer, a share-code
/// redemption is short-lived and must never become a process-wide credential.
fn marketplace_install_session() -> Option<String> {
    INSTALL_SESSION
        .try_with(|session| session.clone())
        .ok()
        .flatten()
        .filter(|session| !session.is_empty())
}

pub(crate) fn ryu_marketplace_base() -> String {
    std::env::var(RYU_MARKETPLACE_API_ENV)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| RYU_MARKETPLACE_DEFAULT_BASE.to_owned())
}

const MAX_RYU_PACKAGE_DETAIL_BYTES: usize = 16 * 1024 * 1024;
const MAX_RYU_PACKAGE_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;

/// The control plane's own reason for refusing a request (`{ "error": "…" }`),
/// read from a bounded body and capped, so an install failure says why (for
/// example, a version that has not passed Marketplace review) rather than only
/// the status. `None` when the body carries no readable reason.
async fn control_plane_refusal(response: reqwest::Response) -> Option<String> {
    let body = read_bounded_reqwest_body(response, 16 * 1024, "Ryu Marketplace error")
        .await
        .ok()?;
    let value: Value = serde_json::from_slice(&body).ok()?;
    let reason: String = value
        .get("error")
        .and_then(Value::as_str)?
        .chars()
        .filter(|c| !c.is_control())
        .take(300)
        .collect();
    (!reason.trim().is_empty()).then_some(reason)
}

pub(crate) async fn read_bounded_reqwest_body(
    mut response: reqwest::Response,
    max_bytes: usize,
    label: &str,
) -> Result<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        bail!("{label} exceeds the configured size limit");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if chunk.len() > max_bytes.saturating_sub(bytes.len()) {
            bail!("{label} exceeds the configured size limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Refuse to install a paid Marketplace listing the caller is not entitled to.
/// The control plane withholds the package from such callers and says so with
/// `requiresPurchase`; failing here gives the user that reason instead of a
/// confusing signature or descriptor error further down.
pub(super) fn require_install_entitlement(id: &str, detail: &Value) -> Result<()> {
    if detail
        .get("requiresPurchase")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        bail!("`{id}` is a paid Marketplace item: purchase it (or use a plan that includes it) before installing");
    }
    if detail
        .get("updateAllowanceExhausted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        bail!("`{id}`: this purchase has no updates left for this release; buy it again to update");
    }
    Ok(())
}

/// Whether a Marketplace detail envelope describes a priced listing.
fn detail_is_paid(detail: &Value) -> bool {
    detail
        .get("pricing")
        .is_some_and(|pricing| !pricing.is_null())
}

/// Fetch the detail envelope for a portable GitHub-backed package. Portable
/// package kinds intentionally do not expand `CatalogKind`: they are a package
/// transport, not one of Core's legacy catalog adapters. The returned detail is
/// still the signed marketplace handoff, so the caller can verify the manifest
/// before asking for the archive.
pub async fn fetch_ryu_package_detail(
    client: &reqwest::Client,
    kind: &str,
    id: &str,
    update: bool,
    version: Option<&str>,
) -> Result<Value> {
    let version_param = version
        .map(|value| format!("&version={}", urlencoding::encode(value)))
        .unwrap_or_default();
    let url = format!(
        "{}/api/marketplace/catalog/detail?kind={}&id={}{}{}",
        ryu_marketplace_base(),
        urlencoding::encode(kind),
        urlencoding::encode(id.trim()),
        if update {
            "&operation=update"
        } else {
            "&operation=install"
        },
        version_param,
    );
    let mut request = client.get(url.clone());
    if let Some(token) = marketplace_buyer_token() {
        request = request.bearer_auth(token);
    }
    if let Some(session) = marketplace_install_session() {
        request = request.header(RYU_MARKETPLACE_INSTALL_SESSION_HEADER, session);
    }
    let response = request
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("fetching Ryu package detail {url}: {error}"))?;
    if !response.status().is_success() {
        let status = response.status();
        match control_plane_refusal(response).await {
            Some(reason) => bail!("Ryu package `{kind}/{id}`: {reason} ({status})"),
            None => bail!("Ryu package detail returned {status} for `{kind}/{id}`"),
        }
    }
    let detail_bytes =
        read_bounded_reqwest_body(response, MAX_RYU_PACKAGE_DETAIL_BYTES, "Ryu package detail")
            .await?;
    let detail = serde_json::from_slice::<Value>(&detail_bytes)
        .context("Ryu package detail was not valid JSON")?;
    require_install_entitlement(id, &detail)?;
    let descriptor = detail
        .get("descriptor")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow::anyhow!("Ryu package detail has no descriptor"))?;
    if descriptor.get("kind").and_then(Value::as_str) != Some("ryu_package") {
        bail!("marketplace item `{kind}/{id}` is not a portable Ryu package");
    }
    super::license::remember_install_entitlement(kind, id.trim(), detail_is_paid(&detail));
    Ok(detail)
}

/// Download the package archive from the Ryu proxy. The URL is deliberately
/// constrained to the first-party marketplace path; a signed descriptor cannot
/// turn Core into a generic outbound proxy.
pub async fn fetch_ryu_package_archive(
    client: &reqwest::Client,
    detail: &Value,
    update: bool,
) -> Result<Vec<u8>> {
    let raw_url = detail
        .get("descriptor")
        .and_then(Value::as_object)
        .and_then(|descriptor| descriptor.get("download_url"))
        .and_then(Value::as_str)
        .filter(|value| value.starts_with("/api/marketplace/github/"))
        .ok_or_else(|| {
            anyhow::anyhow!("portable package descriptor has no first-party download URL")
        })?;
    let mut url = reqwest::Url::parse(&format!("{}{}", ryu_marketplace_base(), raw_url))?;
    url.query_pairs_mut()
        .append_pair("operation", if update { "update" } else { "install" });
    if update {
        url.query_pairs_mut().append_pair("purpose", "update");
    }
    let mut request = client.get(url.clone());
    if let Some(token) = marketplace_buyer_token() {
        request = request.bearer_auth(token);
    }
    if let Some(session) = marketplace_install_session() {
        request = request.header(RYU_MARKETPLACE_INSTALL_SESSION_HEADER, session);
    }
    let response = request
        .send()
        .await
        .map_err(|error| anyhow::anyhow!("downloading Ryu package archive {url}: {error}"))?;
    if !response.status().is_success() {
        bail!("Ryu package archive returned {}", response.status());
    }
    let bytes = read_bounded_reqwest_body(
        response,
        MAX_RYU_PACKAGE_ARCHIVE_BYTES,
        "Ryu package archive",
    )
    .await?;
    Ok(bytes)
}

/// Env var naming the pinned Marketplace verifying key (base64 ed25519 public
/// key). Read at runtime (operator/self-host override) and at BUILD time via
/// `option_env!` (the production key a shipped binary trusts).
pub const RYU_MARKETPLACE_PUBLIC_KEY_ENV: &str = "RYU_MARKETPLACE_PUBLIC_KEY";

/// The production Marketplace verifying key compiled into this binary, when the
/// release pipeline provided one. A public key, not a secret.
const COMPILED_MARKETPLACE_PUBLIC_KEY: Option<&str> = option_env!("RYU_MARKETPLACE_PUBLIC_KEY");

/// Whether this build must refuse to fall back to the local Gateway's resident
/// key. Every shipped channel (release/beta/canary/nightly) is an optimized
/// build; only a debug build or the explicit `dev` profile may trust the local
/// Gateway key (whose private half sits on the same machine, so it proves
/// nothing about the hosted Marketplace).
fn marketplace_trust_anchor_required() -> bool {
    !cfg!(debug_assertions) && crate::profile::profile() != "dev"
}

/// Pure trust-anchor policy: runtime override, else the compiled-in key, else
/// (`strict`) refuse, else `None` (dev: Gateway verifies with its own key).
fn resolve_marketplace_trust_anchor(
    runtime: Option<&str>,
    compiled: Option<&str>,
    strict: bool,
) -> Result<Option<String>> {
    let pinned = [runtime, compiled]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|key| !key.is_empty());
    match pinned {
        Some(key) => Ok(Some(key.to_owned())),
        None if strict => bail!(
            "no pinned Marketplace verifying key in this build; refusing to trust the local \
             Gateway key for a hosted Marketplace install (set {RYU_MARKETPLACE_PUBLIC_KEY_ENV} \
             to the Marketplace's public key when self-hosting)"
        ),
        None => Ok(None),
    }
}

/// The key Marketplace install signatures must verify against. `Ok(None)` only
/// in dev/test builds, where the local Gateway's resident key is acceptable.
pub(crate) fn marketplace_trust_anchor() -> Result<Option<String>> {
    let runtime = std::env::var(RYU_MARKETPLACE_PUBLIC_KEY_ENV).ok();
    resolve_marketplace_trust_anchor(
        runtime.as_deref(),
        COMPILED_MARKETPLACE_PUBLIC_KEY,
        marketplace_trust_anchor_required(),
    )
}

/// Verify the signed portable-package manifest using the existing Gateway
/// signing path. Unlike legacy seed listings, a new GitHub package must carry a
/// signature: otherwise the release digest could be valid while the listing
/// identity and publisher metadata were replaced at the control plane.
pub async fn verify_ryu_package_signature(
    client: &reqwest::Client,
    id: &str,
    detail: &Value,
) -> Result<()> {
    let signature = detail
        .get("signature")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("portable package `{id}` has no manifest signature"))?;
    let public_key = marketplace_trust_anchor()?;
    let gateway = crate::sidecar::gateway::gateway_url();
    let url = format!("{}/v1/manifests/verify", gateway.trim_end_matches('/'));
    let mut payload = serde_json::Map::new();
    payload.insert("manifest".to_owned(), marketplace_signature_payload(detail));
    payload.insert("signature".to_owned(), Value::String(signature.to_owned()));
    if let Some(public_key) = public_key {
        payload.insert("public_key".to_owned(), Value::String(public_key));
    }
    let response = client
        .post(&url)
        .json(&Value::Object(payload))
        .send()
        .await
        .map_err(|error| {
            anyhow::anyhow!("signature verification unreachable for `{id}`: {error}")
        })?;
    if !response.status().is_success() {
        bail!(
            "signature verification failed for `{id}`: gateway returned {}",
            response.status()
        );
    }
    let body = response
        .json::<Value>()
        .await
        .context("signature verification response was not valid JSON")?;
    if body.get("valid").and_then(Value::as_bool) != Some(true) {
        bail!("manifest signature is invalid for `{id}`; refusing portable package install");
    }
    Ok(())
}

/// The **Ryu Marketplace** federated catalog source (#467). One source type
/// that spans **all four kinds**: a [`kind`](Self::kind) field discriminates,
/// and the source is registered once per kind in `builtin_sources`. It fetches
/// the first-party marketplace API (`GET /api/marketplace/catalog{,/detail}`)
/// over a **plain reqwest client** (the endpoint is trusted first-party — the
/// hosted marketplace by default, or loopback when self-hosting — so it must NOT
/// go through the SSRF `guarded_get` that blocks loopback) and maps each item
/// onto Core's per-kind install path.
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
/// Degrades gracefully: `search` serves the last successful list from memory or
/// disk when the server is unavailable, with a staleness note; a first-ever
/// offline search returns an empty, labelled per-kind envelope. `detail` /
/// `install_descriptor` return a clear error, because stale detail must not
/// bypass signature, integrity, or node-policy checks. Never panics.
#[derive(Clone)]
pub struct RyuMarketplaceSource {
    pub id: String,
    pub display_name: String,
    pub kind: CatalogKind,
    /// Optional base URL override. `None` ⇒ env (`RYU_MARKETPLACE_API_URL`) or
    /// the hosted-marketplace default.
    pub base_url: Option<String>,
}

/// One catalog card from the marketplace `GET /catalog` response.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
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
    // App-store presentation (logo + free-text category) and the denormalized
    // rating aggregate. Optional so an older server that omits them still parses.
    #[serde(default, rename = "iconUrl")]
    icon_url: Option<String>,
    /// Icon-primitive glyph id (Ryu ext: `icon`), distinct from the raster
    /// `iconUrl`. Optional so an older server that omits it still parses.
    #[serde(default)]
    icon: Option<String>,
    /// Dithered-gradient icon-square background (Ryu ext: `iconDither`). Raw JSON
    /// `{ from, to?, direction? }`, validated + fallback-guarded at render time.
    #[serde(default, rename = "iconDither")]
    icon_dither: Option<Value>,
    /// A theme listing's own palette (Ryu ext: `themePreview`), projected by the
    /// marketplace server from the stored manifest's `contributes.themes[0].preview`
    /// — the same swatch the desktop Appearance tab paints. Carried onto the card
    /// so a theme's icon square is its palette, not a dither avatar. Pure colour
    /// strings; validated + fallback-guarded at render time.
    #[serde(default, rename = "themePreview")]
    theme_preview: Option<Value>,
    /// True when the item ships a Companion UI surface — the browse client's signal
    /// to classify it as an "app" rather than a plugin.
    #[serde(default, rename = "hasCompanion")]
    has_companion: bool,
    #[serde(default)]
    category: Option<String>,
    #[serde(default, rename = "ratingAverage")]
    rating_average: Option<f64>,
    #[serde(default, rename = "ratingCount")]
    rating_count: Option<u64>,
    /// Monetization view (`{ amountMinor, currency, kind }`), present only for PAID
    /// items — the hosted server emits `null` for free ones. Carried onto the card
    /// so a paid listing still reads as paid once it is folded into the unified
    /// first-party view alongside the free git catalog; without it the merged list
    /// showed every paid item as if it were free, and the price only reappeared
    /// after the user reached checkout. Display only: pricing is not an install
    /// decision, and the signed handoff remains available before checkout.
    #[serde(default)]
    pricing: Option<Value>,
    /// True only when the hosted server says this paid app is included in the
    /// recurring A Major Pass publisher pool. Display only; it does not
    /// control install or runtime access.
    #[serde(default, rename = "membershipIncluded")]
    membership_included: bool,
    /// True when the hosted server vouches for the item as first-party. Used to
    /// order the unified view (first-party above third-party) rather than to grant
    /// any trust — trust comes from the signed manifest.
    #[serde(default, rename = "firstParty")]
    first_party: bool,
    /// The PUBLISHING ORGANIZATION's identity has been verified by Ryu — the
    /// X/Meta-style blue check. Three distinct trust axes ride this catalog and
    /// must never be folded together:
    ///   1. `reviewed`     — did Ryu vet this LISTING's code (stamped `false` on
    ///                       every community card by `github_topic.rs`);
    ///   2. `verification` — did this listing's manifest SIGNATURE verify, i.e.
    ///                       install trust (decided at install, not on the card);
    ///   3. `org_verified` — is the PUBLISHING ORG identity-verified (this field).
    /// A verified org can publish an unreviewed listing and an unverified
    /// individual can publish a reviewed one; both are normal and both render.
    ///
    /// `Option<bool>` rather than the plain `bool` its `firstParty` neighbour uses,
    /// deliberately: that pattern collapses absent and explicit-`false` into the
    /// same emitted output, and here they mean different things. Absent means the
    /// server sent NO org-verification signal at all (an older marketplace build),
    /// which must stay absent downstream — projecting it as `false` would render a
    /// positive "this publisher is not verified" claim nobody actually made.
    ///
    /// Server-derived either way: never a manifest's or a client's self-claim,
    /// since "I am who I say I am" is exactly what a hostile listing asserts.
    #[serde(default, rename = "orgVerified")]
    org_verified: Option<bool>,
    /// Which tier the publishing org holds ("official" / "partner" / "community").
    /// Only meaningful alongside a true `org_verified` — a tier without the flag
    /// renders nothing.
    #[serde(default, rename = "orgVerifiedTier")]
    org_verified_tier: Option<String>,
    /// Canonical publisher trust level: `gold` is Ryu staff verification,
    /// `blue` is Stripe Connect identity verification, and `dotted` means
    /// the publisher is allowed to publish without identity verification.
    #[serde(default, rename = "publisherTrust")]
    publisher_trust: Option<String>,
    #[serde(default, rename = "publisherTrustSource")]
    publisher_trust_source: Option<String>,
    /// Public evidence behind the publisher mark (`verifiedSince` plus method
    /// ids/labels), kept opaque here so Core can forward newer methods without
    /// needing to know the presentation vocabulary.
    #[serde(default, rename = "publisherVerification")]
    publisher_verification: Option<Value>,
    /// The plugin's declared dependency closure + host surfaces, when the
    /// marketplace server exposes them on the card. Raw JSON, and `Option` so an
    /// older server that omits the columns still parses (the fields survive inside
    /// the signed manifest regardless — the card copy is a browse-time convenience,
    /// and the install path reads the manifest, never this).
    #[serde(default)]
    requires: Option<Value>,
    #[serde(default)]
    targets: Option<Value>,
    /// Per-surface support levels from the hosted catalog. Optional for older
    /// marketplace servers; local manifest detail remains the fallback.
    #[serde(default, rename = "surfaceSupport")]
    surface_support: Option<Value>,
    /// GitHub-backed package identity and public download metadata. The
    /// installation URL is a relative Ryu route; Core never receives a GitHub
    /// token or a raw release URL from this card.
    #[serde(default, rename = "packageKind")]
    package_kind: Option<String>,
    #[serde(default, rename = "githubSource")]
    github_source: Option<Value>,
    #[serde(default, rename = "downloadUrl")]
    download_url: Option<String>,
    #[serde(default, rename = "packageChecksum")]
    package_checksum: Option<String>,
    /// Deprecation notice from the listing's manifest — any shape the plugin
    /// manifest accepts; normalised on projection. Absent ⇒ current.
    #[serde(default, deserialize_with = "lenient_deprecation")]
    deprecated: Option<crate::plugin_manifest::Deprecation>,
    /// Whether the author allows remixes. The hosted server always resolves it
    /// (absent manifest field ⇒ true); absent here means an older server, which
    /// is read the same way. Raw JSON so a malformed value never fails the
    /// envelope; only `false` opts out.
    #[serde(default, rename = "allowRemix")]
    allow_remix: Option<Value>,
    /// The listing this one remixes (`{ kind, id, version }`), as credited by its
    /// manifest. Display only; kept opaque and validated by the render layer.
    #[serde(default, rename = "remixedFrom")]
    remixed_from: Option<Value>,
}

/// The marketplace `GET /catalog` envelope.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct MarketplaceListEnvelope {
    #[serde(default)]
    items: Vec<MarketplaceCard>,
    /// Opaque cursor for the next page; null/absent on the last page (and from
    /// servers that predate catalog paging).
    #[serde(default, rename = "nextCursor")]
    next_cursor: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct MarketplaceCacheEnvelope<T> {
    fetched_at: u64,
    value: T,
}

struct MarketplaceCards {
    cards: Vec<MarketplaceCard>,
    next_cursor: Option<String>,
    stale: bool,
}

/// One cached `/catalog` page: the cards plus the cursor that continues it.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
struct MarketplacePage {
    cards: Vec<MarketplaceCard>,
    #[serde(default)]
    next_cursor: Option<String>,
}

/// The on-disk cache value. Caches written before paging stored a bare card
/// array; they still load (as a last page) so an upgrade keeps offline browse.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
enum MarketplaceDiskPage {
    Page(MarketplacePage),
    Legacy(Vec<MarketplaceCard>),
}

impl From<MarketplaceDiskPage> for MarketplacePage {
    fn from(value: MarketplaceDiskPage) -> Self {
        match value {
            MarketplaceDiskPage::Page(page) => page,
            MarketplaceDiskPage::Legacy(cards) => Self {
                cards,
                next_cursor: None,
            },
        }
    }
}

const RYU_MARKETPLACE_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const RYU_MARKETPLACE_CACHE_DIR: &str = "ryu-marketplace-catalog";

type MarketplaceMemoryCache =
    std::collections::HashMap<String, (std::time::Instant, MarketplacePage)>;

static RYU_MARKETPLACE_MEMORY_CACHE: OnceLock<std::sync::Mutex<MarketplaceMemoryCache>> =
    OnceLock::new();

fn marketplace_cache_key(
    base: &str,
    kind: CatalogKind,
    query: &str,
    limit: usize,
    offset: Option<u64>,
) -> String {
    match offset {
        // The first page keeps its pre-paging key so existing disk caches still hit.
        None => format!("{base}\n{}\n{}\n{limit}", kind.as_str(), query.trim()),
        Some(offset) => format!(
            "{base}\n{}\n{}\n{limit}\n{offset}",
            kind.as_str(),
            query.trim()
        ),
    }
}

fn marketplace_cache_path(key: &str) -> PathBuf {
    use sha2::{Digest, Sha256};

    crate::paths::cache_dir()
        .join(RYU_MARKETPLACE_CACHE_DIR)
        .join(format!(
            "{}.json",
            hex::encode(Sha256::digest(key.as_bytes()))
        ))
}

fn now_unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

fn marketplace_memory_cache_get(key: &str, allow_stale: bool) -> Option<MarketplaceCards> {
    let cache = RYU_MARKETPLACE_MEMORY_CACHE.get_or_init(Default::default);
    let guard = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let (fetched_at, page) = guard.get(key)?;
    let stale = fetched_at.elapsed() >= RYU_MARKETPLACE_CACHE_TTL;
    if stale && !allow_stale {
        return None;
    }
    Some(MarketplaceCards {
        cards: page.cards.clone(),
        next_cursor: page.next_cursor.clone(),
        stale,
    })
}

fn marketplace_memory_cache_set(key: String, page: MarketplacePage) {
    let cache = RYU_MARKETPLACE_MEMORY_CACHE.get_or_init(Default::default);
    let mut guard = cache
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if guard.len() >= 128 && !guard.contains_key(&key) {
        let oldest = guard
            .iter()
            .min_by_key(|(_, (fetched_at, _))| *fetched_at)
            .map(|(key, _)| key.clone());
        if let Some(oldest) = oldest {
            guard.remove(&oldest);
        }
    }
    guard.insert(key, (std::time::Instant::now(), page));
}

fn read_marketplace_disk_cache(key: &str) -> Option<MarketplaceCacheEnvelope<MarketplacePage>> {
    let raw = std::fs::read_to_string(marketplace_cache_path(key)).ok()?;
    let envelope: MarketplaceCacheEnvelope<MarketplaceDiskPage> =
        serde_json::from_str(&raw).ok()?;
    Some(MarketplaceCacheEnvelope {
        fetched_at: envelope.fetched_at,
        value: envelope.value.into(),
    })
}

fn write_marketplace_disk_cache(key: &str, page: &MarketplacePage) {
    let path = marketplace_cache_path(key);
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let envelope = MarketplaceCacheEnvelope {
        fetched_at: now_unix_seconds(),
        value: page,
    };
    let Ok(json) = serde_json::to_vec(&envelope) else {
        return;
    };
    let temporary = path.with_extension("json.tmp");
    if std::fs::write(&temporary, json).is_ok() {
        let _ = std::fs::rename(temporary, path);
    }
}

fn disk_cache_is_fresh(fetched_at: u64) -> bool {
    now_unix_seconds().saturating_sub(fetched_at) <= RYU_MARKETPLACE_CACHE_TTL.as_secs()
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

    /// Resolve the API base URL: an explicit `base_url`, else the env override
    /// (`RYU_MARKETPLACE_API_URL`), else the hosted-marketplace default. Trailing
    /// slash trimmed.
    fn resolve_base(&self) -> String {
        self.base_url
            .clone()
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.trim_end_matches('/').to_owned())
            .unwrap_or_else(ryu_marketplace_base)
    }

    /// Fetch one page of search results for this source's kind. A plain
    /// (non-guarded) reqwest GET against the trusted first-party endpoint —
    /// `guarded_get` would block the localhost dev URL. `offset` is the parsed
    /// `cursor` of a previous page (see [`super::parse_marketplace_cursor`]).
    async fn fetch_cards(
        &self,
        client: &reqwest::Client,
        query: &str,
        limit: usize,
        offset: Option<u64>,
    ) -> Result<MarketplaceCards> {
        let base = self.resolve_base();
        let cache_key = marketplace_cache_key(&base, self.kind, query, limit, offset);
        if let Some(cached) = marketplace_memory_cache_get(&cache_key, false) {
            return Ok(cached);
        }
        // Only the first unfiltered page is kept on disk: it is the offline
        // browse fallback, and deeper pages are not worth the disk churn.
        let cache_on_disk = query.trim().is_empty() && offset.is_none();
        if cache_on_disk {
            if let Some(cached) = read_marketplace_disk_cache(&cache_key) {
                if disk_cache_is_fresh(cached.fetched_at) {
                    marketplace_memory_cache_set(cache_key.clone(), cached.value.clone());
                    return Ok(MarketplaceCards {
                        cards: cached.value.cards,
                        next_cursor: cached.value.next_cursor,
                        stale: false,
                    });
                }
            }
        }
        let cursor_param = offset.map_or_else(String::new, |offset| format!("&cursor={offset}"));
        let url = format!(
            "{}/api/marketplace/catalog?kind={}&query={}&limit={}{cursor_param}",
            base,
            self.kind.as_str(),
            urlencode_component(query.trim()),
            limit.max(1),
        );
        let fetched = async {
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
            // Only a cursor this source could later accept is passed on, so a
            // client can never be handed a page token that answers 400.
            let next_cursor = super::parse_marketplace_cursor(env.next_cursor.as_deref())
                .ok()
                .flatten()
                .map(|next| next.to_string());
            Ok::<MarketplacePage, anyhow::Error>(MarketplacePage {
                cards: env.items,
                next_cursor,
            })
        }
        .await;
        match fetched {
            Ok(page) => {
                marketplace_memory_cache_set(cache_key.clone(), page.clone());
                if cache_on_disk {
                    write_marketplace_disk_cache(&cache_key, &page);
                }
                Ok(MarketplaceCards {
                    cards: page.cards,
                    next_cursor: page.next_cursor,
                    stale: false,
                })
            }
            Err(error) => {
                if let Some(cached) = marketplace_memory_cache_get(&cache_key, true) {
                    return Ok(cached);
                }
                if cache_on_disk {
                    if let Some(cached) = read_marketplace_disk_cache(&cache_key) {
                        return Ok(MarketplaceCards {
                            cards: cached.value.cards,
                            next_cursor: cached.value.next_cursor,
                            stale: true,
                        });
                    }
                }
                Err(error)
            }
        }
    }

    /// Fetch one item's detail (manifest + descriptor) for this source's kind.
    ///
    /// `catalog/detail` is the signed install handoff. When a buyer bearer is
    /// present — the per-request token threaded from the install handler's
    /// `Authorization` header via [`with_buyer_token`], else the
    /// `RYU_MARKETPLACE_TOKEN` headless fallback — it is forwarded for optional
    /// account-aware Marketplace behavior. Any upstream 402 is reported as an
    /// upstream service response, not treated as the local access policy.
    async fn fetch_detail(&self, client: &reqwest::Client, id: &str) -> Result<Value> {
        self.fetch_detail_on_channel(client, id, None, false).await
    }

    /// [`Self::fetch_detail`] for ONE release channel.
    ///
    /// `channel: None` asks for the listing's default train, which the control
    /// plane defines as `stable` — the same meaning `pick_version_for_channel`
    /// gives an empty channel. A named channel is sent verbatim and the server
    /// answers 404 when that train has no build, which the caller must surface
    /// rather than retrying without it: falling back is how someone on `canary`
    /// silently ends up installing stable.
    ///
    /// `install` marks the request as an actual install, which is the only kind
    /// of request that may spend a bounded-update purchase's allowance; a detail
    /// view must pass `false`.
    async fn fetch_detail_on_channel(
        &self,
        client: &reqwest::Client,
        id: &str,
        channel: Option<&str>,
        install: bool,
    ) -> Result<Value> {
        let channel_param = channel
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(|c| format!("&channel={}", urlencode_component(c)))
            .unwrap_or_default();
        let operation_param = if install { "&operation=install" } else { "" };
        let url = format!(
            "{}/api/marketplace/catalog/detail?kind={}&id={}{channel_param}{operation_param}",
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
        if !resp.status().is_success() {
            // A channelled request that 404s means that TRAIN has no build — a
            // materially different fact from "no such item", and the one the user
            // needs to read when they picked `canary` on a listing that only ships
            // stable. Say which was asked for; never retry without it.
            if let Some(channel) = channel.map(str::trim).filter(|c| !c.is_empty()) {
                bail!(
                    "Ryu Marketplace item `{id}` has nothing published on the `{channel}` channel ({} from {url})",
                    resp.status()
                );
            }
            bail!(
                "Ryu Marketplace item `{id}` not found ({} from {url})",
                resp.status()
            );
        }
        resp.json()
            .await
            .map_err(|e| anyhow::anyhow!("parsing Ryu Marketplace detail {url}: {e}"))
    }

    /// Fetch one exact historical version. The control plane validates the
    /// immutable release and returns an error when it cannot serve that tag;
    /// this method never retries without the requested version.
    async fn fetch_detail_on_version(
        &self,
        client: &reqwest::Client,
        id: &str,
        version: &str,
    ) -> Result<Value> {
        let version = version.trim();
        if version.is_empty() {
            bail!("historical Marketplace version must not be empty");
        }
        // Only the install path reaches here, so it is an install request.
        let url = format!(
            "{}/api/marketplace/catalog/detail?kind={}&id={}&version={}&operation=install",
            self.resolve_base(),
            self.kind.as_str(),
            urlencode_path(id.trim()),
            urlencode_component(version),
        );
        let mut req = client.get(&url);
        if let Some(token) = marketplace_buyer_token() {
            req = req.bearer_auth(token);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("fetching Ryu Marketplace detail {url}: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            // The control plane says why it will not serve this exact version (for
            // example, it has not passed Marketplace review). Relay that.
            match control_plane_refusal(resp).await {
                Some(reason) => bail!("Ryu Marketplace item `{id}`: {reason} ({status})"),
                None => bail!(
                    "Ryu Marketplace item `{id}` has no published `{version}` build ({status} from {url})"
                ),
            }
        }
        resp.json()
            .await
            .map_err(|e| anyhow::anyhow!("parsing Ryu Marketplace detail {url}: {e}"))
    }

    /// The release channels this listing publishes, each with the version that
    /// channel currently resolves to — read from the control plane, the same shape
    /// [`crate::catalog_source::github_listing_channels`] returns for a
    /// repo-published listing.
    ///
    /// Empty (never an error) when the server is unreachable or predates the
    /// endpoint, so a caller renders no picker rather than a broken one. An EMPTY
    /// list must never be read as "stable is fine": it means "unknown", and the
    /// install path keeps whatever channel it was told to use.
    pub async fn fetch_channels(
        &self,
        client: &reqwest::Client,
        id: &str,
    ) -> Vec<(String, String)> {
        let url = format!(
            "{}/api/marketplace/catalog/channels?kind={}&id={}",
            self.resolve_base(),
            self.kind.as_str(),
            urlencode_path(id.trim()),
        );
        let Ok(resp) = client.get(&url).send().await else {
            return Vec::new();
        };
        if !resp.status().is_success() {
            return Vec::new();
        }
        let Ok(body) = resp.json::<Value>().await else {
            return Vec::new();
        };
        body.get("channels")
            .and_then(|c| c.as_array())
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let channel = row.get("channel")?.as_str()?.trim();
                        let version = row.get("version").and_then(|v| v.as_str()).unwrap_or("");
                        (!channel.is_empty())
                            .then(|| (channel.to_ascii_lowercase(), version.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Verify-on-install (#468): reject a tampered manifest before any install
    /// work. The detail document carries the Gateway-issued `signature` (over the
    /// canonical `{ descriptor, manifest }`) and its `signingPublicKey`.
    /// We ask the Gateway's `/v1/manifests/verify` to check them.
    ///
    /// Trust policy ([`marketplace_trust_anchor`]):
    /// - A runtime `RYU_MARKETPLACE_PUBLIC_KEY` wins (operator / self-host pin);
    ///   else the key compiled in at build time from the same variable (the
    ///   shipped production pin) is the verifier.
    /// - With no pinned key, a shipped (optimized, non-`dev`) build FAILS CLOSED:
    ///   the local Gateway's resident key is on this machine and proves nothing
    ///   about the hosted Marketplace.
    /// - Only a debug build or the `dev` profile sends NO key so the Gateway
    ///   verifies with its own resident key (same-gateway dev path).
    ///
    /// The manifest-supplied `signingPublicKey` is NEVER used as the trust anchor:
    /// trusting it would be self-attested signing (a tamperer ships their own key
    /// + a matching signature and "passes"). That field is for display / rotation
    /// cross-checks only.
    ///
    /// Fail policy (mirrors the lifecycle grant seam):
    /// - signature present + invalid  -> reject (the tamper case).
    /// - signature absent             -> reject before any install work.
    /// - gateway unreachable          -> reject (fail closed).
    ///
    /// Browsing unsigned listings does not enter this boundary. Installation
    /// returns `Ok(true)` only after the complete signed envelope verifies.
    async fn verify_manifest_signature(
        &self,
        client: &reqwest::Client,
        id: &str,
        detail: &Value,
    ) -> Result<bool> {
        let public_key = marketplace_trust_anchor()?;
        let gateway = crate::sidecar::gateway::gateway_url();
        let url = format!("{}/v1/manifests/verify", gateway.trim_end_matches('/'));
        verify_marketplace_install_at(client, id, detail, &url, public_key.as_deref()).await
    }

    /// The empty, per-kind search envelope keyed on `self.kind`, with a `note`
    /// explaining the degrade. Mirrors Smithery's tolerant-search behavior.
    fn empty_envelope(&self, note: &str) -> Value {
        let cards: Vec<Value> = Vec::new();
        self.wrap_envelope(cards, None, Some(note))
    }

    /// Wrap a list of per-kind cards in the envelope the matching desktop tab
    /// expects: model `{ models }`, skill `{ skills }`, mcp `{ servers }`,
    /// plugin `{ items }`, plus the `next_cursor` that continues the page.
    fn wrap_envelope(
        &self,
        cards: Vec<Value>,
        next_cursor: Option<String>,
        note: Option<&str>,
    ) -> Value {
        let key = envelope_key(self.kind);
        let mut obj = serde_json::Map::new();
        obj.insert(key.to_string(), Value::Array(cards));
        obj.insert(
            "next_cursor".to_string(),
            next_cursor.map_or(Value::Null, Value::String),
        );
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
                "icon_url": card.icon_url,
                "category": card.category,
                "rating_average": card.rating_average.unwrap_or(0.0),
                "rating_count": card.rating_count.unwrap_or(0),
            }),
            CatalogKind::Skill => serde_json::json!({
                "id": card.id,
                "source": self.display_name,
                "slug": card.id.rsplit('/').next().unwrap_or(&card.id),
                "name": card.name,
                "description": card.description,
                "installs": 0,
                "installed": false,
                "icon_url": card.icon_url,
                "category": card.category,
                "rating_average": card.rating_average.unwrap_or(0.0),
                "rating_count": card.rating_count.unwrap_or(0),
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
                "icon_url": card.icon_url,
                "category": card.category,
                "rating_average": card.rating_average.unwrap_or(0.0),
                "rating_count": card.rating_count.unwrap_or(0),
            }),
            CatalogKind::Plugin => {
                let mut value = serde_json::json!({
                    "id": card.id,
                    "name": card.name,
                    "description": card.description,
                    "author": card.author,
                    "version": card.version,
                    "install_source": card.install_source,
                    "package_kind": card.package_kind,
                    "github_source": card.github_source,
                    "download_url": card.download_url,
                    "package_checksum": card.package_checksum,
                    "installed": false,
                    "icon_url": card.icon_url,
                    "category": card.category,
                    "rating_average": card.rating_average.unwrap_or(0.0),
                    "rating_count": card.rating_count.unwrap_or(0),
                });
                // The dependency closure + surfaces, when the marketplace server
                // exposes them on the card. Emitted only when present/non-empty
                // (empty `targets` = every surface). Display only — the install path
                // reads the SIGNED manifest, never the card.
                if let Some(obj) = value.as_object_mut() {
                    if let Some(requires) = card.requires.clone().filter(|v| !v.is_null()) {
                        obj.insert("requires".to_owned(), requires);
                    }
                    if let Some(targets) = card
                        .targets
                        .as_ref()
                        .and_then(|v| v.as_array())
                        .filter(|a| !a.is_empty())
                    {
                        obj.insert("targets".to_owned(), serde_json::json!(targets));
                    }
                    if let Some(surface_support) = card
                        .surface_support
                        .clone()
                        .filter(|value| value.as_array().is_some_and(|items| !items.is_empty()))
                    {
                        obj.insert("surface_support".to_owned(), surface_support);
                    }
                    // Icon glyph + dither background + app-ness — see `MarketplaceCard`.
                    if let Some(icon) = &card.icon {
                        obj.insert("icon".to_owned(), serde_json::json!(icon));
                    }
                    if let Some(dither) = card.icon_dither.clone().filter(|v| !v.is_null()) {
                        obj.insert("icon_dither".to_owned(), dither);
                    }
                    // A theme listing's palette — see `MarketplaceCard::theme_preview`.
                    if let Some(preview) = card.theme_preview.clone().filter(|v| !v.is_null()) {
                        obj.insert("theme_preview".to_owned(), preview);
                    }
                    if card.has_companion {
                        obj.insert("has_companion".to_owned(), serde_json::json!(true));
                    }
                    // Commerce disclosure — see the `pricing` note on `MarketplaceCard`.
                    if let Some(pricing) = card.pricing.clone().filter(|v| !v.is_null()) {
                        obj.insert("pricing".to_owned(), pricing);
                    }
                    obj.insert(
                        "membership_included".to_owned(),
                        serde_json::json!(card.membership_included),
                    );
                    if card.first_party {
                        obj.insert("first_party".to_owned(), serde_json::json!(true));
                    }
                    // Publisher identity trust is the canonical badge signal;
                    // the org fields remain as a compatibility projection for
                    // older desktop clients.
                    if let Some(trust) = card
                        .publisher_trust
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        obj.insert("publisher_trust".to_owned(), serde_json::json!(trust));
                    }
                    if let Some(source) = card
                        .publisher_trust_source
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        obj.insert(
                            "publisher_trust_source".to_owned(),
                            serde_json::json!(source),
                        );
                    }
                    if let Some(verification) = card
                        .publisher_verification
                        .clone()
                        .filter(|value| !value.is_null())
                    {
                        obj.insert("publisher_verification".to_owned(), verification);
                    }
                    if let Some(org_verified) = card.org_verified {
                        obj.insert("org_verified".to_owned(), serde_json::json!(org_verified));
                    }
                    if let Some(tier) = card
                        .org_verified_tier
                        .as_deref()
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                    {
                        obj.insert("org_verified_tier".to_owned(), serde_json::json!(tier));
                    }
                    if let Some(notice) = card
                        .deprecated
                        .as_ref()
                        .and_then(crate::plugin_manifest::Deprecation::notice)
                    {
                        obj.insert("deprecated".to_owned(), serde_json::json!(notice));
                    }
                    obj.insert(
                        "allow_remix".to_owned(),
                        serde_json::json!(
                            card.allow_remix.as_ref().and_then(Value::as_bool) != Some(false)
                        ),
                    );
                    if let Some(source) = card.remixed_from.clone().filter(Value::is_object) {
                        obj.insert("remixed_from".to_owned(), source);
                    }
                }
                value
            }
            // Knowledge and Agent share the plain card shape: neither carries a
            // manifest surface (`requires`/`targets`/companion), and an agent's
            // real payload is the template resolved at detail/install time.
            CatalogKind::Knowledge | CatalogKind::Agent => serde_json::json!({
                "id": card.id,
                "name": card.name,
                "description": card.description,
                "author": card.author,
                "version": card.version,
                "install_source": card.install_source,
                "installed": false,
                "icon_url": card.icon_url,
                "category": card.category,
                "rating_average": card.rating_average.unwrap_or(0.0),
                "rating_count": card.rating_count.unwrap_or(0),
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
                // Plugin: carry ONLY the signed manifest here. The unsigned
                // server-served `uiCode` blob is deliberately NOT copied into
                // `raw` — `install_descriptor` overwrites `raw` with the manifest
                // plus the VALIDATED ui_code (or null) after the signature +
                // sha256 integrity gate. Never surface unvalidated code.
                Ok(InstallDescriptor {
                    kind: CatalogKind::Plugin,
                    source_id: self.id.clone(),
                    repo_id: id.to_string(),
                    files: Vec::new(),
                    raw: serde_json::json!({
                        "manifest": detail.get("manifest").cloned().unwrap_or(Value::Null),
                    }),
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
            CatalogKind::Agent => {
                // Agent: the descriptor carries the portable agent template
                // (`{ template: { kind: "agent", name, version, agent_config } }`) —
                // byte-for-byte what `GET /api/agents/:id/export` emits, so the
                // install path can hand it straight to the EXISTING importer. Same
                // fallback as Knowledge: an older server that stores the template at
                // the detail root rather than under `descriptor` still resolves.
                //
                // No sanitisation happens here by design: a source resolves
                // descriptors, it never decides trust. Core strips the
                // privilege-bearing fields at install
                // (`AgentTemplate::sanitize_for_untrusted_install`).
                Ok(InstallDescriptor {
                    kind: CatalogKind::Agent,
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

    /// Resolve an MCP [`crate::mcp_catalog::ServerJson`] from a fetched detail's
    /// descriptor. The caller still has to verify the marketplace signature and
    /// package registry metadata before turning a stdio descriptor into a launch
    /// command.
    fn detail_to_mcp_server(
        &self,
        id: &str,
        detail: &Value,
    ) -> Result<crate::mcp_catalog::ServerJson> {
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
                Ok(crate::mcp_catalog::ServerJson::remote(
                    server_name,
                    description,
                    url,
                ))
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
                Ok(crate::mcp_catalog::ServerJson::npm_stdio(
                    server_name,
                    description,
                    identifier,
                    version,
                ))
            }
            other => bail!("Ryu Marketplace mcp `{id}` has unsupported descriptor kind `{other}`"),
        }
    }

    /// Build a validated plan for tests and callers that already hold a signed
    /// Marketplace descriptor. The live install route additionally verifies the
    /// package registry metadata before it calls this helper.
    fn detail_to_mcp_plan(
        &self,
        id: &str,
        detail: &Value,
    ) -> Result<crate::mcp_catalog::InstallPlan> {
        let mut server = self.detail_to_mcp_server(id, detail)?;
        server.mark_package_provenance_verified();
        crate::mcp_catalog::plan_from_server(&server)
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

    /// One page of the hosted catalog. `q.cursor` is the `next_cursor` of the
    /// previous page and is validated with the control plane's rules: a cursor
    /// it could not have issued is an [`super::InvalidCatalogCursor`] error (a
    /// route answers 400) rather than a silent restart at page one. `q.limit` is
    /// clamped to the server's page bound.
    async fn search(&self, client: &reqwest::Client, q: &CatalogQuery) -> Result<Value> {
        let limit = if q.limit == 0 {
            40
        } else {
            q.limit.min(super::MARKETPLACE_CATALOG_MAX_LIMIT)
        };
        let offset = super::parse_marketplace_cursor(q.cursor.as_deref())?;
        match self.fetch_cards(client, &q.query, limit, offset).await {
            Ok(result) => {
                let values: Vec<Value> =
                    result.cards.iter().map(|c| self.card_to_value(c)).collect();
                let note = result
                    .stale
                    .then_some("Ryu Marketplace is unavailable; showing cached listings.");
                Ok(self.wrap_envelope(values, result.next_cursor, note))
            }
            // Degrade to an empty, labelled per-kind envelope when there is no
            // previous browse result (for example, a first launch while offline).
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
        self.install_descriptor_on_channel(client, id, None).await
    }
}

impl RyuMarketplaceSource {
    /// [`CatalogSource::install_descriptor`] for ONE release channel.
    ///
    /// The channel changes only WHICH published version is resolved; every trust
    /// gate below is unchanged and runs identically on a prerelease. A nightly is
    /// signature-verified and ui_code-hash-checked exactly like a stable build —
    /// the channel is a selection, never a relaxation.
    pub async fn install_descriptor_on_channel(
        &self,
        client: &reqwest::Client,
        id: &str,
        channel: Option<&str>,
    ) -> Result<InstallDescriptor> {
        let detail = self
            .fetch_detail_on_channel(client, id, channel, true)
            .await?;
        self.install_descriptor_from_detail(client, id, detail)
            .await
    }

    /// Resolve one exact historical release selected from the Versions tab.
    /// Unlike a channel, this never asks the source for its current build.
    pub async fn install_descriptor_on_version(
        &self,
        client: &reqwest::Client,
        id: &str,
        version: &str,
    ) -> Result<InstallDescriptor> {
        let detail = self.fetch_detail_on_version(client, id, version).await?;
        self.install_descriptor_from_detail(client, id, detail)
            .await
    }

    async fn install_descriptor_from_detail(
        &self,
        client: &reqwest::Client,
        id: &str,
        detail: Value,
    ) -> Result<InstallDescriptor> {
        require_install_entitlement(id, &detail)?;
        // Verify-on-install (#468): reject a tampered manifest before mapping it
        // onto an install descriptor. `signed` is true only when a signature was
        // present AND verified valid.
        let signed = self.verify_manifest_signature(client, id, &detail).await?;
        // The control plane just confirmed entitlement; remember it so the
        // enable-time license re-check has a last-good answer offline.
        super::license::remember_install_entitlement(
            self.kind.as_str(),
            id,
            detail_is_paid(&detail),
        );

        self.descriptor_from_verified_detail(id, detail, signed)
    }

    fn descriptor_from_verified_detail(
        &self,
        id: &str,
        detail: Value,
        signed: bool,
    ) -> Result<InstallDescriptor> {
        if !signed {
            bail!("Marketplace item `{id}` is unverified; refusing executable install");
        }
        // Plugin CODE CARRIAGE: bind the bundled UI code to the signed manifest
        // via its sha256. The code rides OUTSIDE the signed manifest (server
        // top-level `uiCode`); its integrity comes from `manifest.ui_code_sha256`
        // (which IS signed). The gate is fail-closed: a valid signature +
        // declared-hash mismatch (a registry-tamper / MITM that swapped the code
        // after signing) is a hard reject; an unsigned item carries no code. Only
        // the VALIDATED code reaches `raw`.
        if self.kind == CatalogKind::Plugin {
            let mut descriptor = self.detail_to_descriptor(id, &detail)?;
            let ui_code = gate_plugin_ui_code(id, &detail, signed)?;
            let mut manifest = detail.get("manifest").cloned().unwrap_or(Value::Null);
            // Backend CODE CARRIAGE (HIGH-2): unlike `ui_code`, the node backend
            // bundle rides INLINE in the manifest, so a valid signature already
            // covers it — but an UNSIGNED item carries executable `backend_code`
            // attested by nothing (only a self-referential `backend_sha256` the
            // attacker controls both sides of). Strip it before it lands in
            // `descriptor.raw` (which `install_plugin_from_catalog` deserializes and
            // persists) so unattested backend never reaches disk. Signed items are
            // untouched — the code is inside the verified surface.
            gate_plugin_backend_code(id, &mut manifest, signed);
            descriptor.raw = serde_json::json!({
                "manifest": manifest,
                "ui_code": ui_code,
                "signature_verified": signed,
                "publisherOrg": detail.get("publisherOrg"),
                "orgVerified": detail.get("orgVerified"),
                "orgVerifiedTier": detail.get("orgVerifiedTier"),
            });
            return Ok(descriptor);
        }

        // ARTIFACT CARRIAGE: the generalized sibling of the plugin path for a
        // `ryu_bundle` NON-plugin item (today: a skill). Its artifact is served as
        // a base64 bundle whose integrity anchor is the signed
        // `manifest.artifact_sha256`. When a validated bundle is present, carry it
        // in `raw` and skip the public-source descriptor entirely (a bundle-served
        // skill deliberately advertises NO public `install_source`, closing the
        // pay-then-clone-the-repo leak). `gate_artifact` returns `None` for a free
        // item, a public-source item, or a paid `private_repo` item (Phase 4B),
        // leaving the existing public install path untouched.
        if let Some(artifact_b64) = gate_artifact(id, &detail, signed)? {
            return Ok(InstallDescriptor {
                kind: self.kind,
                source_id: self.id.clone(),
                repo_id: id.to_string(),
                files: Vec::new(),
                raw: serde_json::json!({ "artifact_bundle_b64": artifact_b64 }),
            });
        }

        self.detail_to_descriptor(id, &detail)
    }
}

/// Install verification is mandatory; browsing does not enter this boundary.
pub(super) async fn verify_marketplace_install_at(
    client: &reqwest::Client,
    id: &str,
    detail: &Value,
    url: &str,
    public_key: Option<&str>,
) -> Result<bool> {
    let signature = detail
        .get("signature")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("Marketplace item `{id}` has no signature; refusing install")
        })?;
    let manifest = marketplace_signature_payload(detail);
    // Only a pinned key (runtime or compiled-in) is trusted. `None` reaches here
    // only in dev/test builds (see `marketplace_trust_anchor`), where the
    // Gateway verifies with its own resident key. The manifest's own
    // `signingPublicKey` is deliberately NOT used (self-attestation bypass).
    let mut payload = serde_json::Map::new();
    payload.insert("manifest".to_string(), manifest);
    payload.insert(
        "signature".to_string(),
        Value::String(signature.to_string()),
    );
    if let Some(pk) = public_key {
        payload.insert("public_key".to_string(), Value::String(pk.to_owned()));
    }

    let resp = client
        .post(url)
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
        Ok(true)
    } else {
        bail!("manifest signature is invalid for `{id}`; refusing install (tampered manifest)")
    }
}

/// The publisher signs both the launch/install descriptor and manifest.
fn marketplace_signature_payload(detail: &Value) -> Value {
    serde_json::json!({
        "descriptor": detail.get("descriptor").cloned().unwrap_or(Value::Null),
        "manifest": detail.get("manifest").cloned().unwrap_or(Value::Null),
    })
}

/// Maximum size of a plugin's bundled sandboxed-UI code, enforced fail-closed at
/// the integrity gate (mirrors the Core install cap so a pathological bundle is
/// refused before it is ever stored). 32 MiB.
const MAX_UI_CODE_BYTES: usize = 32 * 1024 * 1024;

/// Lower-case hex `sha256(utf8_bytes(s))`. The SDK (`ryu pack`) hashes the exact
/// same UTF-8 bytes with the same lower-case-hex encoding, so JS and Rust agree
/// byte-for-byte. Reuses the existing `sha2`/`hex` deps — no hand-rolled crypto.
fn compute_ui_code_sha256(s: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// The fail-closed ui_code carriage ladder for a Plugin marketplace/URL install.
///
/// The trust decision (carrying/running code REQUIRES a valid signature attesting
/// the hash — never a self-declared hash on an unsigned item):
/// - unsigned (`signed == false`)                         -> `Ok(None)` (benign
///   summary; NEVER run code off an unattested hash, even if it "matches").
/// - signed, manifest declares no `ui_code_sha256`         -> `Ok(None)` (a
///   manifest-only plugin: nothing to carry).
/// - signed, hash declared, code served, hashes MATCH      -> `Ok(Some(code))`.
/// - signed, hash declared, code MISSING or hash MISMATCH  -> `Err` (HARD reject —
///   active tampering: the code was stripped/swapped after signing; the whole
///   install fails and stores nothing).
///
/// `detail` is the raw server-shaped detail document: the declared hash is read
/// from the SIGNED `detail["manifest"]["ui_code_sha256"]` (snake, as the SDK wrote
/// it into the signed surface) and the code blob from the UNSIGNED top-level
/// `detail["uiCode"]` (camel, as the control plane serves it).
fn gate_plugin_ui_code(id: &str, detail: &Value, signed: bool) -> Result<Option<String>> {
    // The declared hash lives INSIDE the signed manifest object.
    let declared = detail
        .get("manifest")
        .and_then(|m| m.get("ui_code_sha256"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // The code blob rides OUTSIDE the manifest, as the server's top-level `uiCode`.
    let code = detail
        .get("uiCode")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    if !signed {
        // Unsigned item: install the manifest as a benign summary but NEVER carry
        // code — nothing attests the declared hash, so a matching hash is not
        // trust, it is self-attestation (a bypass).
        return Ok(None);
    }
    // From here the signature was present AND verified valid.
    let Some(declared) = declared else {
        // Signed manifest declaring no code hash: a manifest-only plugin.
        return Ok(None);
    };
    // A declared hash means code existed at signing time. Missing code now = the
    // code was stripped after signing (tamper) -> hard reject.
    let Some(code) = code else {
        bail!(
            "plugin `{id}` manifest declares ui_code_sha256 but no ui_code was served; \
             refusing install (code stripped after signing)"
        );
    };
    if code.len() > MAX_UI_CODE_BYTES {
        bail!("plugin `{id}` ui_code exceeds the {MAX_UI_CODE_BYTES}-byte cap; refusing install");
    }
    let actual = compute_ui_code_sha256(code);
    if actual != declared.to_ascii_lowercase() {
        bail!(
            "plugin `{id}` ui_code hash mismatch (signed manifest declares {declared}, \
             served code hashes to {actual}); refusing install (tampered code)"
        );
    }
    Ok(Some(code.to_string()))
}

/// Strip an UNSIGNED plugin's inline node-backend bundle from `manifest` before it
/// is carried into the install descriptor.
///
/// The node backend bundle (`backend_code` + its `backend_sha256`) rides INLINE in
/// the manifest — so for a SIGNED item it is inside the Gateway-verified surface
/// and is left as-is. For an UNSIGNED item there is nothing attesting the code (the
/// self-referential `backend_sha256` is attacker-controlled on both sides), so the
/// executable blob is removed here: unattested backend code must never reach disk
/// via the marketplace path. Both keys are dropped together — leaving a dangling
/// `backend_sha256` would trip the install-door "declares hash but carries no code"
/// check. Mirrors the trust decision of [`gate_plugin_ui_code`] (carry runnable
/// code only off a valid signature). No-op when `signed` or when the manifest
/// carries no backend.
pub(crate) fn gate_plugin_backend_code(id: &str, manifest: &mut Value, signed: bool) {
    if signed {
        return;
    }
    let Some(obj) = manifest.as_object_mut() else {
        return;
    };
    let had_code = obj.remove("backend_code").is_some();
    obj.remove("backend_sha256");
    if had_code {
        tracing::warn!(
            id,
            "plugin is unsigned; stripping inline backend_code (no signature attests it — \
             unattested backend never reaches disk)"
        );
    }
}

/// Largest base64 `artifact` string carried on a bundled install. The blob is
/// a base64 `.tar.gz`; base64 is ~4/3 the raw size, so this bounds a ~4 MiB
/// archive the same way the plugin `uiCode` cap bounds its module. Refused
/// fail-closed before decode/install so a pathological blob never lands on disk.
const MAX_ARTIFACT_B64_BYTES: usize = 6 * 1024 * 1024;

/// Lower-case hex `sha256(bytes)` over the DECODED artifact bytes. The publisher's
/// packing tool hashes the same raw `.tar.gz` bytes, so the declared
/// `manifest.artifact_sha256` and this value agree byte-for-byte. Hashing the
/// DECODED bytes (not the base64 string) is the deliberate interop contract: the
/// signed anchor is the archive's own digest, independent of transport encoding.
fn compute_artifact_sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// The fail-closed carriage ladder for a `ryu_bundle` NON-plugin artifact — the
/// generalized sibling of [`gate_plugin_ui_code`]. The artifact rides OUTSIDE the
/// signed manifest (the server's top-level base64 `artifact` blob); its integrity
/// anchor is the SIGNED `manifest.artifact_sha256`. The trust ladder is identical
/// to the plugin path (carry code ONLY off a valid signature attesting the hash):
/// - unsigned                                          -> `Ok(None)` (never carry
///   bytes off an unattested hash; a matching hash would be self-attestation).
/// - signed, no `artifact_sha256` declared             -> `Ok(None)` (no bundle: a
///   free / public-source / `private_repo` (4B) item — leave install untouched).
/// - signed, hash declared, artifact served, MATCH     -> `Ok(Some(base64))`.
/// - signed, hash declared, artifact MISSING/MISMATCH  -> `Err` (HARD reject: the
///   bytes were stripped or swapped after signing).
///
/// Returns the base64 string (not decoded bytes) so it can ride in the JSON
/// descriptor `raw`; the install path decodes it once more. The hash is verified
/// here over the decoded bytes so a corrupt/oversize blob never reaches install.
fn gate_artifact(id: &str, detail: &Value, signed: bool) -> Result<Option<String>> {
    use base64::Engine as _;

    // The declared hash lives INSIDE the signed manifest object.
    let declared = detail
        .get("manifest")
        .and_then(|m| m.get("artifact_sha256"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    // The bundle rides OUTSIDE the manifest, as the server's top-level `artifact`.
    let artifact_b64 = detail
        .get("artifact")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());

    if !signed {
        // Unsigned item: never carry bytes — nothing attests the declared hash.
        return Ok(None);
    }
    let Some(declared) = declared else {
        // Signed manifest declaring no artifact hash: not a bundled-artifact item.
        return Ok(None);
    };
    // A declared hash means a bundle existed at signing time. Missing now = the
    // bytes were stripped after signing (tamper) -> hard reject.
    let Some(artifact_b64) = artifact_b64 else {
        bail!(
            "item `{id}` manifest declares artifact_sha256 but no artifact was served; \
             refusing install (bundle stripped after signing)"
        );
    };
    if artifact_b64.len() > MAX_ARTIFACT_B64_BYTES {
        bail!(
            "item `{id}` artifact exceeds the {MAX_ARTIFACT_B64_BYTES}-byte cap; refusing install"
        );
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(artifact_b64)
        .map_err(|e| anyhow::anyhow!("item `{id}` artifact is not valid base64: {e}"))?;
    let actual = compute_artifact_sha256(&bytes);
    if actual != declared.to_ascii_lowercase() {
        bail!(
            "item `{id}` artifact hash mismatch (signed manifest declares {declared}, \
             served artifact hashes to {actual}); refusing install (tampered bundle)"
        );
    }
    Ok(Some(artifact_b64.to_string()))
}

// ── integrations.sh source (Plugin kind) ────────────────────────────────────

/// Default integrations.sh catalog envelope. Prefer this over individual raw
/// source files because it is the normalized, multi-format catalog
/// (`mcp`/`api`/`graphql`/`cli`) and needs no credentials.
const INTEGRATIONS_SH_API_URL: &str = "https://integrations.sh/api.json";

/// Raw GitHub fallback for the OpenAPI subset only. This is intentionally not
/// the primary source: it is one upstream feed (`api-guru-openapi.json`), while
/// `/api.json` carries the full normalized integrations.sh registry.
const INTEGRATIONS_SH_RAW_OPENAPI_URL: &str = "https://raw.githubusercontent.com/UsefulSoftwareCo/integrationsdotsh/refs/heads/main/sources/api-guru-openapi.json";

const INTEGRATIONS_SH_API_ENV: &str = "RYU_INTEGRATIONS_SH_API_URL";
const INTEGRATIONS_SH_RAW_ENV: &str = "RYU_INTEGRATIONS_SH_RAW_OPENAPI_URL";
const INTEGRATIONS_SH_TTL_ENV: &str = "RYU_INTEGRATIONS_SH_CACHE_TTL_SECS";
const INTEGRATIONS_SH_DEFAULT_TTL_SECS: u64 = 24 * 60 * 60;

static INTEGRATIONS_SH_CACHE: OnceLock<tokio::sync::Mutex<Option<IntegrationsShCache>>> =
    OnceLock::new();

#[derive(Clone)]
struct IntegrationsShCache {
    fetched_at: std::time::Instant,
    records: Vec<IntegrationsShRecord>,
    source_url: String,
}

/// A normalized integrations.sh item. This is deliberately smaller than the raw
/// payload so the cache is cheap and stable across small upstream schema changes.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
struct IntegrationsShRecord {
    id: String,
    kind: String,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    domain: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    feeds: Vec<String>,
    #[serde(default)]
    popularity: Option<u64>,
    #[serde(default)]
    version: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct IntegrationsShApiEnvelope {
    #[serde(default)]
    data: Vec<IntegrationsShRecord>,
}

#[derive(Debug, serde::Deserialize)]
struct IntegrationsShRawOpenApiEnvelope {
    #[serde(default)]
    specs: Vec<IntegrationsShRawOpenApiSpec>,
}

#[derive(Debug, serde::Deserialize)]
struct IntegrationsShRawOpenApiSpec {
    provider: String,
    #[serde(default, rename = "versionKey")]
    version_key: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    link: Option<String>,
    #[serde(default, rename = "swaggerUrl")]
    swagger_url: Option<String>,
    #[serde(default, rename = "swaggerYamlUrl")]
    swagger_yaml_url: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    service: Option<String>,
    #[serde(default, rename = "providerName")]
    provider_name: Option<String>,
    #[serde(default)]
    raw: Value,
}

/// Built-in integrations.sh source for the Plugin/App catalog. It is descriptor
/// discovery, not a Ryu plugin runtime: records tell users which integration
/// surfaces exist and where to inspect them. Install returns a raw descriptor
/// handoff only.
#[derive(Clone)]
pub struct IntegrationsShSource {
    pub id: String,
    pub display_name: String,
    pub api_url: Option<String>,
    pub raw_openapi_url: Option<String>,
}

impl IntegrationsShSource {
    pub fn builtin() -> Self {
        Self {
            id: "integrations-sh".to_string(),
            display_name: "integrations.sh".to_string(),
            api_url: None,
            raw_openapi_url: None,
        }
    }

    fn resolve_api_url(&self) -> String {
        self.api_url
            .clone()
            .filter(|u| !u.trim().is_empty())
            .or_else(|| {
                std::env::var(INTEGRATIONS_SH_API_ENV)
                    .ok()
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty())
            })
            .unwrap_or_else(|| INTEGRATIONS_SH_API_URL.to_string())
    }

    fn resolve_raw_openapi_url(&self) -> String {
        self.raw_openapi_url
            .clone()
            .filter(|u| !u.trim().is_empty())
            .or_else(|| {
                std::env::var(INTEGRATIONS_SH_RAW_ENV)
                    .ok()
                    .map(|u| u.trim().to_string())
                    .filter(|u| !u.is_empty())
            })
            .unwrap_or_else(|| INTEGRATIONS_SH_RAW_OPENAPI_URL.to_string())
    }

    fn cache_ttl() -> std::time::Duration {
        let secs = std::env::var(INTEGRATIONS_SH_TTL_ENV)
            .ok()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(INTEGRATIONS_SH_DEFAULT_TTL_SECS);
        std::time::Duration::from_secs(secs)
    }

    async fn fetch_records(&self) -> Result<IntegrationsShCache> {
        let api_url = self.resolve_api_url();
        match crate::server::guarded_get_bytes(&api_url).await {
            Ok(bytes) => {
                let envelope: IntegrationsShApiEnvelope = serde_json::from_slice(&bytes)
                    .map_err(|e| anyhow::anyhow!("parsing integrations.sh API {api_url}: {e}"))?;
                return Ok(IntegrationsShCache {
                    fetched_at: std::time::Instant::now(),
                    records: envelope.data,
                    source_url: api_url,
                });
            }
            Err(api_err) => {
                tracing::warn!(
                    url = api_url,
                    "integrations.sh API fetch failed, trying raw OpenAPI fallback: {api_err}"
                );
            }
        }

        let raw_url = self.resolve_raw_openapi_url();
        let body = crate::server::guarded_get_bytes(&raw_url)
            .await
            .map_err(|e| anyhow::anyhow!("fetching integrations.sh raw fallback {raw_url}: {e}"))?;
        let envelope: IntegrationsShRawOpenApiEnvelope = serde_json::from_slice(&body)
            .map_err(|e| anyhow::anyhow!("parsing integrations.sh raw fallback {raw_url}: {e}"))?;
        Ok(IntegrationsShCache {
            fetched_at: std::time::Instant::now(),
            records: envelope.specs.iter().map(raw_openapi_to_record).collect(),
            source_url: raw_url,
        })
    }

    async fn records(&self) -> Result<IntegrationsShCache> {
        let lock = INTEGRATIONS_SH_CACHE.get_or_init(|| tokio::sync::Mutex::new(None));
        let mut guard = lock.lock().await;
        if let Some(cache) = guard.as_ref() {
            if cache.fetched_at.elapsed() < Self::cache_ttl() {
                return Ok(cache.clone());
            }
        }
        let cache = self.fetch_records().await?;
        *guard = Some(cache.clone());
        Ok(cache)
    }

    fn wrap_items(
        &self,
        records: Vec<Value>,
        source_url: &str,
        note: Option<&str>,
        next_cursor: Option<String>,
    ) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("items".to_string(), Value::Array(records));
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
}

impl CatalogSource for IntegrationsShSource {
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
        // Real offset-cursor pagination: the cursor carries the numeric offset
        // into the fully-filtered list, so the client can page past the first
        // `limit` records instead of dead-ending.
        let offset = q
            .cursor
            .as_deref()
            .and_then(|c| c.trim().parse::<usize>().ok())
            .unwrap_or(0);
        match self.records().await {
            Ok(cache) => {
                let needle = q.query.trim().to_ascii_lowercase();
                let kind_filter = q.extra_str("integration_kind").to_ascii_lowercase();
                let filtered: Vec<Value> = cache
                    .records
                    .iter()
                    .filter(|record| {
                        (kind_filter.is_empty() || record.kind.eq_ignore_ascii_case(&kind_filter))
                            && (needle.is_empty()
                                || record.id.to_ascii_lowercase().contains(&needle)
                                || record.name.to_ascii_lowercase().contains(&needle)
                                || record
                                    .domain
                                    .as_deref()
                                    .is_some_and(|d| d.to_ascii_lowercase().contains(&needle))
                                || record
                                    .description
                                    .as_deref()
                                    .is_some_and(|d| d.to_ascii_lowercase().contains(&needle))
                                || record
                                    .categories
                                    .iter()
                                    .any(|c| c.to_ascii_lowercase().contains(&needle)))
                    })
                    .map(integration_record_to_item)
                    .collect();
                let total = filtered.len();
                let next_cursor = (offset + limit < total).then(|| (offset + limit).to_string());
                let items: Vec<Value> = filtered.into_iter().skip(offset).take(limit).collect();
                Ok(self.wrap_items(items, &cache.source_url, None, next_cursor))
            }
            Err(e) => Ok(self.wrap_items(
                Vec::new(),
                &self.resolve_api_url(),
                Some(&e.to_string()),
                None,
            )),
        }
    }

    async fn detail(&self, _client: &reqwest::Client, id: &str) -> Result<Value> {
        let cache = self.records().await?;
        let record = cache
            .records
            .iter()
            .find(|record| record.id == id)
            .ok_or_else(|| anyhow::anyhow!("integration `{id}` not found in integrations.sh"))?;
        Ok(serde_json::json!({
            "id": record.id,
            "kind": record.kind,
            "name": record.name,
            "description": record.description,
            "url": record.url,
            "iconUrl": record.icon,
            "domain": record.domain,
            "categories": record.categories,
            "feeds": record.feeds,
            "popularity": record.popularity,
            "version": record.version,
            "source": self.display_name,
            "sourceUrl": cache.source_url,
            "descriptor": {
                "kind": "integration-descriptor",
                "integration_kind": record.kind,
                "url": record.url,
                "domain": record.domain,
            },
        }))
    }

    async fn install_descriptor(
        &self,
        _client: &reqwest::Client,
        id: &str,
    ) -> Result<InstallDescriptor> {
        let detail = self.detail(_client, id).await?;
        Ok(InstallDescriptor {
            kind: CatalogKind::Plugin,
            source_id: self.id.clone(),
            repo_id: id.to_string(),
            files: Vec::new(),
            raw: detail,
        })
    }
}

fn integration_record_to_item(record: &IntegrationsShRecord) -> Value {
    serde_json::json!({
        "id": record.id,
        "name": record.name,
        "description": record.description,
        "author": record.domain,
        "version": record.version.clone().unwrap_or_else(|| record.kind.to_uppercase()),
        "install_source": record.url,
        "installed": false,
        "icon_url": record.icon,
        "category": record.categories.first().cloned().unwrap_or_else(|| record.kind.clone()),
        "integration_kind": record.kind,
        "domain": record.domain,
        "url": record.url,
        "feeds": record.feeds,
        "popularity": record.popularity.unwrap_or(0),
        "rating_average": 0.0,
        "rating_count": 0,
    })
}

/// A brand-level integration entry, normalized from the integrations.sh directory
/// or a Composio toolkit, for the Integrations Store tab.
#[derive(Debug, Clone, serde::Serialize)]
pub struct IntegrationBrand {
    pub id: String, // normalized slug (lowercase, non-alnum stripped)
    pub name: String,
    pub description: Option<String>,
    pub logo: Option<String>,
    pub categories: Vec<String>,
    pub sources: Vec<String>, // ["directory"], ["composio"], ["treg"] and/or ["ryu"]
    pub feeds: Vec<String>,   // integration kinds available (mcp/api/graphql/cli)
    /// Every directory record folded into this brand, deduped by record id. The
    /// actionable form of `feeds`.
    pub connections: Vec<IntegrationConnection>,
    /// One unified preview list. Directory records remain in `connections` for
    /// compatibility, while every source also projects into this richer option
    /// shape for action routing and price display.
    pub options: Vec<IntegrationOption>,
    /// Native source ids used to lazily enrich a brand's preview. The normalized
    /// brand id is intentionally not used here: source slugs can contain
    /// punctuation that the cross-source brand slug removes.
    pub composio_slug: Option<String>,
    pub treg_slug: Option<String>,
    /// The platform slug in Ryu's own tool catalog (Treg parity B8).
    pub ryu_slug: Option<String>,
    /// The managed source Ryu suggests for this brand: the tool catalog that
    /// offers it eligibly (`treg`, billed at provider cost, or `ryu`), else
    /// `composio`; `None` when no managed source offers it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_source: Option<String>,
    /// The user's own choice for this brand (`treg` or `composio`), from the
    /// [`INTEGRATION_PROVIDER_PINS_PREF`] preference, when that source offers it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_source: Option<String>,
    pub domain: Option<String>,
    pub popularity: Option<u64>,
}

/// One concrete connection a brand offers, carried through the brand fold so the
/// Integrations tab can ACT on it (import an OpenAPI/GraphQL entry as tools, jump
/// to the MCP catalog, open setup docs). `feeds` alone is only a set of kind
/// tokens; without the record `id`/`url` every one of those actions is
/// unreachable, which is why the fold keeps the records rather than collapsing
/// them into chips.
#[derive(Debug, Clone, serde::Serialize)]
pub struct IntegrationConnection {
    /// The integrations.sh record id (`openapi/1password-com-events`, `mcp/notion`).
    pub id: String,
    /// The record's integration kind (`mcp` / `openapi` / `api` / `graphql` / `cli`).
    pub kind: String,
    pub name: String,
    /// The record's setup/docs/endpoint URL, when the directory carries one.
    pub url: Option<String>,
}

/// One provider option for a merged brand. An option is deliberately a
/// descriptor, not an execution credential: the preview can compare sources
/// without pretending that Ryu owns or can execute a user's provider account.
#[derive(Debug, Clone, serde::Serialize)]
pub struct IntegrationOption {
    pub id: String,
    pub source: String, // "directory", "composio", "treg" or "ryu"
    pub kind: String,   // source-native kind, e.g. "openapi" or "treg-endpoint"
    /// The action the preview can take without guessing from a provider name.
    /// `chat-setup` is the honest fallback for installs that need environment,
    /// credentials, or provider-specific judgment.
    pub action: String, // "connect", "mcp", "rest-import", "graphql-import", "chat-setup"
    /// Directory record id when this option came from integrations.sh.
    pub connection_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub url: Option<String>,
    pub provider: Option<String>,
    /// Provider-native capability used to compare like-for-like priced options.
    pub capability: Option<String>,
    pub comparison_key: Option<String>,
    pub price: Option<IntegrationPrice>,
    pub is_cheapest: bool,
    /// Treg can publish a platform-blocked endpoint. Preserve that signal so the
    /// UI does not present a catalog row as executable when it is not eligible.
    pub available: Option<bool>,
    pub availability_note: Option<String>,
    /// Which managed provider Ryu prefers for this brand, set only when a tool
    /// catalog (Treg's or Ryu's) and Composio both offer it: `primary` on the
    /// catalog options, `alternative` on Composio's. See
    /// [`rank_managed_providers`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_role: Option<String>,
}

fn integration_connection_action(kind: &str) -> &'static str {
    match kind.trim().to_ascii_lowercase().as_str() {
        "mcp" => "mcp",
        "api" | "openapi" | "rest" => "rest-import",
        "graphql" => "graphql-import",
        // CLI setup varies by machine, package manager, and credentials. It is
        // intentionally a chat handoff rather than a fake one-click install.
        _ => "chat-setup",
    }
}

fn integration_connection_option(
    connection: &IntegrationConnection,
    description: Option<String>,
) -> IntegrationOption {
    IntegrationOption {
        id: format!("directory:{}", connection.id),
        source: "directory".to_owned(),
        kind: connection.kind.clone(),
        action: integration_connection_action(&connection.kind).to_owned(),
        connection_id: Some(connection.id.clone()),
        name: connection.name.clone(),
        description,
        url: connection.url.clone(),
        provider: Some("integrations.sh".to_owned()),
        capability: None,
        comparison_key: None,
        price: None,
        is_cheapest: false,
        provider_role: None,
        available: Some(true),
        availability_note: None,
    }
}

/// Published provider pricing attached to an integration option. `usd` is the
/// only field used for cross-provider comparison; the native value/unit remain
/// available for a truthful display when a source has not published a USD
/// conversion.
#[derive(Debug, Clone, serde::Serialize)]
pub struct IntegrationPrice {
    pub usd: Option<f64>,
    pub currency: Option<String>,
    pub value: Option<f64>,
    pub per: Option<f64>,
    pub unit: Option<String>,
    pub confidence: Option<String>,
    /// What the figure covers (Ryu catalog rows): `one_call` (all-in),
    /// `base_call` (the per-call part; `metered_by` meters add to it) or
    /// `usage`. Absent means all-in.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub basis: Option<String>,
    /// Meters billed on top of a `base_call` figure, such as `results_over_10`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub metered_by: Vec<String>,
}

/// Mark the lowest published USD price within each provider-native capability
/// and billing unit. Unknown prices, blocked endpoints, and unlike units are
/// excluded; an option is only called cheapest when there are at least two
/// comparable eligible options. A base price with extra meters (`base_call`)
/// is compared only with base prices metered the same way, never with an
/// all-in price.
pub fn mark_cheapest_options(options: &mut [IntegrationOption]) {
    let mut groups: std::collections::HashMap<String, Vec<(usize, f64)>> =
        std::collections::HashMap::new();
    for (index, option) in options.iter_mut().enumerate() {
        option.is_cheapest = false;
        let Some(price) = option.price.as_ref() else {
            continue;
        };
        let Some(usd) = price.usd.filter(|value| value.is_finite() && *value >= 0.0) else {
            continue;
        };
        if option.available == Some(false) {
            continue;
        }
        let Some(comparison_key) = option.comparison_key.as_deref() else {
            continue;
        };
        let unit = price.unit.as_deref().unwrap_or("unit");
        let basis = price.basis.as_deref().unwrap_or("one_call");
        if basis == "usage" {
            continue;
        }
        let meters = price.metered_by.join(",");
        groups
            .entry(format!(
                "{comparison_key}\u{1f}{unit}\u{1f}{basis}\u{1f}{meters}"
            ))
            .or_default()
            .push((index, usd));
    }

    for entries in groups.into_values() {
        if entries.len() < 2 {
            continue;
        }
        let Some(minimum) = entries
            .iter()
            .map(|(_, price)| *price)
            .min_by(f64::total_cmp)
        else {
            continue;
        };
        for (index, price) in entries {
            if (price - minimum).abs() <= f64::EPSILON.max(minimum.abs() * 1e-9) {
                options[index].is_cheapest = true;
            }
        }
    }
}

/// Where a source sits in the managed-provider order: direct records
/// (integrations.sh, first-party adapters) first, then the tool catalogs (Treg,
/// billed at the provider's cost, and Ryu's own), then Composio as the fallback.
fn managed_provider_tier(source: &str) -> u8 {
    match source {
        "treg" | "ryu" => 1,
        "composio" => 2,
        _ => 0,
    }
}

/// Preference key holding the user's per-brand managed-source choice, a JSON
/// object of brand id to `"treg"` or `"composio"`. Written through the generic
/// preferences API; read by the Integrations Store and the Treg agent tools.
pub const INTEGRATION_PROVIDER_PINS_PREF: &str = "integrations-provider-pins";

/// The values a brand can be pinned to.
pub const PINNABLE_SOURCES: [&str; 2] = ["treg", "composio"];

/// Parse [`INTEGRATION_PROVIDER_PINS_PREF`]. Unknown values and malformed JSON
/// are dropped, never an error: a bad pin falls back to the suggestion.
pub fn parse_provider_pins(raw: Option<&str>) -> std::collections::HashMap<String, String> {
    let Some(serde_json::Value::Object(map)) =
        raw.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
    else {
        return std::collections::HashMap::new();
    };
    map.into_iter()
        .filter_map(|(brand, value)| {
            let source = value.as_str()?.trim().to_ascii_lowercase();
            PINNABLE_SOURCES
                .contains(&source.as_str())
                .then_some((brand, source))
        })
        .collect()
}

/// Order a brand's options and sources (direct records first, then the
/// managed sources), suggest a managed source, honor the user's pin, and when a
/// tool catalog and Composio both offer the brand, mark the chosen source's
/// eligible options `primary` and the other's `alternative`.
///
/// The suggestion is the tool catalog when it offers the brand eligibly (Treg
/// is billed at the provider's cost), else Composio. A pin (`treg` or
/// `composio`) wins when that source offers the brand. Composio's options are
/// never dropped: an app Treg lacks (Gmail) or only offers on the user's own
/// account (Slack) keeps Composio as its suggestion.
pub fn rank_managed_providers(brand: &mut IntegrationBrand, pin: Option<&str>) {
    let catalog_source = brand
        .options
        .iter()
        .find(|option| {
            managed_provider_tier(&option.source) == 1 && option.available != Some(false)
        })
        .map(|option| option.source.clone());
    let has_composio = brand
        .options
        .iter()
        .any(|option| managed_provider_tier(&option.source) == 2);
    brand.suggested_source = catalog_source
        .clone()
        .or_else(|| has_composio.then(|| "composio".to_owned()));
    brand.preferred_source = match pin {
        Some("treg") if catalog_source.is_some() => Some("treg".to_owned()),
        Some("composio") if has_composio => Some("composio".to_owned()),
        _ => None,
    };
    let chosen_tier = match brand
        .preferred_source
        .as_deref()
        .or(brand.suggested_source.as_deref())
    {
        Some("composio") => 2,
        _ => 1,
    };
    // Direct records first, then the chosen managed tier, then the other.
    let rank = |source: &str| match managed_provider_tier(source) {
        0 => 0,
        tier if tier == chosen_tier => 1,
        _ => 2,
    };
    brand.options.sort_by_key(|option| rank(&option.source));
    brand.sources.sort_by_key(|source| rank(source));
    let both = catalog_source.is_some() && has_composio;
    for option in &mut brand.options {
        let tier = managed_provider_tier(&option.source);
        option.provider_role = match tier {
            _ if !both || tier == 0 => None,
            tier if tier == chosen_tier && option.available != Some(false) => {
                Some("primary".to_owned())
            }
            tier if tier != chosen_tier => Some("alternative".to_owned()),
            _ => None,
        };
    }
}

/// Normalize a display name / id into a stable brand slug for dedup+matching.
pub fn integration_brand_slug(raw: &str) -> String {
    raw.chars()
        .filter(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Full integrations.sh directory as brand entries (cache-backed, dedup by slug,
/// merging feeds/categories across records that share a brand). Returns empty on
/// fetch error rather than failing the whole endpoint.
pub async fn integrations_sh_brands() -> Vec<IntegrationBrand> {
    let source = IntegrationsShSource::builtin();
    let cache = match source.records().await {
        Ok(cache) => cache,
        Err(_) => return Vec::new(),
    };
    // Fold duplicates by slug, preserving first-seen order.
    let mut order: Vec<String> = Vec::new();
    let mut by_slug: std::collections::HashMap<String, IntegrationBrand> =
        std::collections::HashMap::new();
    for record in &cache.records {
        let slug = integration_brand_slug(&record.name);
        if slug.is_empty() {
            continue;
        }
        // Feeds are the integration kinds available: the record's own kind plus
        // any extra feed tags it carries.
        let mut feeds: Vec<String> = Vec::new();
        feeds.push(record.kind.clone());
        feeds.extend(record.feeds.iter().cloned());
        let connection = IntegrationConnection {
            id: record.id.clone(),
            kind: record.kind.clone(),
            name: record.name.clone(),
            url: record.url.clone(),
        };
        let option = integration_connection_option(&connection, record.description.clone());
        match by_slug.get_mut(&slug) {
            Some(brand) => {
                for cat in &record.categories {
                    if !brand.categories.contains(cat) {
                        brand.categories.push(cat.clone());
                    }
                }
                for feed in feeds {
                    if !brand.feeds.contains(&feed) {
                        brand.feeds.push(feed);
                    }
                }
                if !brand.connections.iter().any(|c| c.id == connection.id) {
                    brand.connections.push(connection);
                }
                if !brand
                    .options
                    .iter()
                    .any(|candidate| candidate.id == option.id)
                {
                    brand.options.push(option);
                }
                if brand.description.is_none() {
                    brand.description = record.description.clone();
                }
                if brand.logo.is_none() {
                    brand.logo = record.icon.clone();
                }
                if brand.domain.is_none() {
                    brand.domain = record.domain.clone();
                }
                brand.popularity = brand.popularity.max(record.popularity);
            }
            None => {
                order.push(slug.clone());
                by_slug.insert(
                    slug.clone(),
                    IntegrationBrand {
                        id: slug,
                        name: record.name.clone(),
                        description: record.description.clone(),
                        logo: record.icon.clone(),
                        categories: record.categories.clone(),
                        sources: vec!["directory".into()],
                        feeds,
                        connections: vec![connection],
                        options: vec![option],
                        composio_slug: None,
                        treg_slug: None,
                        ryu_slug: None,
                        suggested_source: None,
                        preferred_source: None,
                        domain: record.domain.clone(),
                        popularity: record.popularity,
                    },
                );
            }
        }
    }
    order
        .into_iter()
        .filter_map(|slug| by_slug.remove(&slug))
        .collect()
}

fn raw_openapi_to_record(spec: &IntegrationsShRawOpenApiSpec) -> IntegrationsShRecord {
    let version = spec.version_key.clone();
    let provider = spec
        .provider_name
        .clone()
        .unwrap_or_else(|| spec.provider.clone());
    let title = spec
        .title
        .clone()
        .unwrap_or_else(|| provider.replace([':', '.'], " "));
    let url = spec
        .link
        .clone()
        .or_else(|| spec.swagger_url.clone())
        .or_else(|| spec.swagger_yaml_url.clone());
    let logo = spec
        .raw
        .get("info")
        .and_then(|info| info.get("x-logo"))
        .and_then(|logo| logo.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string);
    IntegrationsShRecord {
        id: format!("api/{}", spec.provider),
        kind: "api".to_string(),
        name: title,
        description: spec.description.clone(),
        url,
        icon: logo,
        domain: Some(provider),
        categories: spec.categories.clone(),
        feeds: vec!["api-guru-openapi".to_string()],
        popularity: None,
        version: version.or_else(|| spec.service.clone()),
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
    IntegrationsSh(IntegrationsShSource),
    /// GitHub-topic discovery (`ryu-app` / `ryu-plugin`) — unreviewed,
    /// descriptor-only community listings. See `github_topic.rs`.
    GithubTopic(GithubTopicSource),
    OkfBundle(OkfBundleSource),
    /// The non-skills.sh Skill registries (GitHub taps, `/.well-known/skills`,
    /// browse.sh, ClawHub, LobeHub). See `skill_registries`.
    GithubTap(GithubTapSource),
    WellKnown(WellKnownSource),
    BrowseSh(BrowseShSource),
    ClawHub(ClawHubSource),
    LobeHub(LobeHubSource),
    /// A user-added agent registry speaking the marketplace catalog shape.
    /// See `agent_registry`.
    AgentRegistry(AgentRegistrySource),
    Stub(StubSource),
}

impl Source {
    pub(crate) fn is_canonical_marketplace(&self) -> bool {
        matches!(self, Source::RyuMarketplace(source) if source.resolve_base().trim_end_matches('/') == RYU_MARKETPLACE_DEFAULT_BASE)
    }
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
            Source::IntegrationsSh(s) => s.id(),
            Source::GithubTopic(s) => s.id(),
            Source::OkfBundle(s) => s.id(),
            Source::GithubTap(s) => s.id(),
            Source::WellKnown(s) => s.id(),
            Source::BrowseSh(s) => s.id(),
            Source::ClawHub(s) => s.id(),
            Source::LobeHub(s) => s.id(),
            Source::AgentRegistry(s) => s.id(),
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
            Source::IntegrationsSh(s) => s.display_name(),
            Source::GithubTopic(s) => s.display_name(),
            Source::OkfBundle(s) => s.display_name(),
            Source::GithubTap(s) => s.display_name(),
            Source::WellKnown(s) => s.display_name(),
            Source::BrowseSh(s) => s.display_name(),
            Source::ClawHub(s) => s.display_name(),
            Source::LobeHub(s) => s.display_name(),
            Source::AgentRegistry(s) => s.display_name(),
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
            Source::IntegrationsSh(s) => s.kind(),
            Source::GithubTopic(s) => s.kind(),
            Source::OkfBundle(s) => s.kind(),
            Source::GithubTap(s) => s.kind(),
            Source::WellKnown(s) => s.kind(),
            Source::BrowseSh(s) => s.kind(),
            Source::ClawHub(s) => s.kind(),
            Source::LobeHub(s) => s.kind(),
            Source::AgentRegistry(s) => s.kind(),
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
            // integrations.sh uses its public API by default, with optional env
            // overrides. Builtin listing keeps the base implicit.
            Source::IntegrationsSh(s) => s.api_url.as_deref(),
            // GitHub-topic discovery surfaces its (optional) API base override.
            Source::GithubTopic(s) => s.api_base.as_deref(),
            // A knowledge bundle surfaces its OKF source URL (git/local).
            Source::OkfBundle(s) => Some(&s.source_url),
            // A tap surfaces its repo and a well-known source its site, so the
            // picker can show where a source points. browse.sh / ClawHub /
            // LobeHub are host-fixed, so like skills.sh they surface nothing.
            Source::WellKnown(s) => Some(&s.base_url),
            Source::AgentRegistry(s) => Some(&s.base_url),
            Source::Smithery(_)
            | Source::SkillsSh(_)
            | Source::GithubTap(_)
            | Source::BrowseSh(_)
            | Source::ClawHub(_)
            | Source::LobeHub(_)
            | Source::Stub(_) => None,
        }
    }

    /// Optional private-marketplace [`SourceAuth`] (Phase 5c). Only a git
    /// [`MarketplaceSource`] can carry auth today; every other variant is `None`.
    /// Used by the registry to persist the auth template and to surface a
    /// redacted `hasAuth` flag — the token itself is never exposed here.
    pub fn auth(&self) -> Option<&SourceAuth> {
        match self {
            Source::Marketplace(s) => s.auth.as_ref(),
            _ => None,
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
            Source::IntegrationsSh(s) => s.search(client, q).await,
            Source::GithubTopic(s) => s.search(client, q).await,
            Source::OkfBundle(s) => s.search(client, q).await,
            Source::GithubTap(s) => s.search(client, q).await,
            Source::WellKnown(s) => s.search(client, q).await,
            Source::BrowseSh(s) => s.search(client, q).await,
            Source::ClawHub(s) => s.search(client, q).await,
            Source::LobeHub(s) => s.search(client, q).await,
            Source::AgentRegistry(s) => s.search(client, q).await,
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
            Source::IntegrationsSh(s) => s.detail(client, id).await,
            Source::GithubTopic(s) => s.detail(client, id).await,
            Source::OkfBundle(s) => s.detail(client, id).await,
            Source::GithubTap(s) => s.detail(client, id).await,
            Source::WellKnown(s) => s.detail(client, id).await,
            Source::BrowseSh(s) => s.detail(client, id).await,
            Source::ClawHub(s) => s.detail(client, id).await,
            Source::LobeHub(s) => s.detail(client, id).await,
            Source::AgentRegistry(s) => s.detail(client, id).await,
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
            Source::IntegrationsSh(s) => s.install_descriptor(client, id).await,
            Source::GithubTopic(s) => s.install_descriptor(client, id).await,
            Source::OkfBundle(s) => s.install_descriptor(client, id).await,
            Source::GithubTap(s) => s.install_descriptor(client, id).await,
            Source::WellKnown(s) => s.install_descriptor(client, id).await,
            Source::BrowseSh(s) => s.install_descriptor(client, id).await,
            Source::ClawHub(s) => s.install_descriptor(client, id).await,
            Source::LobeHub(s) => s.install_descriptor(client, id).await,
            Source::AgentRegistry(s) => s.install_descriptor(client, id).await,
            Source::Stub(s) => s.install_descriptor(client, id).await,
        }
    }

    /// [`Self::install_descriptor`] restricted to ONE release channel.
    ///
    /// `None` (or `stable`) is the ordinary install and every source serves it.
    /// A named prerelease channel is served ONLY by a source that actually
    /// publishes trains — today the Ryu Marketplace, whose control plane keys a
    /// listing by `(kind, id, channel)`. Any other source ERRORS rather than
    /// falling through to its channel-blind descriptor, because that fallthrough
    /// is precisely the silent cross-channel downgrade the whole resolution rule
    /// exists to prevent: a user who asked for `beta` would be handed stable and
    /// told it succeeded.
    pub async fn install_descriptor_at(
        &self,
        client: &reqwest::Client,
        id: &str,
        channel: Option<&str>,
    ) -> Result<InstallDescriptor> {
        let wanted = channel
            .map(str::trim)
            .filter(|c| !c.is_empty() && !c.eq_ignore_ascii_case(crate::update::STABLE_CHANNEL));
        let Some(wanted) = wanted else {
            return self.install_descriptor(client, id).await;
        };
        match self {
            Source::RyuMarketplace(s) => {
                s.install_descriptor_on_channel(client, id, Some(wanted))
                    .await
            }
            other => bail!(
                "source `{}` does not publish release channels, so `{id}` has no `{wanted}` build to install",
                other.id()
            ),
        }
    }

    /// Resolve one exact historical version. Only the trusted Ryu Marketplace
    /// source owns this selector; every other source refuses instead of
    /// interpreting the version as a generic URL or silently serving current.
    pub async fn install_descriptor_at_version(
        &self,
        client: &reqwest::Client,
        id: &str,
        version: &str,
    ) -> Result<InstallDescriptor> {
        match self {
            Source::RyuMarketplace(source) => {
                source
                    .install_descriptor_on_version(client, id, version)
                    .await
            }
            other => bail!(
                "source `{}` does not publish exact historical versions for `{id}`",
                other.id()
            ),
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
                Ok(Some(crate::mcp_catalog::verify_and_plan(server).await?))
            }
            // Ryu Marketplace spans 4 kinds: only an Mcp-kind source resolves an
            // MCP plan. A model/skill/plugin marketplace source returns None so
            // the route never installs it down the MCP path (the crux guard).
            Source::RyuMarketplace(s) if s.kind == CatalogKind::Mcp => {
                let detail = s.fetch_detail_on_channel(_client, id, None, true).await?;
                require_install_entitlement(id, &detail)?;
                // Verify-on-install (#468) on the MCP path too (it bypasses
                // install_descriptor), so a tampered MCP manifest is rejected.
                s.verify_manifest_signature(_client, id, &detail).await?;
                let server = s.detail_to_mcp_server(id, &detail)?;
                Ok(Some(crate::mcp_catalog::verify_and_plan(&server).await?))
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
        let result: Result<Option<crate::skills_catalog::InstallResult>> = match self {
            Source::SkillsSh(_) => Ok(Some(
                crate::skills_catalog::install_skill(client, id).await?,
            )),
            // Each registry knows how to turn one of its own ids into an install:
            // a tap hands a repo subdir to the from-source fetcher, the other
            // three write the SKILL.md they serve. See `skill_registries`.
            Source::GithubTap(s) => Ok(Some(s.install(client, id).await?)),
            Source::WellKnown(s) => Ok(Some(s.install(client, id).await?)),
            Source::BrowseSh(s) => Ok(Some(s.install(client, id).await?)),
            Source::ClawHub(s) => Ok(Some(s.install(client, id).await?)),
            Source::LobeHub(s) => Ok(Some(s.install(client, id).await?)),
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
                // ARTIFACT CARRIAGE: a `ryu_bundle` skill's `install_descriptor`
                // carries the integrity-verified bundle bytes (base64 `.tar.gz`)
                // instead of a public
                // source. Install from those bytes — never a public git repo.
                if let Some(b64) = descriptor
                    .raw
                    .get("artifact_bundle_b64")
                    .and_then(|v| v.as_str())
                {
                    use base64::Engine as _;
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(b64)
                        .map_err(|e| {
                            anyhow::anyhow!(
                                "marketplace skill `{id}` bundle is not valid base64: {e}"
                            )
                        })?;
                    Ok(Some(
                        crate::skills_catalog::from_source::install_from_tarball_bytes(&bytes)?,
                    ))
                } else {
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
            }
            _ => Ok(None),
        };
        let result = result?;
        if let Some(installed) = &result {
            if let Some(public_id) = self.public_skill_listing_id(id).await {
                crate::skills_catalog::public_stats::record_public_install(&public_id, installed);
            }
        }
        Ok(result)
    }

    /// Anonymous public metadata at canonical catalog endpoints is the witness.
    /// Custom source overrides and authenticated/private handoffs never attest it.
    async fn public_skill_listing_id(&self, id: &str) -> Option<String> {
        let public = match self {
            Source::SkillsSh(_) => crate::skills_catalog::uses_public_catalog(),
            Source::BrowseSh(source) => {
                source.api_base().trim_end_matches('/') == "https://browse.sh"
                    && anonymous_public_document(&format!(
                        "https://browse.sh/api/skills/{}",
                        urlencode_path(id)
                    ))
                    .await
                    .is_some_and(|value| {
                        value.get("skillMd").and_then(Value::as_str).is_some()
                            || value.get("skillMdUrl").and_then(Value::as_str).is_some()
                    })
            }
            Source::ClawHub(source) => {
                source.api_base().trim_end_matches('/') == "https://clawhub.ai"
                    && anonymous_public_document(&format!(
                        "https://clawhub.ai/api/v1/skills/{}",
                        urlencode_component(&crate::skills_catalog::slug_of(id))
                    ))
                    .await
                    .is_some_and(|value| {
                        value
                            .get("skill")
                            .and_then(|skill| skill.get("slug"))
                            .and_then(Value::as_str)
                            == Some(crate::skills_catalog::slug_of(id).as_str())
                    })
            }
            Source::LobeHub(source) => {
                source.api_base().trim_end_matches('/') == "https://chat-agents.lobehub.com"
                    && anonymous_public_document(&format!(
                        "https://chat-agents.lobehub.com/{}.json",
                        urlencode_component(&crate::skills_catalog::slug_of(id))
                    ))
                    .await
                    .is_some_and(|value| {
                        value
                            .get("config")
                            .and_then(|config| config.get("systemRole"))
                            .and_then(Value::as_str)
                            .is_some()
                    })
            }
            Source::GithubTap(source)
                if source.api_base().trim_end_matches('/') == super::GITHUB_API_BASE =>
            {
                if id.rsplit_once('/').map(|(repo, _)| repo) != Some(source.repo.as_str()) {
                    return None;
                }
                let value = anonymous_public_document(&format!(
                    "{}/repos/{}",
                    super::GITHUB_API_BASE,
                    source.repo
                ))
                .await?;
                value.get("private").and_then(Value::as_bool) == Some(false)
                    && value.get("full_name").and_then(Value::as_str) == Some(source.repo.as_str())
            }
            Source::RyuMarketplace(source)
                if source.kind == CatalogKind::Skill
                    && source.resolve_base().trim_end_matches('/')
                        == RYU_MARKETPLACE_DEFAULT_BASE =>
            {
                let url = format!(
                    "{}/api/marketplace/catalog/detail?kind=skill&id={}&view=presentation",
                    RYU_MARKETPLACE_DEFAULT_BASE,
                    urlencode_path(id)
                );
                let value = anonymous_public_document(&url).await?;
                value.get("id").and_then(Value::as_str) == Some(id)
                    && value.get("kind").and_then(Value::as_str) == Some("skill")
            }
            _ => false,
        };
        public.then(|| id.to_owned())
    }
}

pub(crate) async fn public_marketplace_listing(kind: &str, id: &str) -> bool {
    if ryu_marketplace_base().trim_end_matches('/') != RYU_MARKETPLACE_DEFAULT_BASE {
        return false;
    }
    let url = format!(
        "{}/api/marketplace/catalog/detail?kind={}&id={}&view=presentation",
        RYU_MARKETPLACE_DEFAULT_BASE,
        urlencode_component(kind),
        urlencode_path(id)
    );
    anonymous_public_document(&url).await.is_some_and(|value| {
        value.get("id").and_then(Value::as_str) == Some(id)
            && value.get("kind").and_then(Value::as_str) == Some(kind)
    })
}

pub(crate) async fn public_marketplace_catalog(kind: &str) -> Vec<String> {
    if ryu_marketplace_base().trim_end_matches('/') != RYU_MARKETPLACE_DEFAULT_BASE {
        return Vec::new();
    }
    let url = format!(
        "{}/api/marketplace/catalog?kind={}&limit=256",
        RYU_MARKETPLACE_DEFAULT_BASE,
        urlencode_component(kind)
    );
    let Some(value) = anonymous_public_document(&url).await else {
        return Vec::new();
    };
    value
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("kind").and_then(Value::as_str) == Some(kind))
                .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

async fn anonymous_public_document(url: &str) -> Option<Value> {
    // A fresh client has no buyer/GitHub token or install-session header. Redirects
    // are refused so public attestation cannot leave the canonical authority.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .ok()?;
    let response = client
        .get(url)
        .header("User-Agent", crate::skills_catalog::USER_AGENT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = read_bounded_reqwest_body(response, 256 * 1024, "public skill listing metadata")
        .await
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

#[cfg(test)]
mod public_skill_attestation_tests {
    use super::*;

    #[tokio::test]
    async fn custom_and_private_origins_cannot_attest_a_public_listing() {
        for base in [
            "http://127.0.0.1:3000",
            "https://browse.sh@private.example",
            "https://private.example",
            "https://browse.sh/private",
        ] {
            let source = Source::BrowseSh(super::super::skill_registries::BrowseShSource {
                id: "browse-sh".into(),
                display_name: "browse.sh".into(),
                api_base: Some(base.into()),
            });
            assert!(source
                .public_skill_listing_id("private-merger-review")
                .await
                .is_none());
        }
        let source = Source::RyuMarketplace(RyuMarketplaceSource {
            id: "ryu-marketplace".into(),
            display_name: "Ryu".into(),
            kind: CatalogKind::Skill,
            base_url: Some("http://127.0.0.1:3000".into()),
        });
        assert!(source
            .public_skill_listing_id("public-looking-id")
            .await
            .is_none());
    }
}

/// The search-envelope key the matching desktop tab expects for a given kind:
/// model `{ models }`, skill `{ skills }`, mcp `{ servers }`, plugin `{ items }`,
/// knowledge `{ concepts }`, agent `{ agents }`. Single source of truth, shared by
/// every source that wraps per-kind cards (`MarketplaceSource` and
/// `RyuMarketplaceSource`).
pub(super) fn envelope_key(kind: CatalogKind) -> &'static str {
    match kind {
        CatalogKind::Model => "models",
        CatalogKind::Skill => "skills",
        CatalogKind::Mcp => "servers",
        CatalogKind::Plugin => "items",
        CatalogKind::Knowledge => "concepts",
        CatalogKind::Agent => "agents",
    }
}

#[cfg(test)]
#[path = "sources_tests.rs"]
mod tests;
