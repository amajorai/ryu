use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, List, ListItem, Paragraph, Wrap},
    Frame,
};

use crate::app::{App, HintAction, InstallState, Screen, SidebarTab, SIDEBAR_TABS};
use crate::chat::Role;

// ── Palette ───────────────────────────────────────────────────────────────────
const ACCENT: Color = Color::Cyan;
const MUTED: Color = Color::DarkGray;
const SUCCESS: Color = Color::Green;
const DANGER: Color = Color::Red;
const FG: Color = Color::White;
const HIGHLIGHT_BG: Color = Color::Rgb(28, 28, 35);
const HOVER_BG: Color = Color::Rgb(38, 38, 50);
const HOVER_FG: Color = Color::White;
const BTN_HOVER_BG: Color = Color::Rgb(60, 60, 80);

const SIDEBAR_WIDTH: u16 = 20;

fn mouse_in(app: &App, rect: Rect) -> bool {
    app.mouse_col >= rect.x
        && app.mouse_col < rect.x + rect.width
        && app.mouse_row >= rect.y
        && app.mouse_row < rect.y + rect.height
}

// ── Step breadcrumb ───────────────────────────────────────────────────────────

const STEP_LABELS: &[&str] = &["deps", "provider", "tools", "agent"];

fn step_index(screen: &Screen) -> Option<usize> {
    match screen {
        Screen::SetupDependencies => Some(0),
        Screen::SetupProviders => Some(1),
        Screen::SetupTools => Some(2),
        Screen::SetupAgents => Some(3),
        _ => None,
    }
}

fn render_steps(f: &mut Frame, area: Rect, screen: &Screen, app: &mut App) {
    let current = step_index(screen);
    let mut spans: Vec<Span> = vec![Span::raw("  ")];
    let mut x_offset: u16 = area.x + 2;

    for (i, label) in STEP_LABELS.iter().enumerate() {
        let is_current = current == Some(i);
        let is_done = current.map(|c| i < c).unwrap_or(false);

        let text = if is_current {
            format!("● {}", label)
        } else if is_done {
            format!("✓ {}", label)
        } else {
            format!("○ {}", label)
        };
        let text_width = text.chars().count() as u16;
        let step_rect = Rect::new(x_offset, area.y, text_width, 1);
        app.click_regions.wizard_steps.push((step_rect, i));
        let hovered = mouse_in(app, step_rect);
        let is_clickable = current.map(|c| i <= c).unwrap_or(false);

        let style = if is_current {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else if hovered && is_clickable {
            Style::default()
                .fg(HOVER_FG)
                .bg(HOVER_BG)
                .add_modifier(Modifier::BOLD)
        } else if is_done {
            Style::default().fg(SUCCESS)
        } else {
            Style::default().fg(MUTED)
        };

        spans.push(Span::styled(text, style));
        x_offset += text_width;

        if i < STEP_LABELS.len() - 1 {
            let sep = "  ›  ";
            spans.push(Span::styled(sep, Style::default().fg(MUTED)));
            x_offset += sep.chars().count() as u16;
        }
    }

    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

// ── Key hints bar ─────────────────────────────────────────────────────────────

fn render_hints(f: &mut Frame, area: Rect, pairs: &[(&str, &str, HintAction)], app: &mut App) {
    let mut spans: Vec<Span> = vec![Span::raw("  ")];
    let mut x_offset: u16 = area.x + 2;

    for &(key, label, action) in pairs {
        let key_text = format!(" {} ", key);
        let label_text = format!(" {}  ", label);
        let key_width = key_text.chars().count() as u16;
        let label_width = label_text.chars().count() as u16;
        let total_width = key_width + label_width;

        let btn_rect = Rect::new(x_offset, area.y, total_width, 1);
        app.click_regions.hint_buttons.push((btn_rect, action));
        let hovered = mouse_in(app, btn_rect);

        if hovered {
            spans.push(Span::styled(
                key_text,
                Style::default()
                    .fg(Color::Black)
                    .bg(ACCENT)
                    .add_modifier(Modifier::BOLD),
            ));
            spans.push(Span::styled(
                label_text,
                Style::default().fg(HOVER_FG).bg(BTN_HOVER_BG),
            ));
        } else {
            spans.push(Span::styled(
                key_text,
                Style::default()
                    .fg(Color::Black)
                    .bg(MUTED)
                    .add_modifier(Modifier::BOLD),
            ));
            spans.push(Span::styled(label_text, Style::default().fg(MUTED)));
        }
        x_offset += total_width;
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

// ── Outer layout helper (for setup wizard screens) ────────────────────────────

struct Regions {
    header: Rect,
    steps: Rect,
    body: Rect,
    hints: Rect,
}

fn layout(f: &Frame, show_steps: bool) -> Regions {
    let step_height = if show_steps { 2 } else { 0 };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(2)
        .constraints([
            Constraint::Length(14),
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(step_height),
            Constraint::Length(2),
        ])
        .split(f.area());

    Regions {
        header: chunks[0],
        body: chunks[2],
        steps: chunks[3],
        hints: chunks[4],
    }
}

// ── Router ────────────────────────────────────────────────────────────────────

pub fn ui(f: &mut Frame, app: &mut App) {
    app.click_regions.clear();

    match app.current_screen {
        Screen::WaitingForCore => ui_waiting_for_core(f, app),
        Screen::Dashboard => render_main_app(f, app),
        Screen::SetupDependencies => ui_setup_dependencies(f, app),
        Screen::SetupProviders => ui_setup_providers(f, app),
        Screen::SetupTools => ui_setup_tools(f, app),
        Screen::SetupAgents => ui_setup_agents(f, app),
        Screen::Complete => ui_complete(f, app),
        Screen::Chat => render_main_app(f, app),
        Screen::Agents => render_main_app(f, app),
        Screen::Account => render_main_app(f, app),
    }
}

// ── Logo (converted from apps/desktop/app-icon.png) ──────────────────────────

fn ghost_logo_lines() -> Vec<Line<'static>> {
    let s = |t: &'static str, r: u8, g: u8, b: u8| -> Span<'static> {
        Span::styled(
            t,
            Style::default()
                .fg(Color::Rgb(r, g, b))
                .add_modifier(Modifier::BOLD),
        )
    };
    vec![
        Line::from(vec![
            s("      ", 0, 0, 0),
            s(".::::::::::::", 27, 67, 129),
            s(":::.", 66, 69, 125),
            s(".", 55, 50, 85),
        ]),
        Line::from(vec![
            s("  .", 6, 16, 29),
            s(":::--::::::", 28, 78, 144),
            s("::::", 31, 62, 124),
            s(":-", 56, 71, 135),
            s("--", 80, 84, 152),
            s("=", 98, 96, 166),
            s("=", 111, 104, 177),
            s("=", 124, 112, 187),
            s("-", 107, 94, 156),
        ]),
        Line::from(vec![
            s(" ", 5, 14, 25),
            s(":------:::::", 28, 78, 145),
            s(":::::", 31, 61, 123),
            s(":-", 58, 72, 136),
            s("--", 78, 84, 151),
            s("-=", 99, 96, 167),
            s("=", 117, 108, 182),
            s("+=", 133, 117, 192),
        ]),
        Line::from(vec![
            s(".", 22, 56, 101),
            s("--------::::", 32, 80, 148),
            s(":::::", 40, 63, 125),
            s(":-", 62, 73, 137),
            s("--", 80, 84, 152),
            s("-=", 100, 96, 167),
            s("==", 121, 110, 185),
            s("+", 139, 121, 199),
            s(":", 99, 84, 138),
        ]),
        Line::from(vec![
            s(":------", 33, 84, 154),
            s("--", 50, 99, 171),
            s("==", 73, 114, 188),
            s("=+", 105, 120, 196),
            s("+++++", 151, 115, 190),
            s("==", 133, 101, 173),
            s("====", 106, 96, 167),
            s("==", 122, 110, 185),
            s("+=", 135, 117, 191),
        ]),
        Line::from(vec![
            s(":----", 35, 87, 158),
            s("-", 49, 100, 173),
            s("=", 66, 113, 189),
            s("=", 84, 127, 205),
            s("+++", 109, 139, 219),
            s("*", 153, 140, 221),
            s("*********", 210, 133, 213),
            s("*", 192, 124, 202),
            s("+", 170, 118, 194),
            s("+++++", 142, 116, 192),
        ]),
        Line::from(vec![
            s("---", 37, 89, 160),
            s("-", 47, 98, 171),
            s("=", 63, 111, 186),
            s("=", 82, 127, 205),
            s("++++", 106, 141, 221),
            s("+", 144, 142, 223),
            s("*", 176, 140, 220),
            s("*************", 218, 132, 212),
            s("*+*", 186, 127, 206),
        ]),
        Line::from(vec![
            s("--", 45, 96, 168),
            s("-", 58, 107, 181),
            s("=", 74, 120, 197),
            s("++++", 99, 140, 220),
            s("*", 134, 164, 231),
            s("@", 224, 229, 248),
            s("@", 244, 243, 251),
            s("%", 222, 203, 239),
            s("****", 217, 137, 217),
            s("%", 242, 200, 237),
            s("@@", 250, 235, 248),
            s("#", 233, 157, 223),
            s("********", 224, 134, 214),
        ]),
        Line::from(vec![
            s("==", 70, 116, 192),
            s("=+", 90, 133, 212),
            s("++++", 103, 143, 224),
            s("@", 222, 231, 248),
            s("███", 255, 255, 255),
            s("#", 216, 178, 231),
            s("**", 215, 137, 217),
            s("#", 234, 176, 229),
            s("███", 255, 255, 255),
            s("@", 249, 230, 247),
            s("********", 227, 135, 215),
        ]),
        Line::from(vec![
            s("=", 85, 123, 195),
            s("+++++++", 100, 141, 222),
            s("@", 225, 233, 249),
            s("███", 255, 255, 255),
            s("#", 199, 182, 233),
            s("**", 198, 138, 218),
            s("#", 228, 178, 230),
            s("███", 255, 255, 255),
            s("@", 249, 233, 248),
            s("*******", 226, 136, 216),
            s("+", 208, 123, 196),
        ]),
        Line::from(vec![
            s(":", 69, 95, 149),
            s("+++++++", 104, 144, 225),
            s("*", 137, 167, 232),
            s("@", 229, 236, 250),
            s("@", 247, 249, 253),
            s("%", 200, 212, 243),
            s("+*", 144, 143, 223),
            s("**", 184, 140, 220),
            s("%", 231, 208, 240),
            s("@@", 249, 242, 250),
            s("#", 226, 162, 225),
            s("*******", 224, 136, 217),
            s(":", 154, 91, 145),
        ]),
        Line::from(vec![
            s(" ", 17, 24, 38),
            s("+++++++++++++", 104, 142, 223),
            s("+**", 155, 140, 221),
            s("**********", 213, 135, 216),
        ]),
        Line::from(vec![
            s("  ", 0, 0, 0),
            s("-", 83, 115, 179),
            s("+++++++++++++", 107, 143, 224),
            s("+*", 154, 141, 222),
            s("*******", 209, 136, 217),
            s("=", 184, 109, 174),
        ]),
        Line::from(vec![
            s("    .", 20, 28, 44),
            s(":", 69, 95, 148),
            s("-", 82, 114, 178),
            s("==", 95, 131, 204),
            s("++++++++", 110, 142, 223),
            s("++", 158, 138, 217),
            s("++", 181, 124, 198),
            s("=", 172, 108, 171),
            s(":", 148, 90, 143),
            s(".", 107, 64, 102),
        ]),
    ]
}

fn render_logo(f: &mut Frame, area: Rect) {
    f.render_widget(Paragraph::new(ghost_logo_lines()), area);
}

// ── Compact logo for sidebar (half-block rendered from app-icon.png) ──────────

fn render_sidebar_logo(f: &mut Frame, area: Rect) {
    let s = |t: &'static str, fr: u8, fg: u8, fb: u8, br: u8, bg: u8, bb: u8| -> Span<'static> {
        Span::styled(
            t,
            Style::default()
                .fg(Color::Rgb(fr, fg, fb))
                .bg(Color::Rgb(br, bg, bb)),
        )
    };
    let c = |t: &'static str, r: u8, g: u8, b: u8| -> Span<'static> {
        Span::styled(t, Style::default().fg(Color::Rgb(r, g, b)))
    };
    let lines = vec![
        Line::from(vec![
            Span::raw("  "),
            c("▄", 11, 28, 51),
            c("▄", 31, 80, 146),
            s("▀", 17, 44, 81, 33, 83, 152),
            s("▀", 25, 64, 118, 33, 83, 152),
            s("▀▀▀", 29, 76, 140, 30, 79, 146),
            s("▀▀▀▀", 29, 63, 126, 30, 65, 127),
            s("▀", 57, 68, 127, 60, 74, 138),
            s("▀", 67, 69, 123, 81, 85, 153),
            s("▀", 58, 55, 94, 102, 98, 169),
            c("▄", 118, 107, 179),
            c("▄", 46, 41, 68),
        ]),
        Line::from(vec![
            Span::raw(" "),
            c("▄", 17, 45, 82),
            s("▀▀▀▀▀▀", 31, 81, 149, 31, 82, 151),
            s("▀▀▀▀", 27, 66, 130, 28, 64, 126),
            s("▀", 46, 67, 129, 48, 66, 129),
            s("▀", 62, 75, 139, 63, 75, 139),
            s("▀", 79, 84, 151, 79, 84, 151),
            s("▀", 96, 95, 165, 94, 93, 163),
            s("▀", 115, 106, 180, 112, 104, 177),
            s("▀", 131, 115, 190, 131, 116, 193),
            c("▄", 79, 68, 111),
        ]),
        Line::from(vec![
            Span::raw(" "),
            s("▀", 26, 66, 120, 31, 78, 141),
            s("▀▀▀▀", 34, 85, 154, 35, 86, 157),
            s("▀", 34, 84, 153, 46, 95, 167),
            s("▀", 33, 81, 148, 60, 103, 176),
            s("▀", 31, 74, 139, 78, 108, 181),
            s("▀", 31, 66, 128, 103, 109, 181),
            s("▀▀", 38, 62, 123, 125, 103, 175),
            s("▀", 52, 68, 130, 115, 94, 164),
            s("▀", 65, 75, 140, 98, 89, 157),
            s("▀", 80, 84, 152, 92, 89, 158),
            s("▀", 95, 94, 164, 99, 96, 166),
            s("▀", 111, 104, 177, 112, 104, 177),
            s("▀", 129, 115, 191, 128, 114, 190),
            s("▀", 114, 98, 161, 133, 114, 186),
        ]),
        Line::from(vec![
            Span::raw(" "),
            s("▀▀▀", 34, 86, 155, 36, 89, 160),
            s("▀", 40, 92, 164, 59, 108, 182),
            s("▀", 57, 106, 180, 87, 131, 209),
            s("▀", 82, 125, 203, 104, 141, 222),
            s("▀", 105, 136, 216, 125, 143, 223),
            s("▀", 139, 138, 218, 169, 140, 221),
            s("▀", 180, 137, 217, 205, 137, 218),
            s("▀▀▀", 209, 133, 212, 222, 136, 216),
            s("▀", 194, 125, 202, 225, 135, 215),
            s("▀", 161, 114, 188, 219, 133, 213),
            s("▀", 130, 105, 178, 198, 127, 205),
            s("▀", 121, 107, 180, 166, 119, 195),
            s("▀", 130, 114, 190, 150, 118, 194),
            s("▀", 141, 121, 198, 154, 124, 202),
        ]),
        Line::from(vec![
            Span::raw(" "),
            s("▀", 36, 89, 159, 42, 94, 166),
            s("▀", 40, 92, 164, 53, 103, 177),
            s("▀", 56, 105, 179, 78, 124, 201),
            s("▀", 85, 129, 207, 99, 140, 220),
            s("▀", 101, 142, 222, 104, 144, 225),
            s("▀", 109, 144, 225, 134, 163, 230),
            s("▀", 134, 143, 223, 235, 236, 249),
            s("▀", 183, 139, 220, 210, 177, 231),
            s("▀▀", 218, 137, 217, 219, 136, 217),
            s("▀", 226, 136, 217, 236, 174, 229),
            s("▀", 228, 136, 217, 250, 235, 248),
            s("▀", 228, 136, 216, 233, 156, 223),
            s("▀▀▀", 222, 134, 213, 227, 135, 215),
            s("▀▀", 194, 128, 207, 222, 134, 214),
        ]),
        Line::from(vec![
            Span::raw(" "),
            s("▀", 58, 107, 181, 81, 124, 200),
            s("▀", 75, 121, 197, 93, 135, 215),
            s("▀▀▀", 100, 140, 221, 103, 143, 224),
            s("▀", 199, 213, 244, 220, 229, 248),
            s("▀", 255, 255, 255, 255, 255, 255),
            s("▀", 245, 236, 249, 254, 253, 254),
            s("▀▀", 216, 137, 217, 208, 137, 218),
            s("▀", 250, 235, 248, 254, 252, 254),
            s("▀", 255, 255, 255, 255, 255, 255),
            s("▀", 245, 211, 241, 248, 228, 246),
            s("▀▀▀▀▀", 228, 135, 215, 226, 135, 215),
        ]),
        Line::from(vec![
            Span::raw(" "),
            s("▀", 90, 128, 202, 81, 113, 177),
            s("▀▀▀▀", 103, 143, 224, 104, 144, 225),
            s("▀", 207, 219, 245, 147, 175, 234),
            s("▀", 255, 255, 255, 253, 253, 254),
            s("▀", 244, 243, 251, 187, 198, 239),
            s("▀", 176, 140, 220, 147, 142, 223),
            s("▀", 205, 138, 218, 180, 139, 220),
            s("▀", 250, 242, 250, 224, 194, 236),
            s("▀", 255, 255, 255, 254, 253, 254),
            s("▀", 245, 218, 243, 229, 170, 228),
            s("▀▀▀▀", 226, 136, 217, 225, 136, 217),
            s("▀", 210, 124, 199, 181, 107, 171),
        ]),
        Line::from(vec![
            Span::raw(" "),
            c("▀", 56, 78, 122),
            s("▀▀▀▀▀▀▀▀", 108, 144, 224, 104, 143, 223),
            s("▀", 151, 141, 222, 129, 143, 224),
            s("▀", 178, 140, 220, 153, 141, 222),
            s("▀▀", 205, 141, 219, 189, 138, 219),
            s("▀▀▀▀", 223, 136, 217, 220, 135, 215),
            c("▀", 125, 74, 118),
        ]),
        Line::from(vec![
            Span::raw("  "),
            Span::raw(" "),
            c("▀", 36, 50, 78),
            c("▀", 101, 140, 219),
            s("▀", 105, 145, 226, 57, 78, 123),
            s("▀", 105, 145, 226, 82, 114, 177),
            s("▀", 105, 145, 226, 96, 132, 207),
            s("▀▀▀▀", 109, 144, 225, 107, 143, 223),
            s("▀", 136, 142, 223, 129, 143, 224),
            s("▀", 164, 141, 221, 155, 138, 217),
            s("▀", 192, 139, 219, 176, 127, 201),
            s("▀", 212, 137, 217, 169, 108, 171),
            s("▀", 223, 137, 217, 122, 74, 118),
            c("▀", 222, 132, 211),
            c("▀", 81, 48, 76),
        ]),
    ];
    f.render_widget(Paragraph::new(lines), area);
}

// ── Waiting for core ──────────────────────────────────────────────────────────

fn ui_waiting_for_core(f: &mut Frame, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(2)
        .constraints([
            Constraint::Length(14),
            Constraint::Length(1),
            Constraint::Min(1),
            Constraint::Length(2),
        ])
        .split(f.area());

    render_logo(f, chunks[0]);

    let frame = spinner_frame(app.animation_tick);
    let msg = Paragraph::new(Line::from(vec![
        Span::styled(
            format!("{frame} "),
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::styled("waiting for ", Style::default().fg(MUTED)),
        Span::styled(
            "ryu-core",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ),
        Span::styled(" — start it to continue", Style::default().fg(MUTED)),
    ]))
    .alignment(ratatui::layout::Alignment::Center);
    f.render_widget(msg, chunks[2]);

    render_hints(f, chunks[3], &[("q", "quit", HintAction::Quit)], app);
}

// ── Main app with sidebar ─────────────────────────────────────────────────────

fn render_main_app(f: &mut Frame, app: &mut App) {
    let outer = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([Constraint::Min(1), Constraint::Length(2)])
        .split(f.area());

    let body = outer[0];
    let hints_area = outer[1];

    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(SIDEBAR_WIDTH), Constraint::Min(1)])
        .split(body);

    let sidebar_area = columns[0];
    let main_area = columns[1];

    render_sidebar(f, sidebar_area, app);

    f.render_widget(Clear, main_area);
    match app.active_tab {
        SidebarTab::Services => render_services_content(f, main_area, app),
        SidebarTab::Chat => render_chat_content(f, main_area, app),
        SidebarTab::Agents => render_agents_content(f, main_area, app),
        SidebarTab::Apps => render_apps_content(f, main_area, app),
        SidebarTab::Gateway => render_gateway_content(f, main_area, app),
        SidebarTab::Workflows => render_workflows_content(f, main_area, app),
        SidebarTab::Spaces => render_spaces_content(f, main_area, app),
        SidebarTab::Engines => render_engines_content(f, main_area, app),
        SidebarTab::Schedules => render_schedules_content(f, main_area, app),
        SidebarTab::Account => render_account_content(f, main_area, app),
        SidebarTab::Models
        | SidebarTab::Skills
        | SidebarTab::Tools
        | SidebarTab::Monitors
        | SidebarTab::Teams
        | SidebarTab::Meetings
        | SidebarTab::Recipes => render_feature_tab(f, main_area, app, app.active_tab),
    }

    let tab_hints: Vec<(&str, &str, HintAction)> = match app.active_tab {
        SidebarTab::Services => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("↑↓", "nav", HintAction::NavUp),
            ("d", "install", HintAction::Install),
            ("s", "start", HintAction::StartSidecar),
            ("x", "stop", HintAction::StopSidecar),
            ("r", "restart", HintAction::RestartSidecar),
            ("A", "all start", HintAction::StartAll),
            ("Z", "all stop", HintAction::StopAll),
            ("i", "setup", HintAction::Setup),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Chat => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("enter", "send", HintAction::Send),
            ("^a", "agent", HintAction::Pick),
            ("↑↓", "scroll", HintAction::ScrollUp),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Agents => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("↑↓", "nav", HintAction::NavUp),
            ("enter", "detail", HintAction::Pick),
            ("r", "refresh", HintAction::Refresh),
            ("esc", "clear", HintAction::Quit),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Account => {
            if app.auth_info.is_some() {
                vec![
                    ("tab", "switch", HintAction::SwitchTab),
                    ("r", "refresh", HintAction::Refresh),
                    ("L", "logout", HintAction::Logout),
                    ("q", "quit", HintAction::Quit),
                ]
            } else if app.login_pending {
                vec![
                    ("tab", "switch", HintAction::SwitchTab),
                    ("q", "quit", HintAction::Quit),
                ]
            } else {
                vec![
                    ("tab", "switch", HintAction::SwitchTab),
                    ("l", "login", HintAction::Login),
                    ("q", "quit", HintAction::Quit),
                ]
            }
        }
        SidebarTab::Apps => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("↑↓", "navigate", HintAction::NavUp),
            ("i", "install", HintAction::Install),
            ("D", "uninstall", HintAction::Uninstall),
            ("r", "refresh", HintAction::Refresh),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Workflows => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("↑↓", "nav", HintAction::NavUp),
            ("enter", "run", HintAction::Pick),
            ("r", "refresh", HintAction::Refresh),
            ("esc", "clear", HintAction::Quit),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Spaces => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("↑↓", "space", HintAction::NavUp),
            ("r", "refresh", HintAction::Refresh),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Engines => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("\u{2191}\u{2193}", "nav", HintAction::NavUp),
            ("enter", "activate", HintAction::Pick),
            ("r", "refresh", HintAction::Refresh),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Schedules => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("\u{2191}\u{2193}", "nav", HintAction::NavUp),
            ("r", "refresh", HintAction::Refresh),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Agents | SidebarTab::Gateway => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Models | SidebarTab::Skills => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("\u{2191}\u{2193}", "nav", HintAction::NavUp),
            ("enter", "install", HintAction::Pick),
            ("a", "activate", HintAction::Pick),
            ("r", "refresh", HintAction::Refresh),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Monitors | SidebarTab::Recipes => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("\u{2191}\u{2193}", "nav", HintAction::NavUp),
            ("enter", "run", HintAction::Pick),
            ("r", "refresh", HintAction::Refresh),
            ("q", "quit", HintAction::Quit),
        ],
        SidebarTab::Tools | SidebarTab::Teams | SidebarTab::Meetings => vec![
            ("tab", "switch", HintAction::SwitchTab),
            ("\u{2191}\u{2193}", "nav", HintAction::NavUp),
            ("r", "refresh", HintAction::Refresh),
            ("q", "quit", HintAction::Quit),
        ],
    };
    render_hints(f, hints_area, &tab_hints, app);

    // Node picker renders on top of everything (any tab).
    if app.node_picker_open {
        render_node_picker(f, body, app);
    }
    // Command palette renders above even the node picker.
    if app.palette.open {
        render_command_palette(f, body, app);
    }
}

/// Fuzzy command palette overlay (Ctrl+P). A query line + the matching commands.
fn render_command_palette(f: &mut Frame, area: Rect, app: &App) {
    let matches = crate::filtered_palette(&app.palette.query);
    // `clamp(30, ..)` forces a 30-col minimum, which can exceed a very narrow
    // terminal; cap to the available area so the popup never spills outside the
    // buffer (a subtract-free out-of-bounds write would panic at small sizes).
    let width = area
        .width
        .saturating_sub(4)
        .clamp(30, 70)
        .min(area.width.saturating_sub(2));
    let visible = (matches.len() as u16 + 3).min(area.height.saturating_sub(2));
    let height = visible.clamp(5, 22).min(area.height.saturating_sub(2));
    let popup = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + 1,
        width,
        height,
    };
    f.render_widget(Clear, popup);

    let query_line = Line::from(vec![
        Span::styled("  ", Style::default()),
        Span::styled("› ", Style::default().fg(ACCENT)),
        Span::styled(
            if app.palette.query.is_empty() {
                "type to search…".to_string()
            } else {
                app.palette.query.clone()
            },
            if app.palette.query.is_empty() {
                Style::default().fg(MUTED)
            } else {
                Style::default().fg(FG)
            },
        ),
    ]);

    let sel = app.palette.index.min(matches.len().saturating_sub(1));
    let items: Vec<ListItem> = matches
        .iter()
        .enumerate()
        .map(|(i, (label, _))| {
            let style = if i == sel {
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(FG)
            };
            let prefix = if i == sel { "› " } else { "  " };
            ListItem::new(Line::from(Span::styled(format!("{prefix}{label}"), style)))
        })
        .collect();

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACCENT))
        .title(Span::styled(
            " Command palette · Esc to close ",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ));
    let inner = block.inner(popup);
    f.render_widget(block, popup);

    let inner_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(1), Constraint::Min(1)])
        .split(inner);
    f.render_widget(Paragraph::new(query_line), inner_chunks[0]);

    let mut list_state = ratatui::widgets::ListState::default();
    if !matches.is_empty() {
        list_state.select(Some(sel));
    }
    f.render_stateful_widget(
        List::new(items).highlight_style(Style::default().bg(HIGHLIGHT_BG)),
        inner_chunks[1],
        &mut list_state,
    );
}

/// Modal overlay that lists all configured nodes and lets the user pick one.
/// Rendered on top of the main area so it is visible on any tab.
fn render_node_picker(f: &mut Frame, area: Rect, app: &App) {
    let nodes = &app.node_picker_nodes;
    let row_count = nodes.len().max(1);
    // Cap to the area: the `.max(3)` floor plus the `y + 1` offset can otherwise
    // push the popup past the bottom of a very short area and panic.
    let height = (row_count as u16 + 2)
        .min(area.height.saturating_sub(2))
        .max(3)
        .min(area.height.saturating_sub(1))
        .max(1);
    let width = area.width.saturating_sub(4).min(60);
    let popup = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + 1,
        width,
        height,
    };

    f.render_widget(Clear, popup);

    let active_node = crate::nodes::active_node();

    let items: Vec<ListItem> = nodes
        .iter()
        .map(|node| {
            let is_active = node.name == active_node.name;
            let health = app.node_health.get(&node.name).copied();

            let health_icon = match health {
                Some(true) => Span::styled("● ", Style::default().fg(SUCCESS)),
                Some(false) => Span::styled("○ ", Style::default().fg(DANGER)),
                None => Span::styled("· ", Style::default().fg(MUTED)),
            };

            let name_style = if is_active {
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(FG)
            };

            let mut spans = vec![
                health_icon,
                Span::styled(node.name.clone(), name_style),
                Span::styled(format!("  {}", node.url), Style::default().fg(MUTED)),
            ];
            if node.token.is_some() {
                spans.push(Span::styled("  [token]", Style::default().fg(MUTED)));
            }
            if is_active {
                spans.push(Span::styled("  <active>", Style::default().fg(MUTED)));
            }

            ListItem::new(Line::from(spans))
        })
        .collect();

    let mut list_state = ratatui::widgets::ListState::default();
    list_state.select(Some(app.node_picker_index.min(row_count.saturating_sub(1))));

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(ACCENT))
                .title(Span::styled(
                    " select node · enter confirm · esc cancel ",
                    Style::default().fg(ACCENT),
                )),
        )
        .highlight_style(
            Style::default()
                .bg(HIGHLIGHT_BG)
                .fg(HOVER_FG)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("› ");

    f.render_stateful_widget(list, popup, &mut list_state);
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

fn render_sidebar(f: &mut Frame, area: Rect, app: &mut App) {
    let sidebar_block = Block::default()
        .borders(Borders::RIGHT)
        .border_style(Style::default().fg(MUTED));
    let inner = sidebar_block.inner(area);
    f.render_widget(sidebar_block, area);

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(9), // logo (half-block icon from app-icon.png)
            Constraint::Length(1), // spacer
            Constraint::Min(1),    // nav items
            Constraint::Length(3), // user info
        ])
        .split(inner);

    let (logo_area, _spacer, nav_area, user_area) = (chunks[0], chunks[1], chunks[2], chunks[3]);

    render_sidebar_logo(f, logo_area);

    let mut nav_lines: Vec<Line> = Vec::new();
    for (i, tab) in SIDEBAR_TABS.iter().enumerate() {
        let is_active = *tab == app.active_tab;
        let tab_rect = Rect::new(nav_area.x, nav_area.y + i as u16, nav_area.width, 1);
        app.click_regions.sidebar_tabs.push((tab_rect, *tab));
        let hovered = mouse_in(app, tab_rect);

        let (prefix, style) = if is_active {
            (
                "▸ ",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            )
        } else if hovered {
            ("▸ ", Style::default().fg(HOVER_FG).bg(HOVER_BG))
        } else {
            ("  ", Style::default().fg(MUTED))
        };

        nav_lines.push(Line::from(vec![
            Span::styled(format!(" {prefix}"), style),
            Span::styled(tab.label(), style),
        ]));
    }
    f.render_widget(Paragraph::new(nav_lines), nav_area);

    app.click_regions.sidebar_user_area = Some(user_area);
    let user_hovered = mouse_in(app, user_area);

    let mut user_lines: Vec<Line> = Vec::new();

    let (dot, dot_style) = if app.core_connected {
        ("●", Style::default().fg(SUCCESS))
    } else {
        ("○", Style::default().fg(DANGER))
    };
    let user_bg = if user_hovered { HOVER_BG } else { Color::Reset };
    user_lines.push(Line::from(vec![
        Span::styled(" ", Style::default().bg(user_bg)),
        Span::styled(dot, dot_style.bg(user_bg)),
        Span::styled(
            if app.core_connected {
                " connected"
            } else {
                " offline"
            },
            Style::default().fg(MUTED).bg(user_bg),
        ),
    ]));

    if let Some(info) = &app.auth_info {
        let name_display = if info.name.len() > 14 {
            format!("{}…", &info.name[..13])
        } else {
            info.name.clone()
        };
        user_lines.push(Line::from(vec![Span::styled(
            format!(" {name_display}"),
            Style::default()
                .fg(if user_hovered { HOVER_FG } else { FG })
                .bg(user_bg),
        )]));
        let plan_display = if info.plan.len() > 16 {
            format!("{}…", &info.plan[..15])
        } else {
            info.plan.clone()
        };
        user_lines.push(Line::from(vec![Span::styled(
            format!(" {plan_display}"),
            Style::default().fg(ACCENT).bg(user_bg),
        )]));
    } else if crate::auth::load_token().is_none() {
        user_lines.push(Line::from(Span::styled(
            if user_hovered {
                " not logged in ◂"
            } else {
                " not logged in"
            },
            Style::default().fg(Color::Yellow).bg(user_bg),
        )));
    }

    f.render_widget(Paragraph::new(user_lines), user_area);
}

// ── Services tab content ──────────────────────────────────────────────────────

fn render_services_content(f: &mut Frame, area: Rect, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    let header_area = chunks[0];
    let list_area = chunks[1];

    f.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            " Services",
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        )])),
        header_area,
    );

    let core_offline = !app.core_connected
        && app.statuses.is_empty()
        && app.providers.iter().all(|s| !s.installed)
        && app.tools.iter().all(|s| !s.installed)
        && app.agents.iter().all(|s| !s.installed);

    if core_offline {
        let msg = Paragraph::new(Line::from(vec![
            Span::styled("core not running — start with ", Style::default().fg(MUTED)),
            Span::styled(
                "`ryu-core`",
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
        ]))
        .alignment(ratatui::layout::Alignment::Center);
        f.render_widget(msg, list_area);
        return;
    }

    app.click_regions.service_list_area = Some(list_area);
    app.click_regions.service_list_top_y = list_area.y + 1;

    let items: Vec<ListItem> = crate::app::SIDECAR_ORDER
        .iter()
        .enumerate()
        .map(|(row_i, name)| {
            let info = app.all_sidecars().find(|s| s.name == *name);
            let status_entry = app.statuses.iter().find(|s| s.name == *name);

            let installed = info.map(|s| s.installed).unwrap_or(false);
            let running = status_entry.map(|s| s.running).unwrap_or(false);
            let downloading = !installed
                && app
                    .install_results
                    .iter()
                    .any(|(n, queued)| n == *name && *queued);

            let install_failed = matches!(
                app.install_states.get(*name),
                Some(InstallState::Failed { .. })
            );

            let category = match *name {
                "llamacpp" | "ollama" | "vllm" => "provider",
                "spider" | "screenpipe" | "llmfit" => "tool   ",
                _ => "agent  ",
            };

            let (status_icon, status_text, status_style) = if install_failed {
                ("✗", "install failed", Style::default().fg(DANGER))
            } else if downloading {
                (
                    spinner_frame(app.animation_tick),
                    "downloading",
                    Style::default().fg(ACCENT),
                )
            } else if !installed {
                (" ", "—", Style::default().fg(MUTED))
            } else if running {
                ("●", "running", Style::default().fg(SUCCESS))
            } else {
                ("○", "stopped", Style::default().fg(Color::Yellow))
            };

            let row_rect = Rect::new(
                list_area.x,
                list_area.y + 1 + row_i as u16,
                list_area.width,
                1,
            );
            let hovered = mouse_in(app, row_rect);
            let row_bg = if hovered { HOVER_BG } else { Color::Reset };

            Line::from(vec![
                Span::styled(" ", Style::default().bg(row_bg)),
                Span::styled(
                    format!("{:<12}", name),
                    Style::default()
                        .fg(if hovered { HOVER_FG } else { FG })
                        .bg(row_bg),
                ),
                Span::styled(
                    format!(" {category} "),
                    Style::default().fg(MUTED).bg(row_bg),
                ),
                if installed {
                    Span::styled(
                        "[✓] ",
                        Style::default()
                            .fg(if hovered { SUCCESS } else { MUTED })
                            .bg(row_bg),
                    )
                } else {
                    Span::styled("    ", Style::default().fg(MUTED).bg(row_bg))
                },
                Span::styled(format!("{status_icon} "), status_style.bg(row_bg)),
                Span::styled(status_text, status_style.bg(row_bg)),
            ])
            .into()
        })
        .collect();

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED)),
        )
        .highlight_style(
            Style::default()
                .bg(HIGHLIGHT_BG)
                .add_modifier(Modifier::BOLD),
        );
    f.render_stateful_widget(list, list_area, &mut app.list_state.clone());
}

// ── Account tab content ───────────────────────────────────────────────────────

fn render_account_content(f: &mut Frame, area: Rect, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            " Account",
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        ))),
        chunks[0],
    );

    let content_area = chunks[1];
    let mut lines: Vec<Line> = Vec::new();

    match &app.auth_info {
        Some(info) => {
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("  Name:      ", Style::default().fg(MUTED)),
                Span::styled(info.name.as_str(), Style::default().fg(FG)),
            ]));

            let verified_span = if info.verified {
                Span::styled(" (verified)", Style::default().fg(SUCCESS))
            } else {
                Span::styled(" (unverified)", Style::default().fg(Color::Yellow))
            };
            lines.push(Line::from(vec![
                Span::styled("  Email:     ", Style::default().fg(MUTED)),
                Span::styled(info.email.as_str(), Style::default().fg(FG)),
                verified_span,
            ]));

            lines.push(Line::from(""));

            let (pw_text, pw_style) = if info.has_password {
                ("Set".to_owned(), Style::default().fg(SUCCESS))
            } else {
                (
                    format!("Not set (via {})", info.auth_method),
                    Style::default().fg(MUTED),
                )
            };
            lines.push(Line::from(vec![
                Span::styled("  Password:  ", Style::default().fg(MUTED)),
                Span::styled(pw_text, pw_style),
            ]));

            let (tfa_text, tfa_style) = if info.two_factor {
                ("Enabled", Style::default().fg(SUCCESS))
            } else {
                ("Disabled", Style::default().fg(MUTED))
            };
            lines.push(Line::from(vec![
                Span::styled("  2FA:       ", Style::default().fg(MUTED)),
                Span::styled(tfa_text, tfa_style),
            ]));

            lines.push(Line::from(""));

            lines.push(Line::from(vec![
                Span::styled("  Plan:      ", Style::default().fg(MUTED)),
                Span::styled(info.plan.as_str(), Style::default().fg(ACCENT)),
            ]));

            lines.push(Line::from(vec![
                Span::styled("  Sessions:  ", Style::default().fg(MUTED)),
                Span::styled(
                    format!("{} active", info.session_count),
                    Style::default().fg(FG),
                ),
            ]));
        }
        None => {
            lines.push(Line::from(""));
            if app.login_pending {
                lines.push(Line::from(Span::styled(
                    "  Waiting for browser authentication…",
                    Style::default().fg(Color::Yellow),
                )));
                lines.push(Line::from(""));
                lines.push(Line::from(Span::styled(
                    "  Complete sign-in in the browser window that just opened.",
                    Style::default().fg(MUTED),
                )));
            } else {
                let login_rect = Rect::new(content_area.x + 2, content_area.y + 1 + 3, 20, 1);
                app.click_regions.account_login_area = Some(login_rect);
                let login_hovered = mouse_in(app, login_rect);

                lines.push(Line::from(Span::styled(
                    "  Not logged in",
                    Style::default().fg(Color::Yellow),
                )));
                lines.push(Line::from(""));
                if login_hovered {
                    lines.push(Line::from(vec![
                        Span::styled("  ", Style::default()),
                        Span::styled(
                            " Sign in ",
                            Style::default()
                                .fg(Color::Black)
                                .bg(ACCENT)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled("  click or press l", Style::default().fg(MUTED)),
                    ]));
                } else {
                    lines.push(Line::from(vec![
                        Span::styled("  ", Style::default()),
                        Span::styled(
                            " Sign in ",
                            Style::default()
                                .fg(Color::Black)
                                .bg(MUTED)
                                .add_modifier(Modifier::BOLD),
                        ),
                        Span::styled("  press l", Style::default().fg(MUTED)),
                    ]));
                }
            }
        }
    }

    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED)),
        ),
        content_area,
    );
}

fn render_apps_content(f: &mut Frame, area: Rect, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    let header_area = chunks[0];
    let list_area = chunks[1];

    f.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            " Apps",
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        )])),
        header_area,
    );

    if app.catalog_items.is_empty() {
        let msg = Paragraph::new(Line::from(vec![Span::styled(
            "no catalog items — press r to refresh",
            Style::default().fg(MUTED),
        )]))
        .alignment(ratatui::layout::Alignment::Center);
        f.render_widget(msg, list_area);
        return;
    }

    let items: Vec<ListItem> = app
        .catalog_items
        .iter()
        .enumerate()
        .map(|(row_i, item)| {
            let state_str = item.install_state.as_str();
            let installing = state_str == "installing";
            let installed = state_str == "installed";
            let failed = state_str == "failed";

            let (status_icon, status_text, status_style) = if failed {
                ("✗", "failed", Style::default().fg(DANGER))
            } else if installing {
                (
                    spinner_frame(app.animation_tick),
                    "installing",
                    Style::default().fg(ACCENT),
                )
            } else if installed {
                ("●", "installed", Style::default().fg(SUCCESS))
            } else {
                (" ", "—", Style::default().fg(MUTED))
            };

            let row_rect = Rect::new(
                list_area.x,
                list_area.y + 1 + row_i as u16,
                list_area.width,
                1,
            );
            let hovered = mouse_in(app, row_rect);
            let row_bg = if hovered { HOVER_BG } else { Color::Reset };

            let version_label = item
                .installed_version
                .as_deref()
                .or(item.latest_version.as_deref())
                .unwrap_or("");

            Line::from(vec![
                Span::styled(" ", Style::default().bg(row_bg)),
                Span::styled(
                    format!("{:<16}", item.name),
                    Style::default()
                        .fg(if hovered { HOVER_FG } else { FG })
                        .bg(row_bg),
                ),
                Span::styled(
                    format!(" {:<10} ", item.category),
                    Style::default().fg(MUTED).bg(row_bg),
                ),
                if installed {
                    Span::styled(
                        "[✓] ",
                        Style::default()
                            .fg(if hovered { SUCCESS } else { MUTED })
                            .bg(row_bg),
                    )
                } else {
                    Span::styled("    ", Style::default().fg(MUTED).bg(row_bg))
                },
                Span::styled(format!("{status_icon} "), status_style.bg(row_bg)),
                Span::styled(status_text, status_style.bg(row_bg)),
                if !version_label.is_empty() {
                    Span::styled(
                        format!("  {version_label}"),
                        Style::default().fg(MUTED).bg(row_bg),
                    )
                } else {
                    Span::styled("", Style::default().bg(row_bg))
                },
            ])
            .into()
        })
        .collect();

    let selected_idx = app.apps_list_state.selected();
    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED)),
        )
        .highlight_style(
            Style::default()
                .bg(HIGHLIGHT_BG)
                .add_modifier(Modifier::BOLD),
        );
    let mut state = app.apps_list_state.clone();
    f.render_stateful_widget(list, list_area, &mut state);
    // Sync selected index back (render_stateful_widget may update offset)
    if let Some(idx) = selected_idx {
        app.apps_list_state.select(Some(idx));
    }
}

fn render_gateway_content(f: &mut Frame, area: Rect, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            " Gateway",
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        ))),
        chunks[0],
    );

    let body_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(MUTED));
    let inner = body_block.inner(chunks[1]);
    f.render_widget(body_block, chunks[1]);

    let Some(status) = &app.gateway_status else {
        // Core not yet connected or status not yet fetched — show offline state.
        f.render_widget(
            Paragraph::new(vec![
                Line::from(""),
                Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled("○", Style::default().fg(DANGER)),
                    Span::styled(
                        " gateway unreachable — Core may still be starting",
                        Style::default().fg(MUTED),
                    ),
                ]),
            ]),
            inner,
        );
        return;
    };

    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(""));

    // Reachability indicator — value comes from response, not hardcoded.
    let (dot, dot_style, reach_label) = if status.reachable {
        ("●", Style::default().fg(SUCCESS), "online")
    } else {
        ("○", Style::default().fg(DANGER), "offline")
    };
    lines.push(Line::from(vec![
        Span::styled("  status      ", Style::default().fg(MUTED)),
        Span::styled(dot, dot_style),
        Span::styled(format!(" {reach_label}"), Style::default().fg(FG)),
    ]));

    // URL — from response.
    lines.push(Line::from(vec![
        Span::styled("  url         ", Style::default().fg(MUTED)),
        Span::styled(status.url.clone(), Style::default().fg(ACCENT)),
    ]));

    // Model routing default — read from effective_config if present.
    let routing_default = status
        .effective_config
        .as_ref()
        .and_then(|c| c.get("routing"))
        .and_then(|r| r.get("default_model").or_else(|| r.get("default")))
        .and_then(|v| v.as_str())
        .unwrap_or("—");
    lines.push(Line::from(vec![
        Span::styled("  routing     ", Style::default().fg(MUTED)),
        Span::styled(routing_default, Style::default().fg(FG)),
    ]));

    // Firewall enabled indicator.
    let firewall_enabled = status
        .effective_config
        .as_ref()
        .and_then(|c| c.get("firewall"))
        .and_then(|f| f.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let (fw_icon, fw_style, fw_label) = if firewall_enabled {
        ("●", Style::default().fg(SUCCESS), "enabled")
    } else {
        ("○", Style::default().fg(MUTED), "disabled")
    };
    lines.push(Line::from(vec![
        Span::styled("  firewall    ", Style::default().fg(MUTED)),
        Span::styled(fw_icon, fw_style),
        Span::styled(format!(" {fw_label}"), Style::default().fg(FG)),
    ]));

    // DLP (PII) indicator.
    let dlp_enabled = status
        .effective_config
        .as_ref()
        .and_then(|c| c.get("dlp").or_else(|| c.get("pii")))
        .and_then(|d| d.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let (dlp_icon, dlp_style, dlp_label) = if dlp_enabled {
        ("●", Style::default().fg(SUCCESS), "enabled")
    } else {
        ("○", Style::default().fg(MUTED), "disabled")
    };
    lines.push(Line::from(vec![
        Span::styled("  dlp         ", Style::default().fg(MUTED)),
        Span::styled(dlp_icon, dlp_style),
        Span::styled(format!(" {dlp_label}"), Style::default().fg(FG)),
    ]));

    // Budget indicator.
    let budget_enabled = status
        .effective_config
        .as_ref()
        .and_then(|c| c.get("budget"))
        .and_then(|b| b.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let (bud_icon, bud_style, bud_label) = if budget_enabled {
        ("●", Style::default().fg(SUCCESS), "enabled")
    } else {
        ("○", Style::default().fg(MUTED), "disabled")
    };
    lines.push(Line::from(vec![
        Span::styled("  budget      ", Style::default().fg(MUTED)),
        Span::styled(bud_icon, bud_style),
        Span::styled(format!(" {bud_label}"), Style::default().fg(FG)),
    ]));

    // If reachable, show a request-count metric from /metrics (if present).
    if status.reachable {
        if let Some(total) = status
            .metrics
            .as_ref()
            .and_then(|m| m.get("requests_total").or_else(|| m.get("total_requests")))
            .and_then(|v| v.as_u64())
        {
            lines.push(Line::from(""));
            lines.push(Line::from(vec![
                Span::styled("  requests    ", Style::default().fg(MUTED)),
                Span::styled(total.to_string(), Style::default().fg(FG)),
            ]));
        }
    }

    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  read-only — edit gateway policy in the desktop app",
        Style::default().fg(MUTED),
    )));

    f.render_widget(Paragraph::new(lines), inner);
}

fn render_workflows_content(f: &mut Frame, area: Rect, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " Workflows",
                Style::default().fg(FG).add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                "  \u{2191}\u{2193} nav \u{b7} enter run \u{b7} r refresh \u{b7} esc clear",
                Style::default().fg(MUTED),
            ),
        ])),
        chunks[0],
    );

    let body = chunks[1];

    if !app.core_connected && app.workflows_list.is_empty() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                " core not running",
                Style::default().fg(MUTED),
            ))),
            body,
        );
        return;
    }

    if app.workflows_list.is_empty() {
        let body_block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(MUTED));
        let inner = body_block.inner(body);
        f.render_widget(body_block, body);
        f.render_widget(
            Paragraph::new(vec![
                Line::from(""),
                Line::from(Span::styled(
                    "  no workflows configured \u{2014} press r to refresh",
                    Style::default().fg(MUTED),
                )),
            ]),
            inner,
        );
        return;
    }

    // Split body: left list (40%) + right detail/run pane.
    let list_width = (body.width * 2 / 5)
        .max(22)
        .min(body.width.saturating_sub(2));
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(list_width), Constraint::Min(1)])
        .split(body);

    let list_area = columns[0];
    let detail_area = columns[1];

    // Workflow list
    let sel = app
        .workflows_tab_index
        .min(app.workflows_list.len().saturating_sub(1));
    let mut items: Vec<ListItem> = Vec::with_capacity(app.workflows_list.len());
    for (i, wf) in app.workflows_list.iter().enumerate() {
        let is_selected = i == sel;
        let name_style = if is_selected {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(FG)
        };
        let mut wf_lines: Vec<Line> = Vec::new();
        wf_lines.push(Line::from(Span::styled(
            format!(" {}", wf.name),
            name_style,
        )));
        if let Some(desc) = &wf.description {
            wf_lines.push(Line::from(Span::styled(
                format!("  {}", desc),
                Style::default().fg(MUTED),
            )));
        }
        items.push(ListItem::new(wf_lines));
    }

    let mut list_state = ratatui::widgets::ListState::default();
    list_state.select(Some(sel));

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED))
                .title(Span::styled(" workflows ", Style::default().fg(MUTED))),
        )
        .highlight_style(Style::default().bg(HIGHLIGHT_BG))
        .highlight_symbol("");

    f.render_stateful_widget(list, list_area, &mut list_state);

    // Run / status pane
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(MUTED))
        .title(Span::styled(" run status ", Style::default().fg(MUTED)));
    let inner = block.inner(detail_area);
    f.render_widget(block, detail_area);

    let mut detail_lines: Vec<Line> = Vec::new();

    if let Some(wf) = app.workflows_list.get(sel) {
        detail_lines.push(Line::from(vec![
            Span::styled(" id    ", Style::default().fg(MUTED)),
            Span::styled(wf.id.clone(), Style::default().fg(MUTED)),
        ]));
        detail_lines.push(Line::from(vec![
            Span::styled(" name  ", Style::default().fg(MUTED)),
            Span::styled(
                wf.name.clone(),
                Style::default().fg(FG).add_modifier(Modifier::BOLD),
            ),
        ]));
        if let Some(desc) = &wf.description {
            detail_lines.push(Line::from(vec![
                Span::styled(" desc  ", Style::default().fg(MUTED)),
                Span::styled(desc.clone(), Style::default().fg(MUTED)),
            ]));
        }
        detail_lines.push(Line::from(""));
    }

    if app.workflow_confirm_pending {
        detail_lines.push(Line::from(Span::styled(
            " Press enter to confirm run, esc to cancel",
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )));
    } else if app.workflow_run_loading {
        detail_lines.push(Line::from(Span::styled(
            " polling run status\u{2026}",
            Style::default().fg(ACCENT),
        )));
    } else if let Some(err) = &app.workflow_run_error {
        detail_lines.push(Line::from(Span::styled(
            format!(" error: {err}"),
            Style::default().fg(DANGER),
        )));
    } else if let Some(run_id) = &app.workflow_run_id {
        let state = app.workflow_run_state.as_deref().unwrap_or("unknown");
        let (state_icon, state_style) = match state {
            "completed" => ("\u{2713}", Style::default().fg(SUCCESS)),
            "failed" => ("\u{2717}", Style::default().fg(DANGER)),
            "running" => (
                spinner_frame(app.animation_tick),
                Style::default().fg(ACCENT),
            ),
            _ => ("\u{25cb}", Style::default().fg(MUTED)),
        };
        detail_lines.push(Line::from(vec![
            Span::styled(" run    ", Style::default().fg(MUTED)),
            Span::styled(run_id.clone(), Style::default().fg(MUTED)),
        ]));
        detail_lines.push(Line::from(vec![
            Span::styled(" state  ", Style::default().fg(MUTED)),
            Span::styled(format!("{state_icon} {state}"), state_style),
        ]));
        if let Some(output) = &app.workflow_run_output {
            detail_lines.push(Line::from(""));
            detail_lines.push(Line::from(Span::styled(
                " output",
                Style::default().fg(MUTED),
            )));
            for output_line in output.lines().take(10) {
                detail_lines.push(Line::from(Span::styled(
                    format!("   {output_line}"),
                    Style::default().fg(FG),
                )));
            }
        }
    } else {
        detail_lines.push(Line::from(Span::styled(
            " select a workflow and press enter to run it",
            Style::default().fg(MUTED),
        )));
    }

    f.render_widget(Paragraph::new(detail_lines), inner);
}

fn render_spaces_content(f: &mut Frame, area: Rect, app: &mut App) {
    // Layout: header (2) | top split [spaces+docs (60%) | conversations (40%)]
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            " Spaces",
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        ))),
        chunks[0],
    );

    let body = chunks[1];

    // Horizontal split: left = spaces + documents, right = conversations
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Ratio(3, 5), Constraint::Ratio(2, 5)])
        .split(body);

    let left_area = cols[0];
    let right_area = cols[1];

    // ── Left: spaces list + selected space documents ──────────────────────────

    let left_chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Ratio(1, 2), Constraint::Ratio(1, 2)])
        .split(left_area);

    let spaces_area = left_chunks[0];
    let docs_area = left_chunks[1];

    // Spaces list
    let spaces_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(MUTED))
        .title(Span::styled(" spaces ", Style::default().fg(MUTED)));
    let spaces_inner = spaces_block.inner(spaces_area);
    f.render_widget(spaces_block, spaces_area);

    if app.spaces.is_empty() {
        f.render_widget(
            Paragraph::new(vec![
                Line::from(""),
                Line::from(Span::styled(
                    "  no spaces — create one in the desktop app",
                    Style::default().fg(MUTED),
                )),
            ]),
            spaces_inner,
        );
    } else {
        let mut space_items: Vec<ListItem> = Vec::with_capacity(app.spaces.len());
        for (i, space) in app.spaces.iter().enumerate() {
            let is_selected = i == app.spaces_tab_index;
            let name_style = if is_selected {
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(FG)
            };
            let doc_count = space
                .document_count
                .map(|n| format!(" ({n} docs)"))
                .unwrap_or_default();
            space_items.push(ListItem::new(Line::from(vec![
                Span::styled(format!(" {}", space.name), name_style),
                Span::styled(doc_count, Style::default().fg(MUTED)),
            ])));
        }
        let mut list_state = ratatui::widgets::ListState::default();
        list_state.select(Some(
            app.spaces_tab_index.min(app.spaces.len().saturating_sub(1)),
        ));
        let list = List::new(space_items)
            .highlight_style(Style::default().bg(HIGHLIGHT_BG))
            .highlight_symbol("");
        f.render_stateful_widget(list, spaces_inner, &mut list_state);
    }

    // Documents for selected space
    let docs_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(MUTED))
        .title(Span::styled(" documents ", Style::default().fg(MUTED)));
    let docs_inner = docs_block.inner(docs_area);
    f.render_widget(docs_block, docs_area);

    let selected_space_id = app.spaces.get(app.spaces_tab_index).map(|s| s.id.clone());
    let docs = selected_space_id
        .as_deref()
        .and_then(|id| app.space_documents.get(id));

    match docs {
        None => {
            f.render_widget(
                Paragraph::new(vec![
                    Line::from(""),
                    Line::from(Span::styled(
                        if app.spaces.is_empty() {
                            "  select a space to see documents"
                        } else {
                            "  loading documents…"
                        },
                        Style::default().fg(MUTED),
                    )),
                ]),
                docs_inner,
            );
        }
        Some(docs) if docs.is_empty() => {
            f.render_widget(
                Paragraph::new(vec![
                    Line::from(""),
                    Line::from(Span::styled(
                        "  no documents in this space",
                        Style::default().fg(MUTED),
                    )),
                ]),
                docs_inner,
            );
        }
        Some(docs) => {
            let mut lines: Vec<Line> = Vec::with_capacity(docs.len());
            for doc in docs {
                let size_label = doc
                    .size
                    .map(|b| {
                        if b >= 1024 * 1024 {
                            format!(" {:.1}MB", b as f64 / (1024.0 * 1024.0))
                        } else if b >= 1024 {
                            format!(" {:.1}KB", b as f64 / 1024.0)
                        } else {
                            format!(" {b}B")
                        }
                    })
                    .unwrap_or_default();
                lines.push(Line::from(vec![
                    Span::styled(format!(" {}", doc.name), Style::default().fg(FG)),
                    Span::styled(size_label, Style::default().fg(MUTED)),
                ]));
            }
            f.render_widget(Paragraph::new(lines), docs_inner);
        }
    }

    // ── Right: conversations ──────────────────────────────────────────────────

    let conv_block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(MUTED))
        .title(Span::styled(" history ", Style::default().fg(MUTED)));
    let conv_inner = conv_block.inner(right_area);
    f.render_widget(conv_block, right_area);

    if app.conversations.is_empty() {
        f.render_widget(
            Paragraph::new(vec![
                Line::from(""),
                Line::from(Span::styled(
                    "  no conversations yet",
                    Style::default().fg(MUTED),
                )),
            ]),
            conv_inner,
        );
    } else {
        let visible = conv_inner.height as usize;
        let total = app.conversations.len();
        let max_scroll = total.saturating_sub(visible);
        let scroll = app.spaces_scroll.min(max_scroll);

        let mut lines: Vec<Line> = Vec::with_capacity(total);
        for conv in &app.conversations {
            let title = conv
                .title
                .as_deref()
                .filter(|t| !t.is_empty())
                .unwrap_or("untitled");
            let msgs = conv
                .message_count
                .map(|n| format!(" {n}msg"))
                .unwrap_or_default();
            let date = conv
                .updated_at
                .as_deref()
                .and_then(|s| s.split('T').next())
                .map(|d| format!(" {d}"))
                .unwrap_or_default();
            lines.push(Line::from(vec![
                Span::styled(format!(" {title}"), Style::default().fg(FG)),
                Span::styled(format!("{msgs}{date}"), Style::default().fg(MUTED)),
            ]));
        }

        let display: Vec<Line> = if scroll < lines.len() {
            lines[scroll..].to_vec()
        } else {
            Vec::new()
        };
        f.render_widget(Paragraph::new(display), conv_inner);
    }
}

/// Engines tab: list from `GET /api/engines` with active marker, selection
/// POSTs `/api/engine/active`. No engine name is hardcoded in the CLI.
fn render_engines_content(f: &mut Frame, area: Rect, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    let active_name = app.engine_active.active.as_deref().unwrap_or("");
    let running = app.engine_active.running;

    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " Engines",
                Style::default().fg(FG).add_modifier(Modifier::BOLD),
            ),
            if !active_name.is_empty() {
                let (dot, dot_style) = if running {
                    ("●", Style::default().fg(SUCCESS))
                } else {
                    ("○", Style::default().fg(Color::Yellow))
                };
                Span::styled(format!("  active: "), Style::default().fg(MUTED))
            } else {
                Span::styled(
                    "  ↑↓ nav · enter activate · r refresh",
                    Style::default().fg(MUTED),
                )
            },
        ])),
        chunks[0],
    );

    // Overwrite the header with a richer active-engine line when we have one.
    if !active_name.is_empty() {
        let (dot, dot_style) = if running {
            ("●", Style::default().fg(SUCCESS))
        } else {
            ("○", Style::default().fg(Color::Yellow))
        };
        f.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    " Engines",
                    Style::default().fg(FG).add_modifier(Modifier::BOLD),
                ),
                Span::styled("  active: ", Style::default().fg(MUTED)),
                Span::styled(dot, dot_style),
                Span::styled(
                    format!(" {active_name}"),
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    "  ↑↓ nav · enter activate · r refresh",
                    Style::default().fg(MUTED),
                ),
            ])),
            chunks[0],
        );
    }

    let body = chunks[1];

    if !app.core_connected && app.engines_list.is_empty() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                " core not running",
                Style::default().fg(MUTED),
            ))),
            body,
        );
        return;
    }

    if app.engines_list.is_empty() {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(MUTED));
        let inner = block.inner(body);
        f.render_widget(block, body);
        f.render_widget(
            Paragraph::new(vec![
                Line::from(""),
                Line::from(Span::styled(
                    "  no engines found — press r to refresh",
                    Style::default().fg(MUTED),
                )),
            ]),
            inner,
        );
        return;
    }

    let sel = app
        .engines_tab_index
        .min(app.engines_list.len().saturating_sub(1));
    let mut items: Vec<ListItem> = Vec::with_capacity(app.engines_list.len());
    for (i, eng) in app.engines_list.iter().enumerate() {
        let is_sel = i == sel;
        let is_active = eng.active;
        let installed = eng.installed.unwrap_or(false);

        let name_style = if is_sel {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(FG)
        };

        let (status_icon, status_style) = if is_active && running {
            ("●", Style::default().fg(SUCCESS))
        } else if is_active {
            ("○", Style::default().fg(Color::Yellow))
        } else if installed {
            (" ", Style::default().fg(MUTED))
        } else {
            ("-", Style::default().fg(MUTED))
        };

        let active_label = if is_active { " [active]" } else { "" };

        let mut line_spans = vec![
            Span::styled(format!(" {status_icon} "), status_style),
            Span::styled(format!("{:<18}", eng.name), name_style),
            Span::styled(
                if installed {
                    "installed"
                } else {
                    "not installed"
                },
                if installed {
                    Style::default().fg(SUCCESS)
                } else {
                    Style::default().fg(MUTED)
                },
            ),
            Span::styled(
                active_label,
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
            ),
        ];

        if let Some(desc) = &eng.description {
            let short = if desc.len() > 30 {
                format!("  {}…", &desc[..29])
            } else {
                format!("  {desc}")
            };
            line_spans.push(Span::styled(short, Style::default().fg(MUTED)));
        }

        items.push(ListItem::new(Line::from(line_spans)));
    }

    let mut list_state = ratatui::widgets::ListState::default();
    list_state.select(Some(sel));

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED))
                .title(Span::styled(" engines ", Style::default().fg(MUTED))),
        )
        .highlight_style(Style::default().bg(HIGHLIGHT_BG))
        .highlight_symbol("");

    f.render_stateful_widget(list, body, &mut list_state);
}

/// Schedules tab: read-only list from `GET /heartbeat/jobs`.
/// No schedule is hardcoded — all rows come from Core.
fn render_schedules_content(f: &mut Frame, area: Rect, app: &mut App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " Schedules",
                Style::default().fg(FG).add_modifier(Modifier::BOLD),
            ),
            Span::styled("  ↑↓ nav · r refresh", Style::default().fg(MUTED)),
        ])),
        chunks[0],
    );

    let body = chunks[1];

    if !app.core_connected && app.scheduled_jobs.is_empty() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                " core not running",
                Style::default().fg(MUTED),
            ))),
            body,
        );
        return;
    }

    if app.scheduled_jobs.is_empty() {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(MUTED));
        let inner = block.inner(body);
        f.render_widget(block, body);
        f.render_widget(
            Paragraph::new(vec![
                Line::from(""),
                Line::from(Span::styled(
                    "  no scheduled jobs — press r to refresh",
                    Style::default().fg(MUTED),
                )),
            ]),
            inner,
        );
        return;
    }

    let sel = app
        .schedules_tab_index
        .min(app.scheduled_jobs.len().saturating_sub(1));
    let mut items: Vec<ListItem> = Vec::with_capacity(app.scheduled_jobs.len());

    for (i, job) in app.scheduled_jobs.iter().enumerate() {
        let is_sel = i == sel;
        let name_style = if is_sel {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(FG)
        };

        let (enabled_icon, enabled_style) = if job.enabled {
            ("●", Style::default().fg(SUCCESS))
        } else {
            ("○", Style::default().fg(MUTED))
        };

        let schedule_str = job
            .schedule
            .as_ref()
            .map(|s| match s {
                serde_json::Value::Object(m) => {
                    if let Some(expr) = m.get("expr").and_then(|v| v.as_str()) {
                        expr.to_string()
                    } else if let Some(interval) = m.get("interval").and_then(|v| v.as_str()) {
                        format!("every {interval}")
                    } else {
                        s.to_string()
                    }
                }
                other => other.to_string(),
            })
            .unwrap_or_else(|| "—".to_string());

        let last_run = job
            .last_run_at
            .as_deref()
            .and_then(|s| s.split('T').next())
            .unwrap_or("—");

        let outcome_span = match job.last_outcome.as_deref() {
            Some("success") => Span::styled("✓", Style::default().fg(SUCCESS)),
            Some("failure") => Span::styled("✗", Style::default().fg(DANGER)),
            _ => Span::styled("—", Style::default().fg(MUTED)),
        };

        let line = Line::from(vec![
            Span::styled(format!(" {enabled_icon} "), enabled_style),
            Span::styled(format!("{:<20}", job.name), name_style),
            Span::styled(format!(" {:<22}", schedule_str), Style::default().fg(MUTED)),
            outcome_span,
            Span::styled(format!("  {last_run}"), Style::default().fg(MUTED)),
        ]);
        items.push(ListItem::new(line));
    }

    let mut list_state = ratatui::widgets::ListState::default();
    list_state.select(Some(sel));

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED))
                .title(Span::styled(" scheduled jobs ", Style::default().fg(MUTED))),
        )
        .highlight_style(Style::default().bg(HIGHLIGHT_BG))
        .highlight_symbol("");

    f.render_stateful_widget(list, body, &mut list_state);
}

/// Truncate `s` to at most `n` display chars, appending an ellipsis when cut.
fn trunc(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let t: String = s.chars().take(n.saturating_sub(1)).collect();
    format!("{t}…")
}

/// Generic renderer for every data-driven list tab (Models / Skills / Tools /
/// Monitors / Teams / Meetings / Recipes). Reads the tab's [`SimpleListTab`]
/// state and shows a title + per-tab key hint + a selectable list.
fn render_feature_tab(f: &mut Frame, area: Rect, app: &App, tab: SidebarTab) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    let title = tab.label();
    let action_hint = match tab {
        SidebarTab::Models => "↑↓ nav · enter install · a use · r refresh",
        SidebarTab::Skills => "↑↓ nav · enter install · a activate · r refresh",
        SidebarTab::Monitors => "↑↓ nav · enter check now · r refresh",
        SidebarTab::Recipes => "↑↓ nav · enter replay · r refresh",
        _ => "↑↓ nav · r refresh (browse)",
    };
    let mut header = vec![
        Span::styled(
            format!(" {title}"),
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!("  {action_hint}"), Style::default().fg(MUTED)),
    ];
    let state = app.feature_tabs.get(&tab);
    if let Some(notice) = state.and_then(|s| s.notice.as_ref()) {
        header.push(Span::styled(
            format!("  · {notice}"),
            Style::default().fg(ACCENT),
        ));
    }
    f.render_widget(Paragraph::new(Line::from(header)), chunks[0]);

    let body = chunks[1];
    let new_block = || {
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(MUTED))
    };

    let placeholder = |f: &mut Frame, msg: &str, color: Color| {
        f.render_widget(
            Paragraph::new(vec![
                Line::from(""),
                Line::from(Span::styled(format!("  {msg}"), Style::default().fg(color))),
            ])
            .block(new_block()),
            body,
        );
    };

    let Some(state) = state else {
        placeholder(f, "Loading…", MUTED);
        return;
    };
    if let Some(err) = &state.error {
        placeholder(f, &format!("error: {err}"), DANGER);
        return;
    }
    if state.rows.is_empty() {
        if state.loading || !state.loaded {
            placeholder(f, "Loading…", MUTED);
        } else {
            placeholder(f, "nothing here — press r to refresh", MUTED);
        }
        return;
    }

    let sel = state.index.min(state.rows.len() - 1);
    let items: Vec<ListItem> = state
        .rows
        .iter()
        .enumerate()
        .map(|(i, row)| {
            let name_style = if i == sel {
                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(FG)
            };
            let mut spans = vec![Span::styled(
                format!(" {:<30}", trunc(&row.title, 30)),
                name_style,
            )];
            if !row.badge.is_empty() {
                spans.push(Span::styled(
                    format!("[{}] ", trunc(&row.badge, 14)),
                    Style::default().fg(SUCCESS),
                ));
            }
            if !row.subtitle.is_empty() {
                spans.push(Span::styled(
                    trunc(&row.subtitle, 58),
                    Style::default().fg(MUTED),
                ));
            }
            ListItem::new(Line::from(spans))
        })
        .collect();

    let mut list_state = ratatui::widgets::ListState::default();
    list_state.select(Some(sel));
    let list = List::new(items)
        .block(new_block().title(Span::styled(
            format!(" {} ({}) ", title.to_lowercase(), state.rows.len()),
            Style::default().fg(MUTED),
        )))
        .highlight_style(Style::default().bg(HIGHLIGHT_BG));
    f.render_stateful_widget(list, body, &mut list_state);
}

// ── Chat tab content ──────────────────────────────────────────────────────────

fn render_chat_content(f: &mut Frame, area: Rect, app: &mut App) {
    // A status bar appears above the composer whenever a goal is active, the
    // double-check is armed, or a model/team override is set.
    let show_status = app.chat_goal.condition.is_some()
        || app.double_check_on
        || app.selected_model.is_some()
        || app.selected_team.is_some();
    let constraints: &[Constraint] = if show_status {
        &[
            Constraint::Length(2), // header
            Constraint::Min(1),    // messages
            Constraint::Length(1), // status bar
            Constraint::Length(3), // composer
        ]
    } else {
        &[
            Constraint::Length(2), // header
            Constraint::Min(1),    // messages
            Constraint::Length(3), // composer
        ]
    };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints(constraints.to_vec())
        .split(area);

    let header_area = chunks[0];
    let msg_area = chunks[1];
    let (status_area, composer_area) = if show_status {
        (Some(chunks[2]), chunks[3])
    } else {
        (None, chunks[2])
    };

    app.click_regions.chat_messages_area = Some(msg_area);
    app.click_regions.chat_composer_area = Some(composer_area);

    let msg_hovered = mouse_in(app, msg_area);
    let msg_border_style = if msg_hovered {
        Style::default().fg(Color::Rgb(60, 60, 80))
    } else {
        Style::default().fg(MUTED)
    };

    // Header shows the active agent and its Core-resolved engine, so the user
    // always knows what they are talking to.
    let mut header_spans = vec![Span::styled(
        " Chat",
        Style::default().fg(FG).add_modifier(Modifier::BOLD),
    )];
    if let Some(team) = &app.selected_team {
        // A team routing target wins over a single agent.
        header_spans.push(Span::styled(
            format!("  @{team}"),
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ));
    } else {
        match &app.selected_agent {
            Some(id) => {
                let agent = app.agents_list.iter().find(|a| &a.id == id);
                let label = agent.map_or(id.as_str(), |a| a.name.as_str());
                header_spans.push(Span::styled(
                    format!("  {label}"),
                    Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                ));
                if let Some(engine) = agent.and_then(|a| a.engine.as_deref()) {
                    header_spans.push(Span::styled(
                        format!(" → {engine}"),
                        Style::default().fg(MUTED),
                    ));
                }
            }
            None => header_spans.push(Span::styled("  Default agent", Style::default().fg(MUTED))),
        }
    }
    header_spans.push(Span::styled(
        "  ·  ^p palette · ^a agent · /goal /check /model /team /sessions /btw",
        Style::default().fg(MUTED),
    ));
    f.render_widget(Paragraph::new(Line::from(header_spans)), header_area);

    let mut all_lines: Vec<Line<'static>> = Vec::new();

    if app.chat.messages.is_empty() {
        all_lines.push(Line::from(Span::styled(
            "  No messages yet. Type below and press Enter.",
            Style::default().fg(MUTED),
        )));
    }

    for (i, msg) in app.chat.messages.iter().enumerate() {
        let is_last = i == app.chat.messages.len() - 1;
        let is_streaming_assistant = is_last && app.chat.streaming && msg.role == Role::Assistant;

        match msg.role {
            Role::User => {
                let content_lines: Vec<&str> = msg.content.lines().collect();
                for (li, line_text) in content_lines.iter().enumerate() {
                    if li == 0 {
                        all_lines.push(Line::from(vec![
                            Span::styled(
                                "You  ",
                                Style::default().fg(SUCCESS).add_modifier(Modifier::BOLD),
                            ),
                            Span::styled(line_text.to_string(), Style::default().fg(FG)),
                        ]));
                    } else {
                        all_lines.push(Line::from(vec![
                            Span::raw("     "),
                            Span::styled(line_text.to_string(), Style::default().fg(FG)),
                        ]));
                    }
                }
                if content_lines.is_empty() {
                    all_lines.push(Line::from(Span::styled(
                        "You  ",
                        Style::default().fg(SUCCESS).add_modifier(Modifier::BOLD),
                    )));
                }
            }
            Role::Assistant => {
                let raw_content = if is_streaming_assistant && msg.content.is_empty() {
                    "▋".to_string()
                } else if is_streaming_assistant {
                    format!("{}▋", msg.content)
                } else {
                    msg.content.clone()
                };

                let content_lines: Vec<&str> = raw_content.lines().collect();
                for (li, line_text) in content_lines.iter().enumerate() {
                    if li == 0 {
                        all_lines.push(Line::from(vec![
                            Span::styled(
                                "AI   ",
                                Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                            ),
                            Span::styled(line_text.to_string(), Style::default().fg(FG)),
                        ]));
                    } else {
                        all_lines.push(Line::from(vec![
                            Span::raw("     "),
                            Span::styled(line_text.to_string(), Style::default().fg(FG)),
                        ]));
                    }
                }
                if content_lines.is_empty() {
                    all_lines.push(Line::from(Span::styled(
                        "AI   ▋",
                        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                    )));
                }
            }
        }

        all_lines.push(Line::from(""));
    }

    if let Some(err) = &app.chat.error {
        all_lines.push(Line::from(Span::styled(
            format!("  error: {err}"),
            Style::default().fg(DANGER),
        )));
    }

    let visible = msg_area.height.saturating_sub(2) as usize;
    let total = all_lines.len();
    let max_scroll = total.saturating_sub(visible);

    let scroll_y = if app.chat.auto_scroll {
        max_scroll
    } else {
        app.chat.scroll.min(max_scroll)
    };

    let display_lines: Vec<Line<'static>> = if scroll_y < all_lines.len() {
        all_lines[scroll_y..].to_vec()
    } else {
        Vec::new()
    };

    let msg_block = Block::default()
        .borders(Borders::ALL)
        .border_style(msg_border_style);
    f.render_widget(Paragraph::new(display_lines).block(msg_block), msg_area);

    let composer_hovered = mouse_in(app, composer_area);
    let (border_color, title_label) = if app.chat.streaming {
        (MUTED, " thinking… ")
    } else if composer_hovered {
        (ACCENT, " message (click to type) ")
    } else {
        (ACCENT, " message ")
    };

    let input_display = format!("> {}", app.chat.input);
    let composer = Paragraph::new(input_display).block(
        Block::default()
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color))
            .title(Span::styled(
                title_label,
                Style::default()
                    .fg(if composer_hovered && !app.chat.streaming {
                        HOVER_FG
                    } else {
                        border_color
                    })
                    .add_modifier(if composer_hovered {
                        Modifier::BOLD
                    } else {
                        Modifier::empty()
                    }),
            )),
    );
    f.render_widget(composer, composer_area);

    if let Some(status_area) = status_area {
        render_chat_status_bar(f, status_area, app);
    }

    if app.agent_picker_open {
        render_agent_picker(f, area, app);
    }
    if app.btw.open {
        render_btw_overlay(f, area, app);
    }
    if app.double_check.open {
        render_double_check_overlay(f, area, app);
    }
    if app.sessions_overlay.open {
        render_sessions_overlay(f, area, app);
    }
}

/// One-line status strip above the composer: active goal (+ live timer, turn
/// count, latest judge reason), the double-check arm, and model/team overrides.
fn render_chat_status_bar(f: &mut Frame, area: Rect, app: &App) {
    let mut spans: Vec<Span> = Vec::new();
    if let Some(cond) = &app.chat_goal.condition {
        let icon = if app.chat_goal.achieved {
            "✓"
        } else if app.chat_goal.judging {
            "…"
        } else {
            "◎"
        };
        let color = if app.chat_goal.achieved {
            SUCCESS
        } else {
            ACCENT
        };
        let mut label = format!(" {icon} goal: {cond}");
        if let Some(started) = app.chat_goal.started_at {
            let secs = started.elapsed().as_secs();
            label.push_str(&format!(
                "  ({}m{:02}s · turn {}/{})",
                secs / 60,
                secs % 60,
                app.chat_goal.turns,
                crate::app::MAX_GOAL_TURNS
            ));
        }
        spans.push(Span::styled(
            label,
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ));
        if let Some(reason) = &app.chat_goal.last_reason {
            let trimmed: String = reason.chars().take(60).collect();
            spans.push(Span::styled(
                format!(" — {trimmed}"),
                Style::default().fg(MUTED),
            ));
        }
    }
    if app.double_check_on {
        spans.push(Span::styled(
            "  ✓✓ double-check",
            Style::default().fg(SUCCESS),
        ));
    }
    if let Some(model) = &app.selected_model {
        spans.push(Span::styled(
            format!("  ⚙ {model}"),
            Style::default().fg(MUTED),
        ));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}

/// Centered overlay showing the last double-check review (verdict + critique).
fn render_double_check_overlay(f: &mut Frame, area: Rect, app: &App) {
    let width = (area.width.saturating_mul(7) / 10)
        .clamp(40, 100)
        .min(area.width.saturating_sub(2));
    let height = (area.height.saturating_mul(6) / 10)
        .clamp(8, 26)
        .min(area.height)
        .max(1);
    let popup = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    };
    f.render_widget(Clear, popup);

    let (title, title_color) = match (app.double_check.loading, app.double_check.ok) {
        (true, _) => (" Double-check · reviewing… ", ACCENT),
        (false, Some(true)) => (" Double-check · ✓ no issues ", SUCCESS),
        (false, Some(false)) => (" Double-check · ⚠ issue flagged ", DANGER),
        (false, None) => (" Double-check ", ACCENT),
    };

    let mut lines: Vec<Line<'static>> = Vec::new();
    if let Some(err) = &app.double_check.error {
        lines.push(Line::from(Span::styled(
            format!("error: {err}"),
            Style::default().fg(DANGER),
        )));
    } else if app.double_check.loading {
        lines.push(Line::from(Span::styled(
            "Reviewing the last answer…",
            Style::default().fg(MUTED),
        )));
    } else {
        for l in app.double_check.critique.lines() {
            lines.push(Line::from(Span::styled(
                l.to_string(),
                Style::default().fg(FG),
            )));
        }
        if !app.double_check.model.is_empty() {
            lines.push(Line::from(""));
            lines.push(Line::from(Span::styled(
                format!("reviewer: {}", app.double_check.model),
                Style::default().fg(MUTED),
            )));
        }
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Esc/Enter to dismiss · ↑↓ scroll",
        Style::default().fg(MUTED),
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(title_color))
        .title(Span::styled(
            title,
            Style::default()
                .fg(title_color)
                .add_modifier(Modifier::BOLD),
        ));
    f.render_widget(
        Paragraph::new(lines)
            .block(block)
            .wrap(Wrap { trim: false })
            .scroll((app.double_check.scroll, 0)),
        popup,
    );
}

/// Centered overlay listing the runs/sessions of the current conversation.
fn render_sessions_overlay(f: &mut Frame, area: Rect, app: &App) {
    let width = (area.width.saturating_mul(7) / 10)
        .clamp(40, 90)
        .min(area.width.saturating_sub(2));
    let height = (area.height.saturating_mul(6) / 10)
        .clamp(8, 26)
        .min(area.height)
        .max(1);
    let popup = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    };
    f.render_widget(Clear, popup);

    let mut items: Vec<ListItem> = Vec::new();
    if let Some(err) = &app.sessions_overlay.error {
        items.push(ListItem::new(Line::from(Span::styled(
            format!("error: {err}"),
            Style::default().fg(DANGER),
        ))));
    } else if app.sessions_overlay.loading {
        items.push(ListItem::new(Line::from(Span::styled(
            "Loading sessions…",
            Style::default().fg(MUTED),
        ))));
    } else if app.sessions_overlay.rows.is_empty() {
        items.push(ListItem::new(Line::from(Span::styled(
            "No runs recorded for this conversation yet.",
            Style::default().fg(MUTED),
        ))));
    } else {
        for (i, row) in app.sessions_overlay.rows.iter().enumerate() {
            let selected = i == app.sessions_overlay.index;
            let marker = if selected { "› " } else { "  " };
            let status_color = match row.status.as_str() {
                "completed" | "done" | "ok" => SUCCESS,
                "error" | "failed" => DANGER,
                _ => ACCENT,
            };
            let mut spans = vec![
                Span::styled(marker, Style::default().fg(ACCENT)),
                Span::styled(
                    format!(
                        "{:<10}",
                        if row.status.is_empty() {
                            "—"
                        } else {
                            &row.status
                        }
                    ),
                    Style::default().fg(status_color),
                ),
                Span::styled(format!(" {}", row.created_at), Style::default().fg(MUTED)),
            ];
            if !row.branch.is_empty() {
                spans.push(Span::styled(
                    format!("  ⎇ {}", row.branch),
                    Style::default().fg(MUTED),
                ));
            }
            items.push(ListItem::new(Line::from(spans)));
        }
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(ACCENT))
        .title(Span::styled(
            " Sessions · Esc to close ",
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        ));
    f.render_widget(List::new(items).block(block), popup);
}

/// Centered overlay for a `/btw` side question (Claude-Code-style). Shows the
/// question, a "Thinking…" state while in flight, then the ephemeral answer.
/// Dismissed with Space/Enter/Esc; the answer never enters the chat history.
fn render_btw_overlay(f: &mut Frame, area: Rect, app: &App) {
    let width = area.width.saturating_mul(7) / 10;
    let width = width.clamp(40, 100).min(area.width.saturating_sub(2));
    let height = (area.height.saturating_mul(7) / 10)
        .clamp(8, 30)
        .min(area.height)
        .max(1);
    let popup = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 2,
        width,
        height,
    };
    f.render_widget(Clear, popup);

    let body = if app.btw.loading {
        "Thinking…".to_owned()
    } else if let Some(err) = &app.btw.error {
        format!("Error: {err}")
    } else {
        app.btw.answer.clone().unwrap_or_default()
    };

    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(
            format!("Q: {}", app.btw.question),
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];
    for raw in body.lines() {
        lines.push(Line::from(raw.to_owned()));
    }

    let footer = Line::from(Span::styled(
        "Space/Enter/Esc dismiss · ↑/↓ scroll · not saved to history",
        Style::default().fg(Color::DarkGray),
    ));

    let paragraph = Paragraph::new(lines)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan))
                .title(" Side question (/btw) ")
                .title_bottom(footer),
        )
        .wrap(Wrap { trim: false })
        .scroll((app.btw.scroll, 0));
    f.render_widget(paragraph, popup);
}

// ── Agents tab ────────────────────────────────────────────────────────────────

/// Agents tab: left card list from `GET /api/agents` + right attribute pane.
/// All data comes from Core — no rows are hardcoded in the client.
fn render_agents_content(f: &mut Frame, area: Rect, app: &mut App) {
    // Header
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(2), Constraint::Min(1)])
        .split(area);

    f.render_widget(
        Paragraph::new(Line::from(vec![Span::styled(
            " Agents",
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        )])),
        chunks[0],
    );

    let body = chunks[1];

    if !app.core_connected && app.agents_list.is_empty() {
        f.render_widget(
            Paragraph::new(Line::from(vec![Span::styled(
                " core not running",
                Style::default().fg(MUTED),
            )])),
            body,
        );
        return;
    }

    if app.agents_list.is_empty() {
        f.render_widget(
            Paragraph::new(Line::from(vec![Span::styled(
                " no agents configured",
                Style::default().fg(MUTED),
            )])),
            body,
        );
        return;
    }

    // Split body: left list (40% of width, min 22 cols) + right detail pane.
    let list_width = (body.width * 2 / 5)
        .max(22)
        .min(body.width.saturating_sub(2));
    let columns = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(list_width), Constraint::Min(1)])
        .split(body);

    let list_area = columns[0];
    let detail_area = columns[1];

    // ── Card list ────────────────────────────────────────────────────────────
    let mut items: Vec<ListItem> = Vec::with_capacity(app.agents_list.len());
    for agent in &app.agents_list {
        let is_selected = items.len() == app.agents_tab_index;
        let name_style = if is_selected {
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(FG)
        };
        let mut lines: Vec<Line> = Vec::new();
        lines.push(Line::from(Span::styled(
            format!(" {}", agent.name),
            name_style,
        )));

        // Engine/transport badge on second line
        let mut badge_spans: Vec<Span> = Vec::new();
        badge_spans.push(Span::raw("  "));
        if let Some(engine) = &agent.engine {
            badge_spans.push(Span::styled(engine.clone(), Style::default().fg(MUTED)));
        }
        if let Some(transport) = &agent.transport {
            badge_spans.push(Span::styled(
                format!(" [{}]", transport),
                Style::default().fg(MUTED),
            ));
        }
        if agent.installed == Some(false) {
            badge_spans.push(Span::styled(" !", Style::default().fg(DANGER)));
        }
        lines.push(Line::from(badge_spans));

        items.push(ListItem::new(lines));
    }

    // Register click region for mouse interaction.
    app.click_regions.agent_list_area = Some(list_area);
    app.click_regions.agent_list_top_y = list_area.y + 1; // inside border

    let mut list_state = ratatui::widgets::ListState::default();
    let sel = app
        .agents_tab_index
        .min(app.agents_list.len().saturating_sub(1));
    list_state.select(Some(sel));

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED))
                .title(Span::styled(" agents ", Style::default().fg(MUTED))),
        )
        .highlight_style(Style::default().bg(HIGHLIGHT_BG))
        .highlight_symbol("");

    f.render_stateful_widget(list, list_area, &mut list_state);

    // ── Detail pane ──────────────────────────────────────────────────────────
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(MUTED))
        .title(Span::styled(" attributes ", Style::default().fg(MUTED)));
    let inner = block.inner(detail_area);
    f.render_widget(block, detail_area);

    if app.agent_detail_loading {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                " loading…",
                Style::default().fg(MUTED),
            ))),
            inner,
        );
        return;
    }

    if let Some(err) = &app.agent_detail_error.clone() {
        f.render_widget(
            Paragraph::new(Line::from(Span::styled(
                format!(" {}", err),
                Style::default().fg(DANGER),
            ))),
            inner,
        );
        return;
    }

    // Show summary from list data; if a detail was loaded, overlay tools.
    if let Some(agent) = app.agents_list.get(sel) {
        let mut lines: Vec<Line> = Vec::new();

        // Name
        lines.push(Line::from(vec![
            Span::styled(" name       ", Style::default().fg(MUTED)),
            Span::styled(
                agent.name.clone(),
                Style::default().fg(FG).add_modifier(Modifier::BOLD),
            ),
        ]));

        // Engine slot
        let engine_val = agent.engine.as_deref().unwrap_or("—");
        lines.push(Line::from(vec![
            Span::styled(" engine     ", Style::default().fg(MUTED)),
            Span::styled(engine_val, Style::default().fg(ACCENT)),
        ]));

        // Model slot
        let model_val = agent.model.as_deref().unwrap_or("—");
        lines.push(Line::from(vec![
            Span::styled(" model      ", Style::default().fg(MUTED)),
            Span::styled(model_val, Style::default().fg(FG)),
        ]));

        // Routing / gateway-bypass slot (policy-routing attribute)
        let routing_val = match agent.gateway_bypass {
            Some(true) => "direct (gateway bypass)",
            Some(false) => "via gateway",
            None => "via gateway",
        };
        lines.push(Line::from(vec![
            Span::styled(" routing    ", Style::default().fg(MUTED)),
            Span::styled(routing_val, Style::default().fg(FG)),
        ]));

        // Transport
        if let Some(transport) = &agent.transport {
            lines.push(Line::from(vec![
                Span::styled(" transport  ", Style::default().fg(MUTED)),
                Span::styled(transport.clone(), Style::default().fg(FG)),
            ]));
        }

        // Tools — from detail if loaded, else prompt to press enter
        lines.push(Line::from(Span::raw("")));
        if let Some(detail) = &app.agent_detail {
            if detail.id == agent.id {
                lines.push(Line::from(Span::styled(
                    " tools",
                    Style::default().fg(MUTED),
                )));
                if detail.tools.is_empty() {
                    lines.push(Line::from(Span::styled(
                        "   (none configured)",
                        Style::default().fg(MUTED),
                    )));
                } else {
                    for tool in &detail.tools {
                        lines.push(Line::from(Span::styled(
                            format!("   • {}", tool),
                            Style::default().fg(FG),
                        )));
                    }
                }
            } else {
                lines.push(Line::from(Span::styled(
                    " tools      press enter to load",
                    Style::default().fg(MUTED),
                )));
            }
        } else {
            lines.push(Line::from(Span::styled(
                " tools      press enter to load",
                Style::default().fg(MUTED),
            )));
        }

        // Description
        if let Some(desc) = &agent.description {
            lines.push(Line::from(Span::raw("")));
            lines.push(Line::from(vec![
                Span::styled(" desc       ", Style::default().fg(MUTED)),
                Span::styled(desc.clone(), Style::default().fg(MUTED)),
            ]));
        }

        f.render_widget(Paragraph::new(lines), inner);
    }
}

/// Modal list of Core-configured agents (plus a "Default" playground entry).
/// Each row shows the agent name and the engine Core bound it to.
fn render_agent_picker(f: &mut Frame, area: Rect, app: &App) {
    let row_count = app.agents_list.len() + 1;
    // Cap to the area: the `.max(3)` floor plus the `y + 1` offset can otherwise
    // push the popup past the bottom of a very short area and panic.
    let height = (row_count as u16 + 2)
        .min(area.height.saturating_sub(2))
        .max(3)
        .min(area.height.saturating_sub(1))
        .max(1);
    let width = area.width.saturating_sub(4).min(60);
    let popup = Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + 1,
        width,
        height,
    };

    f.render_widget(Clear, popup);

    let mut items: Vec<ListItem> = Vec::with_capacity(row_count);
    // Row 0: the no-agent default.
    items.push(ListItem::new(Line::from(vec![Span::styled(
        "Default (playground)",
        Style::default().fg(MUTED),
    )])));
    for agent in &app.agents_list {
        let mut spans = vec![Span::styled(
            agent.name.clone(),
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        )];
        if let Some(engine) = &agent.engine {
            spans.push(Span::styled(
                format!("  → {engine}"),
                Style::default().fg(ACCENT),
            ));
        }
        if let Some(transport) = &agent.transport {
            spans.push(Span::styled(
                format!("  [{transport}]"),
                Style::default().fg(MUTED),
            ));
        }
        if agent.installed == Some(false) {
            spans.push(Span::styled(
                "  (not installed)",
                Style::default().fg(MUTED),
            ));
        }
        if let Some(desc) = &agent.description {
            spans.push(Span::styled(
                format!("  — {desc}"),
                Style::default().fg(MUTED),
            ));
        }
        items.push(ListItem::new(Line::from(spans)));
    }

    let mut list_state = ratatui::widgets::ListState::default();
    list_state.select(Some(
        app.agent_picker_index.min(row_count.saturating_sub(1)),
    ));

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(ACCENT))
                .title(Span::styled(
                    " select agent · enter confirm · esc cancel · r refresh ",
                    Style::default().fg(ACCENT),
                )),
        )
        .highlight_style(
            Style::default()
                .bg(HIGHLIGHT_BG)
                .fg(HOVER_FG)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("› ");

    f.render_stateful_widget(list, popup, &mut list_state);
}

// ── Dependencies ──────────────────────────────────────────────────────────────

pub fn ui_setup_dependencies(f: &mut Frame, app: &mut App) {
    let r = layout(f, true);
    render_logo(f, r.header);

    let screen = app.current_screen.clone();
    render_steps(f, r.steps, &screen, app);

    let body = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(2),
            Constraint::Min(1),
        ])
        .split(r.body);

    f.render_widget(
        Paragraph::new(Span::styled(
            "System requirements",
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        )),
        body[0],
    );

    let caption = if app.deps_installing {
        let elapsed = app
            .deps_install_started
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0);
        format!(
            "all required · cannot be skipped  ·  installing {}  {}",
            fmt_elapsed(elapsed),
            spinner_frame(app.animation_tick)
        )
    } else {
        "all required · cannot be skipped".to_string()
    };
    f.render_widget(
        Paragraph::new(Span::styled(caption, Style::default().fg(MUTED))),
        body[1],
    );

    let dep_list_area = body[2];
    app.click_regions.wizard_list_area = Some(dep_list_area);
    app.click_regions.wizard_list_top_y = dep_list_area.y + 1;

    let deps_snapshot: Vec<(String, bool)> = app
        .dependencies
        .iter()
        .map(|s| (s.name.clone(), s.installed))
        .collect();

    let items: Vec<ListItem> = deps_snapshot
        .iter()
        .enumerate()
        .map(|(row_i, (name, installed))| {
            let row_rect = Rect::new(
                dep_list_area.x,
                dep_list_area.y + 1 + row_i as u16,
                dep_list_area.width,
                1,
            );
            let hovered = mouse_in(app, row_rect);
            let row_bg = if hovered { HOVER_BG } else { Color::Reset };

            let (icon, icon_style, status_span) = if *installed {
                (
                    "✓",
                    Style::default().fg(SUCCESS).bg(row_bg),
                    Span::styled("installed", Style::default().fg(SUCCESS).bg(row_bg)),
                )
            } else if app.deps_installing {
                let frame = spinner_frame(app.animation_tick);
                (
                    frame,
                    Style::default()
                        .fg(ACCENT)
                        .bg(row_bg)
                        .add_modifier(Modifier::BOLD),
                    Span::styled("installing…", Style::default().fg(MUTED).bg(row_bg)),
                )
            } else {
                (
                    "✗",
                    Style::default().fg(DANGER).bg(row_bg),
                    Span::styled("not found", Style::default().fg(MUTED).bg(row_bg)),
                )
            };

            Line::from(vec![
                Span::styled(format!("  {} ", icon), icon_style),
                Span::styled(
                    format!("{:<14}", name),
                    Style::default()
                        .fg(if hovered { HOVER_FG } else { FG })
                        .bg(row_bg),
                ),
                status_span,
            ])
            .into()
        })
        .collect();

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED)),
        )
        .highlight_style(
            Style::default()
                .bg(HIGHLIGHT_BG)
                .add_modifier(Modifier::BOLD),
        );
    f.render_stateful_widget(list, dep_list_area, &mut app.list_state.clone());

    render_hints(
        f,
        r.hints,
        &[
            ("r", "refresh", HintAction::Refresh),
            ("i", "install", HintAction::InstallDeps),
            ("←  →", "prev / next", HintAction::NextStep),
            ("q", "quit", HintAction::Quit),
        ],
        app,
    );
}

// ── Providers ─────────────────────────────────────────────────────────────────

pub fn ui_setup_providers(f: &mut Frame, app: &mut App) {
    render_selection_screen(
        f,
        app,
        "Choose a local LLM provider",
        "Pick one  ·  space to select",
    );
}

// ── Tools ─────────────────────────────────────────────────────────────────────

pub fn ui_setup_tools(f: &mut Frame, app: &mut App) {
    render_selection_screen(
        f,
        app,
        "Choose optional tools",
        "Pick any  ·  space to toggle",
    );
}

// ── Agents ────────────────────────────────────────────────────────────────────

pub fn ui_setup_agents(f: &mut Frame, app: &mut App) {
    render_selection_screen(
        f,
        app,
        "Choose an AI agent",
        "Pick one  ·  space to select  ·  → or enter to install",
    );
}

// ── Shared selection renderer ─────────────────────────────────────────────────

fn render_selection_screen(f: &mut Frame, app: &mut App, heading: &str, caption: &str) {
    let items_data: Vec<crate::app::SidecarInfo> = match app.current_screen {
        Screen::SetupProviders => app.providers.clone(),
        Screen::SetupTools => app.tools.clone(),
        Screen::SetupAgents => app.agents.clone(),
        _ => Vec::new(),
    };

    let r = layout(f, true);
    render_logo(f, r.header);

    let screen = app.current_screen.clone();
    render_steps(f, r.steps, &screen, app);

    let body = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(1),
            Constraint::Length(2),
            Constraint::Min(1),
        ])
        .split(r.body);

    f.render_widget(
        Paragraph::new(Span::styled(
            heading,
            Style::default().fg(FG).add_modifier(Modifier::BOLD),
        )),
        body[0],
    );

    f.render_widget(
        Paragraph::new(Span::styled(caption, Style::default().fg(MUTED))),
        body[1],
    );

    let wiz_list_area = body[2];
    app.click_regions.wizard_list_area = Some(wiz_list_area);
    app.click_regions.wizard_list_top_y = wiz_list_area.y + 1;

    let items: Vec<ListItem> = items_data
        .iter()
        .enumerate()
        .map(|(row_i, s)| {
            let unavailable = !s.supported;
            let row_rect = Rect::new(
                wiz_list_area.x,
                wiz_list_area.y + 1 + row_i as u16,
                wiz_list_area.width,
                1,
            );
            let hovered = mouse_in(app, row_rect);
            let row_bg = if hovered && !unavailable {
                HOVER_BG
            } else {
                Color::Reset
            };

            let (marker, marker_style) = if unavailable || !s.selected {
                ("◇", Style::default().fg(MUTED).bg(row_bg))
            } else {
                (
                    "◆",
                    Style::default()
                        .fg(ACCENT)
                        .bg(row_bg)
                        .add_modifier(Modifier::BOLD),
                )
            };

            let name_style = if unavailable {
                Style::default().fg(MUTED).bg(row_bg)
            } else if s.selected {
                Style::default()
                    .fg(FG)
                    .bg(row_bg)
                    .add_modifier(Modifier::BOLD)
            } else if hovered {
                Style::default().fg(HOVER_FG).bg(row_bg)
            } else {
                Style::default().fg(FG).bg(row_bg)
            };

            let mut spans = vec![
                Span::styled("  ", Style::default().bg(row_bg)),
                Span::styled(marker, marker_style),
                Span::styled(" ", Style::default().bg(row_bg)),
                Span::styled(format!("{:<16}", s.name), name_style),
            ];

            if unavailable {
                spans.push(Span::styled(
                    "unsupported on this platform",
                    Style::default().fg(MUTED).bg(row_bg),
                ));
            } else if s.installed {
                spans.push(Span::styled(
                    "installed",
                    Style::default().fg(SUCCESS).bg(row_bg),
                ));
            } else if !s.description.is_empty() {
                spans.push(Span::styled(
                    s.description.as_str(),
                    Style::default().fg(MUTED).bg(row_bg),
                ));
            }

            Line::from(spans).into()
        })
        .collect();

    let list = List::new(items)
        .block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED)),
        )
        .highlight_style(
            Style::default()
                .bg(HIGHLIGHT_BG)
                .add_modifier(Modifier::BOLD),
        );

    f.render_stateful_widget(list, wiz_list_area, &mut app.list_state.clone());

    render_hints(
        f,
        r.hints,
        &[
            ("↑↓", "move", HintAction::NavUp),
            ("space", "pick", HintAction::Pick),
            ("←  →", "prev / next", HintAction::NextStep),
            ("q", "quit", HintAction::Quit),
        ],
        app,
    );
}

// ── Spinner ───────────────────────────────────────────────────────────────────

const SPINNER: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

fn spinner_frame(tick: u64) -> &'static str {
    SPINNER[(tick as usize) % SPINNER.len()]
}

fn fmt_elapsed(secs: u64) -> String {
    if secs < 60 {
        format!("{}s", secs)
    } else {
        format!("{}m {}s", secs / 60, secs % 60)
    }
}

// ── Complete ──────────────────────────────────────────────────────────────────

pub fn ui_complete(f: &mut Frame, app: &mut App) {
    let r = layout(f, false);
    render_logo(f, r.header);

    let body = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(2),
            Constraint::Min(1),
            Constraint::Length(1),
        ])
        .split(r.body);

    let elapsed_secs = app
        .install_started_at
        .map(|t| t.elapsed().as_secs())
        .unwrap_or(0);

    let all_sidecars_ref: Vec<&crate::app::SidecarInfo> = app.all_sidecars().collect();
    let all_done = app.install_results.is_empty()
        || app.install_results.iter().all(|(name, queued)| {
            !queued
                || all_sidecars_ref
                    .iter()
                    .find(|s| &s.name == name)
                    .map(|s| s.installed)
                    .unwrap_or(false)
        });

    let heading_text = if app.install_results.is_empty() {
        Span::styled(
            "nothing selected",
            Style::default().fg(MUTED).add_modifier(Modifier::BOLD),
        )
    } else if all_done {
        Span::styled(
            "all done",
            Style::default().fg(SUCCESS).add_modifier(Modifier::BOLD),
        )
    } else {
        Span::styled(
            format!("installing  {}", fmt_elapsed(elapsed_secs)),
            Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
        )
    };

    f.render_widget(Paragraph::new(heading_text), body[0]);

    let mut lines: Vec<Line> = vec![];

    if app.install_results.is_empty() {
        lines.push(Line::from(Span::styled(
            "  no sidecars were selected",
            Style::default().fg(MUTED),
        )));
    } else {
        for (name, queued) in &app.install_results {
            let installed = all_sidecars_ref
                .iter()
                .find(|s| &s.name == name)
                .map(|s| s.installed)
                .unwrap_or(false);

            if !queued {
                lines.push(Line::from(vec![
                    Span::styled("  ✗ ", Style::default().fg(DANGER)),
                    Span::styled(format!("{:<16}", name), Style::default().fg(FG)),
                    Span::styled("server unreachable", Style::default().fg(DANGER)),
                ]));
            } else if installed {
                lines.push(Line::from(vec![
                    Span::styled("  ✓ ", Style::default().fg(SUCCESS)),
                    Span::styled(format!("{:<16}", name), Style::default().fg(FG)),
                    Span::styled("installed", Style::default().fg(SUCCESS)),
                ]));
            } else {
                let frame = spinner_frame(app.animation_tick);
                lines.push(Line::from(vec![
                    Span::styled("  ", Style::default()),
                    Span::styled(
                        frame,
                        Style::default().fg(ACCENT).add_modifier(Modifier::BOLD),
                    ),
                    Span::raw(" "),
                    Span::styled(format!("{:<16}", name), Style::default().fg(FG)),
                    Span::styled("installing", Style::default().fg(MUTED)),
                ]));
            }
        }
    }

    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_style(Style::default().fg(MUTED)),
        ),
        body[1],
    );

    let notice = if all_done {
        Span::styled(
            "  setup complete — press enter to return to the dashboard",
            Style::default().fg(MUTED),
        )
    } else {
        Span::styled(
            "  you may close this screen — downloads continue in the background",
            Style::default().fg(MUTED),
        )
    };
    f.render_widget(Paragraph::new(Line::from(notice)), body[2]);

    render_hints(
        f,
        r.hints,
        &[
            ("enter", "dashboard", HintAction::Dashboard),
            ("q", "quit", HintAction::Quit),
        ],
        app,
    );
}
