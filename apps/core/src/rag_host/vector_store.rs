//! The configured **external vector store** — the pluggable half of the RAG
//! provider binding ([`super::open_retrieval_store`]).
//!
//! # What selecting a vector store does
//!
//! The built-in stores keep doing what they did: `retrieval.db` answers memory and
//! OKF chunks, and each Space answers out of `spaces.db` (sqlite-vec) under its own
//! `retrieval_mode`. A configured vector store adds **one more knowledge source**:
//! a collection in Qdrant, Chroma, Pinecone, Weaviate, Milvus, pgvector, or a local
//! sqlite-vec file, addressed by the source id [`SOURCE_ID`]. It joins retrieval
//! exactly the way a Space does — through the [`ryu_rag::SpaceRecall`] delegate —
//! so its hits are fused by rank with memory and Spaces and never compared to a
//! cosine they are not on the scale of:
//!
//! - `space_ids: None` ("every source the caller may read") includes it;
//! - `space_ids: Some([... "vector-store" ...])` (an agent allowlist, or the
//!   `space_ids` of `POST /api/retrieval/search`) includes it;
//! - `space_ids: Some([])` — the default agent's turn — skips it, like every Space.
//!
//! The collection is queried with the node's retrieval embedder, so it must have
//! been written with the same embedding model and dimensions; the first use runs
//! `ensure_collection`, which creates an empty collection when it is missing and
//! fails loudly on a dimension mismatch.
//!
//! # Tenancy
//!
//! The collection is **node-shared knowledge** (like an OKF bundle): an unbound
//! node reads it unrestricted. On a bound node an anonymous caller gets nothing
//! (fail closed); a signed-in caller reads the collection. Per-user partitioning
//! inside an external collection is not attempted, because Ryu does not own what
//! the operator writes there.
//!
//! # Credentials
//!
//! Never inline. `RYU_RAG_VECTOR_STORE_CREDENTIAL` is a **reference**: `env:NAME`
//! (process environment) or `secret:NAME` (the node's encrypted vault, resolved in
//! node scope). It is resolved lazily on first use, never logged, and the resolved
//! value lives only inside the backend client.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use tokio::sync::OnceCell;

use ryu_rag::{ChunkSource, Embedder, RetrievalOptions, ScoredChunk, SpaceRecall};
use ryu_vector_stores::{
    CollectionSpec, DistanceMetric, VectorQuery, VectorStore, VectorStoreConfig,
    VectorStoreProvider,
};

use super::SpacesRecall;

/// The retrieval source id that selects the external collection in `space_ids`.
pub const SOURCE_ID: &str = "vector-store";

/// Default collection name.
pub const DEFAULT_COLLECTION: &str = "ryu_knowledge";

/// The local sqlite-vec file (under the data dir's `db/`).
pub const SQLITE_VEC_DB_FILE: &str = "vector-store.db";

/// After a failed open or query, the collection is skipped (without I/O) for
/// this long, so an unreachable server costs one turn a connect timeout instead
/// of costing every turn one.
const FAILURE_COOLDOWN: Duration = Duration::from_secs(30);

/// Hit ids are namespaced (`vector-store:<id>`) before rank fusion, which merges
/// rows by id: an external id must never collide with a memory or Space chunk id
/// and silently fold two different passages into one.
fn chunk_id(id: &str) -> String {
    format!("{SOURCE_ID}:{id}")
}

/// Core's own bootstrap secrets, which a credential reference may not name.
const NODE_SECRET_ENV: [&str; 4] = [
    "RYU_TOKEN",
    "RYU_MASTER_KEY",
    "RYU_EXT_TOKEN",
    "RYU_MESH_AUTHKEY",
];

/// A credential reference: where the backend credential is read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CredentialRef {
    /// `env:NAME` — a process environment variable.
    Env(String),
    /// `secret:NAME` — the node-scoped encrypted vault.
    Secret(String),
}

impl CredentialRef {
    /// Parse a reference. Anything that is not `env:` / `secret:` is rejected so
    /// a pasted key can never be accepted as configuration.
    pub fn parse(raw: &str) -> Result<Self> {
        let raw = raw.trim();
        if let Some(name) = raw.strip_prefix("env:") {
            let valid = !name.is_empty()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_');
            if !valid {
                bail!("vector store credential env: reference needs an upper-case variable name");
            }
            // Core's own bootstrap secrets are never a vector-store credential:
            // naming one would send the node's token or master key to a third
            // party server.
            if NODE_SECRET_ENV.contains(&name) {
                bail!("vector store credential env:{name} names one of Core's own secrets");
            }
            return Ok(Self::Env(name.to_owned()));
        }
        if let Some(name) = raw.strip_prefix("secret:") {
            if name.trim().is_empty() {
                bail!("vector store credential secret: reference needs a name");
            }
            return Ok(Self::Secret(name.trim().to_owned()));
        }
        bail!(
            "RYU_RAG_VECTOR_STORE_CREDENTIAL must be a reference (env:NAME or secret:NAME); \
             inline credentials are not accepted"
        )
    }

    async fn resolve(&self) -> Result<String> {
        let value = match self {
            Self::Env(name) => std::env::var(name)
                .ok()
                .with_context(|| format!("vector store credential: {name} is not set"))?,
            Self::Secret(name) => {
                let store = crate::plugin_secrets::global()
                    .context("vector store credential: the secret store is not available")?;
                let context = crate::plugin_secrets::SecretResolutionContext::node_only(
                    crate::server::agent_sync::local_node_id(),
                    Vec::new(),
                );
                store
                    .resolve_vault_secret(name, &context)
                    .await
                    .context("vector store credential: reading the vault secret failed")?
                    .with_context(|| {
                        format!("vector store credential: vault secret '{name}' is not set")
                    })?
            }
        };
        let value = value.trim().to_owned();
        if value.is_empty() {
            bail!("vector store credential resolved to an empty value");
        }
        Ok(value)
    }
}

/// Non-secret vector-store settings (`settings.rag.vectorStore.*` in
/// `node-config.json`, flattened to `RYU_RAG_VECTOR_STORE_*`).
#[derive(Debug, Clone, PartialEq)]
pub struct VectorStoreSettings {
    pub provider: VectorStoreProvider,
    pub collection: String,
    pub url: Option<String>,
    pub credential: Option<CredentialRef>,
    pub text_field: Option<String>,
    pub tenant: Option<String>,
    pub database: Option<String>,
    pub index: Option<String>,
    pub cloud: Option<String>,
    pub region: Option<String>,
    pub metric: DistanceMetric,
}

impl VectorStoreSettings {
    /// Read the settings for `provider` through `lookup` (the process
    /// environment in production). Validates everything that can be validated
    /// without I/O, so a misconfiguration fails at boot, not on a chat turn.
    pub fn from_lookup(
        provider: VectorStoreProvider,
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Self> {
        let get = |suffix: &str| {
            lookup(&format!("RYU_RAG_VECTOR_STORE_{suffix}"))
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        };
        let collection = get("COLLECTION").unwrap_or_else(|| DEFAULT_COLLECTION.to_owned());
        ryu_vector_stores::validate_collection_name(&collection)?;
        let url = get("URL");
        if provider.is_remote() && provider != VectorStoreProvider::Pinecone && url.is_none() {
            bail!("RYU_RAG_VECTOR_STORE_URL is required for the {provider} vector store");
        }
        if let Some(url) = &url {
            let is_postgres = url.starts_with("postgres://") || url.starts_with("postgresql://");
            let is_http = url.starts_with("http://") || url.starts_with("https://");
            let expected = if provider == VectorStoreProvider::Pgvector {
                is_postgres
            } else {
                is_http
            };
            if !expected {
                bail!(
                    "RYU_RAG_VECTOR_STORE_URL has the wrong scheme for the {provider} vector store"
                );
            }
        }
        let credential = get("CREDENTIAL")
            .map(|raw| CredentialRef::parse(&raw))
            .transpose()?;
        if provider == VectorStoreProvider::Pinecone {
            if get("INDEX").is_none() {
                bail!("RYU_RAG_VECTOR_STORE_INDEX is required for the pinecone vector store");
            }
            if credential.is_none() {
                bail!("RYU_RAG_VECTOR_STORE_CREDENTIAL is required for the pinecone vector store");
            }
        }
        let text_field = get("TEXT_FIELD");
        if let Some(field) = &text_field {
            ryu_vector_stores::validate_field_name(field)?;
        }
        let metric = get("METRIC")
            .map(|raw| raw.parse())
            .transpose()?
            .unwrap_or_default();
        Ok(Self {
            provider,
            collection,
            url,
            credential,
            text_field,
            tenant: get("TENANT"),
            database: get("DATABASE"),
            index: get("INDEX"),
            cloud: get("CLOUD"),
            region: get("REGION"),
            metric,
        })
    }

    async fn backend_config(&self) -> Result<VectorStoreConfig> {
        let api_key = match &self.credential {
            Some(reference) => Some(reference.resolve().await?),
            None => None,
        };
        Ok(VectorStoreConfig {
            provider: Some(self.provider),
            url: self.url.clone(),
            api_key,
            path: (self.provider == VectorStoreProvider::SqliteVec)
                .then(|| crate::paths::db_path(SQLITE_VEC_DB_FILE)),
            text_key: self.text_field.clone(),
            tenant: self.tenant.clone(),
            database: self.database.clone(),
            index: self.index.clone(),
            cloud: self.cloud.clone(),
            region: self.region.clone(),
            timeout_secs: None,
        })
    }
}

/// How a backend is opened once its config is resolved. Production uses
/// [`ryu_vector_stores::build`]; tests inject a store directly.
type Opener = dyn Fn(VectorStoreConfig) -> Result<Arc<dyn VectorStore>> + Send + Sync;

/// The configured external collection, opened lazily on first recall.
pub struct ExternalCollection {
    settings: VectorStoreSettings,
    embedder: Embedder,
    opener: Box<Opener>,
    store: OnceCell<Arc<dyn VectorStore>>,
    failed_at: Mutex<Option<Instant>>,
}

impl ExternalCollection {
    /// Wrap validated settings. No I/O happens until the first recall.
    pub fn new(settings: VectorStoreSettings, embedder: Embedder) -> Self {
        Self::with_opener(
            settings,
            embedder,
            Box::new(|config| ryu_vector_stores::build(&config)),
        )
    }

    fn with_opener(settings: VectorStoreSettings, embedder: Embedder, opener: Box<Opener>) -> Self {
        Self {
            settings,
            embedder,
            opener,
            store: OnceCell::new(),
            failed_at: Mutex::new(None),
        }
    }

    fn cooling_down(&self) -> bool {
        self.failed_at
            .lock()
            .ok()
            .and_then(|failed_at| *failed_at)
            .is_some_and(|at| at.elapsed() < FAILURE_COOLDOWN)
    }

    fn record_outcome(&self, failed: bool) {
        if let Ok(mut failed_at) = self.failed_at.lock() {
            *failed_at = failed.then(Instant::now);
        }
    }

    /// The provider this collection lives in.
    pub fn provider(&self) -> VectorStoreProvider {
        self.settings.provider
    }

    async fn store(&self) -> Result<&Arc<dyn VectorStore>> {
        self.store
            .get_or_try_init(|| async {
                let config = self.settings.backend_config().await?;
                let store = (self.opener)(config)?;
                store
                    .ensure_collection(&CollectionSpec {
                        name: self.settings.collection.clone(),
                        dimensions: self.embedder.dims(),
                        metric: self.settings.metric,
                    })
                    .await?;
                Ok(store)
            })
            .await
    }

    /// Whether `opts` selects this source.
    pub fn selected(opts: &RetrievalOptions) -> bool {
        match &opts.space_ids {
            None => true,
            Some(ids) => ids.iter().any(|id| id == SOURCE_ID),
        }
    }

    /// One best-first list of hits for `query`, honouring the bound-node rule.
    pub async fn recall(
        &self,
        query: &str,
        opts: &RetrievalOptions,
        limit: usize,
    ) -> Result<Vec<ScoredChunk>> {
        if limit == 0 || (opts.node_bound && opts.caller_user_id.is_none()) {
            return Ok(Vec::new());
        }
        if self.cooling_down() {
            bail!(
                "skipped for up to {}s after a failed request",
                FAILURE_COOLDOWN.as_secs()
            );
        }
        let vector = self.embedder.embed(query).await?;
        let result = async {
            self.store()
                .await?
                .query(
                    &self.settings.collection,
                    &VectorQuery {
                        vector,
                        top_k: limit,
                        filter: None,
                    },
                )
                .await
        }
        .await;
        self.record_outcome(result.is_err());
        let filter = opts.filter.as_ref().filter(|filter| !filter.is_empty());
        Ok(result?
            .into_iter()
            .filter_map(|hit| {
                // `RetrievalOptions::filter` is a predicate every returned chunk
                // must satisfy, external ones included.
                if let Some(filter) = filter {
                    if !filter.matches(&external_filter_metadata(&hit.metadata)) {
                        return None;
                    }
                }
                let content = hit.document.filter(|text| !text.trim().is_empty())?;
                Some(ScoredChunk {
                    id: chunk_id(&hit.id),
                    source: ChunkSource::Space,
                    space_id: Some(SOURCE_ID.to_owned()),
                    content,
                    score: hit.score,
                })
            })
            .collect())
    }
}

/// The metadata object a metadata filter sees for one external hit: the stored
/// metadata overlaid with the built-in fields, which win so stored metadata
/// cannot impersonate them (the same rule as `retrieval.db` chunks).
fn external_filter_metadata(
    stored: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = stored.clone();
    map.insert("source".into(), "space".into());
    map.insert("space_id".into(), SOURCE_ID.into());
    map
}

/// The [`SpaceRecall`] delegate when a vector store is configured: the Spaces
/// store answers real Space ids, the external collection answers [`SOURCE_ID`].
pub struct VectorStoreRecall {
    spaces: SpacesRecall,
    external: ExternalCollection,
}

impl VectorStoreRecall {
    pub fn new(spaces: SpacesRecall, external: ExternalCollection) -> Self {
        Self { spaces, external }
    }
}

#[async_trait::async_trait]
impl SpaceRecall for VectorStoreRecall {
    async fn recall(
        &self,
        query: &str,
        opts: &RetrievalOptions,
        per_space_limit: usize,
    ) -> Result<Vec<Vec<ScoredChunk>>> {
        // The Spaces store must never see the pseudo-id: it is not a Space and
        // would only produce a "space skipped" warning per turn.
        let spaces_opts = opts.space_ids.as_ref().map(|ids| {
            ids.iter()
                .filter(|id| id.as_str() != SOURCE_ID)
                .cloned()
                .collect::<Vec<_>>()
        });
        let run_spaces = spaces_opts.as_ref().is_none_or(|ids| !ids.is_empty());
        let spaces_future = async {
            if !run_spaces {
                return Ok(Vec::new());
            }
            let narrowed = RetrievalOptions {
                space_ids: spaces_opts.clone(),
                ..opts.clone()
            };
            self.spaces.recall(query, &narrowed, per_space_limit).await
        };
        let external_future = async {
            if !ExternalCollection::selected(opts) {
                return Vec::new();
            }
            // Fail open, like one unreadable Space: the rest of the answer stands.
            match self.external.recall(query, opts, per_space_limit).await {
                Ok(hits) => hits,
                Err(error) => {
                    tracing::warn!(
                        "retrieval: {} vector store skipped ({error:#})",
                        self.external.provider()
                    );
                    Vec::new()
                }
            }
        };
        let (spaces, external) = tokio::join!(spaces_future, external_future);
        let mut lists = spaces?;
        if !external.is_empty() {
            lists.push(external);
        }
        Ok(lists)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_vector_stores::sqlite_vec::SqliteVecStore;
    use ryu_vector_stores::VectorRecord;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn credential_references_reject_inline_values() {
        assert_eq!(
            CredentialRef::parse("env:QDRANT_API_KEY").unwrap(),
            CredentialRef::Env("QDRANT_API_KEY".into())
        );
        assert_eq!(
            CredentialRef::parse(" secret:prod/qdrant ").unwrap(),
            CredentialRef::Secret("prod/qdrant".into())
        );
        for bad in [
            "sk-live-123",
            "env:lower",
            "env:",
            "secret: ",
            "vault:x",
            "env:RYU_TOKEN",
            "env:RYU_MASTER_KEY",
        ] {
            assert!(CredentialRef::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn settings_validate_per_provider() {
        let qdrant = VectorStoreSettings::from_lookup(
            VectorStoreProvider::Qdrant,
            lookup(&[
                ("RYU_RAG_VECTOR_STORE_URL", "https://qdrant.internal:6333"),
                ("RYU_RAG_VECTOR_STORE_CREDENTIAL", "env:QDRANT_API_KEY"),
                ("RYU_RAG_VECTOR_STORE_TEXT_FIELD", "page_content"),
                ("RYU_RAG_VECTOR_STORE_METRIC", "dot"),
            ]),
        )
        .unwrap();
        assert_eq!(qdrant.collection, DEFAULT_COLLECTION);
        assert_eq!(qdrant.metric, DistanceMetric::Dot);
        assert_eq!(qdrant.text_field.as_deref(), Some("page_content"));

        // Remote backends need a URL with the right scheme.
        assert!(
            VectorStoreSettings::from_lookup(VectorStoreProvider::Chroma, lookup(&[])).is_err()
        );
        assert!(VectorStoreSettings::from_lookup(
            VectorStoreProvider::Pgvector,
            lookup(&[("RYU_RAG_VECTOR_STORE_URL", "https://db")]),
        )
        .is_err());
        assert!(VectorStoreSettings::from_lookup(
            VectorStoreProvider::Qdrant,
            lookup(&[("RYU_RAG_VECTOR_STORE_URL", "file:///etc/passwd")]),
        )
        .is_err());
        // Inline credentials and unsafe collection names fail at boot.
        assert!(VectorStoreSettings::from_lookup(
            VectorStoreProvider::Qdrant,
            lookup(&[
                ("RYU_RAG_VECTOR_STORE_URL", "http://q"),
                ("RYU_RAG_VECTOR_STORE_CREDENTIAL", "sk-123"),
            ]),
        )
        .is_err());
        assert!(VectorStoreSettings::from_lookup(
            VectorStoreProvider::SqliteVec,
            lookup(&[("RYU_RAG_VECTOR_STORE_COLLECTION", "../x")]),
        )
        .is_err());
        // Pinecone: index + credential, URL optional (public control plane).
        assert!(VectorStoreSettings::from_lookup(
            VectorStoreProvider::Pinecone,
            lookup(&[("RYU_RAG_VECTOR_STORE_INDEX", "ryu")]),
        )
        .is_err());
        assert!(VectorStoreSettings::from_lookup(
            VectorStoreProvider::Pinecone,
            lookup(&[
                ("RYU_RAG_VECTOR_STORE_INDEX", "ryu"),
                ("RYU_RAG_VECTOR_STORE_CREDENTIAL", "secret:pinecone"),
            ]),
        )
        .is_ok());
        // The local default needs nothing.
        assert!(
            VectorStoreSettings::from_lookup(VectorStoreProvider::SqliteVec, lookup(&[])).is_ok()
        );
    }

    async fn seeded_collection() -> (ExternalCollection, Arc<SqliteVecStore>) {
        let embedder = Embedder::Local { dims: 64 };
        let store = Arc::new(SqliteVecStore::open(std::path::Path::new(":memory:")).unwrap());
        store
            .ensure_collection(&CollectionSpec {
                name: DEFAULT_COLLECTION.into(),
                dimensions: 64,
                metric: DistanceMetric::Cosine,
            })
            .await
            .unwrap();
        let docs = [
            (
                "kb:1",
                "Rotterdam harbour logistics costs fell this quarter",
            ),
            ("kb:2", "The cafeteria menu lists soup on Tuesdays"),
        ];
        let mut records = Vec::new();
        for (id, text) in docs {
            records.push(VectorRecord {
                id: id.into(),
                vector: embedder.embed(text).await.unwrap(),
                document: Some(text.into()),
                metadata: serde_json::Map::new(),
            });
        }
        // A record with no text cannot ground anything and must be dropped.
        records.push(VectorRecord {
            id: "kb:empty".into(),
            vector: embedder.embed("Rotterdam logistics").await.unwrap(),
            document: None,
            metadata: serde_json::Map::new(),
        });
        store.upsert(DEFAULT_COLLECTION, &records).await.unwrap();
        let settings =
            VectorStoreSettings::from_lookup(VectorStoreProvider::SqliteVec, |_| None).unwrap();
        let handle: Arc<dyn VectorStore> = store.clone();
        let collection = ExternalCollection::with_opener(
            settings,
            embedder,
            Box::new(move |config| {
                assert_eq!(config.provider, Some(VectorStoreProvider::SqliteVec));
                Ok(Arc::clone(&handle))
            }),
        );
        (collection, store)
    }

    #[tokio::test]
    async fn recall_ranks_the_collection_and_tags_the_source() {
        let (collection, _store) = seeded_collection().await;
        let hits = collection
            .recall("Rotterdam logistics costs", &RetrievalOptions::default(), 5)
            .await
            .unwrap();
        let ids: Vec<_> = hits.iter().map(|h| h.id.as_str()).collect();
        assert_eq!(ids, ["vector-store:kb:1", "vector-store:kb:2"]);
        assert!(hits
            .iter()
            .all(|h| h.space_id.as_deref() == Some(SOURCE_ID) && h.source == ChunkSource::Space));
    }

    #[tokio::test]
    async fn recall_applies_the_metadata_filter_with_built_in_fields_winning() {
        let (collection, _store) = seeded_collection().await;
        let search = |filter: serde_json::Value| {
            let collection = &collection;
            async move {
                collection
                    .recall(
                        "Rotterdam logistics costs",
                        &RetrievalOptions {
                            filter: Some(ryu_rag::MetadataFilter::parse(&filter).unwrap()),
                            ..RetrievalOptions::default()
                        },
                        5,
                    )
                    .await
                    .unwrap()
            }
        };
        // External chunks are `space` chunks of the pseudo-space, so a memory
        // filter or a different space id must not return them.
        assert!(search(serde_json::json!({ "source": "memory" }))
            .await
            .is_empty());
        assert!(search(serde_json::json!({ "space_id": "some-space" }))
            .await
            .is_empty());
        assert_eq!(
            search(serde_json::json!({ "source": "space", "space_id": SOURCE_ID }))
                .await
                .len(),
            2
        );
        // Stored metadata cannot impersonate the built-in fields.
        let mut stored = serde_json::Map::new();
        stored.insert("source".into(), "memory".into());
        stored.insert("team".into(), "ops".into());
        let overlaid = external_filter_metadata(&stored);
        assert_eq!(overlaid["source"], "space");
        assert_eq!(overlaid["space_id"], SOURCE_ID);
        assert_eq!(overlaid["team"], "ops");
    }

    #[tokio::test]
    async fn bound_node_anonymous_callers_get_nothing() {
        let (collection, _store) = seeded_collection().await;
        let anonymous = RetrievalOptions {
            node_bound: true,
            ..RetrievalOptions::default()
        };
        assert!(collection
            .recall("Rotterdam", &anonymous, 5)
            .await
            .unwrap()
            .is_empty());
        let signed_in = RetrievalOptions {
            node_bound: true,
            caller_user_id: Some("user-1".into()),
            ..RetrievalOptions::default()
        };
        assert!(!collection
            .recall("Rotterdam", &signed_in, 5)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn selection_follows_the_space_allowlist() {
        let mut opts = RetrievalOptions::default();
        assert!(ExternalCollection::selected(&opts));
        opts.space_ids = Some(Vec::new());
        assert!(!ExternalCollection::selected(&opts));
        opts.space_ids = Some(vec!["space-1".into()]);
        assert!(!ExternalCollection::selected(&opts));
        opts.space_ids = Some(vec!["space-1".into(), SOURCE_ID.into()]);
        assert!(ExternalCollection::selected(&opts));
    }

    #[tokio::test]
    async fn delegate_fuses_the_collection_into_retrieval_and_hides_the_pseudo_id_from_spaces() {
        let (collection, _store) = seeded_collection().await;
        let spaces = ryu_spaces::SpaceStore::open_in_memory().unwrap();
        let retrieval = ryu_rag::RetrievalStore::open_in_memory(64, "test/reranker".into())
            .unwrap()
            .with_space_recall(Arc::new(VectorStoreRecall::new(
                SpacesRecall::new(spaces),
                collection,
            )));
        let opts = RetrievalOptions {
            space_ids: Some(vec![SOURCE_ID.into()]),
            include_memory: false,
            top_k: 3,
            ..RetrievalOptions::default()
        };
        let hits = retrieval
            .retrieve("Rotterdam logistics costs", &opts)
            .await
            .unwrap();
        assert_eq!(
            hits.first().map(|h| h.id.as_str()),
            Some("vector-store:kb:1")
        );
        assert!(hits
            .iter()
            .all(|h| h.space_id.as_deref() == Some(SOURCE_ID)));

        // Not selected: the default agent turn never touches the collection.
        let none = RetrievalOptions {
            space_ids: Some(Vec::new()),
            include_memory: false,
            ..RetrievalOptions::default()
        };
        assert!(retrieval
            .retrieve("Rotterdam", &none)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn a_failed_open_is_not_retried_during_the_cooldown() {
        let settings =
            VectorStoreSettings::from_lookup(VectorStoreProvider::SqliteVec, |_| None).unwrap();
        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&attempts);
        let collection = ExternalCollection::with_opener(
            settings,
            Embedder::Local { dims: 8 },
            Box::new(move |_| {
                counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                anyhow::bail!("connection refused")
            }),
        );
        let opts = RetrievalOptions::default();
        let first = collection.recall("q", &opts, 3).await.unwrap_err();
        assert!(first.to_string().contains("connection refused"), "{first}");
        let second = collection.recall("q", &opts, 3).await.unwrap_err();
        assert!(second.to_string().contains("skipped"), "{second}");
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);

        // Once the cooldown has passed, the next recall tries again.
        *collection.failed_at.lock().unwrap() =
            Some(Instant::now() - FAILURE_COOLDOWN - Duration::from_secs(1));
        assert!(collection.recall("q", &opts, 3).await.is_err());
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn external_ids_never_fuse_with_a_same_id_space_chunk() {
        let (collection, _store) = seeded_collection().await;
        let hits = collection
            .recall("Rotterdam logistics costs", &RetrievalOptions::default(), 5)
            .await
            .unwrap();
        let fused = ryu_rag::fuse_ranked_lists(
            vec![ScoredChunk {
                id: "kb:1".into(),
                source: ChunkSource::Memory,
                space_id: None,
                content: "a different passage".into(),
                score: 0.9,
            }],
            vec![hits],
            10,
        );
        assert_eq!(fused.len(), 3, "{fused:?}");
    }

    #[tokio::test]
    async fn an_unreachable_store_fails_open() {
        let settings =
            VectorStoreSettings::from_lookup(VectorStoreProvider::SqliteVec, |_| None).unwrap();
        let collection = ExternalCollection::with_opener(
            settings,
            Embedder::Local { dims: 8 },
            Box::new(|_| anyhow::bail!("connection refused")),
        );
        let spaces = ryu_spaces::SpaceStore::open_in_memory().unwrap();
        let delegate = VectorStoreRecall::new(SpacesRecall::new(spaces), collection);
        let lists = delegate
            .recall(
                "anything",
                &RetrievalOptions {
                    space_ids: Some(vec![SOURCE_ID.into()]),
                    ..RetrievalOptions::default()
                },
                5,
            )
            .await
            .unwrap();
        assert!(lists.is_empty());
    }
}
