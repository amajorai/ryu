//! Configuration-driven backend selection for [`CheckpointStore`]s.
//!
//! [`CheckpointStoreConfig`] names a backend (`file`, the default; `memory`;
//! `postgres`; `redis`) and its settings. [`CheckpointBackend::open`] builds the
//! shared backend once (one connection pool per process), and
//! [`CheckpointBackend::store`] hands out a store per namespace. The file
//! backend keeps each namespace in the directory the host passes, so the host
//! still owns its data-dir layout; the network backends key by namespace.
//!
//! Connection URLs carry credentials, so they are never serialized: they come
//! from the environment (or a secret store) at runtime and are redacted in
//! every description and error.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::store::{checked_id, CheckpointError, CheckpointStore, MemoryCheckpointStore};
use crate::FileCheckpointStore;

/// Environment variable naming the backend (`file`, `memory`, `postgres`, `redis`).
pub const ENV_BACKEND: &str = "RYU_DURABLE_BACKEND";
/// Environment variable holding the Postgres URL (`postgres://…`).
pub const ENV_POSTGRES_URL: &str = "RYU_DURABLE_POSTGRES_URL";
/// Environment variable overriding the Postgres table.
pub const ENV_POSTGRES_TABLE: &str = "RYU_DURABLE_POSTGRES_TABLE";
/// Environment variable holding the Redis URL (`redis://…` or `rediss://…`).
pub const ENV_REDIS_URL: &str = "RYU_DURABLE_REDIS_URL";
/// Environment variable overriding the Redis key prefix.
pub const ENV_REDIS_PREFIX: &str = "RYU_DURABLE_REDIS_PREFIX";

/// Which checkpoint backend to use.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointBackendKind {
    /// One atomically-written JSON file per record (the default).
    #[default]
    File,
    /// Process memory; nothing survives a restart.
    Memory,
    /// A Postgres table (feature `postgres`).
    Postgres,
    /// A Redis or Valkey server (feature `redis`).
    Redis,
}

impl CheckpointBackendKind {
    /// Parse a backend id, case-insensitively.
    pub fn parse(raw: &str) -> Result<Self, CheckpointError> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "file" => Ok(Self::File),
            "memory" => Ok(Self::Memory),
            "postgres" | "postgresql" => Ok(Self::Postgres),
            "redis" | "valkey" => Ok(Self::Redis),
            other => Err(CheckpointError::Config(format!(
                "unknown checkpoint backend {other:?} (expected file, memory, postgres, or redis)"
            ))),
        }
    }

    /// The stable id.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Memory => "memory",
            Self::Postgres => "postgres",
            Self::Redis => "redis",
        }
    }
}

fn default_table() -> String {
    "ryu_durable_checkpoints".to_owned()
}

fn default_prefix() -> String {
    "ryu:durable".to_owned()
}

/// Backend selection plus per-backend settings.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckpointStoreConfig {
    #[serde(default)]
    pub backend: CheckpointBackendKind,
    /// Postgres connection URL (secret; never serialized).
    #[serde(default, skip_serializing)]
    pub postgres_url: Option<String>,
    /// Postgres table (`table` or `schema.table`).
    #[serde(default = "default_table")]
    pub postgres_table: String,
    /// Redis connection URL (secret; never serialized).
    #[serde(default, skip_serializing)]
    pub redis_url: Option<String>,
    /// Redis key prefix.
    #[serde(default = "default_prefix")]
    pub redis_key_prefix: String,
}

impl Default for CheckpointStoreConfig {
    fn default() -> Self {
        Self {
            backend: CheckpointBackendKind::File,
            postgres_url: None,
            postgres_table: default_table(),
            redis_url: None,
            redis_key_prefix: default_prefix(),
        }
    }
}

impl std::fmt::Debug for CheckpointStoreConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CheckpointStoreConfig")
            .field("backend", &self.backend)
            .field(
                "postgres_url",
                &self.postgres_url.as_ref().map(|_| "<redacted>"),
            )
            .field("postgres_table", &self.postgres_table)
            .field("redis_url", &self.redis_url.as_ref().map(|_| "<redacted>"))
            .field("redis_key_prefix", &self.redis_key_prefix)
            .finish()
    }
}

impl CheckpointStoreConfig {
    /// Read the configuration from the `RYU_DURABLE_*` environment variables.
    /// Unset variables keep their defaults (the file backend).
    pub fn from_env() -> Result<Self, CheckpointError> {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// Read the configuration through `lookup` (the testable form of
    /// [`from_env`](Self::from_env)). Empty values count as unset.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, CheckpointError> {
        let get = |name: &str| lookup(name).filter(|value| !value.trim().is_empty());
        let mut config = Self::default();
        if let Some(backend) = get(ENV_BACKEND) {
            config.backend = CheckpointBackendKind::parse(&backend)?;
        }
        config.postgres_url = get(ENV_POSTGRES_URL);
        if let Some(table) = get(ENV_POSTGRES_TABLE) {
            config.postgres_table = table;
        }
        config.redis_url = get(ENV_REDIS_URL);
        if let Some(prefix) = get(ENV_REDIS_PREFIX) {
            config.redis_key_prefix = prefix;
        }
        Ok(config)
    }
}

#[derive(Debug, Clone)]
enum Inner {
    File,
    Memory(MemoryCheckpointStore),
    #[cfg(feature = "postgres")]
    Postgres(Arc<crate::postgres::PostgresBackend>),
    #[cfg(feature = "redis")]
    Redis {
        client: Arc<ryu_redis_wire::RedisClient>,
        prefix: String,
    },
}

/// A configured backend shared by every namespace. Cheap to clone.
#[derive(Debug, Clone)]
pub struct CheckpointBackend {
    inner: Inner,
}

impl CheckpointBackend {
    /// Build the backend `config` selects. Network backends connect lazily, so
    /// this validates settings but never blocks on (or fails for) an
    /// unreachable server; the first store operation reports that.
    pub fn open(config: &CheckpointStoreConfig) -> Result<Self, CheckpointError> {
        let inner = match config.backend {
            CheckpointBackendKind::File => Inner::File,
            CheckpointBackendKind::Memory => Inner::Memory(MemoryCheckpointStore::new()),
            CheckpointBackendKind::Postgres => Self::postgres(config)?,
            CheckpointBackendKind::Redis => Self::redis(config)?,
        };
        Ok(Self { inner })
    }

    #[cfg(feature = "postgres")]
    fn postgres(config: &CheckpointStoreConfig) -> Result<Inner, CheckpointError> {
        let url = config.postgres_url.as_deref().ok_or_else(|| {
            CheckpointError::Config(format!("the postgres backend needs {ENV_POSTGRES_URL}"))
        })?;
        Ok(Inner::Postgres(Arc::new(
            crate::postgres::PostgresBackend::new(url, &config.postgres_table)?,
        )))
    }

    #[cfg(not(feature = "postgres"))]
    fn postgres(_config: &CheckpointStoreConfig) -> Result<Inner, CheckpointError> {
        Err(CheckpointError::Config(
            "this build of ryu-durable lacks the `postgres` feature".to_owned(),
        ))
    }

    #[cfg(feature = "redis")]
    fn redis(config: &CheckpointStoreConfig) -> Result<Inner, CheckpointError> {
        let url = config.redis_url.as_deref().ok_or_else(|| {
            CheckpointError::Config(format!("the redis backend needs {ENV_REDIS_URL}"))
        })?;
        crate::redis::validate_prefix(&config.redis_key_prefix)?;
        let client = ryu_redis_wire::RedisClient::from_url(url)
            .map_err(|error| CheckpointError::Config(error.to_string()))?;
        Ok(Inner::Redis {
            client: Arc::new(client),
            prefix: config.redis_key_prefix.clone(),
        })
    }

    #[cfg(not(feature = "redis"))]
    fn redis(_config: &CheckpointStoreConfig) -> Result<Inner, CheckpointError> {
        Err(CheckpointError::Config(
            "this build of ryu-durable lacks the `redis` feature".to_owned(),
        ))
    }

    /// The selected backend's id.
    pub fn kind(&self) -> CheckpointBackendKind {
        match &self.inner {
            Inner::File => CheckpointBackendKind::File,
            Inner::Memory(_) => CheckpointBackendKind::Memory,
            #[cfg(feature = "postgres")]
            Inner::Postgres(_) => CheckpointBackendKind::Postgres,
            #[cfg(feature = "redis")]
            Inner::Redis { .. } => CheckpointBackendKind::Redis,
        }
    }

    /// A credential-free description for logs and status pages.
    pub fn describe(&self) -> String {
        match &self.inner {
            Inner::File => "file".to_owned(),
            Inner::Memory(_) => "memory".to_owned(),
            #[cfg(feature = "postgres")]
            Inner::Postgres(backend) => format!("postgres ({})", backend.target()),
            #[cfg(feature = "redis")]
            Inner::Redis { client, prefix } => {
                format!("redis ({}, prefix {prefix})", client.url().redacted())
            }
        }
    }

    /// The store for `namespace`. The file backend stores it in `file_dir`;
    /// the other backends ignore `file_dir` and key by `namespace`.
    pub fn store(
        &self,
        namespace: &str,
        file_dir: &Path,
    ) -> Result<Arc<dyn CheckpointStore>, CheckpointError> {
        checked_id(namespace)?;
        Ok(match &self.inner {
            Inner::File => Arc::new(FileCheckpointStore::new(file_dir)),
            Inner::Memory(memory) => Arc::new(memory.namespace(namespace)?),
            #[cfg(feature = "postgres")]
            Inner::Postgres(backend) => Arc::new(backend.store(namespace)?),
            #[cfg(feature = "redis")]
            Inner::Redis { client, prefix } => Arc::new(crate::redis::RedisCheckpointStore::new(
                Arc::clone(client),
                prefix,
                namespace,
            )?),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn the_default_is_the_file_backend() {
        let config = CheckpointStoreConfig::from_lookup(lookup(&[])).unwrap();
        assert_eq!(config, CheckpointStoreConfig::default());
        let backend = CheckpointBackend::open(&config).unwrap();
        assert_eq!(backend.kind(), CheckpointBackendKind::File);
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(backend.store("runs", dir.path()).unwrap().backend(), "file");
    }

    #[test]
    fn env_selects_and_configures_network_backends() {
        let config = CheckpointStoreConfig::from_lookup(lookup(&[
            (ENV_BACKEND, "Redis"),
            (ENV_REDIS_URL, "redis://:pw@cache:6380/2"),
            (ENV_REDIS_PREFIX, "tenant-a:durable"),
            (ENV_POSTGRES_TABLE, "ops.runs"),
        ]))
        .unwrap();
        assert_eq!(config.backend, CheckpointBackendKind::Redis);
        assert_eq!(config.redis_key_prefix, "tenant-a:durable");
        assert_eq!(config.postgres_table, "ops.runs");
        assert!(!format!("{config:?}").contains("pw"));
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(!serialized.contains("redis://"), "{serialized}");
        let backend = CheckpointBackend::open(&config).unwrap();
        assert_eq!(
            backend.describe(),
            "redis (redis://cache:6380/2, prefix tenant-a:durable)"
        );
    }

    #[test]
    fn misconfiguration_fails_at_open() {
        assert!(CheckpointStoreConfig::from_lookup(lookup(&[(ENV_BACKEND, "sqlite")])).is_err());
        for backend in ["postgres", "redis"] {
            let config =
                CheckpointStoreConfig::from_lookup(lookup(&[(ENV_BACKEND, backend)])).unwrap();
            let error = CheckpointBackend::open(&config).unwrap_err();
            assert!(
                matches!(error, CheckpointError::Config(_)),
                "{backend}: {error}"
            );
        }
        let config = CheckpointStoreConfig {
            backend: CheckpointBackendKind::Redis,
            redis_url: Some("redis://x".into()),
            redis_key_prefix: "bad prefix".into(),
            ..CheckpointStoreConfig::default()
        };
        assert!(CheckpointBackend::open(&config).is_err());
    }

    #[test]
    fn memory_namespaces_share_one_backend() {
        let backend = CheckpointBackend::open(&CheckpointStoreConfig {
            backend: CheckpointBackendKind::Memory,
            ..CheckpointStoreConfig::default()
        })
        .unwrap();
        let dir = Path::new("/unused");
        assert!(backend.store("bad/ns", dir).is_err());
        assert_eq!(backend.store("runs", dir).unwrap().backend(), "memory");
    }
}
