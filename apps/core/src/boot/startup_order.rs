/// The built-in sidecar startup order. `start_all` walks it to boot installed
/// sidecars, `stop_all` walks it in reverse at shutdown, and `main` seeds the
/// installed set from it, so every swappable local engine must appear here.
pub(super) fn default_startup_order() -> Vec<String> {
    vec![
        // Tools first
        "llmfit".into(),
        // Release Core treats Shadow and Ghost as first-party preinstalled tools.
        // Their managers download through the global DownloadCenter on a fresh
        // node and start normally here; debug Core leaves eligibility to the
        // local turbo/dev processes.
        "shadow".into(),
        "ghost".into(),
        // Then providers
        "llamacpp".into(),
        // Embeddings server auto-starts so RAG has real embeddings on launch.
        "llamacpp-embed".into(),
        // Ryu TTS sidecar auto-starts when installed so the default TTS engine
        // (Kokoro 82M) is live out of the box. `start_all` skips it when it was
        // never provisioned (no venv / model), so this has no cost on nodes that
        // don't have the sidecar — TTS falls back to on-demand OuteTTS there.
        "ryutts".into(),
        // Parakeet (the default STT engine, `default_stt_engine()`) auto-starts for
        // the same reason: its model is downloaded unconditionally during onboarding,
        // so a node that has the bits should have the engine loaded rather than
        // reporting itself dead. Being absent here is what made the Voice settings
        // row read "Not running — install + start it from Services first" on every
        // install forever: nothing ever called `start()`, so `loaded` stayed false —
        // while transcription silently worked anyway, because `transcribe_wav_bytes`
        // preloads on first use. Listing it here makes `running` mean what it says
        // and warms the first dictation. `start_all` skips it when the model is not
        // installed, and a lean build (no `voice-parakeet`) refuses in `start()` and
        // reports the missing feature — neither reports a false "Running".
        "parakeet".into(),
        // audio.cpp is a selectable native STT/TTS runtime. It is only started
        // when its version marker is present, so the optional alternate costs
        // nothing on nodes that have not installed it.
        "audiocpp".into(),
        "ollama".into(),
        "vllm".into(),
        "sglang".into(),
        "mlx".into(),
        // MLX-VLM and oMLX MUST be listed like every other local engine: this
        // order seeds the installed set on restart, drives `start_all`'s
        // resident-engine boot, `available_local_engines`, and `stop_all`'s
        // shutdown sweep. Omitting them made a persisted selection read as
        // "not installed" after a restart and leaked their Python servers on
        // Core shutdown.
        "mlx-vlm".into(),
        "mlx-serve".into(),
        "omlx".into(),
        // Docker Model Runner is adopt-only (never spawned/downloaded), but it
        // MUST be in startup_order: `seed_names = startup_order.clone()` drives
        // `seed_installed_from_disk`, so without it a persisted install would not
        // re-seed the installed set on restart. `start_all` skips non-resident
        // local engines, so listing it here has no spawn cost.
        "docker-model-runner".into(),
        "lemonade".into(),
        "magnitude".into(),
        "llama-swap".into(),
        "freetoken".into(),
        // apfel (Apple Foundation Models). Like docker-model-runner it never
        // auto-spawns (`start_all` skips non-resident local engines), but it MUST
        // be in startup_order so `seed_installed_from_disk` re-seeds a persisted
        // install on restart — otherwise a Mac that chose Apple Intelligence would
        // lose the selection across Core restarts.
        "apfel".into(),
        "mesh-llm".into(),
        // Finally agents
        "zeroclaw".into(),
        "openclaw".into(),
        // nanoclaw is deliberately NOT auto-started: it is a message-driven Node
        // orchestrator (its own WhatsApp/Telegram/Slack ingress) with no HTTP/ACP
        // endpoint for Core to health-check or route a chat turn to, so its
        // Sidecar::start() bails by design. Kept registered for the docker-sandbox
        // installer only; not a Ryu-routable agent (issue #509 abandoned).
        "picoclaw".into(),
        "nemoclaw".into(),
        "ironclaw".into(),
        "hermes".into(),
        // Network backends (Tailscale/Headscale, Tailcat, Cloudflared, OpenTunnel,
        // and the plugin tunnel adapter). Listed in
        // startup_order so an enabled node auto-starts its selected backend on boot.
        // `start_all` skips them
        // unless it was explicitly marked installed, which `main()` does just
        // below only when `ryu_mesh::is_enabled()`. A mesh-off install is never
        // marked and so never runs (nor logs) anything.
        //
        // Managed binaries may exist because Ryu installed them while the tunnel
        // was off. The enabled preference remains the authority that marks the
        // selected sidecar installed and allows its listener to start.
        "tailscale".into(),
        "tailcat".into(),
        "cloudflared".into(),
        "opentunnel".into(),
        "tunnel-plugin".into(),
    ]
}

#[cfg(test)]
mod startup_order_tests {
    use super::default_startup_order;

    #[test]
    fn every_local_engine_is_in_the_startup_order() {
        let order = default_startup_order();
        for engine in crate::sidecar::active_engine::LOCAL_ENGINES {
            assert!(
                order.iter().any(|name| name == engine),
                "local engine {engine} is missing from the startup order"
            );
        }
    }

    /// The node screener's guard tier is opt-in: it must never auto-start.
    #[test]
    fn the_guard_tier_is_not_in_the_startup_order() {
        let order = default_startup_order();
        assert!(!order.iter().any(|name| {
            name == crate::sidecar::providers::llamacpp::guard::GUARD_SIDECAR_NAME
        }));
    }
}
