//! Redis / Valkey backends for the exact and semantic response caches.
//!
//! - [`RedisExactCache`] — `SET <prefix>:exact:<key> <json> PX <ttl>` / `GET`.
//!   Expiry is the server's, so the background sweep is a no-op; size is bounded
//!   by the server's `maxmemory` policy (use `allkeys-lru` or `volatile-lru`).
//! - [`RedisSemanticCache`] — embeddings plus responses per tenant scope, with
//!   two search paths:
//!   - `brute_force` (default, any Redis/Valkey): entries are binary strings
//!     (`[dim u32 LE][f32 LE × dim][response JSON]`) indexed by a per-scope
//!     sorted set of insertion times; a lookup reads the newest
//!     `semantic_scan_limit` entries with one `MGET` and scores them locally.
//!   - `redisearch` (Redis Stack / RediSearch 2.4+): entries are hashes with a
//!     `FLOAT32` vector field in a per-dimension `FLAT … COSINE` index created on
//!     first use, and a lookup is one `FT.SEARCH … KNN 1` filtered by the scope tag.
//!
//!   Both keep the same per-scope sorted set, which caps each scope at
//!   `cache.max_entries` (oldest first) like the in-memory cache.
//!
//! The connection URL is a secret and comes only from [`REDIS_URL_ENV`]. Every
//! backend failure is logged, counted in [`CacheStats`], and served as a miss
//! (or a dropped store): a cache outage never fails a request.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Client;
use ryu_redis_wire::{ClientOptions, Cmd, Frame, RedisClient, RedisError, RedisUrl};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use tracing::{debug, warn};

use crate::exact::{CacheBackend, CacheConfig};
use crate::semantic::{cosine_similarity, embed_text, SemanticCacheBackend, SemanticCacheConfig};
use crate::stats::{CacheStats, CacheStatsSnapshot};
use crate::BoxFuture;

/// Environment variable holding the Redis URL (`redis://…`, `rediss://…`).
pub const REDIS_URL_ENV: &str = "RYU_GATEWAY_REDIS_URL";

/// Registry id the Redis backends register under.
pub const REDIS_BACKEND_ID: &str = "redis";

/// How the Redis semantic cache finds the nearest stored prompt.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticSearch {
    /// Score the newest entries of the scope locally (works on any server).
    #[default]
    BruteForce,
    /// RediSearch `FT.SEARCH` KNN over a vector index (Redis Stack).
    Redisearch,
}

fn default_key_prefix() -> String {
    "ryu:gw".to_owned()
}
fn default_pool_size() -> usize {
    4
}
fn default_connect_timeout_ms() -> u64 {
    1_000
}
fn default_io_timeout_ms() -> u64 {
    250
}
fn default_scan_limit() -> usize {
    1_000
}

/// `[redis_cache]`: settings shared by every Redis-backed Gateway cache. The
/// URL itself is read from [`REDIS_URL_ENV`] so it never lands in
/// `gateway.toml` or the config API.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct RedisCacheConfig {
    /// Prefix for every key the Gateway writes (`[A-Za-z0-9_:.-]`, 1–64 chars).
    #[serde(default = "default_key_prefix")]
    pub key_prefix: String,
    /// Semantic-cache search path.
    #[serde(default)]
    pub semantic_search: SemanticSearch,
    /// Brute-force path: newest entries scored per lookup.
    #[serde(default = "default_scan_limit")]
    pub semantic_scan_limit: usize,
    /// Pooled connections.
    #[serde(default = "default_pool_size")]
    pub pool_size: usize,
    /// Connect (TCP + TLS + AUTH) deadline.
    #[serde(default = "default_connect_timeout_ms")]
    pub connect_timeout_ms: u64,
    /// Per-command deadline. Keep it short: a slow cache is treated as a miss.
    #[serde(default = "default_io_timeout_ms")]
    pub io_timeout_ms: u64,
}

impl Default for RedisCacheConfig {
    fn default() -> Self {
        Self {
            key_prefix: default_key_prefix(),
            semantic_search: SemanticSearch::default(),
            semantic_scan_limit: default_scan_limit(),
            pool_size: default_pool_size(),
            connect_timeout_ms: default_connect_timeout_ms(),
            io_timeout_ms: default_io_timeout_ms(),
        }
    }
}

impl RedisCacheConfig {
    /// Validate the settings (not the URL).
    pub fn validate(&self) -> Result<(), String> {
        let prefix_ok = !self.key_prefix.is_empty()
            && self.key_prefix.len() <= 64
            && self
                .key_prefix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-'));
        if !prefix_ok {
            return Err("redis_cache.key_prefix must be 1-64 characters of [A-Za-z0-9_:.-]".into());
        }
        if self.semantic_scan_limit == 0 {
            return Err("redis_cache.semantic_scan_limit must be at least 1".into());
        }
        Ok(())
    }

    /// Build a (lazily connecting) client for `url` with these settings.
    pub fn client(&self, url: &str) -> Result<Arc<RedisClient>, String> {
        self.validate()?;
        let parsed = RedisUrl::parse(url).map_err(|error| format!("{REDIS_URL_ENV}: {error}"))?;
        Ok(Arc::new(RedisClient::new(
            parsed,
            ClientOptions {
                pool_size: self.pool_size.max(1),
                connect_timeout: Duration::from_millis(self.connect_timeout_ms.max(1)),
                io_timeout: Duration::from_millis(self.io_timeout_ms.max(1)),
            },
        )))
    }
}

/// The Redis URL from the environment, if set and non-empty.
pub fn redis_url_from_env() -> Option<String> {
    std::env::var(REDIS_URL_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

/// Run an async cache call from a sync trait verb. Only possible on a
/// multi-thread Tokio runtime (the Gateway's); elsewhere the call is skipped
/// and the verb behaves as a miss / dropped store. The pipeline uses the async
/// verbs, so this path only serves legacy sync callers.
fn block_on_bridge<F: Future>(future: F) -> Option<F::Output> {
    let handle = tokio::runtime::Handle::try_current().ok()?;
    if handle.runtime_flavor() != tokio::runtime::RuntimeFlavor::MultiThread {
        return None;
    }
    Some(tokio::task::block_in_place(|| handle.block_on(future)))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn ttl_ms(ttl: Duration) -> i64 {
    i64::try_from(ttl.as_millis()).unwrap_or(i64::MAX)
}

fn log_failure(stats: &CacheStats, what: &str, error: &RedisError) {
    stats.error();
    warn!(error = %error, "redis {what} failed; serving as a cache miss");
}

// ─── Exact cache ──────────────────────────────────────────────────────────────

/// Exact-match response cache in Redis.
pub struct RedisExactCache {
    client: Arc<RedisClient>,
    prefix: String,
    ttl: Duration,
    enabled: bool,
    stats: CacheStats,
}

impl RedisExactCache {
    /// Build over a shared client; `config` supplies `enabled` and `ttl_secs`.
    pub fn new(client: Arc<RedisClient>, redis: &RedisCacheConfig, config: &CacheConfig) -> Self {
        Self {
            client,
            prefix: redis.key_prefix.clone(),
            ttl: Duration::from_secs(config.ttl_secs),
            enabled: config.enabled,
            stats: CacheStats::default(),
        }
    }

    fn key(&self, key: &str) -> String {
        format!("{}:exact:{key}", self.prefix)
    }

    async fn fetch(&self, key: &str) -> Option<Value> {
        if !self.enabled || self.ttl.is_zero() {
            return None;
        }
        match self.client.query(Cmd::new("GET").arg(self.key(key))).await {
            Ok(frame) => match frame.into_bytes() {
                Some(bytes) => match serde_json::from_slice(&bytes) {
                    Ok(value) => {
                        self.stats.hit();
                        debug!(key, "redis exact cache hit");
                        Some(value)
                    }
                    Err(_) => {
                        self.stats.error();
                        None
                    }
                },
                None => {
                    self.stats.miss();
                    None
                }
            },
            Err(error) => {
                log_failure(&self.stats, "exact-cache lookup", &error);
                None
            }
        }
    }

    async fn store(&self, key: String, response: Value) {
        // A zero TTL means nothing is ever served, so nothing is written
        // (Redis also rejects `PX 0`).
        if !self.enabled || self.ttl.is_zero() {
            return;
        }
        let Ok(json) = serde_json::to_vec(&response) else {
            self.stats.error();
            return;
        };
        let cmd = Cmd::new("SET")
            .arg(self.key(&key))
            .arg(json)
            .arg("PX")
            .int(ttl_ms(self.ttl));
        match self.client.query(cmd).await {
            Ok(_) => self.stats.stored(1),
            Err(error) => log_failure(&self.stats, "exact-cache store", &error),
        }
    }
}

impl CacheBackend for RedisExactCache {
    fn get(&self, key: &str) -> Option<Value> {
        block_on_bridge(self.fetch(key)).flatten()
    }
    fn insert(&self, key: String, response: Value) {
        let _ = block_on_bridge(self.store(key, response));
    }
    /// Redis expires keys itself.
    fn evict_expired(&self) {}
    fn get_async<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Option<Value>> {
        Box::pin(self.fetch(key))
    }
    fn insert_async(&self, key: String, response: Value) -> BoxFuture<'_, ()> {
        Box::pin(self.store(key, response))
    }
    fn stats(&self) -> Option<CacheStatsSnapshot> {
        Some(self.stats.snapshot(REDIS_BACKEND_ID))
    }
}

// ─── Semantic cache ───────────────────────────────────────────────────────────

/// Encode an embedding as little-endian `f32` bytes.
pub fn vector_bytes(embedding: &[f32]) -> Vec<u8> {
    embedding
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

/// Brute-force entry encoding: `[dim u32 LE][f32 LE × dim][response JSON]`.
pub fn encode_entry(embedding: &[f32], response: &Value) -> Option<Vec<u8>> {
    let dim = u32::try_from(embedding.len()).ok()?;
    let mut out = dim.to_le_bytes().to_vec();
    out.extend(vector_bytes(embedding));
    out.extend(serde_json::to_vec(response).ok()?);
    Some(out)
}

/// Inverse of [`encode_entry`].
pub fn decode_entry(bytes: &[u8]) -> Option<(Vec<f32>, Value)> {
    let dim = u32::from_le_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
    let end = 4usize.checked_add(dim.checked_mul(4)?)?;
    let embedding = bytes
        .get(4..end)?
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect();
    let response = serde_json::from_slice(bytes.get(end..)?).ok()?;
    Some((embedding, response))
}

/// The tag a tenant scope is stored under: a hex SHA-256 (so arbitrary scope
/// strings are key- and RediSearch-tag-safe) with `None` distinct from every
/// `Some`.
pub fn scope_tag(org_id: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-semantic-scope-v1\0");
    match org_id {
        Some(org) => {
            hasher.update([1]);
            hasher.update(org.as_bytes());
        }
        None => hasher.update([0]),
    }
    hex::encode(&hasher.finalize()[..16])
}

/// Semantic (embedding-similarity) response cache in Redis.
pub struct RedisSemanticCache {
    client: Arc<RedisClient>,
    prefix: String,
    config: SemanticCacheConfig,
    ttl: Duration,
    max_entries: usize,
    search: SemanticSearch,
    scan_limit: usize,
    indexes: Mutex<HashSet<usize>>,
    stats: CacheStats,
}

impl RedisSemanticCache {
    /// Build over a shared client. `ttl_secs` / `max_entries` come from `[cache]`
    /// (the same knobs the in-memory semantic cache uses).
    pub fn new(
        client: Arc<RedisClient>,
        redis: &RedisCacheConfig,
        config: SemanticCacheConfig,
        ttl_secs: u64,
        max_entries: usize,
    ) -> Self {
        Self {
            client,
            prefix: redis.key_prefix.clone(),
            config,
            ttl: Duration::from_secs(ttl_secs),
            max_entries: max_entries.max(1),
            search: redis.semantic_search,
            scan_limit: redis.semantic_scan_limit.max(1),
            indexes: Mutex::new(HashSet::new()),
            stats: CacheStats::default(),
        }
    }

    fn index_key(&self, tag: &str) -> String {
        format!("{}:sem:{tag}:idx", self.prefix)
    }

    fn seq_key(&self) -> String {
        format!("{}:sem:seq", self.prefix)
    }

    /// Sorted-set members are `<dim>:<id>`, so an evicted member names its entry key.
    fn entry_key(&self, tag: &str, member: &str) -> String {
        match self.search {
            SemanticSearch::BruteForce => format!("{}:sem:{tag}:e:{member}", self.prefix),
            SemanticSearch::Redisearch => {
                let (dim, id) = member.split_once(':').unwrap_or(("0", member));
                format!("{}:semv:{dim}:{tag}:{id}", self.prefix)
            }
        }
    }

    fn vector_index(&self, dim: usize) -> String {
        format!("{}:semidx:{dim}", self.prefix)
    }

    /// `FT.CREATE` for a dimension's vector index.
    pub fn create_index_cmd(&self, dim: usize) -> Cmd {
        Cmd::new("FT.CREATE")
            .arg(self.vector_index(dim))
            .arg("ON")
            .arg("HASH")
            .arg("PREFIX")
            .arg("1")
            .arg(format!("{}:semv:{dim}:", self.prefix))
            .arg("SCHEMA")
            .arg("scope")
            .arg("TAG")
            .arg("embedding")
            .arg("VECTOR")
            .arg("FLAT")
            .arg("6")
            .arg("TYPE")
            .arg("FLOAT32")
            .arg("DIM")
            .arg(dim.to_string())
            .arg("DISTANCE_METRIC")
            .arg("COSINE")
    }

    /// `FT.SEARCH` for the nearest entry of `tag` to `query`.
    pub fn knn_cmd(&self, tag: &str, query: &[f32]) -> Cmd {
        Cmd::new("FT.SEARCH")
            .arg(self.vector_index(query.len()))
            .arg(format!(
                "(@scope:{{{tag}}})=>[KNN 1 @embedding $vec AS dist]"
            ))
            .arg("PARAMS")
            .arg("2")
            .arg("vec")
            .arg(vector_bytes(query))
            .arg("SORTBY")
            .arg("dist")
            .arg("RETURN")
            .arg("2")
            .arg("response")
            .arg("dist")
            .arg("LIMIT")
            .arg("0")
            .arg("1")
            .arg("DIALECT")
            .arg("2")
    }

    async fn ensure_index(&self, dim: usize) -> Result<(), RedisError> {
        let mut created = self.indexes.lock().await;
        if created.contains(&dim) {
            return Ok(());
        }
        match self.client.query(self.create_index_cmd(dim)).await {
            Ok(_) => {}
            Err(RedisError::Server(message)) if message.contains("already exists") => {}
            Err(error) => return Err(error),
        }
        created.insert(dim);
        Ok(())
    }

    async fn find(&self, org_id: Option<&str>, query: &[f32]) -> Option<Value> {
        if query.is_empty() || self.ttl.is_zero() {
            return None;
        }
        let tag = scope_tag(org_id);
        let outcome = match self.search {
            SemanticSearch::BruteForce => self.find_brute_force(&tag, query).await,
            SemanticSearch::Redisearch => self.find_knn(&tag, query).await,
        };
        match outcome {
            Ok(Some((score, response))) if score >= self.config.similarity_threshold => {
                self.stats.hit();
                debug!(score, "redis semantic cache hit");
                Some(response)
            }
            Ok(_) => {
                self.stats.miss();
                None
            }
            Err(error) => {
                log_failure(&self.stats, "semantic-cache lookup", &error);
                None
            }
        }
    }

    async fn find_brute_force(
        &self,
        tag: &str,
        query: &[f32],
    ) -> Result<Option<(f32, Value)>, RedisError> {
        let index = self.index_key(tag);
        let cutoff = now_ms() - ttl_ms(self.ttl);
        let replies = self
            .client
            .pipeline(&[
                Cmd::new("ZREMRANGEBYSCORE")
                    .arg(&index)
                    .arg("-inf")
                    .arg(format!("({cutoff}")),
                Cmd::new("ZRANGE")
                    .arg(&index)
                    .int(-i64::try_from(self.scan_limit).unwrap_or(i64::MAX))
                    .int(-1),
            ])
            .await?;
        let members: Vec<String> = replies
            .into_iter()
            .nth(1)
            .map(Frame::into_result)
            .transpose()?
            .map(Frame::into_array)
            .unwrap_or_default()
            .into_iter()
            .filter_map(Frame::into_bytes)
            .filter_map(|bytes| String::from_utf8(bytes).ok())
            .collect();
        if members.is_empty() {
            return Ok(None);
        }
        let mut mget = Cmd::new("MGET");
        for member in &members {
            mget = mget.arg(self.entry_key(tag, member));
        }
        let values = self.client.query(mget).await?.into_array();
        let mut best: Option<(f32, Value)> = None;
        let mut stale = Cmd::new("ZREM").arg(&index);
        let mut any_stale = false;
        for (member, value) in members.iter().zip(values) {
            match value.into_bytes().as_deref().and_then(decode_entry) {
                Some((embedding, response)) => {
                    let score = cosine_similarity(query, &embedding);
                    if best.as_ref().is_none_or(|(top, _)| score > *top) {
                        best = Some((score, response));
                    }
                }
                None => {
                    stale = stale.arg(member);
                    any_stale = true;
                }
            }
        }
        if any_stale {
            // Entry expired before its index member; drop the dangling members.
            self.client.query(stale).await?;
        }
        Ok(best)
    }

    async fn find_knn(&self, tag: &str, query: &[f32]) -> Result<Option<(f32, Value)>, RedisError> {
        let reply = match self.client.query(self.knn_cmd(tag, query)).await {
            Ok(reply) => reply,
            // No entry of this dimension was stored yet, or the index was
            // dropped (for example by `FLUSHALL`). Forget it so the next store
            // recreates it instead of writing hashes no index covers.
            Err(RedisError::Server(message))
                if message.to_ascii_lowercase().contains("no such index")
                    || message.to_ascii_lowercase().contains("unknown index") =>
            {
                self.indexes.lock().await.remove(&query.len());
                return Ok(None);
            }
            Err(error) => return Err(error),
        };
        Ok(parse_knn_reply(reply))
    }

    async fn store(&self, org_id: Option<String>, embedding: Vec<f32>, response: Value) {
        if embedding.is_empty() || self.ttl.is_zero() {
            return;
        }
        if let Err(error) = self
            .store_inner(org_id.as_deref(), &embedding, &response)
            .await
        {
            log_failure(&self.stats, "semantic-cache store", &error);
        }
    }

    async fn store_inner(
        &self,
        org_id: Option<&str>,
        embedding: &[f32],
        response: &Value,
    ) -> Result<(), RedisError> {
        let tag = scope_tag(org_id);
        let index = self.index_key(&tag);
        let id = self
            .client
            .query(Cmd::new("INCR").arg(self.seq_key()))
            .await?
            .as_integer()
            .ok_or_else(|| RedisError::Protocol("INCR did not return an integer".into()))?;
        let member = format!("{}:{id}", embedding.len());
        let key = self.entry_key(&tag, &member);
        let ttl = ttl_ms(self.ttl);
        let write = match self.search {
            SemanticSearch::BruteForce => {
                let Some(bytes) = encode_entry(embedding, response) else {
                    return Err(RedisError::Protocol("embedding too large to encode".into()));
                };
                Cmd::new("SET").arg(&key).arg(bytes).arg("PX").int(ttl)
            }
            SemanticSearch::Redisearch => {
                self.ensure_index(embedding.len()).await?;
                let json = serde_json::to_vec(response)
                    .map_err(|error| RedisError::Protocol(error.to_string()))?;
                Cmd::new("HSET")
                    .arg(&key)
                    .arg("scope")
                    .arg(&tag)
                    .arg("embedding")
                    .arg(vector_bytes(embedding))
                    .arg("response")
                    .arg(json)
            }
        };
        let mut batch = vec![write];
        if self.search == SemanticSearch::Redisearch {
            batch.push(Cmd::new("PEXPIRE").arg(&key).int(ttl));
        }
        batch.push(Cmd::new("ZADD").arg(&index).int(now_ms()).arg(&member));
        batch.push(Cmd::new("PEXPIRE").arg(&index).int(ttl));
        batch.push(Cmd::new("ZCARD").arg(&index));
        let results = self.client.transaction(&batch).await?;
        self.stats.stored(1);
        let count = results.last().and_then(Frame::as_integer).unwrap_or(0);
        let max = i64::try_from(self.max_entries).unwrap_or(i64::MAX);
        if count > max {
            let popped = self
                .client
                .query(Cmd::new("ZPOPMIN").arg(&index).int(count - max))
                .await?
                .into_array();
            // ZPOPMIN replies member, score, member, score, …
            let evicted: Vec<String> = popped
                .into_iter()
                .step_by(2)
                .filter_map(Frame::into_bytes)
                .filter_map(|bytes| String::from_utf8(bytes).ok())
                .collect();
            if !evicted.is_empty() {
                let mut del = Cmd::new("DEL");
                for member in &evicted {
                    del = del.arg(self.entry_key(&tag, member));
                }
                self.client.query(del).await?;
                self.stats.evicted(evicted.len() as u64);
            }
        }
        Ok(())
    }
}

/// Parse an `FT.SEARCH … RETURN 2 response dist` reply into
/// `(cosine similarity, response)` for its first document.
pub fn parse_knn_reply(reply: Frame) -> Option<(f32, Value)> {
    // [total, key, [field, value, field, value], …]
    let mut items = reply.into_array().into_iter();
    let total = items.next()?.as_integer()?;
    if total < 1 {
        return None;
    }
    let _key = items.next()?;
    let fields = items.next()?.into_array();
    let mut response = None;
    let mut distance = None;
    for pair in fields.chunks(2) {
        let [name, value] = pair else {
            continue;
        };
        let Some(name) = name.clone().into_bytes() else {
            continue;
        };
        let Some(value) = value.clone().into_bytes() else {
            continue;
        };
        match name.as_slice() {
            b"response" => response = serde_json::from_slice::<Value>(&value).ok(),
            b"dist" => distance = std::str::from_utf8(&value).ok()?.parse::<f32>().ok(),
            _ => {}
        }
    }
    // RediSearch's COSINE distance is 1 − cosine similarity.
    Some((1.0 - distance?, response?))
}

impl SemanticCacheBackend for RedisSemanticCache {
    fn embedding_model(&self) -> &str {
        &self.config.embedding_model
    }
    fn get_embedding<'a>(
        &'a self,
        text: &'a str,
        http: &'a Client,
        base_url: &'a str,
        api_key: &'a str,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Vec<f32>>> + Send + 'a>> {
        Box::pin(embed_text(
            text,
            http,
            base_url,
            api_key,
            &self.config.embedding_model,
        ))
    }
    fn lookup(&self, org_id: Option<&str>, query: &[f32]) -> Option<Value> {
        block_on_bridge(self.find(org_id, query)).flatten()
    }
    fn insert(&self, org_id: Option<String>, embedding: Vec<f32>, response: Value) {
        let _ = block_on_bridge(self.store(org_id, embedding, response));
    }
    /// Redis expires entries itself; lookups prune expired index members.
    fn evict_expired(&self) {}
    fn lookup_async<'a>(
        &'a self,
        org_id: Option<&'a str>,
        query: &'a [f32],
    ) -> BoxFuture<'a, Option<Value>> {
        Box::pin(self.find(org_id, query))
    }
    fn insert_async(
        &self,
        org_id: Option<String>,
        embedding: Vec<f32>,
        response: Value,
    ) -> BoxFuture<'_, ()> {
        Box::pin(self.store(org_id, embedding, response))
    }
    fn stats(&self) -> Option<CacheStatsSnapshot> {
        Some(self.stats.snapshot(REDIS_BACKEND_ID))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_redis_wire::testing::FakeRedis;
    use serde_json::json;

    fn redis_config(search: SemanticSearch) -> RedisCacheConfig {
        RedisCacheConfig {
            key_prefix: "t".into(),
            semantic_search: search,
            ..RedisCacheConfig::default()
        }
    }

    fn semantic(
        server: &FakeRedis,
        search: SemanticSearch,
        max_entries: usize,
    ) -> RedisSemanticCache {
        let redis = redis_config(search);
        RedisSemanticCache::new(
            redis.client(&server.url()).unwrap(),
            &redis,
            SemanticCacheConfig {
                enabled: true,
                similarity_threshold: 0.9,
                embedding_model: "m".into(),
            },
            60,
            max_entries,
        )
    }

    #[test]
    fn config_defaults_and_validation() {
        let config: RedisCacheConfig = serde_json::from_value(json!({})).unwrap();
        assert_eq!(config, RedisCacheConfig::default());
        assert_eq!(config.semantic_search, SemanticSearch::BruteForce);
        let config: RedisCacheConfig =
            serde_json::from_value(json!({"semantic_search": "redisearch"})).unwrap();
        assert_eq!(config.semantic_search, SemanticSearch::Redisearch);
        let bad = RedisCacheConfig {
            key_prefix: "has space".into(),
            ..RedisCacheConfig::default()
        };
        assert!(bad.validate().is_err());
        assert!(RedisCacheConfig::default().client("http://nope").is_err());
    }

    #[test]
    fn entries_round_trip_and_reject_truncation() {
        let response = json!({"choices": [{"message": {"content": "hi"}}]});
        let bytes = encode_entry(&[0.5, -1.0, 3.25], &response).unwrap();
        assert_eq!(
            decode_entry(&bytes),
            Some((vec![0.5, -1.0, 3.25], response))
        );
        assert_eq!(decode_entry(&bytes[..10]), None);
        assert_eq!(decode_entry(&[]), None);
    }

    #[test]
    fn scope_tags_separate_none_and_every_tenant() {
        assert_ne!(scope_tag(None), scope_tag(Some("")));
        assert_ne!(scope_tag(Some("a")), scope_tag(Some("b")));
        assert_eq!(scope_tag(Some("a")), scope_tag(Some("a")));
        assert!(scope_tag(Some("x y{}|"))
            .bytes()
            .all(|b| b.is_ascii_hexdigit()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exact_cache_sets_with_ttl_and_serves_hits() {
        let server = FakeRedis::start().await;
        let redis = redis_config(SemanticSearch::BruteForce);
        let cache = RedisExactCache::new(
            redis.client(&server.url()).unwrap(),
            &redis,
            &CacheConfig {
                enabled: true,
                ttl_secs: 30,
                max_entries: 10,
            },
        );
        assert_eq!(cache.get_async("k").await, None);
        cache.insert_async("k".into(), json!({"a": 1})).await;
        assert_eq!(cache.get_async("k").await, Some(json!({"a": 1})));
        let ttl = server.ttl("t:exact:k").expect("key has a TTL");
        assert!(ttl <= Duration::from_secs(30) && ttl > Duration::from_secs(25));
        // The sync verbs bridge on a multi-thread runtime.
        assert_eq!(CacheBackend::get(&cache, "k"), Some(json!({"a": 1})));
        let stats = cache.stats().unwrap();
        assert_eq!((stats.hits, stats.misses, stats.stores), (2, 1, 1));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exact_cache_disabled_or_zero_ttl_never_touches_redis() {
        let server = FakeRedis::start().await;
        let redis = redis_config(SemanticSearch::BruteForce);
        for config in [
            CacheConfig {
                enabled: false,
                ttl_secs: 30,
                max_entries: 10,
            },
            CacheConfig {
                enabled: true,
                ttl_secs: 0,
                max_entries: 10,
            },
        ] {
            let cache = RedisExactCache::new(redis.client(&server.url()).unwrap(), &redis, &config);
            cache.insert_async("k".into(), json!(1)).await;
            assert_eq!(cache.get_async("k").await, None);
        }
        assert!(server.commands().is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_unreachable_server_is_a_counted_miss_not_a_failure() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("redis://{}", listener.local_addr().unwrap());
        drop(listener);
        let redis = RedisCacheConfig {
            connect_timeout_ms: 200,
            io_timeout_ms: 200,
            ..redis_config(SemanticSearch::BruteForce)
        };
        let cache =
            RedisExactCache::new(redis.client(&url).unwrap(), &redis, &CacheConfig::default());
        cache.insert_async("k".into(), json!(1)).await;
        assert_eq!(cache.get_async("k").await, None);
        assert_eq!(cache.stats().unwrap().errors, 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn brute_force_semantic_hits_within_threshold_and_scope() {
        let server = FakeRedis::start().await;
        let cache = semantic(&server, SemanticSearch::BruteForce, 100);
        let scope = Some("org-a".to_owned());
        cache
            .insert_async(scope.clone(), vec![1.0, 0.0, 0.0], json!("east"))
            .await;
        cache
            .insert_async(scope.clone(), vec![0.0, 1.0, 0.0], json!("north"))
            .await;
        assert_eq!(
            cache.lookup_async(Some("org-a"), &[0.98, 0.05, 0.0]).await,
            Some(json!("east"))
        );
        assert_eq!(
            cache.lookup_async(Some("org-a"), &[0.0, 0.0, 1.0]).await,
            None
        );
        assert_eq!(
            cache.lookup_async(Some("org-b"), &[1.0, 0.0, 0.0]).await,
            None
        );
        assert_eq!(cache.lookup_async(None, &[1.0, 0.0, 0.0]).await, None);
        let stats = cache.stats().unwrap();
        assert_eq!((stats.hits, stats.misses, stats.stores), (1, 3, 2));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn brute_force_caps_each_scope_and_drops_evicted_entries() {
        let server = FakeRedis::start().await;
        let cache = semantic(&server, SemanticSearch::BruteForce, 2);
        for n in 0..3 {
            let angle = n as f32;
            cache
                .insert_async(Some("s".into()), vec![angle.cos(), angle.sin()], json!(n))
                .await;
        }
        // The oldest (n = 0, vector [1, 0]) was evicted with its entry key.
        assert_eq!(cache.lookup_async(Some("s"), &[1.0, 0.0]).await, None);
        assert_eq!(
            cache
                .lookup_async(Some("s"), &[2.0_f32.cos(), 2.0_f32.sin()])
                .await,
            Some(json!(2))
        );
        assert_eq!(cache.stats().unwrap().evictions, 1);
        // index + seq + two live entries
        assert_eq!(server.key_count(), 4);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn brute_force_prunes_members_whose_entry_expired() {
        let server = FakeRedis::start().await;
        let cache = semantic(&server, SemanticSearch::BruteForce, 10);
        cache.insert_async(None, vec![1.0, 0.0], json!("x")).await;
        let tag = scope_tag(None);
        // Simulate the entry key expiring before its index member.
        let client = redis_config(SemanticSearch::BruteForce)
            .client(&server.url())
            .unwrap();
        client
            .query(Cmd::new("DEL").arg(format!("t:sem:{tag}:e:2:1")))
            .await
            .unwrap();
        assert_eq!(cache.lookup_async(None, &[1.0, 0.0]).await, None);
        let zcard = client
            .query(Cmd::new("ZCARD").arg(format!("t:sem:{tag}:idx")))
            .await
            .unwrap();
        assert_eq!(zcard, Frame::Integer(0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn redisearch_path_creates_the_index_once_and_parses_knn_replies() {
        let server = FakeRedis::start().await;
        let tag = scope_tag(Some("org"));
        let expected_tag = tag.clone();
        server.set_handler(Arc::new(move |args: &[Vec<u8>]| {
            let name = String::from_utf8_lossy(&args[0]).to_ascii_uppercase();
            match name.as_str() {
                "FT.CREATE" => Some(Frame::Simple("OK".into())),
                "FT.SEARCH" => {
                    let query = String::from_utf8_lossy(&args[2]).into_owned();
                    assert!(
                        query.contains(&format!("@scope:{{{expected_tag}}}")),
                        "{query}"
                    );
                    assert_eq!(args[6].len(), 8, "two f32 query components");
                    Some(Frame::Array(Some(vec![
                        Frame::Integer(1),
                        Frame::Bulk(Some(b"t:semv:2:x:1".to_vec())),
                        Frame::Array(Some(vec![
                            Frame::Bulk(Some(b"response".to_vec())),
                            Frame::Bulk(Some(b"{\"cached\":true}".to_vec())),
                            Frame::Bulk(Some(b"dist".to_vec())),
                            Frame::Bulk(Some(b"0.02".to_vec())),
                        ])),
                    ])))
                }
                _ => None,
            }
        }));
        let cache = semantic(&server, SemanticSearch::Redisearch, 10);
        cache
            .insert_async(Some("org".into()), vec![1.0, 0.0], json!(1))
            .await;
        cache
            .insert_async(Some("org".into()), vec![0.0, 1.0], json!(2))
            .await;
        let names = server.command_names();
        assert_eq!(names.iter().filter(|n| *n == "FT.CREATE").count(), 1);
        assert!(names.contains(&"HSET".to_owned()));
        let hset = server
            .commands()
            .into_iter()
            .find(|cmd| cmd[0] == b"HSET")
            .unwrap();
        assert_eq!(hset[1], format!("t:semv:2:{tag}:1").into_bytes());
        assert_eq!(
            cache.lookup_async(Some("org"), &[1.0, 0.0]).await,
            Some(json!({"cached": true}))
        );
    }

    #[test]
    fn knn_replies_below_threshold_or_empty_are_misses() {
        assert_eq!(
            parse_knn_reply(Frame::Array(Some(vec![Frame::Integer(0)]))),
            None
        );
        let far = Frame::Array(Some(vec![
            Frame::Integer(1),
            Frame::Bulk(Some(b"k".to_vec())),
            Frame::Array(Some(vec![
                Frame::Bulk(Some(b"dist".to_vec())),
                Frame::Bulk(Some(b"0.5".to_vec())),
                Frame::Bulk(Some(b"response".to_vec())),
                Frame::Bulk(Some(b"\"r\"".to_vec())),
            ])),
        ]));
        let (score, response) = parse_knn_reply(far).unwrap();
        assert!((score - 0.5).abs() < 1e-6);
        assert_eq!(response, json!("r"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn missing_vector_index_is_a_miss() {
        let server = FakeRedis::start().await;
        server.set_handler(Arc::new(|args: &[Vec<u8>]| {
            (args[0] == b"FT.SEARCH").then(|| Frame::Error("t:semidx:3: no such index".into()))
        }));
        let cache = semantic(&server, SemanticSearch::Redisearch, 10);
        assert_eq!(cache.lookup_async(None, &[1.0, 0.0, 0.0]).await, None);
        let stats = cache.stats().unwrap();
        assert_eq!((stats.misses, stats.errors), (1, 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_dropped_vector_index_is_recreated_on_the_next_store() {
        let server = FakeRedis::start().await;
        server.set_handler(Arc::new(|args: &[Vec<u8>]| match args[0].as_slice() {
            b"FT.CREATE" => Some(Frame::Simple("OK".into())),
            b"FT.SEARCH" => Some(Frame::Error("t:semidx:2: no such index".into())),
            _ => None,
        }));
        let cache = semantic(&server, SemanticSearch::Redisearch, 10);
        cache.insert_async(None, vec![1.0, 0.0], json!(1)).await;
        assert_eq!(cache.lookup_async(None, &[1.0, 0.0]).await, None);
        cache.insert_async(None, vec![0.0, 1.0], json!(2)).await;
        let creates = server
            .command_names()
            .iter()
            .filter(|name| *name == "FT.CREATE")
            .count();
        assert_eq!(creates, 2, "the index is recreated after it went missing");
    }
}
