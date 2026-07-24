//! Persisted Agent config model (SQLite) + the typed records the CRUD API uses.
//!
//! An *agent* here is a configuration record — a system prompt, a tool list, and
//! a model/engine binding — independent of the in-code [`AcpAgentRegistry`], which
//! remains the source of truth for *chat routing* (it carries the `&'static str`
//! spawn commands / base URLs a DB row can't hold). The built-in registry agents
//! are seeded into this table as `built_in` rows so they stay selectable and
//! survive a Core restart, while custom agents created via the API live alongside
//! them. History belongs to sessions (M2), not agents.
//!
//! ## Agents-as-cards (M3-U048)
//!
//! Each agent record now carries independent attribute *slots* for the eight
//! swappable dimensions: chat model, STT, TTS, image model, tools/MCP, memory/
//! Spaces, persona, and Gateway policy. A slot that is `None` means "use the
//! registry default"; callers (the desktop card-builder U11, per-attribute Gateway
//! routing U12) read whichever slot they need without touching the others.
//!
//! Legacy rows that only have `model`/`engine` set are back-filled during the
//! migration so their chat slot matches the old fields — no data is lost.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::sidecar::adapters::AcpAgentRegistry;
use crate::sidecar::download_manager::ryu_dir;

// ── Per-attribute slot types ───────────────────────────────────────────────────

/// Chat-model slot: which model the agent uses for text generation.
/// `model_id` is a registry key (e.g. "gemma4", "gpt-4o"); `engine` is the
/// ACP/OpenAI-compat runtime that should handle the call.  Both are optional so
/// that a `None` slot means "inherit the registry default".
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ModelSlot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

/// Speech-to-text slot.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SttSlot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Text-to-speech slot.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TtsSlot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}

/// Image-generation slot.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ImageSlot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Video-generation slot. `provider` is the gateway ProviderKind string (e.g.
/// `"replicate"`, `"fal"`); video routes through the gateway's job-based
/// `/v1/videos/generations` path.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct VideoSlot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

/// Memory / Spaces slot: which Space(s) and memory levels the agent may access.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct MemorySlot {
    /// Space IDs the agent is allowed to read from during retrieval. Empty means
    /// no Spaces are injected into chat (the safe default).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub space_ids: Vec<String>,
    /// Memory scope levels the agent may recall from: any subset of
    /// `["user", "node", "project"]`. An **empty** list means "all three levels"
    /// (the back-compat default for agents configured before this existed).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read_levels: Vec<String>,
    /// Whether the agent may write new memories during a session.
    #[serde(default)]
    pub write_enabled: bool,
}

/// Dither-gradient avatar spec: two palette colours (or hues) plus a direction,
/// rendered entirely client-side by the shared dither-kit. Core stores it
/// verbatim inside the persona JSON and never interprets it — the field names
/// match the frontend `{ from, to, direction }` shape one-for-one.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DitherSpec {
    /// The colour the gradient starts solid as — a palette name (e.g. `"green"`)
    /// or a hue number rendered as a string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// What it dissolves into — another palette colour, or absent for a fade to
    /// transparent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// Where `to` ends up: `"up" | "down" | "left" | "right"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
}

/// Persona slot: name, avatar, and tone instructions.
///
/// The avatar can be any one of three mutually-exclusive sources, resolved in
/// priority order by the client: an uploaded image ([`avatar_url`]), a custom
/// icon id ([`icon`], resolved through the shared Icon primitive), or a
/// dither-gradient ([`dither`]). Setting one clears the others on save; Core
/// stores whichever are present and never interprets them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PersonaSlot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    /// Custom icon id (Iconify / icons0 / Hugeicons), an alternative avatar
    /// source to an uploaded image or a dither gradient.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Dither-gradient avatar, an alternative avatar source to an uploaded image
    /// or a custom icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dither: Option<DitherSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone: Option<String>,
}

/// Gateway policy reference slot: points to a named policy in the Gateway
/// that governs firewall rules, PII/DLP, budget caps, and routing for this agent.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PolicyRef {
    /// Named policy id as registered in the Gateway config.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_id: Option<String>,
}

// ── Core record types ──────────────────────────────────────────────────────────

/// A persisted agent configuration record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Names of the tools / MCP servers this agent may use.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Composio action names this agent may call (e.g. `GMAIL_SEND_EMAIL`). Kept
    /// separate from `tools` (which holds MCP `<server>__<tool>` ids) because the
    /// gateway gates these via a distinct per-request allowlist
    /// (`x-ryu-composio-actions`). Only effective on the gateway/openai-compat
    /// route — ACP agents bypass the gateway.
    #[serde(default)]
    pub composio_actions: Vec<String>,
    /// Agent Skill ids this agent may use. An **empty** list means "all
    /// currently-enabled skills" (the default, back-compat behaviour); a
    /// non-empty list narrows injection to the intersection of this allowlist
    /// and the globally-enabled skills (it never re-activates a globally
    /// inactive skill). Enforced in Core (skills are injected, not gateway-gated)
    /// on both the openai-compat and ACP planes via the skill registry.
    #[serde(default)]
    pub skills: Vec<String>,
    /// Identity Vault profile ids this agent is bound to (epic #517, Unit 4).
    /// An **empty** list means the agent sees *no* identity profiles (the safe
    /// default — unlike `skills`, binding is opt-in, never "all"). At tool-call
    /// time decrypted credential state is fetched only for the domains of these
    /// bound profiles; state is never broadcast. Enforced in Core (the
    /// [`crate::identity`] vault), governed by the Gateway grant + audit.
    #[serde(default)]
    pub identity_profile_ids: Vec<String>,
    /// Tool ids (MCP `<server>__<tool>`) that require a human-in-the-loop
    /// approval before this agent may execute them (Layer A of the approval
    /// policy — see [`crate::approvals::policy`]). An **empty** list means the
    /// agent has no per-agent gated tools (the safe default — opt-in, like
    /// `identity_profile_ids`). Composes with the global approval mode + risk
    /// tags + the Gateway consult via logical OR: any layer requiring approval
    /// gates the call.
    #[serde(default)]
    pub approval_tools: Vec<String>,
    /// Legacy flat model identifier. Kept for backward compatibility;
    /// the `chat_model` slot is the authoritative slot going forward.
    #[serde(default)]
    pub model: Option<String>,
    /// Legacy engine / runtime binding. Kept for backward compatibility;
    /// use `chat_model.engine` going forward.
    #[serde(default)]
    pub engine: Option<String>,
    /// True for the seeded registry agents; they can't be deleted.
    #[serde(default)]
    pub built_in: bool,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,

    // ── Per-attribute slots (M3 agents-as-cards) ───────────────────────────
    /// Chat / text-generation model slot.
    #[serde(default)]
    pub chat_model: Option<ModelSlot>,
    /// Speech-to-text slot.
    #[serde(default)]
    pub stt: Option<SttSlot>,
    /// Text-to-speech slot.
    #[serde(default)]
    pub tts: Option<TtsSlot>,
    /// Image-generation slot.
    #[serde(default)]
    pub image_model: Option<ImageSlot>,
    /// Video-generation slot.
    #[serde(default)]
    pub video_model: Option<VideoSlot>,
    /// Memory / Spaces slot.
    #[serde(default)]
    pub memory: Option<MemorySlot>,
    /// Persona slot.
    #[serde(default)]
    pub persona: Option<PersonaSlot>,
    /// Gateway policy reference slot.
    #[serde(default)]
    pub policy_ref: Option<PolicyRef>,
    /// Advanced inference / sampling defaults for this agent (temperature, top_p,
    /// top_k, penalties, mirostat, DRY, …). Applied per request on the
    /// OpenAI-compat chat path, translated for the bound engine. `None` means
    /// "use the engine defaults". See [`crate::inference::SamplingConfig`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inference: Option<crate::inference::SamplingConfig>,

    // ── Versioning + immutability (M3 agent-apps) ─────────────────────────
    /// Semver version string (e.g. `"1.0.0"`). Defaults to `"1.0.0"` for new
    /// rows; back-filled for legacy rows via the migration default.
    #[serde(default = "default_version")]
    pub version: String,
    /// When `true`, the record is immutable: `update()` rejects any patch with
    /// an error. `locked` agents may still be deleted by users (unlike
    /// `built_in` rows, which are protected at the delete layer too).
    #[serde(default)]
    pub locked: bool,

    // ── Orchestration capabilities ─────────────────────────────────────────
    /// Whether this agent may discover peers (`orchestrator__discover_agents`)
    /// and delegate work to them (`delegate__*`). `None` is the default and is
    /// treated as **on**: delegation has always been default-available, so
    /// legacy rows keep it. `Some(false)` withholds delegation/discovery from
    /// this agent's offered tool set. See [`AgentRecord::orchestrator_enabled`].
    #[serde(default)]
    pub orchestrator: Option<bool>,
    /// Whether this agent may mint or reconfigure custom agents via the
    /// `agent_builder__create_agent` tool. Defaults to **off** (`None` /
    /// `Some(false)`): agent creation is a privileged capability (a created
    /// child can be granted tools, so it is a privilege-escalation surface) and
    /// must be enabled explicitly per agent. See
    /// [`AgentRecord::can_create_agents_enabled`].
    #[serde(default)]
    pub can_create_agents: Option<bool>,
}

impl AgentRecord {
    /// Whether delegation/discovery tools are offered to this agent. Absent
    /// (`None`) means **on** — the historical default-available behaviour.
    pub fn orchestrator_enabled(&self) -> bool {
        self.orchestrator.unwrap_or(true)
    }

    /// Whether the agent-creation tool is offered to this agent. Absent (`None`)
    /// means **off** — creation is opt-in per agent.
    pub fn can_create_agents_enabled(&self) -> bool {
        self.can_create_agents.unwrap_or(false)
    }
}

/// Fields a client may supply when creating an agent. `id` is server-assigned.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateAgent {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    /// Composio action names this agent may call (gateway-route only).
    #[serde(default)]
    pub composio_actions: Vec<String>,
    /// Skill id allowlist; empty = all enabled skills. See [`AgentRecord::skills`].
    #[serde(default)]
    pub skills: Vec<String>,
    /// Identity Vault profile ids to bind (empty = none). See [`AgentRecord::identity_profile_ids`].
    #[serde(default)]
    pub identity_profile_ids: Vec<String>,
    /// Legacy flat model; maps to `chat_model.model_id` when `chat_model` is absent.
    #[serde(default)]
    pub model: Option<String>,
    /// Legacy engine binding; maps to `chat_model.engine` when `chat_model` is absent.
    #[serde(default)]
    pub engine: Option<String>,
    // ── Per-attribute slots ────────────────────────────────────────────────
    #[serde(default)]
    pub chat_model: Option<ModelSlot>,
    #[serde(default)]
    pub stt: Option<SttSlot>,
    #[serde(default)]
    pub tts: Option<TtsSlot>,
    #[serde(default)]
    pub image_model: Option<ImageSlot>,
    /// Video-generation slot.
    #[serde(default)]
    pub video_model: Option<VideoSlot>,
    #[serde(default)]
    pub memory: Option<MemorySlot>,
    #[serde(default)]
    pub persona: Option<PersonaSlot>,
    #[serde(default)]
    pub policy_ref: Option<PolicyRef>,
    /// Advanced inference / sampling defaults (see [`crate::inference::SamplingConfig`]).
    #[serde(default)]
    pub inference: Option<crate::inference::SamplingConfig>,
    // ── Versioning ────────────────────────────────────────────────────────
    /// Initial version for the agent template; defaults to "1.0.0".
    #[serde(default = "default_version")]
    pub version: String,
    // ── Orchestration capabilities ─────────────────────────────────────────
    /// Delegation/discovery capability. `None` = default-on. See [`AgentRecord::orchestrator`].
    #[serde(default)]
    pub orchestrator: Option<bool>,
    /// Agent-creation capability. `None` = default-off. See [`AgentRecord::can_create_agents`].
    #[serde(default)]
    pub can_create_agents: Option<bool>,
}

impl Default for CreateAgent {
    fn default() -> Self {
        Self {
            name: String::new(),
            description: None,
            system_prompt: None,
            tools: vec![],
            composio_actions: vec![],
            skills: vec![],
            identity_profile_ids: vec![],
            model: None,
            engine: None,
            chat_model: None,
            stt: None,
            tts: None,
            image_model: None,
            video_model: None,
            memory: None,
            persona: None,
            policy_ref: None,
            inference: None,
            version: default_version(),
            orchestrator: None,
            can_create_agents: None,
        }
    }
}

/// Fields a client may patch on update. Absent fields are left unchanged.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateAgent {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Option<Vec<String>>,
    /// Composio action allowlist patch (`Some(_)` replaces the list).
    #[serde(default)]
    pub composio_actions: Option<Vec<String>>,
    /// Skill allowlist patch (`Some(_)` replaces the list; empty = all enabled).
    #[serde(default)]
    pub skills: Option<Vec<String>>,
    /// Identity profile binding patch (`Some(_)` replaces the list; empty = none).
    #[serde(default)]
    pub identity_profile_ids: Option<Vec<String>>,
    /// Legacy flat model patch.
    #[serde(default)]
    pub model: Option<String>,
    /// Legacy engine patch.
    #[serde(default)]
    pub engine: Option<String>,
    // ── Per-attribute slot patches ─────────────────────────────────────────
    #[serde(default)]
    pub chat_model: Option<ModelSlot>,
    #[serde(default)]
    pub stt: Option<SttSlot>,
    #[serde(default)]
    pub tts: Option<TtsSlot>,
    #[serde(default)]
    pub image_model: Option<ImageSlot>,
    /// Video-generation slot.
    #[serde(default)]
    pub video_model: Option<VideoSlot>,
    #[serde(default)]
    pub memory: Option<MemorySlot>,
    #[serde(default)]
    pub persona: Option<PersonaSlot>,
    #[serde(default)]
    pub policy_ref: Option<PolicyRef>,
    /// Advanced inference / sampling defaults patch (see
    /// [`crate::inference::SamplingConfig`]). `Some(_)` replaces the slot.
    #[serde(default)]
    pub inference: Option<crate::inference::SamplingConfig>,
    // ── Versioning + lock ─────────────────────────────────────────────────
    /// New version string for the agent template.
    #[serde(default)]
    pub version: Option<String>,
    /// Toggle the locked state. Pass `Some(true)` to lock, `Some(false)` to
    /// unlock. `None` leaves the current state unchanged.
    #[serde(default)]
    pub locked: Option<bool>,
    // ── Orchestration capability patches ───────────────────────────────────
    /// Toggle delegation/discovery. `Some(_)` sets the flag; `None` is unchanged.
    #[serde(default)]
    pub orchestrator: Option<bool>,
    /// Toggle agent-creation. `Some(_)` sets the flag; `None` is unchanged.
    #[serde(default)]
    pub can_create_agents: Option<bool>,
}

fn default_version() -> String {
    "1.0.0".to_owned()
}

fn db_path() -> PathBuf {
    ryu_dir().join("agents.db")
}

/// SQLite-backed store for agent config records. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct AgentStore {
    conn: Arc<Mutex<Connection>>,
}

impl AgentStore {
    /// Open (creating if needed) the agents DB under `~/.ryu/agents.db`, run the
    /// schema migration, then idempotently seed the built-in registry agents.
    pub fn open(registry: &AcpAgentRegistry) -> Result<Self> {
        let path = db_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).context("creating ~/.ryu for agents.db")?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening agents db at {}", path.display()))?;
        Self::migrate(&conn)?;
        Self::seed_built_ins(&conn, registry)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// In-memory store, used by tests.
    #[cfg(test)]
    pub fn open_in_memory(registry: &AcpAgentRegistry) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::migrate(&conn)?;
        Self::seed_built_ins(&conn, registry)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn migrate(conn: &Connection) -> Result<()> {
        // Step 1: create the base table if it doesn't exist (unchanged schema for
        // the legacy columns so existing databases are not affected).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agents (
                id            TEXT PRIMARY KEY,
                name          TEXT NOT NULL,
                description   TEXT,
                system_prompt TEXT,
                tools         TEXT NOT NULL DEFAULT '[]',
                model         TEXT,
                engine        TEXT,
                built_in      INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );",
        )
        .context("running agents schema migration (base table)")?;

        // Step 2: idempotently add the per-attribute slot columns. SQLite does not
        // support ADD COLUMN IF NOT EXISTS before 3.37, so we catch the "duplicate
        // column" error instead and treat it as success.
        let slot_columns = [
            "chat_model TEXT",
            "stt        TEXT",
            "tts        TEXT",
            "image_model TEXT",
            "video_model TEXT",
            "memory     TEXT",
            "persona    TEXT",
            "policy_ref TEXT",
            "inference  TEXT",
        ];
        for col_def in slot_columns {
            let sql = format!("ALTER TABLE agents ADD COLUMN {col_def}");
            match conn.execute_batch(&sql) {
                Ok(()) => {}
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("duplicate column") {
                        // Already added in a previous run — idempotent.
                    } else {
                        return Err(e).context(format!("adding column: {col_def}"));
                    }
                }
            }
        }

        // Step 3: back-fill `chat_model` from legacy `model`/`engine` for existing
        // rows that have not yet been migrated. Rows that already have `chat_model`
        // set are left untouched.
        conn.execute_batch(
            "UPDATE agents
             SET chat_model = json_object(
                 'model_id', model,
                 'engine',   engine
             )
             WHERE (model IS NOT NULL OR engine IS NOT NULL)
               AND chat_model IS NULL;",
        )
        .context("back-filling chat_model from legacy model/engine")?;

        // Step 4: add versioning + immutability columns (M3 agent-apps). SQLite
        // back-fills existing rows with the DEFAULT so no data is lost.
        let v4_columns = [
            "version TEXT NOT NULL DEFAULT '1.0.0'",
            "locked  INTEGER NOT NULL DEFAULT 0",
        ];
        for col_def in v4_columns {
            let sql = format!("ALTER TABLE agents ADD COLUMN {col_def}");
            match conn.execute_batch(&sql) {
                Ok(()) => {}
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("duplicate column") {
                        // Already added in a previous run — idempotent.
                    } else {
                        return Err(e).context(format!("adding column: {col_def}"));
                    }
                }
            }
        }

        // Step 5: add the `installed` flag — the default-installed set. Only the
        // flagship `ryu` agent is installed by default; every other built-in
        // (Claude Code, Codex, Gemini CLI, Pi, OpenClaw, …) is opt-in via the
        // agents catalog. On a fresh DB the rows are seeded with the right flag
        // (see `seed_built_ins`); on an existing DB the new column defaults to 0
        // for every row, so we re-assert `ryu = 1` right after adding it.
        match conn
            .execute_batch("ALTER TABLE agents ADD COLUMN installed INTEGER NOT NULL DEFAULT 0")
        {
            Ok(()) => {
                conn.execute_batch("UPDATE agents SET installed = 1 WHERE id = 'ryu'")
                    .context("seeding ryu as installed after adding installed column")?;
            }
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("duplicate column") {
                    // Already added in a previous run — idempotent.
                } else {
                    return Err(e).context("adding column: installed");
                }
            }
        }

        // Step 6: per-agent Composio action allowlist (#456 deep integration).
        // JSON array of action names; defaults to `[]` so legacy rows have none.
        match conn.execute_batch(
            "ALTER TABLE agents ADD COLUMN composio_actions TEXT NOT NULL DEFAULT '[]'",
        ) {
            Ok(()) => {}
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("duplicate column") {
                    // Already added in a previous run — idempotent.
                } else {
                    return Err(e).context("adding column: composio_actions");
                }
            }
        }

        // Step 7: per-agent Skill allowlist. JSON array of skill ids; defaults to
        // `[]` which means "all enabled skills" (back-compat). A non-empty list
        // narrows skill injection to the intersection with the enabled set.
        match conn.execute_batch("ALTER TABLE agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]'")
        {
            Ok(()) => {}
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("duplicate column") {
                    // Already added in a previous run — idempotent.
                } else {
                    return Err(e).context("adding column: skills");
                }
            }
        }

        // Step 8: per-agent Identity Vault profile binding (epic #517, Unit 4).
        // JSON array of profile ids; defaults to `[]` which means "no bound
        // identities" (the safe default — binding is opt-in). Resolved per
        // request so an agent only ever sees the credential state of its bound
        // domains, fetched at tool-call time and never broadcast.
        match conn.execute_batch(
            "ALTER TABLE agents ADD COLUMN identity_profile_ids TEXT NOT NULL DEFAULT '[]'",
        ) {
            Ok(()) => {}
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("duplicate column") {
                    // Already added in a previous run — idempotent.
                } else {
                    return Err(e).context("adding column: identity_profile_ids");
                }
            }
        }

        // Step 9: orchestration capability flags. Both are *nullable* (no DEFAULT)
        // so NULL encodes "use the code default": `orchestrator` defaults on,
        // `can_create_agents` defaults off (see the `*_enabled` helpers). Only the
        // flagship `ryu` is seeded with both ON, and only at the moment the column
        // is first created — so a user who later disables a flag is not overridden
        // on the next boot (mirrors the `installed` seed in step 5).
        for col_def in ["orchestrator INTEGER", "can_create_agents INTEGER"] {
            match conn.execute_batch(&format!("ALTER TABLE agents ADD COLUMN {col_def}")) {
                Ok(()) => {
                    let col = col_def.split_whitespace().next().unwrap_or_default();
                    conn.execute_batch(&format!("UPDATE agents SET {col} = 1 WHERE id = 'ryu'"))
                        .with_context(|| format!("seeding ryu {col} after adding column"))?;
                }
                Err(e) => {
                    let msg = e.to_string();
                    if msg.contains("duplicate column") {
                        // Already added in a previous run — idempotent.
                    } else {
                        return Err(e).context(format!("adding column: {col_def}"));
                    }
                }
            }
        }

        Ok(())
    }

    /// Insert the registry's built-in agents as durable rows. Idempotent:
    /// `INSERT OR IGNORE` so existing rows (and any user edits) are preserved.
    ///
    /// The `engine` column stores the entry's own id for ACP agents and the
    /// id itself for OpenAI-compat agents, mirroring `list_infos()`. For the
    /// `ryu` flagship agent the engine is `acp:pi`, reflecting its Pi binding.
    fn seed_built_ins(conn: &Connection, registry: &AcpAgentRegistry) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        for entry in &registry.entries {
            // The ryu agent's engine binding is acp:pi (the Pi entry), not "ryu"
            // itself. This makes the store row reflect the real engine so
            // resolve_binding returns the right engine for routing (AC4).
            let engine_id = if entry.id == "ryu" {
                "acp:pi".to_owned()
            } else {
                entry.id.clone()
            };
            // Populate the chat_model slot so new callers never have to fall
            // back to the flat fields (agents-as-cards M3-U048 compat).
            let chat_model_json = serde_json::to_string(&ModelSlot {
                model_id: None,
                engine: Some(engine_id.clone()),
            })
            .unwrap_or_else(|_| "null".to_owned());
            // Only the flagship `ryu` agent is installed by default; every other
            // built-in is opt-in via the agents catalog (onboarding step).
            let installed_flag: i32 = i32::from(entry.id == "ryu");
            // The flagship `ryu` is seeded as a full orchestrator that may also
            // create agents (it runs the builder pane). Every other built-in
            // leaves both flags NULL = the code defaults (delegation on, creation
            // off). Seeded here — not only in the migration — because on a fresh
            // DB the migration's `UPDATE … WHERE id='ryu'` runs before this row
            // exists; the migration UPDATE covers the existing-DB upgrade path.
            let ryu_caps: Option<i64> = (entry.id == "ryu").then_some(1);
            conn.execute(
                "INSERT OR IGNORE INTO agents
                    (id, name, description, system_prompt, tools, model, engine, built_in,
                     chat_model, installed, orchestrator, can_create_agents,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, '[]', NULL, ?4, 1, ?5, ?6, ?8, ?8, ?7, ?7)",
                params![
                    entry.id,
                    entry.name,
                    entry.description,
                    engine_id,
                    chat_model_json,
                    installed_flag,
                    now,
                    ryu_caps,
                ],
            )?;
        }
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<AgentRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                    created_at, updated_at,
                    chat_model, stt, tts, image_model, memory, persona, policy_ref,
                    version, locked, inference, composio_actions, skills,
                    identity_profile_ids, orchestrator, can_create_agents, video_model
             FROM agents ORDER BY built_in DESC, created_at ASC",
        )?;
        let rows = stmt
            .query_map([], row_to_record)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Ids of agents currently in the installed set (agents the user has added).
    /// The flagship `ryu` is always present. The agent picker (`GET /api/agents`)
    /// uses this to hide catalog-only built-ins until the user adds them.
    pub async fn installed_ids(&self) -> Result<std::collections::HashSet<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT id FROM agents WHERE installed = 1")?;
        let ids = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
        Ok(ids)
    }

    /// Toggle the installed flag for a built-in agent (catalog install/uninstall).
    /// Returns `true` if a row was updated. The flagship `ryu` is always
    /// installed and cannot be removed.
    pub async fn set_installed(&self, id: &str, installed: bool) -> Result<bool> {
        if id == "ryu" && !installed {
            anyhow::bail!("the ryu agent is always installed and cannot be removed");
        }
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE agents SET installed = ?1, updated_at = ?2 WHERE id = ?3",
            params![i32::from(installed), now, id],
        )?;
        Ok(updated > 0)
    }

    pub async fn get(&self, id: &str) -> Result<Option<AgentRecord>> {
        let conn = self.conn.lock().await;
        let record = conn
            .query_row(
                "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                        created_at, updated_at,
                        chat_model, stt, tts, image_model, memory, persona, policy_ref,
                        version, locked, inference, composio_actions, skills,
                        identity_profile_ids, orchestrator, can_create_agents, video_model
                 FROM agents WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?;
        Ok(record)
    }

    pub async fn create(&self, input: CreateAgent) -> Result<AgentRecord> {
        let id = format!("agent_{}", uuid::Uuid::new_v4().simple());
        self.create_with_id(id, input).await
    }

    /// Create an agent with a caller-supplied `id` instead of a generated one.
    /// Used by the migrate-to-ryu endpoint to create the Ryu agent under a
    /// stable well-known id. Fails if a row with that id already exists.
    pub async fn create_with_id(&self, id: String, input: CreateAgent) -> Result<AgentRecord> {
        let now = chrono::Utc::now().to_rfc3339();
        let tools_json = serde_json::to_string(&input.tools).unwrap_or_else(|_| "[]".to_owned());
        let composio_json =
            serde_json::to_string(&input.composio_actions).unwrap_or_else(|_| "[]".to_owned());
        let skills_json = serde_json::to_string(&input.skills).unwrap_or_else(|_| "[]".to_owned());
        let identity_json =
            serde_json::to_string(&input.identity_profile_ids).unwrap_or_else(|_| "[]".to_owned());

        // Resolve the chat slot: prefer explicit `chat_model`, fall back to
        // legacy `model`/`engine` fields so old clients keep working.
        let chat_model = input.chat_model.clone().or_else(|| {
            if input.model.is_some() || input.engine.is_some() {
                Some(ModelSlot {
                    model_id: input.model.clone(),
                    engine: input.engine.clone(),
                })
            } else {
                None
            }
        });

        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO agents
                (id, name, description, system_prompt, tools, model, engine, built_in,
                 chat_model, stt, tts, image_model, video_model, memory, persona, policy_ref,
                 inference, version, locked, composio_actions, skills,
                 identity_profile_ids, orchestrator, can_create_agents,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0,
                     ?8, ?9, ?10, ?11, ?23, ?12, ?13, ?14,
                     ?15, ?16, 0, ?17, ?18,
                     ?19, ?21, ?22, ?20, ?20)",
            params![
                id,
                input.name,
                input.description,
                input.system_prompt,
                tools_json,
                input.model,
                input.engine,
                serialize_slot(&chat_model),
                serialize_slot(&input.stt),
                serialize_slot(&input.tts),
                serialize_slot(&input.image_model),
                serialize_slot(&input.memory),
                serialize_slot(&input.persona),
                serialize_slot(&input.policy_ref),
                serialize_slot(&input.inference),
                input.version,
                composio_json,
                skills_json,
                identity_json,
                now,
                input.orchestrator.map(i64::from),
                input.can_create_agents.map(i64::from),
                serialize_slot(&input.video_model),
            ],
        )?;
        Ok(AgentRecord {
            id,
            name: input.name,
            description: input.description,
            system_prompt: input.system_prompt,
            tools: input.tools,
            // Concurrent wip(orchestrator) added `approval_tools` to AgentRecord
            // without wiring an input/DB source; default empty so the crate builds.
            approval_tools: Vec::new(),
            composio_actions: input.composio_actions,
            skills: input.skills,
            identity_profile_ids: input.identity_profile_ids,
            model: input.model,
            engine: input.engine,
            built_in: false,
            created_at: Some(now.clone()),
            updated_at: Some(now),
            chat_model,
            stt: input.stt,
            tts: input.tts,
            image_model: input.image_model,
            video_model: input.video_model,
            memory: input.memory,
            persona: input.persona,
            policy_ref: input.policy_ref,
            inference: input.inference,
            version: input.version,
            locked: false,
            orchestrator: input.orchestrator,
            can_create_agents: input.can_create_agents,
        })
    }

    /// Patch an existing agent. Returns `None` if no row matched. Built-in agents
    /// can be edited (name/prompt/tools) but their `built_in` flag is preserved.
    /// Returns an error if the agent is locked (`locked = true`).
    pub async fn update(&self, id: &str, patch: UpdateAgent) -> Result<Option<AgentRecord>> {
        {
            let conn = self.conn.lock().await;
            let existing: Option<AgentRecord> = conn
                .query_row(
                    "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                            created_at, updated_at,
                            chat_model, stt, tts, image_model, memory, persona, policy_ref,
                            version, locked, inference, composio_actions, skills,
                            identity_profile_ids, orchestrator, can_create_agents, video_model
                     FROM agents WHERE id = ?1",
                    params![id],
                    row_to_record,
                )
                .optional()?;
            let Some(mut record) = existing else {
                return Ok(None);
            };

            // Locked agents are immutable: reject patch attempts UNLESS the patch
            // only unlocks the agent (i.e., the only field being set is `locked:
            // false`). This allows a user to unlock a locked agent without having
            // to bypass the lock. Any patch that edits content while the agent is
            // locked is rejected.
            let is_unlock_only = matches!(patch.locked, Some(false))
                && patch.name.is_none()
                && patch.description.is_none()
                && patch.system_prompt.is_none()
                && patch.tools.is_none()
                && patch.composio_actions.is_none()
                && patch.skills.is_none()
                && patch.identity_profile_ids.is_none()
                && patch.model.is_none()
                && patch.engine.is_none()
                && patch.chat_model.is_none()
                && patch.stt.is_none()
                && patch.tts.is_none()
                && patch.image_model.is_none()
                && patch.video_model.is_none()
                && patch.memory.is_none()
                && patch.persona.is_none()
                && patch.policy_ref.is_none()
                && patch.inference.is_none()
                && patch.version.is_none()
                && patch.orchestrator.is_none()
                && patch.can_create_agents.is_none();
            if record.locked && !is_unlock_only {
                anyhow::bail!("cannot edit locked agent '{id}'");
            }

            if let Some(name) = patch.name {
                record.name = name;
            }
            if patch.description.is_some() {
                record.description = patch.description;
            }
            if patch.system_prompt.is_some() {
                record.system_prompt = patch.system_prompt;
            }
            if let Some(tools) = patch.tools {
                record.tools = tools;
            }
            if let Some(composio_actions) = patch.composio_actions {
                record.composio_actions = composio_actions;
            }
            if let Some(skills) = patch.skills {
                record.skills = skills;
            }
            if let Some(identity_profile_ids) = patch.identity_profile_ids {
                record.identity_profile_ids = identity_profile_ids;
            }
            if patch.model.is_some() {
                record.model = patch.model;
            }
            if patch.engine.is_some() {
                record.engine = patch.engine;
            }
            // Slot patches: a Some(_) patch replaces the slot; None leaves it unchanged.
            if let Some(chat_model) = patch.chat_model {
                record.chat_model = Some(chat_model);
            }
            if let Some(stt) = patch.stt {
                record.stt = Some(stt);
            }
            if let Some(tts) = patch.tts {
                record.tts = Some(tts);
            }
            if let Some(image_model) = patch.image_model {
                record.image_model = Some(image_model);
            }
            if let Some(video_model) = patch.video_model {
                record.video_model = Some(video_model);
            }
            if let Some(memory) = patch.memory {
                record.memory = Some(memory);
            }
            if let Some(persona) = patch.persona {
                record.persona = Some(persona);
            }
            if let Some(policy_ref) = patch.policy_ref {
                record.policy_ref = Some(policy_ref);
            }
            if let Some(inference) = patch.inference {
                record.inference = Some(inference);
            }
            if let Some(version) = patch.version {
                record.version = version;
            }
            if let Some(locked) = patch.locked {
                record.locked = locked;
            }
            if let Some(orchestrator) = patch.orchestrator {
                record.orchestrator = Some(orchestrator);
            }
            if let Some(can_create_agents) = patch.can_create_agents {
                record.can_create_agents = Some(can_create_agents);
            }

            let now = chrono::Utc::now().to_rfc3339();
            record.updated_at = Some(now.clone());
            let tools_json =
                serde_json::to_string(&record.tools).unwrap_or_else(|_| "[]".to_owned());
            let composio_json =
                serde_json::to_string(&record.composio_actions).unwrap_or_else(|_| "[]".to_owned());
            let skills_json =
                serde_json::to_string(&record.skills).unwrap_or_else(|_| "[]".to_owned());
            let identity_json = serde_json::to_string(&record.identity_profile_ids)
                .unwrap_or_else(|_| "[]".to_owned());

            conn.execute(
                "UPDATE agents SET name = ?2, description = ?3, system_prompt = ?4,
                    tools = ?5, model = ?6, engine = ?7,
                    chat_model = ?8, stt = ?9, tts = ?10, image_model = ?11,
                    video_model = ?24,
                    memory = ?12, persona = ?13, policy_ref = ?14, inference = ?15,
                    version = ?16, locked = ?17, composio_actions = ?18, skills = ?19,
                    identity_profile_ids = ?20, orchestrator = ?22,
                    can_create_agents = ?23, updated_at = ?21
                 WHERE id = ?1",
                params![
                    id,
                    record.name,
                    record.description,
                    record.system_prompt,
                    tools_json,
                    record.model,
                    record.engine,
                    serialize_slot(&record.chat_model),
                    serialize_slot(&record.stt),
                    serialize_slot(&record.tts),
                    serialize_slot(&record.image_model),
                    serialize_slot(&record.memory),
                    serialize_slot(&record.persona),
                    serialize_slot(&record.policy_ref),
                    serialize_slot(&record.inference),
                    record.version,
                    record.locked as i64,
                    composio_json,
                    skills_json,
                    identity_json,
                    now,
                    record.orchestrator.map(i64::from),
                    record.can_create_agents.map(i64::from),
                    serialize_slot(&record.video_model),
                ],
            )?;
        }
        self.get(id).await
    }

    /// Delete a custom agent. Returns `Ok(false)` if the row doesn't exist;
    /// errors if the target is a built-in agent (those stay selectable).
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let built_in: Option<bool> = conn
            .query_row(
                "SELECT built_in FROM agents WHERE id = ?1",
                params![id],
                |row| row.get::<_, i64>(0).map(|v| v != 0),
            )
            .optional()?;
        match built_in {
            None => Ok(false),
            Some(true) => anyhow::bail!("cannot delete built-in agent '{id}'"),
            Some(false) => {
                conn.execute("DELETE FROM agents WHERE id = ?1", params![id])?;
                Ok(true)
            }
        }
    }
}

// ── Portable agent template (export / import) ─────────────────────────────────

/// The portable agent template JSON returned by `GET /api/agents/:id/export`.
///
/// Follows the single-Runnable `ryu.json` App manifest shape (as used by
/// [`crate::plugin_manifest::PluginManifest`]): a `PluginManifest`-compatible envelope
/// with one Runnable entry of kind `agent`, plus an `agent_config` sub-object
/// that carries the persisted agent fields needed to recreate the agent via
/// `POST /api/agents/import`.
///
/// Only the portable, user-owned fields are included. The `id`, `built_in`,
/// `created_at`, and `updated_at` fields are **excluded** — on import a fresh
/// id is always assigned and the timestamps are set server-side so there are
/// never collisions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTemplate {
    /// Manifest type identifier — always `"agent"`.
    pub kind: String,
    /// Human-readable display name (copied from `AgentRecord.name`).
    pub name: String,
    /// Semver version of the template (copied from `AgentRecord.version`).
    pub version: String,
    /// The agent-specific configuration that will be used to recreate the agent.
    pub agent_config: AgentTemplateConfig,
}

/// The agent-specific fields inside an [`AgentTemplate`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTemplateConfig {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    /// Composio action allowlist (portable across export/import).
    #[serde(default)]
    pub composio_actions: Vec<String>,
    /// Skill allowlist (portable across export/import; empty = all enabled).
    #[serde(default)]
    pub skills: Vec<String>,
    /// Identity Vault profile binding (portable across export/import; empty = none).
    #[serde(default)]
    pub identity_profile_ids: Vec<String>,
    /// Legacy engine binding (preserved for back-compat with older importers).
    #[serde(default)]
    pub engine: Option<String>,
    /// Legacy flat model identifier.
    #[serde(default)]
    pub model: Option<String>,
    // ── Per-attribute slots ────────────────────────────────────────────────
    #[serde(default)]
    pub chat_model: Option<ModelSlot>,
    #[serde(default)]
    pub stt: Option<SttSlot>,
    #[serde(default)]
    pub tts: Option<TtsSlot>,
    #[serde(default)]
    pub image_model: Option<ImageSlot>,
    /// Video-generation slot.
    #[serde(default)]
    pub video_model: Option<VideoSlot>,
    #[serde(default)]
    pub memory: Option<MemorySlot>,
    #[serde(default)]
    pub persona: Option<PersonaSlot>,
    #[serde(default)]
    pub policy_ref: Option<PolicyRef>,
}

impl AgentRecord {
    /// Build a portable [`AgentTemplate`] from this record for export.
    pub fn to_template(&self) -> AgentTemplate {
        AgentTemplate {
            kind: "agent".to_owned(),
            name: self.name.clone(),
            version: self.version.clone(),
            agent_config: AgentTemplateConfig {
                description: self.description.clone(),
                system_prompt: self.system_prompt.clone(),
                tools: self.tools.clone(),
                composio_actions: self.composio_actions.clone(),
                skills: self.skills.clone(),
                identity_profile_ids: self.identity_profile_ids.clone(),
                engine: self.engine.clone(),
                model: self.model.clone(),
                chat_model: self.chat_model.clone(),
                stt: self.stt.clone(),
                tts: self.tts.clone(),
                image_model: self.image_model.clone(),
                video_model: self.video_model.clone(),
                memory: self.memory.clone(),
                persona: self.persona.clone(),
                policy_ref: self.policy_ref.clone(),
            },
        }
    }
}

impl AgentTemplate {
    /// Convert this template into a [`CreateAgent`] input.
    /// The imported agent is always unlocked and gets a fresh server-assigned id.
    pub fn into_create_agent(self) -> CreateAgent {
        CreateAgent {
            name: self.name,
            description: self.agent_config.description,
            system_prompt: self.agent_config.system_prompt,
            tools: self.agent_config.tools,
            composio_actions: self.agent_config.composio_actions,
            skills: self.agent_config.skills,
            identity_profile_ids: self.agent_config.identity_profile_ids,
            engine: self.agent_config.engine,
            model: self.agent_config.model,
            chat_model: self.agent_config.chat_model,
            stt: self.agent_config.stt,
            tts: self.agent_config.tts,
            image_model: self.agent_config.image_model,
            video_model: self.agent_config.video_model,
            memory: self.agent_config.memory,
            persona: self.agent_config.persona,
            policy_ref: self.agent_config.policy_ref,
            inference: None,
            version: self.version,
            // Capabilities are not carried across export/import: an imported
            // agent starts at the safe defaults (delegation on, creation off) so
            // a shared template can never smuggle in the privileged
            // agent-creation capability.
            orchestrator: None,
            can_create_agents: None,
        }
    }
}

fn parse_slot<T: for<'de> Deserialize<'de>>(json: Option<String>) -> Option<T> {
    serde_json::from_str(&json?).ok()
}

fn serialize_slot<T: Serialize>(v: &Option<T>) -> Option<String> {
    v.as_ref().and_then(|s| serde_json::to_string(s).ok())
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRecord> {
    let tools_json: String = row.get(4)?;
    let tools = serde_json::from_str(&tools_json).unwrap_or_default();
    // Column 20 is `composio_actions` (JSON array). Older rows / SELECTs that
    // omit it parse as an empty list (fail-soft).
    let composio_actions = row
        .get::<_, Option<String>>(20)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Column 21 is `skills` (JSON array). Older rows / SELECTs that omit it parse
    // as an empty list = "all enabled skills" (fail-soft, back-compat).
    let skills = row
        .get::<_, Option<String>>(21)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Column 22 is `identity_profile_ids` (JSON array). Older rows / SELECTs that
    // omit it parse as an empty list = "no bound identities" (fail-soft).
    let identity_profile_ids = row
        .get::<_, Option<String>>(22)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Columns 23/24 are the nullable orchestration flags. Absent column or NULL
    // value → `None` (fail-soft), which the `*_enabled` helpers map to the code
    // default (orchestrator on, can_create_agents off).
    let orchestrator = row.get::<_, Option<i64>>(23).ok().flatten().map(|v| v != 0);
    let can_create_agents = row.get::<_, Option<i64>>(24).ok().flatten().map(|v| v != 0);
    // Column 25 is the video slot (appended after the orchestration flags).
    // A missing column (older row from before the migration) → None (fail-soft).
    let video_model = row
        .get::<_, Option<String>>(25)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok());
    Ok(AgentRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        description: row.get(2)?,
        system_prompt: row.get(3)?,
        tools,
        // Concurrent wip(orchestrator) added `approval_tools` without a DB column;
        // default empty so the crate builds (no persistence to read yet).
        approval_tools: Vec::new(),
        composio_actions,
        skills,
        identity_profile_ids,
        model: row.get(5)?,
        engine: row.get(6)?,
        built_in: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        chat_model: parse_slot(row.get(10)?),
        stt: parse_slot(row.get(11)?),
        tts: parse_slot(row.get(12)?),
        image_model: parse_slot(row.get(13)?),
        video_model,
        memory: parse_slot(row.get(14)?),
        persona: parse_slot(row.get(15)?),
        policy_ref: parse_slot(row.get(16)?),
        version: row
            .get::<_, Option<String>>(17)?
            .unwrap_or_else(default_version),
        locked: row.get::<_, i64>(18).unwrap_or(0) != 0,
        inference: parse_slot(row.get(19)?),
        orchestrator,
        can_create_agents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> AgentStore {
        AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap()
    }

    #[tokio::test]
    async fn seeds_built_in_agents() {
        let store = store();
        let agents = store.list().await.unwrap();
        // Every registry entry is seeded as a built-in row (includes the ryu
        // flagship and all curated + ACP-registry agents). Derive the expected
        // count from the registry so it stays correct as agents are added.
        let expected = AcpAgentRegistry::new().entries.len();
        assert_eq!(agents.iter().filter(|a| a.built_in).count(), expected);
        assert!(agents.iter().any(|a| a.id == "acp:claude" && a.built_in));
        // The ryu flagship agent must be seeded as a protected built-in.
        assert!(agents.iter().any(|a| a.id == "ryu" && a.built_in));
        // ryu's engine binding points to acp:pi (the Pi entry), not itself.
        let ryu = agents.iter().find(|a| a.id == "ryu").unwrap();
        assert_eq!(ryu.engine.as_deref(), Some("acp:pi"));
    }

    #[tokio::test]
    async fn seeds_chat_model_slot_for_built_ins() {
        let store = store();
        let claude = store.get("acp:claude").await.unwrap().unwrap();
        // Built-ins get their chat slot populated pointing at their ACP engine id.
        assert!(
            claude.chat_model.is_some(),
            "chat_model slot should be populated on seed"
        );
        let slot = claude.chat_model.unwrap();
        assert_eq!(
            slot.engine.as_deref(),
            Some("acp:claude"),
            "engine should match the registry entry id"
        );
    }

    #[tokio::test]
    async fn create_get_update_delete_roundtrip() {
        let store = store();
        let created = store
            .create(CreateAgent {
                name: "Researcher".into(),
                system_prompt: Some("You research.".into()),
                tools: vec!["web_search".into()],
                model: Some("gpt-4o".into()),
                engine: Some("acp:claude".into()),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(!created.built_in);

        let fetched = store.get(&created.id).await.unwrap().unwrap();
        assert_eq!(fetched.name, "Researcher");
        assert_eq!(fetched.tools, vec!["web_search".to_string()]);
        // Legacy fields back-fill the chat slot.
        let chat = fetched.chat_model.unwrap();
        assert_eq!(chat.model_id.as_deref(), Some("gpt-4o"));
        assert_eq!(chat.engine.as_deref(), Some("acp:claude"));

        let updated = store
            .update(
                &created.id,
                UpdateAgent {
                    name: Some("Analyst".into()),
                    tools: Some(vec!["web_search".into(), "calculator".into()]),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.name, "Analyst");
        assert_eq!(updated.tools.len(), 2);
        assert_eq!(updated.system_prompt.as_deref(), Some("You research."));

        assert!(store.delete(&created.id).await.unwrap());
        assert!(store.get(&created.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn inference_slot_roundtrips_through_create_and_update() {
        let store = store();
        let mut sampling = crate::inference::SamplingConfig {
            temperature: Some(0.2),
            top_k: Some(40),
            repeat_penalty: Some(1.1),
            ..Default::default()
        };
        let created = store
            .create(CreateAgent {
                name: "Tuned".into(),
                inference: Some(sampling.clone()),
                ..Default::default()
            })
            .await
            .unwrap();
        let fetched = store.get(&created.id).await.unwrap().unwrap();
        assert_eq!(fetched.inference.as_ref(), Some(&sampling));

        // Patch the sampling slot via update.
        sampling.temperature = Some(0.9);
        let updated = store
            .update(
                &created.id,
                UpdateAgent {
                    inference: Some(sampling.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.inference.as_ref(), Some(&sampling));
    }

    #[tokio::test]
    async fn per_attribute_slots_roundtrip() {
        let store = store();
        let tts = TtsSlot {
            model_id: Some("tts-1".into()),
            provider: Some("openai".into()),
            voice: Some("alloy".into()),
        };
        let stt = SttSlot {
            model_id: Some("whisper-1".into()),
            provider: Some("openai".into()),
        };
        let img = ImageSlot {
            model_id: Some("dall-e-3".into()),
            provider: Some("openai".into()),
        };
        let mem = MemorySlot {
            space_ids: vec!["space_abc".into()],
            read_levels: vec!["user".into(), "project".into()],
            write_enabled: true,
        };
        let persona = PersonaSlot {
            display_name: Some("Aria".into()),
            avatar_url: None,
            icon: None,
            dither: None,
            tone: Some("friendly".into()),
        };
        let policy = PolicyRef {
            policy_id: Some("strict".into()),
        };
        let chat = ModelSlot {
            model_id: Some("gpt-4o".into()),
            engine: Some("acp:claude".into()),
        };
        let video = VideoSlot {
            model_id: Some("fal-ai/ltx-video".into()),
            provider: Some("fal".into()),
        };

        let created = store
            .create(CreateAgent {
                name: "Slotted".into(),
                chat_model: Some(chat.clone()),
                tts: Some(tts.clone()),
                stt: Some(stt.clone()),
                image_model: Some(img.clone()),
                video_model: Some(video.clone()),
                memory: Some(mem.clone()),
                persona: Some(persona.clone()),
                policy_ref: Some(policy.clone()),
                ..Default::default()
            })
            .await
            .unwrap();

        let fetched = store.get(&created.id).await.unwrap().unwrap();
        assert_eq!(fetched.chat_model.as_ref(), Some(&chat));
        assert_eq!(fetched.tts.as_ref(), Some(&tts));
        assert_eq!(fetched.stt.as_ref(), Some(&stt));
        assert_eq!(fetched.image_model.as_ref(), Some(&img));
        assert_eq!(fetched.video_model.as_ref(), Some(&video));
        assert_eq!(fetched.memory.as_ref(), Some(&mem));
        assert_eq!(fetched.persona.as_ref(), Some(&persona));
        assert_eq!(fetched.policy_ref.as_ref(), Some(&policy));

        // Patching a single slot leaves the others unchanged.
        let new_persona = PersonaSlot {
            display_name: Some("Aria 2".into()),
            ..Default::default()
        };
        let patched = store
            .update(
                &created.id,
                UpdateAgent {
                    persona: Some(new_persona.clone()),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(patched.persona.as_ref(), Some(&new_persona));
        assert_eq!(
            patched.tts.as_ref(),
            Some(&tts),
            "unpatched slots are preserved"
        );
        // Regression: an unrelated patch must not wipe the video slot (the
        // update() SELECT must read video_model so it round-trips through the
        // read-modify-write).
        assert_eq!(
            patched.video_model.as_ref(),
            Some(&video),
            "video_model survives an unrelated update"
        );
    }

    #[tokio::test]
    async fn legacy_model_engine_migrates_to_chat_slot() {
        // Simulate a database that was created before the slot columns existed by
        // inserting a row via raw SQL with only the old model/engine columns set,
        // then re-running the migration to back-fill the chat slot.
        let conn = Connection::open_in_memory().unwrap();
        // Create only the old schema.
        conn.execute_batch(
            "CREATE TABLE agents (
                id TEXT PRIMARY KEY, name TEXT NOT NULL,
                description TEXT, system_prompt TEXT,
                tools TEXT NOT NULL DEFAULT '[]',
                model TEXT, engine TEXT,
                built_in INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );",
        )
        .unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO agents (id, name, tools, model, engine, built_in, created_at, updated_at)
             VALUES ('legacy_agent', 'Legacy', '[]', 'gpt-4o', 'acp:claude', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();

        // Run the migration (adds slot columns + back-fills).
        AgentStore::migrate(&conn).unwrap();

        // Verify no data loss: legacy columns still present.
        let (model, engine): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT model, engine FROM agents WHERE id = 'legacy_agent'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(model.as_deref(), Some("gpt-4o"));
        assert_eq!(engine.as_deref(), Some("acp:claude"));

        // chat_model must be back-filled.
        let chat_json: Option<String> = conn
            .query_row(
                "SELECT chat_model FROM agents WHERE id = 'legacy_agent'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let chat: ModelSlot =
            serde_json::from_str(&chat_json.expect("chat_model populated")).unwrap();
        assert_eq!(
            chat.model_id.as_deref(),
            Some("gpt-4o"),
            "model_id back-filled"
        );
        assert_eq!(
            chat.engine.as_deref(),
            Some("acp:claude"),
            "engine back-filled"
        );
    }

    #[tokio::test]
    async fn migration_is_idempotent() {
        // Running migrate twice must not fail or duplicate data.
        let conn = Connection::open_in_memory().unwrap();
        AgentStore::migrate(&conn).unwrap();
        AgentStore::migrate(&conn).unwrap();
    }

    // ── Identity Vault binding (epic #517, Unit 4) ────────────────────────────

    #[tokio::test]
    async fn legacy_rows_default_identity_profile_ids_to_empty() {
        // Simulate a database created before the identity_profile_ids column.
        // After migration the new column must default to '[]' for existing rows,
        // which `row_to_record` parses as "no bound identities" (the safe default).
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agents (
                id TEXT PRIMARY KEY, name TEXT NOT NULL,
                description TEXT, system_prompt TEXT,
                tools TEXT NOT NULL DEFAULT '[]',
                model TEXT, engine TEXT,
                built_in INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );",
        )
        .unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO agents (id, name, tools, built_in, created_at, updated_at)
             VALUES ('legacy_ident', 'Legacy', '[]', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();

        // Run the full migration (adds the identity_profile_ids column + default).
        AgentStore::migrate(&conn).unwrap();

        let raw: String = conn
            .query_row(
                "SELECT identity_profile_ids FROM agents WHERE id = 'legacy_ident'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(raw, "[]", "legacy rows default to no bound identities");

        // Migration is still idempotent with the new column present.
        AgentStore::migrate(&conn).unwrap();
    }

    #[tokio::test]
    async fn identity_profile_ids_roundtrip_through_create_and_update() {
        let store = store();
        let created = store
            .create(CreateAgent {
                name: "Bound".into(),
                identity_profile_ids: vec!["prof_netflix".into(), "prof_gmail".into()],
                ..Default::default()
            })
            .await
            .unwrap();
        // Default is empty (no broadcast): a record with no binding sees nothing.
        assert_eq!(
            created.identity_profile_ids,
            vec!["prof_netflix".to_string(), "prof_gmail".to_string()]
        );

        let fetched = store.get(&created.id).await.unwrap().unwrap();
        assert_eq!(fetched.identity_profile_ids.len(), 2);

        // Patch replaces the binding list.
        let updated = store
            .update(
                &created.id,
                UpdateAgent {
                    identity_profile_ids: Some(vec!["prof_only".into()]),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.identity_profile_ids, vec!["prof_only".to_string()]);

        // An agent with no binding sees no profiles (empty = none, never "all").
        let none = store
            .create(CreateAgent {
                name: "Unbound".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert!(none.identity_profile_ids.is_empty());
    }

    #[tokio::test]
    async fn orchestration_capabilities_default_and_roundtrip() {
        let store = store();

        // The flagship ryu is seeded with both capabilities ON.
        let ryu = store.get("ryu").await.unwrap().unwrap();
        assert!(ryu.orchestrator_enabled(), "ryu should be an orchestrator");
        assert!(
            ryu.can_create_agents_enabled(),
            "ryu should be allowed to create agents (it runs the builder pane)"
        );

        // A fresh custom agent gets the safe defaults: delegation on, creation off,
        // both stored as NULL (`None`) so the helpers apply the code defaults.
        let made = store
            .create(CreateAgent {
                name: "Plain".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(made.orchestrator, None);
        assert_eq!(made.can_create_agents, None);
        assert!(made.orchestrator_enabled());
        assert!(!made.can_create_agents_enabled());

        // Toggling persists through the store round-trip.
        let updated = store
            .update(
                &made.id,
                UpdateAgent {
                    orchestrator: Some(false),
                    can_create_agents: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.orchestrator, Some(false));
        assert_eq!(updated.can_create_agents, Some(true));
        let refetched = store.get(&made.id).await.unwrap().unwrap();
        assert_eq!(refetched.orchestrator, Some(false));
        assert_eq!(refetched.can_create_agents, Some(true));
        assert!(!refetched.orchestrator_enabled());
        assert!(refetched.can_create_agents_enabled());
    }

    #[tokio::test]
    async fn update_of_unrelated_field_preserves_identity_bindings() {
        // Regression guard: `update()` reads-modifies-writes the whole row, so its
        // SELECT must include identity_profile_ids — otherwise patching any other
        // field silently wipes the bindings. (This previously did exactly that.)
        let store = store();
        let created = store
            .create(CreateAgent {
                name: "Bound".into(),
                identity_profile_ids: vec!["prof_gmail".into()],
                ..Default::default()
            })
            .await
            .unwrap();

        // Patch only the name — identity bindings must survive untouched.
        let updated = store
            .update(
                &created.id,
                UpdateAgent {
                    name: Some("Renamed".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.name, "Renamed");
        assert_eq!(
            updated.identity_profile_ids,
            vec!["prof_gmail".to_string()],
            "patching an unrelated field must not wipe identity bindings"
        );
    }

    #[tokio::test]
    async fn built_in_agents_cannot_be_deleted() {
        let store = store();
        assert!(store.delete("acp:claude").await.is_err());
        assert!(store.get("acp:claude").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn seed_is_idempotent_and_preserves_edits() {
        let registry = AcpAgentRegistry::new();
        // Re-seeding (simulating a restart) must not duplicate or clobber rows.
        let store = AgentStore::open_in_memory(&registry).unwrap();
        store
            .update(
                "acp:claude",
                UpdateAgent {
                    system_prompt: Some("custom".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            AgentStore::seed_built_ins(&conn, &registry).unwrap();
        }
        let claude = store.get("acp:claude").await.unwrap().unwrap();
        assert_eq!(claude.system_prompt.as_deref(), Some("custom"));
        // Re-seed must not duplicate rows: still exactly one row per registry entry.
        assert_eq!(
            store
                .list()
                .await
                .unwrap()
                .iter()
                .filter(|a| a.built_in)
                .count(),
            registry.entries.len()
        );
    }

    // ── M3 agent-apps: migration defaults (AC1) ───────────────────────────────

    #[tokio::test]
    async fn legacy_rows_default_version_and_locked_sensibly() {
        // Simulate a database created before the version/locked columns were added.
        // After migration, existing rows must have version="1.0.0" and locked=false.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE agents (
                id TEXT PRIMARY KEY, name TEXT NOT NULL,
                description TEXT, system_prompt TEXT,
                tools TEXT NOT NULL DEFAULT '[]',
                model TEXT, engine TEXT,
                built_in INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );",
        )
        .unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO agents (id, name, tools, built_in, created_at, updated_at)
             VALUES ('old_agent', 'Old', '[]', 0, ?1, ?1)",
            params![now],
        )
        .unwrap();

        // Run the full migration (adds slot columns, version, locked, back-fills).
        AgentStore::migrate(&conn).unwrap();

        let (version, locked): (String, i64) = conn
            .query_row(
                "SELECT version, locked FROM agents WHERE id = 'old_agent'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(version, "1.0.0", "legacy rows default to version 1.0.0");
        assert_eq!(locked, 0, "legacy rows default to unlocked");
    }

    // ── M3 agent-apps: locked immutability (AC3) ──────────────────────────────

    #[tokio::test]
    async fn locked_agent_rejects_update() {
        let store = store();
        let agent = store
            .create(CreateAgent {
                name: "Lockable".into(),
                ..Default::default()
            })
            .await
            .unwrap();

        // Lock the agent.
        store
            .update(
                &agent.id,
                UpdateAgent {
                    locked: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();

        // Attempt to edit — must error.
        let result = store
            .update(
                &agent.id,
                UpdateAgent {
                    name: Some("Renamed".into()),
                    ..Default::default()
                },
            )
            .await;
        assert!(
            result.is_err(),
            "update on locked agent must return an error"
        );
        let err = result.unwrap_err().to_string();
        assert!(err.contains("locked"), "error must mention 'locked': {err}");
    }

    #[tokio::test]
    async fn locked_agent_can_be_unlocked_and_edited() {
        let store = store();
        let agent = store
            .create(CreateAgent {
                name: "Lockable2".into(),
                ..Default::default()
            })
            .await
            .unwrap();

        // Lock then unlock.
        store
            .update(
                &agent.id,
                UpdateAgent {
                    locked: Some(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        store
            .update(
                &agent.id,
                UpdateAgent {
                    locked: Some(false),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();

        // Now editing must succeed.
        let updated = store
            .update(
                &agent.id,
                UpdateAgent {
                    name: Some("Unlocked".into()),
                    ..Default::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.name, "Unlocked");
    }

    // ── M3 agent-apps: export/import round-trip (AC2) ─────────────────────────

    // ── Issue #410: PersonaSlot wired into chat prompt context ───────────────

    #[test]
    fn persona_tone_prefix_builds_correct_string() {
        // Both name and tone present.
        let persona = PersonaSlot {
            display_name: Some("Aria".to_owned()),
            avatar_url: None,
            icon: None,
            dither: None,
            tone: Some("pirate".to_owned()),
        };
        // Build the prefix the same way route_chat_stream does (inline logic test).
        let prefix = {
            let mut p = String::new();
            if let Some(name) = &persona.display_name {
                p.push_str(&format!("Your name is {name}.\n"));
            }
            if let Some(tone) = &persona.tone {
                p.push_str(&format!(
                    "You are {tone}. Respond in that voice consistently."
                ));
            }
            p
        };
        assert!(
            prefix.contains("pirate"),
            "prefix must contain tone: {prefix}"
        );
        assert!(
            prefix.contains("Your name is Aria"),
            "prefix must contain name: {prefix}"
        );
        assert!(
            prefix.contains("Respond in that voice consistently."),
            "prefix must contain cue: {prefix}"
        );
    }

    #[test]
    fn persona_tone_prefix_tone_only() {
        let persona = PersonaSlot {
            display_name: None,
            avatar_url: None,
            icon: None,
            dither: None,
            tone: Some("pirate".to_owned()),
        };
        let prefix = {
            let mut p = String::new();
            if let Some(name) = &persona.display_name {
                p.push_str(&format!("Your name is {name}.\n"));
            }
            if let Some(tone) = &persona.tone {
                p.push_str(&format!(
                    "You are {tone}. Respond in that voice consistently."
                ));
            }
            p
        };
        assert!(
            prefix.contains("pirate"),
            "prefix must contain tone: {prefix}"
        );
        assert!(
            !prefix.contains("Your name is"),
            "no name line when display_name is None: {prefix}"
        );
    }

    #[test]
    fn persona_icon_and_dither_roundtrip_json() {
        // Icon avatar source survives a serialize → parse round-trip.
        let icon_persona = PersonaSlot {
            icon: Some("lucide:sparkles".to_owned()),
            ..Default::default()
        };
        let json = serde_json::to_string(&icon_persona).unwrap();
        let parsed: PersonaSlot = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, icon_persona);
        assert_eq!(parsed.icon.as_deref(), Some("lucide:sparkles"));
        assert!(parsed.dither.is_none());

        // Dither avatar source (nested spec) survives the same round-trip and
        // preserves the camelCase-agnostic {from,to,direction} shape.
        let dither_persona = PersonaSlot {
            dither: Some(DitherSpec {
                from: Some("green".to_owned()),
                to: Some("blue".to_owned()),
                direction: Some("up".to_owned()),
            }),
            ..Default::default()
        };
        let json = serde_json::to_string(&dither_persona).unwrap();
        assert!(
            json.contains("\"direction\":\"up\""),
            "dither spec keys stay verbatim: {json}"
        );
        let parsed: PersonaSlot = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, dither_persona);

        // An empty persona serializes without any of the optional keys.
        let empty = serde_json::to_string(&PersonaSlot::default()).unwrap();
        assert_eq!(empty, "{}");
    }

    #[tokio::test]
    async fn export_import_roundtrips_agent_template() {
        let store = store();
        let original = store
            .create(CreateAgent {
                name: "Exportable".into(),
                system_prompt: Some("You export.".into()),
                tools: vec!["web_search".into()],
                engine: Some("acp:claude".into()),
                identity_profile_ids: vec!["prof_portable".into()],
                version: "2.1.0".into(),
                ..Default::default()
            })
            .await
            .unwrap();

        // Export to template.
        let template = original.to_template();
        assert_eq!(template.kind, "agent");
        assert_eq!(template.name, "Exportable");
        assert_eq!(template.version, "2.1.0");
        assert_eq!(
            template.agent_config.system_prompt.as_deref(),
            Some("You export.")
        );
        assert_eq!(template.agent_config.tools, vec!["web_search"]);
        assert_eq!(template.agent_config.engine.as_deref(), Some("acp:claude"));
        // Identity binding is portable across export.
        assert_eq!(
            template.agent_config.identity_profile_ids,
            vec!["prof_portable"]
        );

        // Template serializes to JSON and back cleanly.
        let json = serde_json::to_string(&template).unwrap();
        let parsed: AgentTemplate = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, "Exportable");

        // Import creates a new agent with a fresh id.
        let imported = store.create(parsed.into_create_agent()).await.unwrap();
        assert_ne!(imported.id, original.id, "import must assign a fresh id");
        assert_eq!(imported.name, "Exportable");
        assert_eq!(imported.system_prompt.as_deref(), Some("You export."));
        assert_eq!(imported.tools, vec!["web_search"]);
        assert_eq!(imported.engine.as_deref(), Some("acp:claude"));
        assert_eq!(imported.version, "2.1.0");
        assert_eq!(
            imported.identity_profile_ids,
            vec!["prof_portable"],
            "identity binding survives the export/import round-trip"
        );
        assert!(!imported.locked, "imported agent must start unlocked");
    }
}
