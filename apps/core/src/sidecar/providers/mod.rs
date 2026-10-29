mod adopted;
pub mod apfel;
pub mod audiocpp;
pub mod docker_model_runner;
mod engine_child;
pub mod freetoken;
mod held_child;
pub mod lemonade;
pub mod llama_swap;
pub mod llamacpp;
pub mod magnitude;
pub mod mesh_llm;
pub mod mlx;
pub mod mlx_serve;
pub mod mlx_vlm;
pub mod ollama;
pub mod omlx;
pub mod outetts;
pub mod parakeet;
mod python_server;
pub(crate) mod readiness;
pub mod ryutts;
pub mod sdcpp;
pub mod sglang;
pub mod vllm;
pub mod whispercpp;

pub use apfel::ApfelManager;
pub use audiocpp::AudioCppManager;
pub use docker_model_runner::DockerModelRunnerManager;
pub use freetoken::FreeTokenManager;
pub use lemonade::LemonadeManager;
pub use llama_swap::LlamaSwapManager;
pub use llamacpp::LlamaCppManager;
pub use magnitude::MagnitudeManager;
pub use mesh_llm::MeshLlmManager;
pub use mlx::MlxManager;
pub use mlx_serve::MlxServeManager;
pub use mlx_vlm::MlxVlmManager;
pub use ollama::OllamaManager;
pub use omlx::OmlxManager;
pub use outetts::OuteTtsManager;
pub use parakeet::ParakeetManager;
pub use sdcpp::StableDiffusionManager;
pub use sglang::SglangManager;
pub use vllm::VllmManager;
pub use whispercpp::WhisperCppManager;

/// Engine-wide launch settings saved for `engine` (`model.launch.engine.<id>`).
/// Fail-soft: an unreadable preferences store yields the default config so a
/// settings problem never prevents an engine from starting.
pub(crate) async fn engine_launch_config(engine: &str) -> crate::inference::LaunchConfig {
    match crate::server::preferences::PreferencesStore::open_default() {
        Ok(preferences) => preferences.get_engine_launch_config(engine).await,
        Err(error) => {
            tracing::warn!(%error, engine, "could not read engine launch settings");
            crate::inference::LaunchConfig::default()
        }
    }
}

/// Drop flags Core manages (and the value after each) from user-supplied args,
/// including the `--flag=value` form, so saved settings cannot rebind a
/// sidecar's host, port, model or output.
pub(crate) fn strip_managed_args(args: &[String], managed: &[&str]) -> Vec<String> {
    strip_managed_flags(args, managed, &[])
}

/// Like [`strip_managed_args`], with a second list of managed flags that take
/// no value (`--serve`, `--permissive`, …): those are dropped alone, so the
/// user argument after them survives.
pub(crate) fn strip_managed_flags(args: &[String], valued: &[&str], bare: &[&str]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    let mut skip_next = false;
    for arg in args {
        if skip_next {
            skip_next = false;
            continue;
        }
        if valued.contains(&arg.as_str()) {
            skip_next = true;
            continue;
        }
        if bare.contains(&arg.as_str()) {
            continue;
        }
        if valued
            .iter()
            .chain(bare)
            .any(|flag| flag.starts_with("--") && arg.starts_with(&format!("{flag}=")))
        {
            continue;
        }
        out.push(arg.clone());
    }
    out
}

/// `launch.to_args(engine)` (typed flags, native options, raw args) with the
/// managed flags filtered out of the raw args only, so a catalog value is never
/// mistaken for a managed flag.
pub(crate) fn launch_args_with_filtered_raw(
    launch: &crate::inference::LaunchConfig,
    engine: crate::inference::Engine,
    valued: &[&str],
    bare: &[&str],
) -> Vec<String> {
    let mut filtered = launch.clone();
    filtered.extra_args = strip_managed_flags(&launch.extra_args, valued, bare);
    filtered.to_args(engine)
}

/// Native environment for `engine`, minus variables already set in Core's own
/// environment (an inherited variable stays authoritative) and any name Core
/// manages for the spawn.
pub(crate) fn native_env_for_spawn(
    engine: &str,
    launch: &crate::inference::LaunchConfig,
    managed: &[&str],
) -> Vec<(String, String)> {
    crate::inference::native_env(engine, &launch.native)
        .into_iter()
        .filter(|(name, _)| !managed.contains(&name.as_str()) && std::env::var_os(name).is_none())
        .collect()
}

/// Pure precedence for a single-model engine's launch model: explicit override >
/// the user's active-model selection for the engine > env var > default.
fn pick_launch_model(
    explicit: Option<String>,
    active: Option<String>,
    env: Option<String>,
    default: &str,
) -> String {
    explicit
        .or(active)
        .or(env)
        .unwrap_or_else(|| default.to_owned())
}

/// Resolve the model a single-model engine (vLLM, SGLang, MLX, MLX-VLM) binds at
/// launch. Shared by each provider's `start()` and by [`served_chat_model`], so a
/// route that left `model` unset requests exactly what the engine launched.
pub(crate) async fn resolve_launch_model(
    engine: &str,
    explicit: Option<String>,
    env_var: &str,
    default: &str,
) -> String {
    pick_launch_model(
        explicit,
        crate::model_catalog::active_model_ref_for_engine(engine).await,
        std::env::var(env_var).ok(),
        default,
    )
}

/// The model a local engine actually serves, for a chat route that left
/// `model` unset. Ollama/vLLM/SGLang reject a request whose `model` is the
/// engine name, so ask the provider what it launched. `None` when unknown
/// (e.g. llama.cpp with no active override — it ignores the field anyway).
pub async fn served_chat_model(engine: &str) -> Option<String> {
    match engine {
        "vllm" => Some(vllm::launch_model(None).await),
        "sglang" => Some(sglang::launch_model(None).await),
        "mlx" => Some(mlx::launch_model(None).await),
        "mlx-vlm" => Some(mlx_vlm::launch_model(None).await),
        "apfel" => Some(apfel::APPLE_FM_MODEL_ID.to_owned()),
        _ => crate::model_catalog::active_model_ref_for_engine(engine).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_args_are_stripped_with_their_values() {
        let args: Vec<String> = [
            "--port",
            "1",
            "--threads",
            "4",
            "--model=x",
            "-m",
            "y",
            "--vad",
            "-mx",
        ]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
        assert_eq!(
            strip_managed_args(&args, &["--port", "--model", "-m"]),
            vec!["--threads", "4", "--vad", "-mx"]
        );
    }

    #[test]
    fn bare_managed_flags_keep_the_following_argument() {
        let args: Vec<String> = [
            "--serve",
            "--no-pld",
            "--port",
            "9",
            "--permissive=1",
            "--x",
        ]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
        assert_eq!(
            strip_managed_flags(&args, &["--port"], &["--serve", "--permissive"]),
            vec!["--no-pld", "--x"]
        );
    }

    #[test]
    fn launch_model_precedence_is_explicit_active_env_default() {
        let some = |value: &str| Some(value.to_owned());
        assert_eq!(
            pick_launch_model(some("explicit"), some("active"), some("env"), "default"),
            "explicit"
        );
        assert_eq!(
            pick_launch_model(None, some("active"), some("env"), "default"),
            "active"
        );
        assert_eq!(pick_launch_model(None, None, some("env"), "default"), "env");
        assert_eq!(pick_launch_model(None, None, None, "default"), "default");
    }

    /// Every Core-managed local engine/sidecar that binds a profile-aware
    /// default port, by name. Two entries sharing a port means the second
    /// process to start fails to bind (or a client adopts the wrong runtime).
    fn profile_aware_engine_ports() -> Vec<(&'static str, u16)> {
        vec![
            ("core", 7980),
            ("gateway", 7981),
            ("shadow", 3030),
            (
                "sdk-app",
                crate::sidecar::adapters::sdk::DEFAULT_SDK_APP_PORT,
            ),
            ("llamacpp-chat", 8080),
            ("llamacpp-embed", llamacpp::embed::EMBED_PORT_BASE),
            ("llamacpp-rerank", llamacpp::rerank::RERANK_PORT_BASE),
            ("llamacpp-classify", llamacpp::classify::CLASSIFY_PORT_BASE),
            (
                "llamacpp-speech",
                llamacpp::speech::SPEECH_PROCESSING_PORT_BASE,
            ),
            ("llamacpp-guard", llamacpp::guard::GUARD_PORT_BASE),
            // Reserved for the operator's systemone decision server, which the
            // node screener's default URL points at. Core does not spawn it.
            (
                "node-screener-decision",
                crate::sidecar::node_screener::DECISION_SCREENER_PORT_BASE,
            ),
            ("sdcpp", sdcpp::SD_PORT_BASE),
            ("mlx-vlm", mlx_vlm::process::DEFAULT_PORT_BASE),
            ("ryutts", ryutts::TTS_PORT),
            ("mlx", mlx::process::DEFAULT_PORT_BASE),
            // The `@ryu/research` app owns its autoresearch engine now (Core no
            // longer links or spawns it), so its release port is a literal here;
            // it still binds this profile-shifted port on the same node.
            ("research-engine", 8087),
            ("apfel", apfel::APFEL_PORT_BASE),
            ("whispercpp", whispercpp::WHISPER_PORT_BASE),
            ("audiocpp", audiocpp::AUDIOCPP_PORT_BASE),
            ("mlx-serve", mlx_serve::DEFAULT_PORT),
            ("mesh-llm", mesh_llm::DEFAULT_PORT),
        ]
    }

    // oMLX and vLLM share a fixed, non-profile 8000 by design: they are
    // mutually exclusive resident chat engines, so they are not listed above.
    // Every listed engine must have its own port — there is no exemption list.

    #[test]
    fn local_engine_default_ports_are_unique_per_profile() {
        let ports = profile_aware_engine_ports();
        for (profile, _) in crate::profile::PROFILE_PORT_OFFSETS {
            let mut seen: std::collections::BTreeMap<u16, &str> = Default::default();
            for (name, base) in &ports {
                let port = crate::profile::port_for(*base, profile);
                if let Some(previous) = seen.insert(port, name) {
                    panic!("profile {profile}: {previous} and {name} both default to port {port}");
                }
            }
        }
        assert_eq!(
            crate::profile::port_for(audiocpp::AUDIOCPP_PORT_BASE, "release"),
            8091
        );
        assert_ne!(
            audiocpp::AUDIOCPP_PORT_BASE,
            mlx::process::DEFAULT_PORT_BASE
        );
        assert_ne!(sdcpp::SD_PORT_BASE, llamacpp::classify::CLASSIFY_PORT_BASE);
    }

    #[tokio::test]
    async fn apfel_reports_the_apple_foundation_model_id() {
        assert_eq!(
            served_chat_model("apfel").await.as_deref(),
            Some(apfel::APPLE_FM_MODEL_ID)
        );
    }
}

/// What a Python chat engine (vLLM, SGLang, MLX, MLX-VLM) is launched with for
/// one model ref.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PythonEngineModel {
    /// The engine's model argument: the installed snapshot's local directory
    /// (`models/chat/snapshots/<slug>/`) when there is one, else the ref as
    /// given (a Hub repo id the engine downloads into [`python_engine_env`]'s
    /// `HF_HOME`, or a path the operator supplied).
    pub model_arg: String,
    /// The name to keep advertising on `/v1/models` when `model_arg` is a local
    /// path (the original repo id), so clients that address the model by its id
    /// keep working. `None` when the ref is served as given.
    pub served_name: Option<String>,
}

/// Resolve a Python engine's model ref to its launch argument, preferring the
/// installed snapshot so the engine never re-downloads weights the catalog
/// already put on disk.
pub(crate) fn python_engine_model(model_ref: &str) -> PythonEngineModel {
    match crate::model_catalog::installed::present_snapshot_dir(model_ref) {
        Some(dir) => PythonEngineModel {
            model_arg: dir.to_string_lossy().into_owned(),
            served_name: Some(model_ref.to_string()),
        },
        None => PythonEngineModel {
            model_arg: model_ref.to_string(),
            served_name: None,
        },
    }
}

/// Env every Ryu-spawned Python engine process gets: `HF_HOME` pointed at the
/// data dir's shared `models/hf`, so any Hub download lands inside the data dir
/// (moved by Storage relocation, wiped by node reset) instead of
/// `~/.cache/huggingface`. The directory is created on demand.
pub(crate) fn python_engine_env() -> Vec<(&'static str, std::path::PathBuf)> {
    let hf_home = ryu_sidecar_runtime::layout::hf_home(&crate::paths::ryu_dir());
    if let Err(e) = std::fs::create_dir_all(&hf_home) {
        tracing::warn!("could not create {}: {e}", hf_home.display());
    }
    vec![("HF_HOME", hf_home)]
}

#[cfg(test)]
mod python_engine_tests {
    use super::*;

    #[test]
    fn uninstalled_refs_are_served_as_given() {
        crate::model_catalog_host::install();
        let model = python_engine_model("acme/never-installed-python-engine-probe");
        assert_eq!(model.model_arg, "acme/never-installed-python-engine-probe");
        assert!(model.served_name.is_none());
    }

    #[test]
    fn hf_home_is_the_shared_models_hf_dir() {
        let env = python_engine_env();
        assert_eq!(env.len(), 1);
        assert_eq!(env[0].0, "HF_HOME");
        assert!(env[0].1.ends_with("models/hf"));
    }
}
