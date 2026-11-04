//! Host dependency status and installers: `check_installed` through `check_dependencies`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    get,
    path = "/api/setup/check/{name}",
    tag = "Sidecars",
    summary = "Check whether a sidecar is installed",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn check_installed(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use crate::sidecar::download_manager::VersionStore;

    let in_session = state.setup.is_installed(&name).await;
    let in_store = VersionStore::load().versions.contains_key(&name);

    let installed = (in_session || in_store) && binary_installed_on_disk(&name);

    Json(json!({ "name": name, "installed": installed }))
}

#[utoipa::path(
    get,
    path = "/api/setup/status",
    tag = "Sidecars",
    summary = "Install status for all sidecars",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_install_status(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use crate::sidecar::download_manager::VersionStore;
    use crate::sidecar::install_state::InstallState;

    // The in-memory InstallStatusStore only knows about installs/uninstalls that
    // happened in *this* core session. To report per-engine state for *every*
    // installed engine (including ones installed in a previous session, e.g.
    // both llama.cpp and ollama side by side), hydrate from the durable
    // versions.json and verify each binary still exists on disk.
    let mut states = state.install_status.get_all().await;

    let store = VersionStore::load();
    for (name, version) in &store.versions {
        // Don't override a live session state (Installing / Failed / freshly
        // Installed) — that is always the most accurate.
        if states.contains_key(name) {
            continue;
        }
        if binary_installed_on_disk(name) {
            states.insert(
                name.clone(),
                InstallState::Installed {
                    version: version.clone(),
                    installed_at: chrono::Utc::now(),
                },
            );
        }
    }

    Json(json!({ "states": states }))
}

#[utoipa::path(
    get,
    path = "/api/setup/status/{name}",
    tag = "Sidecars",
    summary = "Install status for one sidecar",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_install_status_by_name(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Json<serde_json::Value> {
    use crate::sidecar::download_manager::VersionStore;
    use crate::sidecar::install_state::InstallState;

    // Prefer the live session state; otherwise fall back to the durable store so
    // an engine installed in a previous session still reports as installed.
    let status = match state.install_status.get(&name).await {
        InstallState::NotInstalled => match VersionStore::load().versions.get(&name) {
            Some(version) if binary_installed_on_disk(&name) => InstallState::Installed {
                version: version.clone(),
                installed_at: chrono::Utc::now(),
            },
            _ => InstallState::NotInstalled,
        },
        live => live,
    };
    Json(json!({ "name": name, "status": status }))
}

pub(in crate::server) fn command_exists(program: &str) -> bool {
    Command::new(program)
        .arg("--version")
        .no_window()
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub(in crate::server) fn dependency_status() -> (serde_json::Map<String, serde_json::Value>, bool) {
    let git_installed = command_exists("git");
    let rust_installed = command_exists("rustc");
    let npm_installed = command_exists("npm") || command_exists("bun");
    let python_installed = command_exists("python3") || command_exists("python");
    let all_installed = git_installed && rust_installed && npm_installed && python_installed;

    let mut dependencies = serde_json::Map::new();
    dependencies.insert("git".to_string(), json!(git_installed));
    dependencies.insert("rust".to_string(), json!(rust_installed));
    dependencies.insert("npm".to_string(), json!(npm_installed));
    dependencies.insert("python".to_string(), json!(python_installed));

    (dependencies, all_installed)
}

pub(in crate::server) fn run_install_command(program: &str, args: &[&str]) -> Result<(), String> {
    let output = Command::new(program)
        .args(args)
        .no_window()
        .output()
        .map_err(|error| format!("{program} failed to start: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let status = output.status.code().map_or_else(
        || "terminated by signal".to_string(),
        |code| code.to_string(),
    );

    if stderr.is_empty() {
        Err(format!("{program} exited with status {status}"))
    } else {
        Err(format!("{program} exited with status {status}: {stderr}"))
    }
}

pub(in crate::server) fn run_first_success(commands: &[(&str, &[&str])]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (program, args) in commands {
        match run_install_command(program, args) {
            Ok(()) => return Ok(()),
            Err(error) => errors.push(error),
        }
    }
    Err(errors.join("; "))
}

pub(in crate::server) fn install_git() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        run_install_command(
            "winget",
            &[
                "install",
                "--id",
                "Git.Git",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        )
    }

    #[cfg(target_os = "macos")]
    {
        run_install_command("brew", &["install", "git"])
    }

    #[cfg(target_os = "linux")]
    {
        run_first_success(&[
            ("sudo", &["apt-get", "install", "-y", "git"][..]),
            ("sudo", &["dnf", "install", "-y", "git"][..]),
            ("sudo", &["yum", "install", "-y", "git"][..]),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("automatic git install is unsupported on this platform".to_string())
    }
}

pub(in crate::server) fn install_rust() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        run_install_command(
            "winget",
            &[
                "install",
                "--id",
                "Rustlang.Rustup",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        )
    }

    #[cfg(target_os = "macos")]
    {
        run_install_command("brew", &["install", "rust"])
    }

    #[cfg(target_os = "linux")]
    {
        run_first_success(&[
            ("sudo", &["apt-get", "install", "-y", "rustc", "cargo"][..]),
            ("sudo", &["dnf", "install", "-y", "rust", "cargo"][..]),
            ("sudo", &["yum", "install", "-y", "rust", "cargo"][..]),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("automatic Rust install is unsupported on this platform".to_string())
    }
}

pub(in crate::server) fn install_node_runtime() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        run_install_command(
            "winget",
            &[
                "install",
                "--id",
                "OpenJS.NodeJS.LTS",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        )
    }

    #[cfg(target_os = "macos")]
    {
        run_install_command("brew", &["install", "node"])
    }

    #[cfg(target_os = "linux")]
    {
        run_first_success(&[
            ("sudo", &["apt-get", "install", "-y", "nodejs", "npm"][..]),
            ("sudo", &["dnf", "install", "-y", "nodejs", "npm"][..]),
            ("sudo", &["yum", "install", "-y", "nodejs", "npm"][..]),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("automatic Node.js install is unsupported on this platform".to_string())
    }
}

pub(in crate::server) fn install_python() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        run_install_command(
            "winget",
            &[
                "install",
                "--id",
                "Python.Python.3",
                "-e",
                "--accept-source-agreements",
                "--accept-package-agreements",
            ],
        )
    }

    #[cfg(target_os = "macos")]
    {
        run_install_command("brew", &["install", "python3"])
    }

    #[cfg(target_os = "linux")]
    {
        run_first_success(&[
            (
                "sudo",
                &["apt-get", "install", "-y", "python3", "python3-pip"][..],
            ),
            (
                "sudo",
                &["dnf", "install", "-y", "python3", "python3-pip"][..],
            ),
            (
                "sudo",
                &["yum", "install", "-y", "python3", "python3-pip"][..],
            ),
        ])
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err("automatic Python install is unsupported on this platform".to_string())
    }
}

pub(in crate::server) fn install_dependency(
    is_installed: impl Fn() -> bool,
    install: impl FnOnce() -> Result<(), String>,
) -> serde_json::Value {
    if is_installed() {
        return json!({ "status": "already_installed", "success": true });
    }

    match install() {
        Ok(()) if is_installed() => json!({ "status": "installed", "success": true }),
        Ok(()) => json!({
            "status": "failed",
            "success": false,
            "error": "installer completed, but the dependency is still unavailable"
        }),
        Err(error) => json!({
            "status": "failed",
            "success": false,
            "error": error
        }),
    }
}

#[utoipa::path(
    get,
    path = "/api/dependencies/check",
    tag = "Sidecars",
    summary = "Check for git/rust/bun/python on PATH",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn check_dependencies() -> Json<serde_json::Value> {
    use std::time::Duration;

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::task::spawn_blocking(|| {
            let (dependencies, all_installed) = dependency_status();

            json!({
                "dependencies": dependencies,
                "all_installed": all_installed
            })
        }),
    )
    .await;

    match result {
        Ok(Ok(json)) => Json(json),
        Ok(Err(e)) => Json(json!({ "success": false, "error": e.to_string() })),
        Err(_) => Json(json!({ "success": false, "error": "timeout" })),
    }
}
