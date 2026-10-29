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
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::{ContentCipher, ContentContext};
use ryu_workspace::source_history::{SourceHistory, SourceHistoryVersion};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::activity::sealed_store::{core_cipher, StoreSeal};
use crate::sidecar::adapters::AcpAgentRegistry;

pub mod jay_jr;
pub mod patrol;

/// Whether `agent_id` is a built-in bot that runs on Ryu's managed engine under
/// its own identity (as opposed to the flagship `ryu` facade itself): Jay Jr. and
/// Patrol. These bots take the managed Pi + Gateway route, are seeded installed,
/// and never read the user's own Pi launch settings.
pub fn runs_on_ryu_engine(agent_id: &str) -> bool {
    jay_jr::runs_on_ryu_engine(agent_id) || patrol::is_patrol(agent_id)
}

/// Whether a custom agent saved on the "Ryu" engine (`acp:pi`) with limited
/// model provider access runs on Ryu's managed, Gateway-routed Pi under its own
/// id, with the credential-free limited Pi config. An unrestricted custom
/// `acp:pi` agent, and the built-in `acp:pi` row itself, keep the user's own
/// Pi, which a limited agent never launches.
pub fn runs_limited_on_managed_pi(
    agent_id: &str,
    engine: Option<&str>,
    provider_access: Option<&[String]>,
) -> bool {
    provider_access.is_some()
        && !matches!(agent_id.trim(), "" | "default" | "ryu" | "acp:pi")
        && !runs_on_ryu_engine(agent_id)
        && engine.map(str::trim) == Some("acp:pi")
}

/// Explicit opt-in marker for an agent that may call every MCP tool currently
/// registered on the node. An empty or missing persisted list is fail-closed by
/// [`AgentRecord::mcp_tool_allowlist`].
pub const ALL_MCP_TOOLS: &str = "*";

/// Private wire marker used when a user explicitly turns every capability in a
/// category off. It is intentionally not a real tool or skill id.
pub const NO_AGENT_CAPABILITIES: &str = "__ryu_none__";

/// Whether an agent is still being authored, being evaluated, or available for
/// normal use. This is intentionally separate from [`AgentSafetyProfile`]: a
/// trial agent is read-only even when its saved profile is autonomous.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentLifecycleStatus {
    Draft,
    Trial,
    Active,
}

impl AgentLifecycleStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Trial => "trial",
            Self::Active => "active",
        }
    }

    /// Whether changing from `self` to `next` is an intentional, reviewable
    /// lifecycle transition. Repeated updates are idempotent.
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Draft, Self::Draft)
                | (Self::Draft, Self::Trial)
                | (Self::Trial, Self::Draft)
                | (Self::Trial, Self::Trial)
                | (Self::Trial, Self::Active)
                | (Self::Active, Self::Draft)
                | (Self::Active, Self::Trial)
                | (Self::Active, Self::Active)
        )
    }
}

impl Default for AgentLifecycleStatus {
    fn default() -> Self {
        Self::Active
    }
}

impl std::str::FromStr for AgentLifecycleStatus {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "draft" => Ok(Self::Draft),
            "trial" => Ok(Self::Trial),
            "active" => Ok(Self::Active),
            other => anyhow::bail!("unknown agent lifecycle status '{other}'"),
        }
    }
}

/// The least-permissive execution profile saved on an agent. The runtime also
/// applies global and per-run policy, so this is never an escalation grant.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentSafetyProfile {
    ReadOnly,
    ApprovalRequired,
    /// Every side-effecting operation must arrive through a Core-verified,
    /// certificate-bound tool plan. Direct raw tool calls are denied.
    VerifiedPlanOnly,
    Autonomous,
}

impl AgentSafetyProfile {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read_only",
            Self::ApprovalRequired => "approval_required",
            Self::VerifiedPlanOnly => "verified_plan_only",
            Self::Autonomous => "autonomous",
        }
    }
}

impl Default for AgentSafetyProfile {
    fn default() -> Self {
        Self::Autonomous
    }
}

impl std::str::FromStr for AgentSafetyProfile {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "read_only" => Ok(Self::ReadOnly),
            "approval_required" => Ok(Self::ApprovalRequired),
            "verified_plan_only" => Ok(Self::VerifiedPlanOnly),
            "autonomous" => Ok(Self::Autonomous),
            other => anyhow::bail!("unknown agent safety profile '{other}'"),
        }
    }
}

fn default_create_safety_profile() -> AgentSafetyProfile {
    AgentSafetyProfile::ReadOnly
}

/// Whose accounts an agent works with. `Managed` acts as the user with the
/// accounts the user connected; `Individual` has its own identity and accounts
/// and never touches the user's; `Mixed` may use both. Legacy rows default to
/// `Managed`, which with an unrestricted [`AgentRecord::account_access`] is the
/// behaviour every agent had before this setting existed.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AgentIdentityMode {
    #[default]
    Managed,
    Individual,
    Mixed,
}

impl AgentIdentityMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Managed => "managed",
            Self::Individual => "individual",
            Self::Mixed => "mixed",
        }
    }

    /// How far into the user's accounts the mode reaches, used to order an
    /// app's declared mode against an agent's current one: `managed` (acts as
    /// the user) reaches furthest, then `mixed` (its own accounts first, the
    /// user's only as allowed), then `individual` (never the user's). A move to
    /// a lower value narrows the agent; a move to a higher one widens it.
    pub const fn user_account_reach(self) -> u8 {
        match self {
            Self::Managed => 2,
            Self::Mixed => 1,
            Self::Individual => 0,
        }
    }
}

/// Id prefix of the agent Core creates for an app's `kind: "agent"` Runnable
/// (`app__<runnable id>`).
pub const APP_AGENT_ID_PREFIX: &str = "app__";

/// Where an app agent's identity mode came from, kept beside the agent so an
/// app update can tell the app's mode from the user's own choice. See
/// [`AgentStore::reconcile_app_identity`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct AppAgentIdentity {
    /// The mode the app's manifest last set on the agent. The user changed the
    /// mode themselves when the agent's mode differs from it.
    pub app_mode: AgentIdentityMode,
    /// A mode a newer app version asks for that Core did not apply by itself:
    /// a wider mode, or any change to a mode the user chose or a locked agent.
    /// The user accepts it by saving the agent with this mode, or dismisses it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_mode: Option<AgentIdentityMode>,
}

/// What [`AgentStore::reconcile_app_identity`] did with an app's declared mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppIdentityOutcome {
    /// The agent was created with the declared mode.
    Created,
    /// Nothing to change: the declared mode is the one the app already set.
    Unchanged,
    /// The declared mode narrowed the agent and the user had not chosen
    /// another, so Core applied it.
    Narrowed {
        from: AgentIdentityMode,
        to: AgentIdentityMode,
    },
    /// The declared mode was left for the user to accept.
    Pending {
        current: AgentIdentityMode,
        requested: AgentIdentityMode,
    },
}

/// The pure decision behind [`AgentStore::reconcile_app_identity`]: given the
/// agent's current mode, the mode the app last set, and the mode the app now
/// declares, return the mode to store, the new provenance, and the outcome.
///
/// The declared mode is applied only when the user has not changed the mode
/// (current == app mode), the agent is not locked, and it narrows the agent.
/// Anything else that differs is left pending; nothing here ever widens.
fn decide_app_identity(
    current: AgentIdentityMode,
    app_mode: AgentIdentityMode,
    declared: AgentIdentityMode,
    locked: bool,
) -> (AgentIdentityMode, AppAgentIdentity, AppIdentityOutcome) {
    let settled = |mode| AppAgentIdentity {
        app_mode: mode,
        pending_mode: None,
    };
    if declared == app_mode {
        // The app asks for what it already set (or went back to it): any older
        // pending request is withdrawn.
        return (current, settled(app_mode), AppIdentityOutcome::Unchanged);
    }
    if declared == current {
        // The user is already where the app now wants to be.
        return (current, settled(declared), AppIdentityOutcome::Unchanged);
    }
    let user_chose = current != app_mode;
    if !user_chose && !locked && declared.user_account_reach() < current.user_account_reach() {
        return (
            declared,
            settled(declared),
            AppIdentityOutcome::Narrowed {
                from: current,
                to: declared,
            },
        );
    }
    (
        current,
        AppAgentIdentity {
            app_mode,
            pending_mode: Some(declared),
        },
        AppIdentityOutcome::Pending {
            current,
            requested: declared,
        },
    )
}

fn read_app_identity(conn: &Connection, agent_id: &str) -> Result<Option<AppAgentIdentity>> {
    let row: Option<(String, Option<String>)> = conn
        .query_row(
            "SELECT app_mode, pending_mode FROM app_agent_identity WHERE agent_id = ?1",
            params![agent_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    // A stored mode that does not parse fails closed to `individual`: as the
    // app's mode it makes any wider current mode read as the user's choice,
    // and as a pending mode it is only ever a request.
    let parse = |value: &str| value.parse().unwrap_or(AgentIdentityMode::Individual);
    Ok(row.map(|(app_mode, pending_mode)| AppAgentIdentity {
        app_mode: parse(&app_mode),
        pending_mode: pending_mode.as_deref().map(parse),
    }))
}

fn write_app_identity(conn: &Connection, agent_id: &str, identity: AppAgentIdentity) -> Result<()> {
    conn.execute(
        "INSERT INTO app_agent_identity (agent_id, app_mode, pending_mode)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(agent_id) DO UPDATE SET
            app_mode = excluded.app_mode,
            pending_mode = excluded.pending_mode",
        params![
            agent_id,
            identity.app_mode.as_str(),
            identity.pending_mode.map(AgentIdentityMode::as_str),
        ],
    )?;
    Ok(())
}

impl From<crate::plugin_manifest::schema::ManifestAgentIdentityMode> for AgentIdentityMode {
    fn from(mode: crate::plugin_manifest::schema::ManifestAgentIdentityMode) -> Self {
        use crate::plugin_manifest::schema::ManifestAgentIdentityMode as Manifest;
        match mode {
            Manifest::Managed => Self::Managed,
            Manifest::Individual => Self::Individual,
            Manifest::Mixed => Self::Mixed,
        }
    }
}

impl std::str::FromStr for AgentIdentityMode {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "managed" => Ok(Self::Managed),
            "individual" => Ok(Self::Individual),
            "mixed" => Ok(Self::Mixed),
            other => anyhow::bail!("unknown agent identity mode '{other}'"),
        }
    }
}

/// Distinguishes an absent patch field (`None`) from an explicit `null`
/// (`Some(None)`), so a patch can clear a nullable field.
fn double_option<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

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
    /// `["agent", "user", "node", "project", "org"]`. An **empty** list means the four
    /// PERSONAL levels — `agent`, `user`, `node`, `project` (the back-compat default for
    /// agents configured before this existed).
    ///
    /// `"org"` is **not** in that default and must be named explicitly. Every agent
    /// predating org scope has an empty list, so folding `org` into the default
    /// would have granted all of them organization-wide recall the moment the level
    /// shipped. Both readers enforce this: `MemoryStore::effective_levels` and
    /// `ryu_rag::memory_level_matches` (which also excludes `org` from its
    /// permissive `read_levels == None` branch, so the store and the retrieval index
    /// agree about what an unconfigured agent can see).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub read_levels: Vec<String>,
    /// Whether the agent may write new memories during a session.
    #[serde(default)]
    pub write_enabled: bool,
    /// Mastra-style working memory: a per-thread or per-resource scratchpad
    /// (Markdown template or JSON-schema object) injected into every turn and
    /// updated by the agent through `working_memory.update_working_memory`.
    /// Absent = off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_memory: Option<ryu_memory::WorkingMemoryConfig>,
    /// Per-agent context compaction overrides. Absent fields fall back to the
    /// node-wide `context.*` preferences.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<CompactionSettings>,
}

/// Per-agent context compaction settings. Every field is optional and
/// overrides the matching node-wide `context.*` preference for turns this agent
/// runs; an absent field keeps the node default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct CompactionSettings {
    /// Turn compaction on/off for this agent (`context.auto-compact`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// The token budget at which older turns are dropped or summarized
    /// (`context.max-tokens`): a positive integer or `"auto"` (the loaded
    /// model's context size).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<CompactionThreshold>,
    /// Model used to summarize dropped turns (`context.compact-model`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Reasoning effort for the summarizer (`context.compact-effort`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
}

/// A compaction threshold: a token count or `"auto"`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum CompactionThreshold {
    Tokens(u64),
    Keyword(String),
}

impl CompactionThreshold {
    /// The value in the `context.max-tokens` preference format.
    pub fn as_pref_value(&self) -> String {
        match self {
            Self::Tokens(tokens) => tokens.to_string(),
            Self::Keyword(keyword) => keyword.trim().to_ascii_lowercase(),
        }
    }
}

impl MemorySlot {
    /// Reject a slot whose working-memory or compaction settings cannot work.
    pub fn validate(&self) -> Result<()> {
        if let Some(working) = &self.working_memory {
            working.validate()?;
        }
        if let Some(CompactionThreshold::Keyword(keyword)) =
            self.compaction.as_ref().and_then(|c| c.threshold.as_ref())
        {
            let keyword = keyword.trim().to_ascii_lowercase();
            if keyword != "auto" && keyword != "off" {
                anyhow::bail!("compaction threshold must be a token count, \"auto\", or \"off\"");
            }
        }
        if let Some(CompactionThreshold::Tokens(0)) =
            self.compaction.as_ref().and_then(|c| c.threshold.as_ref())
        {
            anyhow::bail!("compaction threshold must be greater than zero");
        }
        Ok(())
    }
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

/// DiceBear avatar spec: a style id from https://www.dicebear.com/styles/ plus a
/// seed string. Core stores it verbatim; the client builds the SVG URL.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DicebearSpec {
    /// DiceBear style id (e.g. `"notionists"`, `"bottts-neutral"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// Deterministic seed for the style.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
}

/// Avatar drawn from a plugin-contributed avatar style
/// (`contributes.avatar_styles`): the style id, a seed for unpicked regions, an
/// optional palette, and explicit region picks (a style option id or a namespaced
/// accessory id). Core stores it verbatim; the client resolves the style and falls
/// back when its plugin is not installed or enabled.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AvatarStyleSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parts: Option<std::collections::BTreeMap<String, String>>,
}

/// Expressive Ryu ghost avatar: a named mood plus an animation selection. Core
/// stores both opaque values and the clients render the animated ghost.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ExpressiveSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expression: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(rename = "bodyStyle", skip_serializing_if = "Option::is_none")]
    pub body_style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behavior: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colors: Option<std::collections::BTreeMap<String, String>>,
    /// Halloween costume slots (palette, finish, eyes, headwear, ...) for the
    /// `costume` variant, stored opaquely like `colors`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub costume: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animated: Option<bool>,
    #[serde(rename = "eyeScale", skip_serializing_if = "Option::is_none")]
    pub eye_scale: Option<f64>,
    #[serde(rename = "animationDuration", skip_serializing_if = "Option::is_none")]
    pub animation_duration: Option<f64>,
}

/// Persona slot: name, avatar, and tone instructions.
///
/// Glyph sources from the shared GlyphPicker, resolved client-side:
/// uploaded image ([`avatar_url`]), emoji ([`emoji`]), custom icon
/// ([`icon`] + optional [`icon_color`]), DiceBear ([`dicebear`]), expressive
/// ghost ([`expressive`]), or a dither-gradient ([`dither`]). Dither may layer as a *background* under
/// emoji or icon (never under DiceBear or an uploaded image). Setting a
/// primary source clears the others on save; Core stores whatever is present
/// and never interprets the fields.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct PersonaSlot {
    /// Output-style profile assigned to this agent. The id resolves through the
    /// enabled output-style registry, while the profile body remains owned by
    /// the plugin or user style store. `None` means this agent uses its own
    /// instructions and tone without a profile.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_style_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    /// Native emoji character used as the avatar glyph.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    /// Custom icon id (Iconify / icons0 / Hugeicons), an alternative avatar
    /// source to an uploaded image or a dither gradient.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Optional hex tint for [`icon`] (e.g. `"#3b82f6"`). Absent = theme
    /// `currentColor`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_color: Option<String>,
    /// DiceBear generative avatar (style + seed). Does not mix with dither.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dicebear: Option<DicebearSpec>,
    /// Ryu ghost eyes with a named expression or the cycling `random` selection,
    /// plus a named animation or the cycling `random` selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expressive: Option<ExpressiveSpec>,
    /// Dither-gradient: standalone avatar, or background under [`emoji`]/[`icon`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dither: Option<DitherSpec>,
    /// Plugin-contributed avatar style (see [`AvatarStyleSpec`]). Does not mix
    /// with dither.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_style: Option<AvatarStyleSpec>,
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
    /// Authoring/runtime lifecycle. Legacy rows default to active during the
    /// additive migration so existing automations keep their behavior.
    #[serde(default)]
    pub lifecycle_status: AgentLifecycleStatus,
    /// Saved safety posture. Trial lifecycle always overrides this to read-only
    /// at dispatch time.
    #[serde(default)]
    pub safety_profile: AgentSafetyProfile,
    /// Optional role/title shown beside the agent's human name.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Tool or MCP server ids this agent may use. `*` means all tools currently
    /// registered (including plugin/app tools) and future tools added to the
    /// node; a non-empty list narrows access. Empty is retained as the legacy
    /// unrestricted value, while `__ryu_none__` is the explicit no-tools value.
    #[serde(default)]
    pub tools: Vec<String>,
    /// Composio action names this agent may call (e.g. `GMAIL_SEND_EMAIL`). Kept
    /// separate from `tools` (which holds MCP `<server>.<tool>` ids) because the
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
    /// on both the openai-compat and ACP planes via the skill registry — and, since
    /// it is the model itself that pulls L2 bodies under progressive disclosure,
    /// also at `skills.search` / `skills.load` dispatch (`sidecar::mcp::skills_tool`),
    /// so what an agent can load equals what its index shows.
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
    /// Tool ids (MCP `<server>.<tool>`) that require a human-in-the-loop
    /// approval before this agent may execute them (Layer A of the approval
    /// policy — see [`crate::approvals::policy`]). An **empty** list means the
    /// agent has no per-agent gated tools (the safe default — opt-in, like
    /// `identity_profile_ids`). Composes with the global approval mode + risk
    /// tags + the Gateway consult via logical OR: any layer requiring approval
    /// gates the call.
    #[serde(default)]
    pub approval_tools: Vec<String>,
    /// Whose accounts this agent works with (see [`AgentIdentityMode`]).
    #[serde(default)]
    pub identity_mode: AgentIdentityMode,
    /// Account keys this agent may use (`composio:<id>`, `mcp:<profile>:<plugin>:<server>`,
    /// `mcp-secret:<server-or-plugin>`, `provider:<id>`, `platform:treg`,
    /// `platform:desktop`, `agent:<vault_account_id>`; parsed in
    /// `crate::agent_access`). `None` is unrestricted (legacy behaviour);
    /// `Some(vec![])` allows no accounts. Node-local: never part of a template.
    /// Identity Vault profiles stay in [`Self::identity_profile_ids`].
    #[serde(default)]
    pub account_access: Option<Vec<String>>,
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
    /// Whether this agent may discover peers (`orchestrator.discover_agents`)
    /// and delegate work to them (`delegate.*`). `None` is the default and is
    /// treated as **on**: delegation has always been default-available, so
    /// legacy rows keep it. `Some(false)` withholds delegation/discovery from
    /// this agent's offered tool set. See [`AgentRecord::orchestrator_enabled`].
    #[serde(default)]
    pub orchestrator: Option<bool>,
    /// Whether this agent may mint or reconfigure custom agents via the
    /// `agent_builder.create_agent` tool. Defaults to **off** (`None` /
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

    /// Resolve the persisted tool setting into the shape used by the MCP
    /// registry: `None` is unrestricted, `Some([])` is explicitly empty.
    pub fn mcp_tool_allowlist(&self) -> Option<Vec<String>> {
        if self.tools.iter().any(|tool| tool == ALL_MCP_TOOLS) {
            return None;
        }
        if self.tools.is_empty() || self.tools.iter().any(|tool| tool == NO_AGENT_CAPABILITIES) {
            return Some(Vec::new());
        }
        Some(self.tools.clone())
    }

    /// Resolve the persisted skill setting into the empty-means-all contract
    /// already used by the skill registry. The private no-capabilities marker
    /// is deliberately non-matching, so it produces an explicit empty scope.
    pub fn skill_allowlist(&self) -> Vec<String> {
        if self.skills.is_empty() {
            return Vec::new();
        }
        if self
            .skills
            .iter()
            .any(|skill| skill == NO_AGENT_CAPABILITIES)
        {
            return vec![NO_AGENT_CAPABILITIES.to_owned()];
        }
        self.skills.clone()
    }
}

/// Fields a client may supply when creating an agent. `id` is server-assigned.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateAgent {
    pub name: String,
    /// New agents begin in `trial`; this saved profile is still surfaced so a
    /// later promotion cannot accidentally make them autonomous by default.
    #[serde(default = "default_create_safety_profile")]
    pub safety_profile: AgentSafetyProfile,
    /// Optional role/title shown beside the agent's human name.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Tool/MCP allowlist. Omitted on create means no MCP tools; an explicit
    /// wildcard (`*`) is required to opt into every current and future tool.
    #[serde(default = "default_agent_tools")]
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
    /// Tool ids that always require a human approval before execution. This is
    /// an opt-in safety layer and never grants the agent additional capability.
    #[serde(default)]
    pub approval_tools: Vec<String>,
    /// Whose accounts the agent works with. See [`AgentRecord::identity_mode`].
    #[serde(default)]
    pub identity_mode: AgentIdentityMode,
    /// Account allowlist; `None` = unrestricted. See [`AgentRecord::account_access`].
    #[serde(default)]
    pub account_access: Option<Vec<String>>,
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
            safety_profile: default_create_safety_profile(),
            title: String::new(),
            description: None,
            system_prompt: None,
            tools: default_agent_tools(),
            composio_actions: vec![],
            skills: vec![],
            identity_profile_ids: vec![],
            approval_tools: vec![],
            identity_mode: AgentIdentityMode::default(),
            account_access: None,
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

impl CreateAgent {
    /// Apply the shared capability defaults at the persistence boundary.
    ///
    /// `serde(default = "default_agent_tools")` covers normal API payloads,
    /// but internal creators and older template/import paths can construct a
    /// `CreateAgent` literal with an empty `tools` vector. Treat that legacy
    /// shape as the same least-privilege default so ACP installs, onboarding
    /// records, plugin-provided agents, and user-created cards cannot drift.
    /// The wildcard remains an explicit opt-in for users who grant every tool.
    pub fn with_capability_defaults(mut self) -> Self {
        if self.tools.is_empty() {
            self.tools = default_agent_tools();
        }
        self
    }
}

/// A patch was based on an agent revision that someone else has since changed.
///
/// On a shared node two members can edit the same agent. A client that sends the
/// `updated_at` it loaded as [`UpdateAgent::expected_updated_at`] gets this error
/// instead of silently overwriting the other member's save, and can reload the
/// current record and reapply its change.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentUpdateConflict {
    /// The stored revision the patch did not match.
    pub current_updated_at: Option<String>,
}

impl std::fmt::Display for AgentUpdateConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("agent revision conflict: the agent was changed since it was loaded")
    }
}

impl std::error::Error for AgentUpdateConflict {}

/// Fields a client may patch on update. Absent fields are left unchanged.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateAgent {
    /// Optimistic-concurrency guard: the `updated_at` the client last loaded.
    /// When present and no longer current, the update fails with
    /// [`AgentUpdateConflict`] instead of overwriting a newer save.
    #[serde(default)]
    pub expected_updated_at: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    /// Explicit lifecycle transition. `draft -> active` is rejected; callers
    /// must pass through trial so the agent has a real evaluation checkpoint.
    #[serde(default)]
    pub lifecycle_status: Option<AgentLifecycleStatus>,
    /// Saved safety posture for active agents. Trial still forces read-only.
    #[serde(default)]
    pub safety_profile: Option<AgentSafetyProfile>,
    /// Replaces the role/title. An empty string clears it.
    #[serde(default)]
    pub title: Option<String>,
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
    /// Approval-tool patch (`Some(_)` replaces the list; empty = no per-agent
    /// approval rules).
    #[serde(default)]
    pub approval_tools: Option<Vec<String>>,
    /// Identity mode patch. `None` is unchanged. Setting the mode a newer app
    /// version asked for ([`AppAgentIdentity::pending_mode`]) also accepts that
    /// request.
    #[serde(default)]
    pub identity_mode: Option<AgentIdentityMode>,
    /// Dismiss the identity mode a newer app version asked for, keeping the
    /// agent's current mode. Treated as the user's own choice from then on.
    #[serde(default)]
    pub dismiss_pending_identity_mode: bool,
    /// Account allowlist patch. Absent is unchanged, an explicit `null`
    /// (`Some(None)`) clears it to unrestricted, and a list replaces it.
    #[serde(default, deserialize_with = "double_option")]
    pub account_access: Option<Option<Vec<String>>>,
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

/// Metadata for one saved system-prompt version. The prompt body is fetched
/// separately so history lists stay small.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPromptVersionMeta {
    pub agent_id: String,
    pub created_at: i64,
    pub id: String,
    pub label: Option<String>,
}

/// A complete saved system-prompt version.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPromptVersion {
    pub agent_id: String,
    pub created_at: i64,
    pub id: String,
    pub label: Option<String>,
    pub prompt: String,
}

/// Metadata for one saved agent configuration version. The complete record is
/// fetched separately so history lists stay small.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfigVersionMeta {
    pub agent_id: String,
    pub created_at: i64,
    pub id: String,
    pub label: Option<String>,
    pub name: String,
    pub version: String,
}

/// A complete saved agent configuration version. `source` is the exact
/// canonical JSON used by the diff view; `agent` is the typed projection used
/// by callers that want to inspect or restore the record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfigVersion {
    pub agent: AgentRecord,
    pub agent_id: String,
    pub created_at: i64,
    pub id: String,
    pub label: Option<String>,
    pub name: String,
    pub source: String,
    pub version: String,
}

fn default_version() -> String {
    "1.0.0".to_owned()
}

fn default_agent_tools() -> Vec<String> {
    vec![NO_AGENT_CAPABILITIES.to_owned()]
}

fn db_path() -> PathBuf {
    crate::paths::db_path(AGENTS_STORE)
}

// ── Encryption at rest ────────────────────────────────────────────────────────
//
// `agents.db` seals the user-authored text of every agent: `description`,
// `system_prompt` and `persona` (`encb:v1:` under the `agents.db` content key,
// each bound to the agent id and column), the legacy `agent_prompt_versions.prompt`
// (bound to the version id) and `agent_operation_receipts.receipt` (a full copy
// of the agent, bound to agent id + operation id). Ids, names, titles, model and
// tool bindings, flags and timestamps stay plaintext. Legacy rows are sealed on
// open; copies to a new id re-seal in Rust.

/// Registered store name (content-key input; never rename).
const AGENTS_STORE: &str = "agents.db";
const DESCRIPTION: &str = "agents.description";
const SYSTEM_PROMPT: &str = "agents.system_prompt";
const PERSONA: &str = "agents.persona";
const PROMPT_VERSION: &str = "agent_prompt_versions.prompt";
const OPERATION_RECEIPT: &str = "agent_operation_receipts.receipt";

fn agent_column_plans() -> Result<Vec<ColumnPlan>> {
    Ok(vec![
        ColumnPlan::text("agents", "description", "id", KeyKind::Text)?,
        ColumnPlan::text("agents", "system_prompt", "id", KeyKind::Text)?,
        ColumnPlan::text("agents", "persona", "id", KeyKind::Text)?,
        ColumnPlan::text("agent_prompt_versions", "prompt", "id", KeyKind::Text)?,
    ])
}

/// The `agents.db` content cipher, resolved once per process (every store of
/// this process seals under the same master key).
fn agents_cipher() -> Result<&'static ContentCipher> {
    static CIPHER: OnceLock<ContentCipher> = OnceLock::new();
    if let Some(cipher) = CIPHER.get() {
        return Ok(cipher);
    }
    let cipher = core_cipher(AGENTS_STORE)?;
    Ok(CIPHER.get_or_init(|| cipher))
}

fn receipt_context(agent_id: &str, operation_id: &str) -> ContentContext {
    ContentContext::new(OPERATION_RECEIPT)
        .with("agent_id", agent_id)
        .with("operation_id", operation_id)
}

/// Seal one optional agent column value for agent `id`.
fn seal_agent_value(
    seal: &StoreSeal,
    purpose: &str,
    id: &str,
    value: Option<&str>,
) -> Result<Option<String>> {
    seal.seal_opt(value, &ContentContext::for_id(purpose, id))
}

/// Seal a value while seeding built-ins (no store handle yet).
fn seal_seed_value(purpose: &str, id: &str, value: Option<&str>) -> Result<Option<String>> {
    let cipher = agents_cipher()?;
    value
        .map(|value| cipher.seal_text(value, &ContentContext::for_id(purpose, id)))
        .transpose()
}

/// Open one optional stored agent value.
fn open_agent_value(purpose: &str, id: &str, stored: Option<String>) -> Result<Option<String>> {
    let Some(stored) = stored else {
        return Ok(None);
    };
    Ok(Some(
        agents_cipher()?
            .open_text(&stored, &ContentContext::for_id(purpose, id))
            .with_context(|| format!("opening {purpose} of agent {id}"))?
            .value,
    ))
}

/// A sealed agent column that did not open, surfaced through a row mapper so
/// list reads can skip (and count) the row while get-by-id reads fail.
#[derive(Debug)]
struct UnreadableAgentValue(String);

impl std::fmt::Display for UnreadableAgentValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "sealed agent value does not open: {}", self.0)
    }
}

impl std::error::Error for UnreadableAgentValue {}

fn open_agent_column(
    row: &rusqlite::Row<'_>,
    index: usize,
    purpose: &str,
) -> rusqlite::Result<Option<String>> {
    let id: String = row.get(0)?;
    let stored: Option<String> = row.get(index)?;
    open_agent_value(purpose, &id, stored).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(UnreadableAgentValue(format!("{error:#}"))),
        )
    })
}

fn is_unreadable_agent_value(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::FromSqlConversionFailure(_, _, inner)
            if inner.is::<UnreadableAgentValue>()
    )
}

/// Seal legacy plaintext operation receipts and reseal receipts sealed under a
/// retired key. The table is keyed by `(agent_id, operation_id)`, so it is
/// walked here (every non-empty row, one transaction) instead of by the
/// single-key cursor migration. Compare-and-swap; idempotent. A receipt that
/// does not open is left as it is.
fn seal_legacy_operation_receipts(conn: &mut Connection, seal: &StoreSeal) -> Result<u64> {
    let transaction = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let rows = {
        let mut stmt = transaction.prepare(
            "SELECT agent_id, operation_id, receipt FROM agent_operation_receipts
             WHERE receipt != ''",
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
    for (agent_id, operation_id, receipt) in rows {
        let Ok(Some(value)) =
            seal.reseal_if_needed(&receipt, &receipt_context(&agent_id, &operation_id))
        else {
            continue;
        };
        sealed += transaction.execute(
            "UPDATE agent_operation_receipts SET receipt = ?1
             WHERE agent_id = ?2 AND operation_id = ?3 AND receipt = ?4",
            params![value, agent_id, operation_id, receipt],
        )? as u64;
    }
    transaction.commit()?;
    Ok(sealed)
}

fn source_history() -> SourceHistory {
    SourceHistory::new(crate::paths::files_path("source-history"))
}

fn source_history_path(agent_id: &str) -> String {
    let key = hex::encode(agent_id.as_bytes());
    format!("agents/{key}/system-prompt.md")
}

fn agent_config_version_meta(
    agent_id: &str,
    history_version: SourceHistoryVersion,
    record: &AgentRecord,
) -> AgentConfigVersionMeta {
    AgentConfigVersionMeta {
        agent_id: agent_id.to_owned(),
        created_at: history_version.created_at,
        id: history_version.id,
        label: history_version.label,
        name: record.name.clone(),
        version: record.version.clone(),
    }
}

fn serialize_agent_record(record: &AgentRecord) -> Result<String> {
    serde_json::to_string_pretty(record).context("serializing agent configuration")
}

fn agent_config_history_path(agent_id: &str) -> String {
    let key = hex::encode(agent_id.as_bytes());
    format!("agents/{key}/agent.json")
}

async fn checkpoint_source_history(
    relative_path: String,
    content: String,
    label: Option<String>,
) -> Result<SourceHistoryVersion> {
    let history = source_history();
    tokio::task::spawn_blocking(move || {
        history.checkpoint(&relative_path, &content, label.as_deref())
    })
    .await
    .context("agent source history checkpoint task panicked")?
    .context("checkpointing agent source history")
}

/// Record a source snapshot without turning an already-committed agent change
/// into a reported failure. The SQLite mutation is authoritative; Git is a
/// repairable audit projection and may be unavailable on a read-only or full
/// data volume.
async fn checkpoint_source_history_best_effort(
    relative_path: String,
    content: String,
    label: Option<String>,
) {
    if let Err(error) = checkpoint_source_history(relative_path.clone(), content, label).await {
        tracing::warn!(
            path = %relative_path,
            error = %error,
            "agent source-history checkpoint was not recorded"
        );
    }
}

async fn list_source_history(
    relative_path: String,
    limit: Option<usize>,
) -> Result<Vec<SourceHistoryVersion>> {
    let history = source_history();
    tokio::task::spawn_blocking(move || history.list(&relative_path, limit))
        .await
        .context("agent source history list task panicked")?
        .context("listing agent source history")
}

async fn read_source_history(relative_path: String, version_id: String) -> Result<Option<String>> {
    let history = source_history();
    tokio::task::spawn_blocking(move || history.read(&relative_path, &version_id))
        .await
        .context("agent source history read task panicked")?
        .context("reading agent source history")
}

fn is_git_version_id(version_id: &str) -> bool {
    (7..=64).contains(&version_id.len())
        && version_id
            .chars()
            .all(|character| character.is_ascii_hexdigit())
}

/// A durable operation acknowledgement committed with the exact agent update.
/// Consumers must authorize the current resource before disclosing this snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOperationReceipt {
    pub operation_id: String,
    pub payload: serde_json::Value,
    pub agent: AgentRecord,
}

fn read_operation_receipt(
    conn: &Connection,
    agent_id: &str,
    operation_id: &str,
) -> Result<Option<AgentOperationReceipt>> {
    let raw: Option<String> = conn.query_row(
        "SELECT receipt FROM agent_operation_receipts WHERE agent_id = ?1 AND operation_id = ?2",
        params![agent_id, operation_id], |row| row.get(0),
    ).optional()?;
    raw.map(|raw| parse_operation_receipt(agent_id, operation_id, &raw))
        .transpose()
}

fn parse_operation_receipt(
    agent_id: &str,
    operation_id: &str,
    raw: &str,
) -> Result<AgentOperationReceipt> {
    let raw = agents_cipher()?
        .open_text(raw, &receipt_context(agent_id, operation_id))
        .context("opening agent operation receipt")?
        .value;
    let receipt: AgentOperationReceipt =
        serde_json::from_str(&raw).context("parsing agent operation receipt")?;
    if receipt.agent.id != agent_id || receipt.operation_id != operation_id {
        anyhow::bail!("agent operation receipt identity mismatch");
    }
    Ok(receipt)
}

/// SQLite-backed store for agent config records. Cheap to clone (`Arc` inside).
#[derive(Clone)]
pub struct AgentStore {
    conn: Arc<Mutex<Connection>>,
    seal: StoreSeal,
}

static GLOBAL_AGENT_STORE: OnceLock<AgentStore> = OnceLock::new();

/// Publish the process-wide agent store for Core-owned runtimes that do not
/// carry `ServerState` (workflows, scheduler jobs, and trigger fan-out).
pub fn set_global(store: AgentStore) {
    let _ = GLOBAL_AGENT_STORE.set(store);
}

/// Return the process-wide agent store when Core has finished bootstrapping it.
pub fn global() -> Option<&'static AgentStore> {
    GLOBAL_AGENT_STORE.get()
}

impl AgentStore {
    /// Open (creating if needed) the agents DB under `<data dir>/db/agents.db`, run the
    /// schema migration, then idempotently seed the built-in registry agents.
    pub fn open(registry: &AcpAgentRegistry) -> Result<Self> {
        let path = db_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).context("creating the db dir for agents.db")?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening agents db at {}", path.display()))?;
        Self::open_connection(conn, Some(&path), registry)
    }

    /// Migrate the schema, seal legacy plaintext, then seed built-ins (sealed).
    fn open_connection(
        mut conn: Connection,
        path: Option<&std::path::Path>,
        registry: &AcpAgentRegistry,
    ) -> Result<Self> {
        Self::migrate(&conn)?;
        let seal = StoreSeal::prepare(
            &mut conn,
            path,
            agents_cipher()?.clone(),
            &agent_column_plans()?,
        )
        .context("sealing the agents store")?;
        if seal.writable() {
            if seal_legacy_operation_receipts(&mut conn, &seal)? > 0 {
                seal.finish(&conn, path);
            }
            Self::seed_built_ins(&conn, registry)?;
        }
        let conn = Arc::new(Mutex::new(conn));
        seal.defer_compaction(&conn, path);
        Ok(Self { conn, seal })
    }

    /// Isolated file-backed action store for approval handler regressions.
    #[cfg(test)]
    pub(crate) fn open_approval_test_file(path: &std::path::Path) -> Result<Self> {
        crate::crypto_host::install();
        let conn = Connection::open(path)?;
        Self::open_connection(conn, Some(path), &AcpAgentRegistry::new())
    }

    /// In-memory store, used by tests.
    #[cfg(test)]
    pub fn open_in_memory(registry: &AcpAgentRegistry) -> Result<Self> {
        crate::crypto_host::install();
        let conn = Connection::open_in_memory()?;
        Self::open_connection(conn, None, registry)
    }

    /// Agent rows list reads skipped because a sealed value did not open.
    pub fn unreadable_rows(&self) -> u64 {
        self.seal.unreadable()
    }

    /// Move the retired node-wide output-style selection onto every existing
    /// agent that has not chosen a profile yet.
    ///
    /// The old selector applied to every agent, so copying it to all existing
    /// records preserves the user's behavior while making the ownership explicit.
    /// The caller clears the legacy selection file after this succeeds; this method
    /// is therefore intentionally idempotent and never overwrites a profile an
    /// agent already owns (including an explicit JSON `null`).
    pub async fn migrate_legacy_output_style(&self, style_id: &str) -> Result<usize> {
        let style_id = style_id.trim();
        if style_id.is_empty() {
            return Ok(0);
        }

        let conn = self.conn.lock().await;
        let records = {
            let mut stmt = conn.prepare("SELECT id, persona FROM agents")?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })?;
            let records = rows.collect::<rusqlite::Result<Vec<_>>>()?;
            records
        };
        let now = chrono::Utc::now().to_rfc3339();
        let mut migrated = 0;

        for (id, raw_persona) in records {
            let Ok(raw_persona) = open_agent_value(PERSONA, &id, raw_persona) else {
                continue;
            };
            let mut persona = match raw_persona {
                None => serde_json::Map::new(),
                Some(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                    Ok(serde_json::Value::Object(object)) => object,
                    Ok(_) | Err(_) => continue,
                },
            };
            if persona.contains_key("output_style_id") {
                continue;
            }
            persona.insert(
                "output_style_id".to_owned(),
                serde_json::Value::String(style_id.to_owned()),
            );
            let serialized = serde_json::to_string(&serde_json::Value::Object(persona))?;
            let serialized = self
                .seal
                .seal(&serialized, &ContentContext::for_id(PERSONA, &id))?;
            conn.execute(
                "UPDATE agents SET persona = ?1, updated_at = ?2 WHERE id = ?3",
                params![serialized, now, id],
            )?;
            migrated += 1;
        }

        Ok(migrated)
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
                tools         TEXT NOT NULL DEFAULT '[\"__ryu_none__\"]',
                model         TEXT,
                engine        TEXT,
                built_in      INTEGER NOT NULL DEFAULT 0,
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL
            );",
        )
        .context("running agents schema migration (base table)")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_operation_receipts (
                agent_id TEXT NOT NULL,
                operation_id TEXT NOT NULL,
                receipt TEXT NOT NULL,
                acknowledged_at TEXT,
                PRIMARY KEY (agent_id, operation_id)
            );",
        )
        .context("creating agent operation receipts")?;
        let has_acknowledgement = {
            let mut columns = conn.prepare("PRAGMA table_info(agent_operation_receipts)")?;
            let names = columns
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            names.iter().any(|name| name == "acknowledged_at")
        };
        if !has_acknowledgement {
            conn.execute(
                "ALTER TABLE agent_operation_receipts ADD COLUMN acknowledged_at TEXT",
                [],
            )?;
        }

        // Step 1b: existing versions used an empty list or `*` as the implicit
        // default. Normalize those legacy rows exactly once. The marker table
        // keeps a later restart from rewriting a user who deliberately chose
        // the explicit wildcard after this migration ran.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_capability_migrations (
                name       TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            );",
        )
        .context("creating agent capability migration ledger")?;
        let normalized = conn.execute(
            "INSERT OR IGNORE INTO agent_capability_migrations (name, applied_at)
             VALUES (?1, ?2)",
            params![
                "least-privilege-mcp-defaults",
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        if normalized > 0 {
            conn.execute(
                "UPDATE agents
                 SET tools = ?1
                 WHERE tools IS NULL
                    OR trim(tools) IN ('', '[]', '[\"*\"]')",
                params![serde_json::to_string(&default_agent_tools())?],
            )?;
        }

        // Existing deny markers are explicit operator restrictions. They cannot
        // be distinguished from older defaults and must survive every restart.
        // Fresh built-in seeding independently supplies its deliberate wildcard.

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

        // Step 10: an explicit role/title for the agent identity. Keep the
        // existing persona.display_name slot separate: it is the voice the
        // agent uses when introducing itself, while this field is the compact
        // badge shown beside the human name across the product.
        match conn.execute_batch("ALTER TABLE agents ADD COLUMN title TEXT NOT NULL DEFAULT ''") {
            Ok(()) => {}
            Err(e) => {
                let msg = e.to_string();
                if !msg.contains("duplicate column") {
                    return Err(e).context("adding column: title");
                }
            }
        }

        // Step 11: lifecycle and safety posture. Existing rows are deliberately
        // active/autonomous so adding the feature cannot silently pause a user's
        // deployed agents or change their tool behavior. New rows choose trial
        // in `insert_with_id` and therefore never rely on the SQL default.
        for col_def in [
            "lifecycle_status TEXT NOT NULL DEFAULT 'active'",
            "safety_profile TEXT NOT NULL DEFAULT 'autonomous'",
        ] {
            match conn.execute_batch(&format!("ALTER TABLE agents ADD COLUMN {col_def}")) {
                Ok(()) => {}
                Err(e) => {
                    if !e.to_string().contains("duplicate column") {
                        return Err(e).context(format!("adding column: {col_def}"));
                    }
                }
            }
        }

        // Step 12: per-agent approval requirements. JSON array of tool ids;
        // defaults to `[]` so legacy agents keep their existing approval policy.
        match conn.execute_batch(
            "ALTER TABLE agents ADD COLUMN approval_tools TEXT NOT NULL DEFAULT '[]'",
        ) {
            Ok(()) => {}
            Err(e) => {
                if !e.to_string().contains("duplicate column") {
                    return Err(e).context("adding column: approval_tools");
                }
            }
        }

        // Step 13: legacy Prompt Studio history. Git-backed source history is now
        // canonical; keep this table readable so nodes can migrate snapshots that
        // predate the managed repository and older clients remain compatible.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_prompt_versions (
                id         TEXT PRIMARY KEY,
                agent_id   TEXT NOT NULL,
                prompt     TEXT NOT NULL,
                label      TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_agent_prompt_versions_agent
                ON agent_prompt_versions(agent_id, created_at DESC, id DESC);",
        )
        .context("creating agent prompt versions")?;

        // Step 14: whose accounts the agent works with. Existing rows become
        // `managed` with a NULL (unrestricted) allowlist, which is exactly the
        // behaviour every agent had before these columns existed.
        let mut identity_mode_added = false;
        for col_def in [
            "identity_mode TEXT NOT NULL DEFAULT 'managed'",
            "account_access TEXT",
        ] {
            match conn.execute_batch(&format!("ALTER TABLE agents ADD COLUMN {col_def}")) {
                Ok(()) => {
                    identity_mode_added |= col_def.starts_with("identity_mode ");
                }
                Err(e) => {
                    if !e.to_string().contains("duplicate column") {
                        return Err(e).context(format!("adding column: {col_def}"));
                    }
                }
            }
        }

        // Step 15: where an app agent's identity mode came from. `app_mode` is the
        // mode the app's manifest last set, so a later app version can tell the
        // user's own choice (a mode different from it) from the app's; a
        // `pending_mode` is a mode a newer app version asked for that Core would not
        // apply by itself. Only when the identity column was added in this same run
        // is every existing app agent's mode known to be untouched (the column
        // default, which no user could have chosen), so only then is it recorded as
        // the app's. An app agent that already had a mode gets its provenance at its
        // next reconcile, which takes the mode it has as the user's and changes
        // nothing ([`AgentStore::reconcile_app_identity`]).
        let had_app_identity: bool = conn
            .query_row(
                "SELECT EXISTS (SELECT 1 FROM sqlite_master
                                WHERE type = 'table' AND name = 'app_agent_identity')",
                [],
                |row| row.get(0),
            )
            .context("checking app agent identity table")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS app_agent_identity (
                agent_id     TEXT PRIMARY KEY,
                app_mode     TEXT NOT NULL,
                pending_mode TEXT
            );",
        )
        .context("creating app agent identity")?;
        if !had_app_identity && identity_mode_added {
            conn.execute(
                "INSERT OR IGNORE INTO app_agent_identity (agent_id, app_mode)
                 SELECT id, identity_mode FROM agents
                 WHERE substr(id, 1, length(?1)) = ?1 AND built_in = 0",
                params![APP_AGENT_ID_PREFIX],
            )
            .context("recording app agent identity")?;
        }

        // Published-agent installs are keyed separately from agent ids. The
        // idempotency key is client-controlled, so bind it to the server-verified
        // caller scope before it can select an existing agent or disclosure.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS published_agent_installs (
                idempotency_key TEXT NOT NULL,
                caller_user_id  TEXT NOT NULL DEFAULT '',
                caller_org_id   TEXT NOT NULL DEFAULT '',
                listing_id      TEXT NOT NULL DEFAULT '',
                agent_id        TEXT NOT NULL,
                disclosure      TEXT NOT NULL DEFAULT '{}',
                created_at      TEXT NOT NULL,
                PRIMARY KEY (idempotency_key, caller_user_id, caller_org_id)
            );",
        )
        .context("creating published agent install keys")?;

        // The original table used idempotency_key as its sole primary key. Rebuild
        // that legacy table once so the same client key can be used independently
        // by different verified callers. Legacy rows get an empty scope and can
        // never replay for a verified caller; an unbound local node retains its
        // existing single-principal behavior through the empty scope.
        let has_caller_scope = conn
            .prepare("PRAGMA table_info(published_agent_installs)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .iter()
            .any(|column| column == "caller_user_id");
        if !has_caller_scope {
            conn.execute_batch(
                "ALTER TABLE published_agent_installs
                 RENAME TO published_agent_installs_legacy;
                 CREATE TABLE published_agent_installs (
                    idempotency_key TEXT NOT NULL,
                    caller_user_id  TEXT NOT NULL DEFAULT '',
                    caller_org_id   TEXT NOT NULL DEFAULT '',
                    listing_id      TEXT NOT NULL DEFAULT '',
                    agent_id        TEXT NOT NULL,
                    disclosure      TEXT NOT NULL DEFAULT '{}',
                    created_at      TEXT NOT NULL,
                    PRIMARY KEY (idempotency_key, caller_user_id, caller_org_id)
                 );
                 INSERT INTO published_agent_installs
                    (idempotency_key, caller_user_id, caller_org_id, listing_id,
                     agent_id, disclosure, created_at)
                 SELECT idempotency_key, '', '', listing_id, agent_id, disclosure,
                        created_at
                 FROM published_agent_installs_legacy;
                 DROP TABLE published_agent_installs_legacy;",
            )
            .context("binding legacy published agent install keys")?;
        }
        match conn.execute_batch(
            "ALTER TABLE published_agent_installs
             ADD COLUMN listing_id TEXT NOT NULL DEFAULT ''",
        ) {
            Ok(()) => {}
            Err(e) => {
                if !e.to_string().contains("duplicate column") {
                    return Err(e).context("adding published agent install listing identity");
                }
            }
        }
        match conn.execute_batch(
            "ALTER TABLE published_agent_installs
             ADD COLUMN disclosure TEXT NOT NULL DEFAULT '{}'",
        ) {
            Ok(()) => {}
            Err(e) => {
                if !e.to_string().contains("duplicate column") {
                    return Err(e).context("adding published agent install disclosure");
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
    /// `ryu` flagship agent (and the bots that run on Ryu's engine, Jay Jr. and
    /// Patrol, see [`runs_on_ryu_engine`]) the engine is `acp:pi`, reflecting its
    /// Pi binding.
    fn seed_built_ins(conn: &Connection, registry: &AcpAgentRegistry) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        for entry in &registry.entries {
            let is_ryu_engine_bot = runs_on_ryu_engine(&entry.id);
            let is_jay_jr = jay_jr::runs_on_ryu_engine(&entry.id);
            let is_patrol = patrol::is_patrol(&entry.id);
            // The ryu agent's engine binding is acp:pi (the Pi entry), not "ryu"
            // itself. This makes the store row reflect the real engine so
            // resolve_binding returns the right engine for routing (AC4).
            let engine_id = if entry.id == "ryu" || is_ryu_engine_bot {
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
            // The flagship `ryu` agent and the bots on Ryu's engine (Jay Jr. and
            // Patrol) are installed by default; every other built-in is opt-in via
            // the agents catalog (onboarding step). Unlike `ryu`, those bots can be
            // removed again.
            let installed_flag: i32 = i32::from(entry.id == "ryu" || is_ryu_engine_bot);
            // The flagship `ryu` is seeded as a full orchestrator that may also
            // create agents (it runs the builder pane). Every other built-in
            // leaves both flags NULL = the code defaults (delegation on, creation
            // off). Seeded here — not only in the migration — because on a fresh
            // DB the migration's `UPDATE … WHERE id='ryu'` runs before this row
            // exists; the migration UPDATE covers the existing-DB upgrade path.
            let ryu_caps: Option<i64> = (entry.id == "ryu").then_some(1);
            let tools_json = if entry.id == "ryu" {
                serde_json::to_string(&vec![ALL_MCP_TOOLS.to_owned()])?
            } else if is_jay_jr {
                serde_json::to_string(&jay_jr::TOOLS)?
            } else if is_patrol {
                serde_json::to_string(&patrol::TOOLS)?
            } else {
                serde_json::to_string(&default_agent_tools())?
            };
            let inserted = conn.execute(
                "INSERT OR IGNORE INTO agents
                    (id, name, description, system_prompt, tools, model, engine, built_in,
                     chat_model, installed, orchestrator, can_create_agents,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, NULL, ?9, NULL, ?4, 1, ?5, ?6, ?8, ?8, ?7, ?7)",
                params![
                    entry.id,
                    entry.name,
                    seal_seed_value(DESCRIPTION, &entry.id, Some(entry.description.as_str()))?,
                    engine_id,
                    chat_model_json,
                    installed_flag,
                    now,
                    ryu_caps,
                    tools_json,
                ],
            )?;
            // Jay Jr. ships with its own instructions, title and photo. Written
            // only when the row is first created, so later edits survive restarts.
            if is_jay_jr && inserted > 0 {
                conn.execute(
                    "UPDATE agents SET system_prompt = ?1, title = ?2, persona = ?3 WHERE id = ?4",
                    params![
                        seal_seed_value(SYSTEM_PROMPT, &entry.id, Some(jay_jr::SYSTEM_PROMPT))?,
                        jay_jr::TITLE,
                        seal_seed_value(
                            PERSONA,
                            &entry.id,
                            serialize_slot(&Some(jay_jr::persona())).as_deref()
                        )?,
                        entry.id,
                    ],
                )
                .context("seeding Jay Jr. persona")?;
            }
            // Patrol ships with its own instructions, title and safety profile.
            // Written only when the row is first created, so later edits survive
            // restarts.
            if is_patrol && inserted > 0 {
                conn.execute(
                    "UPDATE agents SET system_prompt = ?1, title = ?2, safety_profile = ?3
                     WHERE id = ?4",
                    params![
                        seal_seed_value(SYSTEM_PROMPT, &entry.id, Some(patrol::SYSTEM_PROMPT))?,
                        patrol::TITLE,
                        patrol::SAFETY_PROFILE.as_str(),
                        entry.id,
                    ],
                )
                .context("seeding Patrol instructions")?;
            }
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
                    identity_profile_ids, orchestrator, can_create_agents, video_model, title,
                    lifecycle_status, safety_profile, approval_tools, identity_mode, account_access
             FROM agents ORDER BY built_in DESC, created_at ASC",
        )?;
        let mut records = Vec::new();
        let mut skipped = 0u64;
        for row in stmt.query_map([], row_to_record)? {
            match row {
                Ok(record) => records.push(record),
                Err(error) if is_unreadable_agent_value(&error) => skipped += 1,
                Err(error) => return Err(error.into()),
            }
        }
        self.seal.count_unreadable(skipped);
        Ok(records)
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
                        identity_profile_ids, orchestrator, can_create_agents, video_model, title,
                        lifecycle_status, safety_profile, approval_tools, identity_mode, account_access
                 FROM agents WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?;
        Ok(record)
    }

    /// Attach or detach one Space from an agent's persisted memory slot.
    ///
    /// This is deliberately a narrow mutation rather than a caller-facing
    /// `UpdateAgent` shortcut: the Spaces tool has a server-derived calling agent
    /// id, so it cannot target a different agent or replace unrelated memory
    /// settings. Locked agents remain immutable, and a no-op detach does not
    /// materialize a new memory slot.
    pub async fn set_space_access(
        &self,
        id: &str,
        space_id: &str,
        attached: bool,
    ) -> Result<Option<AgentRecord>> {
        // Keep the read-modify-write under the same store mutex as update(). A
        // separate get() followed by update() could serialize a stale full
        // record and erase a concurrent slot patch.
        let conn = self.conn.lock().await;
        let Some(record) = conn
            .query_row(
                "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                        created_at, updated_at,
                        chat_model, stt, tts, image_model, memory, persona, policy_ref,
                        version, locked, inference, composio_actions, skills,
                        identity_profile_ids, orchestrator, can_create_agents, video_model, title,
                        lifecycle_status, safety_profile, approval_tools, identity_mode, account_access
                 FROM agents WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?
        else {
            return Ok(None);
        };
        if record.locked {
            anyhow::bail!("cannot edit locked agent '{id}'");
        }
        let mut memory = record.memory.clone().unwrap_or_default();
        let was_attached = memory
            .space_ids
            .iter()
            .any(|candidate| candidate == space_id);
        if was_attached == attached {
            return Ok(Some(record));
        }
        if attached {
            memory.space_ids.push(space_id.to_owned());
        } else {
            memory.space_ids.retain(|candidate| candidate != space_id);
        }
        let memory = if memory.space_ids.is_empty()
            && memory.read_levels.is_empty()
            && !memory.write_enabled
        {
            None
        } else {
            Some(memory)
        };

        let now = chrono::Utc::now().to_rfc3339();
        let changed = conn.execute(
            "UPDATE agents SET memory = ?1, updated_at = ?2 WHERE id = ?3",
            params![serialize_slot(&memory), now, id],
        )?;
        if changed == 0 {
            return Ok(None);
        }
        let updated = conn
            .query_row(
                "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                    created_at, updated_at,
                    chat_model, stt, tts, image_model, memory, persona, policy_ref,
                    version, locked, inference, composio_actions, skills,
                    identity_profile_ids, orchestrator, can_create_agents, video_model, title,
                    lifecycle_status, safety_profile, approval_tools, identity_mode, account_access
             FROM agents WHERE id = ?1",
                params![id],
                row_to_record,
            )
            .optional()?;
        drop(conn);
        if let Some(record) = &updated {
            if let Ok(snapshot) = serialize_agent_record(record) {
                checkpoint_source_history_best_effort(
                    agent_config_history_path(id),
                    snapshot,
                    Some("Agent saved".to_owned()),
                )
                .await;
            }
        }
        Ok(updated)
    }

    pub async fn create(&self, input: CreateAgent) -> Result<AgentRecord> {
        let id = format!("agent_{}", uuid::Uuid::new_v4().simple());
        self.create_with_id(id, input).await
    }

    /// Materialize a published agent once for an install key. The key lookup,
    /// agent insert, and key insert share one SQLite transaction, so retries and
    /// concurrent requests cannot create two records.
    pub async fn create_published_idempotent(
        &self,
        listing_id: &str,
        idempotency_key: &str,
        caller_user_id: Option<&str>,
        caller_org_id: Option<&str>,
        input: CreateAgent,
        disclosure: AgentInstallDisclosure,
    ) -> Result<(AgentRecord, bool, AgentInstallDisclosure)> {
        let listing = listing_id.trim();
        if listing.is_empty() {
            anyhow::bail!("invalid published-agent listing id");
        }
        let key = idempotency_key.trim();
        if key.is_empty() || key.len() > 2048 {
            anyhow::bail!("invalid published-agent idempotency key");
        }
        let caller_user_id = caller_user_id.unwrap_or("");
        let caller_org_id = caller_org_id.unwrap_or("");

        let conn = self.conn.lock().await;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            let existing = conn
                .query_row(
                    "SELECT listing_id, agent_id, disclosure
                     FROM published_agent_installs
                     WHERE idempotency_key = ?1 AND caller_user_id = ?2 AND caller_org_id = ?3",
                    params![key, caller_user_id, caller_org_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((stored_listing, agent_id, stored_disclosure)) = existing {
                if stored_listing != listing {
                    anyhow::bail!(
                        "published-agent idempotency key already used for listing '{}', not '{}'",
                        stored_listing,
                        listing
                    );
                }
                let record = conn.query_row(
                    "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                            created_at, updated_at, chat_model, stt, tts, image_model, memory,
                            persona, policy_ref, version, locked, inference, composio_actions,
                            skills, identity_profile_ids, orchestrator, can_create_agents, video_model, title,
                            lifecycle_status, safety_profile, approval_tools, identity_mode, account_access
                     FROM agents WHERE id = ?1",
                    params![agent_id],
                    row_to_record,
                ).optional()?;
                if let Some(record) = record {
                    let stored_disclosure = serde_json::from_str(&stored_disclosure)
                        .context("decoding published agent install disclosure")?;
                    return Ok((record, true, stored_disclosure));
                }

                // Recover mappings left behind by older versions that deleted
                // the agent row without deleting its idempotency record.
                conn.execute(
                    "DELETE FROM published_agent_installs
                     WHERE idempotency_key = ?1 AND caller_user_id = ?2 AND caller_org_id = ?3",
                    params![key, caller_user_id, caller_org_id],
                )?;
            }

            let id = format!("agent_{}", uuid::Uuid::new_v4().simple());
            let record = Self::insert_with_id(&conn, &self.seal, id, input)?;
            conn.execute(
                "INSERT INTO published_agent_installs
                    (idempotency_key, caller_user_id, caller_org_id, listing_id,
                     agent_id, disclosure, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    key,
                    caller_user_id,
                    caller_org_id,
                    listing,
                    record.id,
                    serde_json::to_string(&disclosure)?,
                    chrono::Utc::now().to_rfc3339()
                ],
            )?;
            Ok((record, false, disclosure))
        })();
        match result {
            Ok(value) => {
                conn.execute_batch("COMMIT")?;
                drop(conn);
                if let Ok(snapshot) = serialize_agent_record(&value.0) {
                    checkpoint_source_history_best_effort(
                        agent_config_history_path(&value.0.id),
                        snapshot,
                        Some("Agent created".to_owned()),
                    )
                    .await;
                }
                Ok(value)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    /// Return a completed published-agent install without consulting the
    /// current catalog descriptor. Replays must use the disclosure captured at
    /// the original install, even if the listing has since been edited.
    pub async fn get_published_idempotent(
        &self,
        listing_id: &str,
        idempotency_key: &str,
        caller_user_id: Option<&str>,
        caller_org_id: Option<&str>,
    ) -> Result<Option<(AgentRecord, AgentInstallDisclosure)>> {
        let listing = listing_id.trim();
        if listing.is_empty() {
            anyhow::bail!("invalid published-agent listing id");
        }
        let key = idempotency_key.trim();
        if key.is_empty() || key.len() > 2048 {
            anyhow::bail!("invalid published-agent idempotency key");
        }
        let caller_user_id = caller_user_id.unwrap_or("");
        let caller_org_id = caller_org_id.unwrap_or("");

        let conn = self.conn.lock().await;
        let Some((stored_listing, agent_id, stored_disclosure)) = conn
            .query_row(
                "SELECT listing_id, agent_id, disclosure
                 FROM published_agent_installs
                 WHERE idempotency_key = ?1 AND caller_user_id = ?2 AND caller_org_id = ?3",
                params![key, caller_user_id, caller_org_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .optional()?
        else {
            return Ok(None);
        };
        if stored_listing != listing {
            anyhow::bail!(
                "published-agent idempotency key already used for listing '{}', not '{}'",
                stored_listing,
                listing
            );
        }
        let Some(record) = conn
            .query_row(
                "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                        created_at, updated_at, chat_model, stt, tts, image_model, memory,
                        persona, policy_ref, version, locked, inference, composio_actions,
                        skills, identity_profile_ids, orchestrator, can_create_agents, video_model, title,
                        lifecycle_status, safety_profile, approval_tools, identity_mode, account_access
                 FROM agents WHERE id = ?1",
                params![agent_id],
                row_to_record,
            )
            .optional()?
        else {
            return Ok(None);
        };
        let disclosure = serde_json::from_str(&stored_disclosure)
            .context("decoding published agent install disclosure")?;
        Ok(Some((record, disclosure)))
    }

    /// Create an agent with a caller-supplied `id` instead of a generated one.
    /// Used by the migrate-to-ryu endpoint to create the Ryu agent under a
    /// stable well-known id. Fails if a row with that id already exists.
    pub async fn create_with_id(&self, id: String, input: CreateAgent) -> Result<AgentRecord> {
        let conn = self.conn.lock().await;
        let record = Self::insert_with_id(&conn, &self.seal, id, input)?;
        drop(conn);
        match serde_json::to_string_pretty(&record) {
            Ok(snapshot) => {
                checkpoint_source_history_best_effort(
                    agent_config_history_path(&record.id),
                    snapshot,
                    Some("Agent created".to_owned()),
                )
                .await;
            }
            Err(error) => tracing::warn!(
                agent_id = %record.id,
                error = %error,
                "agent source-history snapshot could not be serialized"
            ),
        }
        Ok(record)
    }

    fn insert_with_id(
        conn: &Connection,
        seal: &StoreSeal,
        id: String,
        input: CreateAgent,
    ) -> Result<AgentRecord> {
        let input = input.with_capability_defaults();
        if let Some(memory) = &input.memory {
            memory.validate()?;
        }
        let now = chrono::Utc::now().to_rfc3339();
        let tools_json = serde_json::to_string(&input.tools).unwrap_or_else(|_| "[]".to_owned());
        let composio_json =
            serde_json::to_string(&input.composio_actions).unwrap_or_else(|_| "[]".to_owned());
        let skills_json = serde_json::to_string(&input.skills).unwrap_or_else(|_| "[]".to_owned());
        let identity_json =
            serde_json::to_string(&input.identity_profile_ids).unwrap_or_else(|_| "[]".to_owned());
        let approval_json =
            serde_json::to_string(&input.approval_tools).unwrap_or_else(|_| "[]".to_owned());
        let account_access = normalize_account_access(input.account_access);
        let account_access_json = account_access_to_sql(account_access.as_ref())?;

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

        conn.execute(
            "INSERT INTO agents
                (id, name, description, system_prompt, tools, model, engine, built_in,
                 chat_model, stt, tts, image_model, video_model, memory, persona, policy_ref,
                 inference, version, locked, composio_actions, skills,
                 identity_profile_ids, orchestrator, can_create_agents,
                 created_at, updated_at, title, lifecycle_status, safety_profile, approval_tools,
                 identity_mode, account_access)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0,
                     ?8, ?9, ?10, ?11, ?23, ?12, ?13, ?14,
                     ?15, ?16, 0, ?17, ?18,
                     ?19, ?21, ?22, ?20, ?20, ?24, ?25, ?26, ?27, ?28, ?29)",
            params![
                id,
                input.name,
                seal_agent_value(seal, DESCRIPTION, &id, input.description.as_deref())?,
                seal_agent_value(seal, SYSTEM_PROMPT, &id, input.system_prompt.as_deref())?,
                tools_json,
                input.model,
                input.engine,
                serialize_slot(&chat_model),
                serialize_slot(&input.stt),
                serialize_slot(&input.tts),
                serialize_slot(&input.image_model),
                serialize_slot(&input.memory),
                seal_agent_value(
                    seal,
                    PERSONA,
                    &id,
                    serialize_slot(&input.persona).as_deref()
                )?,
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
                input.title.trim().to_owned(),
                AgentLifecycleStatus::Trial.as_str(),
                input.safety_profile.as_str(),
                approval_json,
                input.identity_mode.as_str(),
                account_access_json,
            ],
        )?;
        Ok(AgentRecord {
            id,
            name: input.name,
            lifecycle_status: AgentLifecycleStatus::Trial,
            safety_profile: input.safety_profile,
            title: input.title.trim().to_owned(),
            description: input.description,
            system_prompt: input.system_prompt,
            tools: input.tools,
            approval_tools: input.approval_tools,
            identity_mode: input.identity_mode,
            account_access,
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
        self.update_internal(id, patch, None).await
    }

    pub async fn operation_receipt(
        &self,
        id: &str,
        operation_id: &str,
    ) -> Result<Option<AgentOperationReceipt>> {
        let conn = self.conn.lock().await;
        read_operation_receipt(&conn, id, operation_id)
    }

    /// Read bounded outstanding operations for one resource and exact namespace.
    pub async fn unacknowledged_operations(
        &self,
        id: &str,
        prefix: &str,
        limit: usize,
    ) -> Result<Vec<AgentOperationReceipt>> {
        let conn = self.conn.lock().await;
        let mut statement = conn.prepare(
            "SELECT operation_id, receipt FROM agent_operation_receipts
             WHERE agent_id = ?1 AND substr(operation_id, 1, length(?2)) = ?2
             AND acknowledged_at IS NULL ORDER BY rowid DESC LIMIT ?3",
        )?;
        let rows = statement.query_map(params![id, prefix, limit.clamp(1, 64) as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        rows.map(|row| {
            let (operation_id, raw) = row?;
            parse_operation_receipt(id, &operation_id, &raw)
        })
        .collect()
    }

    /// Mark a projection acknowledged without changing its committed snapshot.
    pub async fn acknowledge_operation(
        &self,
        receipt: &AgentOperationReceipt,
        at: &str,
    ) -> Result<()> {
        let conn = self.conn.lock().await;
        let stored = read_operation_receipt(&conn, &receipt.agent.id, &receipt.operation_id)?
            .context("agent operation receipt not found")?;
        if serde_json::to_value(&stored)? != serde_json::to_value(receipt)? {
            anyhow::bail!("agent operation receipt changed before acknowledgement");
        }
        conn.execute(
            "UPDATE agent_operation_receipts SET acknowledged_at = ?3
             WHERE agent_id = ?1 AND operation_id = ?2 AND acknowledged_at IS NULL",
            params![receipt.agent.id, receipt.operation_id, at],
        )?;
        Ok(())
    }

    /// Commit an operation acknowledgement in the same transaction as a guarded
    /// update. Repeating the identical operation never writes the row or history.
    pub async fn update_with_receipt(
        &self,
        id: &str,
        patch: UpdateAgent,
        operation_id: &str,
        payload: &serde_json::Value,
    ) -> Result<Option<AgentRecord>> {
        if operation_id.trim().is_empty() {
            anyhow::bail!("agent operation id must not be empty");
        }
        if patch.expected_updated_at.is_none() {
            anyhow::bail!("agent operation requires an expected revision");
        }
        self.update_internal(id, patch, Some((operation_id, payload)))
            .await
    }

    async fn update_internal(
        &self,
        id: &str,
        patch: UpdateAgent,
        operation: Option<(&str, &serde_json::Value)>,
    ) -> Result<Option<AgentRecord>> {
        let updated = {
            let mut connection = self.conn.lock().await;
            let transaction = connection.transaction()?;
            let conn = &transaction;
            if let Some((operation_id, payload)) = operation {
                if let Some(receipt) = read_operation_receipt(conn, id, operation_id)? {
                    if receipt.payload != *payload {
                        anyhow::bail!(
                            "agent operation id was already used with a different payload"
                        );
                    }
                    return Ok(Some(receipt.agent));
                }
            }
            let existing: Option<AgentRecord> = conn
                .query_row(
                    "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                            created_at, updated_at,
                            chat_model, stt, tts, image_model, memory, persona, policy_ref,
                            version, locked, inference, composio_actions, skills,
                            identity_profile_ids, orchestrator, can_create_agents, video_model, title,
                            lifecycle_status, safety_profile, approval_tools, identity_mode, account_access
                     FROM agents WHERE id = ?1",
                    params![id],
                    row_to_record,
                )
                .optional()?;
            let Some(mut record) = existing else {
                return Ok(None);
            };

            if let Some(expected) = patch.expected_updated_at.as_deref() {
                if record.updated_at.as_deref() != Some(expected) {
                    return Err(AgentUpdateConflict {
                        current_updated_at: record.updated_at.clone(),
                    }
                    .into());
                }
            }

            if let Some(next_status) = patch.lifecycle_status {
                if !record.lifecycle_status.can_transition_to(next_status) {
                    anyhow::bail!(
                        "invalid lifecycle transition for agent '{id}': {} -> {}",
                        record.lifecycle_status.as_str(),
                        next_status.as_str()
                    );
                }
            }

            // Locked agents are immutable: reject patch attempts UNLESS the patch
            // only unlocks the agent (i.e., the only field being set is `locked:
            // false`). This allows a user to unlock a locked agent without having
            // to bypass the lock. Any patch that edits content while the agent is
            // locked is rejected.
            let is_unlock_only = matches!(patch.locked, Some(false))
                && patch.name.is_none()
                && patch.title.is_none()
                && patch.description.is_none()
                && patch.system_prompt.is_none()
                && patch.tools.is_none()
                && patch.composio_actions.is_none()
                && patch.skills.is_none()
                && patch.identity_profile_ids.is_none()
                && patch.approval_tools.is_none()
                && patch.identity_mode.is_none()
                && !patch.dismiss_pending_identity_mode
                && patch.account_access.is_none()
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
            if let Some(lifecycle_status) = patch.lifecycle_status {
                record.lifecycle_status = lifecycle_status;
            }
            if let Some(safety_profile) = patch.safety_profile {
                record.safety_profile = safety_profile;
            }
            if let Some(title) = patch.title {
                record.title = title.trim().to_owned();
            }
            if patch.description.is_some() {
                record.description = patch.description;
            }
            if patch.system_prompt.is_some() {
                record.system_prompt = patch.system_prompt;
            }
            if let Some(tools) = patch.tools {
                record.tools = if tools.is_empty() {
                    default_agent_tools()
                } else {
                    tools
                };
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
            if let Some(approval_tools) = patch.approval_tools {
                record.approval_tools = approval_tools;
            }
            let requested_identity_mode = patch.identity_mode;
            if let Some(identity_mode) = patch.identity_mode {
                record.identity_mode = identity_mode;
            }
            if let Some(account_access) = patch.account_access {
                record.account_access = normalize_account_access(account_access);
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
                memory.validate()?;
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
            let approval_json =
                serde_json::to_string(&record.approval_tools).unwrap_or_else(|_| "[]".to_owned());
            let account_access_json = account_access_to_sql(record.account_access.as_ref())?;

            conn.execute(
                "UPDATE agents SET name = ?2, description = ?3, system_prompt = ?4,
                    tools = ?5, model = ?6, engine = ?7,
                    chat_model = ?8, stt = ?9, tts = ?10, image_model = ?11,
                    video_model = ?24,
                    memory = ?12, persona = ?13, policy_ref = ?14, inference = ?15,
                    version = ?16, locked = ?17, composio_actions = ?18, skills = ?19,
                    identity_profile_ids = ?20, orchestrator = ?22,
                    can_create_agents = ?23, updated_at = ?21, title = ?25,
                    lifecycle_status = ?26, safety_profile = ?27, approval_tools = ?28,
                    identity_mode = ?29, account_access = ?30
                 WHERE id = ?1",
                params![
                    id,
                    record.name,
                    seal_agent_value(&self.seal, DESCRIPTION, id, record.description.as_deref())?,
                    seal_agent_value(
                        &self.seal,
                        SYSTEM_PROMPT,
                        id,
                        record.system_prompt.as_deref()
                    )?,
                    tools_json,
                    record.model,
                    record.engine,
                    serialize_slot(&record.chat_model),
                    serialize_slot(&record.stt),
                    serialize_slot(&record.tts),
                    serialize_slot(&record.image_model),
                    serialize_slot(&record.memory),
                    seal_agent_value(
                        &self.seal,
                        PERSONA,
                        id,
                        serialize_slot(&record.persona).as_deref()
                    )?,
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
                    record.title,
                    record.lifecycle_status.as_str(),
                    record.safety_profile.as_str(),
                    approval_json,
                    record.identity_mode.as_str(),
                    account_access_json,
                ],
            )?;
            // Saving the mode an app update asked for accepts it; dismissing keeps
            // the current mode. Either way the app's request is settled, and a mode
            // that differs from it is the user's own choice from now on.
            if requested_identity_mode.is_some() || patch.dismiss_pending_identity_mode {
                if let Some(identity) = read_app_identity(conn, id)? {
                    if let Some(pending) = identity.pending_mode {
                        if patch.dismiss_pending_identity_mode
                            || requested_identity_mode == Some(pending)
                        {
                            write_app_identity(
                                conn,
                                id,
                                AppAgentIdentity {
                                    app_mode: pending,
                                    pending_mode: None,
                                },
                            )?;
                        }
                    }
                }
            }
            if let Some((operation_id, payload)) = operation {
                let receipt = AgentOperationReceipt {
                    operation_id: operation_id.to_owned(),
                    payload: payload.clone(),
                    agent: record.clone(),
                };
                conn.execute(
                    "INSERT INTO agent_operation_receipts (agent_id, operation_id, receipt) VALUES (?1, ?2, ?3)",
                    params![
                        id,
                        operation_id,
                        self.seal.seal(
                            &serde_json::to_string(&receipt)?,
                            &receipt_context(id, operation_id)
                        )?
                    ],
                )?;
            }
            transaction.commit()?;
            Some(record)
        };
        if let Some(record) = &updated {
            match serde_json::to_string_pretty(record) {
                Ok(snapshot) => {
                    checkpoint_source_history_best_effort(
                        agent_config_history_path(record.id.as_str()),
                        snapshot,
                        Some("Agent saved".to_owned()),
                    )
                    .await;
                }
                Err(error) => tracing::warn!(
                    agent_id = id,
                    error = %error,
                    "agent source-history snapshot could not be serialized"
                ),
            }
        }
        Ok(updated)
    }

    /// Snapshot the complete persisted agent definition as an immutable Git
    /// checkpoint. The live SQLite row remains authoritative; Git is the
    /// durable, inspectable history projection.
    pub async fn snapshot_config_version(
        &self,
        agent_id: &str,
        label: Option<&str>,
    ) -> Result<Option<AgentConfigVersionMeta>> {
        let Some(record) = self.get(agent_id).await? else {
            return Ok(None);
        };
        let source = serialize_agent_record(&record)?;
        let history_version = checkpoint_source_history(
            agent_config_history_path(agent_id),
            source,
            label.map(str::to_owned),
        )
        .await?;
        Ok(Some(agent_config_version_meta(
            agent_id,
            history_version,
            &record,
        )))
    }

    /// List complete agent-definition checkpoints, newest first. Invalid or
    /// unrelated source entries are ignored so one damaged history item cannot
    /// hide the rest of an agent's usable rollback points.
    pub async fn list_config_versions(
        &self,
        agent_id: &str,
    ) -> Result<Vec<AgentConfigVersionMeta>> {
        let path = agent_config_history_path(agent_id);
        let history_versions = list_source_history(path.clone(), None).await?;
        let mut versions = Vec::new();
        for history_version in history_versions {
            let Some(source) =
                read_source_history(path.clone(), history_version.id.clone()).await?
            else {
                continue;
            };
            let Ok(record) = serde_json::from_str::<AgentRecord>(&source) else {
                continue;
            };
            if record.id != agent_id {
                continue;
            }
            versions.push(agent_config_version_meta(
                agent_id,
                history_version,
                &record,
            ));
        }
        versions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(versions)
    }

    /// Load one complete agent-definition checkpoint. The source path is
    /// derived from the requested agent id and the embedded id is checked too,
    /// keeping a malformed or cross-agent history entry from being restored.
    pub async fn get_config_version(
        &self,
        agent_id: &str,
        version_id: &str,
    ) -> Result<Option<AgentConfigVersion>> {
        if !is_git_version_id(version_id) {
            return Ok(None);
        }
        let path = agent_config_history_path(agent_id);
        let Some(source) = read_source_history(path.clone(), version_id.to_owned()).await? else {
            return Ok(None);
        };
        let agent = serde_json::from_str::<AgentRecord>(&source)
            .context("decoding agent configuration version")?;
        if agent.id != agent_id {
            return Ok(None);
        }
        let history_version = list_source_history(path, Some(1000))
            .await?
            .into_iter()
            .find(|version| version.id == version_id);
        let Some(history_version) = history_version else {
            return Ok(None);
        };
        Ok(Some(AgentConfigVersion {
            agent_id: agent_id.to_owned(),
            created_at: history_version.created_at,
            id: history_version.id,
            label: history_version.label,
            name: agent.name.clone(),
            source,
            version: agent.version.clone(),
            agent,
        }))
    }

    /// Restore a complete agent definition. The current row is checkpointed as
    /// a named undo point first. Identity and install metadata stay attached to
    /// the live row; only the versioned definition fields are replaced.
    pub async fn restore_config_version(
        &self,
        agent_id: &str,
        version_id: &str,
    ) -> Result<Option<AgentRecord>> {
        let Some(version) = self.get_config_version(agent_id, version_id).await? else {
            return Ok(None);
        };
        let Some(current) = self.get(agent_id).await? else {
            return Ok(None);
        };
        if current.locked {
            anyhow::bail!("cannot restore a version on locked agent '{agent_id}'");
        }
        if current.built_in != version.agent.built_in {
            anyhow::bail!("agent version identity does not match '{agent_id}'");
        }
        if !current
            .lifecycle_status
            .can_transition_to(version.agent.lifecycle_status)
        {
            anyhow::bail!(
                "invalid lifecycle transition for agent '{agent_id}': {} -> {}",
                current.lifecycle_status.as_str(),
                version.agent.lifecycle_status.as_str()
            );
        }

        let before_source = serialize_agent_record(&current)?;
        checkpoint_source_history_best_effort(
            agent_config_history_path(agent_id),
            before_source,
            Some("Before restore".to_owned()),
        )
        .await;

        let mut restored = version.agent;
        // These fields identify the live row rather than its mutable
        // configuration and must never be taken from a historical payload.
        restored.id = current.id.clone();
        restored.built_in = current.built_in;
        restored.created_at = current.created_at.clone();
        restored.updated_at = Some(chrono::Utc::now().to_rfc3339());
        // Account access is a security boundary, not configuration history: a
        // snapshot taken before a restriction (or before these fields existed,
        // which reads as unrestricted) must never widen what the agent may use.
        // The UPDATE below leaves both columns untouched; change them explicitly.
        restored.identity_mode = current.identity_mode;
        restored.account_access = current.account_access.clone();
        let updated = {
            let conn = self.conn.lock().await;
            let tools_json =
                serde_json::to_string(&restored.tools).unwrap_or_else(|_| "[]".to_owned());
            let composio_json = serde_json::to_string(&restored.composio_actions)
                .unwrap_or_else(|_| "[]".to_owned());
            let skills_json =
                serde_json::to_string(&restored.skills).unwrap_or_else(|_| "[]".to_owned());
            let identity_json = serde_json::to_string(&restored.identity_profile_ids)
                .unwrap_or_else(|_| "[]".to_owned());
            let approval_json =
                serde_json::to_string(&restored.approval_tools).unwrap_or_else(|_| "[]".to_owned());
            let changed = conn.execute(
                "UPDATE agents SET name = ?2, description = ?3, system_prompt = ?4,
                    tools = ?5, model = ?6, engine = ?7,
                    chat_model = ?8, stt = ?9, tts = ?10, image_model = ?11,
                    video_model = ?24,
                    memory = ?12, persona = ?13, policy_ref = ?14, inference = ?15,
                    version = ?16, locked = ?17, composio_actions = ?18, skills = ?19,
                    identity_profile_ids = ?20, orchestrator = ?22,
                    can_create_agents = ?23, updated_at = ?21, title = ?25,
                    lifecycle_status = ?26, safety_profile = ?27, approval_tools = ?28
                 WHERE id = ?1",
                params![
                    agent_id,
                    &restored.name,
                    seal_agent_value(
                        &self.seal,
                        DESCRIPTION,
                        agent_id,
                        restored.description.as_deref()
                    )?,
                    seal_agent_value(
                        &self.seal,
                        SYSTEM_PROMPT,
                        agent_id,
                        restored.system_prompt.as_deref()
                    )?,
                    tools_json,
                    &restored.model,
                    &restored.engine,
                    serialize_slot(&restored.chat_model),
                    serialize_slot(&restored.stt),
                    serialize_slot(&restored.tts),
                    serialize_slot(&restored.image_model),
                    serialize_slot(&restored.memory),
                    seal_agent_value(
                        &self.seal,
                        PERSONA,
                        agent_id,
                        serialize_slot(&restored.persona).as_deref()
                    )?,
                    serialize_slot(&restored.policy_ref),
                    serialize_slot(&restored.inference),
                    &restored.version,
                    restored.locked as i64,
                    composio_json,
                    skills_json,
                    identity_json,
                    &restored.updated_at,
                    restored.orchestrator.map(i64::from),
                    restored.can_create_agents.map(i64::from),
                    serialize_slot(&restored.video_model),
                    &restored.title,
                    restored.lifecycle_status.as_str(),
                    restored.safety_profile.as_str(),
                    approval_json,
                ],
            )?;
            if changed == 0 {
                None
            } else {
                conn.query_row(
                    "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                        created_at, updated_at,
                        chat_model, stt, tts, image_model, memory, persona, policy_ref,
                        version, locked, inference, composio_actions, skills,
                        identity_profile_ids, orchestrator, can_create_agents, video_model, title,
                        lifecycle_status, safety_profile, approval_tools, identity_mode, account_access
                     FROM agents WHERE id = ?1",
                    params![agent_id],
                    row_to_record,
                )
                .optional()?
            }
        };
        if let Some(record) = &updated {
            if let Ok(source) = serialize_agent_record(record) {
                checkpoint_source_history_best_effort(
                    agent_config_history_path(agent_id),
                    source,
                    Some("Restore agent version".to_owned()),
                )
                .await;
            }
        }
        Ok(updated)
    }

    /// Snapshot an agent's current system prompt, or an editor draft supplied by
    /// Prompt Studio. Supplying the draft is important: the editor may have
    /// unsaved text while the user explicitly saves a version.
    pub async fn snapshot_prompt(
        &self,
        agent_id: &str,
        prompt: Option<&str>,
        label: Option<&str>,
    ) -> Result<Option<AgentPromptVersionMeta>> {
        let conn = self.conn.lock().await;
        let current: Option<Option<String>> = conn
            .query_row(
                "SELECT system_prompt FROM agents WHERE id = ?1",
                params![agent_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(stored_prompt) = current else {
            return Ok(None);
        };
        let stored_prompt =
            open_agent_value(SYSTEM_PROMPT, agent_id, stored_prompt)?.unwrap_or_default();
        let prompt = prompt.unwrap_or(&stored_prompt).to_owned();
        drop(conn);
        let version = checkpoint_source_history(
            source_history_path(agent_id),
            prompt,
            label.map(str::to_owned),
        )
        .await?;
        Ok(Some(AgentPromptVersionMeta {
            agent_id: agent_id.to_owned(),
            created_at: version.created_at,
            id: version.id,
            label: version.label,
        }))
    }

    /// List saved prompt versions, newest first.
    pub async fn list_prompt_versions(
        &self,
        agent_id: &str,
    ) -> Result<Vec<AgentPromptVersionMeta>> {
        let path = source_history_path(agent_id);
        let mut versions = list_source_history(path, None)
            .await?
            .into_iter()
            .map(|version| AgentPromptVersionMeta {
                agent_id: agent_id.to_owned(),
                created_at: version.created_at,
                id: version.id,
                label: version.label,
            })
            .collect::<Vec<_>>();
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, agent_id, label, created_at
             FROM agent_prompt_versions
             WHERE agent_id = ?1
             ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = stmt
            .query_map(params![agent_id], |row| {
                Ok(AgentPromptVersionMeta {
                    id: row.get(0)?,
                    agent_id: row.get(1)?,
                    label: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        versions.extend(rows);
        versions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
        Ok(versions)
    }

    /// Load one prompt version only when it belongs to `agent_id`.
    pub async fn get_prompt_version(
        &self,
        agent_id: &str,
        version_id: &str,
    ) -> Result<Option<AgentPromptVersion>> {
        if is_git_version_id(version_id) {
            let path = source_history_path(agent_id);
            if let Some(prompt) = read_source_history(path.clone(), version_id.to_owned()).await? {
                let metadata = list_source_history(path, Some(1000))
                    .await?
                    .into_iter()
                    .find(|version| version.id == version_id);
                return Ok(Some(AgentPromptVersion {
                    agent_id: agent_id.to_owned(),
                    created_at: metadata
                        .as_ref()
                        .map(|version| version.created_at)
                        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis()),
                    id: version_id.to_owned(),
                    label: metadata.and_then(|version| version.label),
                    prompt,
                }));
            }
        }
        let conn = self.conn.lock().await;
        let version = conn
            .query_row(
                "SELECT id, agent_id, prompt, label, created_at
                 FROM agent_prompt_versions
                 WHERE id = ?1 AND agent_id = ?2",
                params![version_id, agent_id],
                |row| {
                    Ok(AgentPromptVersion {
                        id: row.get(0)?,
                        agent_id: row.get(1)?,
                        prompt: row.get(2)?,
                        label: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()?;
        version
            .map(|mut version| {
                version.prompt =
                    open_agent_value(PROMPT_VERSION, &version.id, Some(version.prompt))?
                        .unwrap_or_default();
                Ok(version)
            })
            .transpose()
    }

    /// Restore a prompt version. The current prompt is recorded as a named undo
    /// point before the target is restored; unlabeled identical saves remain
    /// idempotent. Locked agents remain immutable.
    pub async fn restore_prompt_version(
        &self,
        agent_id: &str,
        version_id: &str,
    ) -> Result<Option<String>> {
        let Some(target_version) = self.get_prompt_version(agent_id, version_id).await? else {
            return Ok(None);
        };
        let (locked, current_prompt) = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT locked, system_prompt FROM agents WHERE id = ?1",
                params![agent_id],
                |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?
        }
        .ok_or_else(|| anyhow::anyhow!("agent '{agent_id}' not found"))?;
        let current_prompt =
            open_agent_value(SYSTEM_PROMPT, agent_id, current_prompt)?.unwrap_or_default();
        if locked {
            anyhow::bail!("cannot restore a prompt on locked agent '{agent_id}'");
        }
        checkpoint_source_history_best_effort(
            source_history_path(agent_id),
            current_prompt,
            Some("Before restore".to_owned()),
        )
        .await;
        let target_prompt = target_version.prompt.clone();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE agents SET system_prompt = ?1, updated_at = ?2 WHERE id = ?3",
                params![
                    self.seal.seal(
                        &target_prompt,
                        &ContentContext::for_id(SYSTEM_PROMPT, agent_id)
                    )?,
                    chrono::Utc::now().to_rfc3339(),
                    agent_id
                ],
            )?;
        }
        if let Some(record) = self.get(agent_id).await? {
            match serde_json::to_string_pretty(&record) {
                Ok(snapshot) => {
                    checkpoint_source_history_best_effort(
                        agent_config_history_path(agent_id),
                        snapshot,
                        Some("Agent saved".to_owned()),
                    )
                    .await;
                }
                Err(error) => tracing::warn!(
                    agent_id,
                    error = %error,
                    "agent source-history snapshot could not be serialized"
                ),
            }
        }
        checkpoint_source_history_best_effort(
            source_history_path(agent_id),
            target_prompt.clone(),
            Some("Restore prompt".to_owned()),
        )
        .await;
        Ok(Some(target_prompt))
    }

    /// Delete a custom agent. Returns `Ok(false)` if the row doesn't exist;
    /// errors if the target is a built-in agent (those stay selectable).
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
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
                    conn.execute(
                        "DELETE FROM agent_prompt_versions WHERE agent_id = ?1",
                        params![id],
                    )?;
                    conn.execute(
                        "DELETE FROM published_agent_installs WHERE agent_id = ?1",
                        params![id],
                    )?;
                    conn.execute(
                        "DELETE FROM app_agent_identity WHERE agent_id = ?1",
                        params![id],
                    )?;
                    Ok(true)
                }
            }
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

    /// Create the agent for an app's `kind: "agent"` Runnable, recording the
    /// mode the app set; when it already exists, reconcile its identity mode
    /// with the one the app now declares ([`Self::reconcile_app_identity`]).
    /// Nothing else on an existing agent is touched.
    pub async fn materialize_app_agent(
        &self,
        id: String,
        input: CreateAgent,
    ) -> Result<AppIdentityOutcome> {
        let declared = input.identity_mode;
        let created = {
            let mut connection = self.conn.lock().await;
            let transaction = connection.transaction()?;
            let exists: bool = transaction.query_row(
                "SELECT EXISTS (SELECT 1 FROM agents WHERE id = ?1)",
                params![id],
                |row| row.get(0),
            )?;
            if exists {
                None
            } else {
                let record = Self::insert_with_id(&transaction, &self.seal, id.clone(), input)?;
                write_app_identity(
                    &transaction,
                    &record.id,
                    AppAgentIdentity {
                        app_mode: declared,
                        pending_mode: None,
                    },
                )?;
                transaction.commit()?;
                Some(record)
            }
        };
        let Some(record) = created else {
            return Ok(self
                .reconcile_app_identity(&id, declared)
                .await?
                .unwrap_or(AppIdentityOutcome::Unchanged));
        };
        if let Ok(snapshot) = serde_json::to_string_pretty(&record) {
            checkpoint_source_history_best_effort(
                agent_config_history_path(&record.id),
                snapshot,
                Some("Agent created".to_owned()),
            )
            .await;
        }
        Ok(AppIdentityOutcome::Created)
    }

    /// Refresh the fields of a kept app agent that its app's manifest owns
    /// (name, system prompt, tools and model) from a new app version, as
    /// recreating the agent from that version would: a prompt or model the
    /// new version no longer sets is cleared. The chat slot's engine, and
    /// everything else on the agent (identity mode, account access, skills,
    /// approvals), is left as the user set it. A locked agent is not changed.
    /// Returns whether the agent was refreshed.
    pub async fn refresh_app_agent(&self, id: &str, input: &CreateAgent) -> Result<bool> {
        let refreshed = {
            let mut connection = self.conn.lock().await;
            let transaction = connection.transaction()?;
            let existing: Option<AgentRecord> = transaction
                .query_row(
                    "SELECT id, name, description, system_prompt, tools, model, engine, built_in,
                            created_at, updated_at,
                            chat_model, stt, tts, image_model, memory, persona, policy_ref,
                            version, locked, inference, composio_actions, skills,
                            identity_profile_ids, orchestrator, can_create_agents, video_model, title,
                            lifecycle_status, safety_profile, approval_tools, identity_mode, account_access
                     FROM agents WHERE id = ?1",
                    params![id],
                    row_to_record,
                )
                .optional()?;
            let Some(mut record) = existing else {
                return Ok(false);
            };
            if record.locked {
                return Ok(false);
            }
            record.name = input.name.clone();
            record.system_prompt = input.system_prompt.clone();
            record.tools = if input.tools.is_empty() {
                default_agent_tools()
            } else {
                input.tools.clone()
            };
            record.model = input.model.clone();
            let engine = record
                .chat_model
                .as_ref()
                .and_then(|slot| slot.engine.clone());
            record.chat_model = (input.model.is_some() || engine.is_some()).then(|| ModelSlot {
                model_id: input.model.clone(),
                engine,
            });
            let now = chrono::Utc::now().to_rfc3339();
            record.updated_at = Some(now.clone());
            let sealed_prompt = seal_agent_value(
                &self.seal,
                SYSTEM_PROMPT,
                id,
                record.system_prompt.as_deref(),
            )?;
            transaction.execute(
                "UPDATE agents SET name = ?2, system_prompt = ?3, tools = ?4, model = ?5,
                    chat_model = ?6, updated_at = ?7
                 WHERE id = ?1",
                params![
                    id,
                    record.name,
                    sealed_prompt,
                    serde_json::to_string(&record.tools).unwrap_or_else(|_| "[]".to_owned()),
                    record.model,
                    serialize_slot(&record.chat_model),
                    now,
                ],
            )?;
            transaction.commit()?;
            record
        };
        if let Ok(snapshot) = serde_json::to_string_pretty(&refreshed) {
            checkpoint_source_history_best_effort(
                agent_config_history_path(id),
                snapshot,
                Some("App updated agent".to_owned()),
            )
            .await;
        }
        Ok(true)
    }

    /// Bring an existing app agent's identity mode in line with the mode its
    /// app now declares, without ever widening it.
    ///
    /// The declared mode is applied only when it narrows the agent
    /// (see [`AgentIdentityMode::user_account_reach`]), the user has not chosen
    /// a mode of their own (the agent still has the mode the app last set), and
    /// the agent is not locked. Any other difference is recorded as
    /// [`AppAgentIdentity::pending_mode`] for the user to accept or dismiss.
    /// The account allowlist is never touched: it is always the user's.
    /// Returns `None` when the agent does not exist.
    pub async fn reconcile_app_identity(
        &self,
        id: &str,
        declared: AgentIdentityMode,
    ) -> Result<Option<AppIdentityOutcome>> {
        let narrowed = {
            let mut connection = self.conn.lock().await;
            let transaction = connection.transaction()?;
            let row: Option<(Option<String>, i64)> = transaction
                .query_row(
                    "SELECT identity_mode, locked FROM agents WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((stored_mode, locked)) = row else {
                return Ok(None);
            };
            // Read the mode the way `row_to_record` does, so a value that does
            // not parse is the most restrictive mode here too.
            let current = match stored_mode {
                None => AgentIdentityMode::Managed,
                Some(value) => value.parse().unwrap_or(AgentIdentityMode::Individual),
            };
            let previous = read_app_identity(&transaction, id)?;
            // An app agent with no record of its app's mode predates that
            // record and may carry a mode the user chose, which is never
            // replaced: record the declared mode as the app's and change
            // nothing, so the mode it has reads as the user's from now on.
            let known = previous.unwrap_or(AppAgentIdentity {
                app_mode: declared,
                pending_mode: None,
            });
            let (mode, identity, outcome) =
                decide_app_identity(current, known.app_mode, declared, locked != 0);
            if mode != current {
                transaction.execute(
                    "UPDATE agents SET identity_mode = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, mode.as_str(), chrono::Utc::now().to_rfc3339()],
                )?;
            }
            if previous != Some(identity) {
                write_app_identity(&transaction, id, identity)?;
            }
            transaction.commit()?;
            outcome
        };
        if matches!(narrowed, AppIdentityOutcome::Narrowed { .. }) {
            if let Some(record) = self.get(id).await? {
                if let Ok(snapshot) = serde_json::to_string_pretty(&record) {
                    checkpoint_source_history_best_effort(
                        agent_config_history_path(id),
                        snapshot,
                        Some("App narrowed identity mode".to_owned()),
                    )
                    .await;
                }
            }
        }
        Ok(Some(narrowed))
    }

    /// Where an app agent's identity mode came from, or `None` for an agent
    /// no app created.
    pub async fn app_identity(&self, id: &str) -> Result<Option<AppAgentIdentity>> {
        let conn = self.conn.lock().await;
        read_app_identity(&conn, id)
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
    /// Optional role/title shown beside the agent's human name.
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    /// Ryu plugin ids the template expects to be installed. This is a
    /// declaration only: published-agent installs report these ids and never
    /// enable a plugin or grant it capabilities implicitly.
    #[serde(default)]
    pub required_plugins: Vec<String>,
    /// Composio action allowlist (portable across export/import).
    #[serde(default)]
    pub composio_actions: Vec<String>,
    /// Skill allowlist (portable across export/import; empty = all enabled).
    #[serde(default)]
    pub skills: Vec<String>,
    /// Identity Vault profile binding (portable across export/import; empty = none).
    #[serde(default)]
    pub identity_profile_ids: Vec<String>,
    /// Whose accounts the agent works with. Portable; the node-local
    /// [`AgentRecord::account_access`] allowlist is deliberately not a template
    /// field, so an import always starts unrestricted for the installer to narrow.
    #[serde(default)]
    pub identity_mode: AgentIdentityMode,
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
    /// Portable schedules that should be materialized after the agent is
    /// imported. The scheduler owns the runtime job record; this field is only
    /// the validated template representation.
    #[serde(default)]
    pub schedules: Vec<AgentScheduleTemplate>,
}

/// One scheduler job embedded in an exported/imported agent template.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentScheduleTemplate {
    #[serde(default)]
    pub name: String,
    pub schedule: crate::scheduler::store::Schedule,
    pub instructions: String,
    #[serde(default = "default_schedule_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub require_approval: bool,
    /// Existing conversation to append to. Absent means each firing starts a
    /// new persistent conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

fn default_schedule_enabled() -> bool {
    true
}

impl AgentRecord {
    /// Build a portable [`AgentTemplate`] from this record for export.
    pub fn to_template(&self) -> AgentTemplate {
        AgentTemplate {
            kind: "agent".to_owned(),
            name: self.name.clone(),
            version: self.version.clone(),
            agent_config: AgentTemplateConfig {
                title: self.title.clone(),
                description: self.description.clone(),
                system_prompt: self.system_prompt.clone(),
                tools: self.tools.clone(),
                required_plugins: Vec::new(),
                composio_actions: self.composio_actions.clone(),
                skills: self.skills.clone(),
                identity_profile_ids: self.identity_profile_ids.clone(),
                identity_mode: self.identity_mode,
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
                schedules: Vec::new(),
            },
        }
    }
}

/// Upper bound on a third-party template's `system_prompt`, in bytes.
///
/// A published template is attacker-controlled text that lands in a SQLite row and
/// is prepended to every turn. 64 KiB is far above any real agent's instructions
/// and far below a payload worth storing, so an over-long prompt is truncated at a
/// char boundary rather than rejected — the install still succeeds and the user
/// sees what they got.
const UNTRUSTED_SYSTEM_PROMPT_MAX_BYTES: usize = 64 * 1024;

/// What a published agent template ASKED for and did not get.
///
/// [`AgentTemplate::sanitize_for_untrusted_install`] never installs a dependency;
/// it removes the privilege-bearing bindings and hands them back here so the
/// install response can list them for the user to grant deliberately, in the agent
/// editor, on their own identities/Spaces/connections. Every field is a
/// *declaration*, never a grant.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct AgentInstallDisclosure {
    /// Tool / MCP-server ids the template names in `tools`. Carried onto the
    /// installed agent (see the note in `sanitize_for_untrusted_install`) but
    /// listed here because the servers behind them may not be installed, and the
    /// user should see what the agent expects to reach.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    /// Plugin ids requested by the publisher and left for the installer to
    /// review/install explicitly.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_plugins: Vec<String>,
    /// Composio actions the template requested. **Removed** — their
    /// `composio.<slug>` ids are merged into the effective tool allowlist, so
    /// carrying them widens what the agent may call, against the installer's own
    /// connected accounts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub composio_actions: Vec<String>,
    /// Identity Vault profile ids the template requested. **Removed** — a bound
    /// profile is read as a credential under the gateway grant, so a template that
    /// named one would attach the installer's secrets to third-party instructions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub identity_profile_ids: Vec<String>,
    /// Space ids the template wanted injected into retrieval. **Removed** — these
    /// are the installer's Spaces, and the safe default (no Spaces) is what an
    /// unconfigured agent gets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub space_ids: Vec<String>,
    /// Memory scope levels the template requested. **Removed** — `"org"` is
    /// deliberately outside the default set, so a template asking for it would have
    /// bought organization-wide recall by being installed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub memory_read_levels: Vec<String>,
    /// True when the template asked to write memories. **Removed.**
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub memory_write_enabled: bool,
    /// Gateway policy id the template pointed at. **Removed** — a named policy
    /// governs firewall/DLP/budget, so a template must not get to pick one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_id: Option<String>,
    /// A remote avatar URL the template shipped. **Removed** — rendering it is an
    /// install-time beacon back to the publisher. Inline `data:` avatars (the
    /// convention custom avatars already use) are kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_avatar_url: Option<String>,
    /// True when the system prompt was truncated to
    /// [`UNTRUSTED_SYSTEM_PROMPT_MAX_BYTES`].
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub system_prompt_truncated: bool,
    /// ACP command bindings removed from a published template before it is
    /// persisted. Ordinary registry engine ids remain portable; `acp-exec:` is
    /// executable configuration and must be selected locally by the installer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub removed_engine_bindings: Vec<String>,
    /// Whose accounts the publisher set the agent to work with. **Kept** on the
    /// installed agent, unlike every field above: it names *whose* accounts,
    /// never *which*, and binds none. Listed so the installer sees the mode the
    /// agent arrives with and can narrow its access under Account access.
    /// `None` only on a disclosure stored before this field existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity_mode: Option<AgentIdentityMode>,
}

impl AgentTemplate {
    /// Strip everything a **third-party** template must not carry across an
    /// install, returning the safe template plus an [`AgentInstallDisclosure`] of
    /// what was removed.
    ///
    /// This is the trust boundary for the `agent` catalog kind, and it is applied
    /// ONLY there. `POST /api/agents/import` stays unsanitised on purpose: that
    /// path is the user re-importing their own export, and stripping their own
    /// identities/Spaces would break the round-trip the export exists for.
    ///
    /// What is kept, and why keeping it is not a grant:
    /// * `tools` — a *narrowing* declaration. Runtime enforcement applies the
    ///   persisted list, with the operator env-backed
    ///   [`crate::sidecar::adapters::acp::AcpAgentRegistry::allowlist_for`]
    ///   override taking precedence. The `*` marker keeps the imported card live
    ///   as tools are added; a non-empty list remains a narrowing declaration.
    /// * `skills` — a non-empty list only narrows (it intersects with the
    ///   globally-enabled skills and never re-activates a disabled one), and empty
    ///   is what every locally-created agent gets.
    /// * the model slots — id + provider strings with no URL field, so they select
    ///   among engines the installer already configured and cannot redirect a turn
    ///   to a publisher-controlled endpoint.
    /// * `identity_mode` — it names *whose* accounts the agent works with, never
    ///   *which*: no mode binds an account, and `managed` is what every
    ///   locally-created agent gets.
    ///
    /// Two grants need no stripping because the template cannot express them:
    /// `AgentRecord::approval_tools` (Layer A auto-approve) is not a template
    /// field and [`CreateAgent`] cannot set it, and `orchestrator` /
    /// `can_create_agents` are already dropped by [`Self::into_create_agent`].
    /// There is no executable code in a template at all — no hook bodies, no
    /// `mcp_servers` block — and none should be added: the manifest/plugin path
    /// with its signature gate is where executable third-party content belongs.
    pub fn sanitize_for_untrusted_install(mut self) -> (Self, AgentInstallDisclosure) {
        let cfg = &mut self.agent_config;
        let mut disclosure = AgentInstallDisclosure {
            tools: cfg.tools.clone(),
            required_plugins: cfg.required_plugins.clone(),
            composio_actions: std::mem::take(&mut cfg.composio_actions),
            identity_profile_ids: std::mem::take(&mut cfg.identity_profile_ids),
            identity_mode: Some(cfg.identity_mode),
            ..Default::default()
        };

        // The whole memory slot goes: Spaces, scope levels and the write bit are
        // all bindings onto the INSTALLER's data, and `None` is the safe default.
        if let Some(memory) = cfg.memory.take() {
            disclosure.space_ids = memory.space_ids;
            disclosure.memory_read_levels = memory.read_levels;
            disclosure.memory_write_enabled = memory.write_enabled;
        }
        if let Some(policy) = cfg.policy_ref.take() {
            disclosure.policy_id = policy.policy_id;
        }
        // Persona is presentation and is kept, minus a remote avatar fetch.
        if let Some(persona) = cfg.persona.as_mut() {
            if let Some(url) = persona.avatar_url.take() {
                if url.starts_with("data:") {
                    persona.avatar_url = Some(url);
                } else {
                    disclosure.remote_avatar_url = Some(url);
                }
            }
        }
        if let Some(prompt) = cfg.system_prompt.as_mut() {
            if prompt.len() > UNTRUSTED_SYSTEM_PROMPT_MAX_BYTES {
                let mut cut = UNTRUSTED_SYSTEM_PROMPT_MAX_BYTES;
                while cut > 0 && !prompt.is_char_boundary(cut) {
                    cut -= 1;
                }
                prompt.truncate(cut);
                disclosure.system_prompt_truncated = true;
            }
        }
        let mut strip_engine = |engine: &mut Option<String>| {
            let Some(value) = engine.clone() else {
                return;
            };
            if value.trim_start().starts_with("acp-exec:") {
                disclosure.removed_engine_bindings.push(value);
                *engine = None;
            }
        };
        strip_engine(&mut cfg.engine);
        if let Some(chat_model) = cfg.chat_model.as_mut() {
            strip_engine(&mut chat_model.engine);
        }
        // A schedule's conversation id is a binding onto an existing thread on
        // the INSTALLER's node; a third-party schedule always starts its own.
        for schedule in &mut cfg.schedules {
            schedule.conversation_id = None;
        }
        (self, disclosure)
    }

    /// Convert this template into a [`CreateAgent`] input.
    /// The imported agent is always unlocked and gets a fresh server-assigned id.
    pub fn into_create_agent(self) -> CreateAgent {
        CreateAgent {
            name: self.name,
            safety_profile: AgentSafetyProfile::ReadOnly,
            title: self.agent_config.title,
            description: self.agent_config.description,
            system_prompt: self.agent_config.system_prompt,
            tools: self.agent_config.tools,
            composio_actions: self.agent_config.composio_actions,
            skills: self.agent_config.skills,
            identity_profile_ids: self.agent_config.identity_profile_ids,
            // Approval requirements are intentionally not part of the portable
            // template surface; importing a template must not smuggle policy.
            approval_tools: vec![],
            identity_mode: self.agent_config.identity_mode,
            // The account allowlist names the exporting node's accounts, so it is
            // never portable; the installer narrows access on their own node.
            account_access: None,
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

/// Trim account keys and drop blanks and duplicates (first occurrence wins).
/// `None` (unrestricted) stays `None`; it is never turned into a list or back.
fn normalize_account_access(access: Option<Vec<String>>) -> Option<Vec<String>> {
    access.map(|keys| {
        let mut seen = std::collections::HashSet::new();
        keys.into_iter()
            .map(|key| key.trim().to_owned())
            .filter(|key| !key.is_empty() && seen.insert(key.clone()))
            .collect()
    })
}

/// SQL value for the `account_access` column: NULL for unrestricted, a JSON
/// array otherwise. Serialisation errors propagate instead of falling back to
/// NULL, which would silently widen a restricted agent.
fn account_access_to_sql(access: Option<&Vec<String>>) -> Result<Option<String>> {
    access
        .map(|keys| serde_json::to_string(keys).context("serializing agent account access"))
        .transpose()
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
    // Column 26 is the optional role/title. The migration back-fills legacy
    // rows with an empty string, and the optional read keeps older test rows
    // fail-soft while they are being migrated.
    let title = row
        .get::<_, Option<String>>(26)
        .ok()
        .flatten()
        .unwrap_or_default();
    // Column 27 is the lifecycle status. Legacy SELECTs/databases fail soft to
    // active so a partially upgraded node never pauses an existing agent.
    let lifecycle_status = row
        .get::<_, Option<String>>(27)
        .ok()
        .flatten()
        .and_then(|value| value.parse().ok())
        .unwrap_or_default();
    // Column 28 is the saved safety profile. Legacy rows remain autonomous for
    // backwards-compatible behavior; trial still forces read-only at runtime.
    let safety_profile = row
        .get::<_, Option<String>>(28)
        .ok()
        .flatten()
        .and_then(|value| value.parse().ok())
        .unwrap_or_default();
    // Column 29 is the per-agent approval-tool list. Legacy SELECTs/databases
    // fail soft to no additional approval requirements.
    let approval_tools = row
        .get::<_, Option<String>>(29)
        .ok()
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    // Column 30 is the identity mode. A missing column or NULL is a legacy row
    // and reads as `managed` (today's behaviour). A value that does not parse
    // fails closed to `individual`, which never touches the user's accounts.
    let identity_mode = match row.get::<_, Option<String>>(30).ok().flatten() {
        None => AgentIdentityMode::Managed,
        Some(value) => value.parse().unwrap_or(AgentIdentityMode::Individual),
    };
    // Column 31 is the account allowlist. NULL (or a legacy SELECT without the
    // column) is unrestricted. A stored value that does not parse fails closed
    // to an empty allowlist rather than silently becoming unrestricted.
    let account_access = row
        .get::<_, Option<String>>(31)
        .ok()
        .flatten()
        .map(|s| serde_json::from_str::<Vec<String>>(&s).unwrap_or_default());
    Ok(AgentRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        lifecycle_status,
        safety_profile,
        title,
        description: open_agent_column(row, 2, DESCRIPTION)?,
        system_prompt: open_agent_column(row, 3, SYSTEM_PROMPT)?,
        tools,
        approval_tools,
        identity_mode,
        account_access,
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
        persona: parse_slot(open_agent_column(row, 15, PERSONA)?),
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
mod tests;
