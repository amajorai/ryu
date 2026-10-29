//! OpenAI's MCP Events webhook subset for the authenticated Core MCP endpoint.
//!
//! The event source is Ryu's durable conversation run state. Subscriptions are
//! scoped to the exact MCP agent and verified caller, their callback secret and
//! filters are sealed with the node's field cipher, and every callback is DNS
//! screened and pinned by `ryu_egress` before the HTTPS connection is opened.

use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};

use anyhow::{Context, Result};
use base64::Engine as _;
use chrono::{DateTime, SecondsFormat, Utc};
use hmac::{Hmac, Mac};
use rand::RngCore as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;
use url::Url;

use super::{conversations::ConversationStore, conversations::RunStatusEvent};

const EVENT_NAME: &str = "thread.run_status_changed";
const MAX_SUBSCRIPTIONS_TOTAL: usize = 5_000;
const MAX_SUBSCRIPTIONS_PER_OWNER: usize = 100;
const MAX_CALLBACK_URL_BYTES: usize = 2_048;
const MAX_EVENT_BODY_BYTES: usize = 256 * 1024;
const MAX_VERIFICATION_BODY_BYTES: usize = 16 * 1024;
const CALLBACK_VERIFICATION_CACHE_MS: i64 = 15 * 60 * 1000;
const SIGNING_KEY_ROTATION_MS: i64 = 5 * 60 * 1000;
const DEFAULT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const MAX_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const JSONRPC_INVALID_PARAMS: i64 = -32_602;
const CALLBACK_ENDPOINT_ERROR: i64 = -32_015;

type HmacSha256 = Hmac<Sha256>;
type WebhookFuture = Pin<Box<dyn Future<Output = Result<ryu_egress::GuardedResponse>> + Send>>;
type WebhookTransport = dyn Fn(ryu_egress::GuardedRequest) -> WebhookFuture + Send + Sync;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct StoredSubscription {
    agent_id: String,
    callback_url: String,
    event_name: String,
    owner_key: String,
    owner_user_id: Option<String>,
    org_id: Option<String>,
    node_bound: bool,
    #[serde(default)]
    authorization_expires_at: Option<i64>,
    thread_id: String,
    secret: String,
    #[serde(default)]
    previous_secret: Option<String>,
    #[serde(default)]
    previous_secret_until: Option<String>,
    refresh_before: Option<String>,
}

#[derive(Clone)]
struct McpEventStore {
    connection: Arc<Mutex<Connection>>,
    cipher: ryu_crypto::FieldCipher,
}

impl McpEventStore {
    fn open_default() -> Result<Self> {
        let path = crate::paths::db_path("mcp-events.db");
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("creating MCP Events data directory")?;
        }
        Self::open(path, ryu_crypto::global_cipher()?)
    }

    fn open(path: std::path::PathBuf, cipher: ryu_crypto::FieldCipher) -> Result<Self> {
        let connection = Connection::open(&path).context("opening MCP Events database")?;
        connection.busy_timeout(Duration::from_secs(5))?;
        let schema_version =
            connection.query_row("PRAGMA user_version", [], |row| row.get::<_, i32>(0))?;
        if schema_version > 1 {
            anyhow::bail!(
                "MCP Events database schema version {schema_version} is newer than this Core build"
            );
        }
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             CREATE TABLE IF NOT EXISTS mcp_event_subscriptions (
                 id TEXT PRIMARY KEY,
                 agent_id TEXT NOT NULL,
                 owner_key TEXT NOT NULL,
                 thread_key TEXT NOT NULL,
                 refresh_before_ms INTEGER,
                 encrypted_state TEXT NOT NULL,
                 created_at_ms INTEGER NOT NULL,
                 updated_at_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_mcp_event_subscriptions_thread
                 ON mcp_event_subscriptions(thread_key, refresh_before_ms);
             CREATE INDEX IF NOT EXISTS idx_mcp_event_subscriptions_owner
                 ON mcp_event_subscriptions(owner_key, refresh_before_ms);
             CREATE TABLE IF NOT EXISTS mcp_event_callback_verifications (
                 owner_key TEXT NOT NULL,
                 callback_hash TEXT NOT NULL,
                 verified_until_ms INTEGER NOT NULL,
                 PRIMARY KEY(owner_key, callback_hash)
             );
             PRAGMA user_version = 1;",
            )
            .context("migrating MCP Events database")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
                .context("restricting MCP Events database permissions")?;
        }
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            cipher,
        })
    }

    fn get_subscription(&self, id: &str, owner_key: &str) -> Result<Option<StoredSubscription>> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
        let sealed = connection
            .query_row(
                "SELECT encrypted_state FROM mcp_event_subscriptions WHERE id = ?1 AND owner_key = ?2",
                params![id, owner_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading MCP event subscription")?;
        sealed
            .map(|value| {
                let plain = self
                    .cipher
                    .open(&value)
                    .context("opening MCP event subscription")?;
                serde_json::from_str(&plain).context("decoding MCP event subscription")
            })
            .transpose()
    }

    fn upsert_subscription(&self, id: &str, subscription: &StoredSubscription) -> Result<()> {
        let now = Utc::now().timestamp_millis();
        let refresh_before_ms = subscription
            .refresh_before
            .as_deref()
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.timestamp_millis());
        let sealed = self
            .cipher
            .seal(&serde_json::to_string(subscription).context("encoding MCP event subscription")?)
            .context("sealing MCP event subscription")?;
        let thread_key = sha256_hex(subscription.thread_id.as_bytes());
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
        connection
            .execute(
                "INSERT INTO mcp_event_subscriptions
                     (id, agent_id, owner_key, thread_key, refresh_before_ms, encrypted_state, created_at_ms, updated_at_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                     agent_id = excluded.agent_id,
                     owner_key = excluded.owner_key,
                     thread_key = excluded.thread_key,
                     refresh_before_ms = excluded.refresh_before_ms,
                     encrypted_state = excluded.encrypted_state,
                     updated_at_ms = excluded.updated_at_ms",
                params![
                    id,
                    subscription.agent_id,
                    subscription.owner_key,
                    thread_key,
                    refresh_before_ms,
                    sealed,
                    now,
                ],
            )
            .context("saving MCP event subscription")?;
        Ok(())
    }

    fn delete_subscription(&self, id: &str, owner_key: &str) -> Result<()> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
        connection
            .execute(
                "DELETE FROM mcp_event_subscriptions WHERE id = ?1 AND owner_key = ?2",
                params![id, owner_key],
            )
            .context("deleting MCP event subscription")?;
        Ok(())
    }

    fn delete_expired(&self, now_ms: i64) -> Result<()> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
        connection
            .execute(
                "DELETE FROM mcp_event_subscriptions WHERE refresh_before_ms IS NOT NULL AND refresh_before_ms <= ?1",
                [now_ms],
            )
            .context("removing expired MCP event subscriptions")?;
        Ok(())
    }

    fn count_for_owner(&self, owner_key: &str, now_ms: i64) -> Result<usize> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
        let count = connection.query_row(
            "SELECT COUNT(*) FROM mcp_event_subscriptions
             WHERE owner_key = ?1 AND (refresh_before_ms IS NULL OR refresh_before_ms > ?2)",
            params![owner_key, now_ms],
            |row| row.get::<_, i64>(0),
        )?;
        usize::try_from(count).context("invalid MCP Events subscription count")
    }

    fn count_total(&self, now_ms: i64) -> Result<usize> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
        let count = connection.query_row(
            "SELECT COUNT(*) FROM mcp_event_subscriptions
             WHERE refresh_before_ms IS NULL OR refresh_before_ms > ?1",
            [now_ms],
            |row| row.get::<_, i64>(0),
        )?;
        usize::try_from(count).context("invalid MCP Events subscription count")
    }

    fn callback_is_verified(
        &self,
        owner_key: &str,
        callback_hash: &str,
        now_ms: i64,
    ) -> Result<bool> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
        let until = connection
            .query_row(
                "SELECT verified_until_ms FROM mcp_event_callback_verifications
                 WHERE owner_key = ?1 AND callback_hash = ?2",
                params![owner_key, callback_hash],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        Ok(until.is_some_and(|until| until > now_ms))
    }

    fn mark_callback_verified(
        &self,
        owner_key: &str,
        callback_hash: &str,
        now_ms: i64,
    ) -> Result<()> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
        connection.execute(
            "DELETE FROM mcp_event_callback_verifications WHERE verified_until_ms <= ?1",
            [now_ms],
        )?;
        connection.execute(
            "INSERT INTO mcp_event_callback_verifications(owner_key, callback_hash, verified_until_ms)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(owner_key, callback_hash) DO UPDATE SET verified_until_ms = excluded.verified_until_ms",
            params![owner_key, callback_hash, now_ms + CALLBACK_VERIFICATION_CACHE_MS],
        )?;
        Ok(())
    }

    fn subscriptions_for_thread(
        &self,
        thread_id: &str,
        now_ms: i64,
    ) -> Result<Vec<(String, StoredSubscription)>> {
        self.delete_expired(now_ms)?;
        let thread_key = sha256_hex(thread_id.as_bytes());
        let connection = self
            .connection
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
        let mut statement = connection.prepare(
            "SELECT id, encrypted_state FROM mcp_event_subscriptions
             WHERE thread_key = ?1 AND (refresh_before_ms IS NULL OR refresh_before_ms > ?2)
             LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![thread_key, now_ms, MAX_SUBSCRIPTIONS_TOTAL as i64],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        let mut subscriptions = Vec::new();
        for row in rows {
            let (id, sealed) = row?;
            let plain = self
                .cipher
                .open(&sealed)
                .context("opening MCP event subscription")?;
            let subscription =
                serde_json::from_str(&plain).context("decoding MCP event subscription")?;
            subscriptions.push((id, subscription));
        }
        Ok(subscriptions)
    }
}

fn store_slot() -> &'static Mutex<Option<McpEventStore>> {
    static STORE: OnceLock<Mutex<Option<McpEventStore>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(None))
}

fn global_store() -> Result<McpEventStore> {
    let mut slot = store_slot()
        .lock()
        .map_err(|_| anyhow::anyhow!("MCP Events store lock poisoned"))?;
    if let Some(store) = slot.as_ref() {
        return Ok(store.clone());
    }
    let store = McpEventStore::open_default()?;
    *slot = Some(store.clone());
    Ok(store)
}

/// Start the durable subscription delivery loop once Core has opened its
/// conversation store. Missed transitions during downtime are not replayed; the
/// advertised event returns a null cursor to make that behavior explicit.
pub fn start(conversations: ConversationStore) -> Result<()> {
    static STARTED: AtomicBool = AtomicBool::new(false);
    let store = global_store()?;
    if STARTED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let events = super::conversations::subscribe_run_events();
    tokio::spawn(delivery_loop(events, store, conversations));
    Ok(())
}

async fn delivery_loop(
    mut events: tokio::sync::broadcast::Receiver<RunStatusEvent>,
    store: McpEventStore,
    conversations: ConversationStore,
) {
    let permits = Arc::new(Semaphore::new(32));
    loop {
        let event = match events.recv().await {
            Ok(event) => event,
            Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                tracing::warn!(
                    count,
                    "MCP Events delivery loop lagged; null-cursor events may be missed"
                );
                continue;
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        };
        let Some(status) = event.run.run_status.as_deref() else {
            continue;
        };
        let now_ms = Utc::now().timestamp_millis();
        let subscriptions = match store.subscriptions_for_thread(&event.run.id, now_ms) {
            Ok(subscriptions) => subscriptions,
            Err(error) => {
                tracing::warn!(%error, "could not load MCP event subscriptions");
                continue;
            }
        };
        for (id, subscription) in subscriptions {
            if subscription.event_name != EVENT_NAME || subscription.thread_id != event.run.id {
                continue;
            }
            if subscription
                .authorization_expires_at
                .is_some_and(|expires_at| expires_at <= Utc::now().timestamp())
            {
                if let Err(error) = store.delete_subscription(&id, &subscription.owner_key) {
                    tracing::warn!(%error, "could not remove an MCP event subscription after its authorization expired");
                }
                continue;
            }
            let visible = conversations
                .get_run_status_visible(
                    &subscription.thread_id,
                    subscription.owner_user_id.as_deref(),
                    subscription.org_id.as_deref(),
                    subscription.node_bound,
                )
                .await
                .ok()
                .flatten()
                .is_some();
            if !visible {
                if let Err(error) = store.delete_subscription(&id, &subscription.owner_key) {
                    tracing::warn!(%error, "could not remove an MCP event subscription after access revocation");
                }
                continue;
            }
            let Ok(permit) = Arc::clone(&permits).acquire_owned().await else {
                return;
            };
            let event = build_run_event(&event.run.id, status, event.run.updated_at);
            tokio::spawn(async move {
                let _permit = permit;
                if let Err(error) = deliver_with_retry(&id, &subscription, &event).await {
                    tracing::debug!(%error, "MCP event webhook delivery was not accepted");
                }
            });
        }
    }
}

/// HTTP call target used by the protocol router. Returns `None` for unrelated
/// methods so the regular MCP dispatcher can handle them.
pub(crate) async fn handle_http_jsonrpc(
    conversations: &ConversationStore,
    agent_id: &str,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    node_bound: bool,
    authorization_expires_at: Option<i64>,
    thread_events_allowed: bool,
    message: &Value,
) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str)?;
    if !matches!(
        method,
        "events/list" | "events/subscribe" | "events/unsubscribe"
    ) {
        return None;
    }
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    if !message.get("id").is_some_and(|value| !value.is_null()) {
        return None;
    }
    let params = message.get("params").and_then(Value::as_object);
    let Some(meta) = params
        .and_then(|params| params.get("_meta"))
        .and_then(Value::as_object)
    else {
        return Some(rpc_error(
            id,
            JSONRPC_INVALID_PARAMS,
            "events request requires params._meta",
            None,
        ));
    };
    if meta
        .get("io.modelcontextprotocol/protocolVersion")
        .and_then(Value::as_str)
        != Some("2026-07-28")
    {
        return Some(rpc_error(
            id,
            JSONRPC_INVALID_PARAMS,
            "events require protocol version 2026-07-28",
            None,
        ));
    }
    let owner = owner_scope(agent_id, caller, node_bound, authorization_expires_at);
    if method == "events/list" {
        let events = if thread_events_allowed {
            vec![run_event_definition()]
        } else {
            Vec::new()
        };
        return Some(rpc_ok(id, complete_result(json!({ "events": events }))));
    }

    if method == "events/unsubscribe" {
        return Some(match unsubscribe(&owner, agent_id, params) {
            Ok(()) => rpc_ok(id, complete_result(json!({}))),
            Err(error) => rpc_error(id, error.code, error.message, error.data),
        });
    }
    if !thread_events_allowed {
        return Some(rpc_error(
            id,
            JSONRPC_INVALID_PARAMS,
            "this MCP principal is not allowed to subscribe to thread events",
            None,
        ));
    }
    Some(
        match subscribe(conversations, &owner, agent_id, params).await {
            Ok(result) => rpc_ok(id, complete_result(result)),
            Err(error) => rpc_error(id, error.code, error.message, error.data),
        },
    )
}

#[derive(Debug, Clone)]
struct OwnerScope {
    key: String,
    user_id: Option<String>,
    org_id: Option<String>,
    node_bound: bool,
    authorization_expires_at: Option<i64>,
}

fn owner_scope(
    agent_id: &str,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    node_bound: bool,
    authorization_expires_at: Option<i64>,
) -> OwnerScope {
    let user_id = caller.as_ref().map(|caller| caller.user_id.clone());
    let org_id = caller.as_ref().and_then(|caller| caller.org_id.clone());
    let mut bytes = Vec::new();
    for value in [
        agent_id,
        user_id.as_deref().unwrap_or(""),
        org_id.as_deref().unwrap_or(""),
    ] {
        bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes.push(u8::from(node_bound));
    OwnerScope {
        key: sha256_hex(&bytes),
        user_id,
        org_id,
        node_bound,
        authorization_expires_at,
    }
}

fn run_event_definition() -> Value {
    json!({
        "name": EVENT_NAME,
        "description": "The run status changed for the selected thread. The payload contains only the thread ID, status, and event timestamp.",
        "delivery": ["webhook"],
        "inputSchema": {
            "type": "object",
            "properties": {
                "thread_id": {
                    "type": "string",
                    "description": "The exact thread ID to monitor."
                }
            },
            "required": ["thread_id"],
            "additionalProperties": false
        },
        "payloadSchema": {
            "type": "object",
            "properties": {
                "thread_id": { "type": "string" },
                "status": {
                    "type": "string",
                    "enum": ["running", "completed", "failed", "interrupted"]
                }
            },
            "required": ["thread_id", "status"],
            "additionalProperties": false
        }
    })
}

#[derive(Debug)]
struct EventProtocolError {
    code: i64,
    message: String,
    data: Option<Value>,
}

impl EventProtocolError {
    fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            code: JSONRPC_INVALID_PARAMS,
            message: message.into(),
            data: None,
        }
    }

    fn callback(reason: &'static str, message: &'static str) -> Self {
        Self {
            code: CALLBACK_ENDPOINT_ERROR,
            message: message.to_owned(),
            data: Some(json!({ "reason": reason })),
        }
    }
}

fn rpc_ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: impl Into<String>, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message.into() });
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

fn complete_result(mut result: Value) -> Value {
    result["resultType"] = json!("complete");
    result["_meta"] = json!({
        "io.modelcontextprotocol/serverInfo": {
            "name": "ryu-core",
            "version": env!("CARGO_PKG_VERSION"),
        }
    });
    result
}

async fn subscribe(
    conversations: &ConversationStore,
    owner: &OwnerScope,
    agent_id: &str,
    params: Option<&serde_json::Map<String, Value>>,
) -> std::result::Result<Value, EventProtocolError> {
    let store = global_store()
        .map_err(|_| EventProtocolError::invalid_params("event storage is unavailable"))?;
    subscribe_with_store(
        conversations,
        owner,
        agent_id,
        params,
        &store,
        webhook_transport(),
    )
    .await
}

async fn subscribe_with_store(
    conversations: &ConversationStore,
    owner: &OwnerScope,
    agent_id: &str,
    params: Option<&serde_json::Map<String, Value>>,
    store: &McpEventStore,
    transport: Arc<WebhookTransport>,
) -> std::result::Result<Value, EventProtocolError> {
    let params = params
        .ok_or_else(|| EventProtocolError::invalid_params("events/subscribe requires params"))?;
    if params.get("name").and_then(Value::as_str) != Some(EVENT_NAME) {
        return Err(EventProtocolError::invalid_params("unknown event name"));
    }
    let arguments = params
        .get("arguments")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            EventProtocolError::invalid_params("events/subscribe requires an arguments object")
        })?;
    if arguments.len() != 1 {
        return Err(EventProtocolError::invalid_params(
            "run status subscriptions require only thread_id",
        ));
    }
    let thread_id = arguments
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|thread_id| !thread_id.trim().is_empty() && thread_id.len() <= 512)
        .ok_or_else(|| {
            EventProtocolError::invalid_params(
                "thread_id must be a non-empty string of at most 512 bytes",
            )
        })?;
    if owner.node_bound && (owner.user_id.is_none() || owner.authorization_expires_at.is_none()) {
        return Err(EventProtocolError::invalid_params(
            "a verified, expiring user identity is required for thread event subscriptions on a shared node",
        ));
    }
    if params.get("cursor").is_some_and(|cursor| !cursor.is_null()) {
        return Err(EventProtocolError::invalid_params(
            "this event does not support replay cursors",
        ));
    }
    let visible = conversations
        .get_run_status_visible(
            thread_id,
            owner.user_id.as_deref(),
            owner.org_id.as_deref(),
            owner.node_bound,
        )
        .await
        .map_err(|_| EventProtocolError::invalid_params("thread is not available to this caller"))?
        .is_some();
    if !visible {
        return Err(EventProtocolError::invalid_params(
            "thread is not available to this caller",
        ));
    }

    let delivery = params
        .get("delivery")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            EventProtocolError::invalid_params("events/subscribe requires webhook delivery")
        })?;
    if delivery.get("mode").and_then(Value::as_str) != Some("webhook") {
        return Err(EventProtocolError::invalid_params(
            "only webhook delivery is supported",
        ));
    }
    let callback_url = canonical_callback_url(
        delivery
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| EventProtocolError::invalid_params("delivery.url is required"))?,
    )
    .map_err(|_| EventProtocolError::invalid_params("delivery.url must be a public HTTPS URL"))?;
    let supplied_secret = delivery.get("secret").and_then(Value::as_str);
    let id = subscription_id(&owner.key, &callback_url, EVENT_NAME, thread_id);
    let previous = store
        .get_subscription(&id, &owner.key)
        .map_err(|_| EventProtocolError::invalid_params("event storage is unavailable"))?;
    let secret = match supplied_secret {
        Some(secret) => {
            decode_signing_secret(secret).map_err(|_| {
                EventProtocolError::invalid_params(
                    "delivery.secret must be whsec_ followed by a base64 key of 24–64 bytes",
                )
            })?;
            secret.to_owned()
        }
        None => previous
            .as_ref()
            .map(|subscription| subscription.secret.clone())
            .ok_or_else(|| {
                EventProtocolError::invalid_params(
                    "delivery.secret is required for a new subscription",
                )
            })?,
    };
    let secret_bytes = decode_signing_secret(&secret).map_err(|_| {
        EventProtocolError::invalid_params(
            "delivery.secret must be whsec_ followed by a base64 key of 24–64 bytes",
        )
    })?;
    let (previous_secret, previous_secret_until) = match (supplied_secret, previous.as_ref()) {
        (Some(new_secret), Some(old)) if old.secret != new_secret => (
            Some(old.secret.clone()),
            DateTime::from_timestamp_millis(now_millis() + SIGNING_KEY_ROTATION_MS)
                .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true)),
        ),
        (_, Some(old)) => (
            old.previous_secret.clone(),
            old.previous_secret_until.clone(),
        ),
        _ => (None, None),
    };

    let callback_hash = sha256_hex(callback_url.as_bytes());
    let now_ms = Utc::now().timestamp_millis();
    if !store
        .callback_is_verified(&owner.key, &callback_hash, now_ms)
        .map_err(|_| {
            EventProtocolError::callback("verification_failed", "Callback verification failed")
        })?
    {
        verify_callback_with_transport(&callback_url, &id, &secret_bytes, Arc::clone(&transport))
            .await
            .map_err(|error| error)?;
        store
            .mark_callback_verified(&owner.key, &callback_hash, now_ms)
            .map_err(|_| {
                EventProtocolError::callback("verification_failed", "Callback verification failed")
            })?;
    }

    let refresh_before =
        granted_refresh_before(params.get("ttlMs"), owner.authorization_expires_at)?;
    let count = store
        .count_for_owner(&owner.key, now_ms)
        .map_err(|_| EventProtocolError::invalid_params("event storage is unavailable"))?;
    if previous.is_none() && count >= MAX_SUBSCRIPTIONS_PER_OWNER {
        return Err(EventProtocolError::invalid_params(
            "this MCP principal has reached its subscription limit",
        ));
    }
    let total_count = store
        .count_total(now_ms)
        .map_err(|_| EventProtocolError::invalid_params("event storage is unavailable"))?;
    if previous.is_none() && total_count >= MAX_SUBSCRIPTIONS_TOTAL {
        return Err(EventProtocolError::invalid_params(
            "the node has reached its MCP event subscription limit",
        ));
    }
    let subscription = StoredSubscription {
        agent_id: agent_id.to_owned(),
        callback_url,
        event_name: EVENT_NAME.to_owned(),
        owner_key: owner.key.clone(),
        owner_user_id: owner.user_id.clone(),
        org_id: owner.org_id.clone(),
        node_bound: owner.node_bound,
        authorization_expires_at: owner.authorization_expires_at,
        thread_id: thread_id.to_owned(),
        secret,
        previous_secret,
        previous_secret_until,
        refresh_before: refresh_before
            .map(|value| value.to_rfc3339_opts(SecondsFormat::Millis, true)),
    };
    store
        .upsert_subscription(&id, &subscription)
        .map_err(|_| EventProtocolError::invalid_params("event storage is unavailable"))?;
    Ok(json!({
        "id": id,
        "refreshBefore": subscription.refresh_before,
        "cursor": null,
        "truncated": false,
    }))
}

fn unsubscribe(
    owner: &OwnerScope,
    agent_id: &str,
    params: Option<&serde_json::Map<String, Value>>,
) -> std::result::Result<(), EventProtocolError> {
    let store = global_store()
        .map_err(|_| EventProtocolError::invalid_params("event storage is unavailable"))?;
    unsubscribe_with_store(owner, agent_id, params, &store)
}

fn unsubscribe_with_store(
    owner: &OwnerScope,
    agent_id: &str,
    params: Option<&serde_json::Map<String, Value>>,
    store: &McpEventStore,
) -> std::result::Result<(), EventProtocolError> {
    let params = params
        .ok_or_else(|| EventProtocolError::invalid_params("events/unsubscribe requires params"))?;
    if params.get("name").and_then(Value::as_str) != Some(EVENT_NAME) {
        return Err(EventProtocolError::invalid_params("unknown event name"));
    }
    let arguments = params
        .get("arguments")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            EventProtocolError::invalid_params("events/unsubscribe requires arguments")
        })?;
    let thread_id = arguments
        .get("thread_id")
        .and_then(Value::as_str)
        .filter(|thread_id| !thread_id.trim().is_empty() && thread_id.len() <= 512)
        .ok_or_else(|| EventProtocolError::invalid_params("thread_id is invalid"))?;
    let delivery = params
        .get("delivery")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            EventProtocolError::invalid_params("events/unsubscribe requires delivery")
        })?;
    let callback_url = canonical_callback_url(
        delivery
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| EventProtocolError::invalid_params("delivery.url is required"))?,
    )
    .map_err(|_| EventProtocolError::invalid_params("delivery.url is invalid"))?;
    let id = subscription_id(&owner.key, &callback_url, EVENT_NAME, thread_id);
    // Include agent_id in the identity check so a host cannot remove another
    // agent's subscription even when user and callback URL are shared.
    if store
        .get_subscription(&id, &owner.key)
        .map_err(|_| EventProtocolError::invalid_params("event storage is unavailable"))?
        .is_some_and(|subscription| subscription.agent_id == agent_id)
    {
        store
            .delete_subscription(&id, &owner.key)
            .map_err(|_| EventProtocolError::invalid_params("event storage is unavailable"))?;
    }
    Ok(())
}

fn granted_refresh_before(
    requested: Option<&Value>,
    authorization_expires_at: Option<i64>,
) -> std::result::Result<Option<DateTime<Utc>>, EventProtocolError> {
    let requested_deadline = match requested {
        Some(Value::Null) => Ok(None),
        Some(value) => {
            let ttl_ms = value.as_u64().filter(|ttl| *ttl > 0).ok_or_else(|| {
                EventProtocolError::invalid_params("ttlMs must be a positive integer or null")
            })?;
            let granted_ms = ttl_ms.min(MAX_TTL_MS as u64) as i64;
            Ok(DateTime::from_timestamp_millis(
                Utc::now().timestamp_millis() + granted_ms,
            ))
        }
        None => Ok(DateTime::from_timestamp_millis(
            Utc::now().timestamp_millis() + DEFAULT_TTL_MS,
        )),
    }?;
    let authorization_deadline = authorization_expires_at
        .and_then(|expires_at| DateTime::from_timestamp(expires_at.saturating_sub(1), 0));
    let refresh_before = match (requested_deadline, authorization_deadline) {
        (Some(requested), Some(authorization)) => Some(requested.min(authorization)),
        (Some(requested), None) => Some(requested),
        (None, Some(authorization)) => Some(authorization),
        (None, None) => None,
    };
    if refresh_before.is_some_and(|deadline| deadline <= Utc::now()) {
        return Err(EventProtocolError::invalid_params(
            "the caller credential expires too soon to create a subscription",
        ));
    }
    Ok(refresh_before)
}

fn canonical_callback_url(input: &str) -> Result<String> {
    if input.len() > MAX_CALLBACK_URL_BYTES {
        anyhow::bail!("callback URL is too long");
    }
    let url = Url::parse(input.trim()).context("invalid callback URL")?;
    let host = url.host_str().context("callback URL has no host")?;
    let literal_ip_blocked = host
        .parse::<std::net::IpAddr>()
        .is_ok_and(ryu_egress::is_blocked_ip);
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || ryu_egress::is_blocked_hostname(host)
        || literal_ip_blocked
    {
        anyhow::bail!("callback URL must be public HTTPS without credentials or fragments");
    }
    Ok(url.to_string())
}

fn decode_signing_secret(secret: &str) -> Result<Vec<u8>> {
    let encoded = secret
        .strip_prefix("whsec_")
        .context("signing secret must use the whsec_ prefix")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(encoded))
        .context("signing secret is not base64")?;
    if !(24..=64).contains(&bytes.len()) {
        anyhow::bail!("signing secret must decode to 24–64 bytes");
    }
    Ok(bytes)
}

fn subscription_id(
    owner_key: &str,
    callback_url: &str,
    event_name: &str,
    thread_id: &str,
) -> String {
    let mut bytes = Vec::new();
    for value in [owner_key, callback_url, event_name, thread_id] {
        bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    format!("sub_{}", &sha256_hex(&bytes)[..32])
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

fn build_run_event(thread_id: &str, status: &str, updated_at_ms: i64) -> Value {
    let timestamp = DateTime::from_timestamp_millis(updated_at_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let event_id = format!(
        "evt_{}",
        &sha256_hex(format!("{thread_id}\0{status}\0{updated_at_ms}").as_bytes())[..32]
    );
    json!({
        "eventId": event_id,
        "name": EVENT_NAME,
        "timestamp": timestamp,
        "data": { "thread_id": thread_id, "status": status },
        "cursor": null,
    })
}

fn standard_webhook_signature(
    secret: &[u8],
    message_id: &str,
    timestamp: &str,
    body: &[u8],
) -> Result<String> {
    let mut signer = HmacSha256::new_from_slice(secret).context("initializing webhook signer")?;
    signer.update(message_id.as_bytes());
    signer.update(b".");
    signer.update(timestamp.as_bytes());
    signer.update(b".");
    signer.update(body);
    Ok(format!(
        "v1,{}",
        base64::engine::general_purpose::STANDARD.encode(signer.finalize().into_bytes())
    ))
}

fn guarded_webhook_request(request: ryu_egress::GuardedRequest) -> WebhookFuture {
    Box::pin(async move {
        let max_body_bytes = request
            .body
            .as_ref()
            .map_or(MAX_VERIFICATION_BODY_BYTES as u64, |body| body.len() as u64)
            .max(MAX_VERIFICATION_BODY_BYTES as u64);
        let response = ryu_egress::guarded_request(
            request,
            ryu_egress::GuardedFetchPolicy {
                allow_http: false,
                max_body_bytes,
                max_redirect_hops: 0,
                timeout: Duration::from_secs(10),
            },
        )
        .await
        .map_err(anyhow::Error::msg)?;
        Ok(response)
    })
}

fn webhook_transport() -> Arc<WebhookTransport> {
    static TRANSPORT: OnceLock<Arc<WebhookTransport>> = OnceLock::new();
    Arc::clone(TRANSPORT.get_or_init(|| Arc::new(guarded_webhook_request)))
}

fn signed_request(
    callback_url: &str,
    subscription_id: &str,
    secrets: &[&[u8]],
    webhook_id: &str,
    body: Vec<u8>,
) -> Result<ryu_egress::GuardedRequest> {
    let timestamp = Utc::now().timestamp().to_string();
    let signatures = secrets
        .iter()
        .map(|secret| standard_webhook_signature(secret, webhook_id, &timestamp, &body))
        .collect::<Result<Vec<_>>>()?
        .join(" ");
    Ok(ryu_egress::GuardedRequest {
        method: "POST".to_owned(),
        url: callback_url.to_owned(),
        headers: vec![
            ("Content-Type".to_owned(), "application/json".to_owned()),
            ("webhook-id".to_owned(), webhook_id.to_owned()),
            ("webhook-timestamp".to_owned(), timestamp),
            ("webhook-signature".to_owned(), signatures),
            (
                "X-MCP-Subscription-Id".to_owned(),
                subscription_id.to_owned(),
            ),
        ],
        body: Some(body),
    })
}

async fn verify_callback(
    callback_url: &str,
    subscription_id: &str,
    secret: &[u8],
) -> std::result::Result<(), EventProtocolError> {
    verify_callback_with_transport(callback_url, subscription_id, secret, webhook_transport()).await
}

async fn verify_callback_with_transport(
    callback_url: &str,
    subscription_id: &str,
    secret: &[u8],
    transport: Arc<WebhookTransport>,
) -> std::result::Result<(), EventProtocolError> {
    let mut challenge_bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut challenge_bytes);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(challenge_bytes);
    let body = serde_json::to_vec(&json!({ "type": "verification", "challenge": challenge }))
        .map_err(|_| {
            EventProtocolError::callback("verification_failed", "Callback verification failed")
        })?;
    let webhook_id = format!("msg_verification_{}", uuid::Uuid::new_v4());
    let request = signed_request(callback_url, subscription_id, &[secret], &webhook_id, body)
        .map_err(|_| {
            EventProtocolError::callback("verification_failed", "Callback verification failed")
        })?;
    let response = transport(request)
        .await
        .map_err(|_| EventProtocolError::callback("timeout", "Callback verification failed"))?;
    if !(200..300).contains(&response.status) {
        return Err(EventProtocolError::callback(
            "challenge_failed",
            "Callback verification failed",
        ));
    }
    let echoed: Value = serde_json::from_slice(&response.body).map_err(|_| {
        EventProtocolError::callback("challenge_failed", "Callback verification failed")
    })?;
    let returned = echoed
        .get("challenge")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !super::ct_eq(returned, &challenge) {
        return Err(EventProtocolError::callback(
            "challenge_failed",
            "Callback verification failed",
        ));
    }
    Ok(())
}

async fn deliver_with_retry(
    subscription_id: &str,
    subscription: &StoredSubscription,
    event: &Value,
) -> Result<()> {
    deliver_with_transport(subscription_id, subscription, event, webhook_transport()).await
}

async fn deliver_with_transport(
    subscription_id: &str,
    subscription: &StoredSubscription,
    event: &Value,
    transport: Arc<WebhookTransport>,
) -> Result<()> {
    let secret = decode_signing_secret(&subscription.secret)?;
    let previous_secret = subscription
        .previous_secret
        .as_deref()
        .zip(subscription.previous_secret_until.as_deref())
        .and_then(|(secret, until)| {
            DateTime::parse_from_rfc3339(until)
                .ok()
                .filter(|until| until.timestamp_millis() > Utc::now().timestamp_millis())
                .and_then(|_| decode_signing_secret(secret).ok())
        });
    let webhook_id = event
        .get("eventId")
        .and_then(Value::as_str)
        .context("MCP event is missing eventId")?;
    let body = serde_json::to_vec(event).context("encoding MCP event webhook")?;
    if body.len() > MAX_EVENT_BODY_BYTES {
        anyhow::bail!("MCP event webhook exceeds {MAX_EVENT_BODY_BYTES} bytes");
    }
    for attempt in 0..3 {
        let mut keys = vec![secret.as_slice()];
        if let Some(previous_secret) = previous_secret.as_deref() {
            keys.push(previous_secret);
        }
        let request = signed_request(
            &subscription.callback_url,
            subscription_id,
            &keys,
            webhook_id,
            body.clone(),
        )?;
        let response = transport(request).await?;
        if (200..300).contains(&response.status) {
            return Ok(());
        }
        if response.status == 410 || response.status == 413 {
            anyhow::bail!(
                "MCP event receiver returned non-retryable HTTP {}",
                response.status
            );
        }
        let transient = response.status == 408
            || response.status == 425
            || response.status == 429
            || response.status >= 500;
        if !transient || attempt == 2 {
            anyhow::bail!("MCP event receiver returned HTTP {}", response.status);
        }
        tokio::time::sleep(Duration::from_millis(250 * (1 << attempt))).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::conversations::Tenancy;
    use std::sync::atomic::AtomicUsize;

    fn test_cipher() -> ryu_crypto::FieldCipher {
        ryu_crypto::FieldCipher::new(&[19; 32])
    }

    #[test]
    fn callback_urls_require_public_https_without_userinfo_or_fragments() {
        assert!(canonical_callback_url("https://receiver.example/events").is_ok());
        for invalid in [
            "http://receiver.example/events",
            "https://localhost/events",
            "https://127.0.0.1/events",
            "https://user:pass@receiver.example/events",
            "https://receiver.example/events#fragment",
            "https://metadata.google.internal/events",
        ] {
            assert!(
                canonical_callback_url(invalid).is_err(),
                "accepted {invalid}"
            );
        }
    }

    #[test]
    fn signing_secret_requires_prefix_base64_and_bounded_entropy() {
        let encoded = base64::engine::general_purpose::STANDARD.encode([4; 32]);
        assert_eq!(
            decode_signing_secret(&format!("whsec_{encoded}")).unwrap(),
            vec![4; 32]
        );
        assert!(decode_signing_secret(&encoded).is_err());
        let short = base64::engine::general_purpose::STANDARD.encode([4; 12]);
        assert!(decode_signing_secret(&format!("whsec_{short}")).is_err());
    }

    #[test]
    fn standard_webhook_signature_covers_id_timestamp_and_exact_body_bytes() {
        let key = [6; 32];
        let body = br#"{"eventId":"evt_1"}"#;
        let first = standard_webhook_signature(&key, "evt_1", "123", body).unwrap();
        assert_eq!(
            first,
            standard_webhook_signature(&key, "evt_1", "123", body).unwrap()
        );
        assert_ne!(
            first,
            standard_webhook_signature(&key, "evt_2", "123", body).unwrap()
        );
        assert_ne!(
            first,
            standard_webhook_signature(&key, "evt_1", "124", body).unwrap()
        );
        assert_ne!(
            first,
            standard_webhook_signature(&key, "evt_1", "123", br#"{"eventId":"evt_1"} "#).unwrap()
        );
    }

    #[test]
    fn subscription_storage_seals_callback_and_signing_secret_and_refreshes_idempotently() {
        let path = std::env::temp_dir().join(format!("ryu-mcp-events-{}.db", uuid::Uuid::new_v4()));
        let store = McpEventStore::open(path.clone(), test_cipher()).unwrap();
        let secret = format!(
            "whsec_{}",
            base64::engine::general_purpose::STANDARD.encode([9; 32])
        );
        let subscription = StoredSubscription {
            agent_id: "agent".into(),
            callback_url: "https://receiver.example/events".into(),
            event_name: EVENT_NAME.into(),
            owner_key: "owner-hash".into(),
            owner_user_id: Some("alice".into()),
            org_id: Some("org".into()),
            node_bound: true,
            authorization_expires_at: None,
            thread_id: "thread-1".into(),
            secret: secret.clone(),
            previous_secret: None,
            previous_secret_until: None,
            refresh_before: None,
        };
        let id = subscription_id(
            "owner-hash",
            &subscription.callback_url,
            EVENT_NAME,
            "thread-1",
        );
        store.upsert_subscription(&id, &subscription).unwrap();
        let raw_state: String = Connection::open(&path)
            .unwrap()
            .query_row(
                "SELECT encrypted_state FROM mcp_event_subscriptions WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!raw_state.contains(&secret));
        assert!(!raw_state.contains("receiver.example"));
        assert_eq!(
            store.get_subscription(&id, "owner-hash").unwrap(),
            Some(subscription.clone())
        );
        let mut rotated = subscription;
        rotated.secret = format!(
            "whsec_{}",
            base64::engine::general_purpose::STANDARD.encode([8; 32])
        );
        store.upsert_subscription(&id, &rotated).unwrap();
        assert_eq!(
            store.get_subscription(&id, "owner-hash").unwrap(),
            Some(rotated)
        );
        store.delete_subscription(&id, "owner-hash").unwrap();
        assert!(store.get_subscription(&id, "owner-hash").unwrap().is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn run_events_are_bounded_and_use_a_stable_id_for_retries() {
        let first = build_run_event("thread", "completed", 1_797_000_000_000);
        let retry = build_run_event("thread", "completed", 1_797_000_000_000);
        assert_eq!(first["eventId"], retry["eventId"]);
        assert_eq!(first["data"]["thread_id"], json!("thread"));
        assert_eq!(first["data"]["status"], json!("completed"));
        assert!(first["timestamp"].as_str().unwrap().ends_with('Z'));
        assert!(first.to_string().len() < MAX_EVENT_BODY_BYTES);
    }

    #[tokio::test]
    async fn subscription_verifies_callback_persists_idempotently_and_unsubscribes() {
        let path = std::env::temp_dir().join(format!("ryu-mcp-events-{}.db", uuid::Uuid::new_v4()));
        let store = McpEventStore::open(path.clone(), test_cipher()).unwrap();
        let conversations = ConversationStore::open_in_memory().unwrap();
        conversations
            .ensure_conversation(
                "thread-1",
                Some("ryu"),
                Some("Build run"),
                Tenancy::Owned {
                    user_id: "alice".to_owned(),
                    org_id: Some("org-1".to_owned()),
                },
            )
            .await
            .unwrap();
        let owner = OwnerScope {
            key: "owner-hash".to_owned(),
            user_id: Some("alice".to_owned()),
            org_id: Some("org-1".to_owned()),
            node_bound: true,
            authorization_expires_at: Some(Utc::now().timestamp() + 3_600),
        };
        let secret = format!(
            "whsec_{}",
            base64::engine::general_purpose::STANDARD.encode([7; 32])
        );
        let request = json!({
            "name": EVENT_NAME,
            "arguments": { "thread_id": "thread-1" },
            "delivery": {
                "mode": "webhook",
                "url": "https://receiver.example/mcp-events",
                "secret": secret,
            },
            "ttlMs": 60_000,
            "cursor": null,
        });
        let received = Arc::new(Mutex::new(Vec::<ryu_egress::GuardedRequest>::new()));
        let received_for_transport = Arc::clone(&received);
        let transport: Arc<WebhookTransport> = Arc::new(move |request| {
            let received = Arc::clone(&received_for_transport);
            Box::pin(async move {
                let body = request.body.clone().unwrap_or_default();
                let parsed: Value = serde_json::from_slice(&body)?;
                let response = json!({ "challenge": parsed["challenge"] });
                received.lock().unwrap().push(request);
                Ok(ryu_egress::GuardedResponse {
                    status: 200,
                    headers: Vec::new(),
                    body: serde_json::to_vec(&response)?,
                })
            })
        });
        let first = subscribe_with_store(
            &conversations,
            &owner,
            "ryu",
            request.as_object(),
            &store,
            Arc::clone(&transport),
        )
        .await
        .unwrap();
        let id = first["id"].as_str().unwrap().to_owned();
        assert!(first["refreshBefore"].as_str().is_some());
        assert_eq!(first["cursor"], Value::Null);
        assert_eq!(first["truncated"], json!(false));
        assert_eq!(
            received.lock().unwrap().len(),
            1,
            "one verification request"
        );

        let stored = store.get_subscription(&id, &owner.key).unwrap().unwrap();
        assert_eq!(stored.thread_id, "thread-1");
        assert!(stored.refresh_before.is_some());
        let sealed: String = store
            .connection
            .lock()
            .unwrap()
            .query_row(
                "SELECT encrypted_state FROM mcp_event_subscriptions WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!sealed.contains(&secret));
        assert!(!sealed.contains("receiver.example"));

        // Repeating the same request refreshes the same durable row. The short
        // callback verification cache prevents a second challenge POST.
        let refreshed = subscribe_with_store(
            &conversations,
            &owner,
            "ryu",
            request.as_object(),
            &store,
            Arc::clone(&transport),
        )
        .await
        .unwrap();
        assert_eq!(refreshed["id"], json!(id));
        assert_eq!(received.lock().unwrap().len(), 1);
        assert_eq!(store.count_for_owner(&owner.key, now_millis()).unwrap(), 1);

        let unsubscribe_request = json!({
            "name": EVENT_NAME,
            "arguments": { "thread_id": "thread-1" },
            "delivery": { "mode": "webhook", "url": "https://receiver.example/mcp-events" },
        });
        unsubscribe_with_store(&owner, "ryu", unsubscribe_request.as_object(), &store).unwrap();
        unsubscribe_with_store(&owner, "ryu", unsubscribe_request.as_object(), &store).unwrap();
        assert!(store.get_subscription(&id, &owner.key).unwrap().is_none());
        drop(store);
        let _ = std::fs::remove_file(path);
    }

    #[tokio::test]
    async fn delivery_retry_keeps_event_id_and_exact_body_but_resigns_timestamp() {
        let subscription = StoredSubscription {
            agent_id: "ryu".to_owned(),
            callback_url: "https://receiver.example/mcp-events".to_owned(),
            event_name: EVENT_NAME.to_owned(),
            owner_key: "owner-hash".to_owned(),
            owner_user_id: Some("alice".to_owned()),
            org_id: Some("org-1".to_owned()),
            node_bound: true,
            authorization_expires_at: None,
            thread_id: "thread-1".to_owned(),
            secret: format!(
                "whsec_{}",
                base64::engine::general_purpose::STANDARD.encode([5; 32])
            ),
            previous_secret: None,
            previous_secret_until: None,
            refresh_before: None,
        };
        let attempts = Arc::new(AtomicUsize::new(0));
        let requests = Arc::new(Mutex::new(Vec::<ryu_egress::GuardedRequest>::new()));
        let attempts_for_transport = Arc::clone(&attempts);
        let requests_for_transport = Arc::clone(&requests);
        let transport: Arc<WebhookTransport> = Arc::new(move |request| {
            let attempt = attempts_for_transport.fetch_add(1, Ordering::SeqCst);
            let requests = Arc::clone(&requests_for_transport);
            Box::pin(async move {
                // Webhook timestamps have whole-second precision. Let the
                // first delivery cross that boundary before checking a retry.
                if attempt == 0 {
                    tokio::time::sleep(Duration::from_millis(1100)).await;
                }
                requests.lock().unwrap().push(request);
                Ok(ryu_egress::GuardedResponse {
                    status: if attempt == 0 { 503 } else { 200 },
                    headers: Vec::new(),
                    body: Vec::new(),
                })
            })
        });
        let event = build_run_event("thread-1", "completed", 1_797_000_000_000);
        deliver_with_transport("sub_1", &subscription, &event, transport)
            .await
            .unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(requests[0].body, requests[1].body);
        assert_eq!(
            requests[0]
                .headers
                .iter()
                .find(|(name, _)| name == "webhook-id"),
            requests[1]
                .headers
                .iter()
                .find(|(name, _)| name == "webhook-id")
        );
        assert_ne!(
            requests[0]
                .headers
                .iter()
                .find(|(name, _)| name == "webhook-timestamp"),
            requests[1]
                .headers
                .iter()
                .find(|(name, _)| name == "webhook-timestamp")
        );
        assert_ne!(
            requests[0]
                .headers
                .iter()
                .find(|(name, _)| name == "webhook-signature"),
            requests[1]
                .headers
                .iter()
                .find(|(name, _)| name == "webhook-signature")
        );
    }
}
