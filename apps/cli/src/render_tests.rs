//! Headless render-smoke tests for the TUI.
//!
//! These render every visual surface (each [`Screen`], each [`SidebarTab`], and
//! every overlay) into a ratatui [`TestBackend`] buffer across a range of
//! terminal sizes — including very small ones. A render that panics (e.g. a
//! subtract-overflow from `area.height - N` layout math when the terminal is
//! smaller than the layout assumes) fails the corresponding test. They assert
//! no behaviour beyond "it draws without panicking", which is the property we
//! care about for a control-panel TUI.

use ratatui::{backend::TestBackend, Terminal};

use crate::app::{
    Agent, AgentDetail, App, AuthInfo, ConversationSummary, EngineActiveInfo, EngineInfo,
    GatewayStatus, ListRow, RemoteCatalogItem, ScheduledJobInfo, Screen, SessionRow, SidebarTab,
    SidecarStatus, SimpleListTab, Space, SpaceDocument, Workflow, FEATURE_TABS, SIDEBAR_TABS,
};
use crate::chat::{ChatMessage, Role};

/// Terminal sizes to render at. The tiny ones are the point: they flush out
/// layout math that underflows when the terminal is smaller than expected.
const SIZES: &[(u16, u16)] = &[
    (16, 6),
    (20, 10),
    (30, 4),
    (40, 12),
    (80, 24),
    (120, 40),
    (200, 60),
];

const ALL_SCREENS: &[Screen] = &[
    Screen::WaitingForCore,
    Screen::Dashboard,
    Screen::SetupDependencies,
    Screen::SetupProviders,
    Screen::SetupTools,
    Screen::SetupAgents,
    Screen::Complete,
    Screen::Chat,
    Screen::Agents,
    Screen::Account,
];

/// Draw one frame at `(w, h)`. Panics inside `ui()` propagate and fail the test.
fn render_ok(app: &mut App, w: u16, h: u16) {
    let backend = TestBackend::new(w, h);
    let mut terminal = Terminal::new(backend).expect("create test terminal");
    terminal
        .draw(|f| crate::ui::ui(f, app))
        .expect("draw frame");
}

/// Render `app` at every size in [`SIZES`].
fn render_all_sizes(app: &mut App) {
    for &(w, h) in SIZES {
        render_ok(app, w, h);
    }
}

fn fresh() -> App {
    App::new("http://127.0.0.1:7980".to_string())
}

// ── Synthetic data builders ───────────────────────────────────────────────────

fn sample_agent(id: &str) -> Agent {
    Agent {
        id: id.to_string(),
        name: format!("Agent {id}"),
        description: Some("A synthetic test agent with a fairly long description".into()),
        engine: Some("llamacpp".into()),
        transport: Some("acp".into()),
        installed: Some(true),
        model: Some("gemma-4".into()),
        gateway_bypass: Some(false),
    }
}

fn sample_catalog_item(name: &str, category: &str) -> RemoteCatalogItem {
    RemoteCatalogItem {
        name: name.to_string(),
        display_name: format!("Display {name}"),
        description: "A synthetic catalog entry used for render testing.".into(),
        category: category.to_string(),
        deprecated: false,
        recommended: true,
        latest_version: Some("1.2.3".into()),
        installed_version: Some("1.2.0".into()),
        install_state: "installed".into(),
    }
}

fn sample_list_tab() -> SimpleListTab {
    SimpleListTab {
        rows: vec![
            ListRow {
                title: "First row".into(),
                subtitle: "a subtitle that is reasonably long for wrapping".into(),
                badge: "installed".into(),
                id: "row-1".into(),
            },
            ListRow {
                title: "Second row".into(),
                subtitle: "another subtitle".into(),
                badge: "running".into(),
                id: "row-2".into(),
            },
        ],
        index: 1,
        loading: false,
        loaded: true,
        error: None,
        notice: Some("installed ✓".into()),
    }
}

/// An app with every data surface populated, so the populated render path of
/// each tab and overlay actually executes (vs. the empty-state guard).
fn populated() -> App {
    let mut app = fresh();

    app.core_connected = true;

    app.statuses = vec![
        SidecarStatus {
            name: "llamacpp".into(),
            running: true,
        },
        SidecarStatus {
            name: "spider".into(),
            running: false,
        },
    ];

    app.agents_list = vec![sample_agent("ryu"), sample_agent("codex")];
    app.selected_agent = Some("ryu".into());
    app.agent_detail = Some(AgentDetail {
        id: "ryu".into(),
        name: "Ryu".into(),
        description: Some("The flagship Pi+Gateway agent.".into()),
        engine: Some("llamacpp".into()),
        model: Some("gemma-4".into()),
        tools: vec!["search_conversations".into(), "spider__crawl".into()],
        built_in: Some(true),
        version: Some("1.0.0".into()),
        locked: Some(true),
    });

    app.catalog_items = vec![
        sample_catalog_item("ghost", "tool"),
        sample_catalog_item("zeroclaw", "agent"),
        sample_catalog_item("llamacpp", "provider"),
    ];
    app.apps_list_state.select(Some(0));

    app.gateway_status = Some(GatewayStatus {
        reachable: true,
        url: "http://127.0.0.1:7981".into(),
        health: Some(serde_json::json!({ "status": "ok" })),
        metrics: Some(serde_json::json!({ "requests": 42 })),
        effective_config: Some(serde_json::json!({ "routing": { "default_model": "gemma-4" } })),
    });

    app.workflows_list = vec![Workflow {
        id: "wf-1".into(),
        name: "Nightly digest".into(),
        description: Some("Summarise the day".into()),
        created_at: Some("2026-06-22T00:00:00Z".into()),
    }];
    app.workflows_tab_index = 0;
    app.workflow_run_id = Some("run-123".into());
    app.workflow_run_state = Some("running".into());
    app.workflow_run_output = Some("partial output line\nsecond line".into());

    app.spaces = vec![Space {
        id: "space-1".into(),
        name: "Research".into(),
        description: Some("Long-term notes".into()),
        document_count: Some(3),
    }];
    app.space_documents.insert(
        "space-1".into(),
        vec![SpaceDocument {
            id: "doc-1".into(),
            name: "notes.md".into(),
            size: Some(2048),
            created_at: Some("2026-06-21T12:00:00Z".into()),
        }],
    );
    app.spaces_tab_index = 0;

    app.conversations = vec![ConversationSummary {
        id: "conv-1".into(),
        title: Some("Fix the failing test".into()),
        agent_id: Some("ryu".into()),
        message_count: Some(8),
        updated_at: Some("2026-06-22T09:00:00Z".into()),
    }];

    app.engines_list = vec![
        EngineInfo {
            id: "llamacpp".into(),
            name: "llama.cpp".into(),
            description: Some("Default local engine".into()),
            installed: Some(true),
            install_hint: None,
            active: true,
        },
        EngineInfo {
            id: "ollama".into(),
            name: "Ollama".into(),
            description: Some("Model wrapper".into()),
            installed: Some(false),
            install_hint: Some("brew install ollama".into()),
            active: false,
        },
    ];
    app.engine_active = EngineActiveInfo {
        active: Some("llamacpp".into()),
        running: true,
        available: vec!["llamacpp".into(), "ollama".into()],
    };
    app.engines_tab_index = 0;

    app.scheduled_jobs = vec![ScheduledJobInfo {
        id: "job-1".into(),
        name: "monitor-abc".into(),
        schedule: Some(serde_json::json!("every 30s")),
        enabled: true,
        last_run_at: Some("2026-06-22T09:30:00Z".into()),
        last_outcome: Some("ok".into()),
    }];
    app.schedules_tab_index = 0;

    app.auth_info = Some(AuthInfo {
        name: "Jane Doe".into(),
        email: "jane@example.com".into(),
        verified: true,
        two_factor: true,
        has_password: true,
        auth_method: "password".into(),
        plan: "Pro (monthly)".into(),
        session_count: 2,
    });

    app.chat.messages = vec![
        ChatMessage { role: Role::User, content: "Hello, can you help?".into() },
        ChatMessage {
            role: Role::Assistant,
            content: "Of course — here is a long answer that should wrap across multiple lines in a narrow terminal to exercise the wrapping path.".into(),
        },
    ];

    for &tab in FEATURE_TABS {
        app.feature_tabs.insert(tab, sample_list_tab());
    }

    app
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[test]
fn renders_every_screen_empty() {
    for screen in ALL_SCREENS {
        let mut app = fresh();
        app.current_screen = screen.clone();
        render_all_sizes(&mut app);
    }
}

#[test]
fn renders_every_screen_populated() {
    for screen in ALL_SCREENS {
        let mut app = populated();
        app.current_screen = screen.clone();
        render_all_sizes(&mut app);
    }
}

#[test]
fn renders_every_tab_empty() {
    for &tab in SIDEBAR_TABS {
        let mut app = fresh();
        app.current_screen = Screen::Dashboard;
        app.active_tab = tab;
        app.list_state.select(Some(0));
        render_all_sizes(&mut app);
    }
}

#[test]
fn renders_every_tab_populated() {
    for &tab in SIDEBAR_TABS {
        let mut app = populated();
        app.current_screen = Screen::Dashboard;
        app.active_tab = tab;
        app.list_state.select(Some(0));
        render_all_sizes(&mut app);
    }
}

#[test]
fn renders_command_palette_overlay() {
    for query in ["", "go", "chat", "zzzznomatch"] {
        let mut app = populated();
        app.current_screen = Screen::Dashboard;
        app.active_tab = SidebarTab::Services;
        app.palette.open = true;
        app.palette.query = query.to_string();
        app.palette.index = 0;
        render_all_sizes(&mut app);
    }
}

#[test]
fn renders_node_picker_overlay() {
    let mut app = populated();
    app.node_picker_open = true;
    app.node_picker_nodes = vec![
        crate::nodes::Node {
            name: "local".into(),
            url: "http://127.0.0.1:7980".into(),
            token: None,
            mesh: None,
        },
        crate::nodes::Node {
            name: "remote".into(),
            url: "http://10.0.0.5:2049".into(),
            token: Some("ryu_secret".into()),
            mesh: None,
        },
    ];
    app.node_picker_index = 1;
    app.node_health.insert("local".into(), true);
    app.node_health.insert("remote".into(), false);
    render_all_sizes(&mut app);
}

#[test]
fn renders_agent_picker_overlay() {
    let mut app = populated();
    app.current_screen = Screen::Chat;
    app.active_tab = SidebarTab::Chat;
    app.agent_picker_open = true;
    app.agent_picker_index = 1;
    render_all_sizes(&mut app);
}

#[test]
fn renders_btw_overlay() {
    // Loading, answered, and error states are distinct render paths.
    let states: &[(bool, Option<&str>, Option<&str>)] = &[
        (true, None, None),
        (false, Some("Here is the answer to your side question, possibly spanning several lines for scroll testing."), None),
        (false, None, Some("the side question failed")),
    ];
    for &(loading, answer, error) in states {
        let mut app = populated();
        app.current_screen = Screen::Chat;
        app.active_tab = SidebarTab::Chat;
        app.btw.open = true;
        app.btw.question = "What does this conversation conclude?".into();
        app.btw.loading = loading;
        app.btw.answer = answer.map(str::to_string);
        app.btw.error = error.map(str::to_string);
        render_all_sizes(&mut app);
    }
}

#[test]
fn renders_double_check_overlay() {
    let states: &[(bool, Option<bool>, &str, Option<&str>)] = &[
        (true, None, "", None),
        (false, Some(true), "Looks correct.", None),
        (
            false,
            Some(false),
            "Found a problem with the second step.",
            None,
        ),
        (false, None, "", Some("review request failed")),
    ];
    for &(loading, ok, critique, error) in states {
        let mut app = populated();
        app.current_screen = Screen::Chat;
        app.active_tab = SidebarTab::Chat;
        app.double_check.open = true;
        app.double_check.loading = loading;
        app.double_check.ok = ok;
        app.double_check.critique = critique.to_string();
        app.double_check.model = "claude".into();
        app.double_check.error = error.map(str::to_string);
        render_all_sizes(&mut app);
    }
}

#[test]
fn renders_sessions_overlay() {
    // Empty, loading, populated, and error variants.
    let mut configs: Vec<App> = Vec::new();

    let mut loading = populated();
    loading.sessions_overlay.open = true;
    loading.sessions_overlay.loading = true;
    configs.push(loading);

    let mut empty = populated();
    empty.sessions_overlay.open = true;
    configs.push(empty);

    let mut err = populated();
    err.sessions_overlay.open = true;
    err.sessions_overlay.error = Some("could not load sessions".into());
    configs.push(err);

    let mut rows = populated();
    rows.sessions_overlay.open = true;
    rows.sessions_overlay.rows = vec![
        SessionRow {
            id: "run-1".into(),
            status: "completed".into(),
            created_at: "2026-06-22T09:00:00Z".into(),
            branch: "main".into(),
        },
        SessionRow {
            id: "run-2".into(),
            status: "running".into(),
            created_at: "2026-06-22T09:10:00Z".into(),
            branch: "ryu/abc123".into(),
        },
    ];
    rows.sessions_overlay.index = 1;
    configs.push(rows);

    for mut app in configs {
        app.current_screen = Screen::Chat;
        app.active_tab = SidebarTab::Chat;
        render_all_sizes(&mut app);
    }
}

#[test]
fn renders_chat_with_overrides() {
    // The chat status bar adds spans for the double-check arm / model / team.
    let mut app = populated();
    app.current_screen = Screen::Chat;
    app.active_tab = SidebarTab::Chat;
    app.double_check_on = true;
    app.selected_model = Some("claude-opus".into());
    app.selected_team = Some("research-team".into());
    app.chat.streaming = true;
    render_all_sizes(&mut app);
}
