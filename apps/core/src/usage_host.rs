//! Core's implementation of the extracted [`ryu_usage::UsageHost`] seam.
//!
//! The `ryu-usage` crate owns the provider readers, never-refresh credential
//! rule, and normalized [`ryu_usage::UsageSnapshot`] windows. Core supplies the
//! host-specific seams: Ryu's isolated Codex and Pi auth paths, Cursor's
//! read-only state-database token, and Antigravity's filtered local-server
//! discovery. Core installs this shim once at boot via
//! [`ryu_usage::set_global_host`].

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use ryu_usage::UsageHost;
use sysinfo::{ProcessesToUpdate, System};

/// Install [`CoreUsageHost`] as the process-global usage host. Idempotent (a
/// second call is a no-op). Called once from `main` at boot; usage backs a
/// poll-driven widget, so if it were ever fetched before install the reader
/// skips host-backed credential sources rather than failing.
pub fn install() {
    ryu_usage::set_global_host(std::sync::Arc::new(CoreUsageHost));
}

/// Core's `UsageHost` — the kernel side of the usage seam.
pub struct CoreUsageHost;

const MAX_CURSOR_TOKEN_BYTES: usize = 16 * 1024;

impl UsageHost for CoreUsageHost {
    fn ryu_codex_home(&self) -> PathBuf {
        crate::codex_config::codex_home()
    }

    fn ryu_pi_auth_path(&self) -> Option<PathBuf> {
        Some(crate::pi_config::config_dir().join("auth.json"))
    }

    fn cursor_access_token(&self) -> Option<String> {
        read_cursor_access_token(&cursor_state_db_path()?)
    }

    fn antigravity_local_servers(&self) -> Vec<ryu_usage::AntigravityLocalServer> {
        discover_antigravity_local_servers()
    }

    fn vendor_proxy(&self, vendor: &str) -> Result<Option<String>, ()> {
        use crate::local_egress::providers::{proxy_url, ProviderRoute};
        match vendor {
            "claude" => proxy_url(ProviderRoute::Claude).map_err(|_| ()),
            _ => Ok(None),
        }
    }
}

fn cursor_state_db_path() -> Option<PathBuf> {
    let app_data = if cfg!(target_os = "macos") {
        dirs::home_dir()?.join("Library/Application Support")
    } else {
        dirs::config_dir()?
    };
    Some(
        app_data
            .join("Cursor")
            .join("User/globalStorage/state.vscdb"),
    )
}

fn read_cursor_access_token(path: &Path) -> Option<String> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let token: String = connection
        .query_row(
            "SELECT value FROM ItemTable
             WHERE key = ?1 AND typeof(value) = 'text'
             AND length(CAST(value AS BLOB)) <= ?2
             LIMIT 1",
            rusqlite::params!["cursorAuth/accessToken", MAX_CURSOR_TOKEN_BYTES as i64],
            |row| row.get(0),
        )
        .ok()?;
    let token = token.trim();
    if token.is_empty()
        || token.len() > MAX_CURSOR_TOKEN_BYTES
        || token.chars().any(char::is_control)
    {
        return None;
    }
    Some(token.to_owned())
}

fn discover_antigravity_local_servers() -> Vec<ryu_usage::AntigravityLocalServer> {
    let mut system = System::new();
    system.refresh_processes(ProcessesToUpdate::All, true);

    let mut servers = Vec::new();
    for process in system.processes().values() {
        let process_name = process.name().to_string_lossy().to_ascii_lowercase();
        let executable = process
            .exe()
            .map(|path| path.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let args: Vec<String> = process
            .cmd()
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        if !is_antigravity_language_server(&process_name, &executable, &args) {
            continue;
        }

        if let Some(server) = antigravity_server_from_args(&args) {
            servers.push(server);
        }
    }

    servers.sort_by_key(|server| (server.http_port, server.https_port));
    servers.dedup();
    servers.truncate(4);
    servers
}

fn is_antigravity_language_server(process_name: &str, executable: &str, args: &[String]) -> bool {
    if !process_name.contains("language_server") && !executable.contains("language_server") {
        return false;
    }
    executable.contains("antigravity")
        || argument_value(args, "--app_data_dir")
            .is_some_and(|value| value.eq_ignore_ascii_case("antigravity"))
        || args
            .iter()
            .any(|argument| argument.to_ascii_lowercase().contains("antigravity-ide"))
}

fn argument_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|argument| argument == flag)
        .and_then(|index| args.get(index + 1))
        .cloned()
        .or_else(|| {
            let prefix = format!("{flag}=");
            args.iter()
                .find_map(|argument| argument.strip_prefix(&prefix).map(str::to_owned))
        })
}

fn valid_local_port(value: Option<String>) -> Option<u16> {
    let port = value?.parse::<u16>().ok()?;
    (port > 0).then_some(port)
}

fn valid_csrf_token(value: Option<String>) -> Option<String> {
    let token = value?;
    if !(8..=256).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return None;
    }
    Some(token)
}

fn antigravity_server_from_args(args: &[String]) -> Option<ryu_usage::AntigravityLocalServer> {
    let main_csrf = valid_csrf_token(argument_value(args, "--csrf_token"));
    let extension_csrf = valid_csrf_token(argument_value(args, "--extension_server_csrf_token"));
    let server = ryu_usage::AntigravityLocalServer {
        http_port: valid_local_port(argument_value(args, "--extension_server_port")),
        http_csrf_token: extension_csrf.or_else(|| main_csrf.clone()),
        https_port: valid_local_port(argument_value(args, "--https_server_port")),
        https_csrf_token: main_csrf,
    };
    ((server.http_port.is_some() && server.http_csrf_token.is_some())
        || (server.https_port.is_some() && server.https_csrf_token.is_some()))
    .then_some(server)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_token_is_read_from_sqlite_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor.vscdb");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
                rusqlite::params!["cursorAuth/accessToken", "current-access-token"],
            )
            .unwrap();
        drop(connection);
        let before = std::fs::read(&path).unwrap();

        assert_eq!(
            read_cursor_access_token(&path).as_deref(),
            Some("current-access-token")
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .expect("read-only reopen");
        let row_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM ItemTable", [], |row| row.get(0))
            .unwrap();
        assert_eq!(row_count, 1);
        assert!(connection
            .execute(
                "INSERT INTO ItemTable (key, value) VALUES (?1, ?2)",
                rusqlite::params!["not-written", "value"],
            )
            .is_err());
    }

    #[test]
    fn cursor_token_reader_rejects_unbounded_or_missing_values() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cursor.vscdb");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                [],
            )
            .unwrap();
        drop(connection);

        assert_eq!(read_cursor_access_token(&path), None);
    }

    #[test]
    fn antigravity_process_args_are_reduced_to_valid_loopback_fields() {
        let args = [
            "language_server.exe".to_owned(),
            "--csrf_token".to_owned(),
            "12345678-1234-1234-1234-123456789012".to_owned(),
            "--extension_server_port=34567".to_owned(),
            "--extension_server_csrf_token".to_owned(),
            "abcdefgh-1234".to_owned(),
            "--app_data_dir".to_owned(),
            "antigravity".to_owned(),
        ];
        let server = antigravity_server_from_args(&args).unwrap();
        assert_eq!(server.http_port, Some(34_567));
        assert_eq!(server.http_csrf_token.as_deref(), Some("abcdefgh-1234"));
        assert_eq!(server.https_port, None);
        assert_eq!(
            server.https_csrf_token.as_deref(),
            Some("12345678-1234-1234-1234-123456789012")
        );
    }

    #[test]
    fn antigravity_process_args_reject_invalid_ports_and_csrf_values() {
        let args = [
            "language_server".to_owned(),
            "--csrf_token".to_owned(),
            "short".to_owned(),
            "--extension_server_port".to_owned(),
            "70000".to_owned(),
        ];
        assert_eq!(antigravity_server_from_args(&args), None);
    }

    #[test]
    fn antigravity_process_filter_requires_language_server_and_product_marker() {
        let args = vec![
            "--csrf_token=12345678-1234".to_owned(),
            "--https_server_port=44321".to_owned(),
            "--app_data_dir".to_owned(),
            "antigravity".to_owned(),
        ];
        assert!(is_antigravity_language_server(
            "language_server.exe",
            "C:\\Antigravity\\language_server.exe",
            &args
        ));
        assert!(!is_antigravity_language_server(
            "unrelated.exe",
            "C:\\Other\\unrelated.exe",
            &args
        ));
        assert!(!is_antigravity_language_server(
            "language_server.exe",
            "C:\\Other\\language_server.exe",
            &["--csrf_token=12345678".to_owned()]
        ));
    }
}
