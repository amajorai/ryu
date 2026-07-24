//! The [`CatalogSourceRegistry`]: built-in sources (registered in code) plus
//! user-added custom sources persisted to a JSON file. Active selection per
//! kind lives in the [`PreferencesStore`] (it is "what the user picked").
//!
//! Two persistence locations, kept deliberately separate:
//! - **Custom source definitions** → JSON file (`~/.ryu/catalog-sources.json`,
//!   override `RYU_CATALOG_SOURCES_FILE`). The path is resolved **once at
//!   construction** and stored on the registry, so tests inject a temp path
//!   without touching process env (no cross-test races).
//! - **Active selection** → `PreferencesStore` key `catalog.active_source.{kind}`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::RwLock;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::sources::{
    HfSource, IntegrationsShSource, MarketplaceSource, ModelIndexSource, OfficialMcpSource,
    OkfBundleSource, RyuHostedMcpSource, RyuMarketplaceSource, SkillsShSource, SmitherySource,
    Source, SourceAuth, StubSource,
};
use super::CatalogKind;
use crate::server::preferences::PreferencesStore;

/// The persisted shape of one user-added custom source.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomSourceSpec {
    pub kind: CatalogKind,
    pub id: String,
    pub display_name: String,
    /// HF-compatible API base for custom model sources. Optional for other
    /// kinds; full custom fetch for non-model kinds lands in later units.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Optional auth for a PRIVATE git/HTTP marketplace (Phase 5c, Skill/Plugin
    /// kinds). Values may be `${ENV_VAR}` templates resolved at fetch time; the
    /// `SourceAuth` `Debug` redacts every value so a literal token never leaks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<SourceAuth>,
}

/// The flat listing metadata returned by the `GET` route per source.
#[derive(Debug, Clone, Serialize)]
pub struct SourceMeta {
    pub id: String,
    pub display_name: String,
    pub builtin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Redacted flag: true when this source carries private-marketplace auth
    /// (Phase 5c). The token/header VALUE is never exposed — only this boolean, so
    /// the UI can show a lock without leaking the secret.
    #[serde(default)]
    pub has_auth: bool,
}

/// Env override for the custom-sources file path ("nothing hardcoded").
const SOURCES_FILE_ENV: &str = "RYU_CATALOG_SOURCES_FILE";

fn preference_key(kind: CatalogKind) -> String {
    format!("catalog.active_source.{kind}")
}

/// Build the concrete [`Source`] for a persisted/added [`CustomSourceSpec`].
///
/// Discrimination for the Model kind (#461): a `base_url` that ends in `.json`
/// (ignoring a trailing `/` and any `?query`/`#fragment`) is a Ryu
/// **model-index** document and is wired as a [`ModelIndexSource`]. Any other
/// `base_url` is treated as an HF-Hub-compatible API base and reuses
/// [`HfSource`]. A Model source with no `base_url` falls back to the HF default
/// host.
///
/// For the Skill kind (#463): a custom Skill source with a `base_url` is a Claude
/// plugin marketplace ([`MarketplaceSource`]) and the `base_url` is the repo/URL
/// hosting `.claude-plugin/marketplace.json`; with no `base_url` it degrades to a
/// labelled stub. The built-in primary Skill source (skills.sh) is registered in
/// [`builtin_sources`], not here. Other kinds get a labelled stub carrier until
/// their per-kind fetch lands in a later unit. This is the single place the
/// discrimination lives, so `add_custom` and `load_custom` stay in sync.
fn source_from_spec(spec: CustomSourceSpec) -> Source {
    match spec.kind {
        CatalogKind::Model => {
            if spec.base_url.as_deref().is_some_and(is_model_index_url) {
                Source::ModelIndex(ModelIndexSource {
                    id: spec.id,
                    display_name: spec.display_name,
                    // Safe: the branch only runs when base_url is Some.
                    index_url: spec.base_url.unwrap_or_default(),
                })
            } else {
                Source::Hf(HfSource {
                    id: spec.id,
                    display_name: spec.display_name,
                    base_url: spec.base_url,
                })
            }
        }
        CatalogKind::Skill => {
            // A custom Skill source with a base_url is a Claude plugin marketplace
            // (#463): the base_url is the repo/URL hosting `.claude-plugin/
            // marketplace.json`. With no base_url there is nothing to point at, so
            // it degrades to a labelled stub.
            match spec.base_url.filter(|u| !u.trim().is_empty()) {
                Some(repo_url) => Source::Marketplace(
                    MarketplaceSource::new(
                        spec.id,
                        spec.display_name,
                        repo_url,
                        CatalogKind::Skill,
                    )
                    .with_auth(spec.auth),
                ),
                None => Source::Stub(StubSource {
                    id: spec.id,
                    display_name: spec.display_name,
                    kind: CatalogKind::Skill,
                }),
            }
        }
        CatalogKind::Plugin => {
            // A custom Plugin source with a base_url is a git plugin marketplace
            // (the same `.claude-plugin/marketplace.json` standard as the Skill
            // arm), surfaced through the existing plugin browse route: each
            // manifest plugin becomes one installable item. With no base_url there
            // is nothing to point at, so it degrades to a labelled stub. The
            // built-in primary (`RyuMarketplaceSource`) is registered in
            // [`builtin_sources`], not here.
            match spec.base_url.filter(|u| !u.trim().is_empty()) {
                Some(repo_url) => Source::Marketplace(
                    MarketplaceSource::new(
                        spec.id,
                        spec.display_name,
                        repo_url,
                        CatalogKind::Plugin,
                    )
                    .with_auth(spec.auth),
                ),
                None => Source::Stub(StubSource {
                    id: spec.id,
                    display_name: spec.display_name,
                    kind: CatalogKind::Plugin,
                }),
            }
        }
        CatalogKind::Mcp => {
            // A custom Mcp source's base_url is an alternate MCP registry mirror
            // (an `OfficialMcpSource` with that base). With no base_url it degrades
            // to a labelled stub. The built-in primary (the official registry) is
            // registered in [`builtin_sources`], not here.
            match spec.base_url.filter(|u| !u.trim().is_empty()) {
                Some(base_url) => Source::OfficialMcp(OfficialMcpSource {
                    id: spec.id,
                    display_name: spec.display_name,
                    base_url: Some(base_url),
                }),
                None => Source::Stub(StubSource {
                    id: spec.id,
                    display_name: spec.display_name,
                    kind: CatalogKind::Mcp,
                }),
            }
        }
        CatalogKind::Knowledge => {
            // A custom Knowledge source's base_url is the OKF bundle location: a
            // git URL (`https://…`) the install path clones, or (in tests) a local
            // directory. With no base_url there is nothing to point at, so it
            // degrades to a labelled stub. The optional git `ref` is not carried in
            // the persisted spec (it has no `base_url`-sibling field), so a custom
            // source tracks the default branch; pin a ref by encoding it into a
            // dedicated source later if needed.
            match spec.base_url.filter(|u| !u.trim().is_empty()) {
                Some(source_url) => Source::OkfBundle(OkfBundleSource {
                    id: spec.id,
                    display_name: spec.display_name,
                    source_url,
                    git_ref: None,
                }),
                None => Source::Stub(StubSource {
                    id: spec.id,
                    display_name: spec.display_name,
                    kind: CatalogKind::Knowledge,
                }),
            }
        }
        other => Source::Stub(StubSource {
            id: spec.id,
            display_name: spec.display_name,
            kind: other,
        }),
    }
}

/// True when a custom model source URL points at a JSON model-index document
/// rather than an HF-compatible API base — the path component ends in `.json`.
fn is_model_index_url(base_url: &str) -> bool {
    let path = base_url
        .split(['?', '#'])
        .next()
        .unwrap_or(base_url)
        .trim_end_matches('/');
    path.to_ascii_lowercase().ends_with(".json")
}

fn default_sources_file() -> PathBuf {
    crate::paths::ryu_dir().join("catalog-sources.json")
}

/// Holds built-in sources keyed by kind plus user-added custom ones. The
/// active selection per kind is read from / written to a [`PreferencesStore`]
/// passed in by the caller, so this registry stays free of global state.
pub struct CatalogSourceRegistry {
    /// Built-in sources, by kind (registered in code; the seam's defaults).
    builtin: HashMap<CatalogKind, Vec<Source>>,
    /// Custom, user-added sources, by kind (mirrors the JSON file).
    custom: RwLock<HashMap<CatalogKind, Vec<Source>>>,
    /// Where custom sources persist. Resolved once at construction.
    sources_file: PathBuf,
}

impl CatalogSourceRegistry {
    /// Construct with the default (or `RYU_CATALOG_SOURCES_FILE`) path and load
    /// any previously-saved custom sources. A missing/corrupt file is non-fatal.
    pub fn new() -> Self {
        let path = std::env::var(SOURCES_FILE_ENV)
            .map(PathBuf::from)
            .unwrap_or_else(|_| default_sources_file());
        Self::with_file(path)
    }

    /// Construct against a specific custom-sources file (the test seam).
    pub fn with_file(sources_file: PathBuf) -> Self {
        let registry = Self {
            builtin: builtin_sources(),
            custom: RwLock::new(HashMap::new()),
            sources_file,
        };
        if let Err(e) = registry.load_custom() {
            tracing::warn!("failed to load custom catalog sources: {e:#}");
        }
        registry
    }

    /// The built-in primary (default active) source for a kind — the first
    /// registered built-in. Every kind has at least one (the AC).
    fn builtin_primary(&self, kind: CatalogKind) -> Option<&Source> {
        self.builtin.get(&kind).and_then(|v| v.first())
    }

    /// All sources for a kind (built-in first, then custom), as flat metadata.
    pub fn sources_for(&self, kind: CatalogKind) -> Vec<SourceMeta> {
        let mut out: Vec<SourceMeta> = self
            .builtin
            .get(&kind)
            .into_iter()
            .flatten()
            .map(|s| SourceMeta {
                id: s.id().to_string(),
                display_name: s.display_name().to_string(),
                builtin: true,
                base_url: s.base_url().map(str::to_string),
                has_auth: s.auth().is_some(),
            })
            .collect();
        if let Ok(custom) = self.custom.read() {
            if let Some(list) = custom.get(&kind) {
                for s in list {
                    out.push(SourceMeta {
                        id: s.id().to_string(),
                        display_name: s.display_name().to_string(),
                        builtin: false,
                        base_url: s.base_url().map(str::to_string),
                        has_auth: s.auth().is_some(),
                    });
                }
            }
        }
        out
    }

    /// Find a source (built-in or custom) by kind + id.
    fn find(&self, kind: CatalogKind, id: &str) -> Option<Source> {
        if let Some(s) = self
            .builtin
            .get(&kind)
            .and_then(|v| v.iter().find(|s| s.id() == id))
        {
            return Some(s.clone());
        }
        self.custom.read().ok().and_then(|c| {
            c.get(&kind)
                .and_then(|v| v.iter().find(|s| s.id() == id).cloned())
        })
    }

    /// The currently-active source id for a kind: the persisted selection if it
    /// still resolves, else the built-in primary. A stale/removed id falls back
    /// rather than erroring.
    pub async fn active_id(&self, kind: CatalogKind, prefs: &PreferencesStore) -> Option<String> {
        if let Ok(Some(id)) = prefs.get(&preference_key(kind)).await {
            if self.find(kind, &id).is_some() {
                return Some(id);
            }
        }
        self.builtin_primary(kind).map(|s| s.id().to_string())
    }

    /// The active source itself, resolved with the same fallback as
    /// [`active_id`](Self::active_id).
    pub async fn get_active(&self, kind: CatalogKind, prefs: &PreferencesStore) -> Option<Source> {
        let id = self.active_id(kind, prefs).await?;
        self.find(kind, &id)
    }

    /// Resolve a specific catalog source by kind + id (built-in or custom).
    pub fn source_by_id(&self, kind: CatalogKind, id: &str) -> Option<Source> {
        self.find(kind, id)
    }

    /// Add (or replace) a custom source and persist it to the JSON file.
    pub fn add_custom(&self, spec: CustomSourceSpec) -> Result<()> {
        // Custom model sources resolve to an HfSource (HF-compatible base) or a
        // ModelIndexSource (a `.json` index URL); other kinds get a stub carrier
        // so listing/selection works ahead of per-kind fetch. See
        // [`source_from_spec`] for the discrimination rule.
        let source = source_from_spec(spec.clone());
        // Reject collisions with a built-in id (those are not user-removable).
        if self
            .builtin
            .get(&spec.kind)
            .is_some_and(|v| v.iter().any(|s| s.id() == spec.id))
        {
            bail!(
                "`{}` is a built-in source id and cannot be overridden",
                spec.id
            );
        }
        {
            let mut custom = self
                .custom
                .write()
                .map_err(|_| anyhow::anyhow!("custom sources lock poisoned"))?;
            let list = custom.entry(spec.kind).or_default();
            list.retain(|s| s.id() != spec.id);
            list.push(source);
        }
        self.save_custom()
    }

    /// Persist the active source id for a kind. Rejects an unknown id.
    pub async fn set_active(
        &self,
        kind: CatalogKind,
        id: &str,
        prefs: &PreferencesStore,
    ) -> Result<()> {
        if self.find(kind, id).is_none() {
            bail!("unknown source `{id}` for kind `{kind}`");
        }
        prefs
            .set(&preference_key(kind), id)
            .await
            .with_context(|| format!("persisting active source for {kind}"))
    }

    // ── JSON persistence for custom sources ─────────────────────────────────

    fn load_custom(&self) -> Result<()> {
        if !self.sources_file.exists() {
            return Ok(());
        }
        let raw = std::fs::read_to_string(&self.sources_file)
            .with_context(|| format!("reading {}", self.sources_file.display()))?;
        if raw.trim().is_empty() {
            return Ok(());
        }
        let specs: Vec<CustomSourceSpec> = serde_json::from_str(&raw)
            .with_context(|| format!("parsing {}", self.sources_file.display()))?;
        let mut custom = self
            .custom
            .write()
            .map_err(|_| anyhow::anyhow!("custom sources lock poisoned"))?;
        custom.clear();
        for spec in specs {
            let kind = spec.kind;
            custom.entry(kind).or_default().push(source_from_spec(spec));
        }
        Ok(())
    }

    fn save_custom(&self) -> Result<()> {
        let specs = self.custom_specs();
        if let Some(parent) = self.sources_file.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(&specs)?;
        std::fs::write(&self.sources_file, json)
            .with_context(|| format!("writing {}", self.sources_file.display()))?;
        Ok(())
    }

    /// Flatten the in-memory custom sources back into their persisted specs.
    fn custom_specs(&self) -> Vec<CustomSourceSpec> {
        let mut specs = Vec::new();
        if let Ok(custom) = self.custom.read() {
            for (kind, list) in custom.iter() {
                for s in list {
                    specs.push(CustomSourceSpec {
                        kind: *kind,
                        id: s.id().to_string(),
                        display_name: s.display_name().to_string(),
                        base_url: s.base_url().map(str::to_string),
                        auth: s.auth().cloned(),
                    });
                }
            }
        }
        specs
    }
}

impl Default for CatalogSourceRegistry {
    fn default() -> Self {
        Self::new()
    }
}

/// The built-in sources registered in code: one real source for models
/// (Hugging Face) and a labelled stub per other kind so every kind has >=1.
fn builtin_sources() -> HashMap<CatalogKind, Vec<Source>> {
    let mut map: HashMap<CatalogKind, Vec<Source>> = HashMap::new();
    // The Ryu Marketplace federated source (#467) is registered on EVERY kind so
    // it appears as a selectable source on every tab. For model/skill/mcp it is
    // appended AFTER the existing primary (the first entry stays the default
    // active — HF / skills.sh / the official MCP registry). For plugin it is the
    // primary (the previous Stub had no real fetch).
    map.insert(
        CatalogKind::Model,
        vec![
            Source::Hf(HfSource::builtin()),
            Source::Hf(HfSource::modelscope()),
            Source::RyuMarketplace(RyuMarketplaceSource::builtin(CatalogKind::Model)),
        ],
    );
    map.insert(
        CatalogKind::Skill,
        vec![
            Source::SkillsSh(SkillsShSource::builtin()),
            Source::RyuMarketplace(RyuMarketplaceSource::builtin(CatalogKind::Skill)),
        ],
    );
    map.insert(
        CatalogKind::Mcp,
        vec![
            // Primary (default active): the official MCP registry (#464).
            Source::OfficialMcp(OfficialMcpSource::builtin()),
            // Smithery's registry (#465) — BYOK API key, host-fixed.
            Source::Smithery(SmitherySource::builtin()),
            // Ryu-hosted curated index (#465) — swappable URL, static fallback.
            Source::RyuHostedMcp(RyuHostedMcpSource::builtin()),
            // Ryu Marketplace federated source (#467).
            Source::RyuMarketplace(RyuMarketplaceSource::builtin(CatalogKind::Mcp)),
        ],
    );
    map.insert(
        CatalogKind::Plugin,
        vec![
            // Primary (default active): the ONE universal GitHub source (unified
            // 2026-07-19). The first-party OPEN catalog git repo (`amajorai/ryu-
            // marketplace`, override via `RYU_MARKETPLACE_REPO`), read via the
            // generalized git `MarketplaceSource`. It is `primary()` (first in the vec),
            // so the store opens on it and the confusing "Ryu Marketplace" vs "Ryu
            // Catalog" two-source split is gone — GitHub is the single browse catalog.
            Source::Marketplace(MarketplaceSource::new(
                "ryu-catalog",
                "Ryu Marketplace",
                std::env::var("RYU_MARKETPLACE_REPO")
                    .ok()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "amajorai/ryu-marketplace".to_string()),
                CatalogKind::Plugin,
            )),
            // DEMOTED, not removed: the hosted (Mongo, api.ryuhq.com) source stays wired
            // as the COMMERCE + signing backend. A static GitHub repo cannot process
            // payments or issue per-user signed download grants, so PAID items still need
            // this server for Stripe checkout + entitlement + `verify_manifest_signature`
            // at install (see `sources.rs` paid gate + `packages/marketplace`
            // `startPurchase`/`useLicenses`). It is no longer the primary browse source;
            // `merged_plugin_catalog_entries` still folds its paid listings into the list.
            Source::RyuMarketplace(RyuMarketplaceSource::builtin(CatalogKind::Plugin)),
            // Browse every publicly documented integration surface
            // (MCP/OpenAPI/GraphQL/CLI) as descriptor-only marketplace entries.
            Source::IntegrationsSh(IntegrationsShSource::builtin()),
            Source::Stub(StubSource {
                id: "ryu-apps".to_string(),
                display_name: "Ryu App Catalog".to_string(),
                kind: CatalogKind::Plugin,
            }),
        ],
    );
    // Knowledge (OKF bundles). Primary (default active): the Ryu Marketplace
    // federated source so every install ships a real catalog without a hardcoded
    // bundle URL ("nothing hardcoded"). Custom git/HTTP OKF bundles are added as
    // `OkfBundleSource`s (see `source_from_spec`).
    map.insert(
        CatalogKind::Knowledge,
        vec![Source::RyuMarketplace(RyuMarketplaceSource::builtin(
            CatalogKind::Knowledge,
        ))],
    );
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn temp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "ryu-catalog-source-{}-{}.json",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_file(&p);
        p
    }

    fn temp_prefs() -> PreferencesStore {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "ryu-catalog-prefs-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&p);
        PreferencesStore::open(p).expect("open temp prefs")
    }

    #[test]
    fn kind_from_str_round_trip() {
        for k in CatalogKind::ALL {
            let parsed = CatalogKind::from_str(k.as_str()).unwrap();
            assert_eq!(parsed, k);
            // Display matches as_str, and uppercase parses too.
            assert_eq!(parsed.to_string(), k.as_str());
            assert_eq!(
                CatalogKind::from_str(&k.as_str().to_uppercase()).unwrap(),
                k
            );
        }
        assert!(CatalogKind::from_str("nope").is_err());
    }

    #[test]
    fn is_model_index_url_discriminates_json_documents() {
        // Plain .json path → model-index.
        assert!(is_model_index_url("https://x.io/models.json"));
        // Trailing slash is stripped before the .json check.
        assert!(is_model_index_url("https://x.io/models.json/"));
        // Query and fragment are ignored (path component only).
        assert!(is_model_index_url("https://x.io/models.json?ref=main"));
        assert!(is_model_index_url("https://x.io/models.json#frag"));
        // Case-insensitive suffix.
        assert!(is_model_index_url("https://x.io/MODELS.JSON"));
        // An HF-style API base is NOT a model index.
        assert!(!is_model_index_url("https://huggingface.co/api"));
        assert!(!is_model_index_url("https://mirror.example/api/"));
    }

    #[test]
    fn preference_key_is_dotted_by_kind() {
        assert_eq!(preference_key(CatalogKind::Model), "catalog.active_source.model");
        assert_eq!(preference_key(CatalogKind::Skill), "catalog.active_source.skill");
    }

    fn spec(kind: CatalogKind, id: &str, base_url: Option<&str>) -> CustomSourceSpec {
        CustomSourceSpec {
            kind,
            id: id.to_owned(),
            display_name: format!("{id} name"),
            base_url: base_url.map(str::to_owned),
            auth: None,
        }
    }

    #[test]
    fn source_from_spec_model_json_is_index_else_hf() {
        // .json base_url → ModelIndex carrier.
        let s = source_from_spec(spec(CatalogKind::Model, "idx", Some("https://x.io/m.json")));
        assert!(matches!(s, Source::ModelIndex(_)));
        assert_eq!(s.id(), "idx");
        // Non-.json base_url → HF carrier.
        let s = source_from_spec(spec(CatalogKind::Model, "hf", Some("https://mirror/api")));
        assert!(matches!(s, Source::Hf(_)));
        // No base_url → HF default host.
        let s = source_from_spec(spec(CatalogKind::Model, "def", None));
        assert!(matches!(s, Source::Hf(_)));
    }

    #[test]
    fn source_from_spec_marketplace_kinds_need_a_base_url() {
        // Skill + base_url → Marketplace; without → Stub.
        assert!(matches!(
            source_from_spec(spec(CatalogKind::Skill, "s1", Some("https://repo/x"))),
            Source::Marketplace(_)
        ));
        assert!(matches!(
            source_from_spec(spec(CatalogKind::Skill, "s2", None)),
            Source::Stub(_)
        ));
        // A whitespace-only base_url is treated as absent → Stub.
        assert!(matches!(
            source_from_spec(spec(CatalogKind::Skill, "s3", Some("   "))),
            Source::Stub(_)
        ));
        // Plugin behaves the same way.
        assert!(matches!(
            source_from_spec(spec(CatalogKind::Plugin, "p1", Some("https://repo/y"))),
            Source::Marketplace(_)
        ));
        assert!(matches!(
            source_from_spec(spec(CatalogKind::Plugin, "p2", None)),
            Source::Stub(_)
        ));
    }

    #[test]
    fn source_from_spec_mcp_and_knowledge_carriers() {
        assert!(matches!(
            source_from_spec(spec(CatalogKind::Mcp, "m1", Some("https://registry/mirror"))),
            Source::OfficialMcp(_)
        ));
        assert!(matches!(
            source_from_spec(spec(CatalogKind::Mcp, "m2", None)),
            Source::Stub(_)
        ));
        assert!(matches!(
            source_from_spec(spec(CatalogKind::Knowledge, "k1", Some("https://git/repo"))),
            Source::OkfBundle(_)
        ));
        assert!(matches!(
            source_from_spec(spec(CatalogKind::Knowledge, "k2", None)),
            Source::Stub(_)
        ));
    }

    #[test]
    fn source_by_id_finds_builtin_and_missing() {
        let reg = CatalogSourceRegistry::with_file(temp_path("by-id"));
        // The built-in HF model source resolves by id.
        assert!(reg.source_by_id(CatalogKind::Model, "huggingface").is_some());
        // An unknown id resolves to None.
        assert!(reg.source_by_id(CatalogKind::Model, "does-not-exist").is_none());
    }

    #[test]
    fn registry_has_at_least_one_source_per_kind() {
        let reg = CatalogSourceRegistry::with_file(temp_path("per-kind"));
        for kind in CatalogKind::ALL {
            assert!(
                !reg.sources_for(kind).is_empty(),
                "kind {kind} has no source"
            );
        }
        // The model built-in is the real HF source.
        let model_sources = reg.sources_for(CatalogKind::Model);
        assert!(model_sources
            .iter()
            .any(|s| s.id == "huggingface" && s.builtin));
    }

    #[tokio::test]
    async fn default_active_is_builtin_primary() {
        let reg = CatalogSourceRegistry::with_file(temp_path("default-active"));
        let prefs = temp_prefs();
        let active = reg.active_id(CatalogKind::Model, &prefs).await;
        assert_eq!(active.as_deref(), Some("huggingface"));
    }

    #[tokio::test]
    async fn add_select_and_read_back_a_custom_source() {
        let file = temp_path("add-select");
        let reg = CatalogSourceRegistry::with_file(file.clone());
        let prefs = temp_prefs();

        reg.add_custom(CustomSourceSpec {
            kind: CatalogKind::Model,
            id: "my-mirror".to_string(),
            display_name: "My Mirror".to_string(),
            base_url: Some("https://mirror.example/api".to_string()),
            auth: None,
        })
        .unwrap();

        // Listing now includes builtin + custom.
        let listed = reg.sources_for(CatalogKind::Model);
        assert!(listed.iter().any(|s| s.id == "huggingface" && s.builtin));
        let custom = listed
            .iter()
            .find(|s| s.id == "my-mirror")
            .expect("custom listed");
        assert!(!custom.builtin);
        assert_eq!(
            custom.base_url.as_deref(),
            Some("https://mirror.example/api")
        );

        // Select it, then read it back as active.
        reg.set_active(CatalogKind::Model, "my-mirror", &prefs)
            .await
            .unwrap();
        assert_eq!(
            reg.active_id(CatalogKind::Model, &prefs).await.as_deref(),
            Some("my-mirror")
        );

        // Unknown id is rejected.
        assert!(reg
            .set_active(CatalogKind::Model, "ghost", &prefs)
            .await
            .is_err());

        // Persistence: a fresh registry over the same file sees the custom source.
        let reg2 = CatalogSourceRegistry::with_file(file);
        assert!(reg2
            .sources_for(CatalogKind::Model)
            .iter()
            .any(|s| s.id == "my-mirror"));
    }

    #[tokio::test]
    async fn active_model_source_resolves_to_its_endpoint_host() {
        let file = temp_path("endpoint-host");
        let reg = CatalogSourceRegistry::with_file(file);
        let prefs = temp_prefs();

        // Default active = Hugging Face → huggingface.co host.
        let active = reg
            .get_active(CatalogKind::Model, &prefs)
            .await
            .expect("default active source");
        let hf = match active {
            Source::Hf(hf) => hf,
            _ => panic!("expected an HF model source"),
        };
        assert_eq!(hf.endpoint().host, "https://huggingface.co");

        // Select the builtin ModelScope source → its host, not HF's.
        reg.set_active(CatalogKind::Model, "modelscope", &prefs)
            .await
            .unwrap();
        let active = reg
            .get_active(CatalogKind::Model, &prefs)
            .await
            .expect("modelscope active");
        let ms = match active {
            Source::Hf(hf) => hf,
            _ => panic!("expected an HF model source"),
        };
        assert_eq!(ms.endpoint().host, "https://modelscope.cn");
        assert_ne!(ms.endpoint().host, HfSource::builtin().endpoint().host);

        // A custom HF-compatible source resolves to its supplied base URL host.
        reg.add_custom(CustomSourceSpec {
            kind: CatalogKind::Model,
            id: "mirror".to_string(),
            display_name: "Private Mirror".to_string(),
            base_url: Some("https://hf.mirror.example/api".to_string()),
            auth: None,
        })
        .unwrap();
        reg.set_active(CatalogKind::Model, "mirror", &prefs)
            .await
            .unwrap();
        let active = reg
            .get_active(CatalogKind::Model, &prefs)
            .await
            .expect("mirror active");
        let mirror = match active {
            Source::Hf(hf) => hf,
            _ => panic!("expected an HF model source"),
        };
        let ep = mirror.endpoint();
        assert_eq!(ep.api_base, "https://hf.mirror.example/api");
        assert_eq!(ep.host, "https://hf.mirror.example");
    }

    #[tokio::test]
    async fn knowledge_custom_source_is_okf_bundle_or_stub() {
        let reg = CatalogSourceRegistry::with_file(temp_path("knowledge-custom"));
        // Every kind, including Knowledge, has a built-in primary.
        assert!(!reg.sources_for(CatalogKind::Knowledge).is_empty());

        // A custom Knowledge source WITH a base_url becomes an OkfBundleSource
        // pointing at that OKF bundle git/HTTP location.
        reg.add_custom(CustomSourceSpec {
            kind: CatalogKind::Knowledge,
            id: "team-kb".to_string(),
            display_name: "Team KB".to_string(),
            base_url: Some("https://github.com/acme/kb".to_string()),
            auth: None,
        })
        .unwrap();
        let bundle = reg
            .find(CatalogKind::Knowledge, "team-kb")
            .expect("custom knowledge source");
        match bundle {
            Source::OkfBundle(s) => {
                assert_eq!(s.source_url, "https://github.com/acme/kb");
                assert!(s.git_ref.is_none());
            }
            _ => panic!("expected an OkfBundle knowledge source"),
        }

        // A custom Knowledge source WITHOUT a base_url degrades to a labelled stub.
        reg.add_custom(CustomSourceSpec {
            kind: CatalogKind::Knowledge,
            id: "empty-kb".to_string(),
            display_name: "Empty KB".to_string(),
            base_url: None,
            auth: None,
        })
        .unwrap();
        assert!(matches!(
            reg.find(CatalogKind::Knowledge, "empty-kb"),
            Some(Source::Stub(_))
        ));
    }

    #[tokio::test]
    async fn plugin_custom_source_is_git_marketplace_or_stub() {
        let file = temp_path("plugin-custom");
        let reg = CatalogSourceRegistry::with_file(file.clone());
        let prefs = temp_prefs();
        // The Plugin kind ships a built-in primary (the Ryu marketplace).
        assert!(!reg.sources_for(CatalogKind::Plugin).is_empty());

        // A custom Plugin source WITH a base_url becomes a git MarketplaceSource
        // pointing at the repo hosting `.claude-plugin/marketplace.json`, serving
        // the Plugin kind so its cards land under the `{ items }` envelope.
        reg.add_custom(CustomSourceSpec {
            kind: CatalogKind::Plugin,
            id: "team-plugins".to_string(),
            display_name: "Team Plugins".to_string(),
            base_url: Some("https://github.com/acme/plugins".to_string()),
            auth: None,
        })
        .unwrap();
        match reg.find(CatalogKind::Plugin, "team-plugins") {
            Some(Source::Marketplace(s)) => {
                assert_eq!(s.repo_url, "https://github.com/acme/plugins");
                assert_eq!(s.kind, CatalogKind::Plugin);
            }
            _ => panic!("expected a git Marketplace plugin source"),
        }

        // It is listed by `sources_for(Plugin)` and selectable via `set_active`.
        assert!(reg
            .sources_for(CatalogKind::Plugin)
            .iter()
            .any(|s| s.id == "team-plugins"));
        reg.set_active(CatalogKind::Plugin, "team-plugins", &prefs)
            .await
            .unwrap();
        assert_eq!(
            reg.active_id(CatalogKind::Plugin, &prefs).await.as_deref(),
            Some("team-plugins")
        );

        // A custom Plugin source with an EMPTY base_url degrades to a stub
        // (exercises the `.filter(|u| !u.trim().is_empty())` trim path).
        reg.add_custom(CustomSourceSpec {
            kind: CatalogKind::Plugin,
            id: "empty-plugins".to_string(),
            display_name: "Empty Plugins".to_string(),
            base_url: Some(String::new()),
            auth: None,
        })
        .unwrap();
        assert!(matches!(
            reg.find(CatalogKind::Plugin, "empty-plugins"),
            Some(Source::Stub(_))
        ));
    }

    #[tokio::test]
    async fn stale_active_falls_back_to_builtin() {
        let reg = CatalogSourceRegistry::with_file(temp_path("stale"));
        let prefs = temp_prefs();
        // Persist an id that no longer resolves (simulating a removed source).
        prefs
            .set(&preference_key(CatalogKind::Model), "gone")
            .await
            .unwrap();
        assert_eq!(
            reg.active_id(CatalogKind::Model, &prefs).await.as_deref(),
            Some("huggingface")
        );
    }
}
