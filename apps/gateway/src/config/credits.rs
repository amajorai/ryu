//! Platform-credits billing config (`[credits]`) and its defaults.

use super::*;

/// Provider-level billing mode for managed provider costs.
///
/// `inherit_global` preserves the existing `[credits].markup_bps` behavior.
/// `pass_through` charges the raw provider cost with no platform markup. This
/// controls wallet pricing only; it does not change credential ownership or
/// subscription-preserving egress.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderBillingMode {
    #[default]
    InheritGlobal,
    PassThrough,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct ProviderBillingPolicy {
    #[serde(default)]
    pub mode: ProviderBillingMode,
}

/// Platform-credits wallet debit hook (marketplace monetization #486, spec §4).
///
/// When enabled, after each metered model call the gateway debits the request's
/// org wallet in the control plane by the call's `costMicroUsd` (plus a
/// configurable platform markup). When the debit response reports a non-positive
/// balance, the org is flagged so the *next* request's budget gate fires (the
/// debit is post-call; the gate is pre-call — same one-call-grace shape as the
/// shared-budget coordinator). Disabled by default and a full no-op when the
/// request carries no org (`x-ryu-org-id` / key org), so existing behavior is
/// unchanged. Nothing hardcoded — every knob is a swappable default.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CreditsConfig {
    /// Master switch for the debit hook. Default: false.
    #[serde(default)]
    pub enabled: bool,
    /// Base URL of the control-plane API the debit endpoint lives on, e.g.
    /// `http://127.0.0.1:3000/api`. Defaults to the same control-plane URL.
    #[serde(default = "default_control_plane_url")]
    pub base_url: String,
    /// Shared internal secret sent as `x-ryu-internal-secret` so the control
    /// plane trusts a service-to-service debit for an arbitrary org. The hook is
    /// inert without it (the debit endpoint would reject the call).
    pub internal_secret: Option<String>,
    /// Platform markup on metered usage in basis points. The debited amount is
    /// `costMicroUsd * (10000 + markup_bps) / 10000`, round-half-up. Default: 0
    /// (pass-through at cost).
    #[serde(default)]
    pub markup_bps: u64,
    /// Provider-level billing modes. This is an operational billing policy, not
    /// the routing `provider_tiers` map and not subscription credential
    /// passthrough. Unknown ids are harmless and allow a provider adapter to be
    /// enabled before its first request reaches this gateway.
    #[serde(default)]
    pub provider_billing: HashMap<ProviderId, ProviderBillingPolicy>,
    #[serde(default)]
    pub web_service_prices: crate::web_config::WebServicePrices,
    /// Per-tool-call cost in micro-USD for billable (Composio) tool executions.
    ///
    /// AT COST, and that is the whole pricing position: Composio charges per
    /// managed-app execution at $0.50/1k, so this defaults to
    /// 500 micro-USD per call and the customer is billed exactly what the
    /// provider bills us. Margin lives in the deposit fee, never in a per-unit
    /// markup (`markup_bps` is 0) — see `docs/pricing-remaining-work.md` item 6.
    ///
    /// Legacy count-only fallback. New execution reports carry the actual auth
    /// source, usage kind, add-ons, and exact Instant charge. Never use this
    /// fallback for delivered triggers or a known premium transaction.
    ///
    /// Overridable per deployment with
    /// `GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD` for a different Composio
    /// contract.
    #[serde(default = "default_cost_per_tool_call_micro_usd")]
    pub cost_per_tool_call_micro_usd: u64,
    /// Micro-USD per second of provider compute, used to price a media call from
    /// the compute time the provider actually reported.
    ///
    /// Replicate's published Nvidia L40S rate ($0.000975/sec) is the default —
    /// its most common serverless GPU, and a real published figure rather than
    /// an invented one. Override per deployment with
    /// `GATEWAY_CREDITS_COST_PER_GPU_SECOND_MICRO_USD` if you route to different
    /// hardware.
    ///
    /// This is what makes media metering track the TRANSACTION. A flat per-call
    /// rate charges a two-second image and a sixty-second video identically; the
    /// same configured number is then wrong by up to ~30x in both directions,
    /// and no single value fixes it.
    #[serde(default = "default_cost_per_gpu_second_micro_usd")]
    pub cost_per_gpu_second_micro_usd: u64,

    /// Per-call cost in micro-USD for a successful image generation — THE
    /// FALLBACK the flat path charges when the provider reported no compute time.
    /// Cloud media providers (Replicate/Fal/OpenRouter) may report a
    /// `usage.cost`; when present, that provider-reported USD amount wins. A
    /// call with no reported cost is debited at this flat fallback rate through
    /// the same at-cost + markup path as tokens. Default:
    /// [`default_cost_per_image_micro_usd`]
    /// (`GATEWAY_CREDITS_COST_PER_IMAGE_MICRO_USD`).
    ///
    /// These four defaulted to 0, which is what a fallback must never be: the
    /// media debit is guarded by `if cost > 0`, so a fallback that prices to
    /// nothing does not charge a small amount — it skips the debit entirely,
    /// silently, while the provider still invoices us. That combination already
    /// shipped once (the async video job, see `media_cost_micro_usd`).
    #[serde(default = "default_cost_per_image_micro_usd")]
    pub cost_per_image_micro_usd: u64,
    /// Per-call fallback cost in micro-USD for a successful video generation job.
    /// `GATEWAY_CREDITS_COST_PER_VIDEO_MICRO_USD`. Default:
    /// [`default_cost_per_video_micro_usd`].
    #[serde(default = "default_cost_per_video_micro_usd")]
    pub cost_per_video_micro_usd: u64,
    /// Per-call fallback cost in micro-USD for a successful Audio synthesis.
    /// `GATEWAY_CREDITS_COST_PER_TTS_MICRO_USD`. Default:
    /// [`default_cost_per_tts_micro_usd`].
    #[serde(default = "default_cost_per_tts_micro_usd")]
    pub cost_per_tts_micro_usd: u64,
    /// Per-call fallback cost in micro-USD for a successful Voice Recognition transcription.
    /// `GATEWAY_CREDITS_COST_PER_STT_MICRO_USD`. Default:
    /// [`default_cost_per_stt_micro_usd`].
    #[serde(default = "default_cost_per_stt_micro_usd")]
    pub cost_per_stt_micro_usd: u64,
    /// What the budget layer does when an org's wallet is empty: `stop` (default)
    /// aborts the next request; `downgrade` reroutes to `wallet_empty_downgrade_to`.
    #[serde(default)]
    pub wallet_empty_action: WalletEmptyAction,
    /// Model to downgrade to when `wallet_empty_action = downgrade`. When unset, a
    /// downgrade safely degrades to a restrict (mirrors the spend-budget rule).
    #[serde(default)]
    pub wallet_empty_downgrade_to: Option<String>,
    /// Notification fan-out tier when the org wallet-empty rule matches
    /// (orthogonal to `wallet_empty_action`). Old configs → `Silent`.
    #[serde(default)]
    pub wallet_empty_alert: AlertTier,
    /// Hold an estimate of a managed request's cost against the org's balance
    /// for the life of that request, so concurrent requests cannot all spend the
    /// same balance. `GATEWAY_CREDITS_RESERVE`. Default: **true**.
    ///
    /// Off restores the pre-reservation behaviour: the gate becomes "is the
    /// balance positive", every in-flight request is invisible to every other,
    /// and the only bound on a burst is the per-org rate limit. That is a
    /// deliberate escape hatch for an operator debugging a false 402, not a
    /// posture anyone should run on.
    #[serde(default = "default_true")]
    pub reserve_enabled: bool,
    /// Floor for a single request's reservation, in micro-USD.
    /// `GATEWAY_CREDITS_MIN_RESERVE_MICRO_USD`. Default: 10_000 ($0.01).
    ///
    /// THIS FLOOR, NOT THE ESTIMATE, IS WHAT BOUNDS A BURST. The per-request
    /// estimate is derived from `max_tokens` at the flat
    /// `control_plane.cost_per_1k_micro_usd` rate, which is the only price basis
    /// the gateway holds — it has no per-model price table, and for OpenRouter
    /// traffic the true cost only arrives with the response's `usage.cost`. So
    /// the estimate systematically UNDER-states a frontier model and cannot be
    /// leaned on alone. The floor makes the bound explicit and model-independent:
    /// at most `balance / min_reserve` requests can be in flight for an org, so
    /// a $10 balance admits at most 1000 concurrent requests at the default, and
    /// a wallet holding a fraction of a cent admits none.
    ///
    /// Raise it to tighten the burst bound at the cost of refusing more
    /// legitimate concurrency; it is the one number to tune if a managed tenant
    /// ever outruns its wallet.
    #[serde(default = "default_min_reserve_micro_usd")]
    pub min_reserve_micro_usd: u64,
    /// Per-request timeout in milliseconds for the debit POST. Default: 3000.
    #[serde(default = "default_credits_timeout_ms")]
    pub timeout_ms: u64,
    /// Fail CLOSED on debit errors for managed tenants (env
    /// `GATEWAY_CREDITS_FAIL_CLOSED`). Default: true. When true and the request
    /// is a managed-inference tenant, a debit transport error, non-2xx response,
    /// or malformed success response marks accounting unavailable so the NEXT
    /// request is refused with a retryable 503. This is separate from an empty
    /// wallet, so a transient control-plane outage cannot strand a funded org.
    /// The current in-flight response is never blocked on the async debit; its
    /// cost is retried/reconciled by the control plane, and new provider spend
    /// stops until accounting recovers.
    #[serde(default = "default_true")]
    pub fail_closed: bool,
    /// Where a caller refused for credit tops up, returned as `top_up_url` on a
    /// managed tool call's typed `402`. Empty omits the link.
    /// `GATEWAY_CREDITS_TOP_UP_URL`. Default: the hosted billing page.
    #[serde(default = "default_credits_top_up_url")]
    pub top_up_url: String,

    // ─── Sandbox per-resource rates (Daytona), nano-USD per unit-second ───────
    // Rates are stored in NANO-USD (not micro) because the Daytona storage rate
    // (0.03 micro-USD/GiB/s) truncates to 0 in a u64 micro-USD field, silently
    // disabling storage billing. Everything downstream (accrual, debit, wallet,
    // balance, budgets) stays micro-USD — the single nano→micro conversion
    // happens inside `sandbox_tick_cost_raw_micro`.
    //
    // Every rate below carries `default = "fn"`, NOT a bare `#[serde(default)]`.
    // The difference is only visible when a `[credits]` table is PRESENT and
    // omits the rate — which is the shape the published self-host doc hands
    // operators (`docs/gateway/configuration.mdx`, the `[credits]` sample lists
    // `enabled`/`base_url`/`internal_secret`/`markup_bps`/`wallet_empty_*`/
    // `timeout_ms` and no sandbox rate at all). An ABSENT `[credits]` table takes
    // `impl Default for CreditsConfig` and was always correct; a present one used
    // to deserialize all nine rates to 0, and a 0 rate is not "free", it is
    // billing turned OFF plus a missing safety stop:
    // `sandbox_tick_cost_raw_micro` returns 0 → `sandbox_debit_amount` returns 0
    // → `debit_sandbox_sync` short-circuits on `billed_micro == 0` and returns
    // `None` → `compute_verdict` sees `balance: None` and cannot reach
    // `KillBalance`, and `accrued` never grows so `KillBudget` is unreachable
    // too. A sandbox on a drained wallet runs until something else stops it.
    // (Core-spawned gateways were rescued incidentally because Core force-injects
    // all nine `GATEWAY_CREDITS_COST_PER_SANDBOX_*` envs at spawn; a hand-run
    // gateway following the doc got the zeros.)
    //
    // The default fns are the SINGLE source for these nine numbers —
    // `impl Default for CreditsConfig` calls them rather than repeating the
    // literals, so the serde path and the struct default cannot drift apart.
    /// vCPU rate, nano-USD per vCPU-second. Default: 14000 (0.014 micro/s).
    #[serde(default = "default_sandbox_vcpu_rate")]
    pub cost_per_sandbox_vcpu_second_nano_usd: u64,
    /// Memory rate, nano-USD per GiB-second. Default: 4500.
    #[serde(default = "default_sandbox_mem_rate")]
    pub cost_per_sandbox_mem_gib_second_nano_usd: u64,
    /// Storage rate, nano-USD per GiB-second (over the free tier). Default: 30.
    #[serde(default = "default_sandbox_storage_rate")]
    pub cost_per_sandbox_storage_gib_second_nano_usd: u64,
    /// GPU H200 rate, nano-USD per GPU-second. Default: 1261000.
    #[serde(default = "default_sandbox_gpu_h200_rate")]
    pub cost_per_sandbox_gpu_h200_second_nano_usd: u64,
    /// GPU H100 rate, nano-USD per GPU-second. Default: 1097000.
    #[serde(default = "default_sandbox_gpu_h100_rate")]
    pub cost_per_sandbox_gpu_h100_second_nano_usd: u64,
    /// GPU RTX PRO 6000 rate, nano-USD per GPU-second. Default: 842000.
    #[serde(default = "default_sandbox_gpu_rtx_pro_6000_rate")]
    pub cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd: u64,
    /// GPU RTX 5090 rate, nano-USD per GPU-second. Default: 358000.
    #[serde(default = "default_sandbox_gpu_rtx_5090_rate")]
    pub cost_per_sandbox_gpu_rtx_5090_second_nano_usd: u64,
    /// GPU RTX 4090 rate, nano-USD per GPU-second. Default: 275000.
    #[serde(default = "default_sandbox_gpu_rtx_4090_rate")]
    pub cost_per_sandbox_gpu_rtx_4090_second_nano_usd: u64,
    /// Windows surcharge, nano-USD per vCPU-second (added on top of the base
    /// vCPU rate for Windows workspaces). Default: 23800.
    #[serde(default = "default_sandbox_windows_vcpu_rate")]
    pub cost_per_sandbox_windows_vcpu_second_nano_usd: u64,
    /// Storage GiB that are free before the storage rate applies. Default: 5.
    #[serde(default = "default_sandbox_free_storage_gib")]
    pub sandbox_free_storage_gib: u64,
    /// Platform markup on metered sandbox usage in basis points. SEPARATE from
    /// the global `markup_bps` (which is pinned 0 for at-cost tokens/Composio);
    /// sandbox carries its own margin. Default: 3000 (× 1.30).
    #[serde(default = "default_sandbox_markup_bps")]
    pub sandbox_markup_bps: u64,
    /// Per-size Box rates (`GATEWAY_CREDITS_SANDBOX_SIZE_RATES`). **Default:
    /// the shared Box rates** ([`default_sandbox_size_rates`], small $0.025,
    /// default $0.04, large $0.07 per hour). A tick that names its Box `size`
    /// is priced at that size's hourly rate with no `sandbox_markup_bps` (the
    /// size rate is the customer price), billed in whole minutes with a
    /// five-minute minimum per start ([`box_billable_seconds`]); a tick without
    /// a size keeps the per-resource math. `"off"` (env or TOML) turns size
    /// pricing off, so Box ticks fall back to the per-resource math.
    #[serde(
        default = "default_sandbox_size_rates",
        deserialize_with = "deserialize_sandbox_size_rates"
    )]
    pub sandbox_size_rates: Option<SizeRates>,
    /// The Box service's Ed25519 public key for minimum waivers
    /// (`GATEWAY_BOX_MINIMUM_WAIVER_PUBLIC_KEY`: the 32-byte key in base64,
    /// as the Box service logs it from `RYU_BOX_MINIMUM_WAIVER_KEY`). A Box
    /// tick is priced without its five-minute minimum only when it carries a
    /// `minimum_waiver` this key verifies for the same Box, org and start.
    /// **Default: none**, so every start pays the minimum.
    #[serde(default)]
    pub box_minimum_waiver_public_key: Option<String>,
}

impl Default for CreditsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_control_plane_url(),
            internal_secret: None,
            markup_bps: 0,
            provider_billing: HashMap::new(),
            web_service_prices: std::collections::BTreeMap::new(),
            cost_per_tool_call_micro_usd: default_cost_per_tool_call_micro_usd(),
            cost_per_gpu_second_micro_usd: default_cost_per_gpu_second_micro_usd(),
            cost_per_image_micro_usd: default_cost_per_image_micro_usd(),
            cost_per_video_micro_usd: default_cost_per_video_micro_usd(),
            cost_per_tts_micro_usd: default_cost_per_tts_micro_usd(),
            cost_per_stt_micro_usd: default_cost_per_stt_micro_usd(),
            wallet_empty_action: WalletEmptyAction::default(),
            wallet_empty_downgrade_to: None,
            wallet_empty_alert: AlertTier::default(),
            reserve_enabled: default_true(),
            min_reserve_micro_usd: default_min_reserve_micro_usd(),
            timeout_ms: default_credits_timeout_ms(),
            fail_closed: true,
            top_up_url: default_credits_top_up_url(),
            // Delegated, not repeated: these must equal the serde `default = "…"`
            // fns on the same fields or an absent `[credits]` table and a present
            // one that omits the rates would bill differently.
            cost_per_sandbox_vcpu_second_nano_usd: default_sandbox_vcpu_rate(),
            cost_per_sandbox_mem_gib_second_nano_usd: default_sandbox_mem_rate(),
            cost_per_sandbox_storage_gib_second_nano_usd: default_sandbox_storage_rate(),
            cost_per_sandbox_gpu_h200_second_nano_usd: default_sandbox_gpu_h200_rate(),
            cost_per_sandbox_gpu_h100_second_nano_usd: default_sandbox_gpu_h100_rate(),
            cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd:
                default_sandbox_gpu_rtx_pro_6000_rate(),
            cost_per_sandbox_gpu_rtx_5090_second_nano_usd: default_sandbox_gpu_rtx_5090_rate(),
            cost_per_sandbox_gpu_rtx_4090_second_nano_usd: default_sandbox_gpu_rtx_4090_rate(),
            cost_per_sandbox_windows_vcpu_second_nano_usd: default_sandbox_windows_vcpu_rate(),
            sandbox_free_storage_gib: default_sandbox_free_storage_gib(),
            sandbox_markup_bps: default_sandbox_markup_bps(),
            sandbox_size_rates: default_sandbox_size_rates(),
            box_minimum_waiver_public_key: None,
        }
    }
}
