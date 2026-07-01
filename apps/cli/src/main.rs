mod api;
mod app;
mod auth;
mod config;
mod nodes;
mod chat;
mod ui;

#[cfg(test)]
mod render_tests;

use std::io;
use std::time::{Duration, Instant};

use ratatui::{
    backend::CrosstermBackend,
    crossterm::{
        event::{
            self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind,
            KeyModifiers, MouseButton, MouseEventKind,
        },
        execute,
        terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    },
    Terminal,
};

use app::{fetch_catalog, fetch_agent_detail, App, HintAction, Screen, SidebarTab, SIDECAR_ORDER, SIDEBAR_TABS};
use ui::ui;
use futures_util;

/// Resolves which node URL to use for this invocation.
/// Checks for a leading `--node <name>` in args, otherwise uses the active node.
fn resolve_node(args: &[String]) -> (String, Option<String>) {
    if let Some(pos) = args.iter().position(|a| a == "--node") {
        if let Some(name) = args.get(pos + 1) {
            if let Ok(node) = nodes::get_node(name) {
                return (node.url, node.token);
            }
            eprintln!("warning: node '{}' not found, using active node", name);
        }
    }
    api::active_url_and_token()
}

// ── Colored logo for CLI output (ANSI escape codes, from app-icon.png) ───────

fn print_logo_ansi() {
    const LINES: &[&[(&str, u8, u8, u8)]] = &[
        &[(".", 27, 67, 129), (":::::::::::", 27, 67, 129), (":::.", 66, 69, 125)],
        &[(":::--::::::", 28, 78, 144), ("::::", 31, 62, 124), ("--", 80, 84, 152), ("==", 111, 104, 177), ("=", 124, 112, 187)],
        &[(":------:::::", 28, 78, 145), (":::::", 31, 61, 123), ("--", 78, 84, 151), ("-=", 99, 96, 167), ("=+=", 133, 117, 192)],
        &[("--------::::", 32, 80, 148), (":::::", 40, 63, 125), ("--", 80, 84, 152), ("-=", 100, 96, 167), ("==+:", 121, 110, 185)],
        &[(":------", 33, 84, 154), ("--==", 73, 114, 188), ("+++++", 151, 115, 190), ("====", 106, 96, 167), ("==+=", 135, 117, 191)],
        &[(":----", 35, 87, 158), ("-==", 66, 113, 189), ("+++", 109, 139, 219), ("*", 153, 140, 221), ("*********", 210, 133, 213), ("++++++", 142, 116, 192)],
        &[("---", 37, 89, 160), ("-==", 63, 111, 186), ("++++", 106, 141, 221), ("+*", 144, 142, 223), ("*************", 218, 132, 212), ("*+*", 186, 127, 206)],
        &[("---=", 45, 96, 168), ("++++", 99, 140, 220), ("@@", 244, 243, 251), ("****", 217, 137, 217), ("@@", 250, 235, 248), ("#", 233, 157, 223), ("********", 224, 134, 214)],
        &[("==", 70, 116, 192), ("=+", 90, 133, 212), ("++++", 103, 143, 224), ("@", 222, 231, 248), ("\u{2588}\u{2588}\u{2588}", 255, 255, 255), ("#", 216, 178, 231), ("**", 215, 137, 217), ("#", 234, 176, 229), ("\u{2588}\u{2588}\u{2588}", 255, 255, 255), ("@", 249, 230, 247), ("********", 227, 135, 215)],
        &[("=", 85, 123, 195), ("+++++++", 100, 141, 222), ("@", 225, 233, 249), ("\u{2588}\u{2588}\u{2588}", 255, 255, 255), ("#", 199, 182, 233), ("**", 198, 138, 218), ("#", 228, 178, 230), ("\u{2588}\u{2588}\u{2588}", 255, 255, 255), ("@", 249, 233, 248), ("*******+", 226, 136, 216)],
        &[(":", 69, 95, 149), ("+++++++", 104, 144, 225), ("*@@", 229, 236, 250), ("+***", 144, 143, 223), ("%@@", 249, 242, 250), ("#", 226, 162, 225), ("*******:", 224, 136, 217)],
        &[("+++++++++++++", 104, 142, 223), ("+**", 155, 140, 221), ("**********", 213, 135, 216)],
        &[(" -", 83, 115, 179), ("+++++++++++++", 107, 143, 224), ("+*", 154, 141, 222), ("*******=", 209, 136, 217)],
        &[("   .:-", 69, 95, 148), ("==", 95, 131, 204), ("++++++++", 110, 142, 223), ("++", 158, 138, 217), ("++=:", 172, 108, 171)],
    ];

    for spans in LINES {
        eprint!("  ");
        for (text, r, g, b) in *spans {
            eprint!("\x1b[38;2;{r};{g};{b}m{text}\x1b[0m");
        }
        eprintln!();
    }
    eprintln!();
}

// ── First-run marker (stored in ~/.ryu/versions.json as "setup_seen") ─────────

fn versions_json_path() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(home).join(".ryu").join("versions.json")
}

fn is_first_run() -> bool {
    let path = versions_json_path();
    let Ok(content) = std::fs::read_to_string(&path) else { return true };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else { return true };
    !json.get("setup_seen").and_then(|v| v.as_bool()).unwrap_or(false)
}

fn mark_initialized() {
    let path = versions_json_path();
    let mut json: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    json["setup_seen"] = serde_json::Value::Bool(true);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&json).unwrap_or_default());
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args.is_empty() {
        return run_command(args).await;
    }

    let node = nodes::active_node();
    // Non-blocking update notice on launch (skipped if Core is unreachable).
    if let Some(notice) = api::fetch_update_check(&node.url, node.token.as_deref()).await {
        if notice.available {
            eprintln!(
                "\x1b[33m▲ Ryu {} is available (you have {}).\x1b[0m Run `ryu update` for details.",
                notice.latest, notice.current
            );
        }
    }
    let catalog_items = fetch_catalog(&node.url, node.token.as_deref())
        .await
        .unwrap_or_default();
    let mut app = if catalog_items.is_empty() {
        App::new(node.url)
    } else {
        App::new_from_catalog(node.url, catalog_items)
    };
    if is_first_run() {
        app.current_screen = Screen::WaitingForCore;
    }
    run_tui(app).await
}

/// Run a headless subcommand and exit — no TUI launched.
async fn run_command(args: Vec<String>) -> anyhow::Result<()> {
    let (api_url, token) = resolve_node(&args);
    match args[0].as_str() {
        "version" | "--version" | "-V" => {
            println!("ryu-cli v{}", env!("CARGO_PKG_VERSION"));
            // Best-effort: report Core's view of the release train + any update.
            if let Some(notice) = api::fetch_update_check(&api_url, token.as_deref()).await {
                println!("ryu (installed): v{}", notice.current);
                if notice.available {
                    println!("ryu (latest):    v{}  — update available", notice.latest);
                } else {
                    println!("ryu (latest):    v{}  — up to date", notice.latest);
                }
            }
        }

        "update" => {
            match api::fetch_update_check(&api_url, token.as_deref()).await {
                Some(notice) if notice.available => {
                    println!("A new Ryu release is available.");
                    println!("  installed: v{}", notice.current);
                    println!("  latest:    v{}", notice.latest);
                    if let Some(url) = notice.html_url {
                        println!("  release:   {url}");
                    }
                    println!();
                    println!("The desktop app self-updates. To update the CLI/Core binaries,");
                    println!("download the latest release from the URL above.");
                }
                Some(notice) => {
                    println!("Ryu is up to date (v{}).", notice.current);
                }
                None => {
                    eprintln!("error: could not reach Core to check for updates — start with `ryu-core`");
                }
            }
        }

        "status" => {
            let catalog_items = fetch_catalog(&api_url, token.as_deref())
                .await
                .unwrap_or_default();
            let mut app = if catalog_items.is_empty() {
                App::new(api_url.clone())
            } else {
                App::new_from_catalog(api_url.clone(), catalog_items)
            };
            let _ = api::fetch_status(&mut app).await;
            let _ = api::fetch_installed(&mut app).await;

            if app.statuses.is_empty() {
                eprintln!("error: core not running — start with `ryu-core`");
                return Ok(());
            }

            println!("{:<14}  {:<9}  {}", "NAME", "INSTALLED", "STATUS");
            println!("{}", "-".repeat(36));

            let all_installed: Vec<String> = app
                .all_sidecars()
                .filter(|s| s.installed)
                .map(|s| s.name.clone())
                .collect();

            for s in &app.statuses {
                let installed = if all_installed.contains(&s.name) { "yes" } else { "no" };
                let status = if s.running { "● running" } else { "○ stopped" };
                println!("{:<14}  {:<9}  {}", s.name, installed, status);
            }
        }

        "start" => match args.get(1).map(|s| s.as_str()) {
            Some("all") | None => {
                println!("Starting all sidecars...");
                api::start_all(&api_url).await?;
                println!("Done.");
            }
            Some(name) => {
                println!("Starting {name}...");
                api::start_sidecar(&api_url, name).await?;
                println!("Done.");
            }
        },

        "stop" => match args.get(1).map(|s| s.as_str()) {
            Some("all") | None => {
                println!("Stopping all sidecars...");
                api::stop_all(&api_url).await?;
                println!("Done.");
            }
            Some(name) => {
                println!("Stopping {name}...");
                api::stop_sidecar(&api_url, name).await?;
                println!("Done.");
            }
        },

        "restart" => match args.get(1).map(|s| s.as_str()) {
            None => eprintln!("usage: ryu restart <name>"),
            Some(name) => {
                println!("Restarting {name}...");
                api::restart_sidecar_runtime(&api_url, name).await?;
                println!("Done.");
            }
        },

        "login" => {
            let backend_url = std::env::var("RYU_AUTH_URL")
                .unwrap_or_else(|_| "http://localhost:3000".into());
            auth::run_login(&backend_url).await?;
        }

        "logout" => {
            auth::clear_token()?;
            println!("Logged out successfully.");
        }

        "whoami" => {
            run_whoami().await?;
        }

        "sessions" => {
            run_sessions_command(&args[1..]).await?;
        }

        "plan" => {
            run_plan_command().await?;
        }

        "account" => {
            run_account_command(&args[1..]).await?;
        }

        "node" => {
            run_node_command(&args[1..]).await?;
        }

        "skills" => {
            run_skills_command(&api_url, token.as_deref(), &args[1..]).await?;
        }

        "mcp" => {
            run_mcp_command(&api_url, token.as_deref(), &args[1..]).await?;
        }

        "okf" => {
            run_okf_command(&api_url, token.as_deref(), &args[1..]).await?;
        }

        "apply" => {
            config::run_apply(&args[1..]).await?;
        }

        "diff" => {
            config::run_diff(&args[1..]).await?;
        }

        "config" => {
            config::run_config(&args[1..]).await?;
        }

        "setup" => {
            let catalog_items = fetch_catalog(&api_url, token.as_deref())
                .await
                .unwrap_or_default();
            let mut app = if catalog_items.is_empty() {
                App::new(api_url.clone())
            } else {
                App::new_from_catalog(api_url.clone(), catalog_items)
            };
            app.current_screen = Screen::SetupDependencies;
            app.list_state.select(Some(0));
            run_tui(app).await?;
        }

        "open" | "link" => {
            run_open_command(&args[1..]);
        }

        cmd => {
            eprintln!("unknown command: {cmd}");
            eprintln!();
            print_usage();
        }
    }

    Ok(())
}

/// Forward a `ryu://` deep link to the desktop app (the OS-registered handler),
/// or build one from a shorthand. The CLI is headless, so a deep link to a
/// desktop page/chat is handed off to the GUI rather than rendered in the TUI:
///
///   ryu open ryu://open/agents          forward an explicit deep link
///   ryu open monitors                   shorthand → ryu://open/monitors
///   ryu open chat Fix the failing test  shorthand → ryu://chat/new?prompt=…
fn run_open_command(args: &[String]) {
    if args.is_empty() {
        eprintln!("usage:");
        eprintln!("  ryu open <ryu://…>          open an explicit deep link in the desktop app");
        eprintln!("  ryu open <page>             open a page (e.g. agents, settings, monitors)");
        eprintln!("  ryu open chat [prompt…]     open a new chat, composer pre-seeded (not sent)");
        return;
    }

    let url = build_deep_link(args);
    // Only ever hand a ryu:// URL to the OS opener (no arbitrary schemes).
    if !url.starts_with("ryu://") {
        eprintln!("error: not a ryu:// deep link: {url}");
        return;
    }

    match open::that(&url) {
        Ok(()) => println!("Opening {url}"),
        Err(e) => {
            eprintln!("error: could not open {url}");
            eprintln!("  {e}");
            eprintln!();
            eprintln!(
                "The `ryu://` scheme is registered by the Ryu desktop app. Install it (or run"
            );
            eprintln!("it once) so the OS knows how to open the link.");
        }
    }
}

/// Build a `ryu://` deep link from CLI args. An explicit `ryu://…` URL is passed
/// through; otherwise the first token is a page key (or `chat`, with the rest as
/// the seed prompt).
fn build_deep_link(args: &[String]) -> String {
    let first = args[0].as_str();
    if first.starts_with("ryu://") {
        return first.to_string();
    }
    if first == "chat" {
        let prompt = args[1..].join(" ");
        if prompt.is_empty() {
            return "ryu://chat/new".to_string();
        }
        return format!("ryu://chat/new?prompt={}", urlencoding::encode(&prompt));
    }
    format!("ryu://open/{}", urlencoding::encode(first))
}

fn print_usage() {
    print_logo_ansi();
    eprintln!("usage: ryu [command]");
    eprintln!();
    eprintln!("General:");
    eprintln!("  (no args)                      open control panel TUI");
    eprintln!("  status                         show sidecar statuses");
    eprintln!("  start <name|all>               start a sidecar or all");
    eprintln!("  stop  <name|all>               stop a sidecar or all");
    eprintln!("  restart <name>                 restart a sidecar");
    eprintln!("  node <sub>                     manage nodes (add/remove/list/use/test/init)");
    eprintln!("  open <ryu://…|page|chat …>     open a deep link / page / new chat in the desktop app");
    eprintln!("  setup                          open setup wizard TUI");
    eprintln!("  version                        show CLI + Ryu release version");
    eprintln!("  update                         check for a newer Ryu release");
    eprintln!();
    eprintln!("Marketplace:");
    eprintln!("  skills list [query]            browse the skills catalog");
    eprintln!("  skills add <id|owner/repo|url> install a skill (id or source)");
    eprintln!("  mcp list [query]               browse the MCP server catalog");
    eprintln!("  mcp add <id>                   install an MCP server (written disabled; enable to use)");
    eprintln!("  okf export <dir> [--bundle id] export indexed knowledge as an OKF bundle");
    eprintln!();
    eprintln!("Config-as-code (GitOps):");
    eprintln!("  apply -f <file> [--org id]     validate + apply a scope's gateway.yaml");
    eprintln!("  diff  -f <file> [--org id]     preview changes without applying");
    eprintln!("  config revisions [--org id]    list applied revisions");
    eprintln!("  config rollback <rev> [--org]  revert to a prior revision");
    eprintln!("  config show [--org id]         print current config as YAML");
    eprintln!();
    eprintln!("Auth:");
    eprintln!("  login                          log in via browser");
    eprintln!("  logout                         clear saved credentials");
    eprintln!("  whoami                         show full account status");
    eprintln!("  sessions                       list active sessions");
    eprintln!("  sessions revoke <id>           revoke a specific session");
    eprintln!("  sessions revoke-all            revoke all other sessions");
    eprintln!("  plan                           show subscription plan + invoices");
    eprintln!("  account                        show detailed account info");
    eprintln!("  account name <new-name>        update display name");
}

// ── Enhanced whoami ──────────────────────────────────────────────────────────

async fn run_whoami() -> anyhow::Result<()> {
    let (data, backend_url) = auth::require_token_and_url()?;

    let (session_res, pw_res, sub_res, sessions_res) = tokio::join!(
        auth::fetch_full_session(&backend_url, &data.token),
        auth::fetch_password_status(&backend_url, &data.token),
        auth::fetch_subscription_status(&backend_url, &data.token),
        auth::fetch_sessions(&backend_url, &data.token),
    );

    let session = session_res?;
    let user = session.get("user");

    let name = user
        .and_then(|u| u.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown");
    let email = user
        .and_then(|u| u.get("email"))
        .and_then(|v| v.as_str())
        .unwrap_or("—");
    let verified = user
        .and_then(|u| u.get("emailVerified"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let two_factor = user
        .and_then(|u| u.get("twoFactorEnabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    println!("Logged in as {name}");
    println!(
        "Email:     {email}{}",
        if verified { " (verified)" } else { " (unverified)" }
    );

    if let Ok(pw) = pw_res {
        let has_password = pw
            .get("hasPassword")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let method = pw
            .get("authMethod")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        println!(
            "Auth:      {}",
            if has_password { "Password set".to_owned() } else { format!("Signed in via {method}") }
        );
    }

    println!(
        "2FA:       {}",
        if two_factor { "Enabled" } else { "Disabled" }
    );

    if let Ok(sub) = sub_res {
        let plan = format_plan(&sub);
        println!("Plan:      {plan}");
    }

    if let Ok(sessions) = sessions_res {
        println!("Sessions:  {} active", sessions.len());
    }

    Ok(())
}

pub fn format_plan(sub: &serde_json::Value) -> String {
    if let Some(lt) = sub.get("lifetime").and_then(|v| if v.is_null() { None } else { Some(v) }) {
        let expired = lt.get("expired").and_then(|v| v.as_bool()).unwrap_or(false);
        if expired {
            return "Lifetime (updates expired)".to_owned();
        }
        let until = lt
            .get("updatesExpiresAt")
            .and_then(|v| v.as_str())
            .and_then(|s| s.split('T').next())
            .unwrap_or("—");
        return format!("Lifetime (updates until {until})");
    }

    if let Some(s) = sub.get("subscription").and_then(|v| if v.is_null() { None } else { Some(v) }) {
        let status = s.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
        let interval = s.get("interval").and_then(|v| v.as_str()).unwrap_or("");

        if status == "trialing" {
            return format!("Trial ({interval}ly after trial)");
        }

        let label = if interval == "month" { "monthly" } else if interval == "year" { "annual" } else { interval };
        return format!("Pro ({label})");
    }

    "Free".to_owned()
}

// ── Sessions command ────────────────────────────────────────────────────────

async fn run_sessions_command(args: &[String]) -> anyhow::Result<()> {
    let (data, backend_url) = auth::require_token_and_url()?;
    let sub = args.first().map(|s| s.as_str()).unwrap_or("list");

    match sub {
        "list" | "" => {
            let sessions = auth::fetch_sessions(&backend_url, &data.token).await?;
            if sessions.is_empty() {
                println!("No active sessions.");
                return Ok(());
            }

            println!(
                "{:<26}  {:<18}  {:<16}  {}",
                "ID", "DEVICE", "IP", "CREATED"
            );
            println!("{}", "-".repeat(80));

            for (i, s) in sessions.iter().enumerate() {
                let id = s.get("_id")
                    .or_else(|| s.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("—");
                let ua = s
                    .get("userAgent")
                    .and_then(|v| v.as_str())
                    .map(parse_user_agent)
                    .unwrap_or_else(|| "Unknown".to_owned());
                let ip = s
                    .get("ipAddress")
                    .and_then(|v| v.as_str())
                    .unwrap_or("—");
                let created = s
                    .get("createdAt")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.split('T').next())
                    .unwrap_or("—");
                let marker = if i == 0 { "  ← this session" } else { "" };
                println!("{:<26}  {:<18}  {:<16}  {}{}", id, ua, ip, created, marker);
            }
        }

        "revoke" => {
            let session_id = args.get(1).ok_or_else(|| {
                anyhow::anyhow!("usage: ryu sessions revoke <session-id>")
            })?;
            auth::revoke_session(&backend_url, &data.token, session_id).await?;
            println!("Session {session_id} revoked.");
        }

        "revoke-all" => {
            auth::revoke_all_other_sessions(&backend_url, &data.token).await?;
            println!("All other sessions revoked.");
        }

        other => {
            eprintln!("unknown sessions subcommand: {other}");
            eprintln!();
            eprintln!("usage: ryu sessions [subcommand]");
            eprintln!("  (no args)          list active sessions");
            eprintln!("  revoke <id>        revoke a specific session");
            eprintln!("  revoke-all         revoke all other sessions");
        }
    }

    Ok(())
}

fn parse_user_agent(ua: &str) -> String {
    if ua.contains("Chrome") {
        "Chrome".to_owned()
    } else if ua.contains("Firefox") {
        "Firefox".to_owned()
    } else if ua.contains("Safari") {
        "Safari".to_owned()
    } else if ua.contains("Edge") {
        "Edge".to_owned()
    } else if ua.len() > 30 {
        format!("{}…", &ua[..30])
    } else {
        ua.to_owned()
    }
}

// ── Plan command ────────────────────────────────────────────────────────────

async fn run_plan_command() -> anyhow::Result<()> {
    let (data, backend_url) = auth::require_token_and_url()?;

    let (sub_res, inv_res) = tokio::join!(
        auth::fetch_subscription_status(&backend_url, &data.token),
        auth::fetch_invoices(&backend_url, &data.token),
    );

    let sub = sub_res?;
    let plan = format_plan(&sub);
    println!("Plan:      {plan}");

    if let Some(s) = sub.get("subscription").and_then(|v| if v.is_null() { None } else { Some(v) }) {
        let status = s.get("status").and_then(|v| v.as_str()).unwrap_or("unknown");
        println!("Status:    {status}");

        if let Some(end) = s.get("currentPeriodEnd").and_then(|v| v.as_str()) {
            let date = end.split('T').next().unwrap_or(end);
            println!("Renews:    {date}");
        }

        let cancel = s
            .get("cancelAtPeriodEnd")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if cancel {
            println!("           (cancels at period end)");
        }
    }

    if let Ok(invoices) = inv_res {
        if invoices.is_empty() {
            println!("\nNo invoices.");
        } else {
            println!();
            println!("{:<16}  {:<10}  {}", "DATE", "STATUS", "AMOUNT");
            println!("{}", "-".repeat(42));
            for inv in &invoices {
                let date = inv
                    .get("createdAt")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.split('T').next())
                    .unwrap_or("—");
                let status = inv
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("—");
                let amount = inv
                    .get("amount")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                let currency = inv
                    .get("currency")
                    .and_then(|v| v.as_str())
                    .unwrap_or("usd")
                    .to_uppercase();
                println!("{:<16}  {:<10}  {:.2} {}", date, status, amount / 100.0, currency);
            }
        }
    }

    Ok(())
}

// ── Account command ─────────────────────────────────────────────────────────

async fn run_account_command(args: &[String]) -> anyhow::Result<()> {
    let (data, backend_url) = auth::require_token_and_url()?;
    let sub = args.first().map(|s| s.as_str());

    match sub {
        Some("name") => {
            let new_name = args.get(1).ok_or_else(|| {
                anyhow::anyhow!("usage: ryu account name <new-name>")
            })?;
            auth::update_display_name(&backend_url, &data.token, new_name).await?;
            println!("Display name updated to \"{new_name}\".");
        }

        None | Some("") => {
            let (session_res, pw_res) = tokio::join!(
                auth::fetch_full_session(&backend_url, &data.token),
                auth::fetch_password_status(&backend_url, &data.token),
            );

            let session = session_res?;
            let user = session.get("user");

            let name = user
                .and_then(|u| u.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("—");
            let email = user
                .and_then(|u| u.get("email"))
                .and_then(|v| v.as_str())
                .unwrap_or("—");
            let verified = user
                .and_then(|u| u.get("emailVerified"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let two_factor = user
                .and_then(|u| u.get("twoFactorEnabled"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            println!("Name:      {name}");
            println!(
                "Email:     {email}{}",
                if verified { " (verified)" } else { " (unverified)" }
            );

            if let Ok(pw) = pw_res {
                let has_password = pw
                    .get("hasPassword")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let method = pw
                    .get("authMethod")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                if has_password {
                    println!("Password:  Set");
                } else {
                    println!("Password:  Not set (signed in via {method})");
                }
            }

            println!(
                "2FA:       {}",
                if two_factor { "Enabled" } else { "Disabled" }
            );
        }

        Some(other) => {
            eprintln!("unknown account subcommand: {other}");
            eprintln!();
            eprintln!("usage: ryu account [subcommand]");
            eprintln!("  (no args)          show account details");
            eprintln!("  name <new-name>    update display name");
        }
    }

    Ok(())
}

async fn run_node_command(args: &[String]) -> anyhow::Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("list");

    match sub {
        "list" => {
            let config = nodes::load();
            println!("{:<16}  {:<40}  {}", "NAME", "URL", "DEFAULT");
            println!("{}", "-".repeat(66));
            for node in &config.nodes {
                let marker = if node.name == config.default { "●" } else { " " };
                let auth = if node.token.is_some() { "(token)" } else { "(open)" };
                println!("{:<16}  {:<40}  {} {}", node.name, node.url, marker, auth);
            }
        }

        "add" => {
            let name = args.get(1).ok_or_else(|| anyhow::anyhow!("usage: ryu node add <name> <url> [--token <token>]"))?;
            let url  = args.get(2).ok_or_else(|| anyhow::anyhow!("usage: ryu node add <name> <url> [--token <token>]"))?;

            if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '-') {
                anyhow::bail!("node name must be alphanumeric + hyphens only");
            }

            let token = args.windows(2).find_map(|w| {
                if w[0] == "--token" { Some(w[1].clone()) } else { None }
            });

            let mut config = nodes::load();
            if config.nodes.iter().any(|n| n.name == *name) {
                anyhow::bail!("node '{}' already exists", name);
            }

            config.nodes.push(nodes::Node {
                name: name.clone(),
                url: url.clone(),
                token,
                mesh: None,
            });
            nodes::save(&config)?;
            println!("Added node '{}'.", name);
        }

        "remove" => {
            let name = args.get(1).ok_or_else(|| anyhow::anyhow!("usage: ryu node remove <name>"))?;
            if name == "local" {
                anyhow::bail!("cannot remove the local node");
            }
            let mut config = nodes::load();
            let before = config.nodes.len();
            config.nodes.retain(|n| n.name != *name);
            if config.nodes.len() == before {
                anyhow::bail!("node '{}' not found", name);
            }
            if config.default == *name {
                config.default = "local".into();
            }
            nodes::save(&config)?;
            println!("Removed node '{}'.", name);
        }

        "use" => {
            let name = args.get(1).ok_or_else(|| anyhow::anyhow!("usage: ryu node use <name>"))?;
            let mut config = nodes::load();
            if !config.nodes.iter().any(|n| n.name == *name) {
                anyhow::bail!("node '{}' not found — run `ryu node list` to see available nodes", name);
            }
            config.default = name.clone();
            nodes::save(&config)?;
            println!("Now using node '{}'.", name);
        }

        "current" => {
            let node = nodes::active_node();
            println!("{} — {}", node.name, node.url);
        }

        "test" => {
            let name = args.get(1).cloned().unwrap_or_else(|| nodes::active_node().name);
            let node = nodes::get_node(&name)?;
            let client = api::authed_client(node.token.as_deref());
            let start = std::time::Instant::now();
            match client
                .get(format!("{}/api/health", node.url))
                .timeout(std::time::Duration::from_secs(5))
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => {
                    println!("● {} — {}ms", node.name, start.elapsed().as_millis());
                }
                Ok(r) => {
                    println!("○ {} — HTTP {}", node.name, r.status());
                }
                Err(e) => {
                    println!("✗ {} — {}", node.name, e);
                }
            }
        }

        "init" => {
            let token_path = {
                let home = std::env::var("USERPROFILE")
                    .or_else(|_| std::env::var("HOME"))
                    .unwrap_or_else(|_| ".".into());
                std::path::PathBuf::from(home).join(".ryu").join("core.token")
            };

            let force = args.iter().any(|a| a == "--force");
            if token_path.exists() && !force {
                anyhow::bail!(
                    "token already exists at {}. Use --force to regenerate.",
                    token_path.display()
                );
            }

            let token = format!("ryu_{}", uuid::Uuid::new_v4().simple());
            if let Some(parent) = token_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&token_path, &token)?;

            println!("Token generated. Add this node on your local machine with:");
            println!();
            println!("  ryu node add <name> <url> --token {}", token);
            println!();
            println!("Start the core with network access:");
            println!("  RYU_TOKEN={} ryu-core --bind 0.0.0.0:2049", token);
        }

        // `ryu node discover [--port <port>] [--add]`
        //
        // Sweeps the local /24 subnet for running Core nodes (bounded to 254
        // hosts, 800 ms per probe, all hosts concurrent).  With --add it
        // registers every found node and prints instructions to activate one.
        "discover" => {
            let port: Option<u16> = args.windows(2).find_map(|w| {
                if w[0] == "--port" { w[1].parse().ok() } else { None }
            });
            let do_add = args.iter().any(|a| a == "--add");

            eprintln!("Scanning local subnet (this takes up to ~1 s)...");
            let found = nodes::discover_lan(port).await;

            if found.is_empty() {
                println!("No Core nodes found on the local network.");
                println!("Make sure the remote machine is running `ryu-core --bind 0.0.0.0:7980`.");
                return Ok(());
            }

            println!("Found {} node(s):", found.len());
            println!("{:<40}  {}", "URL", "LATENCY");
            println!("{}", "-".repeat(52));
            for n in &found {
                println!("{:<40}  {}ms", n.url, n.latency_ms);
            }

            if do_add {
                let mut config = nodes::load();
                let mut added = 0usize;
                for (i, n) in found.iter().enumerate() {
                    let name = format!("discovered-{}", i + 1);
                    if config.nodes.iter().any(|e| e.url == n.url) {
                        println!("  (skipping {}: already in node list)", n.url);
                        continue;
                    }
                    config.nodes.push(nodes::Node {
                        name: name.clone(),
                        url: n.url.clone(),
                        token: None,
                        mesh: None,
                    });
                    println!("  Added as '{name}'.");
                    added += 1;
                }
                if added > 0 {
                    nodes::save(&config)?;
                    println!();
                    println!("Run `ryu node use <name>` to activate, or `ryu node add <name> <url> --token <t>` to add a token.");
                }
            } else {
                println!();
                println!("Re-run with --add to register discovered nodes, then `ryu node use <name>` to activate.");
            }
        }

        other => {
            eprintln!("unknown node subcommand: {other}");
            eprintln!();
            eprintln!("usage: ryu node <subcommand>");
            eprintln!("  list                         list all nodes");
            eprintln!("  add <name> <url> [--token t] add a node");
            eprintln!("  remove <name>                remove a node");
            eprintln!("  use <name>                   set active node");
            eprintln!("  current                      show active node");
            eprintln!("  test [<name>]                ping a node");
            eprintln!("  discover [--port p] [--add]  scan LAN for Core nodes");
            eprintln!("  init [--force]               generate token (run on remote machine)");
        }
    }

    Ok(())
}

// ── Marketplace commands (skills + MCP catalogs) ──────────────────────────────

/// Whether a `skills add` argument is unambiguously a URL source reference.
///
/// Skills catalog ids are `owner/repo/slug` (they contain slashes), so a slash
/// alone cannot distinguish an id from a repo source. Only a `://` scheme is an
/// unambiguous source; everything else is tried as a catalog id first and falls
/// back to install-from-source on failure (see `run_skills_command`).
fn is_url_source(value: &str) -> bool {
    value.trim().contains("://")
}

async fn run_skills_command(
    api_url: &str,
    token: Option<&str>,
    args: &[String],
) -> anyhow::Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("list");

    match sub {
        "list" | "" => {
            let query = args.get(1).map(|s| s.as_str());
            let cards = api::fetch_skill_catalog(api_url, token, query).await?;
            if cards.is_empty() {
                println!("No skills found.");
                return Ok(());
            }
            println!("{:<3}  {:<36}  {:>9}  {}", "", "ID", "INSTALLS", "NAME");
            println!("{}", "-".repeat(70));
            for c in &cards {
                let marker = if c.installed { "●" } else { " " };
                println!("{:<3}  {:<36}  {:>9}  {}", marker, c.id, c.installs, c.name);
            }
            println!();
            println!("● = installed.  Install with `ryu skills add <id>`.");
        }

        "add" | "install" => {
            let target = args.get(1).ok_or_else(|| {
                anyhow::anyhow!("usage: ryu skills add <id|owner/repo|url>")
            })?;
            // A `://` URL is unambiguously a source. A catalog id is
            // `owner/repo/slug` (also contains slashes), so for everything else
            // try catalog-install first and fall back to install-from-source on
            // failure — this routes both a real catalog id and a bare repo ref
            // correctly without guessing from the slash shape.
            if is_url_source(target) {
                println!("Installing skill from source '{target}'...");
                let slug = api::install_skill_from_source(api_url, token, target).await?;
                println!("Installed skill '{slug}'.");
            } else {
                println!("Installing skill '{target}'...");
                match api::install_skill_by_id(api_url, token, target).await {
                    Ok(slug) => println!("Installed skill '{slug}'."),
                    Err(catalog_err) => {
                        // Not a known catalog id — try resolving it as a source
                        // reference (e.g. `owner/repo` not listed in the catalog).
                        println!("Not in catalog, trying as a source reference...");
                        match api::install_skill_from_source(api_url, token, target).await {
                            Ok(slug) => println!("Installed skill '{slug}'."),
                            Err(source_err) => anyhow::bail!(
                                "could not install '{target}': {catalog_err} (and as source: {source_err})"
                            ),
                        }
                    }
                }
            }
        }

        other => {
            eprintln!("unknown skills subcommand: {other}");
            eprintln!();
            eprintln!("usage: ryu skills <subcommand>");
            eprintln!("  list [query]              browse the skills catalog");
            eprintln!("  add <id|owner/repo|url>   install a skill (id or source)");
        }
    }

    Ok(())
}

async fn run_mcp_command(
    api_url: &str,
    token: Option<&str>,
    args: &[String],
) -> anyhow::Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("list");

    match sub {
        "list" | "" => {
            let query = args.get(1).map(|s| s.as_str());
            let cards = api::fetch_mcp_catalog(api_url, token, query).await?;
            if cards.is_empty() {
                println!("No MCP servers found.");
                return Ok(());
            }
            println!("{:<3}  {:<40}  {}", "", "ID", "NAME");
            println!("{}", "-".repeat(70));
            for c in &cards {
                let marker = if c.installed { "●" } else { " " };
                let desc = c
                    .description
                    .as_deref()
                    .map(|d| {
                        let truncated: String = d.chars().take(40).collect();
                        if truncated.len() < d.len() {
                            format!(" — {truncated}…")
                        } else {
                            format!(" — {d}")
                        }
                    })
                    .unwrap_or_default();
                println!("{:<3}  {:<40}  {}{}", marker, c.id, c.name, desc);
            }
            println!();
            println!("● = installed.  Install with `ryu mcp add <id>`.");
        }

        "add" | "install" => {
            let id = args.get(1).ok_or_else(|| anyhow::anyhow!("usage: ryu mcp add <id>"))?;
            println!("Installing MCP server '{id}'...");
            let name = api::install_mcp_server(api_url, token, id).await?;
            println!("Installed '{name}' (disabled; enable it to use).");
        }

        other => {
            eprintln!("unknown mcp subcommand: {other}");
            eprintln!();
            eprintln!("usage: ryu mcp <subcommand>");
            eprintln!("  list [query]   browse the MCP server catalog");
            eprintln!("  add <id>       install an MCP server (written disabled)");
        }
    }

    Ok(())
}

/// `ryu okf export <dir> [--bundle <id>]` — emit Ryu's own indexed knowledge as
/// an OKF bundle directory. Delegates to Core's `/api/okf/export`; Core owns the
/// reconstruction and on-disk write (the path is resolved relative to Core).
async fn run_okf_command(
    api_url: &str,
    token: Option<&str>,
    args: &[String],
) -> anyhow::Result<()> {
    let sub = args.first().map(|s| s.as_str()).unwrap_or("");

    match sub {
        "export" => {
            let mut dir: Option<&str> = None;
            let mut bundle: Option<&str> = None;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--bundle" | "-b" => {
                        bundle = args.get(i + 1).map(|s| s.as_str());
                        if bundle.is_none() {
                            anyhow::bail!("--bundle requires a value");
                        }
                        i += 2;
                    }
                    other if dir.is_none() => {
                        dir = Some(other);
                        i += 1;
                    }
                    other => anyhow::bail!("unexpected argument: {other}"),
                }
            }
            let Some(dir) = dir else {
                anyhow::bail!("usage: ryu okf export <dir> [--bundle <id>]");
            };

            println!("Exporting OKF bundle to '{dir}'...");
            let result = api::export_okf_bundle(api_url, token, dir, bundle).await?;
            println!(
                "Exported {} concept(s) to {}",
                result.concepts, result.target_dir
            );
            for file in &result.files {
                println!("  {file}");
            }
            println!("  index.md (listing)");
            println!("  log.md (changelog)");
        }

        other => {
            eprintln!("unknown okf subcommand: {other}");
            eprintln!();
            eprintln!("usage: ryu okf <subcommand>");
            eprintln!("  export <dir> [--bundle <id>]   write indexed knowledge as an OKF bundle");
        }
    }

    Ok(())
}

async fn run_tui(app: App) -> anyhow::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let res = run_app(&mut terminal, app).await;

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    if let Err(err) = res {
        eprintln!("Error: {err:?}");
    }

    Ok(())
}

fn switch_tab(app: &mut App, tab: SidebarTab) {
    app.active_tab = tab;
    app.current_screen = match tab {
        SidebarTab::Chat => Screen::Chat,
        SidebarTab::Services => Screen::Dashboard,
        SidebarTab::Agents => Screen::Agents,
        SidebarTab::Apps
        | SidebarTab::Gateway
        | SidebarTab::Workflows
        | SidebarTab::Spaces
        | SidebarTab::Engines
        | SidebarTab::Schedules
        | SidebarTab::Models
        | SidebarTab::Skills
        | SidebarTab::Tools
        | SidebarTab::Monitors
        | SidebarTab::Teams
        | SidebarTab::Meetings
        | SidebarTab::Recipes => Screen::Dashboard,
        SidebarTab::Account => Screen::Account,
    };
    // Feature tabs lazily load on the next poll tick (see the Dashboard arm of
    // the poll loop); the renderer shows "Loading…" until then.
    if tab == SidebarTab::Services {
        app.list_state.select(Some(0));
    }
}

// ── Command palette (Ctrl+P) ──────────────────────────────────────────────────

/// One palette command. `Copy` so the filtered list can be cheaply rebuilt.
#[derive(Debug, Clone, Copy)]
pub enum PaletteAction {
    Tab(SidebarTab),
    NewChat,
    Sessions,
    ToggleDoubleCheck,
    NodePicker,
}

/// Every command the palette can run: a jump to each sidebar tab plus a few
/// chat/global actions. Labels double as search text.
pub fn palette_entries() -> Vec<(String, PaletteAction)> {
    let mut v: Vec<(String, PaletteAction)> = SIDEBAR_TABS
        .iter()
        .map(|t| (format!("Go to {}", t.label()), PaletteAction::Tab(*t)))
        .collect();
    v.push(("New chat".into(), PaletteAction::NewChat));
    v.push(("Sessions (run history)".into(), PaletteAction::Sessions));
    v.push(("Toggle double-check".into(), PaletteAction::ToggleDoubleCheck));
    v.push(("Switch node".into(), PaletteAction::NodePicker));
    v
}

/// Case-insensitive subsequence match (the chars of `query` appear in order in
/// `text`). Empty query matches everything.
fn fuzzy_match(query: &str, text: &str) -> bool {
    let mut q = query
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_lowercase());
    let mut needle = q.next();
    if needle.is_none() {
        return true;
    }
    for ch in text.chars().map(|c| c.to_ascii_lowercase()) {
        if Some(ch) == needle {
            needle = q.next();
            if needle.is_none() {
                return true;
            }
        }
    }
    false
}

/// The palette entries matching the current query, in declaration order.
pub fn filtered_palette(query: &str) -> Vec<(String, PaletteAction)> {
    palette_entries()
        .into_iter()
        .filter(|(label, _)| fuzzy_match(query, label))
        .collect()
}

/// Run a chosen palette command.
async fn run_palette_action(app: &mut App, action: PaletteAction) {
    match action {
        PaletteAction::Tab(tab) => switch_tab(app, tab),
        PaletteAction::NewChat => {
            app.conversation_id = uuid::Uuid::new_v4().to_string();
            app.chat.messages.clear();
            app.chat.error = None;
            app.chat_goal = crate::app::ChatGoal::default();
            switch_tab(app, SidebarTab::Chat);
        }
        PaletteAction::Sessions => {
            switch_tab(app, SidebarTab::Chat);
            open_sessions_overlay(app).await;
        }
        PaletteAction::ToggleDoubleCheck => app.double_check_on = !app.double_check_on,
        PaletteAction::NodePicker => open_node_picker(app).await,
    }
}

async fn go_next(app: &mut App) -> anyhow::Result<bool> {
    match app.current_screen {
        Screen::WaitingForCore => {}
        Screen::SetupDependencies => {
            if !app.all_dependencies_installed() {
                // Block advancing until all deps are installed
                return Ok(false);
            }
            app.current_screen = Screen::SetupProviders;
            app.list_state.select(Some(0));
        }
        Screen::SetupProviders => {
            app.current_screen = Screen::SetupTools;
            app.list_state.select(Some(0));
        }
        Screen::SetupTools => {
            app.current_screen = Screen::SetupAgents;
            app.list_state.select(Some(0));
        }
        Screen::SetupAgents => {
            let _ = api::install_selected(app).await;
            while event::poll(Duration::from_millis(0))? {
                let _ = event::read();
            }
            mark_initialized();
            app.install_started_at = Some(Instant::now());
            app.current_screen = Screen::Complete;
        }
        Screen::Complete => {
            app.current_screen = Screen::Dashboard;
            app.active_tab = SidebarTab::Services;
            app.list_state.select(Some(0));
        }
        Screen::Dashboard | Screen::Chat | Screen::Agents | Screen::Account => {}
    }
    Ok(false)
}

fn go_prev(app: &mut App) {
    match app.current_screen {
        Screen::WaitingForCore => {}
        Screen::SetupDependencies => {
            app.current_screen = Screen::Dashboard;
            app.active_tab = SidebarTab::Services;
        }
        Screen::SetupProviders => {
            app.current_screen = Screen::SetupDependencies;
            app.list_state.select(Some(0));
        }
        Screen::SetupTools => {
            app.current_screen = Screen::SetupProviders;
            app.list_state.select(Some(0));
        }
        Screen::SetupAgents => {
            app.current_screen = Screen::SetupTools;
            app.list_state.select(Some(0));
        }
        // Can't go back from Welcome, Complete, or Chat (handled separately)
        _ => {}
    }
}

fn list_up(app: &mut App, len: usize) {
    if len == 0 {
        return;
    }
    let next = app.list_state.selected().unwrap_or(0).saturating_sub(1);
    app.list_state.select(Some(next));
}

fn list_down(app: &mut App, len: usize) {
    if len == 0 {
        return;
    }
    let next = (app.list_state.selected().unwrap_or(0) + 1).min(len - 1);
    app.list_state.select(Some(next));
}

fn is_installed(app: &App, name: &str) -> bool {
    app.all_sidecars().any(|s| s.name == name && s.installed)
}

// ── Extracted action helpers (shared by keyboard & mouse handlers) ────────────

fn chat_scroll_up(app: &mut App) {
    app.chat.auto_scroll = false;
    app.chat.scroll = app.chat.scroll.saturating_sub(1);
}

fn chat_scroll_down(app: &mut App) {
    app.chat.scroll = app.chat.scroll.saturating_add(1);
}

/// Fetch spaces and conversations for the Spaces tab.
/// Both calls are fire-and-forget; errors are silently ignored so the tab
/// stays functional even when Core is temporarily unreachable.
async fn refresh_spaces_data(app: &mut App) {
    if let Ok(spaces) = api::fetch_spaces(&app.api_url).await {
        app.spaces = spaces;
        // Clamp selection after refresh.
        if !app.spaces.is_empty() && app.spaces_tab_index >= app.spaces.len() {
            app.spaces_tab_index = app.spaces.len() - 1;
        }
        // Fetch documents for the currently selected space if not yet cached.
        if let Some(space) = app.spaces.get(app.spaces_tab_index) {
            let id = space.id.clone();
            if !app.space_documents.contains_key(&id) {
                if let Ok(docs) = api::fetch_space_documents(&app.api_url, &id).await {
                    app.space_documents.insert(id, docs);
                }
            }
        }
    }
    if let Ok(convs) = api::fetch_conversations(&app.api_url).await {
        app.conversations = convs;
    }
}

/// Fetch documents for the currently selected space (called after the selection
/// changes so documents are loaded on demand rather than for every space upfront).
async fn refresh_selected_space_docs(app: &mut App) {
    if let Some(space) = app.spaces.get(app.spaces_tab_index) {
        let id = space.id.clone();
        if let Ok(docs) = api::fetch_space_documents(&app.api_url, &id).await {
            app.space_documents.insert(id, docs);
        }
    }
}

/// Fetch the agents Core has configured into `app.agents_list`. If the
/// previously selected agent is no longer offered, the selection is cleared so
/// the CLI never points at an agent Core doesn't know about.
async fn refresh_agents(app: &mut App) {
    let token = nodes::active_node().token;
    match app::fetch_agents(&app.api_url, token.as_deref()).await {
        Ok(agents) => {
            if let Some(sel) = &app.selected_agent {
                if !agents.iter().any(|a| &a.id == sel) {
                    app.selected_agent = None;
                }
            }
            app.agents_list = agents;
        }
        Err(_) => {
            // Core not running or no agents endpoint — leave the list as-is.
        }
    }
}

/// Open the node picker: load a stable snapshot of nodes, snap highlight to
/// the currently active node, and kick off concurrent health checks.
async fn open_node_picker(app: &mut App) {
    let config = nodes::load();
    let active = nodes::active_node();
    let idx = config
        .nodes
        .iter()
        .position(|n| n.name == active.name)
        .unwrap_or(0);
    app.node_picker_nodes = config.nodes.clone();
    app.node_picker_index = idx;
    app.node_picker_open = true;

    // Run health checks concurrently and cache results.
    let results: Vec<bool> = futures_util::future::join_all(
        config.nodes.iter().map(|n| api::health_check_node(n))
    ).await;
    app.node_health.clear();
    for (node, ok) in config.nodes.iter().zip(results.iter()) {
        app.node_health.insert(node.name.clone(), *ok);
    }
}

fn node_picker_up(app: &mut App) {
    let len = app.node_picker_nodes.len();
    if len == 0 {
        return;
    }
    if app.node_picker_index == 0 {
        app.node_picker_index = len - 1;
    } else {
        app.node_picker_index -= 1;
    }
}

fn node_picker_down(app: &mut App) {
    let len = app.node_picker_nodes.len();
    if len == 0 {
        return;
    }
    app.node_picker_index = (app.node_picker_index + 1) % len;
}

/// Commit the highlighted node as the new active node.
/// Updates `app.api_url` for the current session and persists to disk so that
/// all token-reading helpers (refresh_agents, refresh_workflows, etc.) also
/// pick up the new token on their next `nodes::active_node()` call.
async fn node_picker_confirm(app: &mut App) {
    if let Some(node) = app.node_picker_nodes.get(app.node_picker_index).cloned() {
        app.api_url = node.url.clone();
        let _ = nodes::set_active(&node.name);
    }
    app.node_picker_open = false;
}

/// Open the agent picker, snapping the highlight to the current selection.
fn open_agent_picker(app: &mut App) {
    app.agent_picker_open = true;
    // Row 0 is the "Default" (no agent) entry; agents follow at +1.
    app.agent_picker_index = match &app.selected_agent {
        Some(id) => app
            .agents_list
            .iter()
            .position(|a| &a.id == id)
            .map_or(0, |i| i + 1),
        None => 0,
    };
}

/// Number of rows in the picker: a leading "Default" entry plus every agent.
fn agent_picker_len(app: &App) -> usize {
    app.agents_list.len() + 1
}

fn agent_picker_up(app: &mut App) {
    if app.agent_picker_index == 0 {
        app.agent_picker_index = agent_picker_len(app).saturating_sub(1);
    } else {
        app.agent_picker_index -= 1;
    }
}

fn agent_picker_down(app: &mut App) {
    let len = agent_picker_len(app);
    app.agent_picker_index = (app.agent_picker_index + 1) % len.max(1);
}

/// Commit the highlighted picker row as the chat's selected agent.
fn agent_picker_confirm(app: &mut App) {
    app.selected_agent = if app.agent_picker_index == 0 {
        None
    } else {
        app.agents_list
            .get(app.agent_picker_index - 1)
            .map(|a| a.id.clone())
    };
    app.agent_picker_open = false;
}

fn send_chat_message(
    app: &mut App,
    chat_url: &str,
    chat_rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<chat::ChatEvent>>,
) {
    if !app.chat.input.trim().is_empty() && !app.chat.streaming {
        let input = std::mem::take(&mut app.chat.input);
        app.chat.error = None;
        app.chat.messages.push(chat::ChatMessage {
            role: chat::Role::User,
            content: input,
        });
        app.chat.messages.push(chat::ChatMessage {
            role: chat::Role::Assistant,
            content: String::new(),
        });
        app.chat.streaming = true;
        app.chat.auto_scroll = true;
        app.chat.scroll = usize::MAX;

        let history: Vec<chat::ChatMessage> =
            app.chat.messages[..app.chat.messages.len() - 1].to_vec();

        // Every turn routes through Core (`chat_url` = `/api/chat/stream`), which
        // picks its built-in default agent when no agent_id is sent. A selected
        // team wins over a selected agent (Core ignores agent_id when team_id is
        // set). The stable conversation_id is always attached so Core persists
        // the conversation and `/goal` / `/double-check` / sessions can key off it.
        let opts = chat::ChatOptions {
            agent_id: if app.selected_team.is_some() {
                None
            } else {
                app.selected_agent.clone()
            },
            conversation_id: Some(app.conversation_id.clone()),
            acp_model: app.selected_model.clone(),
            team_id: app.selected_team.clone(),
        };

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<chat::ChatEvent>();
        *chat_rx = Some(rx);
        tokio::spawn(chat::stream_chat(history, tx, chat_url.to_owned(), opts));
    }
}

/// Start a `/btw` side question (Claude-Code-style): ask something about the
/// current conversation in an ephemeral overlay, without touching chat history.
/// The current transcript is sent for context; the answer comes back over
/// `btw_rx`. No-op when the input has no question after `/btw`.
fn start_btw(
    app: &mut App,
    btw_url: &str,
    btw_rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<chat::BtwEvent>>,
) {
    let raw = std::mem::take(&mut app.chat.input);
    let question = raw
        .trim()
        .strip_prefix("/btw")
        .unwrap_or_default()
        .trim()
        .to_owned();
    if question.is_empty() {
        return;
    }
    let history = app.chat.messages.clone();
    app.btw = crate::app::BtwOverlay {
        open: true,
        question: question.clone(),
        loading: true,
        ..Default::default()
    };
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<chat::BtwEvent>();
    *btw_rx = Some(rx);
    tokio::spawn(chat::ask_btw(history, question, btw_url.to_owned(), tx));
}

// ── Chat slash commands ───────────────────────────────────────────────────────

/// Slash commands handled locally (everything except `/btw` and a plain send).
/// `/btw` and sessions are handled in the key handler because they touch
/// dedicated channels/overlays.
fn is_chat_slash_command(input: &str) -> bool {
    let verb = input.split_whitespace().next().unwrap_or("");
    matches!(
        verb,
        "/goal" | "/check" | "/double-check" | "/model" | "/team" | "/new" | "/newchat"
    )
}

/// Run a locally-handled chat slash command. Input already trimmed; the caller
/// clears the composer.
async fn handle_chat_command(app: &mut App, cmd: &str) {
    let (verb, rest) = match cmd.split_once(char::is_whitespace) {
        Some((v, r)) => (v, r.trim()),
        None => (cmd, ""),
    };
    match verb {
        "/goal" => {
            const CLEARS: &[&str] = &["clear", "stop", "off", "reset", "none", "cancel"];
            if rest.is_empty() || CLEARS.contains(&rest) {
                do_clear_goal(app).await;
            } else {
                do_set_goal(app, rest.to_string()).await;
            }
        }
        "/check" | "/double-check" => {
            app.double_check_on = !app.double_check_on;
        }
        "/model" => {
            app.selected_model = if rest.is_empty() || rest == "clear" {
                None
            } else {
                Some(rest.to_string())
            };
        }
        "/team" => {
            if rest.is_empty() || rest == "clear" {
                app.selected_team = None;
            } else {
                app.selected_team = Some(rest.to_string());
                app.selected_agent = None;
            }
        }
        "/new" | "/newchat" => {
            app.conversation_id = uuid::Uuid::new_v4().to_string();
            app.chat.messages.clear();
            app.chat.error = None;
            app.chat_goal = crate::app::ChatGoal::default();
        }
        _ => {}
    }
}

/// Set (or replace) the active goal on the current conversation.
async fn do_set_goal(app: &mut App, goal: String) {
    let (url, token) = api::active_url_and_token();
    match api::set_goal(&url, token.as_deref(), &app.conversation_id, &goal).await {
        Ok(()) => {
            app.chat_goal = crate::app::ChatGoal {
                condition: Some(goal),
                started_at: Some(Instant::now()),
                ..Default::default()
            };
        }
        Err(e) => app.chat_goal.error = Some(e.to_string()),
    }
}

/// Clear the active goal on the current conversation.
async fn do_clear_goal(app: &mut App) {
    let (url, token) = api::active_url_and_token();
    let _ = api::clear_goal(&url, token.as_deref(), &app.conversation_id).await;
    app.chat_goal = crate::app::ChatGoal::default();
}

/// Open the read-only sessions (runs) overlay for the current conversation.
async fn open_sessions_overlay(app: &mut App) {
    app.sessions_overlay = crate::app::SessionsOverlay {
        open: true,
        loading: true,
        ..Default::default()
    };
    let (url, token) = api::active_url_and_token();
    match api::fetch_sessions(&url, token.as_deref(), &app.conversation_id).await {
        Ok(rows) => {
            app.sessions_overlay.rows = rows;
            app.sessions_overlay.loading = false;
        }
        Err(e) => {
            app.sessions_overlay.error = Some(e.to_string());
            app.sessions_overlay.loading = false;
        }
    }
}

async fn do_start_sidecar(app: &mut App) {
    if let Some(idx) = app.list_state.selected() {
        if let Some(name) = SIDECAR_ORDER.get(idx) {
            if is_installed(app, name) {
                let _ = api::start_sidecar(&app.api_url, name).await;
                let _ = api::fetch_status(app).await;
            }
        }
    }
}

async fn do_stop_sidecar(app: &mut App) {
    if let Some(idx) = app.list_state.selected() {
        if let Some(name) = SIDECAR_ORDER.get(idx) {
            let _ = api::stop_sidecar(&app.api_url, name).await;
            let _ = api::fetch_status(app).await;
        }
    }
}

async fn do_restart_sidecar(app: &mut App) {
    if let Some(idx) = app.list_state.selected() {
        if let Some(name) = SIDECAR_ORDER.get(idx) {
            if is_installed(app, name) {
                let _ = api::restart_sidecar_runtime(&app.api_url, name).await;
                let _ = api::fetch_status(app).await;
            }
        }
    }
}

async fn do_start_all(app: &mut App) {
    let _ = api::start_all(&app.api_url).await;
    let _ = api::fetch_status(app).await;
}

async fn do_stop_all(app: &mut App) {
    let _ = api::stop_all(&app.api_url).await;
    let _ = api::fetch_status(app).await;
}

async fn do_install_sidecar(app: &mut App) {
    if let Some(idx) = app.list_state.selected() {
        if let Some(&name) = SIDECAR_ORDER.get(idx) {
            let already = is_installed(app, name);
            let downloading = app.install_results.iter().any(|(n, q)| n == name && *q);
            if !already && !downloading {
                let queued = api::install_sidecar(&app.api_url, name)
                    .await
                    .unwrap_or(false);
                if let Some(entry) = app.install_results.iter_mut().find(|(n, _)| n == name) {
                    entry.1 = queued;
                } else {
                    app.install_results.push((name.to_string(), queued));
                }
                let _ = api::fetch_installed(app).await;
                let _ = api::fetch_install_status(app).await;
            }
        }
    }
}

async fn do_uninstall_sidecar(app: &mut App) {
    if let Some(idx) = app.list_state.selected() {
        if let Some(&name) = SIDECAR_ORDER.get(idx) {
            if is_installed(app, name) {
                let _ = api::uninstall_sidecar(&app.api_url, name).await;
                app.install_results.retain(|(n, _)| n != name);
                let _ = api::fetch_installed(app).await;
                let _ = api::fetch_install_status(app).await;
            }
        }
    }
}

fn apps_list_up(app: &mut App) {
    let len = app.catalog_items.len();
    if len == 0 {
        return;
    }
    let next = app.apps_list_state.selected().unwrap_or(0).saturating_sub(1);
    app.apps_list_state.select(Some(next));
}

fn apps_list_down(app: &mut App) {
    let len = app.catalog_items.len();
    if len == 0 {
        return;
    }
    let next = (app.apps_list_state.selected().unwrap_or(0) + 1).min(len - 1);
    app.apps_list_state.select(Some(next));
}

async fn do_install_catalog_item(app: &mut App) {
    if let Some(idx) = app.apps_list_state.selected() {
        if let Some(item) = app.catalog_items.get(idx) {
            let name = item.name.clone();
            let already_installed = item.install_state == "installed";
            let installing = item.install_state == "installing";
            if !already_installed && !installing {
                let _ = api::install_sidecar(&app.api_url, &name).await;
                // Refresh catalog to reflect the new install_state
                let token = nodes::active_node().token;
                if let Ok(items) = app::fetch_catalog(&app.api_url, token.as_deref()).await {
                    app.catalog_items = items;
                }
            }
        }
    }
}

async fn do_uninstall_catalog_item(app: &mut App) {
    if let Some(idx) = app.apps_list_state.selected() {
        if let Some(item) = app.catalog_items.get(idx) {
            let name = item.name.clone();
            let installed = item.install_state == "installed";
            if installed {
                let _ = api::uninstall_sidecar(&app.api_url, &name).await;
                // Refresh catalog to reflect the new install_state
                let token = nodes::active_node().token;
                if let Ok(items) = app::fetch_catalog(&app.api_url, token.as_deref()).await {
                    app.catalog_items = items;
                }
            }
        }
    }
}

async fn refresh_workflows(app: &mut App) {
    let token = nodes::active_node().token;
    match api::fetch_workflows(&app.api_url, token.as_deref()).await {
        Ok(wfs) => {
            app.workflows_list = wfs;
            if app.workflows_tab_index >= app.workflows_list.len() && !app.workflows_list.is_empty() {
                app.workflows_tab_index = app.workflows_list.len() - 1;
            }
        }
        Err(_) => {
            // Core not running or no workflows — leave list as-is.
        }
    }
}

/// Trigger a run for the currently selected workflow.
async fn do_trigger_workflow_run(app: &mut App) {
    let wf = match app.workflows_list.get(app.workflows_tab_index) {
        Some(w) => w.clone(),
        None => return,
    };
    let token = nodes::active_node().token;
    app.workflow_run_id = None;
    app.workflow_run_state = None;
    app.workflow_run_output = None;
    app.workflow_run_error = None;
    app.workflow_run_loading = true;
    match api::trigger_workflow_run(&app.api_url, token.as_deref(), &wf.id).await {
        Ok(run_id) => {
            app.workflow_run_id = Some(run_id);
            app.workflow_run_state = Some("running".to_string());
            app.workflow_run_loading = false;
        }
        Err(e) => {
            app.workflow_run_error = Some(format!("{e}"));
            app.workflow_run_loading = false;
        }
    }
}

/// Poll status for the current run if one is active and not yet terminal.
async fn poll_workflow_run(app: &mut App) {
    let run_id = match &app.workflow_run_id {
        Some(id) => id.clone(),
        None => return,
    };
    let is_terminal = app
        .workflow_run_state
        .as_deref()
        .map(|s| s == "completed" || s == "failed")
        .unwrap_or(false);
    if is_terminal {
        return;
    }
    let token = nodes::active_node().token;
    app.workflow_run_loading = true;
    match api::fetch_workflow_run(&app.api_url, token.as_deref(), &run_id).await {
        Ok((state, output)) => {
            app.workflow_run_state = Some(state);
            app.workflow_run_output = output;
            app.workflow_run_loading = false;
        }
        Err(e) => {
            app.workflow_run_error = Some(format!("{e}"));
            app.workflow_run_loading = false;
        }
    }
}

/// Fetch engines from Core and merge the active-engine marker.
/// No engine name is hardcoded — all data comes from `GET /api/engines`
/// and `GET /api/engine/active`.
async fn refresh_engines(app: &mut App) {
    let token = nodes::active_node().token;
    let engines_res = api::fetch_engines(&app.api_url, token.as_deref()).await;
    let active_res = api::fetch_active_engine(&app.api_url, token.as_deref()).await;

    if let Ok(mut engines) = engines_res {
        let active_name = active_res.as_ref().ok().and_then(|a| a.active.as_deref()).unwrap_or("");
        for eng in &mut engines {
            eng.active = eng.name == active_name || eng.id == active_name;
        }
        app.engines_list = engines;
        if app.engines_tab_index >= app.engines_list.len() && !app.engines_list.is_empty() {
            app.engines_tab_index = app.engines_list.len() - 1;
        }
    }
    if let Ok(active) = active_res {
        app.engine_active = active;
    }
}

/// Activate the engine at `app.engines_tab_index` by POSTing `/api/engine/active`.
/// The choice is persisted by Core, not the CLI.
async fn do_activate_engine(app: &mut App) {
    let engine = match app.engines_list.get(app.engines_tab_index) {
        Some(e) => e.clone(),
        None => return,
    };
    let token = nodes::active_node().token;
    if api::post_active_engine(&app.api_url, token.as_deref(), &engine.name).await.is_ok() {
        // Refresh so the active marker updates immediately.
        refresh_engines(app).await;
    }
}

/// Fetch scheduled jobs from Core. No job is hardcoded — all data comes
/// from `GET /heartbeat/jobs`.
async fn refresh_schedules(app: &mut App) {
    let token = nodes::active_node().token;
    match api::fetch_scheduled_jobs(&app.api_url, token.as_deref()).await {
        Ok(jobs) => {
            app.scheduled_jobs = jobs;
            if app.schedules_tab_index >= app.scheduled_jobs.len()
                && !app.scheduled_jobs.is_empty()
            {
                app.schedules_tab_index = app.scheduled_jobs.len() - 1;
            }
        }
        Err(_) => {
            // Core not running or no jobs — leave list as-is.
        }
    }
}

// ── Data-driven feature tabs (Models/Skills/Tools/Monitors/Teams/Meetings/Recipes) ──

/// Move the selection in a feature tab's list by `delta` (clamped).
fn feature_tab_nav(app: &mut App, tab: SidebarTab, delta: isize) {
    if let Some(state) = app.feature_tabs.get_mut(&tab) {
        if state.rows.is_empty() {
            return;
        }
        let max = state.rows.len() - 1;
        let next = (state.index as isize + delta).clamp(0, max as isize) as usize;
        state.index = next;
    }
}

/// Fetch (or re-fetch) a feature tab's rows from its Core list endpoint. The
/// endpoint + field-key mapping is inline per tab — nothing about a specific
/// schema leaks into the generic `fetch_feature_list`.
async fn refresh_feature_tab(app: &mut App, tab: SidebarTab) {
    if !tab.is_feature_tab() {
        return;
    }
    let (url, token) = api::active_url_and_token();
    let t = token.as_deref();
    {
        let state = app.feature_tabs.entry(tab).or_default();
        state.loading = true;
        state.error = None;
    }
    let result = match tab {
        SidebarTab::Models => {
            api::fetch_feature_list(&url, t, "/api/models/catalog?limit=30",
                &["data", "models", "items", "results"],
                &["name", "id", "model_id", "slug"],
                &["description", "author", "pipeline_tag"],
                &["downloads", "installs", "likes"],
                &["id", "model_id", "slug"]).await
        }
        SidebarTab::Skills => {
            api::fetch_feature_list(&url, t, "/api/skills/catalog?limit=30",
                &["skills", "data", "results"],
                &["name", "slug", "id"],
                &["description", "summary"],
                &["installed"],
                &["id", "slug"]).await
        }
        SidebarTab::Tools => {
            api::fetch_feature_list(&url, t, "/api/tools/search?limit=30",
                &["data", "tools", "results"],
                &["name", "id"],
                &["description"],
                &["kind"],
                &["id"]).await
        }
        SidebarTab::Monitors => {
            api::fetch_feature_list(&url, t, "/api/monitors",
                &["monitors", "data"],
                &["name", "id"],
                &["url"],
                &["last_status", "enabled"],
                &["id"]).await
        }
        SidebarTab::Teams => {
            api::fetch_feature_list(&url, t, "/api/teams",
                &["teams", "data"],
                &["name", "id"],
                &["coordination", "description"],
                &["members"],
                &["id"]).await
        }
        SidebarTab::Meetings => {
            api::fetch_feature_list(&url, t, "/api/meetings",
                &["meetings", "data"],
                &["title", "name", "id"],
                &["created_at", "status"],
                &["status"],
                &["id"]).await
        }
        SidebarTab::Recipes => {
            api::fetch_feature_list(&url, t, "/api/recipes",
                &["recipes", "data"],
                &["name", "id"],
                &["description", "task"],
                &["steps"],
                &["name", "id"]).await
        }
        _ => Ok(Vec::new()),
    };
    let state = app.feature_tabs.entry(tab).or_default();
    state.loading = false;
    state.loaded = true;
    match result {
        Ok(rows) => {
            state.rows = rows;
            if !state.rows.is_empty() && state.index >= state.rows.len() {
                state.index = state.rows.len() - 1;
            }
        }
        Err(e) => state.error = Some(e.to_string()),
    }
}

/// Primary action (Enter) on the selected row of a feature tab.
async fn feature_tab_action(app: &mut App, tab: SidebarTab) {
    let (url, token) = api::active_url_and_token();
    let t = token.as_deref();
    let id = match app.feature_tabs.get(&tab).and_then(|s| s.rows.get(s.index)) {
        Some(row) if !row.id.is_empty() => row.id.clone(),
        _ => return,
    };
    let (verb, result) = match tab {
        SidebarTab::Models => ("install queued", api::install_model_by_id(&url, t, &id).await),
        SidebarTab::Skills => (
            "install queued",
            api::install_skill_by_id(&url, t, &id).await.map(|_| ()),
        ),
        SidebarTab::Monitors => ("checked", api::run_monitor(&url, t, &id).await),
        SidebarTab::Recipes => ("replayed", api::run_recipe(&url, t, &id).await),
        // Tools / Teams / Meetings are browse-only in the CLI for now.
        _ => return,
    };
    let state = app.feature_tabs.entry(tab).or_default();
    state.notice = Some(match result {
        Ok(()) => format!("{verb}: {id}"),
        Err(e) => format!("error: {e}"),
    });
}

/// Secondary action ('a') on the selected row — "activate / use".
async fn feature_tab_secondary(app: &mut App, tab: SidebarTab) {
    let (url, token) = api::active_url_and_token();
    let t = token.as_deref();
    let id = match app.feature_tabs.get(&tab).and_then(|s| s.rows.get(s.index)) {
        Some(row) if !row.id.is_empty() => row.id.clone(),
        _ => return,
    };
    let (verb, result) = match tab {
        SidebarTab::Models => ("active model", api::set_active_model(&url, t, &id).await),
        SidebarTab::Skills => ("activated", api::set_skill_active(&url, t, &id, true).await),
        _ => return,
    };
    let state = app.feature_tabs.entry(tab).or_default();
    state.notice = Some(match result {
        Ok(()) => format!("{verb}: {id}"),
        Err(e) => format!("error: {e}"),
    });
}

async fn refresh_catalog(app: &mut App) {
    let token = nodes::active_node().token;
    if let Ok(items) = app::fetch_catalog(&app.api_url, token.as_deref()).await {
        app.catalog_items = items;
        if app.apps_list_state.selected().is_none() && !app.catalog_items.is_empty() {
            app.apps_list_state.select(Some(0));
        }
    }
}

fn do_login(
    app: &mut App,
    login_rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<auth::LoginEvent>>,
) {
    if app.auth_info.is_none() && !app.login_pending {
        let backend_url =
            std::env::var("RYU_AUTH_URL").unwrap_or_else(|_| "http://localhost:3000".into());
        *login_rx = Some(auth::spawn_login_background(&backend_url));
        app.login_pending = true;
    }
}

fn do_logout(app: &mut App) {
    if app.auth_info.is_some() {
        let _ = auth::clear_token();
        app.auth_info = None;
    }
}

async fn do_install_deps(app: &mut App) {
    let _ = api::install_dependencies(app).await;
    app.deps_installing = true;
    app.deps_install_started = Some(Instant::now());
    app.last_poll = Instant::now();
}

fn do_wizard_pick(app: &mut App) {
    match app.current_screen {
        Screen::SetupProviders => {
            let idx = app.list_state.selected().unwrap_or(0);
            if app.providers.get(idx).map(|p| p.supported).unwrap_or(false) {
                for (i, p) in app.providers.iter_mut().enumerate() {
                    p.selected = i == idx;
                }
            }
        }
        Screen::SetupTools => {
            if let Some(idx) = app.list_state.selected() {
                if app.tools.get(idx).map(|t| t.supported).unwrap_or(false) {
                    app.tools[idx].selected = !app.tools[idx].selected;
                }
            }
        }
        Screen::SetupAgents => {
            let idx = app.list_state.selected().unwrap_or(0);
            if app.agents.get(idx).map(|a| a.supported).unwrap_or(false) {
                for (i, a) in app.agents.iter_mut().enumerate() {
                    a.selected = i == idx;
                }
            }
        }
        _ => {}
    }
}

fn wizard_list_up(app: &mut App) {
    let len = match app.current_screen {
        Screen::SetupDependencies => app.dependencies.len(),
        Screen::SetupProviders => app.providers.len(),
        Screen::SetupTools => app.tools.len(),
        Screen::SetupAgents => app.agents.len(),
        _ => 0,
    };
    list_up(app, len);
}

fn wizard_list_down(app: &mut App) {
    let len = match app.current_screen {
        Screen::SetupDependencies => app.dependencies.len(),
        Screen::SetupProviders => app.providers.len(),
        Screen::SetupTools => app.tools.len(),
        Screen::SetupAgents => app.agents.len(),
        _ => 0,
    };
    list_down(app, len);
}

// ── Mouse hit-testing helpers ────────────────────────────────────────────────

fn rect_contains(rect: ratatui::layout::Rect, col: u16, row: u16) -> bool {
    col >= rect.x && col < rect.x + rect.width && row >= rect.y && row < rect.y + rect.height
}

fn hit_sidebar_tab(app: &App, col: u16, row: u16) -> Option<SidebarTab> {
    for &(rect, tab) in &app.click_regions.sidebar_tabs {
        if rect_contains(rect, col, row) {
            return Some(tab);
        }
    }
    None
}

fn hit_hint_button(app: &App, col: u16, row: u16) -> Option<HintAction> {
    for &(rect, action) in &app.click_regions.hint_buttons {
        if rect_contains(rect, col, row) {
            return Some(action);
        }
    }
    None
}

enum DispatchResult {
    Quit,
    Continue,
}

async fn dispatch_hint_action(
    action: HintAction,
    app: &mut App,
    chat_url: &str,
    chat_rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<chat::ChatEvent>>,
    login_rx: &mut Option<tokio::sync::mpsc::UnboundedReceiver<auth::LoginEvent>>,
) -> anyhow::Result<DispatchResult> {
    match action {
        HintAction::Quit => {
            let is_wizard = matches!(
                app.current_screen,
                Screen::SetupDependencies
                    | Screen::SetupProviders
                    | Screen::SetupTools
                    | Screen::SetupAgents
                    | Screen::Complete
            );
            if is_wizard {
                app.current_screen = Screen::Dashboard;
                app.active_tab = SidebarTab::Services;
                app.list_state.select(Some(0));
            } else {
                return Ok(DispatchResult::Quit);
            }
        }
        HintAction::SwitchTab => {
            let cur = SIDEBAR_TABS
                .iter()
                .position(|t| *t == app.active_tab)
                .unwrap_or(0);
            let next = (cur + 1) % SIDEBAR_TABS.len();
            switch_tab(app, SIDEBAR_TABS[next]);
        }
        HintAction::NavUp => match app.active_tab {
            SidebarTab::Services => list_up(app, SIDECAR_ORDER.len()),
            SidebarTab::Chat => chat_scroll_up(app),
            SidebarTab::Apps => apps_list_up(app),
            SidebarTab::Engines => {
                if app.engines_tab_index > 0 {
                    app.engines_tab_index -= 1;
                }
            }
            SidebarTab::Schedules => {
                if app.schedules_tab_index > 0 {
                    app.schedules_tab_index -= 1;
                }
            }
            t if t.is_feature_tab() => feature_tab_nav(app, t, -1),
            _ => {}
        },
        HintAction::NavDown => match app.active_tab {
            SidebarTab::Services => list_down(app, SIDECAR_ORDER.len()),
            SidebarTab::Chat => chat_scroll_down(app),
            SidebarTab::Apps => apps_list_down(app),
            SidebarTab::Engines => {
                let len = app.engines_list.len();
                if len > 0 && app.engines_tab_index < len - 1 {
                    app.engines_tab_index += 1;
                }
            }
            SidebarTab::Schedules => {
                let len = app.scheduled_jobs.len();
                if len > 0 && app.schedules_tab_index < len - 1 {
                    app.schedules_tab_index += 1;
                }
            }
            t if t.is_feature_tab() => feature_tab_nav(app, t, 1),
            _ => {}
        },
        HintAction::ScrollUp => chat_scroll_up(app),
        HintAction::ScrollDown => chat_scroll_down(app),
        HintAction::Send => send_chat_message(app, chat_url, chat_rx),
        HintAction::StartSidecar => do_start_sidecar(app).await,
        HintAction::StopSidecar => do_stop_sidecar(app).await,
        HintAction::RestartSidecar => do_restart_sidecar(app).await,
        HintAction::StartAll => do_start_all(app).await,
        HintAction::StopAll => do_stop_all(app).await,
        HintAction::Install => {
            if app.active_tab == SidebarTab::Apps {
                do_install_catalog_item(app).await;
            } else {
                do_install_sidecar(app).await;
            }
        }
        HintAction::Uninstall => {
            if app.active_tab == SidebarTab::Apps {
                do_uninstall_catalog_item(app).await;
            } else {
                do_uninstall_sidecar(app).await;
            }
        }
        HintAction::Setup => {
            app.current_screen = Screen::SetupDependencies;
            app.list_state.select(Some(0));
        }
        HintAction::Refresh => {
            if app.active_tab.is_feature_tab() {
                let tab = app.active_tab;
                refresh_feature_tab(app, tab).await;
            } else if app.active_tab == SidebarTab::Apps {
                refresh_catalog(app).await;
            } else if app.active_tab == SidebarTab::Spaces {
                refresh_spaces_data(app).await;
            } else if app.active_tab == SidebarTab::Engines {
                refresh_engines(app).await;
            } else if app.active_tab == SidebarTab::Schedules {
                refresh_schedules(app).await;
            } else if app.current_screen == Screen::SetupDependencies {
                let _ = api::check_dependencies(app).await;
            } else {
                app.auth_info = auth::fetch_auth_info().await;
            }
        }
        HintAction::Login => do_login(app, login_rx),
        HintAction::Logout => do_logout(app),
        HintAction::PrevStep => go_prev(app),
        HintAction::NextStep => {
            if !matches!(app.current_screen, Screen::WaitingForCore) {
                let _ = go_next(app).await?;
            }
        }
        HintAction::Pick => {
            if matches!(app.current_screen, Screen::Chat | Screen::Dashboard)
                && app.active_tab == SidebarTab::Chat
            {
                refresh_agents(app).await;
                open_agent_picker(app);
            } else if app.active_tab == SidebarTab::Engines {
                do_activate_engine(app).await;
            } else if app.active_tab.is_feature_tab() {
                let tab = app.active_tab;
                feature_tab_action(app, tab).await;
            } else {
                do_wizard_pick(app);
            }
        }
        HintAction::Dashboard => {
            app.current_screen = Screen::Dashboard;
            app.active_tab = SidebarTab::Services;
            app.list_state.select(Some(0));
        }
        HintAction::InstallDeps => do_install_deps(app).await,
        HintAction::NodePicker => {
            open_node_picker(app).await;
        }
    }
    Ok(DispatchResult::Continue)
}

async fn run_app<B: ratatui::backend::Backend>(
    terminal: &mut Terminal<B>,
    mut app: App,
) -> anyhow::Result<()> {
    // Select the preferred reachable node before doing any API calls so that
    // all subsequent fetches use the right url+token automatically.
    {
        let preferred = api::select_preferred_node().await;
        app.api_url = preferred.url.clone();
    }

    if api::fetch_status(&mut app).await.is_ok() {
        app.core_connected = true;
    }
    let _ = api::fetch_installed(&mut app).await;
    let _ = api::check_dependencies(&mut app).await;
    app.auth_info = auth::fetch_auth_info().await;
    app.list_state.select(Some(0));
    refresh_agents(&mut app).await;
    // Pre-fetch gateway status so the Gateway tab is populated immediately.
    let _ = api::fetch_gateway_status(&mut app).await;
    refresh_workflows(&mut app).await;
    // Pre-fetch spaces and conversations for the Spaces tab.
    refresh_spaces_data(&mut app).await;
    // Pre-fetch engines and scheduled jobs so those tabs are populated immediately.
    refresh_engines(&mut app).await;
    refresh_schedules(&mut app).await;

    // Default chat routes through Ryu Core (/api/chat/stream), which selects its
    // built-in default agent when no agent_id is sent. Built from the active
    // node's url so chat and the goal/double-check/session calls all hit the
    // same Core. The legacy server /ai Gemini endpoint is not a shipped path.
    let chat_url = format!("{}/api/chat/stream", app.api_url);
    let mut chat_rx: Option<tokio::sync::mpsc::UnboundedReceiver<chat::ChatEvent>> = None;
    // Post-turn hook channels: goal-judge verdicts and double-check reviews.
    let mut goal_rx: Option<tokio::sync::mpsc::UnboundedReceiver<chat::GoalEvent>> = None;
    let mut dc_rx: Option<tokio::sync::mpsc::UnboundedReceiver<chat::DoubleCheckEvent>> = None;
    let mut login_rx: Option<tokio::sync::mpsc::UnboundedReceiver<auth::LoginEvent>> = None;
    // `/btw` side questions hit Core directly (always Core, never the /ai
    // playground) so the answer sees the same conversation the chat does.
    let btw_url = format!("{}/api/btw", app.api_url);
    let mut btw_rx: Option<tokio::sync::mpsc::UnboundedReceiver<chat::BtwEvent>> = None;

    loop {
        app.animation_tick = app.animation_tick.wrapping_add(1);
        terminal.draw(|f| ui(f, &mut app))?;

        // ── Drain chat stream events ───────────────────────────────────
        if let Some(rx) = &mut chat_rx {
            loop {
                match rx.try_recv() {
                    Ok(chat::ChatEvent::Chunk(text)) => {
                        if let Some(last) = app.chat.messages.last_mut() {
                            last.content.push_str(&text);
                        }
                        // Keep scroll pinned to bottom while streaming
                        app.chat.scroll = usize::MAX;
                    }
                    Ok(chat::ChatEvent::Done) => {
                        app.chat.streaming = false;
                        app.chat.turn_just_completed = true;
                        chat_rx = None;
                        break;
                    }
                    Ok(chat::ChatEvent::Error(e)) => {
                        app.chat.error = Some(e);
                        app.chat.streaming = false;
                        chat_rx = None;
                        break;
                    }
                    Err(tokio::sync::mpsc::error::TryRecvError::Empty) => break,
                    Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                        app.chat.streaming = false;
                        chat_rx = None;
                        break;
                    }
                }
            }
        }

        // ── Post-turn hooks: goal judge + double-check ─────────────────
        // Fire exactly once when an assistant turn finishes streaming.
        if app.chat.turn_just_completed {
            app.chat.turn_just_completed = false;
            if app.double_check_on && dc_rx.is_none() {
                app.double_check = crate::app::DoubleCheckOverlay {
                    open: true,
                    loading: true,
                    ..Default::default()
                };
                let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<chat::DoubleCheckEvent>();
                dc_rx = Some(rx);
                let (url, token) = api::active_url_and_token();
                tokio::spawn(chat::double_check(
                    url,
                    app.conversation_id.clone(),
                    token,
                    tx,
                ));
            }
            if app.chat_goal.condition.is_some() && !app.chat_goal.achieved && goal_rx.is_none() {
                app.chat_goal.judging = true;
                app.chat_goal.error = None;
                let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<chat::GoalEvent>();
                goal_rx = Some(rx);
                let (url, token) = api::active_url_and_token();
                tokio::spawn(chat::judge_goal(url, app.conversation_id.clone(), token, tx));
            }
        }

        // ── Drain goal-judge verdicts (drives the continuation loop) ───
        if let Some(rx) = &mut goal_rx {
            match rx.try_recv() {
                Ok(chat::GoalEvent::Verdict { met, reason, stop, turns }) => {
                    app.chat_goal.judging = false;
                    app.chat_goal.turns = turns;
                    app.chat_goal.last_reason = Some(reason);
                    goal_rx = None;
                    if met {
                        app.chat_goal.achieved = true;
                    } else if !stop
                        && app.chat_goal.turns < crate::app::MAX_GOAL_TURNS
                        // Local backstop: never auto-continue past the cap even
                        // if the server's `turns` never advances.
                        && app.chat_goal.loop_count < crate::app::MAX_GOAL_TURNS
                        && !app.chat.streaming
                    {
                        // Not met, keep going: nudge the agent toward the goal.
                        app.chat_goal.loop_count += 1;
                        app.chat.input = "Continue working toward the goal.".to_string();
                        send_chat_message(&mut app, &chat_url, &mut chat_rx);
                    }
                }
                Ok(chat::GoalEvent::Error(e)) => {
                    app.chat_goal.judging = false;
                    app.chat_goal.error = Some(e);
                    goal_rx = None;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    app.chat_goal.judging = false;
                    goal_rx = None;
                }
            }
        }

        // ── Drain double-check reviews ─────────────────────────────────
        if let Some(rx) = &mut dc_rx {
            match rx.try_recv() {
                Ok(chat::DoubleCheckEvent::Result { ok, critique, model }) => {
                    app.double_check.loading = false;
                    app.double_check.ok = Some(ok);
                    app.double_check.critique = critique;
                    app.double_check.model = model;
                    dc_rx = None;
                }
                Ok(chat::DoubleCheckEvent::Error(e)) => {
                    app.double_check.loading = false;
                    app.double_check.error = Some(e);
                    dc_rx = None;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    app.double_check.loading = false;
                    dc_rx = None;
                }
            }
        }

        // ── Drain `/btw` side-question events ──────────────────────────
        if let Some(rx) = &mut btw_rx {
            match rx.try_recv() {
                Ok(chat::BtwEvent::Answer(text)) => {
                    app.btw.answer = Some(text);
                    app.btw.loading = false;
                    btw_rx = None;
                }
                Ok(chat::BtwEvent::Error(e)) => {
                    app.btw.error = Some(e);
                    app.btw.loading = false;
                    btw_rx = None;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    app.btw.loading = false;
                    btw_rx = None;
                }
            }
        }

        // Drain login flow events
        if let Some(rx) = &mut login_rx {
            match rx.try_recv() {
                Ok(auth::LoginEvent::Success) => {
                    app.login_pending = false;
                    app.auth_info = auth::fetch_auth_info().await;
                    login_rx = None;
                }
                Ok(auth::LoginEvent::Error(_)) => {
                    app.login_pending = false;
                    login_rx = None;
                }
                Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {}
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => {
                    app.login_pending = false;
                    login_rx = None;
                }
            }
        }

        // Auto-refresh: 1 second while waiting for core, 2 seconds otherwise.
        // Skip API polling on the Chat screen to avoid stalling the stream.
        let poll_interval = if app.current_screen == Screen::WaitingForCore {
            Duration::from_secs(1)
        } else {
            Duration::from_secs(2)
        };
        if app.last_poll.elapsed() >= poll_interval && app.current_screen != Screen::Chat {
            match app.current_screen {
                Screen::WaitingForCore => {
                    if api::fetch_status(&mut app).await.is_ok() {
                        app.core_connected = true;
                        let _ = api::fetch_installed(&mut app).await;
                        let _ = api::check_dependencies(&mut app).await;
                        app.current_screen = Screen::SetupDependencies;
                        app.list_state.select(Some(0));
                    }
                }
                Screen::Dashboard | Screen::Complete | Screen::Account => {
                    if api::fetch_status(&mut app).await.is_ok() {
                        app.core_connected = true;
                    } else {
                        app.core_connected = false;
                    }
                    let _ = api::fetch_installed(&mut app).await;
                    let _ = api::fetch_install_status(&mut app).await;
                    if app.auth_info.is_none() {
                        app.auth_info = auth::fetch_auth_info().await;
                    }
                    if app.active_tab == SidebarTab::Apps {
                        refresh_catalog(&mut app).await;
                    }
                    // Refresh gateway status in the background so the Gateway tab
                    // shows up-to-date data without a dedicated screen state.
                    if app.active_tab == SidebarTab::Gateway {
                        let _ = api::fetch_gateway_status(&mut app).await;
                    }
                    if app.active_tab == SidebarTab::Workflows {
                        if app.workflows_list.is_empty() {
                            refresh_workflows(&mut app).await;
                        }
                        // Poll active run if not yet terminal.
                        poll_workflow_run(&mut app).await;
                    }
                    // Refresh spaces and conversations when the Spaces tab is active.
                    if app.active_tab == SidebarTab::Spaces {
                        refresh_spaces_data(&mut app).await;
                    }
                    // Refresh engines and schedules when those tabs are active.
                    if app.active_tab == SidebarTab::Engines {
                        if app.engines_list.is_empty() {
                            refresh_engines(&mut app).await;
                        }
                    }
                    if app.active_tab == SidebarTab::Schedules {
                        if app.scheduled_jobs.is_empty() {
                            refresh_schedules(&mut app).await;
                        }
                    }
                    // Lazily load a data-driven feature tab the first time it is
                    // viewed (the renderer shows "Loading…" until this lands).
                    if app.active_tab.is_feature_tab() {
                        let tab = app.active_tab;
                        let need = app
                            .feature_tabs
                            .get(&tab)
                            .map_or(true, |t| !t.loaded && !t.loading);
                        if need {
                            refresh_feature_tab(&mut app, tab).await;
                        }
                    }
                }
                Screen::SetupDependencies if app.deps_installing => {
                    let _ = api::check_dependencies(&mut app).await;
                    // Stop spinner once all installed
                    if app.all_dependencies_installed() {
                        app.deps_installing = false;
                    }
                }
                _ => {}
            }
            app.last_poll = Instant::now();
        }

        // Use a shorter poll timeout when streaming to keep the UI responsive.
        let poll_ms = if app.chat.streaming { 16 } else { 100 };
        if !event::poll(Duration::from_millis(poll_ms))? {
            continue;
        }

        match event::read()? {
            // ── Keyboard events ──────────────────────────────────────
            Event::Key(key) => {
                if key.kind != KeyEventKind::Press {
                    continue;
                }

                if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('c') {
                    return Ok(());
                }

                let is_main_app = matches!(
                    app.current_screen,
                    Screen::Dashboard | Screen::Chat | Screen::Agents | Screen::Account
                );

                if is_main_app {
                    // Command palette captures all input while open.
                    if app.palette.open {
                        match (key.modifiers, key.code) {
                            (_, KeyCode::Esc)
                            | (KeyModifiers::CONTROL, KeyCode::Char('p')) => {
                                app.palette.open = false;
                            }
                            (KeyModifiers::NONE, KeyCode::Up) => {
                                app.palette.index = app.palette.index.saturating_sub(1);
                            }
                            (KeyModifiers::NONE, KeyCode::Down) => {
                                let len = filtered_palette(&app.palette.query).len();
                                if len > 0 {
                                    app.palette.index = (app.palette.index + 1).min(len - 1);
                                }
                            }
                            (KeyModifiers::NONE, KeyCode::Enter) => {
                                let matches = filtered_palette(&app.palette.query);
                                let chosen = matches.get(app.palette.index).map(|(_, a)| *a);
                                app.palette.open = false;
                                if let Some(action) = chosen {
                                    run_palette_action(&mut app, action).await;
                                }
                            }
                            (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Backspace) => {
                                app.palette.query.pop();
                                app.palette.index = 0;
                            }
                            (KeyModifiers::NONE | KeyModifiers::SHIFT, KeyCode::Char(c)) => {
                                app.palette.query.push(c);
                                app.palette.index = 0;
                            }
                            _ => {}
                        }
                        continue;
                    }

                    // Open the command palette with Ctrl+P (global, any tab).
                    if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('p') {
                        app.palette = crate::app::CommandPalette { open: true, ..Default::default() };
                        continue;
                    }

                    // Node picker overlay captures all input while open.
                    if app.node_picker_open {
                        match (key.modifiers, key.code) {
                            (_, KeyCode::Esc) => app.node_picker_open = false,
                            (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                node_picker_up(&mut app);
                            }
                            (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                node_picker_down(&mut app);
                            }
                            (KeyModifiers::NONE, KeyCode::Enter) => {
                                node_picker_confirm(&mut app).await;
                                // Re-fetch all tab data with the new node.
                                let _ = api::fetch_status(&mut app).await;
                                refresh_agents(&mut app).await;
                                refresh_workflows(&mut app).await;
                                refresh_spaces_data(&mut app).await;
                                let _ = api::fetch_gateway_status(&mut app).await;
                                refresh_catalog(&mut app).await;
                            }
                            (KeyModifiers::CONTROL, KeyCode::Char('n')) => {
                                app.node_picker_open = false;
                            }
                            _ => {}
                        }
                        continue;
                    }

                    // Open the node picker with Ctrl+N (global, any tab).
                    if key.modifiers == KeyModifiers::CONTROL && key.code == KeyCode::Char('n') {
                        open_node_picker(&mut app).await;
                        continue;
                    }

                    if key.code == KeyCode::Tab || key.code == KeyCode::BackTab {
                        let cur = SIDEBAR_TABS
                            .iter()
                            .position(|t| *t == app.active_tab)
                            .unwrap_or(0);
                        let next = if key.code == KeyCode::BackTab {
                            if cur == 0 { SIDEBAR_TABS.len() - 1 } else { cur - 1 }
                        } else {
                            (cur + 1) % SIDEBAR_TABS.len()
                        };
                        switch_tab(&mut app, SIDEBAR_TABS[next]);
                        continue;
                    }

                    if key.modifiers == KeyModifiers::NONE {
                        match key.code {
                            KeyCode::Char('1') => { switch_tab(&mut app, SidebarTab::Chat); continue; }
                            KeyCode::Char('2') => { switch_tab(&mut app, SidebarTab::Services); continue; }
                            KeyCode::Char('3') => { switch_tab(&mut app, SidebarTab::Agents); continue; }
                            KeyCode::Char('4') => { switch_tab(&mut app, SidebarTab::Account); continue; }
                            _ => {}
                        }
                    }

                    match app.active_tab {
                        SidebarTab::Chat => {
                            // Double-check result overlay: dismiss with Esc/Enter/Space,
                            // scroll the critique with Up/Down.
                            if app.double_check.open {
                                match (key.modifiers, key.code) {
                                    (_, KeyCode::Esc | KeyCode::Enter)
                                    | (KeyModifiers::NONE, KeyCode::Char(' ')) => {
                                        app.double_check = crate::app::DoubleCheckOverlay::default();
                                    }
                                    (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                        app.double_check.scroll =
                                            app.double_check.scroll.saturating_sub(1);
                                    }
                                    (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                        app.double_check.scroll =
                                            app.double_check.scroll.saturating_add(1);
                                    }
                                    _ => {}
                                }
                                continue;
                            }
                            // Sessions (runs) overlay: Esc/Enter close, Up/Down navigate.
                            if app.sessions_overlay.open {
                                match (key.modifiers, key.code) {
                                    (_, KeyCode::Esc | KeyCode::Enter) => {
                                        app.sessions_overlay =
                                            crate::app::SessionsOverlay::default();
                                    }
                                    (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                        app.sessions_overlay.index =
                                            app.sessions_overlay.index.saturating_sub(1);
                                    }
                                    (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                        let max = app.sessions_overlay.rows.len().saturating_sub(1);
                                        app.sessions_overlay.index =
                                            (app.sessions_overlay.index + 1).min(max);
                                    }
                                    _ => {}
                                }
                                continue;
                            }
                            // `/btw` side-answer overlay captures input while open.
                            // Space/Enter/Esc dismiss (the answer is discarded —
                            // never enters history); Up/Down scroll.
                            if app.btw.open {
                                match (key.modifiers, key.code) {
                                    (_, KeyCode::Esc | KeyCode::Enter)
                                    | (KeyModifiers::NONE, KeyCode::Char(' ')) => {
                                        app.btw = crate::app::BtwOverlay::default();
                                    }
                                    (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                        app.btw.scroll = app.btw.scroll.saturating_sub(1);
                                    }
                                    (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                        app.btw.scroll = app.btw.scroll.saturating_add(1);
                                    }
                                    _ => {}
                                }
                                continue;
                            }
                            // Agent picker overlay captures input while open.
                            if app.agent_picker_open {
                                match (key.modifiers, key.code) {
                                    (_, KeyCode::Esc) => app.agent_picker_open = false,
                                    (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                        agent_picker_up(&mut app);
                                    }
                                    (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                        agent_picker_down(&mut app);
                                    }
                                    (KeyModifiers::NONE, KeyCode::Enter) => {
                                        agent_picker_confirm(&mut app);
                                    }
                                    (KeyModifiers::CONTROL, KeyCode::Char('a')) => {
                                        app.agent_picker_open = false;
                                    }
                                    (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                        refresh_agents(&mut app).await;
                                    }
                                    _ => {}
                                }
                                continue;
                            }
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::CONTROL, KeyCode::Char('a')) => {
                                    refresh_agents(&mut app).await;
                                    open_agent_picker(&mut app);
                                }
                                (KeyModifiers::NONE, KeyCode::Enter) => {
                                    let trimmed = app.chat.input.trim().to_string();
                                    if trimmed == "/btw" || trimmed.starts_with("/btw ") {
                                        // `/btw` is a side question — ephemeral overlay,
                                        // never enters chat history.
                                        start_btw(&mut app, &btw_url, &mut btw_rx);
                                    } else if trimmed == "/sessions" {
                                        app.chat.input.clear();
                                        open_sessions_overlay(&mut app).await;
                                    } else if is_chat_slash_command(&trimmed) {
                                        app.chat.input.clear();
                                        handle_chat_command(&mut app, &trimmed).await;
                                    } else {
                                        send_chat_message(&mut app, &chat_url, &mut chat_rx);
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Up) => {
                                    chat_scroll_up(&mut app);
                                }
                                (KeyModifiers::NONE, KeyCode::Down) => {
                                    chat_scroll_down(&mut app);
                                }
                                (KeyModifiers::NONE, KeyCode::Backspace) => {
                                    app.chat.input.pop();
                                }
                                (KeyModifiers::NONE, KeyCode::Char(c)) => {
                                    if !app.chat.streaming {
                                        app.chat.input.push(c);
                                    }
                                }
                                _ => {}
                            }
                        }
                        SidebarTab::Services => {
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                    list_up(&mut app, SIDECAR_ORDER.len());
                                }
                                (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                    list_down(&mut app, SIDECAR_ORDER.len());
                                }
                                (KeyModifiers::NONE, KeyCode::Char('s')) => {
                                    do_start_sidecar(&mut app).await;
                                }
                                (KeyModifiers::NONE, KeyCode::Char('x')) => {
                                    do_stop_sidecar(&mut app).await;
                                }
                                (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                    do_restart_sidecar(&mut app).await;
                                }
                                (KeyModifiers::SHIFT, KeyCode::Char('A') | KeyCode::Char('a')) => {
                                    do_start_all(&mut app).await;
                                }
                                (KeyModifiers::SHIFT, KeyCode::Char('Z') | KeyCode::Char('z')) => {
                                    do_stop_all(&mut app).await;
                                }
                                (KeyModifiers::NONE, KeyCode::Char('d')) => {
                                    do_install_sidecar(&mut app).await;
                                }
                                (KeyModifiers::SHIFT, KeyCode::Char('D') | KeyCode::Char('d')) => {
                                    do_uninstall_sidecar(&mut app).await;
                                }
                                (KeyModifiers::NONE, KeyCode::Char('i')) => {
                                    app.current_screen = Screen::SetupDependencies;
                                    app.list_state.select(Some(0));
                                }
                                _ => {}
                            }
                        }
                        SidebarTab::Agents => {
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                    if app.agents_tab_index > 0 {
                                        app.agents_tab_index -= 1;
                                        app.agent_detail = None;
                                        app.agent_detail_error = None;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                    let len = app.agents_list.len();
                                    if len > 0 && app.agents_tab_index < len - 1 {
                                        app.agents_tab_index += 1;
                                        app.agent_detail = None;
                                        app.agent_detail_error = None;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Enter) => {
                                    // Load detail for the selected agent.
                                    if let Some(agent) = app.agents_list.get(app.agents_tab_index) {
                                        let id = agent.id.clone();
                                        let api_url = app.api_url.clone();
                                        let token = nodes::active_node().token;
                                        app.agent_detail = None;
                                        app.agent_detail_loading = true;
                                        app.agent_detail_error = None;
                                        match fetch_agent_detail(&api_url, token.as_deref(), &id).await {
                                            Ok(detail) => {
                                                app.agent_detail = Some(detail);
                                                app.agent_detail_loading = false;
                                            }
                                            Err(e) => {
                                                app.agent_detail_loading = false;
                                                app.agent_detail_error = Some(format!("Failed to load detail: {e}"));
                                            }
                                        }
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                    refresh_agents(&mut app).await;
                                    // Clamp index after refresh.
                                    if app.agents_list.is_empty() {
                                        app.agents_tab_index = 0;
                                        app.agent_detail = None;
                                        app.agent_detail_error = None;
                                    } else if app.agents_tab_index >= app.agents_list.len() {
                                        app.agents_tab_index = app.agents_list.len() - 1;
                                        app.agent_detail = None;
                                        app.agent_detail_error = None;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Esc) => {
                                    app.agent_detail = None;
                                    app.agent_detail_error = None;
                                }
                                _ => {}
                            }
                        }
                        SidebarTab::Account => {
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                    app.auth_info = auth::fetch_auth_info().await;
                                }
                                (KeyModifiers::NONE, KeyCode::Char('l')) => {
                                    do_login(&mut app, &mut login_rx);
                                }
                                (KeyModifiers::SHIFT, KeyCode::Char('L') | KeyCode::Char('l')) => {
                                    do_logout(&mut app);
                                }
                                _ => {}
                            }
                        }
                        SidebarTab::Apps => {
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                    apps_list_up(&mut app);
                                }
                                (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                    apps_list_down(&mut app);
                                }
                                (KeyModifiers::NONE, KeyCode::Char('i')) => {
                                    do_install_catalog_item(&mut app).await;
                                }
                                (KeyModifiers::SHIFT, KeyCode::Char('D') | KeyCode::Char('d')) => {
                                    do_uninstall_catalog_item(&mut app).await;
                                }
                                (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                    refresh_catalog(&mut app).await;
                                }
                                _ => {}
                            }
                        }
                        SidebarTab::Workflows => {
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                    if app.workflows_tab_index > 0 {
                                        app.workflows_tab_index -= 1;
                                        app.workflow_confirm_pending = false;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                    let len = app.workflows_list.len();
                                    if len > 0 && app.workflows_tab_index < len - 1 {
                                        app.workflows_tab_index += 1;
                                        app.workflow_confirm_pending = false;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Enter) => {
                                    if app.workflow_confirm_pending {
                                        app.workflow_confirm_pending = false;
                                        do_trigger_workflow_run(&mut app).await;
                                    } else if !app.workflows_list.is_empty() {
                                        app.workflow_confirm_pending = true;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Esc) => {
                                    app.workflow_confirm_pending = false;
                                    app.workflow_run_id = None;
                                    app.workflow_run_state = None;
                                    app.workflow_run_output = None;
                                    app.workflow_run_error = None;
                                }
                                (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                    refresh_workflows(&mut app).await;
                                }
                                _ => {}
                            }
                        }
                        SidebarTab::Spaces => {
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                    if app.spaces_tab_index > 0 {
                                        app.spaces_tab_index -= 1;
                                        // Invalidate document cache so docs reload for new selection.
                                        refresh_selected_space_docs(&mut app).await;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                    let len = app.spaces.len();
                                    if len > 0 && app.spaces_tab_index < len - 1 {
                                        app.spaces_tab_index += 1;
                                        refresh_selected_space_docs(&mut app).await;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                    refresh_spaces_data(&mut app).await;
                                }
                                (KeyModifiers::NONE, KeyCode::PageUp) => {
                                    app.spaces_scroll = app.spaces_scroll.saturating_sub(10);
                                }
                                (KeyModifiers::NONE, KeyCode::PageDown) => {
                                    app.spaces_scroll = app.spaces_scroll.saturating_add(10);
                                }
                                _ => {}
                            }
                        }
                        SidebarTab::Engines => {
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                    if app.engines_tab_index > 0 {
                                        app.engines_tab_index -= 1;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                    let len = app.engines_list.len();
                                    if len > 0 && app.engines_tab_index < len - 1 {
                                        app.engines_tab_index += 1;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Enter) => {
                                    // Activate the selected engine — POSTs /api/engine/active.
                                    do_activate_engine(&mut app).await;
                                }
                                (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                    refresh_engines(&mut app).await;
                                }
                                _ => {}
                            }
                        }
                        SidebarTab::Schedules => {
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                    if app.schedules_tab_index > 0 {
                                        app.schedules_tab_index -= 1;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                    let len = app.scheduled_jobs.len();
                                    if len > 0 && app.schedules_tab_index < len - 1 {
                                        app.schedules_tab_index += 1;
                                    }
                                }
                                (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                    refresh_schedules(&mut app).await;
                                }
                                _ => {}
                            }
                        }
                        SidebarTab::Agents | SidebarTab::Gateway => {
                            if let (KeyModifiers::NONE, KeyCode::Char('q')) =
                                (key.modifiers, key.code)
                            {
                                return Ok(());
                            }
                        }
                        // All data-driven list tabs share the same controls.
                        SidebarTab::Models
                        | SidebarTab::Skills
                        | SidebarTab::Tools
                        | SidebarTab::Monitors
                        | SidebarTab::Teams
                        | SidebarTab::Meetings
                        | SidebarTab::Recipes => {
                            let tab = app.active_tab;
                            match (key.modifiers, key.code) {
                                (KeyModifiers::NONE, KeyCode::Char('q')) => return Ok(()),
                                (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                                    feature_tab_nav(&mut app, tab, -1);
                                }
                                (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                                    feature_tab_nav(&mut app, tab, 1);
                                }
                                (KeyModifiers::NONE, KeyCode::Char('r')) => {
                                    refresh_feature_tab(&mut app, tab).await;
                                }
                                (KeyModifiers::NONE, KeyCode::Enter) => {
                                    feature_tab_action(&mut app, tab).await;
                                }
                                (KeyModifiers::NONE, KeyCode::Char('a')) => {
                                    feature_tab_secondary(&mut app, tab).await;
                                }
                                _ => {}
                            }
                        }
                    }
                    continue;
                }

                // ── Setup / wizard screen key handling ───────────────────
                match (key.modifiers, key.code) {
                    (KeyModifiers::NONE, KeyCode::Char('q')) => {
                        if matches!(app.current_screen, Screen::WaitingForCore) {
                            return Ok(());
                        }
                        app.current_screen = Screen::Dashboard;
                        app.active_tab = SidebarTab::Services;
                        app.list_state.select(Some(0));
                    }

                    (KeyModifiers::NONE, KeyCode::Right)
                    | (KeyModifiers::NONE, KeyCode::Enter) => {
                        if !matches!(app.current_screen, Screen::WaitingForCore) {
                            if go_next(&mut app).await? {
                                return Ok(());
                            }
                        }
                    }

                    (KeyModifiers::NONE, KeyCode::Left) => {
                        go_prev(&mut app);
                    }

                    (KeyModifiers::NONE, KeyCode::Up | KeyCode::Char('k')) => {
                        wizard_list_up(&mut app);
                    }
                    (KeyModifiers::NONE, KeyCode::Down | KeyCode::Char('j')) => {
                        wizard_list_down(&mut app);
                    }

                    (KeyModifiers::NONE, KeyCode::Char(' ')) => {
                        do_wizard_pick(&mut app);
                    }

                    (KeyModifiers::NONE, KeyCode::Char('r'))
                        if app.current_screen == Screen::SetupDependencies =>
                    {
                        let _ = api::check_dependencies(&mut app).await;
                    }
                    (KeyModifiers::NONE, KeyCode::Char('i'))
                        if app.current_screen == Screen::SetupDependencies =>
                    {
                        do_install_deps(&mut app).await;
                    }

                    _ => {}
                }
            }

            // ── Mouse events ─────────────────────────────────────────
            Event::Mouse(mouse) => {
                let col = mouse.column;
                let row = mouse.row;
                app.mouse_col = col;
                app.mouse_row = row;

                match mouse.kind {
                    MouseEventKind::Down(MouseButton::Left) => {
                        // Check sidebar tab clicks
                        if let Some(tab) = hit_sidebar_tab(&app, col, row) {
                            switch_tab(&mut app, tab);
                            continue;
                        }

                        // Check sidebar user area click -> switch to Account
                        if let Some(area) = app.click_regions.sidebar_user_area {
                            if rect_contains(area, col, row) {
                                switch_tab(&mut app, SidebarTab::Account);
                                continue;
                            }
                        }

                        // Check hint button clicks
                        if let Some(action) = hit_hint_button(&app, col, row) {
                            match dispatch_hint_action(
                                action,
                                &mut app,
                                &chat_url,
                                &mut chat_rx,
                                &mut login_rx,
                            )
                            .await?
                            {
                                DispatchResult::Quit => return Ok(()),
                                DispatchResult::Continue => {}
                            }
                            continue;
                        }

                        // Check service list row click
                        if let Some(area) = app.click_regions.service_list_area {
                            if rect_contains(area, col, row) && app.active_tab == SidebarTab::Services {
                                let row_idx = (row - app.click_regions.service_list_top_y) as usize;
                                if row_idx < SIDECAR_ORDER.len() {
                                    app.list_state.select(Some(row_idx));
                                }
                                continue;
                            }
                        }

                        // Check agent list row click on the Agents tab
                        if let Some(area) = app.click_regions.agent_list_area {
                            if rect_contains(area, col, row) && app.active_tab == SidebarTab::Agents {
                                let row_idx = (row - app.click_regions.agent_list_top_y) as usize;
                                let len = app.agents_list.len();
                                if row_idx < len {
                                    app.agents_tab_index = row_idx;
                                    app.agent_detail = None;
                                    app.agent_detail_error = None;
                                }
                                continue;
                            }
                        }

                        // Check chat message area click -> disable autoscroll
                        if let Some(area) = app.click_regions.chat_messages_area {
                            if rect_contains(area, col, row) {
                                app.chat.auto_scroll = false;
                                continue;
                            }
                        }

                        // Check chat composer area click (visual focus)
                        if let Some(area) = app.click_regions.chat_composer_area {
                            if rect_contains(area, col, row) {
                                continue;
                            }
                        }

                        // Check account login area click
                        if let Some(area) = app.click_regions.account_login_area {
                            if rect_contains(area, col, row) {
                                do_login(&mut app, &mut login_rx);
                                continue;
                            }
                        }

                        // Check wizard step breadcrumb clicks
                        for &(rect, step_idx) in &app.click_regions.wizard_steps {
                            if rect_contains(rect, col, row) {
                                let target_screen = match step_idx {
                                    0 => Screen::SetupDependencies,
                                    1 => Screen::SetupProviders,
                                    2 => Screen::SetupTools,
                                    3 => Screen::SetupAgents,
                                    _ => continue,
                                };
                                let current_idx = match app.current_screen {
                                    Screen::SetupDependencies => 0,
                                    Screen::SetupProviders => 1,
                                    Screen::SetupTools => 2,
                                    Screen::SetupAgents => 3,
                                    _ => continue,
                                };
                                // Only allow navigating to completed or current steps
                                if step_idx <= current_idx {
                                    app.current_screen = target_screen;
                                    app.list_state.select(Some(0));
                                }
                                break;
                            }
                        }

                        // Check wizard list item clicks
                        if let Some(area) = app.click_regions.wizard_list_area {
                            if rect_contains(area, col, row) {
                                let row_idx = (row - app.click_regions.wizard_list_top_y) as usize;
                                let list_len = match app.current_screen {
                                    Screen::SetupDependencies => app.dependencies.len(),
                                    Screen::SetupProviders => app.providers.len(),
                                    Screen::SetupTools => app.tools.len(),
                                    Screen::SetupAgents => app.agents.len(),
                                    _ => 0,
                                };
                                if row_idx < list_len {
                                    app.list_state.select(Some(row_idx));
                                    do_wizard_pick(&mut app);
                                }
                            }
                        }
                    }

                    MouseEventKind::ScrollUp => {
                        // Chat messages scroll
                        if let Some(area) = app.click_regions.chat_messages_area {
                            if rect_contains(area, col, row) {
                                chat_scroll_up(&mut app);
                                continue;
                            }
                        }
                        // Service list scroll
                        if let Some(area) = app.click_regions.service_list_area {
                            if rect_contains(area, col, row) {
                                list_up(&mut app, SIDECAR_ORDER.len());
                                continue;
                            }
                        }
                        // Agent list scroll
                        if let Some(area) = app.click_regions.agent_list_area {
                            if rect_contains(area, col, row) {
                                if app.agents_tab_index > 0 {
                                    app.agents_tab_index -= 1;
                                    app.agent_detail = None;
                                }
                                continue;
                            }
                        }
                        // Wizard list scroll
                        if let Some(area) = app.click_regions.wizard_list_area {
                            if rect_contains(area, col, row) {
                                wizard_list_up(&mut app);
                                continue;
                            }
                        }
                    }

                    MouseEventKind::ScrollDown => {
                        // Chat messages scroll
                        if let Some(area) = app.click_regions.chat_messages_area {
                            if rect_contains(area, col, row) {
                                chat_scroll_down(&mut app);
                                continue;
                            }
                        }
                        // Service list scroll
                        if let Some(area) = app.click_regions.service_list_area {
                            if rect_contains(area, col, row) {
                                list_down(&mut app, SIDECAR_ORDER.len());
                                continue;
                            }
                        }
                        // Agent list scroll
                        if let Some(area) = app.click_regions.agent_list_area {
                            if rect_contains(area, col, row) {
                                let len = app.agents_list.len();
                                if len > 0 && app.agents_tab_index < len - 1 {
                                    app.agents_tab_index += 1;
                                    app.agent_detail = None;
                                }
                                continue;
                            }
                        }
                        // Wizard list scroll
                        if let Some(area) = app.click_regions.wizard_list_area {
                            if rect_contains(area, col, row) {
                                wizard_list_down(&mut app);
                                continue;
                            }
                        }
                    }

                    MouseEventKind::Moved | MouseEventKind::Drag(MouseButton::Left) => {
                        app.mouse_col = col;
                        app.mouse_row = row;
                    }

                    _ => {}
                }
            }

            _ => {}
        }
    }
}
