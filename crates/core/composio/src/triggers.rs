//! Composio event triggers — fire an agent when a Composio event arrives.
//!
//! A user attaches a Composio trigger (e.g. `SLACK_CHANNEL_MESSAGE_RECEIVED`,
//! `GITHUB_COMMIT_EVENT`) to an agent. We register a **trigger instance** with
//! Composio (`POST /api/v3.1/trigger_instances/{slug}/upsert`) and store the
//! agent↔trigger mapping. When the event fires, Composio delivers it to a
//! webhook; Core's `POST /api/composio/webhook` looks up the matching
//! subscription(s) and runs the agent with a prompt built from the payload.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): deciding *what runs* in response to
//! an event is orchestration → Core. The Composio key/registry is the user's own.
//!
//! ## Delivery constraint (important)
//!
//! Composio triggers are **webhook-delivered** — there is no event-pull API. A
//! local Core bound to `127.0.0.1` is not publicly reachable, so the webhook will
//! not arrive unless Core is exposed at a public URL (Ryu Cloud) or a relay
//! forwards it. Subscriptions still register fine; firing only happens once the
//! webhook can reach `POST /api/composio/webhook`. The mapping/receiver are built
//! so a reachable deployment "just works".

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::RwLock;
use tokio::sync::Mutex;

/// A persisted Composio-trigger subscription. The `target_kind` selects what the
/// fired event runs: `"agent"` (the default, fires `agent_id`) or `"workflow"`
/// (fires the workflow named by `workflow_id`, with the event payload injected as
/// the run's `trigger` state).
#[derive(Clone, Debug, Serialize)]
pub struct TriggerSubscription {
    pub id: String,
    pub agent_id: String,
    pub toolkit: String,
    pub trigger_slug: String,
    pub connected_account_id: String,
    /// Composio's id for the created trigger instance (when it returned one).
    pub composio_trigger_id: Option<String>,
    /// `"agent"` (default, back-compat for existing rows) or `"workflow"`.
    pub target_kind: String,
    /// The workflow id to fire when `target_kind == "workflow"`.
    pub workflow_id: Option<String>,
    pub created_at: String,
    /// The Composio entity that owns `connected_account_id` on a legacy
    /// (embedded) row: empty for the user's account, or an agent's own entity
    /// `agent:<owner>:<agent_id>`. Never serialized, so the owner id is not
    /// exposed; Connect rows always read as empty.
    #[serde(skip)]
    pub account_entity: String,
    /// Whether the account is one connected to the agent's own identity.
    pub own_account: bool,
}

/// The `SELECT` list [`subscription_row`] reads. A legacy row stores its
/// account's Composio entity in `provider_user_id`; a Connect row stores
/// Connect's provider identity there, which is never an agent entity.
const SUBSCRIPTION_COLUMNS: &str = "id,agent_id,toolkit,trigger_slug,connected_account_id,composio_trigger_id,target_kind,workflow_id,created_at,CASE WHEN owner_user_id='' THEN provider_user_id ELSE '' END";

/// Whether a recorded account entity is an agent's own entity.
fn is_agent_entity(account_entity: &str) -> bool {
    account_entity.starts_with("agent:")
}

/// Identity carried by Connect's verified V3 trigger envelope. This is routing
/// metadata, not permission to execute a Core target: the caller must also
/// authorize the selected agent/workflow for the verified Core user.
pub struct ConnectEventIdentity<'a> {
    pub trigger_id: &'a str,
    pub trigger_slug: &'a str,
    pub connected_account_id: &'a str,
    pub provider_user_id: &'a str,
    pub auth_config_id: &'a str,
}

pub enum ConnectTarget<'a> {
    Agent(&'a str),
    Workflow(&'a str),
}

fn subscription_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TriggerSubscription> {
    let account_entity: String = row.get(9)?;
    Ok(TriggerSubscription {
        id: row.get(0)?,
        agent_id: row.get(1)?,
        toolkit: row.get(2)?,
        trigger_slug: row.get(3)?,
        connected_account_id: row.get(4)?,
        composio_trigger_id: row.get(5)?,
        target_kind: row.get(6)?,
        workflow_id: row.get(7)?,
        created_at: row.get(8)?,
        own_account: is_agent_entity(&account_entity),
        account_entity,
    })
}

pub fn connect_event_identity(payload: &Value) -> Result<ConnectEventIdentity<'_>> {
    if payload.get("type").and_then(Value::as_str) != Some("composio.trigger.message")
        || payload.get("data").is_none()
    {
        anyhow::bail!("Unsupported Connect trigger event");
    }
    let metadata = payload
        .get("metadata")
        .and_then(Value::as_object)
        .context("Missing Connect event metadata")?;
    let field = |name| {
        metadata
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| {
                !value.is_empty()
                    && value.len() <= 256
                    && !value
                        .chars()
                        .any(|character| character.is_whitespace() || character.is_control())
            })
            .context("Invalid Connect event identity")
    };
    Ok(ConnectEventIdentity {
        trigger_id: field("trigger_id")?,
        trigger_slug: field("trigger_slug")?,
        connected_account_id: field("connected_account_id")?,
        provider_user_id: field("user_id")?,
        auth_config_id: field("auth_config_id")?,
    })
}

/// SQLite-backed subscription store. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct ComposioTriggerStore {
    conn: Arc<Mutex<Connection>>,
    http: Client,
}

static GLOBAL: OnceLock<ComposioTriggerStore> = OnceLock::new();

/// Publish the process-global store (set once at startup in `main.rs`).
pub fn set_global(store: ComposioTriggerStore) {
    let _ = GLOBAL.set(store);
}

/// The process-global store, if initialised.
pub fn global() -> Option<&'static ComposioTriggerStore> {
    GLOBAL.get()
}

/// Env var holding the Composio webhook signing secret. The inbound public
/// webhook route authenticates each delivery with Composio's signed
/// id/timestamp/raw-body tuple. Nothing is hardcoded; when unset and no
/// encrypted value exists, the route fails closed.
const WEBHOOK_SECRET_ENV: &str = "COMPOSIO_WEBHOOK_SECRET";

/// The encrypted-at-rest secret-store slot used by the Webhooks companion when
/// an operator does not provide `COMPOSIO_WEBHOOK_SECRET` in the environment.
/// These are public so Core can hydrate the process-local verifier at startup
/// without duplicating the storage key in a second crate.
pub const WEBHOOK_SECRET_STORE_OWNER: &str = "@ryu/webhooks";
pub const WEBHOOK_SECRET_STORE_KEY: &str = WEBHOOK_SECRET_ENV;

/// A process-local copy of the encrypted store value. The verifier is called
/// from public ingress paths that do not carry `ServerState`, so Core hydrates
/// this once at boot and updates it after a successful Webhooks-app write.
static STORED_WEBHOOK_SECRET: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn stored_webhook_secret() -> &'static RwLock<Option<String>> {
    STORED_WEBHOOK_SECRET.get_or_init(|| RwLock::new(None))
}

/// Install the Webhooks-app secret for the in-process verifier. The value is
/// never logged; the at-rest copy lives in Core's encrypted plugin-secret store.
pub fn set_stored_webhook_secret(secret: Option<String>) {
    if let Ok(mut current) = stored_webhook_secret().write() {
        *current = secret
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
    }
}

/// Return the operator-provided environment secret, if present. Core uses this
/// to make the UI explain why a persisted value cannot override the env source.
pub fn env_webhook_secret() -> Option<String> {
    std::env::var(WEBHOOK_SECRET_ENV)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn stored_webhook_secret_value() -> Option<String> {
    stored_webhook_secret()
        .read()
        .ok()
        .and_then(|current| current.clone())
}

/// The configured webhook signing secret, if any. An explicit environment value
/// wins over the encrypted app-managed value so existing deployments retain the
/// operator-controlled configuration contract.
pub fn webhook_secret() -> Option<String> {
    env_webhook_secret().or_else(stored_webhook_secret_value)
}

/// Constant-time byte comparison (no early return on first mismatch) so the
/// signature check does not leak the secret via timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

const COMPOSIO_TRIGGER_MESSAGE_EVENT: &str = "composio.trigger.message";

#[derive(Deserialize)]
struct WebhookSubscriptionList {
    #[serde(default)]
    items: Vec<WebhookSubscription>,
}

#[derive(Deserialize)]
struct WebhookSubscription {
    id: String,
    webhook_url: String,
    version: String,
    #[serde(default)]
    enabled_events: Vec<String>,
    #[serde(default)]
    secret: Option<String>,
}

#[derive(Deserialize)]
struct RotatedWebhookSecret {
    secret: String,
}

/// Compute HMAC-SHA256(key, message) through the shared crypto primitive.
fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let encoded = ryu_crypto::hmac_sha256_hex(key, message);
    let decoded = hex::decode(encoded).expect("shared HMAC must be valid hex");
    decoded
        .try_into()
        .expect("SHA-256 HMAC must always be 32 bytes")
}

/// Compute HMAC-SHA256(key, message) and return it lowercase-hex encoded. This is
/// the legacy per-workflow webhook format; Composio uses base64 over a signed
/// id/timestamp/body tuple instead.
pub fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    ryu_crypto::hmac_sha256_hex(key, message)
}

const COMPOSIO_WEBHOOK_TOLERANCE_SECS: u64 = 300;

/// Verify a Composio webhook signature, FAIL CLOSED. Current Composio
/// deliveries sign `{webhook-id}.{webhook-timestamp}.{rawBody}` and send one or
/// more space-separated `v1,<base64>` values in `webhook-signature`. All three
/// headers are required, and timestamps outside the 300-second replay window are
/// rejected before comparing the digest.
///
/// `raw_body` MUST be the exact bytes received (not a re-serialized JSON value),
/// otherwise the HMAC will never match.
pub fn verify_webhook_signature(
    raw_body: &[u8],
    webhook_id: Option<&str>,
    webhook_timestamp: Option<&str>,
    signature_header: Option<&str>,
) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    verify_webhook_signature_at(
        raw_body,
        webhook_id,
        webhook_timestamp,
        signature_header,
        now,
    )
}

fn verify_webhook_signature_at(
    raw_body: &[u8],
    webhook_id: Option<&str>,
    webhook_timestamp: Option<&str>,
    signature_header: Option<&str>,
    now: i64,
) -> bool {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let Some(secret) = webhook_secret() else {
        return false;
    };
    let Some(id) = webhook_id.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let Some(timestamp) = webhook_timestamp
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let Ok(timestamp_seconds) = timestamp.parse::<i64>() else {
        return false;
    };
    if timestamp_seconds < 0 || now.abs_diff(timestamp_seconds) > COMPOSIO_WEBHOOK_TOLERANCE_SECS {
        return false;
    }
    let Some(header) = signature_header.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };

    let mut signing_message = Vec::with_capacity(id.len() + timestamp.len() + raw_body.len() + 2);
    signing_message.extend_from_slice(id.as_bytes());
    signing_message.push(b'.');
    signing_message.extend_from_slice(timestamp.as_bytes());
    signing_message.push(b'.');
    signing_message.extend_from_slice(raw_body);
    let expected = hmac_sha256(secret.as_bytes(), &signing_message);

    header.split_whitespace().any(|token| {
        let Some(candidate) = token.strip_prefix("v1,") else {
            return false;
        };
        let Ok(decoded) = STANDARD.decode(candidate) else {
            return false;
        };
        constant_time_eq(&decoded, &expected)
    })
}

/// Verify an inbound **per-workflow** webhook POST against a trigger-specific
/// secret (`WorkflowTrigger::Webhook.secret`), independent of the global Composio
/// webhook secret. This legacy route accepts `v1,<hex>`, `sha256=<hex>`, or a
/// bare hex digest over the raw body. An absent header or mismatch is rejected.
/// The caller must also refuse to fire when the trigger has no secret.
pub fn verify_workflow_webhook_signature(
    secret: &str,
    raw_body: &[u8],
    signature_header: Option<&str>,
) -> bool {
    let Some(header) = signature_header.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let expected_hex = hmac_sha256_hex(secret.as_bytes(), raw_body);
    header.split_whitespace().any(|token| {
        let candidate = token
            .rsplit(',')
            .next()
            .unwrap_or(token)
            .trim_start_matches("sha256=");
        constant_time_eq(candidate.as_bytes(), expected_hex.as_bytes())
    })
}

/// Verify a replay-resistant workflow webhook whose signature is also bound to
/// the canonical workflow id selected by the request path.
pub fn verify_workflow_webhook_signature_v3(
    secret: &str,
    workflow_id: &str,
    raw_body: &[u8],
    signature_header: Option<&str>,
    webhook_timestamp: Option<&str>,
    webhook_id: Option<&str>,
    now_secs: u64,
) -> bool {
    let (Some(timestamp), Some(id), Some(signature)) = (
        webhook_timestamp,
        webhook_id,
        signature_header.and_then(|value| value.trim().strip_prefix("v3,")),
    ) else {
        return false;
    };
    let Ok(sent_at) = timestamp.parse::<u64>() else {
        return false;
    };
    if sent_at.abs_diff(now_secs) > 300
        || id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return false;
    }
    if workflow_id.is_empty() || workflow_id.contains('/') {
        return false;
    }
    let mut signed =
        format!("ryu-workflow-webhook-v3\n{workflow_id}\n{timestamp}\n{id}\n").into_bytes();
    signed.extend_from_slice(raw_body);
    let expected = hmac_sha256_hex(secret.as_bytes(), &signed);
    constant_time_eq(signature.as_bytes(), expected.as_bytes())
}

impl ComposioTriggerStore {
    /// Open (creating if needed) the triggers DB at `db_path` (Core passes
    /// `~/.ryu/composio-triggers.db`; the data dir is a kernel concern, inverted
    /// so this crate never reaches into `apps/core`).
    pub fn open(http: Client, db_path: PathBuf) -> Result<Self> {
        let path = db_path;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).context("creating ~/.ryu for composio-triggers.db")?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening composio-triggers db at {}", path.display()))?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS subscriptions (
                 id                   TEXT PRIMARY KEY,
                 agent_id             TEXT NOT NULL,
                 toolkit              TEXT NOT NULL,
                 trigger_slug         TEXT NOT NULL,
                 connected_account_id TEXT NOT NULL,
                 composio_trigger_id  TEXT,
                 target_kind          TEXT NOT NULL DEFAULT 'agent',
                 workflow_id          TEXT,
                 created_at           TEXT NOT NULL
             );",
        )
        .context("running composio-triggers schema migration")?;
        // Guarded migration for DBs created before target_kind/workflow_id
        // existed: CREATE TABLE IF NOT EXISTS won't add columns to a live table,
        // and a bare ALTER throws "duplicate column" on the second boot, so only
        // ALTER the columns that are actually missing. Existing rows default to
        // the agent target.
        Self::add_missing_columns(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            http,
        })
    }

    /// Add the `target_kind`/`workflow_id` columns to a pre-existing table when
    /// they are missing. Idempotent (safe to run on every boot).
    fn add_missing_columns(conn: &Connection) -> Result<()> {
        let mut existing: std::collections::HashSet<String> = std::collections::HashSet::new();
        {
            let mut stmt = conn.prepare("PRAGMA table_info(subscriptions)")?;
            let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
            for name in names {
                existing.insert(name?);
            }
        }
        if !existing.contains("target_kind") {
            conn.execute(
                "ALTER TABLE subscriptions ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'agent'",
                [],
            )?;
        }
        if !existing.contains("workflow_id") {
            conn.execute("ALTER TABLE subscriptions ADD COLUMN workflow_id TEXT", [])?;
        }
        for (name, statement) in [
            (
                "owner_user_id",
                "ALTER TABLE subscriptions ADD COLUMN owner_user_id TEXT NOT NULL DEFAULT ''",
            ),
            (
                "provider_user_id",
                "ALTER TABLE subscriptions ADD COLUMN provider_user_id TEXT NOT NULL DEFAULT ''",
            ),
            (
                "auth_config_id",
                "ALTER TABLE subscriptions ADD COLUMN auth_config_id TEXT NOT NULL DEFAULT ''",
            ),
        ] {
            if !existing.contains(name) {
                conn.execute(statement, [])?;
            }
        }
        if !existing.contains("removed_at") {
            conn.execute("ALTER TABLE subscriptions ADD COLUMN removed_at TEXT", [])?;
        }
        let index_sql: Option<String> = conn.query_row("SELECT sql FROM sqlite_master WHERE type='index' AND name='connect_target_binding'", [], |row| row.get(0)).optional()?;
        if index_sql.is_some_and(|sql| !sql.contains("removed_at IS NULL")) {
            conn.execute("DROP INDEX connect_target_binding", [])?;
        }
        conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS connect_target_binding ON subscriptions(owner_user_id,composio_trigger_id,target_kind,agent_id,coalesce(workflow_id,'')) WHERE owner_user_id<>'' AND removed_at IS NULL")?;
        Ok(())
    }

    /// Create or update the authenticated Composio project's single outbound
    /// webhook subscription. The subscription is always upgraded to V3 and
    /// `composio.trigger.message` is added without removing event types the user
    /// already enabled. Returns the signing secret so Core can place it in the
    /// encrypted plugin-secret store before any trigger instance is created.
    pub async fn reconcile_webhook_subscription(&self, webhook_url: &str) -> Result<String> {
        if crate::service::is_configured() {
            return Err(anyhow!("Connect owns provider webhook subscriptions"));
        }
        let key = crate::auth::key()
            .ok_or_else(|| anyhow!("Composio API key not set (Settings → Integrations)"))?;
        let collection_url = format!("{}/webhook_subscriptions", crate::catalog::base_url());
        let response = self
            .http
            .get(&collection_url)
            .header("x-api-key", &key)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|error| anyhow!("listing Composio webhook subscriptions failed: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(anyhow!(
                "listing Composio webhook subscriptions returned {status}"
            ));
        }
        let subscriptions: WebhookSubscriptionList = response
            .json()
            .await
            .context("decoding Composio webhook subscriptions response")?;
        if subscriptions.items.len() > 1 {
            return Err(anyhow!(
                "Composio returned multiple project webhook subscriptions; refusing to update an ambiguous destination"
            ));
        }

        let Some(existing) = subscriptions.items.into_iter().next() else {
            let response = self
                .http
                .post(&collection_url)
                .header("x-api-key", &key)
                .header("content-type", "application/json")
                .timeout(Duration::from_secs(20))
                .json(&json!({
                    "webhook_url": webhook_url,
                    "enabled_events": [COMPOSIO_TRIGGER_MESSAGE_EVENT],
                    "version": "V3",
                }))
                .send()
                .await
                .map_err(|error| {
                    anyhow!("creating Composio webhook subscription failed: {error}")
                })?;
            let status = response.status();
            if !status.is_success() {
                return Err(anyhow!(
                    "creating Composio webhook subscription returned {status}"
                ));
            }
            let created: WebhookSubscription = response
                .json()
                .await
                .context("decoding created Composio webhook subscription")?;
            return required_webhook_secret(created.secret);
        };

        let mut enabled_events = existing.enabled_events.clone();
        if !enabled_events
            .iter()
            .any(|event| event == COMPOSIO_TRIGGER_MESSAGE_EVENT)
        {
            enabled_events.push(COMPOSIO_TRIGGER_MESSAGE_EVENT.to_owned());
        }
        enabled_events.sort();
        enabled_events.dedup();

        let drifted = existing.webhook_url != webhook_url
            || existing.version != "V3"
            || enabled_events != existing.enabled_events;
        // Current API responses include the secret, while migrated/older
        // subscriptions may omit it except at creation or rotation. Reuse the
        // already-hydrated local value in that case so adding a second trigger
        // does not rotate a still-valid project secret.
        let mut secret = existing
            .secret
            .or_else(stored_webhook_secret_value)
            .or_else(env_webhook_secret);
        if drifted {
            let item_url = format!("{collection_url}/{}", existing.id);
            let response = self
                .http
                .patch(&item_url)
                .header("x-api-key", &key)
                .header("content-type", "application/json")
                .timeout(Duration::from_secs(20))
                .json(&json!({
                    "webhook_url": webhook_url,
                    "enabled_events": enabled_events,
                    "version": "V3",
                }))
                .send()
                .await
                .map_err(|error| {
                    anyhow!("updating Composio webhook subscription failed: {error}")
                })?;
            let status = response.status();
            if !status.is_success() {
                return Err(anyhow!(
                    "updating Composio webhook subscription returned {status}"
                ));
            }
            let updated: WebhookSubscription = response
                .json()
                .await
                .context("decoding updated Composio webhook subscription")?;
            secret = updated.secret.or(secret);
        }

        if let Some(secret) = normalized_secret(secret) {
            return Ok(secret);
        }

        // Some Composio API versions return a subscription's secret only when it
        // is created or rotated. Rotate only when no usable secret was returned,
        // otherwise a normal reconcile never changes credentials.
        let rotate_url = format!("{collection_url}/{}/rotate_secret", existing.id);
        let response = self
            .http
            .post(&rotate_url)
            .header("x-api-key", key)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|error| anyhow!("rotating Composio webhook secret failed: {error}"))?;
        let status = response.status();
        if !status.is_success() {
            return Err(anyhow!(
                "rotating Composio webhook secret returned {status}"
            ));
        }
        let rotated: RotatedWebhookSecret = response
            .json()
            .await
            .context("decoding rotated Composio webhook secret")?;
        required_webhook_secret(Some(rotated.secret))
    }

    /// Register a trigger instance with Composio and persist an **agent**-target
    /// mapping. Kept for existing callers; delegates to [`Self::subscribe_target`].
    pub async fn subscribe(
        &self,
        agent_id: &str,
        toolkit: &str,
        trigger_slug: &str,
        connected_account_id: &str,
        config: Value,
    ) -> Result<TriggerSubscription> {
        self.subscribe_target(
            "agent",
            agent_id,
            None,
            "",
            toolkit,
            trigger_slug,
            connected_account_id,
            config,
        )
        .await
    }

    /// Register a trigger instance on an account connected to an agent's own
    /// Composio entity and persist an **agent**-target mapping that records
    /// `account_entity`. The caller has already checked that the entity is the
    /// agent's own and owns the account; delivery re-checks the entity against
    /// the agent and its account policy on every event.
    pub async fn subscribe_own_account(
        &self,
        agent_id: &str,
        account_entity: &str,
        toolkit: &str,
        trigger_slug: &str,
        connected_account_id: &str,
        config: Value,
    ) -> Result<TriggerSubscription> {
        if !is_agent_entity(account_entity)
            || account_entity.len() <= "agent:".len()
            || account_entity
                .chars()
                .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err(anyhow!("an agent's own Composio entity is required"));
        }
        if agent_id.trim().is_empty() || !account_entity.ends_with(&format!(":{agent_id}")) {
            return Err(anyhow!("the account entity does not belong to this agent"));
        }
        self.subscribe_target(
            "agent",
            agent_id,
            None,
            account_entity,
            toolkit,
            trigger_slug,
            connected_account_id,
            config,
        )
        .await
    }

    /// Register a trigger instance with Composio and persist a **workflow**-target
    /// mapping. The fired event runs `workflow_id` with the payload injected as
    /// `trigger` state.
    pub async fn subscribe_workflow(
        &self,
        workflow_id: &str,
        toolkit: &str,
        trigger_slug: &str,
        connected_account_id: &str,
        config: Value,
    ) -> Result<TriggerSubscription> {
        self.subscribe_target(
            "workflow",
            "",
            Some(workflow_id),
            "",
            toolkit,
            trigger_slug,
            connected_account_id,
            config,
        )
        .await
    }

    /// Shared subscribe implementation for either target kind.
    #[allow(clippy::too_many_arguments)]
    async fn subscribe_target(
        &self,
        target_kind: &str,
        agent_id: &str,
        workflow_id: Option<&str>,
        account_entity: &str,
        toolkit: &str,
        trigger_slug: &str,
        connected_account_id: &str,
        config: Value,
    ) -> Result<TriggerSubscription> {
        if crate::service::is_configured() {
            return Err(anyhow!(
                "Connect owns provider triggers; use its management API and bind the Core target"
            ));
        }
        let key = crate::auth::key()
            .ok_or_else(|| anyhow!("Composio API key not set (Settings → Integrations)"))?;
        let url = format!(
            "{}/trigger_instances/{}/upsert",
            crate::catalog::base_url(),
            trigger_slug
        );
        let resp = self
            .http
            .post(&url)
            .header("x-api-key", key)
            .header("content-type", "application/json")
            .timeout(Duration::from_secs(20))
            .json(&json!({
                "connected_account_id": connected_account_id,
                "trigger_config": config,
            }))
            .send()
            .await
            .map_err(|e| anyhow!("Composio trigger upsert failed: {e}"))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Composio trigger upsert {status}: {body}"));
        }
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        // Composio returns the instance id under one of these keys depending on
        // API version — read defensively.
        let composio_trigger_id = ["trigger_id", "triggerId", "id", "nano_id"]
            .iter()
            .find_map(|k| body.get(*k).and_then(Value::as_str))
            .map(str::to_owned);

        let id = format!("ctrig_{}", uuid::Uuid::new_v4().simple());
        let created_at = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO subscriptions
                    (id, agent_id, toolkit, trigger_slug, connected_account_id,
                     composio_trigger_id, target_kind, workflow_id, created_at,
                     provider_user_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    id,
                    agent_id,
                    toolkit,
                    trigger_slug,
                    connected_account_id,
                    composio_trigger_id,
                    target_kind,
                    workflow_id,
                    created_at,
                    account_entity,
                ],
            )?;
        }
        Ok(TriggerSubscription {
            id,
            agent_id: agent_id.to_owned(),
            toolkit: toolkit.to_owned(),
            trigger_slug: trigger_slug.to_owned(),
            connected_account_id: connected_account_id.to_owned(),
            composio_trigger_id,
            target_kind: target_kind.to_owned(),
            workflow_id: workflow_id.map(str::to_owned),
            created_at,
            account_entity: account_entity.to_owned(),
            own_account: is_agent_entity(account_entity),
        })
    }

    /// All subscriptions, newest first.
    pub async fn list(&self) -> Result<Vec<TriggerSubscription>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE removed_at IS NULL ORDER BY created_at DESC"
        ))?;
        let rows = stmt
            .query_map([], subscription_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Best-effort remote teardown of a Composio trigger *instance* so a removed
    /// subscription stops the remote from firing into the void. Never fails the
    /// caller: a missing key, an absent instance id, or an API error are logged
    /// and swallowed (the local row is still deleted by the caller).
    async fn remote_disable(&self, composio_trigger_id: Option<&str>) {
        if crate::service::is_configured() {
            return;
        }
        let Some(trigger_id) = composio_trigger_id else {
            return;
        };
        let Some(key) = crate::auth::key() else {
            return;
        };
        let url = format!(
            "{}/trigger_instances/manage/{}",
            crate::catalog::base_url(),
            trigger_id
        );
        let resp = self
            .http
            .delete(&url)
            .header("x-api-key", key)
            .timeout(Duration::from_secs(20))
            .send()
            .await;
        match resp {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => {
                let status = r.status();
                tracing::warn!(trigger = %trigger_id, %status, "composio trigger remote disable returned non-success");
            }
            Err(e) => {
                tracing::warn!(trigger = %trigger_id, error = %e, "composio trigger remote disable failed");
            }
        }
    }

    /// Delete a subscription. Returns `false` when no row matched. Best-effort
    /// remote teardown: before removing the local row we ask Composio to disable
    /// the remote trigger instance so it stops firing into the void.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        // Resolve the remote instance id first (before we drop the row).
        let row: Option<(Option<String>, String)> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT composio_trigger_id,owner_user_id FROM subscriptions WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
        };
        let trigger_id = match row {
            Some((_, owner)) if !owner.is_empty() => {
                anyhow::bail!("Connect-owned target requires scoped removal")
            }
            Some((trigger_id, _)) => trigger_id,
            None => None,
        };
        self.remote_disable(trigger_id.as_deref()).await;
        let conn = self.conn.lock().await;
        let n = conn.execute("DELETE FROM subscriptions WHERE id = ?1", params![id])?;
        Ok(n > 0)
    }

    /// Delete every legacy subscription on one account of `account_entity`
    /// (the user's default entity when empty), disabling each remote instance
    /// first. Used when that account is disconnected, so no binding outlives
    /// it. Connect rows are never touched. Returns the rows removed.
    pub async fn delete_for_connected_account(
        &self,
        account_entity: &str,
        connected_account_id: &str,
    ) -> Result<usize> {
        if connected_account_id.trim().is_empty() {
            return Ok(0);
        }
        for sub in self
            .embedded_subscriptions()
            .await?
            .into_iter()
            .filter(|row| {
                row.account_entity == account_entity
                    && row.connected_account_id == connected_account_id
            })
        {
            self.remote_disable(sub.composio_trigger_id.as_deref())
                .await;
        }
        let conn = self.conn.lock().await;
        let removed = conn.execute(
            "DELETE FROM subscriptions WHERE owner_user_id='' AND provider_user_id=?1 AND connected_account_id=?2",
            params![account_entity, connected_account_id],
        )?;
        Ok(removed)
    }

    /// All workflow-target subscriptions for a given workflow id.
    pub async fn list_for_workflow(&self, workflow_id: &str) -> Vec<TriggerSubscription> {
        self.list()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|s| {
                s.target_kind == "workflow" && s.workflow_id.as_deref() == Some(workflow_id)
            })
            .collect()
    }

    /// Delete every workflow-target subscription for a workflow. Returns the
    /// number of rows removed. Used by explicit workflow deletion. Best-effort
    /// remote teardown: each removed instance is disabled on Composio first so it
    /// stops firing into the void (an orphaned remote trigger whose local mapping
    /// is gone).
    pub async fn delete_for_workflow(&self, workflow_id: &str) -> Result<usize> {
        let embedded = self.delete_embedded_for_workflow(workflow_id).await?;
        let conn = self.conn.lock().await;
        let removed = conn.execute("UPDATE subscriptions SET removed_at=? WHERE target_kind='workflow' AND workflow_id=? AND owner_user_id<>'' AND removed_at IS NULL", params![chrono::Utc::now().to_rfc3339(),workflow_id])?;
        Ok(embedded + removed)
    }

    /// Workflow definition reconciliation owns only its legacy embedded rows.
    /// Connect bindings have a separate lifecycle and survive ordinary saves.
    pub async fn delete_embedded_for_workflow(&self, workflow_id: &str) -> Result<usize> {
        // Disable the remote instances before dropping the local rows.
        for sub in self
            .embedded_subscriptions()
            .await?
            .into_iter()
            .filter(|row| {
                row.target_kind == "workflow" && row.workflow_id.as_deref() == Some(workflow_id)
            })
        {
            self.remote_disable(sub.composio_trigger_id.as_deref())
                .await;
        }
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM subscriptions WHERE target_kind = 'workflow' AND workflow_id = ?1 AND owner_user_id=''",
            params![workflow_id],
        )?;
        Ok(n)
    }

    /// Exact candidate lookup for Connect inbox consumption. Unlike legacy
    /// webhook matching, a shared slug never substitutes for another trigger or
    /// account. Lookup failures propagate; they are not an empty-success result.
    pub async fn connect_targets(
        &self,
        owner_user_id: &str,
        payload: &Value,
    ) -> Result<Vec<TriggerSubscription>> {
        if owner_user_id.is_empty() {
            anyhow::bail!("Connect target owner is required");
        }
        let identity = connect_event_identity(payload)?;
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(&format!("SELECT {SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE owner_user_id=? AND provider_user_id=? AND auth_config_id=? AND composio_trigger_id=? AND connected_account_id=? AND trigger_slug=? AND removed_at IS NULL ORDER BY created_at,id"))?;
        let rows = statement
            .query_map(
                params![
                    owner_user_id,
                    identity.provider_user_id,
                    identity.auth_config_id,
                    identity.trigger_id,
                    identity.connected_account_id,
                    identity.trigger_slug
                ],
                subscription_row,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Persist only a Core orchestration target after the caller has authorized
    /// it and obtained the provider identity through Connect's management API.
    /// No provider credential or provider mutation belongs in this method.
    pub async fn bind_connect_target(
        &self,
        owner_user_id: &str,
        identity: &ConnectEventIdentity<'_>,
        toolkit: &str,
        target: ConnectTarget<'_>,
    ) -> Result<TriggerSubscription> {
        let (kind, agent, workflow) = match target {
            ConnectTarget::Agent(id) => ("agent", id, None),
            ConnectTarget::Workflow(id) => ("workflow", "", Some(id)),
        };
        for value in [
            owner_user_id,
            identity.trigger_id,
            identity.trigger_slug,
            identity.connected_account_id,
            identity.provider_user_id,
            identity.auth_config_id,
            toolkit,
            workflow.unwrap_or(agent),
        ] {
            if value.is_empty()
                || value.len() > 256
                || value.chars().any(|c| c.is_whitespace() || c.is_control())
            {
                anyhow::bail!("Invalid Connect target binding");
            }
        }
        let mut conn = self.conn.lock().await;
        let transaction =
            conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let previous: Option<(String,String)> = transaction.query_row("SELECT id,created_at FROM subscriptions WHERE owner_user_id=? AND composio_trigger_id=? AND target_kind=? AND agent_id=? AND coalesce(workflow_id,'')=? AND removed_at IS NULL", params![owner_user_id,identity.trigger_id,kind,agent,workflow.unwrap_or("")], |row| Ok((row.get(0)?,row.get(1)?))).optional()?;
        let (id, created_at) = previous.unwrap_or_else(|| {
            (
                format!("ctrig_{}", uuid::Uuid::new_v4().simple()),
                chrono::Utc::now().to_rfc3339(),
            )
        });
        transaction.execute("INSERT INTO subscriptions(id,agent_id,toolkit,trigger_slug,connected_account_id,composio_trigger_id,target_kind,workflow_id,created_at,owner_user_id,provider_user_id,auth_config_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET toolkit=excluded.toolkit,trigger_slug=excluded.trigger_slug,connected_account_id=excluded.connected_account_id,provider_user_id=excluded.provider_user_id,auth_config_id=excluded.auth_config_id", params![id,agent,toolkit,identity.trigger_slug,identity.connected_account_id,identity.trigger_id,kind,workflow,created_at,owner_user_id,identity.provider_user_id,identity.auth_config_id])?;
        transaction.commit()?;
        Ok(TriggerSubscription {
            id,
            agent_id: agent.to_owned(),
            toolkit: toolkit.to_owned(),
            trigger_slug: identity.trigger_slug.to_owned(),
            connected_account_id: identity.connected_account_id.to_owned(),
            composio_trigger_id: Some(identity.trigger_id.to_owned()),
            target_kind: kind.to_owned(),
            workflow_id: workflow.map(str::to_owned),
            created_at,
            account_entity: String::new(),
            own_account: false,
        })
    }

    /// Remove only the caller's Core target mapping. Provider instance teardown
    /// is a separate Connect operation, never a local Composio-key request.
    pub async fn remove_connect_target(&self, owner_user_id: &str, id: &str) -> Result<bool> {
        if owner_user_id.is_empty() {
            anyhow::bail!("Connect target owner is required");
        }
        let conn = self.conn.lock().await;
        Ok(conn.execute(
            "UPDATE subscriptions SET removed_at=? WHERE id=? AND owner_user_id=? AND removed_at IS NULL",
            params![chrono::Utc::now().to_rfc3339(), id, owner_user_id],
        )? == 1)
    }

    pub async fn list_connect_targets(
        &self,
        owner_user_id: &str,
    ) -> Result<Vec<TriggerSubscription>> {
        if owner_user_id.is_empty() {
            anyhow::bail!("Connect target owner is required");
        }
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(&format!("SELECT {SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE owner_user_id=? AND removed_at IS NULL ORDER BY created_at DESC,id"))?;
        let rows = statement
            .query_map(params![owner_user_id], subscription_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    async fn embedded_subscriptions(&self) -> Result<Vec<TriggerSubscription>> {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(&format!("SELECT {SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE owner_user_id='' ORDER BY created_at DESC"))?;
        let rows = statement
            .query_map([], subscription_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub async fn connect_event_was_unbound(
        &self,
        owner_user_id: &str,
        payload: &Value,
    ) -> Result<bool> {
        if owner_user_id.is_empty() {
            anyhow::bail!("Connect target owner is required");
        }
        let identity = connect_event_identity(payload)?;
        let conn = self.conn.lock().await;
        Ok(conn.query_row("SELECT 1 FROM subscriptions WHERE owner_user_id=? AND provider_user_id=? AND auth_config_id=? AND composio_trigger_id=? AND connected_account_id=? AND trigger_slug=? AND removed_at IS NOT NULL LIMIT 1", params![owner_user_id,identity.provider_user_id,identity.auth_config_id,identity.trigger_id,identity.connected_account_id,identity.trigger_slug], |_| Ok(())).optional()?.is_some())
    }

    /// The legacy rows an event fires. A row on one of the user's accounts
    /// matches by trigger instance id or, for older payloads, by slug. The slug
    /// fallback is skipped for an event that belongs elsewhere: one from an
    /// agent's entity, one carrying an agent row's instance id, or one naming
    /// a different connected account than the row's. A row on an agent's own
    /// account matches only by its exact instance id, and only when any
    /// account and user the event names are that row's own, so an event from
    /// another entity can never reach the agent. An event whose instance id
    /// some row recorded fires only the rows with that id, and an unknown
    /// instance's slug fallback skips rows that recorded a different id.
    async fn matching(&self, event: &EventIdentity<'_>) -> Vec<TriggerSubscription> {
        let all = self.embedded_subscriptions().await.unwrap_or_default();
        let from_agent_account = event.user_id.is_some_and(is_agent_entity)
            || event.trigger_id.is_some_and(|t| {
                all.iter().any(|s| {
                    is_agent_entity(&s.account_entity)
                        && s.composio_trigger_id.as_deref() == Some(t)
                })
            });
        // A known trigger instance fires only the rows bound to it: a shared slug
        // must not fan the event out to other instances (and connected accounts).
        let instance_known = event.trigger_id.is_some_and(|t| {
            all.iter()
                .any(|s| s.composio_trigger_id.as_deref() == Some(t))
        });
        all.iter()
            .filter(|s| {
                let by_id = event
                    .trigger_id
                    .is_some_and(|t| s.composio_trigger_id.as_deref() == Some(t));
                if is_agent_entity(&s.account_entity) {
                    return by_id
                        && event
                            .connected_account_id
                            .is_none_or(|id| id == s.connected_account_id)
                        && event.user_id.is_none_or(|user| user == s.account_entity);
                }
                if by_id {
                    return true;
                }
                if instance_known {
                    return false;
                }
                // Unknown instance: the slug may only stand in for rows that never
                // recorded an instance id.
                if event.trigger_id.is_some() && s.composio_trigger_id.is_some() {
                    return false;
                }
                let other_account = event.connected_account_id.is_some_and(|id| {
                    !s.connected_account_id.is_empty() && id != s.connected_account_id
                });
                !from_agent_account
                    && !other_account
                    && event
                        .slug
                        .is_some_and(|sl| s.trigger_slug.eq_ignore_ascii_case(sl))
            })
            .cloned()
            .collect()
    }

    /// Handle an inbound Composio webhook payload: find matching subscriptions and
    /// fire each bound target. An `agent` target runs the configured agent with a
    /// prompt built from the event; a `workflow` target runs the workflow with the
    /// raw event payload injected as `trigger` state. Returns how many runs were
    /// started.
    pub async fn handle_webhook(&self, payload: &Value) -> usize {
        if crate::service::is_configured() {
            tracing::warn!("Legacy Core Composio delivery ignored: Connect owns ingress");
            return 0;
        }
        // V3 (the current default) nests trigger identity under `metadata`.
        // Retain the flat aliases as a fallback for existing V1/V2 subscriptions.
        let metadata = payload.get("metadata").and_then(Value::as_object);
        let metadata_string = |key: &str| {
            metadata
                .and_then(|value| value.get(key))
                .and_then(Value::as_str)
        };
        let trigger_id = ["trigger_id", "triggerId", "id", "nano_id"]
            .iter()
            .find_map(|key| metadata_string(key))
            .or_else(|| {
                ["trigger_id", "triggerId", "nano_id"]
                    .iter()
                    .find_map(|key| payload.get(*key).and_then(Value::as_str))
            });
        let slug = ["trigger_slug", "triggerName", "type", "trigger_name"]
            .iter()
            .find_map(|key| metadata_string(key))
            .or_else(|| {
                ["trigger_slug", "triggerName", "type", "trigger_name"]
                    .iter()
                    .find_map(|key| payload.get(*key).and_then(Value::as_str))
            });

        let event = EventIdentity {
            trigger_id,
            slug,
            connected_account_id: metadata_string("connected_account_id"),
            user_id: metadata_string("user_id"),
        };
        let subs = self.matching(&event).await;
        let mut fired = 0;
        for sub in subs {
            if sub.target_kind == "workflow" {
                let Some(workflow_id) = sub.workflow_id.as_deref() else {
                    tracing::warn!(sub = %sub.id, "workflow trigger missing workflow_id");
                    continue;
                };
                let payload_json = serde_json::to_string(payload).unwrap_or_default();
                let run = match crate::host::host() {
                    Ok(h) => h.run_workflow_for_trigger(workflow_id, &payload_json).await,
                    Err(e) => Err(e),
                };
                match run {
                    Ok(run_id) => {
                        tracing::info!(
                            workflow = %workflow_id,
                            trigger = %sub.trigger_slug,
                            run = %run_id,
                            "composio trigger fired workflow run"
                        );
                        fired += 1;
                    }
                    Err(e) => {
                        tracing::warn!(workflow = %workflow_id, error = %e, "composio trigger workflow run failed");
                    }
                }
                continue;
            }

            let may_receive = match crate::host::host() {
                Ok(h) => {
                    h.agent_may_receive(
                        &sub.agent_id,
                        &sub.connected_account_id,
                        &sub.account_entity,
                    )
                    .await
                }
                Err(e) => Err(e),
            };
            match may_receive {
                Ok(true) => {}
                Ok(false) => {
                    tracing::info!(
                        agent = %sub.agent_id,
                        trigger = %sub.trigger_slug,
                        "composio trigger skipped: the agent may no longer use this account"
                    );
                    continue;
                }
                Err(e) => {
                    tracing::warn!(agent = %sub.agent_id, error = %e, "composio trigger account check failed");
                    continue;
                }
            }
            let prompt = format!(
                "A Composio `{}` event fired for the `{}` integration. Handle it. \
                 Event payload (JSON):\n\n{}",
                sub.trigger_slug,
                sub.toolkit,
                serde_json::to_string_pretty(payload).unwrap_or_default()
            );
            let run = match crate::host::host() {
                Ok(h) => h.run_agent(&sub.agent_id, &prompt).await,
                Err(e) => Err(e),
            };
            match run {
                Ok(run_id) => {
                    tracing::info!(
                        agent = %sub.agent_id,
                        trigger = %sub.trigger_slug,
                        run = %run_id,
                        "composio trigger fired agent run"
                    );
                    fired += 1;
                }
                Err(e) => {
                    tracing::warn!(agent = %sub.agent_id, error = %e, "composio trigger run failed");
                }
            }
        }
        fired
    }
}

/// What an inbound legacy event says about where it came from.
struct EventIdentity<'a> {
    trigger_id: Option<&'a str>,
    slug: Option<&'a str>,
    /// V3 `metadata.connected_account_id`, when present.
    connected_account_id: Option<&'a str>,
    /// V3 `metadata.user_id` (the account's Composio entity), when present.
    user_id: Option<&'a str>,
}

fn normalized_secret(secret: Option<String>) -> Option<String> {
    secret
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn required_webhook_secret(secret: Option<String>) -> Result<String> {
    normalized_secret(secret)
        .ok_or_else(|| anyhow!("Composio webhook subscription response omitted the signing secret"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn workflow_reconcile_preserves_separately_owned_connect_binding() {
        let (store, _dir) = temp_store().await;
        let payload = json!({"type":"composio.trigger.message","metadata":{"trigger_id":"ti_a","trigger_slug":"SLACK_MSG","connected_account_id":"ca_a","user_id":"provider-a","auth_config_id":"ac_a"},"data":{}});
        let identity = connect_event_identity(&payload).unwrap();
        let binding = store
            .bind_connect_target(
                "owner-a",
                &identity,
                "slack",
                ConnectTarget::Workflow("workflow-a"),
            )
            .await
            .unwrap();
        store.conn.lock().await.execute("INSERT INTO subscriptions(id,agent_id,toolkit,trigger_slug,connected_account_id,target_kind,workflow_id,created_at) VALUES('legacy-workflow','','slack','SLACK_MSG','ca_a','workflow','workflow-a','original')", []).unwrap();
        assert_eq!(
            store
                .delete_embedded_for_workflow("workflow-a")
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            store.connect_targets("owner-a", &payload).await.unwrap()[0].id,
            binding.id
        );
        assert!(!store
            .connect_event_was_unbound("owner-a", &payload)
            .await
            .unwrap());
        assert_eq!(store.delete_for_workflow("workflow-a").await.unwrap(), 1);
        assert!(store
            .connect_targets("owner-a", &payload)
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .connect_event_was_unbound("owner-a", &payload)
            .await
            .unwrap());
    }

    #[test]
    fn connect_events_require_complete_identity() {
        let payload = json!({"type":"composio.trigger.message","metadata":{"trigger_id":"ti_a","trigger_slug":"SLACK_MSG","connected_account_id":"ca_a","user_id":"provider-a","auth_config_id":"ac_a"},"data":{"text":"fixture"}});
        let identity = connect_event_identity(&payload).unwrap();
        assert_eq!(identity.provider_user_id, "provider-a");
        assert_eq!(identity.auth_config_id, "ac_a");
        for key in [
            "trigger_id",
            "trigger_slug",
            "connected_account_id",
            "user_id",
            "auth_config_id",
        ] {
            let mut missing = payload.clone();
            missing["metadata"].as_object_mut().unwrap().remove(key);
            assert!(connect_event_identity(&missing).is_err());
        }
        assert!(connect_event_identity(&json!({"trigger_slug":"SLACK_MSG"})).is_err());
    }

    #[tokio::test]
    async fn connect_target_store_preserves_owner_binding_and_excludes_legacy_rows() {
        let (store, dir) = temp_store().await;
        let payload = json!({"type":"composio.trigger.message","metadata":{"trigger_id":"ti_a","trigger_slug":"SLACK_MSG","connected_account_id":"ca_a","user_id":"provider-a","auth_config_id":"ac_a"},"data":{}});
        let identity = connect_event_identity(&payload).unwrap();
        store.conn.lock().await.execute("INSERT INTO subscriptions(id,agent_id,toolkit,trigger_slug,connected_account_id,composio_trigger_id,created_at) VALUES('legacy','legacy-agent','slack','SLACK_MSG','ca_a','ti_a','original')", []).unwrap();
        assert!(store
            .connect_targets("local", &payload)
            .await
            .unwrap()
            .is_empty());
        let a = store
            .bind_connect_target(
                "owner-a",
                &identity,
                "slack",
                ConnectTarget::Agent("agent-a"),
            )
            .await
            .unwrap();
        let again = store
            .bind_connect_target(
                "owner-a",
                &identity,
                "slack",
                ConnectTarget::Agent("agent-a"),
            )
            .await
            .unwrap();
        assert_eq!(a.id, again.id);
        store
            .bind_connect_target(
                "owner-b",
                &identity,
                "slack",
                ConnectTarget::Agent("agent-b"),
            )
            .await
            .unwrap();
        store
            .bind_connect_target(
                "owner-a",
                &identity,
                "slack",
                ConnectTarget::Workflow("workflow-a"),
            )
            .await
            .unwrap();
        let owned = store.connect_targets("owner-a", &payload).await.unwrap();
        assert_eq!(owned.len(), 2);
        let legacy_matches = store
            .matching(&EventIdentity {
                trigger_id: Some("ti_a"),
                slug: Some("SLACK_MSG"),
                connected_account_id: None,
                user_id: None,
            })
            .await;
        assert_eq!(legacy_matches.len(), 1);
        assert_eq!(legacy_matches[0].id, "legacy");
        assert!(store.delete(&a.id).await.is_err());
        assert!(!store.remove_connect_target("owner-b", &a.id).await.unwrap());
        assert!(owned
            .iter()
            .all(|row| row.agent_id != "agent-b" && row.id != "legacy"));
        assert_eq!(
            store.connect_targets("owner-b", &payload).await.unwrap()[0].agent_id,
            "agent-b"
        );
        for field in [
            "trigger_id",
            "trigger_slug",
            "connected_account_id",
            "user_id",
            "auth_config_id",
        ] {
            let mut wrong = payload.clone();
            wrong["metadata"][field] = json!("different");
            assert!(store
                .connect_targets("owner-a", &wrong)
                .await
                .unwrap()
                .is_empty());
        }
        assert!(store.connect_targets("", &payload).await.is_err());
        drop(store);
        let reopened =
            ComposioTriggerStore::open(Client::new(), dir.path().join("composio-triggers.db"))
                .unwrap();
        assert_eq!(
            reopened
                .connect_targets("owner-a", &payload)
                .await
                .unwrap()
                .len(),
            2
        );
        assert_eq!(reopened.list().await.unwrap().len(), 4);
        assert!(reopened
            .remove_connect_target("owner-a", &a.id)
            .await
            .unwrap());
        assert_eq!(reopened.delete_for_workflow("workflow-a").await.unwrap(), 1);
        assert_eq!(
            reopened
                .connect_targets("owner-b", &payload)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(reopened.list().await.unwrap().len(), 2);
        assert!(reopened
            .connect_event_was_unbound("owner-a", &payload)
            .await
            .unwrap());
        assert!(!reopened
            .connect_event_was_unbound("owner-b", &payload)
            .await
            .unwrap());
        let rebound = reopened
            .bind_connect_target(
                "owner-a",
                &identity,
                "slack",
                ConnectTarget::Agent("agent-a"),
            )
            .await
            .unwrap();
        assert_ne!(rebound.id, a.id);
        assert_eq!(
            reopened
                .list_connect_targets("owner-a")
                .await
                .unwrap()
                .len(),
            1
        );
    }

    /// Serializes the two tests that mutate the process-global
    /// `COMPOSIO_WEBHOOK_SECRET` env var. cargo runs tests in one process in
    /// parallel, so without this one can clear the secret while the other has set
    /// it and is mid-verify. Poison-tolerant.
    static WEBHOOK_SECRET_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_webhook_secret() -> std::sync::MutexGuard<'static, ()> {
        WEBHOOK_SECRET_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn hmac_matches_known_vector() {
        // RFC 4231 Test Case 2: key="Jefe", data="what do ya want for nothing?".
        let mac = hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(
            mac,
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn verify_rejects_when_secret_unset() {
        // Serialize against the other webhook-secret test and restore on exit so
        // neither reads the other's transient value.
        let _lock = lock_webhook_secret();
        let prev = std::env::var(WEBHOOK_SECRET_ENV).ok();
        std::env::remove_var(WEBHOOK_SECRET_ENV);
        assert!(!verify_webhook_signature_at(
            b"{}",
            Some("msg_test"),
            Some("1735689600"),
            Some("v1,deadbeef"),
            1_735_689_600,
        ));
        match prev {
            Some(v) => std::env::set_var(WEBHOOK_SECRET_ENV, v),
            None => std::env::remove_var(WEBHOOK_SECRET_ENV),
        }
    }

    #[test]
    fn verify_accepts_valid_and_rejects_tampered() {
        let _lock = lock_webhook_secret();
        let prev = std::env::var(WEBHOOK_SECRET_ENV).ok();
        std::env::set_var(WEBHOOK_SECRET_ENV, "shhh");
        let body = b"hello";
        let id = "msg_test";
        let timestamp = "1735689600";
        let signature = "v1,/YUk2Hs+/BGr9UgXO4Z1HlNIb79STp+msEPmVUihovw=";
        assert!(verify_webhook_signature_at(
            body,
            Some(id),
            Some(timestamp),
            Some(signature),
            1_735_689_700,
        ));
        // Every signed component, the v1 format, and the replay window are
        // mandatory under Composio's current contract.
        assert!(!verify_webhook_signature_at(
            body,
            Some("msg_other"),
            Some(timestamp),
            Some(signature),
            1_735_689_700,
        ));
        assert!(!verify_webhook_signature_at(
            body,
            Some(id),
            Some(timestamp),
            Some(signature),
            1_735_690_000,
        ));
        assert!(!verify_webhook_signature_at(
            body,
            Some(id),
            Some(timestamp),
            Some("/YUk2Hs+/BGr9UgXO4Z1HlNIb79STp+msEPmVUihovw="),
            1_735_689_700,
        ));
        assert!(!verify_webhook_signature_at(
            b"tampered",
            Some(id),
            Some(timestamp),
            Some(signature),
            1_735_689_700,
        ));
        match prev {
            Some(v) => std::env::set_var(WEBHOOK_SECRET_ENV, v),
            None => std::env::remove_var(WEBHOOK_SECRET_ENV),
        }
    }

    #[test]
    fn workflow_webhook_verify_uses_per_trigger_secret() {
        let body = br#"{"event":"deploy"}"#;
        let sig = hmac_sha256_hex(b"per-wf-secret", body);
        // Correct per-trigger secret + any accepted spelling verifies.
        assert!(verify_workflow_webhook_signature(
            "per-wf-secret",
            body,
            Some(&sig)
        ));
        assert!(verify_workflow_webhook_signature(
            "per-wf-secret",
            body,
            Some(&format!("sha256={sig}"))
        ));
        // A different secret, a wrong signature, an absent header, and a mutated
        // body all reject (fail-closed, independent of the global Composio secret).
        assert!(!verify_workflow_webhook_signature(
            "other",
            body,
            Some(&sig)
        ));
        assert!(!verify_workflow_webhook_signature(
            "per-wf-secret",
            body,
            Some("00")
        ));
        assert!(!verify_workflow_webhook_signature(
            "per-wf-secret",
            body,
            None
        ));
        assert!(!verify_workflow_webhook_signature(
            "per-wf-secret",
            br#"{"event":"other"}"#,
            Some(&sig)
        ));
    }

    #[test]
    fn workflow_v3_signature_binds_workflow_timestamp_id_and_body() {
        let body = br#"{"event":"deploy"}"#;
        let workflow_id = "workflow-a";
        let timestamp = "1735689600";
        let id = "delivery-1";
        let mut signed =
            format!("ryu-workflow-webhook-v3\n{workflow_id}\n{timestamp}\n{id}\n").into_bytes();
        signed.extend_from_slice(body);
        let signature = format!("v3,{}", hmac_sha256_hex(b"per-wf-secret", &signed));
        let verify = |workflow_id: &str, body: &[u8], timestamp: &str, id: &str, now: u64| {
            verify_workflow_webhook_signature_v3(
                "per-wf-secret",
                workflow_id,
                body,
                Some(&signature),
                Some(timestamp),
                Some(id),
                now,
            )
        };
        assert!(verify(workflow_id, body, timestamp, id, 1_735_689_600));
        assert!(!verify("workflow-b", body, timestamp, id, 1_735_689_600));
        assert!(!verify(
            workflow_id,
            body,
            timestamp,
            "delivery-2",
            1_735_689_600
        ));
        assert!(!verify(workflow_id, body, "1735689601", id, 1_735_689_601));
        assert!(!verify(
            workflow_id,
            br#"{"event":"other"}"#,
            timestamp,
            id,
            1_735_689_600
        ));
        assert!(!verify(workflow_id, body, timestamp, id, 1_735_690_000));
        assert!(!verify_workflow_webhook_signature_v3(
            "per-wf-secret",
            workflow_id,
            body,
            Some(&signature[3..]),
            Some(timestamp),
            Some(id),
            1_735_689_600,
        ));
        let legacy = format!("v2,{}", signature.trim_start_matches("v3,"));
        assert!(!verify_workflow_webhook_signature_v3(
            "per-wf-secret",
            workflow_id,
            body,
            Some(&legacy),
            Some(timestamp),
            Some(id),
            1_735_689_600,
        ));
    }

    // --- Store + webhook-dispatch tests ---------------------------------------
    //
    // The trigger store's `subscribe*` path is the ONE composio HTTP leg reachable
    // from a hermetic loopback: it builds its URL from the *unvalidated*
    // `catalog::base_url()` (unlike catalog/connect/execute, which pin https + an
    // allowlisted host and so cannot be pointed at a plaintext mock). We drive it
    // end-to-end against a raw `std::net::TcpListener` (the sibling `core/usage`
    // idiom), a temp SQLite DB, and a set-once mock `ComposioHost`.

    use std::io::{Read, Write};

    /// Records every host fan-out. The `ComposioHost` slot is a set-once
    /// `OnceLock`, so a single process-global mock + call log serves the whole
    /// binary; the webhook test that uses it holds `test_env_lock` for its whole
    /// body, so there is no cross-test race on this log.
    static HOST_CALLS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

    struct RecordingHost;

    #[async_trait::async_trait]
    impl crate::host::ComposioHost for RecordingHost {
        async fn run_workflow_for_trigger(
            &self,
            workflow_id: &str,
            payload_json: &str,
        ) -> Result<String> {
            HOST_CALLS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((format!("workflow:{workflow_id}"), payload_json.to_string()));
            if workflow_id == "FAIL-WF" {
                return Err(anyhow!("simulated workflow failure"));
            }
            Ok(format!("run_wf_{workflow_id}"))
        }

        async fn run_agent(&self, agent_id: &str, prompt: &str) -> Result<String> {
            HOST_CALLS
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((format!("agent:{agent_id}"), prompt.to_string()));
            if agent_id == "FAIL-AGENT" {
                return Err(anyhow!("simulated agent failure"));
            }
            Ok(format!("run_ag_{agent_id}"))
        }

        /// Mirrors Core's entity rule without an agent store: a user account
        /// always passes; an own-entity account must end in `:<agent_id>`.
        async fn agent_may_receive(
            &self,
            agent_id: &str,
            _connected_account_id: &str,
            account_entity: &str,
        ) -> Result<bool> {
            Ok(account_entity.is_empty()
                || (account_entity.starts_with("agent:")
                    && account_entity.ends_with(&format!(":{agent_id}"))))
        }
    }

    fn host_calls() -> Vec<(String, String)> {
        HOST_CALLS.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    fn clear_host_calls() {
        HOST_CALLS.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }

    /// True once the buffer holds a full HTTP request (headers + declared body).
    fn request_complete(buf: &[u8]) -> bool {
        let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
            return false;
        };
        let head = String::from_utf8_lossy(&buf[..pos]).to_ascii_lowercase();
        let content_length = head
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse::<usize>().ok())
            .unwrap_or(0);
        buf.len() - (pos + 4) >= content_length
    }

    /// A hermetic loopback HTTP/1.1 server that serves `status_line` + `body` to
    /// every request on a detached thread. Returns its `http://127.0.0.1:port`
    /// base (no trailing slash) to point `COMPOSIO_BASE_URL` at.
    fn spawn_mock(status_line: &'static str, body: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("addr");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
                // Drain the request (headers + body) so the client's write side
                // completes before we reply and close (avoids a RST).
                let mut req: Vec<u8> = Vec::new();
                let mut tmp = [0u8; 2048];
                loop {
                    match stream.read(&mut tmp) {
                        Ok(0) => break,
                        Ok(n) => {
                            req.extend_from_slice(&tmp[..n]);
                            if request_complete(&req) {
                                break;
                            }
                        }
                        Err(_) => break, // read timeout / would-block
                    }
                }
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}")
    }

    fn spawn_mock_sequence(
        responses: Vec<(&'static str, String)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("addr");
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = std::sync::Arc::clone(&requests);
        std::thread::spawn(move || {
            for ((status_line, body), stream) in responses.into_iter().zip(listener.incoming()) {
                let Ok(mut stream) = stream else { break };
                let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
                let mut request = Vec::new();
                let mut chunk = [0_u8; 2048];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(read) => {
                            request.extend_from_slice(&chunk[..read]);
                            if request_complete(&request) {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                recorded
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .push(String::from_utf8_lossy(&request).into_owned());
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (format!("http://{addr}"), requests)
    }

    /// Snapshot of the shared env this suite mutates, restored on drop-in.
    fn base_url_snapshot() -> Option<String> {
        std::env::var("COMPOSIO_BASE_URL").ok()
    }
    fn restore_env(prev_base: Option<String>) {
        // Clear the key cache we set and put COMPOSIO_BASE_URL back.
        crate::auth::set_key("");
        match prev_base {
            Some(v) => std::env::set_var("COMPOSIO_BASE_URL", v),
            None => std::env::remove_var("COMPOSIO_BASE_URL"),
        }
    }

    async fn temp_store() -> (ComposioTriggerStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("composio-triggers.db");
        let store = ComposioTriggerStore::open(Client::new(), db).expect("open store");
        (store, dir)
    }

    #[tokio::test]
    async fn subscribe_persists_agent_target_and_lists_newest_first() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        let base = spawn_mock("200 OK", r#"{"trigger_id":"trig_abc"}"#.to_string());
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);

        let (store, _dir) = temp_store().await;
        assert!(store.list().await.unwrap().is_empty());

        let sub = store
            .subscribe(
                "agent-1",
                "slack",
                "SLACK_MSG",
                "ca_1",
                json!({ "channel": "C1" }),
            )
            .await
            .expect("subscribe");
        assert_eq!(sub.agent_id, "agent-1");
        assert_eq!(sub.toolkit, "slack");
        assert_eq!(sub.trigger_slug, "SLACK_MSG");
        assert_eq!(sub.target_kind, "agent");
        assert!(sub.workflow_id.is_none());
        // The instance id is parsed defensively from the upsert response.
        assert_eq!(sub.composio_trigger_id.as_deref(), Some("trig_abc"));
        assert!(sub.id.starts_with("ctrig_"));

        let all = store.list().await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].id, sub.id);
        restore_env(prev);
    }

    #[tokio::test]
    async fn subscribe_errors_on_upstream_failure_and_persists_nothing() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        let base = spawn_mock("400 Bad Request", r#"{"error":"bad config"}"#.to_string());
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);

        let (store, _dir) = temp_store().await;
        let err = store
            .subscribe("agent-1", "slack", "SLACK_MSG", "ca_1", json!({}))
            .await
            .expect_err("upstream 400 must surface");
        assert!(err.to_string().contains("trigger upsert"));
        // A failed upsert never writes a row.
        assert!(store.list().await.unwrap().is_empty());
        restore_env(prev);
    }

    #[tokio::test]
    async fn subscribe_requires_a_key() {
        let _lock = crate::auth::test_env_lock();
        let prev_r = std::env::var("RYU_COMPOSIO_API_KEY").ok();
        let prev_c = std::env::var("COMPOSIO_API_KEY").ok();
        crate::auth::set_key("");
        std::env::remove_var("RYU_COMPOSIO_API_KEY");
        std::env::remove_var("COMPOSIO_API_KEY");

        let (store, _dir) = temp_store().await;
        let err = store
            .subscribe("agent-1", "slack", "SLACK_MSG", "ca_1", json!({}))
            .await
            .expect_err("no key must error before HTTP");
        assert!(err.to_string().contains("API key not set"));

        match prev_r {
            Some(v) => std::env::set_var("RYU_COMPOSIO_API_KEY", v),
            None => std::env::remove_var("RYU_COMPOSIO_API_KEY"),
        }
        match prev_c {
            Some(v) => std::env::set_var("COMPOSIO_API_KEY", v),
            None => std::env::remove_var("COMPOSIO_API_KEY"),
        }
    }

    #[tokio::test]
    async fn delete_reports_match_and_removes_row() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        // 200 for the upsert AND the best-effort remote-disable DELETE.
        let base = spawn_mock("200 OK", r#"{"trigger_id":"trig_del"}"#.to_string());
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);

        let (store, _dir) = temp_store().await;
        let sub = store
            .subscribe("agent-x", "github", "GH_PUSH", "ca_9", json!({}))
            .await
            .unwrap();

        // Deleting a non-existent id reports false and removes nothing.
        assert!(!store.delete("ctrig_missing").await.unwrap());
        assert_eq!(store.list().await.unwrap().len(), 1);

        // Deleting the real row reports true (and best-effort-disables remotely).
        assert!(store.delete(&sub.id).await.unwrap());
        assert!(store.list().await.unwrap().is_empty());
        restore_env(prev);
    }

    #[tokio::test]
    async fn workflow_subscriptions_filter_and_bulk_delete() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        let base = spawn_mock("200 OK", r#"{"id":"trig_wf"}"#.to_string());
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);

        let (store, _dir) = temp_store().await;
        // Two workflow subs on wf-1, one agent sub, one workflow sub on wf-2.
        store
            .subscribe_workflow("wf-1", "slack", "SLACK_MSG", "ca_1", json!({}))
            .await
            .unwrap();
        store
            .subscribe_workflow("wf-1", "github", "GH_PUSH", "ca_2", json!({}))
            .await
            .unwrap();
        store
            .subscribe("agent-a", "gmail", "MAIL_IN", "ca_3", json!({}))
            .await
            .unwrap();
        store
            .subscribe_workflow("wf-2", "linear", "ISSUE_NEW", "ca_4", json!({}))
            .await
            .unwrap();

        let for_wf1 = store.list_for_workflow("wf-1").await;
        assert_eq!(for_wf1.len(), 2);
        assert!(for_wf1.iter().all(|s| s.target_kind == "workflow"));
        assert!(for_wf1
            .iter()
            .all(|s| s.workflow_id.as_deref() == Some("wf-1")));
        assert!(store.list_for_workflow("does-not-exist").await.is_empty());

        // Bulk delete only wf-1's two rows.
        let removed = store.delete_for_workflow("wf-1").await.unwrap();
        assert_eq!(removed, 2);
        assert!(store.list_for_workflow("wf-1").await.is_empty());
        // The agent sub and wf-2 sub survive.
        assert_eq!(store.list().await.unwrap().len(), 2);
        restore_env(prev);
    }

    #[tokio::test]
    async fn open_migrates_legacy_table_missing_columns() {
        // A DB created before target_kind/workflow_id existed must be ALTERed in
        // place (the guarded migration), not rejected, and its rows default to the
        // agent target.
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("legacy.db");
        {
            let conn = rusqlite::Connection::open(&db).expect("open legacy");
            conn.execute_batch(
                "CREATE TABLE subscriptions (
                     id                   TEXT PRIMARY KEY,
                     agent_id             TEXT NOT NULL,
                     toolkit              TEXT NOT NULL,
                     trigger_slug         TEXT NOT NULL,
                     connected_account_id TEXT NOT NULL,
                     composio_trigger_id  TEXT,
                     created_at           TEXT NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO subscriptions
                    (id, agent_id, toolkit, trigger_slug, connected_account_id, created_at)
                 VALUES ('old1','ag','slack','SLACK_MSG','ca','2020-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        let store = ComposioTriggerStore::open(Client::new(), db.clone()).expect("open migrates");
        let rows = store.list().await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "old1");
        assert_eq!(rows[0].target_kind, "agent");
        assert!(rows[0].workflow_id.is_none());

        // Re-opening is idempotent (columns already present → no ALTER, no error).
        let store2 = ComposioTriggerStore::open(Client::new(), db).expect("reopen idempotent");
        assert_eq!(store2.list().await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn handle_webhook_dispatches_agent_and_workflow_and_reports_failures() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        let base = spawn_mock("200 OK", r#"{"trigger_id":"trig_hook"}"#.to_string());
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);
        crate::host::set_global_host(std::sync::Arc::new(RecordingHost));

        let (store, _dir) = temp_store().await;
        store
            .subscribe("agent-1", "slack", "SLACK_MSG", "ca_1", json!({}))
            .await
            .unwrap();
        store
            .subscribe_workflow("wf-1", "github", "GH_PUSH", "ca_2", json!({}))
            .await
            .unwrap();
        store
            .subscribe("FAIL-AGENT", "gmail", "MAIL_IN", "ca_3", json!({}))
            .await
            .unwrap();

        // Agent fire, matched by slug (case-insensitive).
        clear_host_calls();
        let fired = store
            .handle_webhook(&json!({ "trigger_slug": "slack_msg", "payload": { "text": "hi" } }))
            .await;
        assert_eq!(fired, 1);
        let calls = host_calls();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "agent:agent-1");
        assert!(calls[0].1.contains("SLACK_MSG"));
        assert!(calls[0].1.contains("slack"));

        // Workflow fire, matched by an alternate slug key; payload injected raw.
        clear_host_calls();
        let fired = store
            .handle_webhook(&json!({ "triggerName": "GH_PUSH", "ref": "main" }))
            .await;
        assert_eq!(fired, 1);
        let calls = host_calls();
        assert_eq!(calls[0].0, "workflow:wf-1");
        assert!(calls[0].1.contains("\"ref\":\"main\""));

        // A host failure is swallowed and not counted as fired.
        clear_host_calls();
        let fired = store
            .handle_webhook(&json!({ "trigger_slug": "MAIL_IN" }))
            .await;
        assert_eq!(fired, 0);
        assert_eq!(host_calls()[0].0, "agent:FAIL-AGENT");

        // No matching subscription → nothing fires (no trigger_id, unknown slug).
        clear_host_calls();
        let fired = store
            .handle_webhook(&json!({ "trigger_slug": "UNKNOWN_EVENT" }))
            .await;
        assert_eq!(fired, 0);
        assert!(host_calls().is_empty());

        restore_env(prev);
    }

    #[tokio::test]
    async fn handle_webhook_matches_by_composio_trigger_id() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        let base = spawn_mock("200 OK", r#"{"trigger_id":"trig_unique"}"#.to_string());
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);
        crate::host::set_global_host(std::sync::Arc::new(RecordingHost));

        let (store, _dir) = temp_store().await;
        store
            .subscribe("agent-id-match", "slack", "SLACK_MSG", "ca_1", json!({}))
            .await
            .unwrap();

        // A payload carrying only the Composio trigger id (no slug) still matches.
        clear_host_calls();
        let fired = store
            .handle_webhook(&json!({ "trigger_id": "trig_unique" }))
            .await;
        assert_eq!(fired, 1);
        assert_eq!(host_calls()[0].0, "agent:agent-id-match");
        restore_env(prev);
    }

    #[tokio::test]
    async fn handle_webhook_fires_only_the_instance_that_fired_when_slugs_are_shared() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        crate::host::set_global_host(std::sync::Arc::new(RecordingHost));

        let (store, _dir) = temp_store().await;
        {
            let conn = store.conn.lock().await;
            for (id, agent, account, instance) in [
                ("sub_x", "agent-repo-x", "ca_x", Some("ti_1")),
                ("sub_y", "agent-repo-y", "ca_y", Some("ti_2")),
                ("sub_old", "agent-unbound", "ca_z", None),
            ] {
                conn.execute(
                    "INSERT INTO subscriptions(id,agent_id,toolkit,trigger_slug,connected_account_id,composio_trigger_id,created_at) VALUES(?,?,'github','GITHUB_COMMIT_EVENT',?,?,'now')",
                    params![id, agent, account, instance],
                )
                .unwrap();
            }
        }

        // The instance id selects exactly its own row.
        clear_host_calls();
        let fired = store
            .handle_webhook(&json!({"metadata":{"trigger_id":"ti_1","trigger_slug":"GITHUB_COMMIT_EVENT"},"data":{}}))
            .await;
        assert_eq!(fired, 1);
        assert_eq!(host_calls()[0].0, "agent:agent-repo-x");

        // An unknown instance falls back to the slug only for rows without one.
        clear_host_calls();
        let fired = store
            .handle_webhook(&json!({"metadata":{"trigger_id":"ti_gone","trigger_slug":"GITHUB_COMMIT_EVENT"},"data":{}}))
            .await;
        assert_eq!(fired, 1);
        assert_eq!(host_calls()[0].0, "agent:agent-unbound");
        restore_env(prev);
    }

    #[tokio::test]
    async fn reconcile_webhook_subscription_creates_v3_project_subscription() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        let (base, requests) = spawn_mock_sequence(vec![
            ("200 OK", r#"{"items":[]}"#.to_string()),
            (
                "201 Created",
                r#"{"id":"ws_new","webhook_url":"https://relay.example/api/composio/webhook","version":"V3","enabled_events":["composio.trigger.message"],"secret":"whsec_new"}"#.to_string(),
            ),
        ]);
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);

        let (store, _dir) = temp_store().await;
        let secret = store
            .reconcile_webhook_subscription("https://relay.example/api/composio/webhook")
            .await
            .expect("reconcile");
        assert_eq!(secret, "whsec_new");

        let requests = requests.lock().unwrap_or_else(|error| error.into_inner());
        assert!(requests[0].starts_with("GET /webhook_subscriptions "));
        assert!(requests[1].starts_with("POST /webhook_subscriptions "));
        assert!(requests[1].contains("\"version\":\"V3\""));
        assert!(requests[1].contains("\"enabled_events\":[\"composio.trigger.message\"]"));

        restore_env(prev);
    }

    #[tokio::test]
    async fn reconcile_webhook_subscription_updates_drift_and_preserves_events() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        let (base, requests) = spawn_mock_sequence(vec![
            (
                "200 OK",
                r#"{"items":[{"id":"ws_existing","webhook_url":"https://old.example/hook","version":"V1","enabled_events":["composio.connected_account.expired"],"secret":"whsec_existing"}]}"#.to_string(),
            ),
            (
                "200 OK",
                r#"{"id":"ws_existing","webhook_url":"https://relay.example/api/composio/webhook","version":"V3","enabled_events":["composio.connected_account.expired","composio.trigger.message"],"secret":"whsec_existing"}"#.to_string(),
            ),
        ]);
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);

        let (store, _dir) = temp_store().await;
        let secret = store
            .reconcile_webhook_subscription("https://relay.example/api/composio/webhook")
            .await
            .expect("reconcile");
        assert_eq!(secret, "whsec_existing");

        let requests = requests.lock().unwrap_or_else(|error| error.into_inner());
        assert!(requests[1].starts_with("PATCH /webhook_subscriptions/ws_existing "));
        assert!(requests[1].contains("composio.connected_account.expired"));
        assert!(requests[1].contains("composio.trigger.message"));
        assert!(requests[1].contains("\"version\":\"V3\""));

        restore_env(prev);
    }

    #[tokio::test]
    async fn reconcile_prefers_stored_secret_over_a_stale_environment_override() {
        let _env_lock = crate::auth::test_env_lock();
        let _lock = lock_webhook_secret();
        let prev_base = base_url_snapshot();
        let prev_secret = std::env::var(WEBHOOK_SECRET_ENV).ok();
        let (base, _requests) = spawn_mock_sequence(vec![(
            "200 OK",
            r#"{"items":[{"id":"ws_existing","webhook_url":"https://relay.example/api/composio/webhook","version":"V3","enabled_events":["composio.trigger.message"]}]}"#.to_string(),
        )]);
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);
        std::env::set_var(WEBHOOK_SECRET_ENV, "stale_environment_secret");
        set_stored_webhook_secret(Some("current_provider_secret".to_owned()));

        let (store, _dir) = temp_store().await;
        let secret = store
            .reconcile_webhook_subscription("https://relay.example/api/composio/webhook")
            .await
            .expect("reconcile");
        assert_eq!(secret, "current_provider_secret");

        set_stored_webhook_secret(None);
        match prev_secret {
            Some(value) => std::env::set_var(WEBHOOK_SECRET_ENV, value),
            None => std::env::remove_var(WEBHOOK_SECRET_ENV),
        }
        restore_env(prev_base);
    }

    #[tokio::test]
    async fn handle_webhook_matches_v3_nested_trigger_metadata() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        let base = spawn_mock("200 OK", r#"{"trigger_id":"ti_xyz789"}"#.to_string());
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);
        crate::host::set_global_host(std::sync::Arc::new(RecordingHost));

        let (store, _dir) = temp_store().await;
        store
            .subscribe(
                "agent-v3",
                "github",
                "GITHUB_COMMIT_EVENT",
                "ca_1",
                json!({}),
            )
            .await
            .unwrap();

        clear_host_calls();
        let fired = store
            .handle_webhook(&json!({
                "id": "msg_abc123",
                "type": "composio.trigger.message",
                "metadata": {
                    "trigger_id": "ti_xyz789",
                    "trigger_slug": "GITHUB_COMMIT_EVENT"
                },
                "data": { "message": "fix webhook handling" }
            }))
            .await;
        assert_eq!(fired, 1);
        assert_eq!(host_calls()[0].0, "agent:agent-v3");

        restore_env(prev);
    }

    /// Insert a legacy row directly, so each one has its own instance id.
    async fn insert_legacy_row(
        store: &ComposioTriggerStore,
        id: &str,
        agent_id: &str,
        trigger_id: &str,
        account: &str,
        entity: &str,
    ) {
        store
            .conn
            .lock()
            .await
            .execute(
                "INSERT INTO subscriptions(id,agent_id,toolkit,trigger_slug,connected_account_id,composio_trigger_id,target_kind,created_at,provider_user_id) VALUES(?1,?2,'gmail','GMAIL_NEW',?3,?4,'agent',?1,?5)",
                params![id, agent_id, account, trigger_id, entity],
            )
            .unwrap();
    }

    #[tokio::test]
    async fn subscribe_own_account_records_the_agent_entity() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        let base = spawn_mock("200 OK", r#"{"trigger_id":"trig_own"}"#.to_string());
        crate::auth::set_key("comp_key");
        std::env::set_var("COMPOSIO_BASE_URL", &base);

        let (store, _dir) = temp_store().await;
        // A malformed or foreign entity is refused before anything is stored.
        for (agent, entity) in [
            ("a1", ""),
            ("a1", "agent:"),
            ("a1", "default"),
            ("a1", "agent:u1:a2"),
            ("a1", "agent:u1 :a1"),
            ("", "agent:u1:"),
        ] {
            assert!(
                store
                    .subscribe_own_account(agent, entity, "gmail", "GMAIL_NEW", "own_1", json!({}))
                    .await
                    .is_err(),
                "{agent} / {entity}"
            );
        }
        assert!(store.list().await.unwrap().is_empty());

        let sub = store
            .subscribe_own_account(
                "a1",
                "agent:u1:a1",
                "gmail",
                "GMAIL_NEW",
                "own_1",
                json!({}),
            )
            .await
            .expect("subscribe own account");
        assert!(sub.own_account);
        assert_eq!(sub.account_entity, "agent:u1:a1");
        let listed = store.list().await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].account_entity, "agent:u1:a1");
        assert!(listed[0].own_account);
        // The listing names the account as the agent's own, never its owner.
        let wire = serde_json::to_value(&listed[0]).unwrap();
        assert_eq!(wire["own_account"], json!(true));
        assert!(wire.get("account_entity").is_none());
        assert!(!wire.to_string().contains("u1"));

        // A user-account subscription keeps an empty entity.
        let user = store
            .subscribe("a1", "gmail", "GMAIL_NEW", "ca_user", json!({}))
            .await
            .unwrap();
        assert!(!user.own_account);
        assert!(user.account_entity.is_empty());
        restore_env(prev);
    }

    #[tokio::test]
    async fn own_account_rows_fire_only_on_their_own_instance_and_entity() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        crate::host::set_global_host(std::sync::Arc::new(RecordingHost));
        let (store, _dir) = temp_store().await;
        insert_legacy_row(&store, "own", "a1", "ti_own", "own_1", "agent:u1:a1").await;
        // A row whose recorded entity is another agent's is refused by the host.
        insert_legacy_row(
            &store,
            "foreign",
            "a2",
            "ti_foreign",
            "own_9",
            "agent:u1:a1",
        )
        .await;

        // A slug-only payload never fires an own-account row.
        clear_host_calls();
        assert_eq!(
            store
                .handle_webhook(&json!({ "trigger_slug": "GMAIL_NEW" }))
                .await,
            0
        );
        assert!(host_calls().is_empty());

        // The exact instance id fires it.
        clear_host_calls();
        assert_eq!(
            store
                .handle_webhook(&json!({ "metadata": { "trigger_id": "ti_own" } }))
                .await,
            1
        );
        assert_eq!(host_calls()[0].0, "agent:a1");

        // ...and so does full V3 metadata that names the row's own account.
        clear_host_calls();
        let own_event = json!({ "metadata": {
            "trigger_id": "ti_own",
            "connected_account_id": "own_1",
            "user_id": "agent:u1:a1",
        } });
        assert_eq!(store.handle_webhook(&own_event).await, 1);

        // Metadata naming another account or another entity does not fire.
        for metadata in [
            json!({ "trigger_id": "ti_own", "connected_account_id": "own_2" }),
            json!({ "trigger_id": "ti_own", "user_id": "agent:u1:a2" }),
            json!({ "trigger_id": "ti_own", "user_id": "default" }),
        ] {
            clear_host_calls();
            assert_eq!(
                store.handle_webhook(&json!({ "metadata": metadata })).await,
                0,
                "{metadata}"
            );
            assert!(host_calls().is_empty());
        }

        // The host refuses an entity that is not the row's agent's own.
        clear_host_calls();
        assert_eq!(
            store
                .handle_webhook(&json!({ "metadata": { "trigger_id": "ti_foreign" } }))
                .await,
            0
        );
        assert!(host_calls().is_empty());
        restore_env(prev);
    }

    #[tokio::test]
    async fn own_account_events_never_reach_user_rows_by_slug() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        crate::host::set_global_host(std::sync::Arc::new(RecordingHost));
        let (store, _dir) = temp_store().await;
        insert_legacy_row(&store, "own_b", "b", "ti_b", "own_b", "agent:u1:b").await;
        insert_legacy_row(&store, "user_a", "a", "ti_user", "ca_user", "").await;
        store
            .conn
            .lock()
            .await
            .execute(
                "INSERT INTO subscriptions(id,agent_id,toolkit,trigger_slug,connected_account_id,composio_trigger_id,target_kind,workflow_id,created_at) VALUES('user_wf','','gmail','GMAIL_NEW','ca_user','ti_wf','workflow','wf-1','wf')",
                [],
            )
            .unwrap();

        // Agent B's own-account event carries the shared slug; it fires only
        // B's own row, never the user's agent or workflow rows.
        for metadata in [
            json!({ "trigger_id": "ti_b", "trigger_slug": "GMAIL_NEW",
                    "connected_account_id": "own_b", "user_id": "agent:u1:b" }),
            json!({ "trigger_id": "ti_b", "trigger_slug": "GMAIL_NEW" }),
        ] {
            clear_host_calls();
            assert_eq!(
                store.handle_webhook(&json!({ "metadata": metadata })).await,
                1,
                "{metadata}"
            );
            assert_eq!(host_calls().len(), 1);
            assert_eq!(host_calls()[0].0, "agent:b");
        }

        // An unknown instance from an agent entity or another account fires
        // nothing by slug.
        for metadata in [
            json!({ "trigger_id": "ti_x", "trigger_slug": "GMAIL_NEW", "user_id": "agent:u1:c" }),
            json!({ "trigger_id": "ti_x", "trigger_slug": "GMAIL_NEW", "connected_account_id": "ca_other" }),
        ] {
            clear_host_calls();
            assert_eq!(
                store.handle_webhook(&json!({ "metadata": metadata })).await,
                0,
                "{metadata}"
            );
            assert!(host_calls().is_empty());
        }

        // A slug-only event from the user's own account still fires both
        // user rows.
        clear_host_calls();
        assert_eq!(
            store
                .handle_webhook(&json!({ "metadata": {
                    "trigger_slug": "GMAIL_NEW", "connected_account_id": "ca_user"
                } }))
                .await,
            2
        );
        restore_env(prev);
    }

    #[tokio::test]
    async fn delete_for_connected_account_removes_only_that_accounts_rows() {
        let _lock = crate::auth::test_env_lock();
        let prev = base_url_snapshot();
        // No key: remote teardown is skipped, local rows still go.
        crate::auth::set_key("");
        let (store, _dir) = temp_store().await;
        insert_legacy_row(&store, "own_a", "a1", "ti_1", "own_1", "agent:u1:a1").await;
        insert_legacy_row(&store, "own_b", "a1", "ti_2", "own_1", "agent:u1:a1").await;
        insert_legacy_row(
            &store,
            "other_account",
            "a1",
            "ti_3",
            "own_2",
            "agent:u1:a1",
        )
        .await;
        insert_legacy_row(&store, "other_entity", "a2", "ti_4", "own_1", "agent:u1:a2").await;
        insert_legacy_row(&store, "user", "a1", "ti_5", "own_1", "").await;

        assert_eq!(
            store
                .delete_for_connected_account("agent:u1:a1", " ")
                .await
                .unwrap(),
            0
        );
        assert_eq!(
            store
                .delete_for_connected_account("agent:u1:a1", "own_1")
                .await
                .unwrap(),
            2
        );
        let mut left: Vec<String> = store
            .list()
            .await
            .unwrap()
            .into_iter()
            .map(|s| s.id)
            .collect();
        left.sort();
        assert_eq!(left, ["other_account", "other_entity", "user"]);
        restore_env(prev);
    }
}
