//! Redis / Valkey checkpoint backend (feature `redis`).
//!
//! Layout under the configured key prefix `P` and namespace `N`:
//!
//! - `P:N:rec:<id>` — the record, a JSON string;
//! - `P:N:ids` — a set of the namespace's ids, for `list`.
//!
//! `put` and `delete` update both keys inside one `MULTI`/`EXEC`, so the index
//! never disagrees with the records. Records carry no TTL. Durability is the
//! server's: with the default RDB snapshots a crash can lose recent writes, so
//! run Redis with `appendonly yes` (and `appendfsync everysec` or `always`) when
//! checkpoints must survive a server restart.

use std::sync::Arc;

use ryu_redis_wire::{Cmd, Frame, RedisClient, RedisError};
use serde_json::Value;

use crate::store::{checked_id, CheckpointError, CheckpointStore};
use crate::BoxFuture;

const BACKEND: &str = "redis";

/// Default key prefix.
pub const DEFAULT_PREFIX: &str = "ryu:durable";

/// Validate a key prefix: 1–64 bytes of `[A-Za-z0-9_:.-]`.
pub fn validate_prefix(prefix: &str) -> Result<(), CheckpointError> {
    let ok = !prefix.is_empty()
        && prefix.len() <= 64
        && prefix
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b':' | b'.' | b'-'));
    if ok {
        Ok(())
    } else {
        Err(CheckpointError::Config(format!(
            "redis key prefix must be 1-64 characters of [A-Za-z0-9_:.-]: {prefix:?}"
        )))
    }
}

fn redis_error(error: RedisError) -> CheckpointError {
    CheckpointError::backend(BACKEND, error)
}

/// One namespace of a Redis-backed checkpoint store.
#[derive(Debug, Clone)]
pub struct RedisCheckpointStore {
    client: Arc<RedisClient>,
    prefix: String,
    namespace: String,
}

impl RedisCheckpointStore {
    /// Bind `namespace` under `prefix` on a shared client.
    pub fn new(
        client: Arc<RedisClient>,
        prefix: &str,
        namespace: &str,
    ) -> Result<Self, CheckpointError> {
        validate_prefix(prefix)?;
        checked_id(namespace)?;
        Ok(Self {
            client,
            prefix: prefix.to_owned(),
            namespace: namespace.to_owned(),
        })
    }

    fn record_key(&self, id: &str) -> String {
        format!("{}:{}:rec:{id}", self.prefix, self.namespace)
    }

    fn index_key(&self) -> String {
        format!("{}:{}:ids", self.prefix, self.namespace)
    }
}

impl CheckpointStore for RedisCheckpointStore {
    fn backend(&self) -> &'static str {
        BACKEND
    }

    fn put<'a>(
        &'a self,
        id: &'a str,
        state: &'a Value,
    ) -> BoxFuture<'a, Result<(), CheckpointError>> {
        Box::pin(async move {
            checked_id(id)?;
            let json = serde_json::to_vec(state)
                .map_err(|error| CheckpointError::Serialization(error.to_string()))?;
            self.client
                .transaction(&[
                    Cmd::new("SET").arg(self.record_key(id)).arg(json),
                    Cmd::new("SADD").arg(self.index_key()).arg(id),
                ])
                .await
                .map_err(redis_error)?;
            Ok(())
        })
    }

    fn get<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Value>, CheckpointError>> {
        Box::pin(async move {
            checked_id(id)?;
            let reply = self
                .client
                .query(Cmd::new("GET").arg(self.record_key(id)))
                .await
                .map_err(redis_error)?;
            match reply.into_bytes() {
                Some(bytes) => serde_json::from_slice(&bytes)
                    .map(Some)
                    .map_err(|error| CheckpointError::Serialization(error.to_string())),
                None => Ok(None),
            }
        })
    }

    fn delete<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<bool, CheckpointError>> {
        Box::pin(async move {
            checked_id(id)?;
            let results = self
                .client
                .transaction(&[
                    Cmd::new("DEL").arg(self.record_key(id)),
                    Cmd::new("SREM").arg(self.index_key()).arg(id),
                ])
                .await
                .map_err(redis_error)?;
            Ok(results.first().and_then(Frame::as_integer).unwrap_or(0) > 0)
        })
    }

    fn list(&self) -> BoxFuture<'_, Result<Vec<String>, CheckpointError>> {
        Box::pin(async move {
            let reply = self
                .client
                .query(Cmd::new("SMEMBERS").arg(self.index_key()))
                .await
                .map_err(redis_error)?;
            let mut ids: Vec<String> = reply
                .into_array()
                .into_iter()
                .filter_map(Frame::into_bytes)
                .filter_map(|bytes| String::from_utf8(bytes).ok())
                .collect();
            ids.sort();
            Ok(ids)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_redis_wire::testing::FakeRedis;
    use serde_json::json;

    #[test]
    fn prefixes_are_validated() {
        assert!(validate_prefix("ryu:durable").is_ok());
        assert!(validate_prefix("").is_err());
        assert!(validate_prefix("has space").is_err());
        assert!(validate_prefix("a*").is_err());
    }

    #[tokio::test]
    async fn writes_are_transactional_and_keys_follow_the_layout() {
        let server = FakeRedis::start().await;
        let client = Arc::new(RedisClient::from_url(&server.url()).unwrap());
        let store = RedisCheckpointStore::new(client, "p", "runs").unwrap();
        store.put("run_1", &json!({"n": 1})).await.unwrap();
        assert!(store.delete("run_1").await.unwrap());
        let names = server.command_names();
        assert_eq!(
            names,
            ["SET", "SADD", "DEL", "SREM"],
            "MULTI/EXEC wrap each write; only queued commands reach the store log"
        );
        let first = &server.commands()[0];
        assert_eq!(first[1], b"p:runs:rec:run_1".to_vec());
    }

    #[tokio::test]
    async fn corrupt_records_are_serialization_errors() {
        let server = FakeRedis::start().await;
        let client = Arc::new(RedisClient::from_url(&server.url()).unwrap());
        client
            .query(Cmd::new("SET").arg("p:runs:rec:bad").arg("{not json"))
            .await
            .unwrap();
        let store = RedisCheckpointStore::new(client, "p", "runs").unwrap();
        assert!(matches!(
            store.get("bad").await.unwrap_err(),
            CheckpointError::Serialization(_)
        ));
    }
}
