//! Host dependency status and installers: `install_dependencies` through `install_dependencies`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/api/dependencies/install",
    tag = "Sidecars",
    summary = "Best-effort install of missing deps",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn install_dependencies(
    State(state): State<ServerState>,
) -> Json<serde_json::Value> {
    use std::time::Duration;

    // One tracked row PER TOOLCHAIN, not one for the batch. These are the longest
    // installs in the product — rustup, a Node runtime and a Python are each a
    // multi-minute, multi-hundred-MB fetch — and until now the whole 5-minute call
    // was a single silent await with nothing on the Downloads page. Collapsing four
    // artifacts into one row would hide which one is actually running (and which one
    // is the slow one), so each gets its own.
    //
    // Each installer is blocking, so it runs on its own `spawn_blocking` awaited
    // inside its own registration; a cancel from the download center drops the join
    // handle (the already-spawned installer runs to completion, as ever — killing a
    // half-written toolchain install is worse than letting it finish).
    let steps: [(&str, &str, fn() -> bool, fn() -> Result<(), String>); 4] = [
        ("git", "Git", || command_exists("git"), install_git),
        (
            "rust",
            "Rust toolchain",
            || command_exists("rustc"),
            install_rust,
        ),
        (
            "npm",
            "Node runtime",
            || command_exists("npm") || command_exists("bun"),
            install_node_runtime,
        ),
        (
            "python",
            "Python",
            || command_exists("python3") || command_exists("python"),
            install_python,
        ),
    ];

    let mut results = serde_json::Map::new();
    for (key, label, is_installed, install) in steps {
        if is_installed() {
            // Nothing to fetch — do not create a row that would instantly complete.
            results.insert(
                key.to_string(),
                json!({ "status": "already_installed", "success": true }),
            );
            continue;
        }
        let outcome = state
            .downloads
            .register_indeterminate(
                format!("dependency:{key}"),
                crate::downloads::DownloadKind::Tool,
                label.to_string(),
                async move {
                    let value = tokio::time::timeout(
                        Duration::from_secs(300), // 5 minute timeout, per dependency
                        tokio::task::spawn_blocking(move || {
                            install_dependency(is_installed, install)
                        }),
                    )
                    .await
                    .map_err(|_| anyhow::anyhow!("timeout"))?
                    .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                    // A failed installer must fail the ROW too, or the overlay would
                    // report a green "installed" for a toolchain that is still missing.
                    if value.get("success").and_then(serde_json::Value::as_bool) != Some(true) {
                        let msg = value
                            .get("error")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("install failed")
                            .to_string();
                        return Err(anyhow::anyhow!(msg));
                    }
                    Ok(value)
                },
            )
            .await;
        results.insert(
            key.to_string(),
            match outcome {
                Ok(value) => value,
                Err(e) => json!({
                    "status": "failed",
                    "success": false,
                    "error": format!("{e}"),
                }),
            },
        );
    }

    let (dependencies, all_installed) = dependency_status();
    let install_steps_succeeded = results.values().all(|result| {
        result
            .get("success")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    });

    Json(json!({
        "success": install_steps_succeeded && all_installed,
        "results": results,
        "dependencies": dependencies,
        "all_installed": all_installed
    }))
}
