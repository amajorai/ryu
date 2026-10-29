use super::{
    box_billable_seconds, default_sandbox_size_rates, sandbox_size_rates_from_env, CreditsConfig,
    GpuKind, Modality, OsKind, ProviderBillingPolicy, ProviderId, SandboxSize, SizeRates,
    WalletEmptyAction, BOX_BILLING_ROUNDING_SECONDS, BOX_MINIMUM_SECONDS_PER_START,
};

#[test]
fn debit_amount_passthrough_at_zero_bps() {
    let c = CreditsConfig::default();
    assert_eq!(c.markup_bps, 0);
    // bps=0 ⇒ identity.
    assert_eq!(c.debit_amount(0), 0);
    assert_eq!(c.debit_amount(1), 1);
    assert_eq!(c.debit_amount(1_000_000), 1_000_000);
}

#[test]
fn sandbox_size_rates_default_to_the_box_rates_and_parse() {
    let expected = SizeRates {
        small: 25_000,
        default: 40_000,
        large: 70_000,
    };
    let defaults = CreditsConfig::default();
    assert_eq!(defaults.sandbox_size_rates, Some(expected));
    assert_eq!(
        defaults.sandbox_size_debit_micro(SandboxSize::Small, 3600),
        Some(25_000)
    );
    assert_eq!(
        SizeRates::parse("small=25000, default=40000,large=70000"),
        Ok(expected)
    );
    assert_eq!(
        SizeRates::parse(r#"{"small":25000,"default":40000,"large":70000}"#),
        Ok(expected)
    );
    for bad in [
        "small=25000,default=40000",
        "small=25000,default=40000,large=0",
        "small=25000,small=1,default=40000,large=70000",
        "small=25000,default=40000,large=70000,huge=1",
        "small=2.5,default=40000,large=70000",
        r#"{"small":25000}"#,
    ] {
        assert!(SizeRates::parse(bad).is_err(), "{bad}");
    }
    // 10 s of small at $0.025/h = 69.44 micro-USD, round half up.
    assert_eq!(
        defaults.sandbox_size_debit_micro(SandboxSize::Small, 10),
        Some(69)
    );
    assert_eq!(
        defaults.sandbox_size_debit_micro(SandboxSize::Large, 3600),
        Some(70_000)
    );
    // TOML: absent is the default table, a table replaces it, "off" turns
    // size pricing off.
    let parsed: CreditsConfig = toml::from_str("enabled = true").expect("credits toml");
    assert_eq!(parsed.sandbox_size_rates, Some(expected));
    let parsed: CreditsConfig =
        toml::from_str("[sandbox_size_rates]\nsmall = 1\ndefault = 2\nlarge = 3")
            .expect("credits toml with size rates");
    assert_eq!(
        parsed.sandbox_size_rates,
        Some(SizeRates {
            small: 1,
            default: 2,
            large: 3
        })
    );
    let parsed: CreditsConfig =
        toml::from_str("sandbox_size_rates = \"off\"").expect("credits toml off");
    assert_eq!(parsed.sandbox_size_rates, None);
    assert_eq!(
        parsed.sandbox_size_debit_micro(SandboxSize::Small, 10),
        None
    );
    assert!(toml::from_str::<CreditsConfig>(
        "[sandbox_size_rates]\nsmall = 0\ndefault = 2\nlarge = 3"
    )
    .is_err());
    // The env override: blank keeps, off clears, a table replaces, and a
    // malformed table keeps the configured one.
    assert_eq!(
        sandbox_size_rates_from_env("", Some(expected)),
        Some(expected)
    );
    assert_eq!(sandbox_size_rates_from_env(" OFF ", Some(expected)), None);
    assert_eq!(sandbox_size_rates_from_env("none", Some(expected)), None);
    assert_eq!(
        sandbox_size_rates_from_env("small=1,default=2,large=3", Some(expected)),
        Some(SizeRates {
            small: 1,
            default: 2,
            large: 3
        })
    );
    assert_eq!(
        sandbox_size_rates_from_env("small=1", Some(expected)),
        Some(expected)
    );
}

/// The Gateway's default Box rates and billing rule are the shared Box
/// rate fixture, which `SERVICE_RATES.box`, the control plane, Core and
/// the Box service also read.
#[test]
fn box_rate_defaults_match_the_shared_fixture() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../crates/gateway/contracts/fixtures/box-rates.json"
    ))
    .expect("box-rates.json is JSON");
    let sizes = &fixture["sizeMicroUsdPerHour"];
    assert_eq!(
        default_sandbox_size_rates(),
        Some(SizeRates {
            small: sizes["small"].as_u64().expect("small"),
            default: sizes["default"].as_u64().expect("default"),
            large: sizes["large"].as_u64().expect("large"),
        })
    );
    assert_eq!(
        fixture["minimumSecondsPerStart"].as_u64(),
        Some(BOX_MINIMUM_SECONDS_PER_START)
    );
    assert_eq!(
        fixture["roundingSeconds"].as_u64(),
        Some(BOX_BILLING_ROUNDING_SECONDS)
    );
}

#[test]
fn box_billable_seconds_rounds_up_with_a_five_minute_minimum() {
    assert_eq!(box_billable_seconds(0, true), 300);
    assert_eq!(box_billable_seconds(10, true), 300);
    assert_eq!(box_billable_seconds(300, true), 300);
    assert_eq!(box_billable_seconds(301, true), 360);
    assert_eq!(box_billable_seconds(3600, true), 3600);
    assert_eq!(box_billable_seconds(3601, true), 3660);
    // A run first seen after a restart already paid its minimum.
    assert_eq!(box_billable_seconds(0, false), 0);
    assert_eq!(box_billable_seconds(10, false), 60);
    assert_eq!(box_billable_seconds(u64::MAX, true), u64::MAX);
}

#[test]
fn debit_amount_applies_markup_round_half_up() {
    let c = CreditsConfig {
        markup_bps: 2000, // +20%
        ..Default::default()
    };
    // 1000 * 12000 / 10000 = 1200 exactly.
    assert_eq!(c.debit_amount(1000), 1200);
    // 1 * 12000 / 10000 = 1.2 → round-half-up → 1.
    assert_eq!(c.debit_amount(1), 1);
    // 5 * 12000 = 60000, +5000 = 65000, /10000 = 6 (was 6.0).
    assert_eq!(c.debit_amount(5), 6);
}

#[test]
fn debit_amount_rounds_half_up_at_boundary() {
    // 50 bps markup: 100 * 10050 = 1_005_000, +5000 = 1_010_000, /10000 = 101.
    let c = CreditsConfig {
        markup_bps: 50,
        ..Default::default()
    };
    assert_eq!(c.debit_amount(100), 101);
}

#[test]
fn undo_debit_amount_inverts_the_markup_without_overshooting() {
    // Sizes a spend ceiling, so it must never return a raw cost whose DEBIT
    // exceeds the budget it was derived from — that would hand out a ceiling
    // the charge then breaks through, which is the overdraft it exists to
    // prevent. Round DOWN, and verify the round trip stays inside.
    let c = CreditsConfig {
        markup_bps: 10_000, // +100%: charged = 2x raw
        ..Default::default()
    };
    assert_eq!(c.undo_debit_amount(50_000), 25_000);
    assert!(c.debit_amount(c.undo_debit_amount(50_000)) <= 50_000);

    // Pass-through at zero bps.
    let free = CreditsConfig::default();
    assert_eq!(free.markup_bps, 0);
    assert_eq!(free.undo_debit_amount(1_234), 1_234);

    // Odd rates must still not overshoot after the round trip.
    let odd = CreditsConfig {
        markup_bps: 333,
        ..Default::default()
    };
    for budget in [1_u64, 7, 99, 1000, 999_999] {
        assert!(
            odd.debit_amount(odd.undo_debit_amount(budget)) <= budget,
            "round trip overshot the budget at {budget}"
        );
    }
}

#[test]
fn is_active_requires_enabled_url_and_secret() {
    let base = CreditsConfig {
        enabled: true,
        internal_secret: Some("s".to_string()),
        ..Default::default()
    };
    assert!(base.is_active());

    let no_secret = CreditsConfig {
        internal_secret: None,
        ..base.clone()
    };
    assert!(!no_secret.is_active());

    let blank_secret = CreditsConfig {
        internal_secret: Some("  ".to_string()),
        ..base.clone()
    };
    assert!(!blank_secret.is_active());

    let disabled = CreditsConfig {
        enabled: false,
        ..base.clone()
    };
    assert!(!disabled.is_active());

    let no_url = CreditsConfig {
        base_url: "  ".to_string(),
        ..base
    };
    assert!(!no_url.is_active());
}

#[test]
fn wallet_empty_action_defaults_to_stop() {
    assert_eq!(WalletEmptyAction::default(), WalletEmptyAction::Stop);
}

#[test]
fn reservation_defaults_survive_a_partial_credits_table() {
    // THE DRIFT THIS CATCHES: `Default for CreditsConfig` and the serde
    // `default = "…"` fns are two separate declarations of the same number.
    // If they disagree, an ABSENT `[credits]` table and a PRESENT one that
    // omits these keys behave differently — and for `reserve_enabled` that
    // difference is "concurrent requests are bounded" vs "they are not".
    let absent: crate::GatewayConfig = toml::from_str("").expect("empty config parses");
    assert!(absent.credits.reserve_enabled);
    assert_eq!(absent.credits.min_reserve_micro_usd, 10_000);

    let partial: crate::GatewayConfig = toml::from_str(
        r#"
[credits]
enabled = true
"#,
    )
    .expect("partial credits table parses");
    assert!(
        partial.credits.reserve_enabled,
        "omitting the key must not silently disable the reservation"
    );
    assert_eq!(partial.credits.min_reserve_micro_usd, 10_000);
    assert_eq!(
        partial.credits.reserve_enabled,
        CreditsConfig::default().reserve_enabled
    );
    assert!(
        partial.credits.fail_closed,
        "omitting fail_closed must not silently re-enable unbilled managed spend"
    );
    assert_eq!(
        partial.credits.fail_closed,
        CreditsConfig::default().fail_closed
    );
    assert_eq!(
        partial.credits.min_reserve_micro_usd,
        CreditsConfig::default().min_reserve_micro_usd
    );
}

#[test]
fn provider_billing_policy_round_trips_from_gateway_config() {
    let config: crate::GatewayConfig = toml::from_str(
        r#"
[credits]
[credits.provider_billing.whatsapp]
mode = "pass_through"

[credits.provider_billing.openrouter]
mode = "pass_through"
"#,
    )
    .expect("provider pass-through config parses");

    let encoded = serde_json::to_value(config.credits).expect("credits serialize");
    assert_eq!(
        encoded["provider_billing"]["whatsapp"]["mode"],
        "pass_through"
    );
    assert_eq!(
        encoded["provider_billing"]["openrouter"]["mode"],
        "pass_through"
    );
}

#[test]
fn provider_pass_through_bypasses_global_markup_only_for_that_provider() {
    let config = CreditsConfig {
        markup_bps: 2000,
        provider_billing: [(
            ProviderId::from("WhatsApp"),
            ProviderBillingPolicy {
                mode: super::ProviderBillingMode::PassThrough,
            },
        )]
        .into_iter()
        .collect(),
        ..Default::default()
    };

    assert_eq!(
        config.debit_amount_for_provider(Some("whatsapp"), 1000),
        1000
    );
    assert_eq!(
        config.debit_amount_for_provider(Some("openrouter"), 1000),
        1200
    );
    assert_eq!(config.debit_amount_for_provider(None, 1000), 1200);
    assert_eq!(
        config.undo_debit_amount_for_provider(Some("WHATSAPP"), 1000),
        1000
    );
    assert_eq!(
        config.undo_debit_amount_for_provider(Some("openrouter"), 1200),
        1000
    );
}

#[test]
fn the_tool_call_rate_defaults_to_composios_cost() {
    // AT COST. Composio's managed-app rate is $0.50/1k executions, so the
    // default is 500 micro-USD per call and the customer pays exactly what we pay.
    // Margin is the deposit fee, never a per-unit markup.
    assert_eq!(CreditsConfig::default().cost_per_tool_call_micro_usd, 500);
    assert_eq!(CreditsConfig::default().markup_bps, 0);
}

#[test]
fn the_boot_gate_passes_on_the_default_rates() {
    // The boot failure the gate was cut back to avoid — a node refusing to
    // start until someone invented numbers — cannot happen now that every
    // gated rate carries a real default. Nothing set, credits on, boots.
    let c = CreditsConfig {
        enabled: true,
        ..Default::default()
    };
    assert!(c.validate_metered_rates().is_ok());
}

#[test]
fn zeroing_tts_or_stt_fails_the_boot_gate() {
    // TTS and STT are served synchronously and have NO second cost source, so
    // a flat rate of 0 there is not an unreached fallback — it is the only
    // number the debit will ever see, and `if cost > 0` then skips it. An
    // explicit 0 is a deliberate give-away and must be stated as one via
    // GATEWAY_CREDITS_ALLOW_FREE_MODALITIES, not left in a blank.
    let tts = CreditsConfig {
        enabled: true,
        cost_per_tts_micro_usd: 0,
        ..Default::default()
    };
    assert!(tts.validate_metered_rates().is_err());

    let stt = CreditsConfig {
        enabled: true,
        cost_per_stt_micro_usd: 0,
        ..Default::default()
    };
    assert!(stt.validate_metered_rates().is_err());
}

#[test]
fn zeroing_any_media_fallback_fails_the_boot_gate() {
    for (name, field) in [
        ("image", Modality::Image),
        ("video", Modality::Video),
        ("tts", Modality::Tts),
        ("stt", Modality::Stt),
    ] {
        let mut c = CreditsConfig {
            enabled: true,
            ..Default::default()
        };
        match field {
            Modality::Image => c.cost_per_image_micro_usd = 0,
            Modality::Video => c.cost_per_video_micro_usd = 0,
            Modality::Tts => c.cost_per_tts_micro_usd = 0,
            Modality::Stt => c.cost_per_stt_micro_usd = 0,
            Modality::Audio | Modality::Chat => {
                unreachable!("not listed above: audio shares the video rate")
            }
        }
        assert!(
            c.validate_metered_rates().is_err(),
            "zero {name} fallback must fail the billing startup gate"
        );
    }
}

#[test]
fn zeroing_the_tool_rate_still_fails_the_boot_gate() {
    let c = CreditsConfig {
        enabled: true,
        cost_per_tool_call_micro_usd: 0,
        ..Default::default()
    };
    assert!(c.validate_metered_rates().is_err());
}

#[test]
fn tool_call_cost_is_flat_per_call_and_saturates() {
    let c = CreditsConfig {
        cost_per_tool_call_micro_usd: 500,
        ..Default::default()
    };
    assert_eq!(c.tool_call_cost_micro_usd(0), 0);
    assert_eq!(c.tool_call_cost_micro_usd(3), 1500);
    // Saturating on overflow rather than wrapping.
    assert_eq!(c.tool_call_cost_micro_usd(u64::MAX), u64::MAX);
}

#[test]
fn media_is_priced_from_the_compute_time_the_provider_reported() {
    // THE POINT OF THE WHOLE CHANGE. A flat per-call rate charges a 2s image
    // and a 60s video the same; this bills what the transaction actually
    // consumed.
    let c = CreditsConfig {
        cost_per_gpu_second_micro_usd: 1000,
        cost_per_image_micro_usd: 40_000,
        ..Default::default()
    };
    let response = serde_json::json!({ "usage": { "compute_seconds": 2.5 } });
    let (cost, estimated) = c.media_cost_from_response(&Modality::Image, &response);
    assert_eq!(cost, 2500);
    assert!(!estimated);
}

#[test]
fn media_prefers_provider_reported_cost_including_openrouter_raw_payload() {
    let c = CreditsConfig {
        cost_per_gpu_second_micro_usd: 1000,
        cost_per_image_micro_usd: 40_000,
        ..Default::default()
    };
    let response = serde_json::json!({
        "data": [{ "url": "data:image/png;base64,AAA" }],
        "raw": { "usage": { "cost": 0.012345 }, "choices": [] }
    });
    let (cost, estimated) = c.media_cost_from_response(&Modality::Image, &response);
    assert_eq!(cost, 12_345);
    assert!(!estimated);
}

#[test]
fn a_partial_gpu_second_rounds_up_rather_than_leaking() {
    let c = CreditsConfig {
        cost_per_gpu_second_micro_usd: 1000,
        ..Default::default()
    };
    let response = serde_json::json!({ "usage": { "compute_seconds": 0.0011 } });
    let (cost, _) = c.media_cost_from_response(&Modality::Image, &response);
    assert_eq!(cost, 2);
}

#[test]
fn a_response_with_no_usage_falls_back_and_is_marked_estimated() {
    // The flag is what lets a later reconciliation tell a guess from a
    // measurement; without it the two rows are identical.
    let c = CreditsConfig {
        cost_per_gpu_second_micro_usd: 1000,
        cost_per_video_micro_usd: 90_000,
        ..Default::default()
    };
    let (cost, estimated) =
        c.media_cost_from_response(&Modality::Video, &serde_json::json!({ "data": [] }));
    assert_eq!(cost, 90_000);
    assert!(estimated);
}

#[test]
fn tts_and_stt_flat_rates_are_not_marked_as_estimated() {
    let c = CreditsConfig::default();
    for modality in [Modality::Tts, Modality::Stt] {
        let (cost, estimated) = c.media_cost_from_response(&modality, &serde_json::json!({}));
        assert!(cost > 0);
        assert!(!estimated, "{modality:?} flat rate is its configured price");
    }
}

#[test]
fn an_async_video_job_bills_from_the_provider_payload_not_the_flat_rate() {
    // REGRESSION. The async video-job debit (submit + poll, in
    // `pipeline::mod`) called the flat `media_cost_micro_usd` directly and
    // then guarded on `if cost > 0`. `cost_per_video_micro_usd` defaults to
    // 0, so under a default config every completed async video job billed
    // NOTHING — while the startup gate had stopped guarding the video rate
    // precisely because video was believed to be metered from provider cost.
    // That belief was true of the synchronous path only.
    //
    // The payload shape here is the one those call sites now pass:
    // `MediaJob::to_response()` flattens the provider's output, so
    // `usage.compute_seconds` sits at the top level next to `data`.
    let c = CreditsConfig {
        cost_per_gpu_second_micro_usd: 975,
        // Explicitly zeroed — the shape that was silent back when 0 was also
        // the default for this field.
        cost_per_video_micro_usd: 0,
        ..Default::default()
    };
    let flattened_job_response = serde_json::json!({
        "id": "vid_1",
        "status": "succeeded",
        "data": [{ "url": "https://example.invalid/v.mp4" }],
        "usage": { "compute_seconds": 12.0 },
    });
    let (cost, estimated) = c.media_cost_from_response(&Modality::Video, &flattened_job_response);
    assert_eq!(cost, 11_700, "12s x $0.000975/s");
    assert!(!estimated);
    // And the property that actually failed: a real charge, not zero.
    assert!(cost > 0, "an async video job must never bill nothing");
}

#[test]
fn the_gpu_second_rate_defaults_to_replicates_published_l40s_price() {
    // $0.000975/sec. A real published figure, not an invented one.
    assert_eq!(CreditsConfig::default().cost_per_gpu_second_micro_usd, 975);
}

#[test]
fn media_cost_is_per_modality_and_chat_is_never_metered() {
    let c = CreditsConfig {
        cost_per_image_micro_usd: 10,
        cost_per_video_micro_usd: 20,
        cost_per_tts_micro_usd: 3,
        cost_per_stt_micro_usd: 4,
        ..Default::default()
    };
    assert_eq!(c.media_cost_micro_usd(&Modality::Image), 10);
    assert_eq!(c.media_cost_micro_usd(&Modality::Video), 20);
    assert_eq!(c.media_cost_micro_usd(&Modality::Tts), 3);
    assert_eq!(c.media_cost_micro_usd(&Modality::Stt), 4);
    // Generated audio is a queued job like video and shares its fallback.
    assert_eq!(c.media_cost_micro_usd(&Modality::Audio), 20);
    // Chat is billed on real token usage, never on a flat media rate.
    assert_eq!(c.media_cost_micro_usd(&Modality::Chat), 0);
}

#[test]
fn gpu_rate_nano_maps_each_tier_and_none_is_free() {
    let c = CreditsConfig::default();
    assert_eq!(c.gpu_rate_nano(GpuKind::None), 0);
    assert_eq!(c.gpu_rate_nano(GpuKind::H200), 1_261_000);
    assert_eq!(c.gpu_rate_nano(GpuKind::H100), 1_097_000);
    assert_eq!(c.gpu_rate_nano(GpuKind::RtxPro6000), 842_000);
    assert_eq!(c.gpu_rate_nano(GpuKind::Rtx5090), 358_000);
    assert_eq!(c.gpu_rate_nano(GpuKind::Rtx4090), 275_000);
}

#[test]
fn sandbox_tick_sums_cpu_mem_storage_above_free_tier() {
    let c = CreditsConfig::default();
    // 2 vcpu (14000) + 4 GiB mem (4500) + (10-5)=5 billable storage GiB (30),
    // Linux, no GPU, 1 second:
    //   2*14000 + 4*4500 + 5*30 = 28000 + 18000 + 150 = 46150 nano/sec.
    //   (46150 + 500) / 1000 = 46 micro (round-half-up).
    assert_eq!(
        c.sandbox_tick_cost_raw_micro(2, 4, 10, GpuKind::None, 0, OsKind::Linux, 1),
        46
    );
}

#[test]
fn sandbox_tick_bills_no_storage_within_the_free_tier() {
    let c = CreditsConfig::default();
    // 5 GiB storage == the free tier ⇒ zero storage cost. Only 1 vcpu counts.
    //   1*14000 = 14000 nano ⇒ (14000+500)/1000 = 14 micro.
    assert_eq!(
        c.sandbox_tick_cost_raw_micro(1, 0, 5, GpuKind::None, 0, OsKind::Linux, 1),
        14
    );
}

#[test]
fn sandbox_tick_bills_a_zero_count_gpu_as_one() {
    let c = CreditsConfig::default();
    // A non-None GPU tier with gpu_count=0 still bills as 1 GPU (the invariant
    // in the doc comment): 1 vcpu (14000) + 1 * H200 (1_261_000) = 1_275_000 nano
    //   ⇒ (1_275_000 + 500)/1000 = 1275 micro.
    assert_eq!(
        c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::H200, 0, OsKind::Linux, 1),
        1275
    );
}

#[test]
fn sandbox_tick_adds_windows_vcpu_surcharge() {
    let c = CreditsConfig::default();
    // Windows adds a per-vcpu surcharge (23800 nano/vcpu-sec) on top of the base
    // vcpu rate: 1*14000 + 1*23800 = 37800 ⇒ (37800+500)/1000 = 38 micro.
    assert_eq!(
        c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Windows, 1),
        38
    );
    // Linux has no such surcharge — same shape costs less.
    assert_eq!(
        c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, 1),
        14
    );
}

#[test]
fn sandbox_tick_scales_with_seconds() {
    let c = CreditsConfig::default();
    let one = c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, 1);
    let ten = c.sandbox_tick_cost_raw_micro(1, 0, 0, GpuKind::None, 0, OsKind::Linux, 10);
    // 10 seconds ⇒ 10x the per-second nano before the single micro conversion:
    //   14000*10 = 140000 ⇒ (140000+500)/1000 = 140 micro (== 10 * 14).
    assert_eq!(one, 14);
    assert_eq!(ten, 140);
}

#[test]
fn sandbox_debit_applies_its_own_markup_not_the_global_one() {
    // sandbox_markup_bps defaults to 3000 (× 1.30), distinct from markup_bps (0).
    let c = CreditsConfig::default();
    assert_eq!(c.sandbox_markup_bps, 3000);
    // 100 * 13000 = 1_300_000, +5000 = 1_305_000, /10000 = 130.
    assert_eq!(c.sandbox_debit_amount(100), 130);
    // The at-cost path (debit_amount, markup_bps=0) leaves 100 untouched — proof
    // the two ledgers use different markups.
    assert_eq!(c.debit_amount(100), 100);
}
