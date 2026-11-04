//! Node init, sidecar install and status, support diagnostics and active engine/model selection: `run_sidecar_downloader` through `uninstall_sidecar`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Install one sidecar with its downloader: the background half of
/// [`install_sidecar`]. `version` and `force` are the request's own (the
/// island bundle installs a pinned version).
pub(in crate::server) async fn run_sidecar_downloader(
    sidecar_name: &str,
    downloads: &crate::downloads::DownloadCenter,
    version: Option<String>,
    force: bool,
) -> anyhow::Result<String> {
    use crate::sidecar::agents::zeroclaw::ZeroClawDownloader;
    use crate::sidecar::providers::llamacpp::LlamaCppDownloader;
    use crate::sidecar::providers::ollama::OllamaDownloader;
    use crate::sidecar::tools::screenpipe::ScreenpipeDownloader;

    match sidecar_name {
        "llamacpp" => LlamaCppDownloader::new()
            .ensure_installed(&downloads)
            .await
            .map(|_| "installed".to_string()),
        "shadow" => crate::sidecar::tools::shadow::ShadowDownloader::new()
            .ensure_installed(&downloads)
            .await
            .map(|_| "installed".to_string()),
        "ghost" => crate::sidecar::tools::ghost::GhostDownloader::new()
            .ensure_installed(&downloads)
            .await
            .map(|_| "installed".to_string()),
        "llamacpp-embed" => {
            // The embeddings engine shares the llama.cpp binary. Installing it
            // only ensures that binary — the embedding *model* (a GGUF) is a
            // model download owned by onboarding (`install_local_stack`), not
            // by the engine catalog, mirroring how the chat model is handled.
            LlamaCppDownloader::new()
                .ensure_installed(&downloads)
                .await
                .map(|_| "installed".to_string())
        }
        // ── Archive-extract downloaders: route the archive through the
        // download center (#456) so the install shows in the overlay. ──
        "ollama" => OllamaDownloader::new()
            .ensure_installed(&downloads)
            .await
            .map(|_| "installed".to_string()),
        "zeroclaw" => ZeroClawDownloader::new()
            .ensure_installed(&downloads)
            .await
            .map(|_| "installed".to_string()),
        "whispercpp" => {
            crate::sidecar::providers::whispercpp::WhisperCppDownloader::new()
                .ensure_installed(&downloads)
                .await
        }
        "parakeet" => crate::sidecar::providers::parakeet::ParakeetDownloader::new()
            .ensure_model(&downloads)
            .await
            .map(|_| "installed".to_string()),
        "audiocpp" => {
            crate::sidecar::providers::audiocpp::AudioCppDownloader::new()
                .ensure_installed(&downloads)
                .await
        }
        "sdcpp" => {
            crate::sidecar::providers::sdcpp::StableDiffusionDownloader::new()
                .ensure_installed(&downloads)
                .await
        }
        "outetts" => {
            crate::sidecar::providers::outetts::OuteTtsDownloader::new()
                .ensure_installed(&downloads)
                .await
        }
        // ── Subprocess installers (npm/pip/cargo/shell): no byte progress, so
        // they track as INDETERMINATE tasks in the overlay (#456). ──
        "screenpipe" => downloads
            .register_indeterminate(
                "tool:screenpipe".to_string(),
                crate::downloads::DownloadKind::Tool,
                "Screenpipe".to_string(),
                async { ScreenpipeDownloader::new().ensure_installed().await },
            )
            .await
            .map(|_| "installed".to_string()),
        "openclaw" => downloads
            .register_indeterminate(
                "agent:openclaw".to_string(),
                crate::downloads::DownloadKind::Agent,
                "OpenClaw".to_string(),
                async { crate::sidecar::agents::openclaw::installer::ensure_installed().await },
            )
            .await
            .map(|_| "installed".to_string()),
        "vllm" => downloads
            .register_indeterminate(
                "engine:vllm".to_string(),
                crate::downloads::DownloadKind::Engine,
                "vLLM".to_string(),
                async { crate::sidecar::providers::vllm::installer::ensure_installed().await },
            )
            .await
            .map(|_| "installed".to_string()),
        "mlx" => downloads
            .register_indeterminate(
                "engine:mlx".to_string(),
                crate::downloads::DownloadKind::Engine,
                "MLX".to_string(),
                async { crate::sidecar::providers::mlx::installer::ensure_installed().await },
            )
            .await
            .map(|_| "installed".to_string()),
        "mlx-vlm" => downloads
            .register_indeterminate(
                "engine:mlx-vlm".to_string(),
                crate::downloads::DownloadKind::Engine,
                "MLX-VLM".to_string(),
                async { crate::sidecar::providers::mlx_vlm::installer::ensure_installed().await },
            )
            .await
            .map(|_| "installed".to_string()),
        "omlx" => downloads
            .register_indeterminate(
                "engine:omlx".to_string(),
                crate::downloads::DownloadKind::Engine,
                "oMLX".to_string(),
                async { crate::sidecar::providers::omlx::installer::ensure_installed().await },
            )
            .await
            .map(|_| "installed".to_string()),
        // mlx-serve is an adopt-or-start native binary. Ryu does not vendor
        // the executable or its model cache; the installer adopts a PATH
        // binary or uses the upstream Homebrew formula.
        "mlx-serve" => {
            downloads
                .register_indeterminate(
                    "engine:mlx-serve".to_string(),
                    crate::downloads::DownloadKind::Engine,
                    "MLX Serve".to_string(),
                    async {
                        crate::sidecar::providers::mlx_serve::installer::ensure_installed()
                            .await
                            .map(|_| "adopted".to_string())
                    },
                )
                .await
        }
        // apfel is adopt-a-binary (Apple Foundation Models): PATH-detect an
        // existing install, else best-effort `brew install apfel`. Nothing to
        // download — Apple FM ships with the OS.
        "apfel" => downloads
            .register_indeterminate(
                "engine:apfel".to_string(),
                crate::downloads::DownloadKind::Engine,
                "Apple Intelligence".to_string(),
                async { crate::sidecar::providers::apfel::installer::ensure_installed().await },
            )
            .await
            .map(|_| "installed".to_string()),
        // Mesh LLM is adopt-or-start: Ryu keeps its config and model cache
        // outside the node data directory, and only records the executable's
        // presence after the operator installs it or Homebrew succeeds.
        "mesh-llm" => {
            downloads
                .register_indeterminate(
                    "engine:mesh-llm".to_string(),
                    crate::downloads::DownloadKind::Engine,
                    "Mesh LLM".to_string(),
                    async {
                        crate::sidecar::providers::mesh_llm::installer::ensure_installed()
                            .await
                            .map(|_| "adopted".to_string())
                    },
                )
                .await
        }
        // The mesh clients (#478). Tailscale/Headscale use the managed
        // `tailscale` + `tailscaled` pair; Tailcat, Cloudflared and OpenTunnel use
        // their own pinned downloaders. Each route is surfaced in the same download overlay and
        // verified before the binary is marked installed.
        //
        // This is the EXPLICIT install path. `POST /api/mesh/config` still does
        // not download inline (a 38 MB transfer inside the toggle handler would
        // hang past any client timeout) — it backgrounds the same helper, so
        // both routes install identically.
        "tailscale" => crate::sidecar::tailscale::downloader::install_mesh_client(&downloads).await,
        "tailcat" => crate::sidecar::tailcat_downloader::install_tailcat(&downloads).await,
        "cloudflared" => {
            crate::sidecar::cloudflared_downloader::install_cloudflared(&downloads).await
        }
        "opentunnel" => crate::sidecar::opentunnel_downloader::install_opentunnel(&downloads).await,
        "island" => {
            let version = version
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_owned());
            crate::sidecar::tools::island::ensure_installed(&downloads, &version, force)
                .await
                .map(|_| version)
        }
        "freetoken" => {
            crate::sidecar::providers::FreeTokenManager::new()
                .install()
                .await
        }
        "llama-swap" => {
            crate::sidecar::providers::LlamaSwapManager::new()
                .install()
                .await
        }
        "lemonade" => {
            crate::sidecar::providers::LemonadeManager::new()
                .install()
                .await
        }
        "magnitude" => {
            crate::sidecar::providers::MagnitudeManager::new()
                .install()
                .await
        }
        "ryutts" => match crate::sidecar::providers::ryutts::ensure_kokoro_runtime().await {
            Ok(true) => {
                match crate::sidecar::providers::ryutts::kokoro::KokoroDownloader::new()
                    .ensure_installed(&downloads)
                    .await
                {
                    Ok(version) => {
                        crate::sidecar::download_manager::VersionStore::record_persisted(
                            "ryutts",
                            &version,
                            "installed",
                        )
                        .map(|()| version)
                    }
                    Err(error) => Err(error),
                }
            }
            Ok(false) => Err(anyhow::anyhow!(
                "A compatible Python runtime is required for Kokoro speech"
            )),
            Err(error) => Err(error),
        },
        // Docker Model Runner is adopt-only: there is nothing to download.
        // "Installing" means verifying DMR is enabled + reachable on :12434,
        // then recording a version-store marker so the engine survives a Core
        // restart (`seed_installed_from_disk` re-detects it). We verify and
        // guide rather than mutate the user's Docker config (the
        // `docker desktop enable model-runner` surface differs across Docker
        // Desktop vs Engine, so auto-running it is the fragile path).
        "docker-model-runner" => {
            use crate::sidecar::providers::docker_model_runner::DockerModelRunnerManager;
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .unwrap_or_default();
            if DockerModelRunnerManager::server_reachable(&client).await {
                let version = "adopted".to_string();
                if let Err(e) =
                    crate::sidecar::download_manager::VersionStore::set_version_persisted(
                        "docker-model-runner",
                        &version,
                    )
                {
                    tracing::warn!("could not persist docker-model-runner marker: {e}");
                }
                Ok(version)
            } else {
                Err(anyhow::anyhow!(
                    "Docker Model Runner is not reachable on 127.0.0.1:12434. Enable it in \
                     Docker Desktop (Settings → AI → Model Runner) with host-side TCP access \
                     on port 12434, or run `docker desktop enable model-runner --tcp 12434`, \
                     then pull a model with `docker model pull ai/<model>` and try again."
                ))
            }
        }
        other => {
            tracing::warn!("no downloader for sidecar '{}' — skipping", other);
            Ok("skipped".to_string())
        }
    }
}

#[utoipa::path(
    post,
    path = "/api/setup/{name}/uninstall",
    tag = "Sidecars",
    summary = "Uninstall a sidecar",
    params(
        ("name" = String, Path),
        ("dryRun" = Option<bool>, Query, description = "Return the removal plan without changing files"),
    ),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn uninstall_sidecar(
    State(state): State<ServerState>,
    axum::extract::Path(name): axum::extract::Path<String>,
    Query(query): Query<InstallSidecarQuery>,
) -> Json<serde_json::Value> {
    if query.dry_run {
        return Json(json!({
            "success": true,
            "dryRun": true,
            "action": "uninstall",
            "name": name,
            "removeData": false,
            "installed": binary_installed_on_disk(&name),
            "writes": ["sidecar binary and runtime files", "install status"],
        }));
    }
    // Clear install status
    state.install_status.clear(&name).await;

    // Use manager to stop and uninstall
    match state.manager.uninstall_sidecar(&name, false).await {
        Ok(()) => {
            // Also clear from setup manager
            state.setup.uninstall(&name).await;
            Json(json!({
                "success": true,
                "message": format!("Sidecar '{}' uninstalled", name)
            }))
        }
        Err(e) => Json(json!({ "success": false, "error": e.to_string() })),
    }
}
