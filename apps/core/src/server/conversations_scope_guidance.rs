//! Per-scope prompt guidance: project goals, bot goals, a bot's goal inside one
//! project, a project's standing instructions, and whether main threads answer
//! briefly.
//!
//! Stored against the same opaque scopes as the model defaults
//! (`project:<p>`, `agent:<a>`, `project:<p>/agent:<a>`; see
//! [`super::hierarchy`]) so the Projects app and Desktop write them through one
//! generic, app-agnostic route and Core never interprets a project id. Every
//! field is optional: an empty goal or instructions and an unset
//! `brief_replies` mean "not set here", and a row with none is deleted.
//! Instructions are a `project:<p>` field only: a bot's own instructions live on
//! the agent, and a bot inside a project already has its per-project goal.
//!
//! Goals and instructions are user prompt text, so they are sealed at rest like
//! chat content (`enc:v1:`, the conversation store's cipher). Rows written
//! before sealing read as plaintext and are sealed when the store opens (see
//! `seal_legacy_run_text`); `brief_replies`, the scope and the timestamp stay
//! readable. A value that does not open is logged and read as unset, so a wrong
//! key never puts ciphertext into a prompt.
//!
//! Prompt-cache contract: [`TurnGuidance::system_layer`] is a pure function of
//! the stored rows, so it is byte-identical turn after turn and only changes
//! when a user edits a goal, the instructions or the brief toggle. That edit invalidates the
//! provider prompt cache for every thread in the scope on its next turn, which
//! is why the editors confirm before saving (`promptEditCacheWarning` in
//! `packages/blocks/src/desktop/agent-elements/prompt-cache.ts`).

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::hierarchy::{agent_scope, is_valid_scope, project_agent_scope, project_scope};
use super::{now_millis, ConversationStore};

/// Longest goal accepted for one scope. Goals ride in every turn's system
/// prompt, so they are kept to a short paragraph rather than a document.
pub const MAX_GOAL_CHARS: usize = 2_000;

/// Longest project instructions accepted. They ride in every member thread's
/// system prompt like goals, so they are capped too, at a few paragraphs.
pub const MAX_INSTRUCTIONS_CHARS: usize = 4_000;

/// Brief replies are on for project and bot main threads unless a scope turns
/// them off.
const DEFAULT_BRIEF_REPLIES: bool = true;

/// The stable instruction main threads carry when brief replies are on. It
/// mirrors the pulse-style bots (Grok's bot, Meta's Muse) the Bot mode design
/// follows: short status-update replies that are easy to scan, with the long
/// form one request away.
pub const BRIEF_REPLIES_INSTRUCTION: &str = "## Reply style for this thread\n\
    This is a main thread the user scans like a feed. Keep replies brief: lead \
    with the answer or status in one or two short sentences, then at most a few \
    short bullets. Skip preamble, recaps and sign-offs. Give the full detail only \
    when the user asks for it, or move long work into a session thread and \
    report back here in one line.";

/// One scope's stored guidance. Empty/`None` fields are "not set here".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeGuidance {
    #[serde(default)]
    pub goal: String,
    /// Standing instructions for every member thread (`project:<p>` only).
    #[serde(default)]
    pub instructions: String,
    #[serde(
        default,
        rename = "briefReplies",
        alias = "brief_replies",
        skip_serializing_if = "Option::is_none"
    )]
    pub brief_replies: Option<bool>,
}

impl ScopeGuidance {
    fn normalized(self) -> Self {
        Self {
            goal: self.goal.trim().to_owned(),
            instructions: self.instructions.trim().to_owned(),
            brief_replies: self.brief_replies,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.goal.trim().is_empty()
            && self.instructions.trim().is_empty()
            && self.brief_replies.is_none()
    }
}

/// A write of one scope's guidance. Omitted fields keep their stored value so a
/// goal editor never resets the brief toggle or the instructions and vice
/// versa; `""` clears a goal or the instructions and an explicit `null` for
/// `briefReplies` resets it to inherited.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ScopeGuidanceInput {
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(
        default,
        rename = "briefReplies",
        alias = "brief_replies",
        deserialize_with = "double_option"
    )]
    pub brief_replies: Option<Option<bool>>,
}

fn double_option<'de, D>(deserializer: D) -> Result<Option<Option<bool>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<bool>::deserialize(deserializer).map(Some)
}

impl ScopeGuidanceInput {
    pub fn merged_over(self, stored: ScopeGuidance) -> ScopeGuidance {
        ScopeGuidance {
            goal: self.goal.unwrap_or(stored.goal),
            instructions: self.instructions.unwrap_or(stored.instructions),
            brief_replies: self.brief_replies.unwrap_or(stored.brief_replies),
        }
    }
}

/// Every guidance level that applies to one turn.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnGuidance {
    pub project: Option<ScopeGuidance>,
    pub agent: Option<ScopeGuidance>,
    pub project_agent: Option<ScopeGuidance>,
}

fn goal_of(level: &Option<ScopeGuidance>) -> Option<&str> {
    level
        .as_ref()
        .map(|level| level.goal.trim())
        .filter(|goal| !goal.is_empty())
}

impl TurnGuidance {
    /// Whether brief replies apply: the most specific level that sets the
    /// toggle wins (`project:<p>/agent:<a>` > `agent:<a>` > `project:<p>`).
    pub fn brief_replies(&self) -> bool {
        [&self.project_agent, &self.agent, &self.project]
            .into_iter()
            .find_map(|level| level.as_ref().and_then(|level| level.brief_replies))
            .unwrap_or(DEFAULT_BRIEF_REPLIES)
    }

    /// The project's standing instructions as one system-prompt layer, or
    /// `None` when the project sets none. Only the `project:<p>` level carries
    /// instructions. Deterministic: same row, same bytes.
    pub fn instructions_layer(&self) -> Option<String> {
        self.project
            .as_ref()
            .map(|level| level.instructions.trim())
            .filter(|text| !text.is_empty())
            .map(|text| format!("## Project instructions\n{text}"))
    }

    /// The goals as one system-prompt layer, broadest first, or `None` when no
    /// level sets one. Deterministic: same rows, same bytes.
    pub fn goals_layer(&self) -> Option<String> {
        let lines: Vec<String> = [
            ("Project goal", goal_of(&self.project)),
            ("Your goal", goal_of(&self.agent)),
            ("Your goal in this project", goal_of(&self.project_agent)),
        ]
        .into_iter()
        .filter_map(|(label, goal)| goal.map(|goal| format!("- {label}: {goal}")))
        .collect();
        (!lines.is_empty()).then(|| {
            format!(
                "## Goals\n{}\nKeep your work pointed at these goals. When a request \
                 conflicts with one, say so briefly before you proceed.",
                lines.join("\n")
            )
        })
    }
}

pub(super) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS scope_guidance (
             scope         TEXT PRIMARY KEY,
             goal          TEXT NOT NULL DEFAULT '',
             instructions  TEXT NOT NULL DEFAULT '',
             brief_replies INTEGER,
             updated_at    INTEGER NOT NULL
         );",
    )
    .context("creating scope guidance table")?;
    // Additive: tables created before project instructions joined the layer.
    let has_instructions = conn
        .prepare("PRAGMA table_info(scope_guidance)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .filter_map(|name| name.ok())
        .any(|name| name == "instructions");
    if !has_instructions {
        conn.execute_batch(
            "ALTER TABLE scope_guidance ADD COLUMN instructions TEXT NOT NULL DEFAULT ''",
        )
        .context("adding scope guidance instructions column")?;
    }
    Ok(())
}

/// Whether `scope` is a bare `project:<p>` scope, the only one that may carry
/// instructions. Valid ids never contain `/`, so any `/` means a nested scope.
fn is_project_only_scope(scope: &str) -> bool {
    scope.starts_with("project:") && !scope.contains('/')
}

/// Whether guidance may be stored at `scope`: every model-default scope except
/// the node-wide `global` one (a node-wide goal is the user personalization's
/// job, not a project setting).
pub fn is_valid_guidance_scope(scope: &str) -> bool {
    scope != super::hierarchy::GLOBAL_SCOPE && is_valid_scope(scope)
}

fn guidance_from_row(row: &rusqlite::Row<'_>, start: usize) -> rusqlite::Result<ScopeGuidance> {
    Ok(ScopeGuidance {
        goal: row.get(start)?,
        instructions: row.get(start + 1)?,
        brief_replies: row.get(start + 2)?,
    })
}

impl ConversationStore {
    /// Open one stored guidance text. Legacy plaintext passes through; a value
    /// that does not open reads as unset.
    fn open_guidance_text(&self, scope: &str, field: &str, stored: String) -> String {
        self.cipher.open(&stored).unwrap_or_else(|error| {
            tracing::warn!("could not open scope guidance {field} for '{scope}': {error}");
            String::new()
        })
    }

    fn open_guidance(&self, scope: &str, raw: ScopeGuidance) -> ScopeGuidance {
        ScopeGuidance {
            goal: self.open_guidance_text(scope, "goal", raw.goal),
            instructions: self.open_guidance_text(scope, "instructions", raw.instructions),
            brief_replies: raw.brief_replies,
        }
    }

    /// Seal one guidance text for storage; an empty text stays empty ("not set").
    fn seal_guidance_text(&self, text: &str) -> Result<String> {
        if text.is_empty() {
            return Ok(String::new());
        }
        self.cipher.seal(text)
    }

    /// One scope's stored guidance, if set.
    pub async fn scope_guidance(&self, scope: &str) -> Result<Option<ScopeGuidance>> {
        let raw = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT goal, instructions, brief_replies FROM scope_guidance WHERE scope = ?1",
                params![scope],
                |row| guidance_from_row(row, 0),
            )
            .optional()?
        };
        Ok(raw.map(|raw| self.open_guidance(scope, raw)))
    }

    /// Every stored scope's guidance, keyed by scope.
    pub async fn list_scope_guidance(&self) -> Result<Vec<(String, ScopeGuidance)>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT scope, goal, instructions, brief_replies FROM scope_guidance ORDER BY scope",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, guidance_from_row(row, 1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(rows
            .into_iter()
            .map(|(scope, raw)| {
                let guidance = self.open_guidance(&scope, raw);
                (scope, guidance)
            })
            .collect())
    }

    /// Write one scope's guidance. Returns whether the stored value changed, so
    /// callers can tell the user a prompt-cache reset is coming only when one
    /// is. An empty value clears the scope.
    pub async fn set_scope_guidance(&self, scope: &str, value: ScopeGuidance) -> Result<bool> {
        if !is_valid_guidance_scope(scope) {
            anyhow::bail!("invalid scope '{scope}'");
        }
        let value = value.normalized();
        if value.goal.chars().count() > MAX_GOAL_CHARS {
            anyhow::bail!("goals are limited to {MAX_GOAL_CHARS} characters");
        }
        if value.instructions.chars().count() > MAX_INSTRUCTIONS_CHARS {
            anyhow::bail!("instructions are limited to {MAX_INSTRUCTIONS_CHARS} characters");
        }
        if !value.instructions.is_empty() && !is_project_only_scope(scope) {
            anyhow::bail!("instructions can be set only on a project:<id> scope");
        }
        let sealed_goal = self.seal_guidance_text(&value.goal)?;
        let sealed_instructions = self.seal_guidance_text(&value.instructions)?;
        let conn = self.conn.lock().await;
        let stored: Option<ScopeGuidance> = conn
            .query_row(
                "SELECT goal, instructions, brief_replies FROM scope_guidance WHERE scope = ?1",
                params![scope],
                |row| guidance_from_row(row, 0),
            )
            .optional()?
            .map(|raw| self.open_guidance(scope, raw));
        if stored.clone().unwrap_or_default() == value {
            return Ok(false);
        }
        if value.is_empty() {
            conn.execute(
                "DELETE FROM scope_guidance WHERE scope = ?1",
                params![scope],
            )?;
            return Ok(stored.is_some());
        }
        conn.execute(
            "INSERT INTO scope_guidance (scope, goal, instructions, brief_replies, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(scope) DO UPDATE SET
                 goal = excluded.goal, instructions = excluded.instructions,
                 brief_replies = excluded.brief_replies, updated_at = excluded.updated_at",
            params![
                scope,
                sealed_goal,
                sealed_instructions,
                value.brief_replies,
                now_millis()
            ],
        )
        .context("writing scope guidance")?;
        Ok(true)
    }

    /// The guidance levels for a turn by `agent_id` in `project_id`.
    pub async fn turn_guidance(
        &self,
        project_id: Option<&str>,
        agent_id: Option<&str>,
    ) -> Result<TurnGuidance> {
        let project_id = project_id.map(str::trim).filter(|p| !p.is_empty());
        let agent_id = agent_id.map(str::trim).filter(|a| !a.is_empty());
        let mut guidance = TurnGuidance::default();
        if let Some(project) = project_id.filter(|p| is_valid_guidance_scope(&project_scope(p))) {
            guidance.project = self.scope_guidance(&project_scope(project)).await?;
        }
        if let Some(agent) = agent_id.filter(|a| is_valid_guidance_scope(&agent_scope(a))) {
            guidance.agent = self.scope_guidance(&agent_scope(agent)).await?;
        }
        if let (Some(project), Some(agent)) = (project_id, agent_id) {
            let scope = project_agent_scope(project, agent);
            if is_valid_guidance_scope(&scope) {
                guidance.project_agent = self.scope_guidance(&scope).await?;
            }
        }
        Ok(guidance)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goal(text: &str) -> Option<ScopeGuidance> {
        Some(ScopeGuidance {
            goal: text.to_owned(),
            ..ScopeGuidance::default()
        })
    }

    fn instructions(text: &str) -> ScopeGuidance {
        ScopeGuidance {
            instructions: text.to_owned(),
            ..ScopeGuidance::default()
        }
    }

    #[test]
    fn goals_layer_orders_broadest_first_and_is_stable() {
        let guidance = TurnGuidance {
            project: goal("Ship v2 by Friday"),
            agent: goal("Keep the codebase tidy"),
            project_agent: goal("Own the release notes"),
        };
        let layer = guidance.goals_layer().unwrap();
        assert_eq!(layer, guidance.goals_layer().unwrap());
        let project = layer.find("Project goal").unwrap();
        let agent = layer.find("- Your goal:").unwrap();
        let pair = layer.find("Your goal in this project").unwrap();
        assert!(project < agent && agent < pair);
    }

    #[test]
    fn no_goals_means_no_layer() {
        assert!(TurnGuidance::default().goals_layer().is_none());
        let blank = TurnGuidance {
            project: goal("   "),
            ..TurnGuidance::default()
        };
        assert!(blank.goals_layer().is_none());
    }

    #[test]
    fn brief_replies_most_specific_level_wins() {
        assert!(TurnGuidance::default().brief_replies());
        let off = |brief| {
            Some(ScopeGuidance {
                brief_replies: Some(brief),
                ..ScopeGuidance::default()
            })
        };
        let guidance = TurnGuidance {
            project: off(false),
            agent: None,
            project_agent: None,
        };
        assert!(!guidance.brief_replies());
        let guidance = TurnGuidance {
            project: off(false),
            agent: off(true),
            project_agent: None,
        };
        assert!(guidance.brief_replies());
        let guidance = TurnGuidance {
            project: off(true),
            agent: off(true),
            project_agent: off(false),
        };
        assert!(!guidance.brief_replies());
    }

    #[test]
    fn input_keeps_omitted_fields_and_null_resets_brief() {
        let stored = ScopeGuidance {
            goal: "keep".into(),
            instructions: "stay".into(),
            brief_replies: Some(false),
        };
        let only_goal: ScopeGuidanceInput = serde_json::from_str(r#"{"goal":"new"}"#).unwrap();
        assert_eq!(
            only_goal.merged_over(stored.clone()),
            ScopeGuidance {
                goal: "new".into(),
                instructions: "stay".into(),
                brief_replies: Some(false)
            }
        );
        let reset: ScopeGuidanceInput = serde_json::from_str(r#"{"briefReplies":null}"#).unwrap();
        assert_eq!(
            reset.merged_over(stored),
            ScopeGuidance {
                goal: "keep".into(),
                instructions: "stay".into(),
                brief_replies: None
            }
        );
    }

    #[tokio::test]
    async fn guidance_round_trips_reports_changes_and_clears() {
        let store = ConversationStore::open_in_memory().unwrap();
        let project = project_scope("atlas");
        let pair = project_agent_scope("atlas", "scout");
        assert!(store
            .set_scope_guidance(&project, goal("Launch").unwrap())
            .await
            .unwrap());
        // Writing the same value again is not a change (no cache reset).
        assert!(!store
            .set_scope_guidance(&project, goal("  Launch ").unwrap())
            .await
            .unwrap());
        store
            .set_scope_guidance(&pair, goal("Write the docs").unwrap())
            .await
            .unwrap();
        let turn = store
            .turn_guidance(Some("atlas"), Some("scout"))
            .await
            .unwrap();
        assert_eq!(turn.project.unwrap().goal, "Launch");
        assert_eq!(turn.project_agent.unwrap().goal, "Write the docs");
        assert!(turn.agent.is_none());
        assert!(store
            .set_scope_guidance(&project, ScopeGuidance::default())
            .await
            .unwrap());
        assert!(store.scope_guidance(&project).await.unwrap().is_none());
        assert_eq!(store.list_scope_guidance().await.unwrap().len(), 1);
        assert!(store
            .set_scope_guidance("global", goal("no").unwrap())
            .await
            .is_err());
        assert!(store
            .set_scope_guidance(&project, goal(&"x".repeat(MAX_GOAL_CHARS + 1)).unwrap())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn goals_and_instructions_are_sealed_at_rest_and_legacy_rows_still_read() {
        let store = ConversationStore::open_in_memory().unwrap();
        let project = project_scope("atlas");
        store
            .set_scope_guidance(
                &project,
                ScopeGuidance {
                    goal: "Launch the secret product".into(),
                    instructions: "Never mention the codename".into(),
                    brief_replies: Some(false),
                },
            )
            .await
            .unwrap();
        let (goal_raw, instructions_raw): (String, String) = store
            .conn
            .lock()
            .await
            .query_row(
                "SELECT goal, instructions FROM scope_guidance WHERE scope = ?1",
                params![project],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(goal_raw.starts_with("enc:"), "{goal_raw}");
        assert!(instructions_raw.starts_with("enc:"), "{instructions_raw}");
        assert!(!goal_raw.contains("secret product"));
        let read = store.scope_guidance(&project).await.unwrap().unwrap();
        assert_eq!(read.goal, "Launch the secret product");
        assert_eq!(read.instructions, "Never mention the codename");
        assert_eq!(read.brief_replies, Some(false));
        // The same value again is still not a change.
        assert!(!store.set_scope_guidance(&project, read).await.unwrap());
        assert_eq!(
            store.list_scope_guidance().await.unwrap()[0].1.goal,
            "Launch the secret product"
        );

        // A row an older build wrote reads as plaintext.
        store
            .conn
            .lock()
            .await
            .execute(
                "INSERT INTO scope_guidance (scope, goal, instructions, brief_replies, updated_at)
                 VALUES ('agent:scout', 'Legacy goal', '', NULL, 1)",
                [],
            )
            .unwrap();
        assert_eq!(
            store
                .scope_guidance("agent:scout")
                .await
                .unwrap()
                .unwrap()
                .goal,
            "Legacy goal"
        );
    }

    #[test]
    fn instructions_layer_comes_from_the_project_level_only_and_is_stable() {
        assert!(TurnGuidance::default().instructions_layer().is_none());
        let guidance = TurnGuidance {
            project: Some(instructions("  Cite sources.  ")),
            agent: Some(instructions("ignored")),
            project_agent: None,
        };
        let layer = guidance.instructions_layer().unwrap();
        assert_eq!(layer, "## Project instructions\nCite sources.");
        assert_eq!(layer, guidance.instructions_layer().unwrap());
        assert!(guidance.goals_layer().is_none());
    }

    #[tokio::test]
    async fn instructions_round_trip_without_touching_goals_and_stay_on_project_scopes() {
        let store = ConversationStore::open_in_memory().unwrap();
        let project = project_scope("atlas");
        store
            .set_scope_guidance(&project, goal("Launch").unwrap())
            .await
            .unwrap();
        let input: ScopeGuidanceInput =
            serde_json::from_str(r#"{"instructions":"Cite sources."}"#).unwrap();
        let stored = store.scope_guidance(&project).await.unwrap().unwrap();
        assert!(store
            .set_scope_guidance(&project, input.merged_over(stored))
            .await
            .unwrap());
        // The same instructions again are not a change (no cache reset).
        let input: ScopeGuidanceInput =
            serde_json::from_str(r#"{"instructions":" Cite sources. "}"#).unwrap();
        let stored = store.scope_guidance(&project).await.unwrap().unwrap();
        assert!(!store
            .set_scope_guidance(&project, input.merged_over(stored))
            .await
            .unwrap());
        let turn = store.turn_guidance(Some("atlas"), None).await.unwrap();
        let level = turn.project.clone().unwrap();
        assert_eq!(level.goal, "Launch");
        assert_eq!(level.instructions, "Cite sources.");
        assert!(turn.instructions_layer().is_some());
        assert!(store
            .set_scope_guidance(&agent_scope("scout"), instructions("no"))
            .await
            .is_err());
        assert!(store
            .set_scope_guidance(&project_agent_scope("atlas", "scout"), instructions("no"))
            .await
            .is_err());
        assert!(store
            .set_scope_guidance(
                &project,
                instructions(&"x".repeat(MAX_INSTRUCTIONS_CHARS + 1))
            )
            .await
            .is_err());
    }

    #[test]
    fn migrate_adds_the_instructions_column_to_an_older_table() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE scope_guidance (
                 scope TEXT PRIMARY KEY, goal TEXT NOT NULL DEFAULT '',
                 brief_replies INTEGER, updated_at INTEGER NOT NULL
             );
             INSERT INTO scope_guidance VALUES ('project:atlas', 'Launch', NULL, 1);",
        )
        .unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let row = conn
            .query_row(
                "SELECT goal, instructions, brief_replies FROM scope_guidance",
                [],
                |row| guidance_from_row(row, 0),
            )
            .unwrap();
        assert_eq!(row, goal("Launch").unwrap());
    }
}
