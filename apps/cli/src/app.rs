use std::collections::HashMap;
use std::time::Instant;

use ratatui::layout::Rect;
use serde::{Deserialize, Serialize};

use crate::chat::ChatState;

// ── Mouse click support ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)]
pub enum HintAction {
    Quit,
    SwitchTab,
    NavUp,
    NavDown,
    Send,
    StartSidecar,
    StopSidecar,
    RestartSidecar,
    StartAll,
    StopAll,
    Install,
    Uninstall,
    Setup,
    Refresh,
    Login,
    Logout,
    PrevStep,
    NextStep,
    Pick,
    Dashboard,
    InstallDeps,
    ScrollUp,
    ScrollDown,
    NodePicker,
}

#[derive(Default)]
pub struct ClickRegions {
    pub sidebar_tabs: Vec<(Rect, SidebarTab)>,
    pub sidebar_user_area: Option<Rect>,
    pub service_list_area: Option<Rect>,
    pub service_list_top_y: u16,
    pub chat_messages_area: Option<Rect>,
    pub chat_composer_area: Option<Rect>,
    pub hint_buttons: Vec<(Rect, HintAction)>,
    pub wizard_steps: Vec<(Rect, usize)>,
    pub wizard_list_area: Option<Rect>,
    pub wizard_list_top_y: u16,
    pub account_login_area: Option<Rect>,
    pub account_refresh_area: Option<Rect>,
    pub account_logout_area: Option<Rect>,
    pub agent_list_area: Option<Rect>,
    pub agent_list_top_y: u16,
}

impl ClickRegions {
    pub fn clear(&mut self) {
        self.sidebar_tabs.clear();
        self.sidebar_user_area = None;
        self.service_list_area = None;
        self.service_list_top_y = 0;
        self.chat_messages_area = None;
        self.chat_composer_area = None;
        self.hint_buttons.clear();
        self.wizard_steps.clear();
        self.wizard_list_area = None;
        self.wizard_list_top_y = 0;
        self.account_login_area = None;
        self.account_refresh_area = None;
        self.account_logout_area = None;
        self.agent_list_area = None;
        self.agent_list_top_y = 0;
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RemoteCatalogItem {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub category: String,
    pub deprecated: bool,
    pub recommended: bool,
    pub latest_version: Option<String>,
    pub installed_version: Option<String>,
    pub install_state: String,
}

pub async fn fetch_catalog(api_url: &str, token: Option<&str>) -> anyhow::Result<Vec<RemoteCatalogItem>> {
    let client = reqwest::Client::new();
    let mut req = client.get(format!("{api_url}/api/catalog"));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let items: Vec<RemoteCatalogItem> = serde_json::from_value(json["sidecars"].clone())?;
    Ok(items)
}

/// A workflow as Core defines it, returned by `GET /workflows`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// Engine info as returned by `GET /api/engines`.
/// All fields come from Core — none are defined or defaulted client-side.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EngineInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Whether the engine binary is installed on this machine.
    #[serde(default)]
    pub installed: Option<bool>,
    #[serde(default)]
    pub install_hint: Option<String>,
    /// Whether this engine is the currently active local engine.
    /// Populated client-side after merging with `GET /api/engine/active`.
    #[serde(skip)]
    pub active: bool,
}

/// Active-engine status from `GET /api/engine/active`.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct EngineActiveInfo {
    /// Name of the currently selected local engine (if any).
    pub active: Option<String>,
    /// Whether the active engine's process is currently running.
    #[serde(default)]
    pub running: bool,
    /// Names of local engines that are installed and available to swap to.
    #[serde(default)]
    pub available: Vec<String>,
}

/// A scheduled job as returned by `GET /heartbeat/jobs`.
/// Only the fields the CLI surfaces — extra fields are ignored by serde.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ScheduledJobInfo {
    pub id: String,
    pub name: String,
    /// Human-readable schedule expression (e.g. "0 */6 * * *" or "every 1h").
    #[serde(default)]
    pub schedule: Option<serde_json::Value>,
    /// True when the job is not paused.
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_outcome: Option<String>,
}

fn default_true() -> bool {
    true
}

/// An agent as Core defines it, returned by `GET /api/agents`. The engine
/// binding is decided by Core (never the client), so the CLI only ever displays
/// what Core sends back.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Engine this agent is bound to, as resolved by Core.
    #[serde(default)]
    pub engine: Option<String>,
    /// Transport backing the agent: "acp" or "openai_compat".
    #[serde(default)]
    pub transport: Option<String>,
    #[serde(default)]
    pub installed: Option<bool>,
    /// Chat-model binding for this agent.
    #[serde(default)]
    pub model: Option<String>,
    /// Whether this agent routes through the gateway (false = bypass).
    #[serde(default)]
    pub gateway_bypass: Option<bool>,
}

/// Full agent record from `GET /api/agents/:id`, including tools list.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AgentDetail {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub built_in: Option<bool>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub locked: Option<bool>,
}

/// Fetch the full record for a single agent from `GET /api/agents/:id`.
pub async fn fetch_agent_detail(
    api_url: &str,
    token: Option<&str>,
    id: &str,
) -> anyhow::Result<AgentDetail> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut req = client.get(format!("{api_url}/api/agents/{id}"));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let detail: AgentDetail = serde_json::from_value(json["agent"].clone())?;
    Ok(detail)
}

/// Fetch the agents Core has configured. Selection always round-trips through
/// Core: the CLI never defines agents client-side.
pub async fn fetch_agents(api_url: &str, token: Option<&str>) -> anyhow::Result<Vec<Agent>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut req = client.get(format!("{api_url}/api/agents"));
    if let Some(t) = token {
        req = req.header("Authorization", format!("Bearer {t}"));
    }
    let resp = req.send().await?.error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    let agents: Vec<Agent> = serde_json::from_value(json["agents"].clone())?;
    Ok(agents)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Category {
    Dependency,
    Provider,
    Tool,
    Agent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "state")]
pub enum InstallState {
    NotInstalled,
    Installing { started_at: String },
    Installed { version: String, installed_at: String },
    Failed { error: String, failed_at: String },
}

impl Default for InstallState {
    fn default() -> Self {
        Self::NotInstalled
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarInfo {
    pub name: String,
    pub description: String,
    pub installed: bool,
    pub category: Category,
    pub selected: bool,
    /// False when this sidecar cannot be installed on the current OS/arch.
    pub supported: bool,
}

/// A space as returned by Core's `GET /api/spaces`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct Space {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub document_count: Option<u64>,
}

/// A document within a space, from `GET /api/spaces/:id/documents`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SpaceDocument {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// A conversation summary as returned by Core's `GET /api/conversations`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct ConversationSummary {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub message_count: Option<u64>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Gateway status as returned by Core's `GET /api/gateway/status`.
/// All fields come from the response; none are hardcoded client-side.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct GatewayStatus {
    /// Whether the gateway process answered a healthy /health check.
    pub reachable: bool,
    /// URL the gateway is listening on (from Core config, not hardcoded).
    pub url: String,
    /// Health payload from the gateway's /health endpoint (if reachable).
    #[serde(default)]
    pub health: Option<serde_json::Value>,
    /// Metrics payload from the gateway's /metrics endpoint (if reachable).
    #[serde(default)]
    pub metrics: Option<serde_json::Value>,
    /// Effective on-disk config (always present; read from gateway.toml).
    #[serde(default)]
    pub effective_config: Option<serde_json::Value>,
}

/// Ephemeral state of a `/btw` side question (Claude-Code-style). The
/// question/answer live here only while the overlay is open and are never added
/// to `ChatState::messages` — they don't enter the conversation history.
#[derive(Default)]
pub struct BtwOverlay {
    /// Whether the side-answer overlay is shown.
    pub open: bool,
    /// The side question being answered.
    pub question: String,
    /// The answer once it arrives (Markdown rendered as plain text).
    pub answer: Option<String>,
    /// Error message when the side question failed.
    pub error: Option<String>,
    /// True while the answer is in flight.
    pub loading: bool,
    /// Vertical scroll offset into the answer.
    pub scroll: u16,
}

/// Hard cap on the client-driven goal continuation loop (matches the desktop's
/// `MAX_GOAL_TURNS`): after this many judged turns the loop stops regardless.
pub const MAX_GOAL_TURNS: u32 = 25;

/// State of an active `/goal` (a persistent completion condition judged each
/// turn by a separate model, Claude-Code-style). Core owns the goal + judge
/// primitive; this drives the continuation loop client-side.
#[derive(Default)]
pub struct ChatGoal {
    /// The completion condition. `None` = no active goal.
    pub condition: Option<String>,
    /// The judge's most recent reason.
    pub last_reason: Option<String>,
    /// Turns the judge has evaluated (server-reported).
    pub turns: u32,
    /// Client-side count of auto-continuations this goal has triggered. A local
    /// backstop independent of the server's `turns` so a misbehaving judge
    /// (e.g. always `turns:0, stop:false`) can't drive an unbounded send loop.
    pub loop_count: u32,
    /// Set once the judge decides the condition is met.
    pub achieved: bool,
    /// True while a judge call is in flight.
    pub judging: bool,
    /// When the goal was set (drives the elapsed timer).
    pub started_at: Option<Instant>,
    /// Last judge error, if any.
    pub error: Option<String>,
}

/// Ephemeral result of a double-check review (shown in a dismissible overlay,
/// never persisted — Core is stateless here).
#[derive(Default)]
pub struct DoubleCheckOverlay {
    pub open: bool,
    pub loading: bool,
    /// `Some(true)` = no issues, `Some(false)` = a problem was flagged.
    pub ok: Option<bool>,
    pub critique: String,
    pub model: String,
    pub error: Option<String>,
    pub scroll: u16,
}

/// One run/session row for a conversation (Core's `GET .../sessions`).
#[derive(Debug, Clone, Default)]
pub struct SessionRow {
    pub id: String,
    pub status: String,
    pub created_at: String,
    pub branch: String,
}

/// Read-only overlay listing a conversation's runs.
#[derive(Default)]
pub struct SessionsOverlay {
    pub open: bool,
    pub loading: bool,
    pub rows: Vec<SessionRow>,
    pub index: usize,
    pub error: Option<String>,
}

/// One row in a generic data-driven list tab (Models / Skills / Tools /
/// Monitors / Teams / Meetings / Recipes). Leniently extracted from whatever
/// Core's list endpoint returns, so a row carries display + an `id` for actions.
#[derive(Debug, Clone, Default)]
pub struct ListRow {
    /// Primary label (name / title / slug).
    pub title: String,
    /// Secondary detail (url / description / members / engine …).
    pub subtitle: String,
    /// A short status/badge (installed / last_status / coordination …).
    pub badge: String,
    /// Stable id used for row actions (run / install / open).
    pub id: String,
}

/// Fuzzy command palette (Ctrl+P) — the TUI analog of the desktop's Cmd+K. The
/// primary discovery/jump surface so every tab + key action is reachable
/// without a crowded sidebar.
#[derive(Default)]
pub struct CommandPalette {
    pub open: bool,
    pub query: String,
    pub index: usize,
}

/// Shared state for every data-driven list tab. One per tab, keyed in
/// [`App::feature_tabs`]. Keeps the per-tab code to a single fetch + render.
#[derive(Default)]
pub struct SimpleListTab {
    pub rows: Vec<ListRow>,
    pub index: usize,
    pub loading: bool,
    pub loaded: bool,
    pub error: Option<String>,
    /// Transient status line (e.g. "running monitor…", "installed ✓").
    pub notice: Option<String>,
}

pub struct App {
    pub dependencies: Vec<SidecarInfo>,
    pub providers: Vec<SidecarInfo>,
    pub tools: Vec<SidecarInfo>,
    pub agents: Vec<SidecarInfo>,
    pub statuses: Vec<SidecarStatus>,
    pub install_states: HashMap<String, InstallState>,
    pub list_state: ratatui::widgets::ListState,
    pub api_url: String,
    pub current_screen: Screen,
    pub install_results: Vec<(String, bool)>, // (name, queued_ok)
    pub last_poll: Instant,
    /// Incremented every ~100 ms draw tick; drives spinner animation.
    pub animation_tick: u64,
    /// Set the moment we enter the Complete screen; drives elapsed-time display.
    pub install_started_at: Option<Instant>,
    /// True while dependency installation is in progress.
    pub deps_installing: bool,
    /// Set the moment deps installation starts; drives elapsed-time display on deps screen.
    pub deps_install_started: Option<Instant>,
    /// Whether the last poll to core succeeded.
    pub core_connected: bool,
    /// Chat screen state.
    pub chat: ChatState,
    /// Cached auth info, refreshed periodically.
    pub auth_info: Option<AuthInfo>,
    /// True while the browser OAuth login flow is in progress.
    pub login_pending: bool,
    /// Which sidebar tab is active on the main screen.
    pub active_tab: SidebarTab,
    /// Clickable regions populated each frame by the UI renderer.
    pub click_regions: ClickRegions,
    /// Current mouse cursor position for hover effects.
    pub mouse_col: u16,
    pub mouse_row: u16,
    /// Agents configured on Core, fetched from `GET /api/agents`.
    pub agents_list: Vec<Agent>,
    /// Id of the agent selected for the current chat session. `None` means the
    /// throwaway `/ai` playground backend; `Some(id)` routes through Core.
    pub selected_agent: Option<String>,
    /// Whether the agent picker overlay is open on the Chat tab.
    pub agent_picker_open: bool,
    /// Highlighted row in the agent picker.
    pub agent_picker_index: usize,
    /// Selected row index on the Agents tab list.
    pub agents_tab_index: usize,
    /// Loaded detail for the currently selected agent on the Agents tab.
    /// `None` = not yet loaded or load failed.
    pub agent_detail: Option<AgentDetail>,
    /// True while a detail fetch is in-flight on the Agents tab.
    pub agent_detail_loading: bool,
    /// Error message from the last failed detail fetch on the Agents tab.
    pub agent_detail_error: Option<String>,
    /// Catalog items fetched from `GET /api/catalog` for the Apps tab.
    pub catalog_items: Vec<RemoteCatalogItem>,
    /// List navigation state for the Apps tab.
    pub apps_list_state: ratatui::widgets::ListState,
    /// Last fetched gateway status from `GET /api/gateway/status`.
    /// `None` = not yet fetched or Core unreachable.
    pub gateway_status: Option<GatewayStatus>,
    /// Workflows fetched from `GET /workflows`.
    pub workflows_list: Vec<Workflow>,
    /// Selected row index on the Workflows tab.
    pub workflows_tab_index: usize,
    /// Run id returned by `POST /workflows/:id/run`, if a run was triggered.
    pub workflow_run_id: Option<String>,
    /// Latest run state polled from `GET /workflows/runs/:run_id`.
    pub workflow_run_state: Option<String>,
    /// Latest run output polled from `GET /workflows/runs/:run_id`.
    pub workflow_run_output: Option<String>,
    /// True while a run-status poll is in-flight.
    pub workflow_run_loading: bool,
    /// Error from the last workflow operation (trigger or poll).
    pub workflow_run_error: Option<String>,
    /// True while waiting for the user to confirm triggering a run.
    pub workflow_confirm_pending: bool,
    /// Spaces fetched from `GET /api/spaces`. Empty until first fetch.
    pub spaces: Vec<Space>,
    /// Documents for the currently selected space, from `GET /api/spaces/:id/documents`.
    /// Keyed by space id so switching spaces triggers a re-fetch.
    pub space_documents: std::collections::HashMap<String, Vec<SpaceDocument>>,
    /// Index of the selected space in the `spaces` vec on the Spaces tab.
    pub spaces_tab_index: usize,
    /// Conversations fetched from `GET /api/conversations`.
    pub conversations: Vec<ConversationSummary>,
    /// Scroll offset for the Spaces tab content.
    pub spaces_scroll: usize,
    /// Engine list from `GET /api/engines`, merged with active-engine marker.
    /// No engine is hardcoded — all entries come from Core.
    pub engines_list: Vec<EngineInfo>,
    /// Active-engine status from `GET /api/engine/active`.
    pub engine_active: EngineActiveInfo,
    /// Selected row index on the Engines tab.
    pub engines_tab_index: usize,
    /// Scheduled jobs from `GET /heartbeat/jobs`.
    /// No job is hardcoded — all entries come from Core.
    pub scheduled_jobs: Vec<ScheduledJobInfo>,
    /// Selected row index on the Schedules tab.
    pub schedules_tab_index: usize,
    /// Whether the node picker overlay is open (any tab).
    pub node_picker_open: bool,
    /// Highlighted row index in the node picker.
    pub node_picker_index: usize,
    /// Snapshot of nodes loaded when the picker was opened (stable during navigation).
    pub node_picker_nodes: Vec<crate::nodes::Node>,
    /// Health state per node name: true = reachable, false = unreachable, None = unchecked.
    pub node_health: HashMap<String, bool>,
    /// Ephemeral `/btw` side-question overlay state (Chat tab).
    pub btw: BtwOverlay,
    /// Stable conversation id for the current chat. Sent on every turn so Core
    /// persists the conversation; `/goal`, `/double-check`, and sessions all key
    /// off it. Reset to a fresh uuid on "new chat".
    pub conversation_id: String,
    /// ACP model override set via `/model <id>` (sent as `acp_model`). `None`
    /// leaves the agent's configured model in force.
    pub selected_model: Option<String>,
    /// Team to route the chat to via `@team` / `/team <id>` (sent as `team_id`).
    /// Mutually exclusive with `selected_agent` (team wins).
    pub selected_team: Option<String>,
    /// Active `/goal` state + client-driven continuation loop.
    pub chat_goal: ChatGoal,
    /// Whether the per-turn double-check review is armed (toggled with `/check`).
    pub double_check_on: bool,
    /// Result overlay for the last double-check review.
    pub double_check: DoubleCheckOverlay,
    /// Read-only sessions (runs) overlay for the current conversation.
    pub sessions_overlay: SessionsOverlay,
    /// State for the data-driven list tabs (Models/Skills/Tools/Monitors/
    /// Teams/Meetings/Recipes), keyed by tab. Lazily populated on first view.
    pub feature_tabs: HashMap<SidebarTab, SimpleListTab>,
    /// Fuzzy command palette (Ctrl+P).
    pub palette: CommandPalette,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Screen {
    WaitingForCore,
    Dashboard,
    SetupDependencies,
    SetupProviders,
    SetupTools,
    SetupAgents,
    Complete,
    Chat,
    Agents,
    Account,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SidebarTab {
    Chat,
    Services,
    Agents,
    Apps,
    Gateway,
    Workflows,
    Spaces,
    Engines,
    Schedules,
    // ── Newer feature surfaces (data-driven list tabs) ──
    Models,
    Skills,
    Tools,
    Monitors,
    Teams,
    Meetings,
    Recipes,
    Account,
}

pub const SIDEBAR_TABS: &[SidebarTab] = &[
    SidebarTab::Chat,
    SidebarTab::Services,
    SidebarTab::Agents,
    SidebarTab::Models,
    SidebarTab::Skills,
    SidebarTab::Tools,
    SidebarTab::Apps,
    SidebarTab::Gateway,
    SidebarTab::Workflows,
    SidebarTab::Recipes,
    SidebarTab::Teams,
    SidebarTab::Spaces,
    SidebarTab::Engines,
    SidebarTab::Monitors,
    SidebarTab::Meetings,
    SidebarTab::Schedules,
    SidebarTab::Account,
];

/// The data-driven list tabs that share the generic [`SimpleListTab`] state +
/// `render_feature_tab` renderer. Each maps to one Core list endpoint.
pub const FEATURE_TABS: &[SidebarTab] = &[
    SidebarTab::Models,
    SidebarTab::Skills,
    SidebarTab::Tools,
    SidebarTab::Monitors,
    SidebarTab::Teams,
    SidebarTab::Meetings,
    SidebarTab::Recipes,
];

impl SidebarTab {
    pub fn label(self) -> &'static str {
        match self {
            Self::Chat => "Chat",
            Self::Services => "Services",
            Self::Agents => "Agents",
            Self::Apps => "Apps",
            Self::Gateway => "Gateway",
            Self::Workflows => "Workflows",
            Self::Spaces => "Spaces",
            Self::Engines => "Engines",
            Self::Schedules => "Schedules",
            Self::Models => "Models",
            Self::Skills => "Skills",
            Self::Tools => "Tools",
            Self::Monitors => "Monitors",
            Self::Teams => "Teams",
            Self::Meetings => "Meetings",
            Self::Recipes => "Recipes",
            Self::Account => "Account",
        }
    }

    /// True for the generic data-driven list tabs.
    pub fn is_feature_tab(self) -> bool {
        FEATURE_TABS.contains(&self)
    }
}

#[derive(Debug, Clone)]
pub struct AuthInfo {
    pub name: String,
    pub email: String,
    pub verified: bool,
    pub two_factor: bool,
    pub has_password: bool,
    pub auth_method: String,
    pub plan: String,
    pub session_count: usize,
}

#[derive(Debug, Clone)]
pub struct SidecarStatus {
    pub name: String,
    pub running: bool,
}

/// True when the current build target is macOS Apple Silicon or Windows x86_64.
const NANOCLAW_SUPPORTED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"))
    || cfg!(all(target_os = "windows", target_arch = "x86_64"));

pub const SIDECAR_ORDER: &[&str] = &[
    "temporal", "spider", "screenpipe", "llmfit", "qmd", "shadow", "ghost",
    "llamacpp", "ollama", "vllm",
    "zeroclaw", "openclaw", "nanoclaw", "picoclaw", "nemoclaw", "ironclaw",
];

fn si(
    name: &'static str,
    description: &'static str,
    category: Category,
    selected: bool,
    supported: bool,
) -> SidecarInfo {
    SidecarInfo {
        name: name.into(),
        description: description.into(),
        installed: false,
        category,
        selected,
        supported,
    }
}

fn si_owned(
    name: impl Into<String>,
    description: impl Into<String>,
    category: Category,
    selected: bool,
    supported: bool,
) -> SidecarInfo {
    SidecarInfo {
        name: name.into(),
        description: description.into(),
        installed: false,
        category,
        selected,
        supported,
    }
}

impl App {
    pub fn new(api_url: String) -> Self {
        Self {
            dependencies: vec![
                si("git",    "", Category::Dependency, false, true),
                si("rust",   "", Category::Dependency, false, true),
                si("npm",    "", Category::Dependency, false, true),
                si("python", "", Category::Dependency, false, true),
            ],
            providers: vec![
                si("llamacpp", "wide range of model support (default)",              Category::Provider, true,  true),
                si("ollama",   "wrapper on llama.cpp with predefined models",        Category::Provider, false, true),
                si("vllm",     "high-throughput GPU inference · requires python ≥3.9", Category::Provider, false, true),
            ],
            tools: vec![
                si("temporal",   "workflow engine for predictable workflows (recommended)",      Category::Tool, false, true),
                si("spider",     "web crawler, more than just search (recommended)",          Category::Tool, false, true),
                si("screenpipe", "continuous local screen + audio recorder for context (recommended)",      Category::Tool, false, true),
                si("llmfit",     "hardware-aware LLM model recommendations",                   Category::Tool, false, true),
                si("qmd",        "markdown knowledge base search tool",                        Category::Tool, false, true),
                si("shadow",     "personal intelligence engine — screen capture & OCR",        Category::Tool, false, true),
                si("ghost",      "MCP server — AI eyes and hands for any desktop app",         Category::Tool, false, true),
            ],
            agents: vec![
                si("zeroclaw",  "native binary · fast autonomous agent (default)",          Category::Agent, true,  true),
                si("openclaw",  "npm global package · cross-platform JS agent",             Category::Agent, false, true),
                si("nanoclaw",  "docker sandbox isolation · macOS M1 / Win x86 only",      Category::Agent, false, NANOCLAW_SUPPORTED),
                si("picoclaw",  "lightweight native binary · minimal footprint · embeddable", Category::Agent, false, true),
                si("nemoclaw",  "NVIDIA NeMo · built-in privacy & safety guardrails",      Category::Agent, false, true),
                si("ironclaw",  "NEAR AI agent · autonomous workflows with blockchain integration", Category::Agent, false, true),
            ],
            statuses: Vec::new(),
            install_states: HashMap::new(),
            list_state: ratatui::widgets::ListState::default(),
            api_url,
            current_screen: Screen::Dashboard,
            install_results: Vec::new(),
            last_poll: Instant::now(),
            animation_tick: 0,
            install_started_at: None,
            deps_installing: false,
            deps_install_started: None,
            core_connected: false,
            chat: ChatState::new(),
            auth_info: None,
            login_pending: false,
            active_tab: SidebarTab::Services,
            click_regions: ClickRegions::default(),
            mouse_col: 0,
            mouse_row: 0,
            agents_list: Vec::new(),
            selected_agent: None,
            agent_picker_open: false,
            agent_picker_index: 0,
            agents_tab_index: 0,
            agent_detail: None,
            agent_detail_loading: false,
            agent_detail_error: None,
            catalog_items: Vec::new(),
            apps_list_state: ratatui::widgets::ListState::default(),
            gateway_status: None,
            workflows_list: Vec::new(),
            workflows_tab_index: 0,
            workflow_run_id: None,
            workflow_run_state: None,
            workflow_run_output: None,
            workflow_run_loading: false,
            workflow_run_error: None,
            workflow_confirm_pending: false,
            spaces: Vec::new(),
            space_documents: std::collections::HashMap::new(),
            spaces_tab_index: 0,
            conversations: Vec::new(),
            spaces_scroll: 0,
            engines_list: Vec::new(),
            engine_active: EngineActiveInfo::default(),
            engines_tab_index: 0,
            scheduled_jobs: Vec::new(),
            schedules_tab_index: 0,
            node_picker_open: false,
            node_picker_index: 0,
            node_picker_nodes: Vec::new(),
            node_health: HashMap::new(),
            btw: BtwOverlay::default(),
            conversation_id: uuid::Uuid::new_v4().to_string(),
            selected_model: None,
            selected_team: None,
            chat_goal: ChatGoal::default(),
            double_check_on: false,
            double_check: DoubleCheckOverlay::default(),
            sessions_overlay: SessionsOverlay::default(),
            feature_tabs: HashMap::new(),
            palette: CommandPalette::default(),
        }
    }

    pub fn new_from_catalog(api_url: String, items: Vec<RemoteCatalogItem>) -> Self {
        let to_info = |item: &RemoteCatalogItem| -> SidecarInfo {
            let category = match item.category.as_str() {
                "agent" => Category::Agent,
                "tool" => Category::Tool,
                "provider" => Category::Provider,
                _ => Category::Agent,
            };
            si_owned(&item.name, &item.description, category, item.recommended, !item.deprecated)
        };

        let agents: Vec<SidecarInfo> = items.iter()
            .filter(|i| i.category == "agent" && !i.deprecated)
            .map(to_info)
            .collect();
        let tools: Vec<SidecarInfo> = items.iter()
            .filter(|i| i.category == "tool" && !i.deprecated)
            .map(to_info)
            .collect();
        let providers: Vec<SidecarInfo> = items.iter()
            .filter(|i| i.category == "provider" && !i.deprecated)
            .map(to_info)
            .collect();

        // Delegate to `new` for all the non-catalog state, then override the
        // four catalog-derived vecs. Keeps the field list in one place so new
        // feature state only has to be added to `new`.
        let mut app = Self::new(api_url);
        app.providers = providers;
        app.tools = tools;
        app.agents = agents;
        app.catalog_items = items;
        app
    }

    pub fn all_dependencies_installed(&self) -> bool {
        self.dependencies.iter().all(|d| d.installed)
    }

    pub fn all_sidecars(&self) -> impl Iterator<Item = &SidecarInfo> {
        self.providers.iter().chain(self.tools.iter()).chain(self.agents.iter())
    }
}
