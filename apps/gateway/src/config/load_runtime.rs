//! Runtime and credits environment overrides, applied by `GatewayConfig::load`.

use super::*;

/// Compression, tool loop, smart routing and per-session budget overrides.
pub(super) fn load_runtime_env(config: &mut GatewayConfig) {
    // Context compression (egress transform via headroom). Off by default;
    // Core sets these when the headroom proxy sidecar is enabled so that
    // every gateway-routed agent is auto-compressed.
    if let Ok(raw) = std::env::var("GATEWAY_COMPRESSION_ENABLED") {
        if let Some(enabled) = parse_bool_env(&raw) {
            config.compression.enabled = enabled;
        }
    }
    if let Ok(url) = std::env::var("GATEWAY_COMPRESSION_URL") {
        if !url.trim().is_empty() {
            config.compression.url = url;
        }
    }
    if let Ok(token) = std::env::var("GATEWAY_COMPRESSION_TOKEN") {
        if !token.trim().is_empty() {
            config.compression.token = Some(token);
        }
    }
    // The compression *service* is plugin-defined: Core forwards the policy
    // definition's `timeout_ms` / `min_messages` here so the whole config is
    // data-driven (any compression plugin, not just the bundled headroom one).
    if let Ok(raw) = std::env::var("GATEWAY_COMPRESSION_TIMEOUT_MS") {
        if let Ok(v) = raw.trim().parse::<u64>() {
            config.compression.timeout_ms = v;
        }
    }
    if let Ok(raw) = std::env::var("GATEWAY_COMPRESSION_MIN_MESSAGES") {
        if let Ok(v) = raw.trim().parse::<usize>() {
            config.compression.min_messages = v;
        }
    }

    // Unified tool loop (#475). The client is keyed off CORE_URL (above);
    // this only toggles the master switch (default true).
    if let Ok(raw) = std::env::var("GATEWAY_TOOLS_ENABLED") {
        if let Some(enabled) = parse_bool_env(&raw) {
            config.tools.enabled = enabled;
        }
    }

    // Smart model routing. `gateway.toml [routing.smart_routing]` is the
    // primary config (rules live there); these env knobs only toggle the
    // master switch and the classifier model so the local stack can flip
    // it on without a config file. Rules are config-file-only.
    if let Ok(raw) = std::env::var("GATEWAY_SMART_ROUTING_ENABLED") {
        if let Some(enabled) = parse_bool_env(&raw) {
            config.routing.smart_routing.enabled = enabled;
        }
    }
    if let Ok(model) = std::env::var("GATEWAY_SMART_ROUTING_MODEL") {
        if !model.trim().is_empty() {
            config.routing.smart_routing.classifier_model = model;
        }
    }

    // Per-session charged-cost budget (#510). Config-file (`[budgets.session]`)
    // is primary; these envs override for a quick per-deployment cap with no
    // gateway.toml edit. The value is micro-USD (`1_000_000 = $1`), and
    // `GATEWAY_SESSION_BUDGET_LIMIT=0` disables it.
    if let Ok(raw) = std::env::var("GATEWAY_SESSION_BUDGET_LIMIT") {
        if let Ok(limit) = raw.trim().parse::<u64>() {
            config.budgets.session.limit = limit;
        }
    }
    if let Ok(raw) = std::env::var("GATEWAY_SESSION_BUDGET_ACTION") {
        match raw.trim().to_ascii_lowercase().as_str() {
            "notify" => config.budgets.session.action = BudgetAction::Notify,
            "downgrade" => config.budgets.session.action = BudgetAction::Downgrade,
            "restrict" => config.budgets.session.action = BudgetAction::Restrict,
            "stop" => config.budgets.session.action = BudgetAction::Stop,
            _ => {}
        }
    }
}

/// Platform-credits debit, media and sandbox rate overrides.
pub(super) fn load_credits_env(config: &mut GatewayConfig) {
    // Platform-credits debit hook (#486). Off by default; Core enables it
    // when the credits wallet is live for the deployment. The debit endpoint
    // shares the control-plane API, so inherit the resolved
    // control_plane.base_url ONLY when `[credits] base_url` was left at its
    // default — an explicit gateway.toml value (or GATEWAY_CREDITS_URL below)
    // wins, preserving the "TOML primary, env overrides" convention.
    if config.credits.base_url == default_control_plane_url() {
        config.credits.base_url = config.control_plane.base_url.clone();
    }
    apply_credits_activation_env(&mut config.credits, |name| std::env::var(name).ok());
    apply_managed_openrouter_privacy_default(
        config,
        std::env::var_os("OPENROUTER_DATA_COLLECTION").is_some(),
    );
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_MARKUP_BPS") {
        if let Ok(bps) = raw.trim().parse::<u64>() {
            config.credits.markup_bps = bps;
        }
    }
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_PASS_THROUGH_PROVIDERS") {
        config.credits.provider_billing = raw
            .split(',')
            .map(str::trim)
            .filter(|provider| !provider.is_empty())
            .map(|provider| {
                (
                    ProviderId::from(provider),
                    ProviderBillingPolicy {
                        mode: ProviderBillingMode::PassThrough,
                    },
                )
            })
            .collect();
    }
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD") {
        if let Ok(cost) = raw.trim().parse::<u64>() {
            config.credits.cost_per_tool_call_micro_usd = cost;
        }
    }
    // Per-modality flat media rates. Each has a real non-zero default, so an
    // unset var never lands on 0; setting one of these to 0 explicitly is
    // REFUSED at boot for TTS and STT (see `validate_metered_rates`), the two
    // whose only cost source is the flat rate.
    for (var, slot) in [
        (
            "GATEWAY_CREDITS_COST_PER_IMAGE_MICRO_USD",
            &mut config.credits.cost_per_image_micro_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_VIDEO_MICRO_USD",
            &mut config.credits.cost_per_video_micro_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_TTS_MICRO_USD",
            &mut config.credits.cost_per_tts_micro_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_STT_MICRO_USD",
            &mut config.credits.cost_per_stt_micro_usd,
        ),
    ] {
        if let Ok(raw) = std::env::var(var) {
            if let Ok(cost) = raw.trim().parse::<u64>() {
                *slot = cost;
            }
        }
    }
    // Sandbox per-resource Daytona rates (nano-USD/unit-second) + the two
    // scalar knobs. Rates default to the Daytona base rates (manual `Default`
    // impl); these envs let a deployment override any rate without a
    // gateway.toml edit. Core injects all of them at gateway spawn.
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_SANDBOX_MARKUP_BPS") {
        if let Ok(bps) = raw.trim().parse::<u64>() {
            config.credits.sandbox_markup_bps = bps;
        }
    }
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_SANDBOX_SIZE_RATES") {
        config.credits.sandbox_size_rates =
            sandbox_size_rates_from_env(&raw, config.credits.sandbox_size_rates);
    }
    if let Ok(raw) = std::env::var("GATEWAY_BOX_MINIMUM_WAIVER_PUBLIC_KEY") {
        let raw = raw.trim();
        config.credits.box_minimum_waiver_public_key = (!raw.is_empty()).then(|| raw.to_owned());
    }
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_SANDBOX_FREE_STORAGE_GIB") {
        if let Ok(gib) = raw.trim().parse::<u64>() {
            config.credits.sandbox_free_storage_gib = gib;
        }
    }
    for (var, slot) in [
        (
            "GATEWAY_CREDITS_COST_PER_SANDBOX_VCPU_SECOND_NANO_USD",
            &mut config.credits.cost_per_sandbox_vcpu_second_nano_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_SANDBOX_MEM_GIB_SECOND_NANO_USD",
            &mut config.credits.cost_per_sandbox_mem_gib_second_nano_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_SANDBOX_STORAGE_GIB_SECOND_NANO_USD",
            &mut config.credits.cost_per_sandbox_storage_gib_second_nano_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_H200_SECOND_NANO_USD",
            &mut config.credits.cost_per_sandbox_gpu_h200_second_nano_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_H100_SECOND_NANO_USD",
            &mut config.credits.cost_per_sandbox_gpu_h100_second_nano_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_PRO_6000_SECOND_NANO_USD",
            &mut config
                .credits
                .cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_5090_SECOND_NANO_USD",
            &mut config.credits.cost_per_sandbox_gpu_rtx_5090_second_nano_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_SANDBOX_GPU_RTX_4090_SECOND_NANO_USD",
            &mut config.credits.cost_per_sandbox_gpu_rtx_4090_second_nano_usd,
        ),
        (
            "GATEWAY_CREDITS_COST_PER_SANDBOX_WINDOWS_VCPU_SECOND_NANO_USD",
            &mut config.credits.cost_per_sandbox_windows_vcpu_second_nano_usd,
        ),
    ] {
        if let Ok(raw) = std::env::var(var) {
            if let Ok(rate) = raw.trim().parse::<u64>() {
                *slot = rate;
            }
        }
    }
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_WALLET_EMPTY_ACTION") {
        match raw.trim().to_ascii_lowercase().as_str() {
            "downgrade" => config.credits.wallet_empty_action = WalletEmptyAction::Downgrade,
            "stop" => config.credits.wallet_empty_action = WalletEmptyAction::Stop,
            _ => {}
        }
    }
    if let Ok(model) = std::env::var("GATEWAY_CREDITS_WALLET_EMPTY_DOWNGRADE_TO") {
        if !model.trim().is_empty() {
            config.credits.wallet_empty_downgrade_to = Some(model);
        }
    }
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_FAIL_CLOSED") {
        if let Some(fail_closed) = parse_bool_env(&raw) {
            config.credits.fail_closed = fail_closed;
        }
    }
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_RESERVE") {
        if let Some(enabled) = parse_bool_env(&raw) {
            config.credits.reserve_enabled = enabled;
        }
    }
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_MIN_RESERVE_MICRO_USD") {
        if let Ok(value) = raw.trim().parse::<u64>() {
            config.credits.min_reserve_micro_usd = value;
        }
    }
    if let Ok(raw) = std::env::var("GATEWAY_CREDITS_TOP_UP_URL") {
        config.credits.top_up_url = raw.trim().to_owned();
    }
}
