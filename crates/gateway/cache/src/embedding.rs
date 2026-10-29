//! Embedding cache for `/v1/embeddings`.
//!
//! Each input string is cached on its own under a key derived from the
//! request's provider scope (tenant, caller, provider, routed model, provider
//! epoch — see [`CacheScope::semantic_scope`](crate::exact::CacheScope::semantic_scope)),
//! the output-shaping parameters (`dimensions`, `encoding_format`), and a
//! SHA-256 of the normalized input. Normalization trims leading/trailing
//! whitespace and folds `\r\n` / `\r` to `\n`; nothing else (case, inner
//! whitespace, Unicode form) is changed, so distinct texts never share a vector.
//!
//! A request is served from cache only when **every** input hits; otherwise it
//! goes to the provider unchanged and each returned vector is stored, so later
//! single or batched requests reuse them. Requests whose `input` is token
//! arrays, or that carry `user`, are not cached.
//!
//! Two stores implement [`EmbeddingStore`]: [`MemoryEmbeddingStore`] (bounded by
//! entry count and approximate bytes, least-recently-used first, with TTL) and
//! [`RedisEmbeddingStore`] (`SET … PX <ttl>` per vector; size bounded by the
//! server's `maxmemory` policy).

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ryu_redis_wire::{Cmd, Frame, RedisClient};
use serde_json::{json, Value};
use tracing::warn;

use crate::stats::{CacheStats, CacheStatsSnapshot};
use crate::BoxFuture;

mod request;
mod settings;
pub use request::{embedding_key, normalize_input, EmbeddingRequest};
pub use settings::{EmbeddingCacheConfig, MEMORY_BACKEND, REDIS_BACKEND};

// ─── Stores ───────────────────────────────────────────────────────────────────

/// Where cached vectors live. Values are the provider's `embedding` field as
/// returned (a float array, or a base64 string for `encoding_format: base64`).
pub trait EmbeddingStore: Send + Sync {
    /// Store id (`memory`, `redis`).
    fn name(&self) -> &'static str;
    /// Look up `keys`, returning one slot per key in order.
    fn get_many<'a>(
        &'a self,
        keys: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<Option<Value>>, String>>;
    /// Store `entries` (key, vector) with the configured TTL.
    fn put_many(&self, entries: Vec<(String, Value)>) -> BoxFuture<'_, Result<(), String>>;
    /// `(entries, approximate bytes)` currently held, when cheap to know.
    fn size(&self) -> Option<(u64, u64)> {
        None
    }
}

struct Slot {
    value: Value,
    inserted: Instant,
    bytes: usize,
    tick: u64,
}

#[derive(Default)]
struct Lru {
    slots: HashMap<String, Slot>,
    order: BTreeMap<u64, String>,
    bytes: usize,
    tick: u64,
}

impl Lru {
    fn remove(&mut self, key: &str) -> Option<Slot> {
        let slot = self.slots.remove(key)?;
        self.order.remove(&slot.tick);
        self.bytes -= slot.bytes;
        Some(slot)
    }
}

/// In-process LRU store bounded by entry count and approximate bytes.
pub struct MemoryEmbeddingStore {
    ttl: Duration,
    max_entries: usize,
    max_bytes: usize,
    lru: Mutex<Lru>,
    stats: Arc<CacheStats>,
}

impl MemoryEmbeddingStore {
    pub fn new(config: &EmbeddingCacheConfig, stats: Arc<CacheStats>) -> Self {
        Self {
            ttl: Duration::from_secs(config.ttl_secs),
            max_entries: config.max_entries.max(1),
            max_bytes: config.max_bytes.max(1),
            lru: Mutex::new(Lru::default()),
            stats,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Lru> {
        // Every mutation keeps `slots`, `order`, and `bytes` consistent before
        // it can panic, so a poisoned lock still guards a valid map.
        self.lru
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn get_now(&self, keys: &[String]) -> Vec<Option<Value>> {
        let mut lru = self.lock();
        keys.iter()
            .map(|key| {
                let expired = lru.slots.get(key)?.inserted.elapsed() >= self.ttl;
                if expired {
                    lru.remove(key);
                    return None;
                }
                lru.tick += 1;
                let tick = lru.tick;
                let slot = lru.slots.get_mut(key)?;
                let previous = std::mem::replace(&mut slot.tick, tick);
                let value = slot.value.clone();
                lru.order.remove(&previous);
                lru.order.insert(tick, key.clone());
                Some(value)
            })
            .collect()
    }

    fn put_now(&self, entries: Vec<(String, Value)>) {
        let mut lru = self.lock();
        let mut evicted = 0u64;
        for (key, value) in entries {
            let bytes = key.len() + value.to_string().len();
            if bytes > self.max_bytes {
                continue;
            }
            lru.remove(&key);
            lru.tick += 1;
            let tick = lru.tick;
            lru.order.insert(tick, key.clone());
            lru.bytes += bytes;
            lru.slots.insert(
                key,
                Slot {
                    value,
                    inserted: Instant::now(),
                    bytes,
                    tick,
                },
            );
            while lru.slots.len() > self.max_entries || lru.bytes > self.max_bytes {
                let Some((_, oldest)) = lru.order.pop_first() else {
                    break;
                };
                if let Some(slot) = lru.slots.remove(&oldest) {
                    lru.bytes -= slot.bytes;
                    evicted += 1;
                }
            }
        }
        if evicted > 0 {
            self.stats.evicted(evicted);
        }
    }

    /// Drop expired vectors (background sweep).
    pub fn evict_expired(&self) {
        let mut lru = self.lock();
        let expired: Vec<String> = lru
            .slots
            .iter()
            .filter(|(_, slot)| slot.inserted.elapsed() >= self.ttl)
            .map(|(key, _)| key.clone())
            .collect();
        for key in &expired {
            lru.remove(key);
        }
    }
}

impl EmbeddingStore for MemoryEmbeddingStore {
    fn name(&self) -> &'static str {
        MEMORY_BACKEND
    }
    fn get_many<'a>(
        &'a self,
        keys: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<Option<Value>>, String>> {
        Box::pin(std::future::ready(Ok(self.get_now(keys))))
    }
    fn put_many(&self, entries: Vec<(String, Value)>) -> BoxFuture<'_, Result<(), String>> {
        self.put_now(entries);
        Box::pin(std::future::ready(Ok(())))
    }
    fn size(&self) -> Option<(u64, u64)> {
        let lru = self.lock();
        Some((lru.slots.len() as u64, lru.bytes as u64))
    }
}

/// Redis store: `<prefix>:emb:<key>` → vector JSON, `PX <ttl>`.
pub struct RedisEmbeddingStore {
    client: Arc<RedisClient>,
    prefix: String,
    ttl: Duration,
}

impl RedisEmbeddingStore {
    pub fn new(client: Arc<RedisClient>, prefix: &str, config: &EmbeddingCacheConfig) -> Self {
        Self {
            client,
            prefix: prefix.to_owned(),
            ttl: Duration::from_secs(config.ttl_secs),
        }
    }

    fn key(&self, key: &str) -> String {
        format!("{}:emb:{key}", self.prefix)
    }
}

impl EmbeddingStore for RedisEmbeddingStore {
    fn name(&self) -> &'static str {
        REDIS_BACKEND
    }

    fn get_many<'a>(
        &'a self,
        keys: &'a [String],
    ) -> BoxFuture<'a, Result<Vec<Option<Value>>, String>> {
        Box::pin(async move {
            let mut cmd = Cmd::new("MGET");
            for key in keys {
                cmd = cmd.arg(self.key(key));
            }
            let reply = self
                .client
                .query(cmd)
                .await
                .map_err(|error| error.to_string())?;
            let values = reply.into_array();
            if values.len() != keys.len() {
                return Err("MGET returned the wrong number of values".to_owned());
            }
            Ok(values
                .into_iter()
                .map(|value| {
                    value
                        .into_bytes()
                        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                })
                .collect())
        })
    }

    fn put_many(&self, entries: Vec<(String, Value)>) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            let ttl = i64::try_from(self.ttl.as_millis()).unwrap_or(i64::MAX);
            let cmds: Vec<Cmd> = entries
                .iter()
                .map(|(key, value)| {
                    Cmd::new("SET")
                        .arg(self.key(key))
                        .arg(value.to_string())
                        .arg("PX")
                        .int(ttl)
                })
                .collect();
            let replies = self
                .client
                .pipeline(&cmds)
                .await
                .map_err(|error| error.to_string())?;
            match replies
                .into_iter()
                .find(|reply| matches!(reply, Frame::Error(_)))
            {
                Some(Frame::Error(message)) => Err(message),
                _ => Ok(()),
            }
        })
    }
}

// ─── Cache facade ─────────────────────────────────────────────────────────────

/// The embedding cache the Gateway consults on `/v1/embeddings`.
pub struct EmbeddingCache {
    store: Arc<dyn EmbeddingStore>,
    memory: Option<Arc<MemoryEmbeddingStore>>,
    stats: Arc<CacheStats>,
}

impl EmbeddingCache {
    /// Build from config. `Ok(None)` when disabled. The Redis store needs
    /// `redis` (a client and key prefix); the memory store ignores it.
    pub fn from_config(
        config: &EmbeddingCacheConfig,
        redis: Option<(Arc<RedisClient>, &str)>,
    ) -> Result<Option<Self>, String> {
        config.validate()?;
        if !config.enabled {
            return Ok(None);
        }
        let stats = Arc::new(CacheStats::default());
        if config.backend == REDIS_BACKEND {
            let (client, prefix) = redis.ok_or_else(|| {
                format!(
                    "embedding_cache.backend = \"redis\" needs {}",
                    crate::redis::REDIS_URL_ENV
                )
            })?;
            return Ok(Some(Self {
                store: Arc::new(RedisEmbeddingStore::new(client, prefix, config)),
                memory: None,
                stats,
            }));
        }
        let memory = Arc::new(MemoryEmbeddingStore::new(config, Arc::clone(&stats)));
        Ok(Some(Self {
            store: Arc::clone(&memory) as Arc<dyn EmbeddingStore>,
            memory: Some(memory),
            stats,
        }))
    }

    /// Build over any store (tests, plugins).
    pub fn with_store(store: Arc<dyn EmbeddingStore>) -> Self {
        Self {
            store,
            memory: None,
            stats: Arc::new(CacheStats::default()),
        }
    }

    /// Serve the whole request from cache, or `None` (a miss) when any input
    /// is absent or the store fails. The response has the OpenAI list shape with
    /// zero usage, since no provider tokens were spent.
    pub async fn lookup(
        &self,
        scope: &str,
        model: &str,
        request: &EmbeddingRequest,
    ) -> Option<Value> {
        let keys: Vec<String> = request
            .inputs
            .iter()
            .map(|input| embedding_key(scope, request, input))
            .collect();
        let found = match self.store.get_many(&keys).await {
            Ok(found) => found,
            Err(error) => {
                self.stats.error();
                warn!(%error, store = self.store.name(), "embedding cache lookup failed; treating as a miss");
                return None;
            }
        };
        let Some(vectors) = found.into_iter().collect::<Option<Vec<Value>>>() else {
            self.stats.miss();
            return None;
        };
        self.stats.hit();
        let data: Vec<Value> = vectors
            .into_iter()
            .enumerate()
            .map(|(index, embedding)| json!({"object": "embedding", "index": index, "embedding": embedding}))
            .collect();
        Some(json!({
            "object": "list",
            "data": data,
            "model": model,
            "usage": {"prompt_tokens": 0, "total_tokens": 0},
        }))
    }

    /// Store each vector of a successful provider `response` for `request`.
    /// Vectors are matched to inputs by their `index` field; a response that
    /// does not cover every input exactly once stores nothing.
    pub async fn store(&self, scope: &str, request: &EmbeddingRequest, response: &Value) {
        let Some(data) = response.get("data").and_then(Value::as_array) else {
            return;
        };
        if data.len() != request.inputs.len() {
            return;
        }
        let mut slots: Vec<Option<Value>> = vec![None; request.inputs.len()];
        for (position, item) in data.iter().enumerate() {
            let index = item
                .get("index")
                .and_then(Value::as_u64)
                .map_or(Some(position), |index| usize::try_from(index).ok());
            let (Some(index), Some(embedding)) = (index, item.get("embedding")) else {
                return;
            };
            let valid = embedding.is_string()
                || embedding.as_array().is_some_and(|values| {
                    !values.is_empty() && values.iter().all(Value::is_number)
                });
            match slots.get_mut(index) {
                Some(slot @ None) if valid => *slot = Some(embedding.clone()),
                _ => return,
            }
        }
        let entries: Vec<(String, Value)> = request
            .inputs
            .iter()
            .zip(slots)
            .filter_map(|(input, vector)| Some((embedding_key(scope, request, input), vector?)))
            .collect();
        let count = entries.len() as u64;
        match self.store.put_many(entries).await {
            Ok(()) => self.stats.stored(count),
            Err(error) => {
                self.stats.error();
                warn!(%error, store = self.store.name(), "embedding cache store failed");
            }
        }
    }

    /// Background sweep (memory store only; Redis expires keys itself).
    pub fn evict_expired(&self) {
        if let Some(memory) = &self.memory {
            memory.evict_expired();
        }
    }

    /// Counters plus current size when known.
    pub fn stats(&self) -> CacheStatsSnapshot {
        let mut snapshot = self.stats.snapshot(self.store.name());
        if let Some((entries, bytes)) = self.store.size() {
            snapshot.entries = Some(entries);
            snapshot.bytes = Some(bytes);
        }
        snapshot
    }
}

#[cfg(test)]
mod tests;
