//! External editor detection and launching.

fn command_exists(command: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&paths).any(|dir| {
        let candidate = dir.join(command);
        if candidate.is_file() {
            return true;
        }
        #[cfg(windows)]
        {
            let candidate = dir.join(format!("{command}.exe"));
            if candidate.is_file() {
                return true;
            }
        }
        false
    })
}

#[cfg(target_os = "macos")]
fn mac_app_exists(name: &str) -> bool {
    [
        format!("/Applications/{name}.app"),
        format!("/System/Applications/{name}.app"),
        format!("/System/Applications/Utilities/{name}.app"),
    ]
    .iter()
    .any(|path| std::path::Path::new(path).exists())
}

fn editor_is_available(editor: &str) -> bool {
    match editor {
        "vscode" => {
            command_exists("code") || {
                #[cfg(target_os = "macos")]
                {
                    mac_app_exists("Visual Studio Code")
                }
                #[cfg(not(target_os = "macos"))]
                {
                    false
                }
            }
        }
        "zed" => {
            command_exists("zed") || {
                #[cfg(target_os = "macos")]
                {
                    mac_app_exists("Zed")
                }
                #[cfg(not(target_os = "macos"))]
                {
                    false
                }
            }
        }
        "cursor" => {
            command_exists("cursor") || {
                #[cfg(target_os = "macos")]
                {
                    mac_app_exists("Cursor")
                }
                #[cfg(not(target_os = "macos"))]
                {
                    false
                }
            }
        }
        "terminal" => {
            if cfg!(windows) {
                command_exists("wt") || command_exists("cmd")
            } else if cfg!(target_os = "macos") {
                true
            } else {
                command_exists("x-terminal-emulator")
            }
        }
        "gitbash" => {
            if cfg!(windows) {
                std::path::Path::new("C:\\Program Files\\Git\\bin\\bash.exe").exists()
                    || command_exists("bash")
            } else {
                command_exists("bash")
            }
        }
        "powershell" => cfg!(windows) && (command_exists("powershell") || command_exists("pwsh")),
        "cmd" => cfg!(windows) && command_exists("cmd"),
        "explorer" | "finder" => true,
        _ => false,
    }
}

#[derive(serde::Serialize)]
pub(crate) struct EditorAvailability {
    id: String,
    available: bool,
}

#[tauri::command]
pub(crate) async fn get_editor_availability(
    editors: Vec<String>,
) -> Result<Vec<EditorAvailability>, String> {
    Ok(editors
        .into_iter()
        .map(|id| {
            let available = editor_is_available(&id);
            EditorAvailability { id, available }
        })
        .collect())
}

/// Open a project folder in an external editor or file manager.
/// `editor` is one of: vscode, zed, cursor, terminal, gitbash, explorer/finder.
/// `path` defaults to "." when omitted.
#[tauri::command]
pub(crate) async fn open_in_editor(
    app: tauri::AppHandle,
    editor: String,
    path: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let raw_path = path.as_deref().unwrap_or(".");

    // Reject flag-like paths (argument injection) and URL-scheme paths (e.g. javascript:, file://).
    if raw_path.starts_with('-') {
        return Err("Invalid path: must not start with '-'".to_string());
    }
    if raw_path.contains("://") {
        return Err("Invalid path: URL schemes are not allowed".to_string());
    }

    // Canonicalize so symlinks and `..` traversal are resolved to an absolute path.
    // Fall back to the raw value only for paths that don't exist yet (e.g. ".").
    let owned;
    let path = match std::fs::canonicalize(raw_path) {
        Ok(p) => {
            owned = p.to_string_lossy().into_owned();
            owned.as_str()
        }
        Err(_) => raw_path,
    };

    let result = match editor.as_str() {
        // `--` terminates option parsing for editors that support it (code, zed, cursor).
        "vscode" => app
            .shell()
            .command("code")
            .args(["--", path])
            .spawn()
            .or_else(|_| {
                if cfg!(target_os = "macos") {
                    app.shell()
                        .command("open")
                        .args(["-a", "Visual Studio Code", path])
                        .spawn()
                } else {
                    app.shell().command("code").args(["--", path]).spawn()
                }
            }),
        "zed" => app
            .shell()
            .command("zed")
            .args(["--", path])
            .spawn()
            .or_else(|_| {
                if cfg!(target_os = "macos") {
                    app.shell()
                        .command("open")
                        .args(["-a", "Zed", path])
                        .spawn()
                } else {
                    app.shell().command("zed").args(["--", path]).spawn()
                }
            }),
        "cursor" => app
            .shell()
            .command("cursor")
            .args(["--", path])
            .spawn()
            .or_else(|_| {
                if cfg!(target_os = "macos") {
                    app.shell()
                        .command("open")
                        .args(["-a", "Cursor", path])
                        .spawn()
                } else {
                    app.shell().command("cursor").args(["--", path]).spawn()
                }
            }),
        "terminal" => {
            if cfg!(windows) {
                app.shell()
                    .command("wt")
                    .args(["-d", path])
                    .spawn()
                    .or_else(|_| {
                        app.shell()
                            .command("cmd")
                            .args(["/c", "start", "cmd"])
                            .spawn()
                    })
            } else if cfg!(target_os = "macos") {
                app.shell()
                    .command("open")
                    .args(["-a", "Terminal", path])
                    .spawn()
            } else {
                app.shell().command("x-terminal-emulator").spawn()
            }
        }
        "gitbash" => {
            if cfg!(windows) {
                app.shell()
                    .command("C:\\Program Files\\Git\\bin\\bash.exe")
                    .args(["--login", "-i"])
                    .spawn()
                    .or_else(|_| app.shell().command("bash").args(["--login", "-i"]).spawn())
            } else {
                app.shell().command("bash").args(["--login"]).spawn()
            }
        }
        // New console windows must be launched via `start`; a bare `cmd`/`powershell`
        // spawned by Tauri has no attached console. The new window inherits the parent
        // working directory, so set it via `current_dir` rather than embedding the path
        // in the command string (avoids quoting/space/injection issues).
        "powershell" => {
            if cfg!(windows) {
                app.shell()
                    .command("cmd")
                    .args(["/c", "start", "powershell"])
                    .current_dir(path)
                    .spawn()
            } else {
                return Err("PowerShell launcher is only available on Windows".to_string());
            }
        }
        "cmd" => {
            if cfg!(windows) {
                app.shell()
                    .command("cmd")
                    .args(["/c", "start", "cmd"])
                    .current_dir(path)
                    .spawn()
            } else {
                return Err("Command Prompt is only available on Windows".to_string());
            }
        }
        "explorer" | "finder" => {
            if cfg!(windows) {
                app.shell().command("explorer").args([path]).spawn()
            } else if cfg!(target_os = "macos") {
                app.shell().command("open").args([path]).spawn()
            } else {
                app.shell().command("xdg-open").args([path]).spawn()
            }
        }
        _ => return Err(format!("Unknown editor: {editor}")),
    };

    result.map(|_| ()).map_err(|e| e.to_string())
}
