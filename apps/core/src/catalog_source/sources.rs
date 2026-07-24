//! Concrete [`CatalogSource`] implementations and their enum-dispatch wrapper.
//!
//! Dispatch design: the project has no `async-trait` dep, so a trait with
//! native `async fn` methods is *not* object-safe (`Box<dyn CatalogSource>`
//! won't compile). Instead we store sources heterogeneously in a small closed
//! [`Source`] enum and match-dispatch each call. Custom model sources collapse
//! into `Hf` with a `base_url` override — no new variant needed.

use anyhow::{bail, Result};
use serde_json::Value;
use std::sync::OnceLock;

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
    fn resolve_headers(&self) -> Result<Vec<(String, String)>> {
        let mut out = Vec::new();
        if let Some(bearer) = &self.bearer {
            let token = interpolate_env(bearer)?;
            let token = token.trim();
            if token.is_empty() {
                bail!("custom marketplace bearer token resolved to empty; refusing to fetch (fail-closed)");
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
    // ── Rich metadata (Phase 1.5) ─────────────────────────────────────────────
    /// Pretty display name (Claude/Codex `displayName`). `name` stays the
    /// kebab-case identity; this is what the card/detail renders when present.
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
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
    // ── Dependency + surface contract ─────────────────────────────────────────
    /// The plugins this entry depends on (`{ apps: [{ id, min_version }] }`) and
    /// the host surfaces it targets — mirrored from the plugin's manifest by the
    /// marketplace author, so a card can disclose the install closure up front.
    ///
    /// Both are carried as RAW JSON / plain strings rather than the typed
    /// `Requires` / `Surface`: a git marketplace is untrusted third-party data, and
    /// one entry with a typo'd surface token must not fail the parse of the WHOLE
    /// marketplace. The typed contract is enforced where it is load-bearing — on
    /// the real `plugin.json` at install time, by the manifest loader and the
    /// install-closure resolver.
    #[serde(default)]
    requires: Option<serde_json::Value>,
    #[serde(default)]
    targets: Vec<String>,
}

/// The rich detail metadata carried from a [`MarketplacePlugin`] onto each
/// resolved [`MarketplaceItem`], so [`MarketplaceSource::detail`] can surface it
/// under the marketplace **detail** contract keys. All optional/additive.
#[derive(Debug, Clone, Default)]
struct MarketplaceItemMeta {
    display_name: Option<String>,
    homepage: Option<String>,
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
    requires: Option<serde_json::Value>,
    targets: Vec<String>,
}

impl MarketplacePlugin {
    /// Snapshot this plugin's rich metadata for carriage onto its items.
    fn meta(&self) -> MarketplaceItemMeta {
        MarketplaceItemMeta {
            display_name: self.display_name.clone(),
            homepage: self.homepage.clone(),
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
            accent_color: self.accent_color.clone(),
            banner: self.banner.clone(),
            developer: self.developer.clone(),
            screenshots: self.screenshots.clone(),
            tagline: self.tagline.clone(),
            example_prompts: self.example_prompts.clone(),
            capabilities: self.capabilities.clone(),
            privacy_policy_url: self.privacy_policy_url.clone(),
            terms_of_service_url: self.terms_of_service_url.clone(),
            setup: self.setup.clone(),
            requires: self.requires.clone(),
            targets: self.targets.clone(),
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
        // The repo reference is user-supplied (custom source / startup load), so
        // SSRF-guard EVERY candidate fetch: resolve + screen IPs, pin the client,
        // disable redirects. (The passed `client` is unused; the guard builds its
        // own pinned client.) A fetch or parse failure falls through to the next
        // candidate path; only when all candidates fail do we surface the error.
        let urls = marketplace_manifest_urls(&self.repo_url);
        // Resolve private-marketplace auth headers ONCE, before any fetch. A
        // referenced-but-unset `${ENV}` fails closed here (no candidate is
        // fetched) rather than sending an unresolved/empty credential.
        let headers = match &self.auth {
            Some(auth) => Some(auth.resolve_headers()?),
            None => None,
        };
        let mut last_err: Option<anyhow::Error> = None;
        for url in &urls {
            let fetched = match &headers {
                Some(h) => crate::server::guarded_get_bytes_with_headers(url, h).await,
                None => crate::server::guarded_get_bytes(url).await,
            };
            match fetched {
                Ok(body) => match parse_marketplace(&body) {
                    Ok(manifest) => {
                        // Pass the marketplace repo as item-resolution context so a
                        // Cursor repo-local `source` (a bare subfolder) resolves as a
                        // git-subdir of THIS repo (Phase 5d), not a standalone repo.
                        return Ok(match self.kind {
                            CatalogKind::Skill => flatten_plugins(&manifest, &self.repo_url),
                            _ => plugins_as_items(&manifest, &self.repo_url),
                        });
                    }
                    Err(e) => {
                        last_err = Some(anyhow::anyhow!("parsing marketplace manifest {url}: {e}"));
                    }
                },
                Err(e) => {
                    last_err = Some(anyhow::anyhow!("fetching marketplace manifest {url}: {e}"));
                }
            }
        }
        Err(last_err.unwrap_or_else(|| {
            anyhow::anyhow!("no marketplace manifest found for {}", self.repo_url)
        }))
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
                    if let Some(tagline) = &item.meta.tagline {
                        obj.insert("tagline".to_owned(), serde_json::json!(tagline));
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
        if let Some(version) = &meta.version {
            detail.insert("version".to_owned(), serde_json::json!(version));
        }
        // URL fields from a git marketplace are untrusted publisher input rendered
        // as <a href> in the desktop dialog, so allowlist http(s) before emitting —
        // blocks a `javascript:`/`data:` homepage/policy URL becoming stored XSS.
        if let Some(site) = meta.homepage.as_deref().and_then(http_url) {
            detail.insert("website".to_owned(), serde_json::json!(site));
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
        if !meta.example_prompts.is_empty() {
            detail.insert(
                "examplePrompts".to_owned(),
                serde_json::json!(meta.example_prompts),
            );
        }
        if let Some(setup) = &meta.setup {
            detail.insert("setup".to_owned(), setup.clone());
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
/// A Cursor repo-local subfolder ([`is_local_subdir_source`]) resolves to a
/// github `tree/HEAD/<subfolder>` URL of the marketplace repo; if the marketplace
/// repo isn't a github repo (e.g. a direct `.json` URL host) it degrades to the
/// bare source string (current behaviour). An `owner/repo`, a URL, or `"builtin"`
/// is returned unchanged.
fn resolve_marketplace_source(source: &str, repo_context: &str) -> String {
    if is_local_subdir_source(source) {
        if let Some((owner, name)) = github_owner_repo(repo_context) {
            return format!(
                "https://github.com/{owner}/{name}/tree/HEAD/{}",
                source.trim()
            );
        }
        // Repo context is not a github repo → degrade to the bare source string.
        return source.trim().to_string();
    }
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
/// Degrades gracefully: an unreachable server makes `search` return an empty,
/// labelled per-kind envelope (with a `note`); `detail` / `install_descriptor`
/// return a clear error. Never panics.
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
    /// The plugin's declared dependency closure + host surfaces, when the
    /// marketplace server exposes them on the card. Raw JSON, and `Option` so an
    /// older server that omits the columns still parses (the fields survive inside
    /// the signed manifest regardless — the card copy is a browse-time convenience,
    /// and the install path reads the manifest, never this).
    #[serde(default)]
    requires: Option<Value>,
    #[serde(default)]
    targets: Option<Value>,
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

    /// Resolve the API base URL: an explicit `base_url`, else the env override
    /// (`RYU_MARKETPLACE_API_URL`), else the hosted-marketplace default. Trailing
    /// slash trimmed.
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
    ///
    /// Returns `Ok(true)` when a signature was present AND verified valid, and
    /// `Ok(false)` when the item is unsigned (allowed as a benign summary). The
    /// caller uses this boolean to drive the fail-closed ui_code carriage ladder
    /// (`gate_plugin_ui_code`): runnable code is carried ONLY off a valid
    /// signature, never off an unattested self-declared hash.
    async fn verify_manifest_signature(
        &self,
        client: &reqwest::Client,
        id: &str,
        detail: &Value,
    ) -> Result<bool> {
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
            return Ok(false);
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
            Ok(true)
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
        let key = envelope_key(self.kind);
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
                    // Icon glyph + dither background + app-ness — see `MarketplaceCard`.
                    if let Some(icon) = &card.icon {
                        obj.insert("icon".to_owned(), serde_json::json!(icon));
                    }
                    if let Some(dither) = card.icon_dither.clone().filter(|v| !v.is_null()) {
                        obj.insert("icon_dither".to_owned(), dither);
                    }
                    if card.has_companion {
                        obj.insert("has_companion".to_owned(), serde_json::json!(true));
                    }
                }
                value
            }
            CatalogKind::Knowledge => serde_json::json!({
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
        // onto an install descriptor. `signed` is true only when a signature was
        // present AND verified valid.
        let signed = self.verify_manifest_signature(client, id, &detail).await?;

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
            });
            return Ok(descriptor);
        }

        // PAID-ARTIFACT CARRIAGE (Phase 4A): the generalized sibling of the plugin
        // path for a PAID `ryu_bundle` NON-plugin item (today: a skill). Its
        // artifact is served — ONLY past the control-plane's 402 entitlement gate —
        // as a base64 bundle whose integrity anchor is the signed
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

/// Maximum size of a plugin's bundled sandboxed-UI code, enforced fail-closed at
/// the integrity gate (mirrors the Core install cap so a pathological bundle is
/// refused before it is ever stored). 4 MiB.
const MAX_UI_CODE_BYTES: usize = 4 * 1024 * 1024;

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
fn gate_plugin_backend_code(id: &str, manifest: &mut Value, signed: bool) {
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

/// Largest base64 `artifact` string carried on a paid-bundle install. The blob is
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

/// The fail-closed carriage ladder for a PAID `ryu_bundle` NON-plugin artifact
/// (Phase 4A) — the generalized sibling of [`gate_plugin_ui_code`]. The artifact
/// rides OUTSIDE the signed manifest (the server's top-level base64 `artifact`
/// blob, served ONLY past the 402 entitlement gate); its integrity anchor is the
/// SIGNED `manifest.artifact_sha256`. The trust ladder is identical to the plugin
/// path (carry code ONLY off a valid signature attesting the hash):
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
        // Signed manifest declaring no artifact hash: not a paid-bundle item.
        return Ok(None);
    };
    // A declared hash means a bundle existed at signing time. Missing now = the
    // bytes were stripped after signing (tamper) -> hard reject.
    let Some(artifact_b64) = artifact_b64 else {
        bail!(
            "item `{id}` manifest declares artifact_sha256 but no artifact was served; \
             refusing install (paid bundle stripped after signing)"
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
const INTEGRATIONS_SH_RAW_OPENAPI_URL: &str =
    "https://raw.githubusercontent.com/UsefulSoftwareCo/integrationsdotsh/refs/heads/main/sources/api-guru-openapi.json";

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
    pub sources: Vec<String>, // ["directory"] and/or ["composio"]
    pub feeds: Vec<String>,   // integration kinds available (mcp/api/graphql/cli)
    pub domain: Option<String>,
    pub popularity: Option<u64>,
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
            Source::IntegrationsSh(s) => s.id(),
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
            Source::IntegrationsSh(s) => s.display_name(),
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
            Source::IntegrationsSh(s) => s.kind(),
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
            // integrations.sh uses its public API by default, with optional env
            // overrides. Builtin listing keeps the base implicit.
            Source::IntegrationsSh(s) => s.api_url.as_deref(),
            // A knowledge bundle surfaces its OKF source URL (git/local).
            Source::OkfBundle(s) => Some(&s.source_url),
            Source::Smithery(_) | Source::SkillsSh(_) | Source::Stub(_) => None,
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
            Source::IntegrationsSh(s) => s.detail(client, id).await,
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
            Source::IntegrationsSh(s) => s.install_descriptor(client, id).await,
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
                // PAID-ARTIFACT CARRIAGE (Phase 4A): a paid `ryu_bundle` skill's
                // `install_descriptor` carries the entitlement-gated, integrity-
                // verified bundle bytes (base64 `.tar.gz`) instead of a public
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
                    return Ok(Some(
                        crate::skills_catalog::from_source::install_from_tarball_bytes(&bytes)?,
                    ));
                }
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

/// The search-envelope key the matching desktop tab expects for a given kind:
/// model `{ models }`, skill `{ skills }`, mcp `{ servers }`, plugin `{ items }`,
/// knowledge `{ concepts }`. Single source of truth, shared by every source that
/// wraps per-kind cards (`MarketplaceSource` and `RyuMarketplaceSource`).
fn envelope_key(kind: CatalogKind) -> &'static str {
    match kind {
        CatalogKind::Model => "models",
        CatalogKind::Skill => "skills",
        CatalogKind::Mcp => "servers",
        CatalogKind::Plugin => "items",
        CatalogKind::Knowledge => "concepts",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plugin marketplace whose plugin declares skill paths must resolve to ONE
    /// plugin item at the repo root (Plugin kind), not per-skill leaves — while the
    /// Skill kind still flattens into per-skill items. Locks the kind-aware
    /// `fetch_items` split so a plugin is never advertised as a skill subdir.
    #[test]
    fn plugin_kind_yields_one_item_per_plugin_skill_kind_flattens() {
        let manifest_json = br#"{
            "plugins": [
                {
                    "name": "foo",
                    "description": "a bundle",
                    "source": "acme/plugins",
                    "skills": ["./skills/bar", "./skills/baz"]
                }
            ]
        }"#;
        let manifest = parse_marketplace(manifest_json).expect("parse manifest");

        // Plugin kind: one item at the repo root, carrying the plugin name + repo.
        let plugin_items = plugins_as_items(&manifest, "acme/marketplace");
        assert_eq!(plugin_items.len(), 1);
        assert_eq!(plugin_items[0].id, "foo");
        assert_eq!(plugin_items[0].plugin, "foo");
        assert_eq!(plugin_items[0].install_source, "acme/plugins");

        // Skill kind: one item per declared skill, scoped to its subdir.
        let skill_items = flatten_plugins(&manifest, "acme/marketplace");
        assert_eq!(skill_items.len(), 2);
        assert_eq!(skill_items[0].id, "foo/bar");
        assert!(skill_items[0]
            .install_source
            .ends_with("/tree/HEAD/skills/bar"));
        assert_eq!(skill_items[1].id, "foo/baz");
    }

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
        // owner/repo and github URLs expand to one candidate per MANIFEST_PATHS,
        // Ryu-native path first, Claude/Codex-legacy last (ecosystem compat).
        let owner = marketplace_manifest_urls("owner/repo");
        assert_eq!(
            owner,
            vec![
                "https://raw.githubusercontent.com/owner/repo/HEAD/.ryu-plugin/marketplace.json",
                "https://raw.githubusercontent.com/owner/repo/HEAD/.agents/plugins/marketplace.json",
                "https://raw.githubusercontent.com/owner/repo/HEAD/.claude-plugin/marketplace.json",
                "https://raw.githubusercontent.com/owner/repo/HEAD/.cursor-plugin/marketplace.json",
            ]
        );
        assert_eq!(
            marketplace_manifest_urls("https://github.com/owner/repo")[0],
            "https://raw.githubusercontent.com/owner/repo/HEAD/.ryu-plugin/marketplace.json"
        );
        assert_eq!(
            marketplace_manifest_urls("https://github.com/owner/repo.git")[2],
            "https://raw.githubusercontent.com/owner/repo/HEAD/.claude-plugin/marketplace.json"
        );
        // A direct .json URL is used verbatim as the sole candidate.
        assert_eq!(
            marketplace_manifest_urls("https://example.com/custom/marketplace.json"),
            vec!["https://example.com/custom/marketplace.json"]
        );
    }

    #[test]
    fn http_url_allowlists_scheme() {
        assert_eq!(http_url("https://ok.example"), Some("https://ok.example"));
        assert_eq!(http_url("  http://ok.example  "), Some("http://ok.example"));
        assert_eq!(http_url("javascript:alert(1)"), None);
        assert_eq!(http_url("data:text/html,x"), None);
        assert_eq!(http_url("ftp://x"), None);
    }

    #[test]
    fn flattens_plugins_into_skill_items() {
        let manifest = parse_marketplace(SAMPLE_MARKETPLACE.as_bytes()).expect("parse");
        let items = flatten_plugins(&manifest, "acme/marketplace");
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
        assert!(flatten_plugins(&empty, "acme/marketplace").is_empty());
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

        // With no explicit base and no env override, the hosted-marketplace default.
        if std::env::var(RYU_MARKETPLACE_API_ENV).is_err() {
            let default_src = RyuMarketplaceSource::builtin(CatalogKind::Plugin);
            assert_eq!(default_src.resolve_base(), RYU_MARKETPLACE_DEFAULT_BASE);
        }
    }

    #[test]
    fn integrations_sh_item_maps_to_plugin_catalog_card() {
        let record = IntegrationsShRecord {
            id: "mcp/figma".to_string(),
            kind: "mcp".to_string(),
            name: "Figma".to_string(),
            description: Some("Design context for agents".to_string()),
            url: Some("https://help.figma.com/mcp".to_string()),
            icon: Some("https://integrations.sh/logo/figma.com".to_string()),
            domain: Some("figma.com".to_string()),
            categories: vec!["design".to_string()],
            feeds: vec!["claude".to_string(), "openai".to_string()],
            popularity: Some(21_667),
            version: None,
        };

        let item = integration_record_to_item(&record);
        assert_eq!(item["id"], "mcp/figma");
        assert_eq!(item["name"], "Figma");
        assert_eq!(item["author"], "figma.com");
        assert_eq!(item["version"], "MCP");
        assert_eq!(item["install_source"], "https://help.figma.com/mcp");
        assert_eq!(item["category"], "design");
        assert_eq!(item["integration_kind"], "mcp");
    }

    #[test]
    fn integrations_sh_raw_openapi_fallback_maps_specs() {
        let spec: IntegrationsShRawOpenApiSpec = serde_json::from_str(
            r#"{
                "provider": "stripe.com",
                "versionKey": "2024-01-01",
                "title": "Stripe API",
                "description": "Payments API",
                "link": "https://api.apis.guru/v2/specs/stripe.com/2024-01-01.json",
                "categories": ["payments"],
                "providerName": "stripe.com",
                "raw": {
                    "info": {
                        "x-logo": { "url": "https://logo.example/stripe.svg" }
                    }
                }
            }"#,
        )
        .expect("parse raw spec");

        let record = raw_openapi_to_record(&spec);
        assert_eq!(record.id, "api/stripe.com");
        assert_eq!(record.kind, "api");
        assert_eq!(record.name, "Stripe API");
        assert_eq!(record.domain.as_deref(), Some("stripe.com"));
        assert_eq!(record.categories, vec!["payments"]);
        assert_eq!(
            record.url.as_deref(),
            Some("https://api.apis.guru/v2/specs/stripe.com/2024-01-01.json")
        );
        assert_eq!(
            record.icon.as_deref(),
            Some("https://logo.example/stripe.svg")
        );
        assert_eq!(record.feeds, vec!["api-guru-openapi"]);
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
        assert_eq!(
            r.ok(),
            Some(false),
            "unsigned item should install unverified (signed=false)"
        );
    }

    // ── Plugin CODE CARRIAGE: ed25519-signed code-integrity gate ──────────────
    //
    // These prove the whole point of the carriage: a registry-tamper / MITM that
    // swaps `ui_code` AFTER the manifest was signed is REJECTED fail-closed on
    // install, because the hash of the swapped code no longer matches the
    // signed-manifest's `ui_code_sha256`. `compute_ui_code_sha256` mirrors the
    // SDK's `sha256(utf8(ui_code))` lower-case-hex exactly, so JS-signed hashes
    // verify byte-for-byte here.

    /// Build a server-shaped `catalog/detail` document (the EXACT keys the control
    /// plane serves): the declared hash inside the signed `manifest`, the code as
    /// the unsigned top-level `uiCode`.
    fn plugin_detail(ui_code_sha256: Option<&str>, ui_code: Option<&str>) -> serde_json::Value {
        let mut manifest = serde_json::Map::new();
        manifest.insert("id".into(), serde_json::json!("com.acme.plugin"));
        manifest.insert("name".into(), serde_json::json!("Acme"));
        manifest.insert("version".into(), serde_json::json!("1.0.0"));
        if let Some(h) = ui_code_sha256 {
            manifest.insert("ui_code_sha256".into(), serde_json::json!(h));
        }
        let mut detail = serde_json::Map::new();
        detail.insert("manifest".into(), serde_json::Value::Object(manifest));
        if let Some(c) = ui_code {
            detail.insert("uiCode".into(), serde_json::json!(c));
        }
        serde_json::Value::Object(detail)
    }

    #[test]
    fn ui_code_sha256_matches_known_vector() {
        // Cross-language golden: `sha256("abc")` lower-case hex. The SDK computes
        // the SAME value via `createHash("sha256").update(code,"utf8").digest("hex")`,
        // so a hash written into a JS-signed manifest verifies here byte-for-byte.
        assert_eq!(
            compute_ui_code_sha256("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn gate_carries_code_when_signed_and_hash_matches() {
        let code = "export function activate(ctx){ return ctx; }";
        let hash = compute_ui_code_sha256(code);
        let detail = plugin_detail(Some(&hash), Some(code));
        let carried = gate_plugin_ui_code("com.acme.plugin", &detail, true)
            .expect("signed + matching hash must carry the code");
        assert_eq!(
            carried.as_deref(),
            Some(code),
            "the exact signed code must be carried"
        );
    }

    #[test]
    fn gate_rejects_tampered_code_fail_closed() {
        // The load-bearing security assertion: the manifest was signed over the
        // hash of the ORIGINAL code, but the served code was swapped (MITM /
        // registry tamper). Install MUST hard-fail — not silently drop the code.
        let original = "export function activate(ctx){ return ctx; }";
        let hash = compute_ui_code_sha256(original);
        let tampered = "export function activate(ctx){ steal(ctx); }";
        let detail = plugin_detail(Some(&hash), Some(tampered));
        let err = gate_plugin_ui_code("com.acme.plugin", &detail, true)
            .expect_err("signed manifest + swapped code must be rejected fail-closed");
        assert!(
            err.to_string().contains("hash mismatch"),
            "reject reason must name the hash mismatch, got: {err}"
        );
    }

    #[test]
    fn gate_rejects_stripped_code_fail_closed() {
        // A signed manifest declares a code hash but the code blob was removed
        // after signing — also active tampering, also a hard reject.
        let hash = compute_ui_code_sha256("some code");
        let detail = plugin_detail(Some(&hash), None);
        let err = gate_plugin_ui_code("com.acme.plugin", &detail, true)
            .expect_err("declared hash with no served code must be rejected");
        assert!(
            err.to_string().contains("no ui_code was served"),
            "got: {err}"
        );
    }

    #[test]
    fn gate_never_carries_code_for_unsigned_item() {
        // The bypass guard: an UNSIGNED item that self-declares a matching hash
        // must NOT run its code — nothing attests the hash. Benign summary only.
        let code = "export function activate(){}";
        let hash = compute_ui_code_sha256(code);
        let detail = plugin_detail(Some(&hash), Some(code));
        let carried = gate_plugin_ui_code("com.acme.plugin", &detail, false)
            .expect("unsigned item installs as a summary (no error)");
        assert_eq!(
            carried, None,
            "unsigned self-declared hash must never carry code"
        );
    }

    #[test]
    fn gate_signed_manifest_only_plugin_carries_nothing() {
        // A signed plugin with no bundled UI (no ui_code_sha256) is fine and
        // simply carries no code.
        let detail = plugin_detail(None, None);
        let carried = gate_plugin_ui_code("com.acme.plugin", &detail, true)
            .expect("signed manifest-only plugin is valid");
        assert_eq!(carried, None);
    }

    #[test]
    fn backend_gate_strips_unsigned_inline_backend_code() {
        // HIGH-2: an UNSIGNED plugin's inline node backend is attested by nothing,
        // so both the code and its self-referential hash are removed before the
        // manifest is carried into the install descriptor.
        let mut manifest = serde_json::json!({
            "id": "com.acme.plugin",
            "version": "1.0.0",
            "backend_code": "export function activate(){ steal(); }",
            "backend_sha256": "deadbeef",
        });
        gate_plugin_backend_code("com.acme.plugin", &mut manifest, false);
        let obj = manifest.as_object().unwrap();
        assert!(
            !obj.contains_key("backend_code"),
            "unsigned backend_code must be stripped"
        );
        assert!(
            !obj.contains_key("backend_sha256"),
            "dangling backend_sha256 must be stripped too (else the install-door \
             hash check trips)"
        );
    }

    #[test]
    fn backend_gate_keeps_signed_inline_backend_code() {
        // A signed manifest's backend is INSIDE the verified surface — untouched.
        let code = "export function activate(){}";
        let mut manifest = serde_json::json!({
            "id": "com.acme.plugin",
            "version": "1.0.0",
            "backend_code": code,
            "backend_sha256": "abc123",
        });
        gate_plugin_backend_code("com.acme.plugin", &mut manifest, true);
        let obj = manifest.as_object().unwrap();
        assert_eq!(
            obj.get("backend_code").and_then(|v| v.as_str()),
            Some(code),
            "signed backend_code must be preserved"
        );
        assert!(obj.contains_key("backend_sha256"));
    }

    // ── PAID-ARTIFACT CARRIAGE (Phase 4A): entitlement-gated bundle integrity ──
    //
    // The generalized sibling of the plugin gate for a paid `ryu_bundle` skill.
    // The hash contract IS the interop spec (there is no separate publisher tool
    // in this phase): `manifest.artifact_sha256` is the lower-case hex sha256 over
    // the DECODED `.tar.gz` bytes, and the served `artifact` is those bytes
    // base64-encoded. These tests lock that contract and the fail-closed ladder.

    /// Build a server-shaped `catalog/detail` for a paid bundle: the declared hash
    /// inside the signed `manifest`, the bundle as the unsigned top-level base64
    /// `artifact`.
    fn artifact_detail(
        artifact_sha256: Option<&str>,
        artifact_b64: Option<&str>,
    ) -> serde_json::Value {
        let mut manifest = serde_json::Map::new();
        manifest.insert("id".into(), serde_json::json!("owner/paid-skill"));
        manifest.insert("version".into(), serde_json::json!("1.0.0"));
        if let Some(h) = artifact_sha256 {
            manifest.insert("artifact_sha256".into(), serde_json::json!(h));
        }
        let mut detail = serde_json::Map::new();
        detail.insert("manifest".into(), serde_json::Value::Object(manifest));
        if let Some(a) = artifact_b64 {
            detail.insert("artifact".into(), serde_json::json!(a));
        }
        serde_json::Value::Object(detail)
    }

    /// Base64-encode raw bytes the way the control plane stores the artifact blob.
    fn b64(bytes: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    #[test]
    fn artifact_sha256_hashes_decoded_bytes_not_base64() {
        // Lock the interop contract: the digest is over the DECODED bytes. Golden
        // vector: sha256("abc") lower-case hex — identical to the plugin path's, so
        // a publisher hashing the raw archive bytes verifies here byte-for-byte.
        assert_eq!(
            compute_artifact_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn artifact_gate_carries_bundle_when_signed_and_hash_matches() {
        let bundle = b"fake .tar.gz skill bundle bytes";
        let hash = compute_artifact_sha256(bundle);
        let encoded = b64(bundle);
        let detail = artifact_detail(Some(&hash), Some(&encoded));
        let carried = gate_artifact("owner/paid-skill", &detail, true)
            .expect("signed + matching hash must carry the bundle");
        assert_eq!(
            carried.as_deref(),
            Some(encoded.as_str()),
            "the exact base64 bundle must be carried for the install path to decode"
        );
    }

    #[test]
    fn artifact_gate_rejects_tampered_bundle_fail_closed() {
        // The load-bearing security assertion: the manifest was signed over the
        // ORIGINAL bundle's hash, but the served bundle was swapped after signing.
        // Install MUST hard-fail, not silently drop the bytes.
        let original = b"original skill bundle";
        let hash = compute_artifact_sha256(original);
        let tampered = b64(b"malicious swapped bundle");
        let detail = artifact_detail(Some(&hash), Some(&tampered));
        let err = gate_artifact("owner/paid-skill", &detail, true)
            .expect_err("signed manifest + swapped bundle must be rejected fail-closed");
        assert!(
            err.to_string().contains("hash mismatch"),
            "reject reason must name the hash mismatch, got: {err}"
        );
    }

    #[test]
    fn artifact_gate_rejects_stripped_bundle_fail_closed() {
        // A signed manifest declares an artifact hash but the bundle was removed
        // after signing — active tampering, a hard reject.
        let hash = compute_artifact_sha256(b"some bundle");
        let detail = artifact_detail(Some(&hash), None);
        let err = gate_artifact("owner/paid-skill", &detail, true)
            .expect_err("declared hash with no served artifact must be rejected");
        assert!(
            err.to_string().contains("no artifact was served"),
            "got: {err}"
        );
    }

    #[test]
    fn artifact_gate_never_carries_bundle_for_unsigned_item() {
        // The bypass guard: an UNSIGNED item that self-declares a matching hash
        // must NOT carry its bundle — nothing attests the hash.
        let bundle = b"bundle";
        let hash = compute_artifact_sha256(bundle);
        let detail = artifact_detail(Some(&hash), Some(&b64(bundle)));
        let carried = gate_artifact("owner/paid-skill", &detail, false)
            .expect("unsigned item is a benign no-carry (no error)");
        assert_eq!(
            carried, None,
            "unsigned self-declared hash must never carry the bundle"
        );
    }

    #[test]
    fn artifact_gate_no_bundle_for_free_or_public_item() {
        // A signed item that declares no artifact hash (a free / public-source /
        // `private_repo` item) carries nothing — the existing install path is left
        // untouched. This is the branch that keeps free items back-compat.
        let detail = artifact_detail(None, None);
        let carried = gate_artifact("owner/free-skill", &detail, true)
            .expect("signed item with no artifact hash is valid");
        assert_eq!(carried, None);
    }

    #[test]
    fn artifact_gate_rejects_invalid_base64_fail_closed() {
        // A declared hash with a non-base64 artifact blob is a corrupt/hostile
        // payload — refuse before any decode/install rather than panic.
        let detail = artifact_detail(Some("deadbeef"), Some("not valid base64 @@@@"));
        let err = gate_artifact("owner/paid-skill", &detail, true)
            .expect_err("non-base64 artifact must be rejected");
        assert!(err.to_string().contains("not valid base64"), "got: {err}");
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

    // ── pure helper coverage ─────────────────────────────────────────────────

    #[test]
    fn interpolate_env_substitutes_and_fails_closed() {
        // Uniquely-named vars avoid colliding with any other test in the binary.
        let key = format!("RYU_TEST_INTERP_{}", std::process::id());
        std::env::set_var(&key, "s3cr3t");
        let out = interpolate_env(&format!("Bearer ${{{key}}}")).unwrap();
        assert_eq!(out, "Bearer s3cr3t");
        std::env::remove_var(&key);

        // Fail-closed on a referenced-but-unset variable.
        assert!(interpolate_env(&format!("${{{key}}}")).is_err());
        // Fail-closed on an unterminated placeholder and an empty placeholder.
        assert!(interpolate_env("prefix ${OOPS").is_err());
        assert!(interpolate_env("${ }").is_err());
        // A template with no placeholders is passed through verbatim.
        assert_eq!(interpolate_env("plain value").unwrap(), "plain value");
    }

    #[test]
    fn author_developer_string_handles_string_object_and_junk() {
        assert_eq!(
            author_developer_string(&serde_json::json!("  Ada  ")),
            Some("Ada".to_string())
        );
        assert_eq!(
            author_developer_string(&serde_json::json!({"name": " Grace "})),
            Some("Grace".to_string())
        );
        // Empty string / whitespace object name / non-string-object → None.
        assert_eq!(author_developer_string(&serde_json::json!("   ")), None);
        assert_eq!(author_developer_string(&serde_json::json!({"name": ""})), None);
        assert_eq!(author_developer_string(&serde_json::json!(42)), None);
        assert_eq!(author_developer_string(&serde_json::json!(null)), None);
    }

    #[test]
    fn http_url_allowlists_http_and_https_only() {
        assert_eq!(http_url("  https://x.io/a  "), Some("https://x.io/a"));
        assert_eq!(http_url("HTTP://x.io"), Some("HTTP://x.io"));
        assert_eq!(http_url("ftp://x.io"), None);
        assert_eq!(http_url("javascript:alert(1)"), None);
        assert_eq!(http_url("owner/repo"), None);
    }

    #[test]
    fn github_raw_head_base_from_shorthand_and_url() {
        assert_eq!(
            github_raw_head_base("owner/repo").as_deref(),
            Some("https://raw.githubusercontent.com/owner/repo/HEAD/")
        );
        assert_eq!(
            github_raw_head_base("https://github.com/owner/repo.git").as_deref(),
            Some("https://raw.githubusercontent.com/owner/repo/HEAD/")
        );
        // A single bare segment has no repo name → None.
        assert_eq!(github_raw_head_base("owner"), None);
    }

    #[test]
    fn marketplace_manifest_urls_direct_json_vs_expanded_paths() {
        // A direct .json URL is the sole candidate.
        let direct = marketplace_manifest_urls("https://host/x/marketplace.JSON");
        assert_eq!(direct, vec!["https://host/x/marketplace.JSON".to_string()]);

        // A shorthand expands to one candidate per manifest path, Ryu-native first.
        let expanded = marketplace_manifest_urls("owner/repo");
        assert_eq!(expanded.len(), MANIFEST_PATHS.len());
        assert!(expanded[0].ends_with(".ryu-plugin/marketplace.json"));
        assert!(expanded
            .iter()
            .all(|u| u.starts_with("https://raw.githubusercontent.com/owner/repo/HEAD/")));
    }

    #[test]
    fn github_owner_repo_extracts_or_rejects() {
        assert_eq!(
            github_owner_repo("owner/repo"),
            Some(("owner".into(), "repo".into()))
        );
        assert_eq!(
            github_owner_repo("https://github.com/owner/repo/tree/HEAD/x"),
            Some(("owner".into(), "repo".into()))
        );
        // Trailing .git stripped.
        assert_eq!(
            github_owner_repo("owner/repo.git"),
            Some(("owner".into(), "repo".into()))
        );
        // A dotted first segment is a bare host, not owner/repo.
        assert_eq!(github_owner_repo("example.com/x"), None);
        // A non-github URL scheme is rejected.
        assert_eq!(github_owner_repo("https://gitlab.com/o/r"), None);
        // A single segment can't be split.
        assert_eq!(github_owner_repo("solo"), None);
    }

    #[test]
    fn is_local_subdir_source_discriminates() {
        assert!(is_local_subdir_source("teaching"));
        // owner/repo, URLs, dotted hosts, builtin, spaces, empty → not local.
        assert!(!is_local_subdir_source("owner/repo"));
        assert!(!is_local_subdir_source("https://x.io/y"));
        assert!(!is_local_subdir_source("example.com"));
        assert!(!is_local_subdir_source("builtin"));
        assert!(!is_local_subdir_source("BUILTIN"));
        assert!(!is_local_subdir_source("has space"));
        assert!(!is_local_subdir_source("   "));
    }

    #[test]
    fn resolve_marketplace_source_maps_local_subdir_against_repo() {
        // A local subfolder resolves to a github tree URL of the marketplace repo.
        assert_eq!(
            resolve_marketplace_source("teaching", "owner/repo"),
            "https://github.com/owner/repo/tree/HEAD/teaching"
        );
        // When the repo context is not a github repo, degrade to the bare source.
        assert_eq!(
            resolve_marketplace_source("teaching", "https://host/x/marketplace.json"),
            "teaching"
        );
        // An owner/repo or URL source is returned unchanged.
        assert_eq!(
            resolve_marketplace_source("acme/tool", "owner/repo"),
            "acme/tool"
        );
    }

    #[test]
    fn scoped_and_subdir_source_build_tree_urls() {
        assert_eq!(
            scoped_source("owner/repo", "skills/a"),
            "https://github.com/owner/repo/tree/HEAD/skills/a"
        );
        assert_eq!(
            scoped_source("https://github.com/owner/repo.git", "s"),
            "https://github.com/owner/repo/tree/HEAD/s"
        );
        // A non-repo string is returned unchanged by scoped_source.
        assert_eq!(scoped_source("not a repo here", "s"), "not a repo here");

        // subdir_source nests under an already-resolved tree URL...
        assert_eq!(
            subdir_source("https://github.com/o/r/tree/HEAD/plugin", "leaf"),
            "https://github.com/o/r/tree/HEAD/plugin/leaf"
        );
        // ...otherwise it delegates to scoped_source.
        assert_eq!(
            subdir_source("owner/repo", "leaf"),
            "https://github.com/owner/repo/tree/HEAD/leaf"
        );
    }

    #[test]
    fn urlencode_component_and_path_escape_correctly() {
        // Component encoding escapes slashes and spaces.
        assert_eq!(urlencode_component("a b/c@d"), "a%20b%2Fc%40d");
        // Unreserved chars pass through untouched.
        assert_eq!(urlencode_component("A-z0.9_~"), "A-z0.9_~");
        // Path encoding PRESERVES `/` and `@` (qualified names), escapes the space.
        assert_eq!(urlencode_path("@scope/name x"), "@scope/name%20x");
    }
}
