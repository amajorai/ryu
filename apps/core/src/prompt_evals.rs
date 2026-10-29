//! Core-owned persistence for Prompt Studio suites, runs, versions, and human
//! review. Provider execution remains Gateway-owned; this module stores the
//! reproducible input/output envelope around that execution.
//!
//! Encryption at rest: suite and version `config` (system prompts, test inputs),
//! run `request`/`result` (full model outputs) and review `comment` are sealed per
//! value as `encb:v1:` under the `prompt-evals.db` content key, each bound to its
//! row id and column (reviews: `run_id` + `result_key`). Names, labels, scores
//! and timestamps stay plaintext for listing. Legacy rows are sealed on open; a
//! value that does not open is an error on a get and skipped (counted) in a list.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::{ContentCipher, ContentContext};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::activity::sealed_store::{core_cipher, StoreSeal};

/// Registered store name (content-key input; never rename).
const STORE: &str = "prompt-evals.db";
const SUITE_CONFIG: &str = "prompt_suites.config";
const VERSION_CONFIG: &str = "prompt_suite_versions.config";
const RUN_REQUEST: &str = "prompt_runs.request";
const RUN_RESULT: &str = "prompt_runs.result";
const REVIEW_COMMENT: &str = "prompt_reviews.comment";

fn column_plans() -> Result<Vec<ColumnPlan>> {
    Ok(vec![
        ColumnPlan::text("prompt_suites", "config", "id", KeyKind::Text)?,
        ColumnPlan::text("prompt_suite_versions", "config", "id", KeyKind::Text)?,
        ColumnPlan::text("prompt_runs", "request", "id", KeyKind::Text)?,
        ColumnPlan::text("prompt_runs", "result", "id", KeyKind::Text)?,
    ])
}

fn review_context(run_id: &str, result_key: &str) -> ContentContext {
    ContentContext::new(REVIEW_COMMENT)
        .with("run_id", run_id)
        .with("result_key", result_key)
}

/// A `prompt_suites` row as stored (config still sealed).
type RawSuite = (String, String, String, String, i64, i64);

fn raw_suite(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawSuite> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
    ))
}

const MAX_SUITE_VERSIONS: i64 = 50;
const MAX_SUITE_CASES: usize = 10_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptSuiteRecord {
    pub agent_id: String,
    pub config: Value,
    pub created_at: i64,
    pub id: String,
    pub name: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptSuiteVersionMeta {
    pub created_at: i64,
    pub id: String,
    pub label: Option<String>,
    pub suite_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptSuiteVersion {
    pub config: Value,
    pub created_at: i64,
    pub id: String,
    pub label: Option<String>,
    pub suite_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRunMeta {
    pub created_at: i64,
    pub id: String,
    pub name: String,
    pub suite_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptRun {
    pub created_at: i64,
    pub id: String,
    pub name: String,
    pub request: Value,
    pub result: Value,
    pub suite_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PromptReview {
    pub comment: Option<String>,
    pub highlighted: bool,
    pub pass: Option<bool>,
    pub result_key: String,
    pub run_id: String,
    pub score: Option<f32>,
    pub updated_at: i64,
}

#[derive(Clone)]
pub struct PromptEvalStore {
    conn: std::sync::Arc<Mutex<Connection>>,
    seal: StoreSeal,
}

static GLOBAL: OnceLock<PromptEvalStore> = OnceLock::new();

fn db_path() -> PathBuf {
    crate::paths::db_path("prompt-evals.db")
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

impl PromptEvalStore {
    pub fn open() -> Result<Self> {
        Self::open_at(db_path(), core_cipher(STORE)?)
    }

    /// Open the store at `path` under an explicit content cipher (tests).
    pub fn open_at(path: PathBuf, cipher: ContentCipher) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).context("creating prompt eval data dir")?;
        }
        let mut conn = Connection::open(&path)
            .with_context(|| format!("opening prompt eval database at {}", path.display()))?;
        Self::migrate(&conn)?;
        let seal = Self::seal_store(&mut conn, Some(&path), cipher)?;
        let conn = std::sync::Arc::new(Mutex::new(conn));
        seal.defer_compaction(&conn, Some(&path));
        Ok(Self { conn, seal })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        let seal = Self::seal_store(&mut conn, None, core_cipher(STORE)?)?;
        Ok(Self {
            conn: std::sync::Arc::new(Mutex::new(conn)),
            seal,
        })
    }

    fn seal_store(
        conn: &mut Connection,
        db_path: Option<&Path>,
        cipher: ContentCipher,
    ) -> Result<StoreSeal> {
        let seal = StoreSeal::prepare(conn, db_path, cipher, &column_plans()?)
            .context("sealing the prompt eval store")?;
        if seal.writable() && seal_legacy_review_comments(conn, &seal)? > 0 {
            seal.finish(conn, db_path);
        }
        Ok(seal)
    }

    /// Values list reads skipped because they did not open (since open).
    pub fn unreadable_rows(&self) -> u64 {
        self.seal.unreadable()
    }

    fn seal_json(&self, value: &Value, purpose: &str, id: &str) -> Result<String> {
        self.seal.seal(
            &serde_json::to_string(value)?,
            &ContentContext::for_id(purpose, id),
        )
    }

    fn open_json(&self, stored: &str, purpose: &str, id: &str) -> Result<Value> {
        let json = self
            .seal
            .open(stored, &ContentContext::for_id(purpose, id))?;
        serde_json::from_str(&json).with_context(|| format!("decoding {purpose} of {id}"))
    }

    fn suite_from_raw(&self, raw: RawSuite) -> Result<PromptSuiteRecord> {
        let (id, agent_id, name, config, created_at, updated_at) = raw;
        Ok(PromptSuiteRecord {
            config: self.open_json(&config, SUITE_CONFIG, &id)?,
            id,
            agent_id,
            name,
            created_at,
            updated_at,
        })
    }

    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS prompt_suites (
                id         TEXT PRIMARY KEY,
                agent_id   TEXT NOT NULL,
                name       TEXT NOT NULL,
                config     TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_prompt_suites_agent
                ON prompt_suites(agent_id, updated_at DESC);
            CREATE TABLE IF NOT EXISTS prompt_suite_versions (
                id         TEXT PRIMARY KEY,
                suite_id   TEXT NOT NULL,
                config     TEXT NOT NULL,
                label      TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_prompt_suite_versions_suite
                ON prompt_suite_versions(suite_id, created_at DESC, id DESC);
            CREATE TABLE IF NOT EXISTS prompt_runs (
                id         TEXT PRIMARY KEY,
                suite_id   TEXT NOT NULL,
                name       TEXT NOT NULL,
                request    TEXT NOT NULL,
                result     TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_prompt_runs_suite
                ON prompt_runs(suite_id, created_at DESC, id DESC);
            CREATE TABLE IF NOT EXISTS prompt_reviews (
                run_id      TEXT NOT NULL,
                result_key  TEXT NOT NULL,
                pass        INTEGER,
                score       REAL,
                comment     TEXT,
                highlighted INTEGER NOT NULL DEFAULT 0,
                updated_at  INTEGER NOT NULL,
                PRIMARY KEY (run_id, result_key)
            );",
        )
        .context("creating prompt eval schema")?;
        Ok(())
    }

    pub fn install_global(store: Self) -> Result<()> {
        GLOBAL
            .set(store)
            .map_err(|_| anyhow::anyhow!("prompt eval store already installed"))
    }

    pub fn global() -> Option<&'static Self> {
        GLOBAL.get()
    }

    pub async fn create_suite(
        &self,
        agent_id: &str,
        name: &str,
        config: &Value,
    ) -> Result<PromptSuiteRecord> {
        let id = new_id("ps");
        let now = now_millis();
        let name = name.trim();
        if name.is_empty() {
            anyhow::bail!("prompt suite name is required");
        }
        let config_json = self.seal_json(config, SUITE_CONFIG, &id)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO prompt_suites (id, agent_id, name, config, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, agent_id, name, config_json, now],
        )?;
        Ok(PromptSuiteRecord {
            agent_id: agent_id.to_owned(),
            config: config.clone(),
            created_at: now,
            id,
            name: name.to_owned(),
            updated_at: now,
        })
    }

    pub async fn list_suites(&self, agent_id: &str) -> Result<Vec<PromptSuiteRecord>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, agent_id, name, config, created_at, updated_at
                 FROM prompt_suites WHERE agent_id = ?1 ORDER BY updated_at DESC, id DESC",
            )?;
            let rows = stmt.query_map(params![agent_id], raw_suite)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut suites = Vec::with_capacity(rows.len());
        let mut skipped = 0u64;
        for raw in rows {
            match self.suite_from_raw(raw) {
                Ok(suite) => suites.push(suite),
                Err(_) => skipped += 1,
            }
        }
        self.seal.count_unreadable(skipped);
        Ok(suites)
    }

    pub async fn get_suite(&self, suite_id: &str) -> Result<Option<PromptSuiteRecord>> {
        let raw = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT id, agent_id, name, config, created_at, updated_at
                 FROM prompt_suites WHERE id = ?1",
                params![suite_id],
                raw_suite,
            )
            .optional()?
        };
        raw.map(|raw| self.suite_from_raw(raw)).transpose()
    }

    pub async fn update_suite(
        &self,
        suite_id: &str,
        name: &str,
        config: &Value,
    ) -> Result<Option<PromptSuiteRecord>> {
        let name = name.trim();
        if name.is_empty() {
            anyhow::bail!("prompt suite name is required");
        }
        let now = now_millis();
        let config_json = self.seal_json(config, SUITE_CONFIG, suite_id)?;
        let conn = self.conn.lock().await;
        let changed = conn.execute(
            "UPDATE prompt_suites SET name = ?1, config = ?2, updated_at = ?3 WHERE id = ?4",
            params![name, config_json, now, suite_id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        drop(conn);
        self.get_suite(suite_id).await
    }

    /// Append one trace-derived case to a suite and return the updated suite.
    ///
    /// The caller owns authorization and trace-to-case extraction. Keeping the
    /// mutation here means imported cases use the same suite persistence and
    /// versioning path as hand-authored Promptfoo cases.
    pub async fn append_case(
        &self,
        suite_id: &str,
        case: &Value,
    ) -> Result<Option<PromptSuiteRecord>> {
        Ok(self
            .append_case_if_absent(suite_id, case)
            .await?
            .map(|(suite, _added)| suite))
    }

    /// Append one case while holding the SQLite write lock across the duplicate
    /// check and update. Trace import retries are common (the browser can replay a
    /// request after a lost response), so an `id` already present in the suite is
    /// treated as an idempotent no-op. Returning the boolean lets the HTTP layer
    /// report whether it created a new case without doing a second racy read.
    pub async fn append_case_if_absent(
        &self,
        suite_id: &str,
        case: &Value,
    ) -> Result<Option<(PromptSuiteRecord, bool)>> {
        let conn = self.conn.lock().await;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            let suite = conn
                .query_row(
                    "SELECT id, agent_id, name, config, created_at, updated_at
                     FROM prompt_suites WHERE id = ?1",
                    params![suite_id],
                    raw_suite,
                )
                .optional()?;
            let Some(suite) = suite else {
                return Ok(None);
            };
            let suite = self.suite_from_raw(suite)?;

            let mut config = suite.config.clone();
            let object = config
                .as_object_mut()
                .ok_or_else(|| anyhow::anyhow!("prompt suite config must be a JSON object"))?;
            let tests = object
                .entry("tests".to_owned())
                .or_insert_with(|| Value::Array(Vec::new()));
            let cases = tests
                .as_array_mut()
                .ok_or_else(|| anyhow::anyhow!("prompt suite tests must be an array"))?;

            if let Some(case_id) = case.get("id").and_then(Value::as_str) {
                if cases
                    .iter()
                    .any(|existing| existing.get("id").and_then(Value::as_str) == Some(case_id))
                {
                    return Ok(Some((suite, false)));
                }
            }
            if cases.len() >= MAX_SUITE_CASES {
                anyhow::bail!("prompt suite cannot contain more than {MAX_SUITE_CASES} cases");
            }
            cases.push(case.clone());
            let now = now_millis();
            conn.execute(
                "UPDATE prompt_suites SET config = ?1, updated_at = ?2 WHERE id = ?3",
                params![
                    self.seal_json(&config, SUITE_CONFIG, suite_id)?,
                    now,
                    suite_id
                ],
            )?;
            let updated = conn
                .query_row(
                    "SELECT id, agent_id, name, config, created_at, updated_at
                     FROM prompt_suites WHERE id = ?1",
                    params![suite_id],
                    raw_suite,
                )
                .optional()?;
            updated
                .map(|suite| self.suite_from_raw(suite).map(|suite| (suite, true)))
                .transpose()
        })();
        match result {
            Ok(value) => {
                conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub async fn delete_suite(&self, suite_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            let changed =
                conn.execute("DELETE FROM prompt_suites WHERE id = ?1", params![suite_id])?;
            if changed == 0 {
                return Ok(false);
            }
            conn.execute(
                "DELETE FROM prompt_suite_versions WHERE suite_id = ?1",
                params![suite_id],
            )?;
            conn.execute(
                "DELETE FROM prompt_reviews WHERE run_id IN (
                    SELECT id FROM prompt_runs WHERE suite_id = ?1
                )",
                params![suite_id],
            )?;
            conn.execute(
                "DELETE FROM prompt_runs WHERE suite_id = ?1",
                params![suite_id],
            )?;
            Ok(true)
        })();
        match result {
            Ok(value) => {
                conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub async fn snapshot_suite(
        &self,
        suite_id: &str,
        label: Option<&str>,
    ) -> Result<Option<PromptSuiteVersionMeta>> {
        let Some(suite) = self.get_suite(suite_id).await? else {
            return Ok(None);
        };
        let id = new_id("psv");
        let now = now_millis();
        let config = self.seal_json(&suite.config, VERSION_CONFIG, &id)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO prompt_suite_versions (id, suite_id, config, label, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, suite_id, config, label, now],
        )?;
        conn.execute(
            "DELETE FROM prompt_suite_versions
             WHERE suite_id = ?1 AND id NOT IN (
               SELECT id FROM prompt_suite_versions WHERE suite_id = ?1
               ORDER BY created_at DESC, id DESC LIMIT ?2
             )",
            params![suite_id, MAX_SUITE_VERSIONS],
        )?;
        Ok(Some(PromptSuiteVersionMeta {
            created_at: now,
            id,
            label: label.map(str::to_owned),
            suite_id: suite.id,
        }))
    }

    pub async fn list_versions(&self, suite_id: &str) -> Result<Vec<PromptSuiteVersionMeta>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, suite_id, label, created_at FROM prompt_suite_versions
             WHERE suite_id = ?1 ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt
            .query_map(params![suite_id], |row| {
                Ok(PromptSuiteVersionMeta {
                    id: row.get(0)?,
                    suite_id: row.get(1)?,
                    label: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub async fn get_version(
        &self,
        suite_id: &str,
        version_id: &str,
    ) -> Result<Option<PromptSuiteVersion>> {
        let raw = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT id, suite_id, config, label, created_at FROM prompt_suite_versions
                 WHERE id = ?1 AND suite_id = ?2",
                params![version_id, suite_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()?
        };
        raw.map(|(id, suite_id, config, label, created_at)| {
            Ok(PromptSuiteVersion {
                config: self.open_json(&config, VERSION_CONFIG, &id)?,
                created_at,
                id,
                label,
                suite_id,
            })
        })
        .transpose()
    }

    pub async fn restore_version(
        &self,
        suite_id: &str,
        version_id: &str,
    ) -> Result<Option<PromptSuiteRecord>> {
        let Some(version) = self.get_version(suite_id, version_id).await? else {
            return Ok(None);
        };
        let _ = self
            .snapshot_suite(suite_id, Some("Before restore"))
            .await?;
        let Some(current) = self.get_suite(suite_id).await? else {
            return Ok(None);
        };
        self.update_suite(suite_id, &current.name, &version.config)
            .await
    }

    pub async fn save_run(
        &self,
        suite_id: &str,
        name: &str,
        request: &Value,
        result: &Value,
    ) -> Result<Option<PromptRunMeta>> {
        if self.get_suite(suite_id).await?.is_none() {
            return Ok(None);
        }
        let id = new_id("pr");
        let now = now_millis();
        let request = self.seal_json(request, RUN_REQUEST, &id)?;
        let result = self.seal_json(result, RUN_RESULT, &id)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO prompt_runs (id, suite_id, name, request, result, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                suite_id,
                if name.trim().is_empty() {
                    "Untitled run"
                } else {
                    name.trim()
                },
                request,
                result,
                now
            ],
        )?;
        Ok(Some(PromptRunMeta {
            created_at: now,
            id,
            name: if name.trim().is_empty() {
                "Untitled run".to_owned()
            } else {
                name.trim().to_owned()
            },
            suite_id: suite_id.to_owned(),
        }))
    }

    pub async fn list_runs(&self, suite_id: &str) -> Result<Vec<PromptRunMeta>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, suite_id, name, created_at FROM prompt_runs
             WHERE suite_id = ?1 ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt
            .query_map(params![suite_id], |row| {
                Ok(PromptRunMeta {
                    id: row.get(0)?,
                    suite_id: row.get(1)?,
                    name: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub async fn get_run(&self, suite_id: &str, run_id: &str) -> Result<Option<PromptRun>> {
        let raw = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT id, suite_id, name, request, result, created_at FROM prompt_runs
                 WHERE id = ?1 AND suite_id = ?2",
                params![run_id, suite_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .optional()?
        };
        raw.map(|(id, suite_id, name, request, result, created_at)| {
            Ok(PromptRun {
                request: self.open_json(&request, RUN_REQUEST, &id)?,
                result: self.open_json(&result, RUN_RESULT, &id)?,
                created_at,
                id,
                name,
                suite_id,
            })
        })
        .transpose()
    }

    pub async fn rename_run(
        &self,
        suite_id: &str,
        run_id: &str,
        name: &str,
    ) -> Result<Option<PromptRunMeta>> {
        let name = name.trim();
        if name.is_empty() {
            anyhow::bail!("prompt run name is required");
        }
        let conn = self.conn.lock().await;
        let changed = conn.execute(
            "UPDATE prompt_runs SET name = ?1 WHERE id = ?2 AND suite_id = ?3",
            params![name, run_id, suite_id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        drop(conn);
        self.list_runs(suite_id)
            .await
            .map(|runs| runs.into_iter().find(|run| run.id == run_id))
    }

    pub async fn delete_run(&self, suite_id: &str, run_id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            let changed = conn.execute(
                "DELETE FROM prompt_runs WHERE id = ?1 AND suite_id = ?2",
                params![run_id, suite_id],
            )?;
            if changed > 0 {
                conn.execute(
                    "DELETE FROM prompt_reviews WHERE run_id = ?1",
                    params![run_id],
                )?;
            }
            Ok(changed > 0)
        })();
        match result {
            Ok(value) => {
                conn.execute_batch("COMMIT")?;
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    pub async fn duplicate_run(
        &self,
        suite_id: &str,
        run_id: &str,
        name: Option<&str>,
    ) -> Result<Option<PromptRunMeta>> {
        let Some(run) = self.get_run(suite_id, run_id).await? else {
            return Ok(None);
        };
        self.save_run(
            suite_id,
            name.unwrap_or_else(|| "").trim(),
            &run.request,
            &run.result,
        )
        .await
    }

    pub async fn save_review(&self, review: &PromptReview) -> Result<PromptReview> {
        let now = now_millis();
        let comment = self.seal.seal_opt(
            review.comment.as_deref(),
            &review_context(&review.run_id, &review.result_key),
        )?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO prompt_reviews
                (run_id, result_key, pass, score, comment, highlighted, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(run_id, result_key) DO UPDATE SET
                pass = excluded.pass,
                score = excluded.score,
                comment = excluded.comment,
                highlighted = excluded.highlighted,
                updated_at = excluded.updated_at",
            params![
                review.run_id,
                review.result_key,
                review.pass.map(i64::from),
                review.score,
                comment,
                i64::from(review.highlighted),
                now
            ],
        )?;
        Ok(PromptReview {
            updated_at: now,
            ..review.clone()
        })
    }

    pub async fn list_reviews(&self, run_id: &str) -> Result<Vec<PromptReview>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT run_id, result_key, pass, score, comment, highlighted, updated_at
                 FROM prompt_reviews WHERE run_id = ?1 ORDER BY result_key",
            )?;
            let rows = stmt.query_map(params![run_id], |row| {
                Ok(PromptReview {
                    run_id: row.get(0)?,
                    result_key: row.get(1)?,
                    pass: row.get::<_, Option<i64>>(2)?.map(|v| v != 0),
                    score: row.get(3)?,
                    comment: row.get(4)?,
                    highlighted: row.get::<_, i64>(5)? != 0,
                    updated_at: row.get(6)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut reviews = Vec::with_capacity(rows.len());
        let mut skipped = 0u64;
        for mut review in rows {
            let context = review_context(&review.run_id, &review.result_key);
            match self.seal.open_opt(review.comment.as_deref(), &context) {
                Ok(comment) => {
                    review.comment = comment;
                    reviews.push(review);
                }
                Err(_) => skipped += 1,
            }
        }
        self.seal.count_unreadable(skipped);
        Ok(reviews)
    }
}

/// Seal legacy plaintext review comments and reseal comments sealed under a
/// retired key. `prompt_reviews` is keyed by `(run_id, result_key)`, so it is
/// walked here (every non-empty row, one transaction; the table is small)
/// instead of by the single-key cursor migration. Compare-and-swap on the
/// stored value; idempotent. A comment that does not open is left as it is.
/// Returns how many values were rewritten.
fn seal_legacy_review_comments(conn: &mut Connection, seal: &StoreSeal) -> Result<u64> {
    let transaction = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let rows = {
        let mut stmt = transaction.prepare(
            "SELECT run_id, result_key, comment FROM prompt_reviews
             WHERE comment IS NOT NULL AND comment != ''",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut sealed = 0u64;
    for (run_id, result_key, comment) in rows {
        let Ok(Some(value)) =
            seal.reseal_if_needed(&comment, &review_context(&run_id, &result_key))
        else {
            continue;
        };
        sealed += transaction.execute(
            "UPDATE prompt_reviews SET comment = ?1
             WHERE run_id = ?2 AND result_key = ?3 AND comment IS ?4",
            params![value, run_id, result_key, comment],
        )? as u64;
    }
    transaction.commit()?;
    Ok(sealed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cipher() -> ContentCipher {
        ContentCipher::from_root(&[17u8; 32], STORE)
    }

    fn file_contains(path: &Path, needle: &str) -> bool {
        std::fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
            .unwrap_or(false)
    }

    #[tokio::test]
    async fn every_content_column_is_sealed_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prompt-evals.db");
        let store = PromptEvalStore::open_at(path.clone(), test_cipher()).unwrap();
        let suite = store
            .create_suite(
                "agent-1",
                "Suite",
                &serde_json::json!({"prompts": ["system-prompt-marker"]}),
            )
            .await
            .unwrap();
        store.snapshot_suite(&suite.id, Some("v1")).await.unwrap();
        let run = store
            .save_run(
                &suite.id,
                "run",
                &serde_json::json!({"input": "request-marker"}),
                &serde_json::json!({"output": "result-marker"}),
            )
            .await
            .unwrap()
            .unwrap();
        store
            .save_review(&PromptReview {
                comment: Some("comment-marker".to_owned()),
                highlighted: false,
                pass: None,
                result_key: "k".to_owned(),
                run_id: run.id.clone(),
                score: None,
                updated_at: 0,
            })
            .await
            .unwrap();
        for file in [path.clone(), dir.path().join("prompt-evals.db-wal")] {
            for marker in [
                "system-prompt-marker",
                "request-marker",
                "result-marker",
                "comment-marker",
            ] {
                assert!(
                    !file_contains(&file, marker),
                    "{marker} in {}",
                    file.display()
                );
            }
        }
        let got = store.get_run(&suite.id, &run.id).await.unwrap().unwrap();
        assert_eq!(got.result["output"], "result-marker");
        assert_eq!(
            store.list_reviews(&run.id).await.unwrap()[0]
                .comment
                .as_deref(),
            Some("comment-marker")
        );
        let conn = Connection::open(&path).unwrap();
        ryu_crypto::content_sqlite::assert_all_open(
            &conn,
            &test_cipher(),
            &column_plans().unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn legacy_rows_are_sealed_once_and_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prompt-evals.db");
        {
            let conn = Connection::open(&path).unwrap();
            PromptEvalStore::migrate(&conn).unwrap();
            conn.execute_batch(
                r#"INSERT INTO prompt_suites VALUES ('ps_1', 'agent-1', 'S', '{"tests":["legacy-config-marker"]}', 1, 1);
                   INSERT INTO prompt_suite_versions VALUES ('psv_1', 'ps_1', '{"v":"legacy-version-marker"}', NULL, 1);
                   INSERT INTO prompt_runs VALUES ('pr_1', 'ps_1', 'r', '{"q":"legacy-request-marker"}', '{"a":"legacy-result-marker"}', 1);
                   INSERT INTO prompt_reviews VALUES ('pr_1', 'k', NULL, NULL, 'legacy-comment-marker', 0, 1);"#,
            )
            .unwrap();
        }
        let store = PromptEvalStore::open_at(path.clone(), test_cipher()).unwrap();
        assert_eq!(
            store.get_suite("ps_1").await.unwrap().unwrap().config["tests"][0],
            "legacy-config-marker"
        );
        assert_eq!(
            store
                .get_version("ps_1", "psv_1")
                .await
                .unwrap()
                .unwrap()
                .config["v"],
            "legacy-version-marker"
        );
        assert_eq!(
            store
                .get_run("ps_1", "pr_1")
                .await
                .unwrap()
                .unwrap()
                .request["q"],
            "legacy-request-marker"
        );
        assert_eq!(
            store.list_reviews("pr_1").await.unwrap()[0]
                .comment
                .as_deref(),
            Some("legacy-comment-marker")
        );
        drop(store);
        for file in [path.clone(), dir.path().join("prompt-evals.db-wal")] {
            for marker in [
                "legacy-config-marker",
                "legacy-version-marker",
                "legacy-request-marker",
                "legacy-result-marker",
                "legacy-comment-marker",
            ] {
                assert!(
                    !file_contains(&file, marker),
                    "{marker} in {}",
                    file.display()
                );
            }
        }
        let snapshot = |path: &Path| -> Vec<String> {
            let conn = Connection::open(path).unwrap();
            conn.query_row(
                "SELECT s.config, v.config, r.request, r.result, w.comment
                 FROM prompt_suites s, prompt_suite_versions v, prompt_runs r, prompt_reviews w",
                [],
                |row| Ok((0..5).map(|i| row.get::<_, String>(i).unwrap()).collect()),
            )
            .unwrap()
        };
        let first = snapshot(&path);
        assert!(first.iter().all(|value| value.starts_with("encb:v1:")));
        let _store = PromptEvalStore::open_at(path.clone(), test_cipher()).unwrap();
        assert_eq!(snapshot(&path), first, "second open is a no-op");
    }

    #[tokio::test]
    async fn a_key_adoption_reseals_every_value_including_review_comments() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prompt-evals.db");
        let root_a = [17u8; 32];
        let root_b = [23u8; 32];
        let run_id = {
            let store =
                PromptEvalStore::open_at(path.clone(), ContentCipher::from_root(&root_a, STORE))
                    .unwrap();
            let suite = store
                .create_suite("agent-1", "S", &serde_json::json!({"a": 1}))
                .await
                .unwrap();
            let run = store
                .save_run(
                    &suite.id,
                    "r",
                    &serde_json::json!({"q": 1}),
                    &serde_json::json!({"a": 2}),
                )
                .await
                .unwrap()
                .unwrap();
            store
                .save_review(&PromptReview {
                    comment: Some("rotated-comment".to_owned()),
                    highlighted: false,
                    pass: None,
                    result_key: "k".to_owned(),
                    run_id: run.id.clone(),
                    score: None,
                    updated_at: 0,
                })
                .await
                .unwrap();
            run.id
        };
        // Adopt root B, keeping A as a retired key.
        let rotated = ContentCipher::from_root(&root_b, STORE).with_retired_roots(&[root_a]);
        drop(PromptEvalStore::open_at(path.clone(), rotated).unwrap());
        // Every value now opens under B alone.
        let only_b = ContentCipher::from_root(&root_b, STORE);
        let conn = Connection::open(&path).unwrap();
        ryu_crypto::content_sqlite::assert_all_open(&conn, &only_b, &column_plans().unwrap())
            .unwrap();
        drop(conn);
        let store = PromptEvalStore::open_at(path.clone(), only_b).unwrap();
        assert_eq!(
            store.list_reviews(&run_id).await.unwrap()[0]
                .comment
                .as_deref(),
            Some("rotated-comment")
        );
        assert_eq!(store.unreadable_rows(), 0);
    }

    #[tokio::test]
    async fn a_config_copied_to_another_suite_is_an_error_not_null() {
        let store = PromptEvalStore::open_in_memory().unwrap();
        let a = store
            .create_suite("agent-1", "A", &serde_json::json!({"a": 1}))
            .await
            .unwrap();
        let b = store
            .create_suite("agent-1", "B", &serde_json::json!({"b": 2}))
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE prompt_suites SET config = (SELECT config FROM prompt_suites WHERE id = ?1)
                 WHERE id = ?2",
                params![a.id, b.id],
            )
            .unwrap();
        }
        assert!(store.get_suite(&b.id).await.is_err());
        let listed = store.list_suites("agent-1").await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, a.id);
        assert_eq!(store.unreadable_rows(), 1);
    }

    #[tokio::test]
    async fn suite_version_run_and_review_roundtrip() {
        let store = PromptEvalStore::open_in_memory().unwrap();
        let suite = store
            .create_suite("agent-1", "Regression", &serde_json::json!({"tests": []}))
            .await
            .unwrap();
        let version = store
            .snapshot_suite(&suite.id, Some("Baseline"))
            .await
            .unwrap()
            .unwrap();
        store
            .update_suite(
                &suite.id,
                "Regression",
                &serde_json::json!({"tests": [{"id": "case-1"}]}),
            )
            .await
            .unwrap();
        let run = store
            .save_run(
                &suite.id,
                "First run",
                &serde_json::json!({"model": "m1"}),
                &serde_json::json!({"cases": []}),
            )
            .await
            .unwrap()
            .unwrap();
        let review = store
            .save_review(&PromptReview {
                comment: Some("Looks good".to_owned()),
                highlighted: true,
                pass: Some(true),
                result_key: "case-1:m1".to_owned(),
                run_id: run.id.clone(),
                score: Some(0.9),
                updated_at: 0,
            })
            .await
            .unwrap();
        assert_eq!(store.list_suites("agent-1").await.unwrap().len(), 1);
        assert_eq!(store.list_versions(&suite.id).await.unwrap().len(), 1);
        assert_eq!(store.list_runs(&suite.id).await.unwrap().len(), 1);
        assert_eq!(store.list_reviews(&run.id).await.unwrap()[0], review);
        assert_eq!(
            store
                .restore_version(&suite.id, &version.id)
                .await
                .unwrap()
                .unwrap()
                .config,
            serde_json::json!({"tests": []})
        );
    }

    #[tokio::test]
    async fn append_case_updates_suite_without_dropping_existing_config() {
        let store = PromptEvalStore::open_in_memory().unwrap();
        let suite = store
            .create_suite(
                "agent-1",
                "Regression",
                &serde_json::json!({
                    "prompts": ["You are helpful."],
                    "providers": ["openai:gpt-4o-mini"],
                    "tests": [{"id": "existing"}]
                }),
            )
            .await
            .unwrap();

        let updated = store
            .append_case(
                &suite.id,
                &serde_json::json!({
                    "id": "trace-run-1",
                    "prompt": "What is 2 + 2?",
                    "expected": "4",
                    "metadata": {"source": "ryu-trace"}
                }),
            )
            .await
            .unwrap()
            .unwrap();

        assert_eq!(updated.config["prompts"][0], "You are helpful.");
        assert_eq!(updated.config["tests"].as_array().unwrap().len(), 2);
        assert_eq!(updated.config["tests"][1]["id"], "trace-run-1");
    }

    #[tokio::test]
    async fn append_case_is_idempotent_and_atomic_for_duplicate_trace_ids() {
        let store = PromptEvalStore::open_in_memory().unwrap();
        let suite = store
            .create_suite("agent-1", "Regression", &serde_json::json!({"tests": []}))
            .await
            .unwrap();
        let case = serde_json::json!({
            "id": "trace-run-1",
            "prompt": "What is 2 + 2?",
            "expected": "4"
        });

        let (first, second) = tokio::join!(
            store.append_case_if_absent(&suite.id, &case),
            store.append_case_if_absent(&suite.id, &case),
        );
        let (first, first_added) = first.unwrap().unwrap();
        let (second, second_added) = second.unwrap().unwrap();
        assert_ne!(
            first_added, second_added,
            "exactly one concurrent import adds"
        );
        assert_eq!(
            first.config["tests"].as_array().unwrap().len(),
            second.config["tests"].as_array().unwrap().len()
        );
        assert_eq!(
            store.get_suite(&suite.id).await.unwrap().unwrap().config["tests"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
