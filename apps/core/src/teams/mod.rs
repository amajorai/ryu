//! Agent **teams**: a persisted, ordered collection of agents that can be
//! addressed as one unit (`@team` in chat) so a single message fans out to every
//! member.
//!
//! A team is *not* an agent — it is a collection of agent ids plus a
//! **coordination strategy** that decides how the members respond when the team
//! is called:
//!
//! - [`Coordination::Broadcast`] — every member answers the same prompt
//!   independently; no member sees another's reply.
//! - [`Coordination::RoundRobin`] — members answer in order, each seeing the
//!   prior members' replies folded into its prompt.
//! - [`Coordination::DebateSynthesis`] — members answer independently (round 1),
//!   then a designated **lead** agent reads every reply and produces one merged
//!   answer.
//! - [`Coordination::Router`] — a router picks the single best-suited member and
//!   routes only to it.
//!
//! The strategy is a per-team, swappable enum (Ryu's "nothing hardcoded"
//! principle): a team can be re-configured at any time without code changes, and
//! the orchestration that interprets it lives entirely in Core
//! (`sidecar::adapters::route_team_chat_stream`). This module owns only the
//! persistence + typed records, mirroring [`crate::agents::AgentStore`].

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::sidecar::download_manager::ryu_dir;

// ── Coordination strategy ───────────────────────────────────────────────────────

/// How a team's members respond when the team is called. Stored per-team as a
/// lowercase string; defaults to [`Coordination::Broadcast`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Coordination {
    /// Every member answers the same prompt independently (the simplest, the
    /// default). No member sees another's output.
    #[default]
    Broadcast,
    /// Members answer in order; each sees the prior members' replies.
    RoundRobin,
    /// Members answer independently, then a lead agent synthesizes one answer.
    DebateSynthesis,
    /// A router picks the single best-suited member and routes only to it.
    Router,
}

impl Coordination {
    /// Parse the stored string form back into the enum, defaulting to
    /// [`Coordination::Broadcast`] for unknown/legacy values so a bad row never
    /// breaks listing.
    fn from_str_lenient(s: &str) -> Self {
        match s {
            "round-robin" => Self::RoundRobin,
            "debate-synthesis" => Self::DebateSynthesis,
            "router" => Self::Router,
            _ => Self::Broadcast,
        }
    }

    /// The stored string form (kebab-case).
    fn as_str(self) -> &'static str {
        match self {
            Self::Broadcast => "broadcast",
            Self::RoundRobin => "round-robin",
            Self::DebateSynthesis => "debate-synthesis",
            Self::Router => "router",
        }
    }
}

// ── Core record types ───────────────────────────────────────────────────────────

/// A persisted team configuration record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeamRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Ordered list of member agent ids. Order is meaningful for
    /// [`Coordination::RoundRobin`] (turn order) and is the default lead source
    /// for [`Coordination::DebateSynthesis`] when `lead_agent_id` is unset.
    #[serde(default)]
    pub members: Vec<String>,
    /// How members respond when the team is called.
    #[serde(default)]
    pub coordination: Coordination,
    /// The synthesizer for [`Coordination::DebateSynthesis`] (and the classifier
    /// for [`Coordination::Router`]). Falls back to the first member when unset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_agent_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Fields a client may supply when creating a team. `id` is server-assigned.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CreateTeam {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub members: Vec<String>,
    #[serde(default)]
    pub coordination: Coordination,
    #[serde(default)]
    pub lead_agent_id: Option<String>,
}

/// Fields a client may patch on update. Absent fields are left unchanged.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateTeam {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// Replace the full ordered member list. Use the member endpoints for
    /// incremental add/remove (e.g. drag-and-drop).
    #[serde(default)]
    pub members: Option<Vec<String>>,
    #[serde(default)]
    pub coordination: Option<Coordination>,
    /// Patch the lead. `Some(Some(id))` sets it, `Some(None)` clears it, `None`
    /// leaves it unchanged.
    #[serde(default, deserialize_with = "double_option")]
    pub lead_agent_id: Option<Option<String>>,
}

/// Deserialize a field so that a present `null` becomes `Some(None)` (clear) and
/// an absent field becomes `None` (leave unchanged) — the standard JSON-patch
/// tri-state for a nullable column.
fn double_option<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

fn db_path() -> PathBuf {
    ryu_dir().join("teams.db")
}

// ── Store ────────────────────────────────────────────────────────────────────

/// SQLite-backed store for team config records. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct TeamStore {
    conn: Arc<Mutex<Connection>>,
}

impl TeamStore {
    /// Open (creating if needed) the teams DB under `~/.ryu/teams.db` and run the
    /// schema migration.
    pub fn open() -> Result<Self> {
        let path = db_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).context("creating ~/.ryu for teams.db")?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening teams db at {}", path.display()))?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// In-memory store, used by tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn migrate(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS teams (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                description   TEXT,
                members       TEXT NOT NULL DEFAULT '[]',
                coordination  TEXT NOT NULL DEFAULT 'broadcast',
                lead_agent_id TEXT,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );",
        )
        .context("running teams schema migration")?;
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<TeamRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, name, description, members, coordination, lead_agent_id,
                    created_at, updated_at
             FROM teams ORDER BY created_at ASC",
        )?;
        let rows = stmt
            .query_map([], row_to_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub async fn get(&self, id: &str) -> Result<Option<TeamRecord>> {
        let conn = self.conn.lock().await;
        let record = conn
            .query_row(
                "SELECT id, name, description, members, coordination, lead_agent_id,
                        created_at, updated_at
                 FROM teams WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?;
        Ok(record)
    }

    pub async fn create(&self, input: CreateTeam) -> Result<TeamRecord> {
        let id = format!("team_{}", uuid::Uuid::new_v4().simple());
        let now = chrono::Utc::now().to_rfc3339();
        let members_json =
            serde_json::to_string(&input.members).unwrap_or_else(|_| "[]".to_owned());
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO teams
                    (id, name, description, members, coordination, lead_agent_id,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    id,
                    input.name,
                    input.description,
                    members_json,
                    input.coordination.as_str(),
                    input.lead_agent_id,
                    now,
                ],
            )?;
        }
        self.get(&id)
            .await?
            .context("team vanished immediately after insert")
    }

    pub async fn update(&self, id: &str, patch: UpdateTeam) -> Result<Option<TeamRecord>> {
        // Load-modify-store so partial patches are simple and the members JSON is
        // re-serialized atomically under the lock.
        let Some(mut record) = self.get(id).await? else {
            return Ok(None);
        };
        if let Some(name) = patch.name {
            record.name = name;
        }
        if let Some(description) = patch.description {
            record.description = Some(description);
        }
        if let Some(members) = patch.members {
            record.members = members;
        }
        if let Some(coordination) = patch.coordination {
            record.coordination = coordination;
        }
        if let Some(lead) = patch.lead_agent_id {
            record.lead_agent_id = lead;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let members_json =
            serde_json::to_string(&record.members).unwrap_or_else(|_| "[]".to_owned());
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE teams
                 SET name = ?1, description = ?2, members = ?3, coordination = ?4,
                     lead_agent_id = ?5, updated_at = ?6
                 WHERE id = ?7",
                params![
                    record.name,
                    record.description,
                    members_json,
                    record.coordination.as_str(),
                    record.lead_agent_id,
                    now,
                    id,
                ],
            )?;
        }
        self.get(id).await
    }

    pub async fn delete(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let deleted = conn.execute("DELETE FROM teams WHERE id = ?1", params![id])?;
        Ok(deleted > 0)
    }

    /// Append an agent to a team's member list (idempotent). Returns the updated
    /// record, or `None` if the team does not exist. Used by drag-and-drop.
    pub async fn add_member(&self, team_id: &str, agent_id: &str) -> Result<Option<TeamRecord>> {
        let Some(record) = self.get(team_id).await? else {
            return Ok(None);
        };
        if record.members.iter().any(|m| m == agent_id) {
            return Ok(Some(record));
        }
        let mut members = record.members;
        members.push(agent_id.to_owned());
        self.update(
            team_id,
            UpdateTeam {
                members: Some(members),
                ..Default::default()
            },
        )
        .await
    }

    /// Remove an agent from a team's member list (idempotent). Returns the
    /// updated record, or `None` if the team does not exist.
    pub async fn remove_member(&self, team_id: &str, agent_id: &str) -> Result<Option<TeamRecord>> {
        let Some(record) = self.get(team_id).await? else {
            return Ok(None);
        };
        let members: Vec<String> = record
            .members
            .into_iter()
            .filter(|m| m != agent_id)
            .collect();
        self.update(
            team_id,
            UpdateTeam {
                members: Some(members),
                ..Default::default()
            },
        )
        .await
    }
}

/// Map a `teams` row to a [`TeamRecord`]. Column order must match the SELECTs.
fn row_to_record(row: &rusqlite::Row) -> rusqlite::Result<TeamRecord> {
    let members_raw: String = row.get(3)?;
    let coordination_raw: String = row.get(4)?;
    Ok(TeamRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        members: serde_json::from_str(&members_raw).unwrap_or_default(),
        coordination: Coordination::from_str_lenient(&coordination_raw),
        lead_agent_id: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> TeamStore {
        TeamStore::open_in_memory().unwrap()
    }

    #[tokio::test]
    async fn create_list_get_roundtrip() {
        let s = store();
        let t = s
            .create(CreateTeam {
                name: "Research".to_owned(),
                description: Some("paper readers".to_owned()),
                members: vec!["acp:claude".to_owned(), "ryu".to_owned()],
                coordination: Coordination::Broadcast,
                lead_agent_id: None,
            })
            .await
            .unwrap();
        assert!(t.id.starts_with("team_"));
        assert_eq!(t.members, vec!["acp:claude", "ryu"]);
        assert_eq!(t.coordination, Coordination::Broadcast);

        let listed = s.list().await.unwrap();
        assert_eq!(listed.len(), 1);
        let got = s.get(&t.id).await.unwrap().unwrap();
        assert_eq!(got.name, "Research");
        assert_eq!(got.description.as_deref(), Some("paper readers"));
    }

    #[tokio::test]
    async fn add_remove_member_idempotent() {
        let s = store();
        let t = s
            .create(CreateTeam {
                name: "T".to_owned(),
                ..Default::default()
            })
            .await
            .unwrap();
        // Add twice — second is a no-op.
        s.add_member(&t.id, "ryu").await.unwrap();
        let r = s.add_member(&t.id, "ryu").await.unwrap().unwrap();
        assert_eq!(r.members, vec!["ryu"]);
        // Remove (idempotent on a missing member).
        let r = s.remove_member(&t.id, "ryu").await.unwrap().unwrap();
        assert!(r.members.is_empty());
        let r = s.remove_member(&t.id, "ryu").await.unwrap().unwrap();
        assert!(r.members.is_empty());
    }

    #[tokio::test]
    async fn update_patches_only_present_fields() {
        let s = store();
        let t = s
            .create(CreateTeam {
                name: "Old".to_owned(),
                members: vec!["a".to_owned()],
                coordination: Coordination::Broadcast,
                ..Default::default()
            })
            .await
            .unwrap();
        let updated = s
            .update(
                &t.id,
                UpdateTeam {
                    coordination: Some(Coordination::DebateSynthesis),
                    lead_agent_id: Some(Some("a".to_owned())),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        // name + members untouched; coordination + lead changed.
        assert_eq!(updated.name, "Old");
        assert_eq!(updated.members, vec!["a"]);
        assert_eq!(updated.coordination, Coordination::DebateSynthesis);
        assert_eq!(updated.lead_agent_id.as_deref(), Some("a"));
    }

    #[tokio::test]
    async fn coordination_string_roundtrip() {
        for c in [
            Coordination::Broadcast,
            Coordination::RoundRobin,
            Coordination::DebateSynthesis,
            Coordination::Router,
        ] {
            assert_eq!(Coordination::from_str_lenient(c.as_str()), c);
        }
        // Unknown values fall back to Broadcast, never panic.
        assert_eq!(
            Coordination::from_str_lenient("nonsense"),
            Coordination::Broadcast
        );
    }

    #[tokio::test]
    async fn delete_removes_team() {
        let s = store();
        let t = s
            .create(CreateTeam {
                name: "Gone".to_owned(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(s.delete(&t.id).await.unwrap());
        assert!(s.get(&t.id).await.unwrap().is_none());
        assert!(!s.delete(&t.id).await.unwrap());
    }
}
