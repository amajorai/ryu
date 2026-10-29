use super::*;

/// The default config must survive a TOML serialize → deserialize round-trip
/// unchanged. This is the exact `save()` → `load()` path (minus disk) and
/// exercises the Serialize/Deserialize derives across every nested config
/// struct, guarding against a `#[serde(default)]`/rename drift that would make
/// a written config fail to re-parse.
#[test]
fn default_config_survives_toml_roundtrip() {
    let cfg = GatewayConfig::default();
    let text = toml::to_string_pretty(&cfg).expect("serialize default config");
    let back: GatewayConfig = toml::from_str(&text).expect("re-parse default config");
    // Spot-check load-bearing fields across several sub-configs.
    assert_eq!(back.bind, cfg.bind);
    assert_eq!(back.routing.default_provider, cfg.routing.default_provider);
    assert_eq!(back.firewall.policy, cfg.firewall.policy);
    assert_eq!(back.cache.enabled, cfg.cache.enabled);
    assert_eq!(
        back.circuit_breaker.failure_threshold,
        cfg.circuit_breaker.failure_threshold
    );
    assert_eq!(
        back.control_plane.cost_per_1k_micro_usd,
        cfg.control_plane.cost_per_1k_micro_usd
    );
    assert_eq!(
        back.credits.sandbox_markup_bps,
        cfg.credits.sandbox_markup_bps
    );
    assert_eq!(back.fleet, cfg.fleet);
}

/// The `[credits]` table the PUBLISHED self-host doc hands operators
/// (`apps/fumadocs/content/docs/gateway/configuration.mdx`, "## Credits") must
/// deserialize the nine sandbox rates to their documented non-zero defaults.
///
/// ## Why the round-trip test above cannot catch this
///
/// [`default_config_survives_toml_roundtrip`] serializes
/// `GatewayConfig::default()` first, and `toml::to_string_pretty` EMITS every
/// non-skipped field — including all nine rates, already at their default
/// values. The re-parse therefore reads a `[credits]` table in which each key
/// is *present*, so serde never runs the absent-key branch. A round-trip test
/// is structurally blind to a wrong `#[serde(default)]`: it can only prove
/// that a value serde WROTE survives being read back. Only a hand-authored
/// TOML that OMITS the keys exercises the default path, which is why the
/// fixture below is pasted from the docs verbatim rather than generated.
///
/// ## Why a zero here is not "free"
///
/// Zeroed rates do not make sandboxes cheap, they turn sandbox billing off and
/// remove a safety stop: `sandbox_tick_cost_raw_micro` → 0 ⇒
/// `sandbox_debit_amount` → 0 ⇒ `debit_sandbox_sync` short-circuits on
/// `billed_micro == 0` and returns `None` ⇒ `compute_verdict` (api/sandbox.rs)
/// sees `balance: None`, so `KillBalance` is unreachable and `accrued` never
/// grows past a `per_run_budget`, so `KillBudget` is unreachable too.
///
/// An ABSENT `[credits]` table was never affected (it takes
/// `impl Default for CreditsConfig` wholesale) — which is exactly why this
/// needs its own fixture with the table present.
#[test]
fn published_credits_doc_toml_keeps_the_documented_sandbox_rates() {
    // Verbatim from docs/gateway/configuration.mdx ("## Credits"). A present
    // `[credits]` table that names no sandbox rate.
    let doc_toml = r#"
[credits]
enabled = false
base_url = "http://127.0.0.1:3000/api"  # defaults to control_plane.base_url
internal_secret = "..."                 # also RYU_CREDITS_INTERNAL_SECRET
markup_bps = 0                          # platform markup in basis points (0 = pass-through)
wallet_empty_action = "stop"            # "stop" | "downgrade"
wallet_empty_downgrade_to = ""
reserve_enabled = true                  # hold an estimate against the balance while a request runs
min_reserve_micro_usd = 10000           # $0.01 floor per request; bounds concurrent burst
timeout_ms = 3000
"#;

    let parsed: GatewayConfig =
        toml::from_str(doc_toml).expect("the documented [credits] table parses");
    let credits = &parsed.credits;
    let want = CreditsConfig::default();

    // The keys the doc DOES set are honored (proves the table was really read
    // and the assertions below are not passing on an ignored fragment).
    assert!(!credits.enabled);
    assert_eq!(credits.timeout_ms, 3000);

    // The nine rates the doc does NOT set fall back to the documented values,
    // not to 0.
    assert_eq!(
        credits.cost_per_sandbox_vcpu_second_nano_usd,
        want.cost_per_sandbox_vcpu_second_nano_usd
    );
    assert_eq!(
        credits.cost_per_sandbox_mem_gib_second_nano_usd,
        want.cost_per_sandbox_mem_gib_second_nano_usd
    );
    assert_eq!(
        credits.cost_per_sandbox_storage_gib_second_nano_usd,
        want.cost_per_sandbox_storage_gib_second_nano_usd
    );
    assert_eq!(
        credits.cost_per_sandbox_gpu_h200_second_nano_usd,
        want.cost_per_sandbox_gpu_h200_second_nano_usd
    );
    assert_eq!(
        credits.cost_per_sandbox_gpu_h100_second_nano_usd,
        want.cost_per_sandbox_gpu_h100_second_nano_usd
    );
    assert_eq!(
        credits.cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd,
        want.cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd
    );
    assert_eq!(
        credits.cost_per_sandbox_gpu_rtx_5090_second_nano_usd,
        want.cost_per_sandbox_gpu_rtx_5090_second_nano_usd
    );
    assert_eq!(
        credits.cost_per_sandbox_gpu_rtx_4090_second_nano_usd,
        want.cost_per_sandbox_gpu_rtx_4090_second_nano_usd
    );
    assert_eq!(
        credits.cost_per_sandbox_windows_vcpu_second_nano_usd,
        want.cost_per_sandbox_windows_vcpu_second_nano_usd
    );
    // The two siblings that already had `default = "fn"` — asserted here so
    // the fixture covers the whole rate block, not just the repaired nine.
    assert_eq!(
        credits.sandbox_free_storage_gib,
        want.sandbox_free_storage_gib
    );
    assert_eq!(credits.sandbox_markup_bps, want.sandbox_markup_bps);

    // The rates the doc omits are non-zero, so a tick costs something and the
    // wallet path stays reachable. Pinned against the documented values rather
    // than only `!= 0` so a future "default" of 1 nano-USD is caught too.
    assert_eq!(credits.cost_per_sandbox_vcpu_second_nano_usd, 14_000);
    assert_eq!(credits.cost_per_sandbox_gpu_h200_second_nano_usd, 1_261_000);
}

/// The same fixture, for the four MEDIA rates — the second half of the bug
/// the sandbox test above covers, and the one that already reached production.
///
/// `cost_per_image/video/tts/stt_micro_usd` were bare `#[serde(default)]`, so
/// the published `[credits]` table below — present, partial, naming none of
/// them — deserialized all four to 0. The media debit is guarded by
/// `if cost > 0`, so a 0 rate does not bill a little, it SKIPS THE DEBIT, and
/// the provider invoices us anyway. That exact shape shipped once already as
/// the async video job (see
/// `an_async_video_job_bills_from_the_provider_payload_not_the_flat_rate`).
///
/// ## Why the round-trip test cannot catch this
///
/// Same structural reason spelled out on
/// [`published_credits_doc_toml_keeps_the_documented_sandbox_rates`]:
/// `default_config_survives_toml_roundtrip` serializes a fully-populated
/// `GatewayConfig::default()` first, and `toml::to_string_pretty` EMITS every
/// non-skipped field — so the re-parse reads all four keys as *present* and
/// serde never runs the absent-key branch. A round-trip can only prove that a
/// value serde wrote survives being read back; it is blind to a wrong
/// `#[serde(default)]` by construction. Only a hand-authored TOML that OMITS
/// the keys exercises the default path, which is why this fixture is pasted
/// from the docs verbatim rather than generated.
#[test]
fn published_credits_doc_toml_keeps_nonzero_media_rates() {
    // Verbatim from docs/gateway/configuration.mdx ("## Credits"), the block
    // an operator self-hosting a metered gateway copies.
    let doc_toml = r#"
[credits]
enabled = false
base_url = "http://127.0.0.1:3000/api"  # defaults to control_plane.base_url
internal_secret = "..."                 # also RYU_CREDITS_INTERNAL_SECRET
markup_bps = 0                          # platform markup in basis points (0 = pass-through)
wallet_empty_action = "stop"            # "stop" | "downgrade"
wallet_empty_downgrade_to = ""
timeout_ms = 3000
"#;

    let credits = toml::from_str::<GatewayConfig>(doc_toml)
        .expect("the documented [credits] table parses")
        .credits;
    let want = CreditsConfig::default();

    // The keys the doc DOES set are honored, so the assertions below are not
    // passing on a fragment serde quietly ignored.
    assert!(!credits.enabled);
    assert_eq!(credits.timeout_ms, 3000);

    // Both halves, deliberately: `want` alone would still pass if the serde
    // attribute and `impl Default` were BOTH left at 0, and the literal alone
    // would not catch the two drifting apart.
    assert_eq!(
        credits.cost_per_image_micro_usd,
        want.cost_per_image_micro_usd
    );
    assert_eq!(
        credits.cost_per_video_micro_usd,
        want.cost_per_video_micro_usd
    );
    assert_eq!(credits.cost_per_tts_micro_usd, want.cost_per_tts_micro_usd);
    assert_eq!(credits.cost_per_stt_micro_usd, want.cost_per_stt_micro_usd);

    // Pinned against the derivation written on the accessor fns — each is a
    // nominal job duration times Replicate's published L40S GPU-second
    // ($0.000975/sec) — so a future "default" of 1 micro-USD is caught too.
    assert_eq!(credits.cost_per_image_micro_usd, 1_950, "2s x $0.000975/s");
    assert_eq!(
        credits.cost_per_video_micro_usd, 58_500,
        "60s x $0.000975/s"
    );
    assert_eq!(credits.cost_per_tts_micro_usd, 975, "1s x $0.000975/s");
    assert_eq!(credits.cost_per_stt_micro_usd, 975, "1s x $0.000975/s");

    // THE PROPERTY THAT ACTUALLY FAILED. Stated on its own so it survives any
    // later re-derivation of the numbers above: none of these may be 0, or
    // the `if cost > 0` debit guard silently gives the modality away.
    for (name, rate) in [
        ("image", credits.cost_per_image_micro_usd),
        ("video", credits.cost_per_video_micro_usd),
        ("tts", credits.cost_per_tts_micro_usd),
        ("stt", credits.cost_per_stt_micro_usd),
    ] {
        assert!(rate > 0, "{name} must never fall back to a rate of 0");
    }
}

/// The two neighbouring shapes the fixture above does not cover: an ABSENT
/// `[credits]` table (which takes `impl Default for CreditsConfig` wholesale,
/// the other half of the "same number by construction" invariant), and the
/// minimal present-but-partial table. A fix applied to only one of the serde
/// attribute or the `Default` impl passes one of these and fails the other.
#[test]
fn credits_media_rates_are_nonzero_whether_the_table_is_absent_or_partial() {
    let absent = CreditsConfig::default();
    assert!(absent.cost_per_image_micro_usd > 0);
    assert!(absent.cost_per_video_micro_usd > 0);
    assert!(absent.cost_per_tts_micro_usd > 0);
    assert!(absent.cost_per_stt_micro_usd > 0);

    // A present `[credits]` table naming no media rate at all.
    let partial = toml::from_str::<GatewayConfig>(
        r#"
[credits]
enabled = false
timeout_ms = 3000
"#,
    )
    .expect("parses")
    .credits;
    assert_eq!(
        partial.cost_per_image_micro_usd,
        absent.cost_per_image_micro_usd
    );
    assert_eq!(
        partial.cost_per_video_micro_usd,
        absent.cost_per_video_micro_usd
    );
    assert_eq!(
        partial.cost_per_tts_micro_usd,
        absent.cost_per_tts_micro_usd
    );
    assert_eq!(
        partial.cost_per_stt_micro_usd,
        absent.cost_per_stt_micro_usd
    );
}

/// A non-zero sandbox rate is what makes the wallet kill-switch reachable at
/// all: with a present `[credits]` table that names no rate, a tick must still
/// bill a non-zero `billed_micro`, so `debit_sandbox_sync` does not take its
/// `billed_micro == 0` early return. The test above pins the parsed numbers;
/// this one pins what those numbers DO.
///
/// Each resource is priced in ISOLATION (one dimension non-zero at a time,
/// with a long enough window that the nano→micro round-half-up cannot swallow
/// the result). Pricing a mixed workspace instead would let one healthy rate
/// mask eight zeroed ones — the assertion would pass while eight of the nine
/// fields were still broken.
#[test]
fn each_documented_sandbox_rate_bills_a_nonzero_tick_on_its_own() {
    // A present `[credits]` table naming no sandbox rate at all — the shape
    // the published doc produces.
    let doc_toml = r#"
[credits]
enabled = false
timeout_ms = 3000
"#;
    let credits = toml::from_str::<GatewayConfig>(doc_toml)
        .expect("parses")
        .credits;
    // 1000s so even the smallest rate (storage, 30 nano/GiB/s) clears the
    // nano→micro rounding floor rather than testing the rounding.
    const SECS: u64 = 1_000;

    let mut cases: Vec<(&str, u64)> = vec![
        (
            "vcpu",
            credits.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, SECS),
        ),
        (
            "mem",
            credits.sandbox_tick_cost_raw_micro(0, 1, 0, GpuKind::None, 0, OsKind::Linux, SECS),
        ),
        (
            // Over the free-storage tier, so the storage rate is the only
            // term that can contribute.
            "storage",
            credits.sandbox_tick_cost_raw_micro(
                0,
                0,
                u32::try_from(credits.sandbox_free_storage_gib)
                    .expect("the default free-storage tier fits in u32")
                    + 1,
                GpuKind::None,
                0,
                OsKind::Linux,
                SECS,
            ),
        ),
    ];
    for (label, gpu) in [
        ("gpu_h200", GpuKind::H200),
        ("gpu_h100", GpuKind::H100),
        ("gpu_rtx_pro_6000", GpuKind::RtxPro6000),
        ("gpu_rtx_5090", GpuKind::Rtx5090),
        ("gpu_rtx_4090", GpuKind::Rtx4090),
    ] {
        cases.push((
            label,
            credits.sandbox_tick_cost_raw_micro(0, 0, 0, gpu, 1, OsKind::Linux, SECS),
        ));
    }
    // Windows surcharge in isolation: the same 1-vCPU tick must cost strictly
    // MORE on Windows than on Linux, which is only true if the surcharge rate
    // is non-zero (a bare `windows` tick also carries the base vCPU rate, so
    // an absolute `> 0` here would pass with the surcharge zeroed).
    let linux_vcpu =
        credits.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, SECS);
    let windows_vcpu =
        credits.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Windows, SECS);
    assert!(
        windows_vcpu > linux_vcpu,
        "the Windows vCPU surcharge is not being applied ({windows_vcpu} vs {linux_vcpu})"
    );

    for (label, raw) in cases {
        assert!(
            raw > 0,
            "the {label} rate bills nothing; a 0 here means debit_sandbox_sync \
             returns None on that workload, so compute_verdict never sees a \
             balance and KillBalance is unreachable"
        );
        assert!(
            credits.sandbox_debit_amount(raw) > 0,
            "the {label} rate survives the markup as a zero debit"
        );
    }
}

/// A richly-populated config (providers with multi-account keys, routing with a
/// tiered fallback chain, a non-default firewall policy, control-plane pricing)
/// round-trips through TOML with every value preserved.
#[test]
fn populated_config_roundtrips_every_value() {
    let mut cfg = GatewayConfig::default();
    cfg.providers.openai = Some(OpenAiProviderConfig {
        api_key: "sk-primary".to_string(),
        api_keys: vec!["sk-a".to_string(), "sk-b".to_string()],
        base_url: "https://proxy.example/v1".to_string(),
    });
    cfg.routing.default_provider = ProviderId::from("primary");
    cfg.routing.fallback_chain = vec![ProviderId::from("primary"), ProviderId::from("secondary")];
    cfg.routing
        .provider_tiers
        .insert(ProviderId::from("secondary"), 2);
    cfg.firewall.policy = FirewallPolicy::Sanitize;
    cfg.control_plane.enabled = true;
    cfg.control_plane.gateway_key = Some("gw-key".to_string());
    cfg.control_plane.cost_per_1k_micro_usd = 4321;
    cfg.control_plane.model_pricing.insert(
        "claude-sonnet".to_string(),
        ModelPrice {
            input_per_1k_micro_usd: 3000,
            output_per_1k_micro_usd: 15000,
        },
    );
    cfg.credits.markup_bps = 700;

    let text = toml::to_string_pretty(&cfg).expect("serialize populated config");
    let back: GatewayConfig = toml::from_str(&text).expect("re-parse populated config");

    let openai = back.providers.openai.expect("openai survives");
    assert_eq!(openai.all_keys(), vec!["sk-primary", "sk-a", "sk-b"]);
    assert_eq!(openai.base_url, "https://proxy.example/v1");
    assert_eq!(back.routing.default_provider, ProviderId::from("primary"));
    assert_eq!(back.routing.fallback_chain.len(), 2);
    assert_eq!(
        back.routing
            .provider_tiers
            .get(&ProviderId::from("secondary")),
        Some(&2)
    );
    assert_eq!(back.firewall.policy, FirewallPolicy::Sanitize);
    assert!(back.control_plane.enabled);
    assert_eq!(back.control_plane.gateway_key.as_deref(), Some("gw-key"));
    assert_eq!(back.control_plane.cost_per_1k_micro_usd, 4321);
    // The per-model price table survived and still resolves via longest-prefix.
    assert_eq!(
        back.control_plane.cost_for("claude-sonnet-4-5", 1000, 1000),
        18000
    );
    assert_eq!(back.credits.markup_bps, 700);
}
