//! The embedded terminal panel's shell execution command.

#[derive(serde::Serialize)]
pub(crate) struct ShellOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

/// Execute a shell command and return its stdout/stderr/exit code.
/// Used by the embedded terminal panel in the desktop UI.
///
/// SECURITY: This is an intentional full-shell exec primitive — a terminal emulator
/// requires shell semantics (pipes, redirects, compound commands). Mitigations in place:
/// 1. cwd is canonicalized to a real existing directory before use.
/// 2. The iframe panels that load external URLs run with `sandbox="allow-scripts
///    allow-forms allow-popups"` (no `allow-same-origin`), so iframe scripts cannot
///    reach `window.parent.__TAURI__` and call this command across the iframe boundary.
/// 3. Tauri's webview does not navigate to external URLs; the renderer is trusted
///    local content only.
/// Resolve a caller-requested shell name to a concrete (binary, command-flag)
/// pair through a FIXED ALLOWLIST. The caller's string is NEVER passed through
/// as the binary directly — that would be arbitrary-binary execution. Any
/// unrecognized, empty, or absent value falls back to the OS default, so a
/// garbage value can never spawn something outside this list.
pub(crate) fn default_shell() -> (&'static str, &'static str) {
    if cfg!(windows) {
        return ("powershell", "-Command");
    }

    // `$SHELL` is the user's login-shell choice on Unix. Only accept the same
    // fixed names exposed by the settings UI; an arbitrary environment path must
    // never become an executable here.
    let configured = std::env::var_os("SHELL").and_then(|value| {
        std::path::Path::new(&value)
            .file_name()
            .map(|name| name.to_owned())
    });
    match configured.as_deref().and_then(|name| name.to_str()) {
        Some("bash") => ("bash", "-c"),
        Some("zsh") => ("zsh", "-c"),
        Some("sh") => ("sh", "-c"),
        Some("fish") => ("fish", "-c"),
        _ if cfg!(target_os = "macos") => ("zsh", "-c"),
        _ => ("bash", "-c"),
    }
}

pub(crate) fn resolve_shell(requested: Option<&str>) -> (&'static str, &'static str) {
    match requested.map(str::trim).filter(|s| !s.is_empty()) {
        Some("bash") => ("bash", "-c"),
        Some("zsh") => ("zsh", "-c"),
        Some("sh") => ("sh", "-c"),
        Some("fish") => ("fish", "-c"),
        Some("powershell") => ("powershell", "-Command"),
        Some("pwsh") => ("pwsh", "-Command"),
        Some("cmd") => ("cmd", "/C"),
        // None or any unrecognized value → the OS default.
        _ => default_shell(),
    }
}

#[tauri::command]
pub(crate) async fn shell_execute(
    app: tauri::AppHandle,
    command: String,
    cwd: Option<String>,
    shell: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<ShellOutput, String> {
    use tauri_plugin_shell::ShellExt;

    let (shell, flag) = resolve_shell(shell.as_deref());

    // Canonicalize cwd: reject non-existent paths and resolve symlinks / `..` traversal.
    let resolved_cwd: Option<std::path::PathBuf> = if let Some(ref dir) = cwd {
        let canonical =
            std::fs::canonicalize(dir).map_err(|_| format!("Invalid working directory: {dir}"))?;
        if !canonical.is_dir() {
            return Err(format!("Working directory is not a directory: {dir}"));
        }
        Some(canonical)
    } else {
        None
    };

    let mut cmd = app.shell().command(shell).args([flag, command.as_str()]);
    if let Some(ref dir) = resolved_cwd {
        cmd = cmd.current_dir(dir);
    }
    if let Some(environment) = env {
        for (key, value) in environment {
            let mut chars = key.chars();
            let valid = chars
                .next()
                .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
                && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric());
            if !valid {
                return Err(format!("Invalid environment variable name: {key}"));
            }
            cmd = cmd.env(key, value);
        }
    }

    // The plugin's `output()` helper reads line-oriented events and appends a
    // newline to each event. That changes the bytes for commands such as
    // `git diff` and corrupts file contents that contain blank lines. Raw
    // events preserve stdout/stderr exactly while keeping the same async
    // process lifecycle.
    let (mut events, _child) = cmd.set_raw_out(true).spawn().map_err(|e| e.to_string())?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut code = 1;

    use tauri_plugin_shell::process::CommandEvent;
    while let Some(event) = events.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => stdout.extend(bytes),
            CommandEvent::Stderr(bytes) => stderr.extend(bytes),
            CommandEvent::Terminated(payload) => {
                code = payload.code.unwrap_or(1);
            }
            CommandEvent::Error(message) => stderr.extend(message.into_bytes()),
            _ => {}
        }
    }

    Ok(ShellOutput {
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        code,
    })
}
