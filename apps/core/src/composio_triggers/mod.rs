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
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::sidecar::download_manager::ryu_dir;
use crate::workflow::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};

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

fn db_path() -> PathBuf {
    ryu_dir().join("composio-triggers.db")
}

/// Env var holding the Composio webhook signing secret. The inbound public
/// webhook route authenticates each delivery with an HMAC-SHA256 over the raw
/// body keyed by this secret (Composio's webhook signing secret). Nothing is
/// hardcoded — when unset the route fails closed (rejects every request).
const WEBHOOK_SECRET_ENV: &str = "COMPOSIO_WEBHOOK_SECRET";

/// The configured webhook signing secret, if any.
pub fn webhook_secret() -> Option<String> {
    std::env::var(WEBHOOK_SECRET_ENV)
        .ok()
        .filter(|s| !s.trim().is_empty())
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

/// Compute HMAC-SHA256(key, message) and return it lowercase-hex encoded. Uses
/// the standard HMAC construction over `sha2::Sha256` (already a Core dep) so no
/// new crate is pulled in.
pub(crate) fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    use sha2::{Digest, Sha256};

    const BLOCK_SIZE: usize = 64;
    // Keys longer than the block size are hashed down first.
    let mut block_key = [0u8; BLOCK_SIZE];
    if key.len() > BLOCK_SIZE {
        let hashed = Sha256::digest(key);
        block_key[..hashed.len()].copy_from_slice(&hashed);
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK_SIZE];
    let mut opad = [0x5cu8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        ipad[i] ^= block_key[i];
        opad[i] ^= block_key[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_digest);
    hex::encode(outer.finalize())
}

/// Verify a Composio webhook signature over the **raw** request body, FAIL
/// CLOSED. Returns `true` only when a secret is configured AND the provided
/// signature matches HMAC-SHA256(secret, raw_body). Composio (Svix-style) sends
/// a `webhook-signature` header of space-separated `v1,<base64>` entries; we
/// also accept a bare hex digest and an optional `sha256=` prefix so the check
/// works across signing-scheme spellings. When the secret is unset, or the
/// header is absent/empty, or no entry matches, the request is rejected.
///
/// `raw_body` MUST be the exact bytes received (not a re-serialized JSON value),
/// otherwise the HMAC will never match.
pub fn verify_webhook_signature(raw_body: &[u8], signature_header: Option<&str>) -> bool {
    let Some(secret) = webhook_secret() else {
        return false;
    };
    let Some(header) = signature_header.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let expected_hex = hmac_sha256_hex(secret.as_bytes(), raw_body);
    // Each header token may be `v1,<sig>`, `sha256=<sig>`, or a bare `<sig>`.
    header.split_whitespace().any(|token| {
        let candidate = token
            .rsplit(',')
            .next()
            .unwrap_or(token)
            .trim_start_matches("sha256=");
        constant_time_eq(candidate.as_bytes(), expected_hex.as_bytes())
    })
}

/// Verify an inbound **per-workflow** webhook POST against a trigger-specific
/// secret (`WorkflowTrigger::Webhook.secret`), independent of the global Composio
/// webhook secret. Same header spellings and fail-closed semantics as
/// [`verify_webhook_signature`]: the header may carry `v1,<sig>`, `sha256=<hex>`,
/// or a bare hex digest; an absent/empty header or a mismatch is rejected. The
/// caller is responsible for refusing to fire when the trigger has no secret at
/// all — this reuses the same constant-time HMAC-SHA256 check over the raw bytes.
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

impl ComposioTriggerStore {
    /// Open (creating if needed) the triggers DB under `~/.ryu/composio-triggers.db`.
    pub fn open(http: Client) -> Result<Self> {
        let path = db_path();
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
        Ok(())
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
        toolkit: &str,
        trigger_slug: &str,
        connected_account_id: &str,
        config: Value,
    ) -> Result<TriggerSubscription> {
        let key = crate::composio_auth::key()
            .ok_or_else(|| anyhow!("Composio API key not set (Settings → Integrations)"))?;
        let url = format!(
            "{}/trigger_instances/{}/upsert",
            crate::composio_catalog::base_url(),
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
                     composio_trigger_id, target_kind, workflow_id, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
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
        })
    }

    /// All subscriptions, newest first.
    pub async fn list(&self) -> Result<Vec<TriggerSubscription>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, toolkit, trigger_slug, connected_account_id,
                    composio_trigger_id, target_kind, workflow_id, created_at
             FROM subscriptions ORDER BY created_at DESC",
        )?;
        let rows = stmt
            .query_map([], |row| {
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
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Best-effort remote teardown of a Composio trigger *instance* so a removed
    /// subscription stops the remote from firing into the void. Never fails the
    /// caller: a missing key, an absent instance id, or an API error are logged
    /// and swallowed (the local row is still deleted by the caller).
    async fn remote_disable(&self, composio_trigger_id: Option<&str>) {
        let Some(trigger_id) = composio_trigger_id else {
            return;
        };
        let Some(key) = crate::composio_auth::key() else {
            return;
        };
        let url = format!(
            "{}/trigger_instances/manage/{}",
            crate::composio_catalog::base_url(),
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
        let trigger_id: Option<String> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT composio_trigger_id FROM subscriptions WHERE id = ?1",
                params![id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
        };
        self.remote_disable(trigger_id.as_deref()).await;
        let conn = self.conn.lock().await;
        let n = conn.execute("DELETE FROM subscriptions WHERE id = ?1", params![id])?;
        Ok(n > 0)
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
    /// number of rows removed. Used by reconcile + workflow delete. Best-effort
    /// remote teardown: each removed instance is disabled on Composio first so it
    /// stops firing into the void (an orphaned remote trigger whose local mapping
    /// is gone).
    pub async fn delete_for_workflow(&self, workflow_id: &str) -> Result<usize> {
        // Disable the remote instances before dropping the local rows.
        for sub in self.list_for_workflow(workflow_id).await {
            self.remote_disable(sub.composio_trigger_id.as_deref())
                .await;
        }
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "DELETE FROM subscriptions WHERE target_kind = 'workflow' AND workflow_id = ?1",
            params![workflow_id],
        )?;
        Ok(n)
    }

    /// Subscriptions matching a fired event, by Composio trigger id (preferred) or
    /// trigger slug (fallback).
    async fn matching(
        &self,
        trigger_id: Option<&str>,
        slug: Option<&str>,
    ) -> Vec<TriggerSubscription> {
        let all = self.list().await.unwrap_or_default();
        all.into_iter()
            .filter(|s| {
                trigger_id.is_some_and(|t| s.composio_trigger_id.as_deref() == Some(t))
                    || slug.is_some_and(|sl| s.trigger_slug.eq_ignore_ascii_case(sl))
            })
            .collect()
    }

    /// Handle an inbound Composio webhook payload: find matching subscriptions and
    /// fire each bound target. An `agent` target runs the configured agent with a
    /// prompt built from the event; a `workflow` target runs the workflow with the
    /// raw event payload injected as `trigger` state. Returns how many runs were
    /// started.
    pub async fn handle_webhook(&self, payload: &Value) -> usize {
        // Composio payloads vary; pull the trigger id / slug defensively.
        let trigger_id = ["trigger_id", "triggerId", "id", "nano_id"]
            .iter()
            .find_map(|k| payload.get(*k).and_then(Value::as_str));
        let slug = ["trigger_slug", "triggerName", "type", "trigger_name"]
            .iter()
            .find_map(|k| payload.get(*k).and_then(Value::as_str));

        let subs = self.matching(trigger_id, slug).await;
        let mut fired = 0;
        for sub in subs {
            if sub.target_kind == "workflow" {
                let Some(workflow_id) = sub.workflow_id.as_deref() else {
                    tracing::warn!(sub = %sub.id, "workflow trigger missing workflow_id");
                    continue;
                };
                let payload_json = serde_json::to_string(payload).unwrap_or_default();
                match run_workflow_for_trigger(workflow_id, &payload_json).await {
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

            let prompt = format!(
                "A Composio `{}` event fired for the `{}` integration. Handle it. \
                 Event payload (JSON):\n\n{}",
                sub.trigger_slug,
                sub.toolkit,
                serde_json::to_string_pretty(payload).unwrap_or_default()
            );
            match run_agent(&sub.agent_id, &prompt).await {
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

/// Run a persisted workflow in response to a trigger, seeding the run's `state`
/// with the raw event payload under the reserved `trigger` key (readable in node
/// templates as `{{trigger.<field>}}`). Returns the run id.
///
/// Implementation note: this seeds state by pre-saving a fresh `WorkflowRun`
/// with `state["trigger"]` set, then calling `run_workflow` with that same
/// `run_id`. It relies on `run_workflow_inner` loading the existing run when the
/// workflow id matches and never clearing `run.state` — keep that path intact.
pub async fn run_workflow_for_trigger(workflow_id: &str, payload_json: &str) -> Result<String> {
    let workflow = crate::workflow::store::load_workflow(workflow_id)
        .map_err(|e| anyhow!("workflow '{workflow_id}' not found: {e}"))?;
    let run_id = format!("trigrun_{}", uuid::Uuid::new_v4().simple());

    // Seed the trigger payload into the run state before executing.
    let mut run = crate::workflow::store::WorkflowRun::new(
        run_id.clone(),
        workflow.id.clone(),
        Default::default(),
    );
    run.state
        .insert("trigger".to_string(), payload_json.to_string());
    crate::workflow::store::save_run(&run)
        .map_err(|e| anyhow!("seeding trigger run state: {e}"))?;

    crate::workflow::executor::run_workflow(&workflow, Default::default(), run_id.clone())
        .await
        .map_err(|e| anyhow!(e))?;
    Ok(run_id)
}

/// Run a single agent prompt for a fired trigger. Returns the run id.
///
/// Routes through the global agent runner so the *configured* agent handles the
/// event via the real chat path (its engine binding, gateway routing, tools,
/// persona) — fixing the prior bug where the ephemeral Prompt-node workflow
/// ignored `agent_id`. Falls back to that ephemeral workflow when no runner is
/// published (headless/tests); that path now also routes the agent correctly.
async fn run_agent(agent_id: &str, prompt: &str) -> Result<String> {
    let run_id = format!("agentrun_{}", uuid::Uuid::new_v4().simple());
    if let Some(runner) = crate::sidecar::agent_runner::global_agent_runner() {
        runner
            .run(
                Some(agent_id.to_string()),
                run_id.clone(),
                prompt.to_string(),
            )
            .await
            .map_err(|e| anyhow!(e))?;
        return Ok(run_id);
    }

    let workflow = Workflow {
        id: format!("ephemeral_{}", uuid::Uuid::new_v4().simple()),
        name: "composio trigger run".to_string(),
        description: None,
        nodes: vec![WorkflowNode {
            id: "prompt".to_string(),
            retry: None,
            timeout_ms: None,
            kind: NodeKind::Prompt {
                prompt: prompt.to_string(),
                agent_id: Some(agent_id.to_string()),
            },
        }],
        edges: Vec::<WorkflowEdge>::new(),
        triggers: Vec::new(),
        created_at: None,
        updated_at: None,
    };
    crate::workflow::executor::run_workflow(&workflow, Default::default(), run_id.clone())
        .await
        .map_err(|e| anyhow!(e))?;
    Ok(run_id)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!verify_webhook_signature(b"{}", Some("deadbeef")));
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
        let body = br#"{"trigger_slug":"x"}"#;
        let sig = hmac_sha256_hex(b"shhh", body);
        // Bare hex, `v1,<sig>`, and `sha256=<sig>` spellings all verify.
        assert!(verify_webhook_signature(body, Some(&sig)));
        assert!(verify_webhook_signature(body, Some(&format!("v1,{sig}"))));
        assert!(verify_webhook_signature(
            body,
            Some(&format!("sha256={sig}"))
        ));
        // A wrong signature, an absent header, and a mutated body all reject.
        assert!(!verify_webhook_signature(body, Some("00")));
        assert!(!verify_webhook_signature(body, None));
        assert!(!verify_webhook_signature(
            br#"{"trigger_slug":"y"}"#,
            Some(&sig)
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
        assert!(!verify_workflow_webhook_signature("other", body, Some(&sig)));
        assert!(!verify_workflow_webhook_signature("per-wf-secret", body, Some("00")));
        assert!(!verify_workflow_webhook_signature("per-wf-secret", body, None));
        assert!(!verify_workflow_webhook_signature(
            "per-wf-secret",
            br#"{"event":"other"}"#,
            Some(&sig)
        ));
    }
}
