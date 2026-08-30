use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_safe_actions::{Certificate, EffectContract, Policy, ToolPlan, VerificationReport};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyRecord {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub policy: Policy,
    pub policy_hash: String,
    pub version: u64,
    pub bound_agent_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolContractRecord {
    pub tool: String,
    pub contract: EffectContract,
    pub contract_hash: String,
    #[serde(default)]
    pub implementation_hash: String,
    pub attested_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmissionRecord {
    pub id: String,
    pub submission_key: String,
    pub agent_id: String,
    pub agent_revision: String,
    pub policy_id: String,
    /// Server-derived conversation principal captured at submission. This is
    /// never accepted from the plan payload and is reused when a review resumes.
    pub host_conversation_id: Option<String>,
    pub plan: ToolPlan,
    pub report: VerificationReport,
    pub certificate: Option<Certificate>,
    pub status: String,
    pub review_note: Option<String>,
    #[serde(default)]
    pub reviewed_by: Option<String>,
    pub reviewed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepReceipt {
    pub step_id: String,
    pub ordinal: u64,
    pub tool: String,
    pub arguments_hash: String,
    pub result_hash: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionReceipt {
    pub id: String,
    pub submission_id: String,
    pub certificate_id: String,
    pub agent_id: String,
    pub status: String,
    pub plan_hash: String,
    pub policy_hash: String,
    pub catalog_hash: String,
    pub verifier_version: String,
    pub result_hash: Option<String>,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub steps: Vec<StepReceipt>,
}

#[derive(Clone)]
pub struct SafeActionsStore {
    conn: Arc<Mutex<Connection>>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn default_path() -> PathBuf {
    crate::paths::ryu_dir().join("safe-actions.db")
}

impl SafeActionsStore {
    pub fn open_default() -> Result<Self> {
        Self::open(default_path())
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating Safe Actions db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening Safe Actions db {}", path.display()))?;
        Self::init(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory Safe Actions db")?;
        Self::init(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init(conn: &Connection) -> Result<()> {
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             CREATE TABLE IF NOT EXISTS safe_action_policies (
                 id TEXT PRIMARY KEY,
                 json TEXT NOT NULL,
                 policy_hash TEXT NOT NULL,
                 version INTEGER NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS safe_action_bindings (
                 agent_id TEXT PRIMARY KEY,
                 policy_id TEXT NOT NULL REFERENCES safe_action_policies(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS idx_safe_action_bindings_policy
                 ON safe_action_bindings(policy_id);
             CREATE TABLE IF NOT EXISTS safe_action_contracts (
                 tool TEXT PRIMARY KEY,
                 json TEXT NOT NULL,
                 contract_hash TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS safe_action_submissions (
                 id TEXT PRIMARY KEY,
                 submission_key TEXT NOT NULL UNIQUE,
                 agent_id TEXT NOT NULL,
                 policy_id TEXT NOT NULL,
                 status TEXT NOT NULL,
                 json TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 updated_at TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_safe_action_submissions_status
                 ON safe_action_submissions(status, created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_safe_action_submissions_agent
                 ON safe_action_submissions(agent_id, created_at DESC);
             CREATE TABLE IF NOT EXISTS safe_action_receipts (
                 id TEXT PRIMARY KEY,
                 submission_id TEXT NOT NULL UNIQUE REFERENCES safe_action_submissions(id),
                 certificate_id TEXT NOT NULL UNIQUE,
                 status TEXT NOT NULL,
                 json TEXT NOT NULL,
                 started_at TEXT NOT NULL,
                 finished_at TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_safe_action_receipts_status
                 ON safe_action_receipts(status, started_at DESC);
             CREATE TABLE IF NOT EXISTS safe_action_steps (
                 receipt_id TEXT NOT NULL REFERENCES safe_action_receipts(id),
                 step_id TEXT NOT NULL,
                 ordinal INTEGER NOT NULL,
                 status TEXT NOT NULL,
                 json TEXT NOT NULL,
                 PRIMARY KEY (receipt_id, step_id)
             );",
        )
        .context("initializing Safe Actions schema")?;

        // A process crash leaves no evidence that a side effect did or did not
        // reach its provider. Never turn that uncertainty into a success or retry.
        let recovered_at = now();
        conn.execute(
            "UPDATE safe_action_receipts
             SET status = 'unknown_after_crash', finished_at = ?1,
                 json = json_set(json, '$.status', 'unknown_after_crash',
                                 '$.finished_at', ?1,
                                 '$.error', 'Core stopped while execution was in progress')
             WHERE status = 'running'",
            params![recovered_at],
        )?;
        conn.execute(
            "UPDATE safe_action_steps
             SET status = 'unknown_after_crash',
                 json = json_set(json, '$.status', 'unknown_after_crash',
                                 '$.finished_at', ?1,
                                 '$.error', 'Core stopped while this step was in progress')
             WHERE status = 'running'",
            params![recovered_at],
        )?;
        conn.execute(
            "UPDATE safe_action_submissions
             SET status = 'unknown_after_crash', updated_at = ?1,
                 json = json_set(json, '$.status', 'unknown_after_crash', '$.updated_at', ?1)
             WHERE status = 'executing'",
            params![recovered_at],
        )?;
        Ok(())
    }

    pub async fn list_policies(&self) -> Result<Vec<PolicyRecord>> {
        let conn = self.conn.lock().await;
        let json_records = {
            let mut stmt = conn.prepare(
                "SELECT json FROM safe_action_policies ORDER BY updated_at DESC, id ASC LIMIT 200",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        json_records
            .into_iter()
            .map(|json| hydrate_policy_bindings(&conn, decode(&json)?))
            .collect()
    }

    pub async fn get_policy(&self, id: &str) -> Result<Option<PolicyRecord>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM safe_action_policies WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        json.map(|value| hydrate_policy_bindings(&conn, decode(&value)?))
            .transpose()
    }

    pub async fn policy_for_agent(&self, agent_id: &str) -> Result<Option<PolicyRecord>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT p.json FROM safe_action_policies p
                 JOIN safe_action_bindings b ON b.policy_id = p.id
                 WHERE b.agent_id = ?1",
                params![agent_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        json.map(|value| hydrate_policy_bindings(&conn, decode(&value)?))
            .transpose()
    }

    pub async fn put_policy(
        &self,
        mut record: PolicyRecord,
        expected_version: Option<u64>,
    ) -> Result<PolicyRecord> {
        let timestamp = now();
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        let existing = transaction
            .query_row(
                "SELECT json FROM safe_action_policies WHERE id = ?1",
                params![record.id],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| decode::<PolicyRecord>(&json))
            .transpose()?;
        match (existing.as_ref(), expected_version) {
            (Some(item), Some(expected)) if item.version == expected => {}
            (Some(item), Some(expected)) => anyhow::bail!(
                "policy version conflict: expected {expected}, found {}",
                item.version
            ),
            (Some(_), None) => anyhow::bail!("policy '{}' already exists", record.id),
            (None, Some(expected)) => anyhow::bail!(
                "policy version conflict: expected {expected}, but the policy does not exist"
            ),
            (None, None) => {}
        }
        record.version = existing
            .as_ref()
            .map_or(1, |item| item.version.saturating_add(1));
        record.created_at = existing
            .as_ref()
            .map_or_else(|| timestamp.clone(), |item| item.created_at.clone());
        record.updated_at = timestamp;
        record.bound_agent_ids.sort();
        record.bound_agent_ids.dedup();
        let json = encode(&record)?;
        if let Some(expected) = expected_version {
            let changed = transaction.execute(
                "UPDATE safe_action_policies
                 SET json = ?2, policy_hash = ?3, version = ?4, updated_at = ?5
                 WHERE id = ?1 AND version = ?6",
                params![
                    record.id,
                    json,
                    record.policy_hash,
                    i64::try_from(record.version).unwrap_or(i64::MAX),
                    record.updated_at,
                    i64::try_from(expected).unwrap_or(i64::MAX),
                ],
            )?;
            if changed != 1 {
                anyhow::bail!("policy version conflict during update");
            }
        } else {
            transaction.execute(
                "INSERT INTO safe_action_policies
                     (id, json, policy_hash, version, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    record.id,
                    json,
                    record.policy_hash,
                    i64::try_from(record.version).unwrap_or(i64::MAX),
                    record.created_at,
                    record.updated_at
                ],
            )?;
        }
        transaction.execute(
            "DELETE FROM safe_action_bindings WHERE policy_id = ?1",
            params![record.id],
        )?;
        for agent_id in &record.bound_agent_ids {
            transaction.execute(
                "INSERT INTO safe_action_bindings (agent_id, policy_id) VALUES (?1, ?2)
                 ON CONFLICT(agent_id) DO UPDATE SET policy_id = excluded.policy_id",
                params![agent_id, record.id],
            )?;
        }
        transaction.commit()?;
        Ok(record)
    }

    pub async fn delete_policy(&self, id: &str, expected_version: u64) -> Result<bool> {
        let conn = self.conn.lock().await;
        Ok(conn.execute(
            "DELETE FROM safe_action_policies WHERE id = ?1 AND version = ?2",
            params![id, i64::try_from(expected_version).unwrap_or(i64::MAX)],
        )? == 1)
    }

    pub async fn list_contracts(&self) -> Result<Vec<ToolContractRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT json FROM safe_action_contracts ORDER BY tool ASC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| decode(&row?)).collect()
    }

    pub async fn put_contract(
        &self,
        mut record: ToolContractRecord,
        expected_contract_hash: Option<&str>,
        expected_implementation_hash: Option<&str>,
    ) -> Result<ToolContractRecord> {
        let timestamp = now();
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        let existing = transaction
            .query_row(
                "SELECT json FROM safe_action_contracts WHERE tool = ?1",
                params![record.tool],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|json| decode::<ToolContractRecord>(&json))
            .transpose()?;
        match (
            &existing,
            expected_contract_hash,
            expected_implementation_hash,
        ) {
            (None, None, None) => {}
            (Some(current), Some(contract), Some(implementation))
                if current.contract_hash == contract
                    && current.implementation_hash == implementation => {}
            (Some(_), None, None) => {
                anyhow::bail!("tool contract already exists; reload before replacing it")
            }
            (None, _, _) => anyhow::bail!("tool contract no longer exists; reload and retry"),
            _ => anyhow::bail!("tool contract changed; reload before replacing it"),
        }
        record.created_at = existing
            .as_ref()
            .map_or_else(|| timestamp.clone(), |item| item.created_at.clone());
        record.updated_at = timestamp;
        let json = encode(&record)?;
        transaction.execute(
            "INSERT INTO safe_action_contracts
                 (tool, json, contract_hash, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(tool) DO UPDATE SET
                 json = excluded.json,
                 contract_hash = excluded.contract_hash,
                 updated_at = excluded.updated_at",
            params![
                record.tool,
                json,
                record.contract_hash,
                record.created_at,
                record.updated_at
            ],
        )?;
        transaction.commit()?;
        Ok(record)
    }

    pub async fn insert_submission(&self, record: &SubmissionRecord) -> Result<SubmissionRecord> {
        let json = encode(record)?;
        let conn = self.conn.lock().await;
        if let Some(existing) = conn
            .query_row(
                "SELECT json FROM safe_action_submissions WHERE submission_key = ?1",
                params![record.submission_key],
                |row| row.get::<_, String>(0),
            )
            .optional()?
        {
            return decode(&existing);
        }
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM safe_action_submissions WHERE agent_id = ?1",
            params![record.agent_id],
            |row| row.get(0),
        )?;
        if count >= 10_000 {
            anyhow::bail!("Safe Actions submission retention limit reached for this agent");
        }
        conn.execute(
            "INSERT INTO safe_action_submissions
                 (id, submission_key, agent_id, policy_id, status, json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                record.id,
                record.submission_key,
                record.agent_id,
                record.policy_id,
                record.status,
                json,
                record.created_at,
                record.updated_at
            ],
        )?;
        Ok(record.clone())
    }

    pub async fn get_submission(&self, id: &str) -> Result<Option<SubmissionRecord>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM safe_action_submissions WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        json.map(|value| decode(&value)).transpose()
    }

    pub async fn get_submission_by_key(&self, key: &str) -> Result<Option<SubmissionRecord>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM safe_action_submissions WHERE submission_key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        json.map(|value| decode(&value)).transpose()
    }

    pub async fn list_reviews(&self) -> Result<Vec<SubmissionRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT json FROM safe_action_submissions
             WHERE status = 'pending_review'
                OR status = 'invalidated'
                OR json_extract(json, '$.reviewed_at') IS NOT NULL
             ORDER BY created_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|row| decode(&row?)).collect()
    }

    pub async fn transition_submission(
        &self,
        id: &str,
        from: &[&str],
        mut updated: SubmissionRecord,
    ) -> Result<bool> {
        if !from.iter().any(|status| *status == updated.status) {
            updated.updated_at = now();
        }
        let json = encode(&updated)?;
        let conn = self.conn.lock().await;
        let placeholders = (0..from.len())
            .map(|index| format!("?{}", index + 5))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "UPDATE safe_action_submissions SET status = ?2, json = ?3, updated_at = ?4
             WHERE id = ?1 AND status IN ({placeholders})"
        );
        // The dynamic text contains placeholders only; values remain parameters.
        let mut values: Vec<&dyn rusqlite::ToSql> =
            vec![&id, &updated.status, &json, &updated.updated_at];
        values.extend(from.iter().map(|value| value as &dyn rusqlite::ToSql));
        let changed = conn.execute(&sql, values.as_slice())?;
        Ok(changed == 1)
    }

    pub async fn start_execution(
        &self,
        id: &str,
        from: &[&str],
        submission: &SubmissionRecord,
        receipt: &ExecutionReceipt,
    ) -> Result<bool> {
        let submission_json = encode(submission)?;
        let mut persisted_receipt = receipt.clone();
        persisted_receipt.steps.clear();
        let receipt_json = encode(&persisted_receipt)?;
        let placeholders = (0..from.len())
            .map(|index| format!("?{}", index + 5))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "UPDATE safe_action_submissions SET status = ?2, json = ?3, updated_at = ?4
             WHERE id = ?1 AND status IN ({placeholders})"
        );
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        let mut values: Vec<&dyn rusqlite::ToSql> = vec![
            &id,
            &submission.status,
            &submission_json,
            &submission.updated_at,
        ];
        values.extend(from.iter().map(|value| value as &dyn rusqlite::ToSql));
        if transaction.execute(&sql, values.as_slice())? != 1 {
            return Ok(false);
        }
        transaction.execute(
            "INSERT INTO safe_action_receipts
                 (id, submission_id, certificate_id, status, json, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                receipt.id,
                receipt.submission_id,
                receipt.certificate_id,
                receipt.status,
                receipt_json,
                receipt.started_at,
                receipt.finished_at
            ],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    pub async fn insert_receipt(&self, receipt: &ExecutionReceipt) -> Result<ExecutionReceipt> {
        let json = encode(receipt)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR IGNORE INTO safe_action_receipts
                 (id, submission_id, certificate_id, status, json, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                receipt.id,
                receipt.submission_id,
                receipt.certificate_id,
                receipt.status,
                json,
                receipt.started_at,
                receipt.finished_at
            ],
        )?;
        let json: String = conn.query_row(
            "SELECT json FROM safe_action_receipts WHERE submission_id = ?1",
            params![receipt.submission_id],
            |row| row.get(0),
        )?;
        decode(&json)
    }

    pub async fn save_terminal(
        &self,
        receipt: &ExecutionReceipt,
        submission: &SubmissionRecord,
    ) -> Result<bool> {
        let mut persisted_receipt = receipt.clone();
        persisted_receipt.steps.clear();
        let receipt_json = encode(&persisted_receipt)?;
        let submission_json = encode(submission)?;
        let mut conn = self.conn.lock().await;
        let transaction = conn.transaction()?;
        let receipt_changed = transaction.execute(
            "UPDATE safe_action_receipts
             SET status = ?2, json = ?3, finished_at = ?4
             WHERE id = ?1 AND status = 'running'",
            params![
                receipt.id,
                receipt.status,
                receipt_json,
                receipt.finished_at
            ],
        )?;
        let submission_changed = transaction.execute(
            "UPDATE safe_action_submissions
             SET status = ?2, json = ?3, updated_at = ?4
             WHERE id = ?1 AND status = 'executing'",
            params![
                submission.id,
                submission.status,
                submission_json,
                submission.updated_at
            ],
        )?;
        if receipt_changed != 1 || submission_changed != 1 {
            return Ok(false);
        }
        transaction.commit()?;
        Ok(true)
    }

    pub async fn save_step(&self, receipt_id: &str, step: &StepReceipt) -> Result<()> {
        let json = encode(step)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO safe_action_steps (receipt_id, step_id, ordinal, status, json)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(receipt_id, step_id) DO UPDATE SET
                 ordinal = excluded.ordinal,
                 status = excluded.status,
                 json = excluded.json",
            params![
                receipt_id,
                step.step_id,
                i64::try_from(step.ordinal).unwrap_or(i64::MAX),
                step.status,
                json
            ],
        )?;
        Ok(())
    }

    pub async fn get_receipt(&self, id: &str) -> Result<Option<ExecutionReceipt>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM safe_action_receipts
                 WHERE id = ?1 OR submission_id = ?1 OR certificate_id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(json) = json else {
            return Ok(None);
        };
        let mut receipt: ExecutionReceipt = decode(&json)?;
        let mut stmt = conn.prepare(
            "SELECT json FROM safe_action_steps WHERE receipt_id = ?1 ORDER BY ordinal ASC",
        )?;
        let rows = stmt.query_map(params![receipt.id], |row| row.get::<_, String>(0))?;
        receipt.steps = rows.map(|row| decode(&row?)).collect::<Result<Vec<_>>>()?;
        Ok(Some(receipt))
    }

    pub async fn list_receipts(&self) -> Result<Vec<ExecutionReceipt>> {
        let ids = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id FROM safe_action_receipts ORDER BY started_at DESC LIMIT 200",
            )?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let mut receipts = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(receipt) = self.get_receipt(&id).await? {
                receipts.push(receipt);
            }
        }
        Ok(receipts)
    }
}

fn encode<T: Serialize>(value: &T) -> Result<String> {
    serde_json::to_string(value).context("serializing Safe Actions record")
}

fn decode<T: for<'de> Deserialize<'de>>(value: &str) -> Result<T> {
    serde_json::from_str(value).context("deserializing Safe Actions record")
}

pub fn sanitize_error(error: &anyhow::Error) -> String {
    // Provider errors may contain credentials, request bodies, or returned data.
    // Keep only a correlation hash in durable receipts; the live Core log remains
    // the place for operator diagnostics.
    let digest = format!("{:x}", Sha256::digest(error.to_string().as_bytes()));
    format!(
        "tool execution did not complete (detail hash {})",
        &digest[..12]
    )
}

fn hydrate_policy_bindings(conn: &Connection, mut record: PolicyRecord) -> Result<PolicyRecord> {
    let mut stmt = conn.prepare(
        "SELECT agent_id FROM safe_action_bindings WHERE policy_id = ?1 ORDER BY agent_id ASC",
    )?;
    let rows = stmt.query_map(params![record.id], |row| row.get::<_, String>(0))?;
    record.bound_agent_ids = rows.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(record)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyInput {
    pub id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub policy: Policy,
    #[serde(default)]
    pub expected_version: Option<u64>,
    #[serde(default)]
    pub bound_agent_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContractInput {
    pub tool: String,
    pub contract: EffectContract,
    #[serde(default)]
    pub expected_contract_hash: Option<String>,
    #[serde(default)]
    pub expected_implementation_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyDeleteInput {
    pub expected_version: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewDecisionInput {
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyCheckInput {
    pub agent_id: String,
    pub plan: ToolPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmitPlanInput {
    pub request_id: String,
    pub plan: ToolPlan,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StatusInput {
    pub execution_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogView {
    pub tools: Vec<Value>,
    pub catalog_hash: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_safe_actions::{PlanNode, VerifierInput, TOOL_PLAN_SCHEMA_VERSION};

    fn plan() -> ToolPlan {
        ToolPlan {
            schema_version: TOOL_PLAN_SCHEMA_VERSION,
            root: PlanNode::Sequence {
                id: "root".to_owned(),
                nodes: Vec::new(),
            },
        }
    }

    fn submission(status: &str) -> SubmissionRecord {
        let plan = plan();
        let report = ryu_safe_actions::verify(&VerifierInput {
            plan: plan.clone(),
            policy: Policy::default(),
            catalog: Vec::new(),
            agent_revision: "agent-revision".to_owned(),
        });
        SubmissionRecord {
            id: "submission-1".to_owned(),
            submission_key: "dedupe-key".to_owned(),
            agent_id: "agent-1".to_owned(),
            agent_revision: "agent-revision".to_owned(),
            policy_id: "policy-1".to_owned(),
            host_conversation_id: Some("conversation-1".to_owned()),
            plan,
            report,
            certificate: None,
            status: status.to_owned(),
            review_note: None,
            reviewed_by: None,
            reviewed_at: None,
            created_at: "2026-08-23T00:00:00Z".to_owned(),
            updated_at: "2026-08-23T00:00:00Z".to_owned(),
        }
    }

    fn receipt(status: &str) -> ExecutionReceipt {
        ExecutionReceipt {
            id: "receipt-1".to_owned(),
            submission_id: "submission-1".to_owned(),
            certificate_id: "certificate-1".to_owned(),
            agent_id: "agent-1".to_owned(),
            status: status.to_owned(),
            plan_hash: "plan".to_owned(),
            policy_hash: "policy".to_owned(),
            catalog_hash: "catalog".to_owned(),
            verifier_version: "verifier".to_owned(),
            result_hash: None,
            error: None,
            started_at: "2026-08-23T00:00:00Z".to_owned(),
            finished_at: None,
            steps: Vec::new(),
        }
    }

    #[tokio::test]
    async fn policy_binding_round_trips_and_versions() {
        let store = SafeActionsStore::open_in_memory().unwrap();
        let policy = PolicyRecord {
            id: "policy-1".to_owned(),
            name: "Customer records".to_owned(),
            description: None,
            policy: Policy::default(),
            policy_hash: ryu_safe_actions::sha256_canonical(&Policy::default()).unwrap(),
            version: 0,
            bound_agent_ids: vec!["agent-1".to_owned()],
            created_at: String::new(),
            updated_at: String::new(),
        };
        let first = store.put_policy(policy.clone(), None).await.unwrap();
        assert_eq!(first.version, 1);
        assert_eq!(
            store.policy_for_agent("agent-1").await.unwrap().unwrap().id,
            "policy-1"
        );
        let second = store.put_policy(policy, Some(first.version)).await.unwrap();
        assert_eq!(second.version, 2);
    }

    #[tokio::test]
    async fn stale_policy_versions_are_rejected() {
        let store = SafeActionsStore::open_in_memory().unwrap();
        let policy = PolicyRecord {
            id: "policy-1".to_owned(),
            name: "Customer records".to_owned(),
            description: None,
            policy: Policy::default(),
            policy_hash: ryu_safe_actions::sha256_canonical(&Policy::default()).unwrap(),
            version: 0,
            bound_agent_ids: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        store.put_policy(policy.clone(), None).await.unwrap();
        assert!(store.put_policy(policy.clone(), None).await.is_err());
        assert!(store.put_policy(policy, Some(0)).await.is_err());
        assert_eq!(
            store.get_policy("policy-1").await.unwrap().unwrap().version,
            1
        );
    }

    #[tokio::test]
    async fn policy_delete_requires_the_exact_live_version() {
        let store = SafeActionsStore::open_in_memory().unwrap();
        let policy = PolicyRecord {
            id: "policy-1".to_owned(),
            name: "Customer records".to_owned(),
            description: None,
            policy: Policy::default(),
            policy_hash: ryu_safe_actions::sha256_canonical(&Policy::default()).unwrap(),
            version: 0,
            bound_agent_ids: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let created = store.put_policy(policy, None).await.unwrap();

        assert!(!store.delete_policy("policy-1", 0).await.unwrap());
        assert!(store.get_policy("policy-1").await.unwrap().is_some());
        assert!(store
            .delete_policy("policy-1", created.version)
            .await
            .unwrap());
        assert!(store.get_policy("policy-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn contract_replacement_requires_both_live_hashes() {
        let store = SafeActionsStore::open_in_memory().unwrap();
        let contract = EffectContract {
            trust: ryu_safe_actions::ContractTrust::OperatorAttested,
            effects: [ryu_safe_actions::EffectKind::Read].into_iter().collect(),
            resources: ["space://alpha/docs".to_owned()].into_iter().collect(),
            resource_bindings: Vec::new(),
            arguments_independent: true,
        };
        let contract_hash = ryu_safe_actions::sha256_canonical(&contract).unwrap();
        let record = ToolContractRecord {
            tool: "files.read".to_owned(),
            contract,
            contract_hash: contract_hash.clone(),
            implementation_hash: "implementation-1".to_owned(),
            attested_by: "operator-1".to_owned(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let created = store
            .put_contract(record.clone(), None, None)
            .await
            .unwrap();

        assert!(store
            .put_contract(record.clone(), None, None)
            .await
            .is_err());
        assert!(store
            .put_contract(
                record.clone(),
                Some(&created.contract_hash),
                Some("stale-implementation"),
            )
            .await
            .is_err());
        assert!(store
            .put_contract(
                record,
                Some(&created.contract_hash),
                Some(&created.implementation_hash),
            )
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn concurrent_identical_submissions_choose_one_record() {
        let store = SafeActionsStore::open_in_memory().unwrap();
        let left = store.clone();
        let right = store.clone();
        let first = submission("pending_review");
        let mut second = first.clone();
        second.id = "submission-2".to_owned();
        let (left_result, right_result) = tokio::join!(
            left.insert_submission(&first),
            right.insert_submission(&second)
        );
        assert_eq!(left_result.unwrap().id, right_result.unwrap().id);
    }

    #[tokio::test]
    async fn execution_start_and_terminalization_are_atomic() {
        let store = SafeActionsStore::open_in_memory().unwrap();
        store
            .insert_submission(&submission("certified"))
            .await
            .unwrap();
        let mut executing = submission("executing");
        let running = receipt("running");
        assert!(store
            .start_execution("submission-1", &["certified"], &executing, &running)
            .await
            .unwrap());
        assert_eq!(
            store
                .get_receipt("receipt-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            "running"
        );

        executing.status = "succeeded".to_owned();
        let mut succeeded = running;
        succeeded.status = "succeeded".to_owned();
        succeeded.finished_at = Some("2026-08-23T00:01:00Z".to_owned());
        store.save_terminal(&succeeded, &executing).await.unwrap();
        assert_eq!(
            store
                .get_receipt("receipt-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            "succeeded"
        );
        assert_eq!(
            store
                .get_submission("submission-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            "succeeded"
        );
    }

    #[tokio::test]
    async fn review_transition_is_compare_and_swap() {
        let store = SafeActionsStore::open_in_memory().unwrap();
        let pending = store
            .insert_submission(&submission("pending_review"))
            .await
            .unwrap();
        let mut approved = pending.clone();
        approved.status = "approved".to_owned();
        let mut denied = pending;
        denied.status = "denied_by_reviewer".to_owned();
        assert!(store
            .transition_submission("submission-1", &["pending_review"], approved)
            .await
            .unwrap());
        assert!(!store
            .transition_submission("submission-1", &["pending_review"], denied)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn running_receipt_recovers_as_unknown_after_crash() {
        let path = std::env::temp_dir().join(format!(
            "ryu-safe-actions-recovery-{}.db",
            uuid::Uuid::new_v4()
        ));
        {
            let store = SafeActionsStore::open(path.clone()).unwrap();
            store
                .insert_submission(&submission("executing"))
                .await
                .unwrap();
            store.insert_receipt(&receipt("running")).await.unwrap();
            store
                .save_step(
                    "receipt-1",
                    &StepReceipt {
                        step_id: "step-1".to_owned(),
                        ordinal: 1,
                        tool: "files.write".to_owned(),
                        arguments_hash: "arguments".to_owned(),
                        result_hash: None,
                        status: "running".to_owned(),
                        error: None,
                        started_at: "2026-08-23T00:00:00Z".to_owned(),
                        finished_at: None,
                    },
                )
                .await
                .unwrap();
        }
        let reopened = SafeActionsStore::open(path.clone()).unwrap();
        let recovered_receipt = reopened.get_receipt("receipt-1").await.unwrap().unwrap();
        assert_eq!(recovered_receipt.status, "unknown_after_crash");
        assert_eq!(recovered_receipt.steps[0].status, "unknown_after_crash");
        assert_eq!(
            reopened
                .get_submission("submission-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            "unknown_after_crash"
        );

        let mut late_submission = submission("succeeded");
        late_submission.updated_at = "2026-08-23T00:02:00Z".to_owned();
        let mut late_receipt = receipt("succeeded");
        late_receipt.finished_at = Some("2026-08-23T00:02:00Z".to_owned());
        assert!(!reopened
            .save_terminal(&late_receipt, &late_submission)
            .await
            .unwrap());
        assert_eq!(
            reopened
                .get_receipt("receipt-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            "unknown_after_crash"
        );
        assert_eq!(
            reopened
                .get_submission("submission-1")
                .await
                .unwrap()
                .unwrap()
                .status,
            "unknown_after_crash"
        );
        drop(reopened);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("db-wal"));
        let _ = std::fs::remove_file(path.with_extension("db-shm"));
    }
}
