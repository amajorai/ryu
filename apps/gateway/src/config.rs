use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GatewayConfig {
    #[serde(default = "default_bind")]
    pub bind: String,

    #[serde(default)]
    pub providers: ProvidersConfig,

    #[serde(default)]
    pub routing: RoutingConfig,

    #[serde(default)]
    pub firewall: FirewallConfig,

    #[serde(default)]
    pub rate_limit: RateLimitConfig,

    #[serde(default)]
    pub auth: AuthConfig,

    #[serde(default)]
    pub cache: CacheConfig,

    #[serde(default)]
    pub circuit_breaker: CircuitBreakerConfig,

    #[serde(default)]
    pub concurrency: ConcurrencyConfig,

    #[serde(default)]
    pub skills: SkillsConfig,

    #[serde(default)]
    pub audit: AuditConfig,

    #[serde(default)]
    pub evals: EvalsConfig,

    #[serde(default)]
    pub composio: ComposioConfig,

    #[serde(default)]
    pub semantic_cache: SemanticCacheConfig,

    #[serde(default)]
    pub budgets: BudgetConfig,

    #[serde(default)]
    pub channels: ChannelsConfig,

    #[serde(default)]
    pub control_plane: ControlPlaneConfig,

    #[serde(default)]
    pub exec_budget: ExecBudgetConfig,

    #[serde(default)]
    pub compression: CompressionConfig,

    #[serde(default)]
    pub tools: ToolsConfig,

    #[serde(default)]
    pub widget: WidgetConfig,

    #[serde(default)]
    pub credits: CreditsConfig,

    /// Fleet mode (managed-cloud WS2). When true, this gateway is a publicly
    /// reachable multi-tenant replica sitting behind a co-located load balancer /
    /// reverse proxy, so external callers arrive over the loopback interface and
    /// appear to the process as `127.0.0.1`. Under fleet mode the admin gate
    /// (`/v1/config`, `/v1/audit`) DROPS loopback trust entirely — those
    /// endpoints require the master key even from a loopback peer, because
    /// "loopback" no longer implies "local operator". Off by default (loopback
    /// trust preserved for local dev); set via `RYU_GATEWAY_FLEET`. Nothing
    /// hardcoded.
    #[serde(default)]
    pub fleet: bool,
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
    /// Per-tool-call cost in micro-USD for billable (Composio) tool executions.
    /// Composio charges per action execution, so on the managed plan each
    /// executed `composio__*` tool call debits the org wallet by this amount
    /// (× the count of calls in the request), at cost — the same `debit_amount`
    /// markup that token usage uses. Default: 0 ⇒ tool calls are free until a
    /// deployment provisions a real rate (managed nodes set it via
    /// `GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD`). Builtin/MCP/app tools are
    /// never billed here — only Composio executions.
    #[serde(default)]
    pub cost_per_tool_call_micro_usd: u64,
    /// Per-call cost in micro-USD for a successful image generation. Cloud media
    /// providers (Replicate/Fal/OpenRouter) do not report a usage.cost the way
    /// chat does, so managed nodes meter media at a configured flat rate per
    /// call, debited through the same at-cost + markup path as tokens. Default: 0
    /// ⇒ media is free until a deployment provisions a rate
    /// (`GATEWAY_CREDITS_COST_PER_IMAGE_MICRO_USD`).
    #[serde(default)]
    pub cost_per_image_micro_usd: u64,
    /// Per-call cost in micro-USD for a successful video generation job.
    /// `GATEWAY_CREDITS_COST_PER_VIDEO_MICRO_USD`. Default: 0.
    #[serde(default)]
    pub cost_per_video_micro_usd: u64,
    /// Per-call cost in micro-USD for a successful TTS synthesis.
    /// `GATEWAY_CREDITS_COST_PER_TTS_MICRO_USD`. Default: 0.
    #[serde(default)]
    pub cost_per_tts_micro_usd: u64,
    /// Per-call cost in micro-USD for a successful STT transcription.
    /// `GATEWAY_CREDITS_COST_PER_STT_MICRO_USD`. Default: 0.
    #[serde(default)]
    pub cost_per_stt_micro_usd: u64,
    /// What the budget layer does when an org's wallet is empty: `stop` (default)
    /// aborts the next request; `downgrade` reroutes to `wallet_empty_downgrade_to`.
    #[serde(default)]
    pub wallet_empty_action: WalletEmptyAction,
    /// Model to downgrade to when `wallet_empty_action = downgrade`. When unset, a
    /// downgrade safely degrades to a restrict (mirrors the token-budget rule).
    #[serde(default)]
    pub wallet_empty_downgrade_to: Option<String>,
    /// Per-request timeout in milliseconds for the debit POST. Default: 3000.
    #[serde(default = "default_credits_timeout_ms")]
    pub timeout_ms: u64,
    /// Fail CLOSED on debit errors for managed tenants (env
    /// `GATEWAY_CREDITS_FAIL_CLOSED`). Default: false (preserves today's
    /// fail-open behavior). When true and the request is a managed-inference
    /// tenant, a debit transport error or non-2xx response flips that org's
    /// wallet-empty flag so the NEXT request is refused, instead of the failure
    /// being silently swallowed. The current in-flight response is never blocked
    /// on the (async) debit — the failure is just made sticky.
    #[serde(default)]
    pub fail_closed: bool,

    // ─── Sandbox per-resource rates (Daytona), nano-USD per unit-second ───────
    // Rates are stored in NANO-USD (not micro) because the Daytona storage rate
    // (0.03 micro-USD/GiB/s) truncates to 0 in a u64 micro-USD field, silently
    // disabling storage billing. Everything downstream (accrual, debit, wallet,
    // balance, budgets) stays micro-USD — the single nano→micro conversion
    // happens inside `sandbox_tick_cost_raw_micro`.
    /// vCPU rate, nano-USD per vCPU-second. Default: 14000 (0.014 micro/s).
    #[serde(default)]
    pub cost_per_sandbox_vcpu_second_nano_usd: u64,
    /// Memory rate, nano-USD per GiB-second. Default: 4500.
    #[serde(default)]
    pub cost_per_sandbox_mem_gib_second_nano_usd: u64,
    /// Storage rate, nano-USD per GiB-second (over the free tier). Default: 30.
    #[serde(default)]
    pub cost_per_sandbox_storage_gib_second_nano_usd: u64,
    /// GPU H200 rate, nano-USD per GPU-second. Default: 1261000.
    #[serde(default)]
    pub cost_per_sandbox_gpu_h200_second_nano_usd: u64,
    /// GPU H100 rate, nano-USD per GPU-second. Default: 1097000.
    #[serde(default)]
    pub cost_per_sandbox_gpu_h100_second_nano_usd: u64,
    /// GPU RTX PRO 6000 rate, nano-USD per GPU-second. Default: 842000.
    #[serde(default)]
    pub cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd: u64,
    /// GPU RTX 5090 rate, nano-USD per GPU-second. Default: 358000.
    #[serde(default)]
    pub cost_per_sandbox_gpu_rtx_5090_second_nano_usd: u64,
    /// GPU RTX 4090 rate, nano-USD per GPU-second. Default: 275000.
    #[serde(default)]
    pub cost_per_sandbox_gpu_rtx_4090_second_nano_usd: u64,
    /// Windows surcharge, nano-USD per vCPU-second (added on top of the base
    /// vCPU rate for Windows workspaces). Default: 23800.
    #[serde(default)]
    pub cost_per_sandbox_windows_vcpu_second_nano_usd: u64,
    /// Storage GiB that are free before the storage rate applies. Default: 5.
    #[serde(default = "default_sandbox_free_storage_gib")]
    pub sandbox_free_storage_gib: u64,
    /// Platform markup on metered sandbox usage in basis points. SEPARATE from
    /// the global `markup_bps` (which is pinned 0 for at-cost tokens/Composio);
    /// sandbox carries its own margin. Default: 3000 (× 1.30).
    #[serde(default = "default_sandbox_markup_bps")]
    pub sandbox_markup_bps: u64,
}

/// GPU tier for a sandbox workspace. Canonical definition (Core mirrors it).
/// Explicit per-variant serde renames (do NOT rely on `rename_all`, which
/// mishandles the digits in `rtx_5090`/`rtx_4090`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum GpuKind {
    #[serde(rename = "none")]
    None,
    #[serde(rename = "h200")]
    H200,
    #[serde(rename = "h100")]
    H100,
    #[serde(rename = "rtx_pro_6000")]
    RtxPro6000,
    #[serde(rename = "rtx_5090")]
    Rtx5090,
    #[serde(rename = "rtx_4090")]
    Rtx4090,
}

/// Operating system for a sandbox workspace. Canonical definition (Core mirrors
/// it). Windows carries a per-vCPU-second surcharge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum OsKind {
    #[serde(rename = "linux")]
    Linux,
    #[serde(rename = "windows")]
    Windows,
}

/// The budget action taken when an org's credit wallet is empty.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WalletEmptyAction {
    /// Abort the next request (`BudgetExceeded`). The default.
    #[default]
    Stop,
    /// Reroute to the configured cheaper model.
    Downgrade,
}

fn default_credits_timeout_ms() -> u64 {
    3000
}

fn default_sandbox_markup_bps() -> u64 {
    3000
}

fn default_sandbox_free_storage_gib() -> u64 {
    5
}

impl Default for CreditsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_control_plane_url(),
            internal_secret: None,
            markup_bps: 0,
            cost_per_tool_call_micro_usd: 0,
            cost_per_image_micro_usd: 0,
            cost_per_video_micro_usd: 0,
            cost_per_tts_micro_usd: 0,
            cost_per_stt_micro_usd: 0,
            wallet_empty_action: WalletEmptyAction::default(),
            wallet_empty_downgrade_to: None,
            timeout_ms: default_credits_timeout_ms(),
            fail_closed: false,
            cost_per_sandbox_vcpu_second_nano_usd: 14_000,
            cost_per_sandbox_mem_gib_second_nano_usd: 4_500,
            cost_per_sandbox_storage_gib_second_nano_usd: 30,
            cost_per_sandbox_gpu_h200_second_nano_usd: 1_261_000,
            cost_per_sandbox_gpu_h100_second_nano_usd: 1_097_000,
            cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd: 842_000,
            cost_per_sandbox_gpu_rtx_5090_second_nano_usd: 358_000,
            cost_per_sandbox_gpu_rtx_4090_second_nano_usd: 275_000,
            cost_per_sandbox_windows_vcpu_second_nano_usd: 23_800,
            sandbox_free_storage_gib: default_sandbox_free_storage_gib(),
            sandbox_markup_bps: default_sandbox_markup_bps(),
        }
    }
}

impl CreditsConfig {
    /// The amount to debit (micro-USD) for a call costing `cost_micro_usd`, after
    /// applying the platform markup. Round-half-up; saturating to avoid overflow.
    /// With `markup_bps == 0` this is the identity (pass-through at cost).
    pub fn debit_amount(&self, cost_micro_usd: u64) -> u64 {
        const BPS_DENOM: u64 = 10_000;
        cost_micro_usd
            .saturating_mul(BPS_DENOM.saturating_add(self.markup_bps))
            .saturating_add(BPS_DENOM / 2)
            / BPS_DENOM
    }

    /// The raw (pre-markup) cost in micro-USD for `n` billable tool calls. Pass
    /// the result through [`Self::debit_amount`] to apply the platform markup,
    /// exactly like token cost. Saturating to avoid overflow.
    pub fn tool_call_cost_micro_usd(&self, n: u64) -> u64 {
        self.cost_per_tool_call_micro_usd.saturating_mul(n)
    }

    /// The raw (pre-markup) flat cost in micro-USD for one successful media call
    /// of `modality`. Chat is never metered here (it uses real token/usage.cost);
    /// returns 0 for Chat and for any modality whose per-call rate is unset. Pass
    /// through [`Self::debit_amount`] to apply the platform markup, like tokens.
    pub fn media_cost_micro_usd(&self, modality: &Modality) -> u64 {
        match modality {
            Modality::Image => self.cost_per_image_micro_usd,
            Modality::Video => self.cost_per_video_micro_usd,
            Modality::Tts => self.cost_per_tts_micro_usd,
            Modality::Stt => self.cost_per_stt_micro_usd,
            Modality::Chat => 0,
        }
    }

    /// Whether the hook is active: enabled with both a control-plane URL and an
    /// internal secret. Without the secret the control plane rejects the debit,
    /// so treat it as disabled rather than emitting doomed calls.
    pub fn is_active(&self) -> bool {
        self.enabled && self.internal_secret.is_some() && !self.base_url.trim().is_empty()
    }

    /// Per-GPU-second rate in nano-USD for a GPU tier. `None` costs nothing.
    pub fn gpu_rate_nano(&self, gpu: GpuKind) -> u64 {
        match gpu {
            GpuKind::None => 0,
            GpuKind::H200 => self.cost_per_sandbox_gpu_h200_second_nano_usd,
            GpuKind::H100 => self.cost_per_sandbox_gpu_h100_second_nano_usd,
            GpuKind::RtxPro6000 => self.cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd,
            GpuKind::Rtx5090 => self.cost_per_sandbox_gpu_rtx_5090_second_nano_usd,
            GpuKind::Rtx4090 => self.cost_per_sandbox_gpu_rtx_4090_second_nano_usd,
        }
    }

    /// Raw (pre-markup) cost of one sandbox tick in MICRO-USD. Takes primitive
    /// args so this module does not depend on the metering route's `SandboxSpec`.
    /// Rates are summed in nano-USD per second, multiplied by `seconds`, then
    /// converted once to micro-USD (round-half-up). Storage is billed only above
    /// the free tier; a GPU count of 0 with a non-`None` tier bills as 1.
    pub fn sandbox_tick_cost_raw_micro(
        &self,
        vcpu: u32,
        mem_gib: u32,
        storage_gib: u32,
        gpu: GpuKind,
        gpu_count: u32,
        os: OsKind,
        seconds: u64,
    ) -> u64 {
        let vcpu = u64::from(vcpu);
        let billable_storage =
            u64::from(storage_gib).saturating_sub(self.sandbox_free_storage_gib);
        let eff_gpu = match gpu {
            GpuKind::None => 0,
            _ => u64::from(gpu_count.max(1)),
        };
        let per_sec_nano = vcpu
            .saturating_mul(self.cost_per_sandbox_vcpu_second_nano_usd)
            .saturating_add(
                u64::from(mem_gib).saturating_mul(self.cost_per_sandbox_mem_gib_second_nano_usd),
            )
            .saturating_add(
                billable_storage
                    .saturating_mul(self.cost_per_sandbox_storage_gib_second_nano_usd),
            )
            .saturating_add(eff_gpu.saturating_mul(self.gpu_rate_nano(gpu)))
            .saturating_add(match os {
                OsKind::Windows => {
                    vcpu.saturating_mul(self.cost_per_sandbox_windows_vcpu_second_nano_usd)
                }
                OsKind::Linux => 0,
            });
        let total_nano = per_sec_nano.saturating_mul(seconds);
        // nano -> micro, round half up.
        total_nano.saturating_add(500) / 1_000
    }

    /// The amount to debit (micro-USD) for a sandbox tick costing
    /// `cost_micro_usd`, after applying the sandbox markup. SEPARATE from
    /// [`Self::debit_amount`]: this uses `sandbox_markup_bps` (default 3000 ⇒
    /// × 1.30), not the global at-cost `markup_bps`. Round-half-up, saturating.
    pub fn sandbox_debit_amount(&self, cost_micro_usd: u64) -> u64 {
        const BPS_DENOM: u64 = 10_000;
        cost_micro_usd
            .saturating_mul(BPS_DENOM.saturating_add(self.sandbox_markup_bps))
            .saturating_add(BPS_DENOM / 2)
            / BPS_DENOM
    }
}

/// Unified search-based tool loop (#475, P2). The gateway injects a `tool_search`
/// meta-tool on the openai-compat chat plane and runs a buffered tool-call loop
/// against Core's unified tool catalog when the request carries the tool signal.
///
/// `enabled` defaults true: the no-signal fast path is preserved (plain chat
/// streams directly), so enabling it costs nothing until a request opts in via
/// `x-ryu-tools` / `x-ryu-tool-search`. Nothing hardcoded — every knob is a
/// swappable default.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ToolsConfig {
    /// Master switch for the unified tool loop. Default: true.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Tool definitions always injected (and always allowlisted) for every
    /// tool-active request. Default: empty. Each entry is an OpenAI tool def.
    #[serde(default)]
    pub always_on: Vec<serde_json::Value>,
    /// Maximum tool-call rounds before returning the last turn. Default: 6.
    #[serde(default = "default_tools_max_rounds")]
    pub max_rounds: u8,
    /// How many top search hits to describe + inject per `tool_search`. Default: 5.
    #[serde(default = "default_describe_top_n")]
    pub describe_top_n: usize,
    /// Named tool-policy profiles (presets) layered ABOVE the per-request
    /// `x-ryu-tools` allowlist, modeled on OpenClaw's profile layering
    /// (profile → allow/deny → sandbox, checked in that order). A request
    /// selects one by name via `x-ryu-tool-profile`; the gateway resolves it to
    /// an effective allowlist (see `effective_tool_allowlist`). Default: empty
    /// map ⇒ no profiles ⇒ the allowlist path is byte-for-byte unchanged. An
    /// unknown/typo'd profile name falls back to today's behavior, never deny-all.
    #[serde(default)]
    pub profiles: HashMap<String, ToolProfile>,
}

/// A named tool-policy profile (preset). Resolves to an allowlist that an
/// explicit per-request `x-ryu-tools` allow/deny still overrides.
///
/// Resolution (in `effective_tool_allowlist`): seed the allow set from `allow`
/// (or the wildcard `"*"` when `unrestricted`), union the explicit
/// `x-ryu-tools` CSV on top, then strip any id listed in `deny` (deny wins over
/// allow). `always_on` tools are appended last and are never deny-stripped.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct ToolProfile {
    /// Fully-qualified tool ids this profile grants. Ignored when `unrestricted`.
    #[serde(default)]
    pub allow: Vec<String>,
    /// Fully-qualified tool ids this profile denies. Deny wins over `allow` and
    /// over the per-request `x-ryu-tools` grant. Does not strip `always_on`.
    #[serde(default)]
    pub deny: Vec<String>,
    /// The "full"/unrestricted preset: resolves the allow set to the wildcard
    /// `"*"`, which `ToolLoopContext::is_allowed` treats as allow-any. Opt-in:
    /// only a request that explicitly selects this profile gets the wildcard.
    #[serde(default)]
    pub unrestricted: bool,
}

fn default_tools_max_rounds() -> u8 {
    6
}
fn default_describe_top_n() -> usize {
    5
}

impl Default for ToolsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            always_on: Vec::new(),
            max_rounds: default_tools_max_rounds(),
            describe_top_n: default_describe_top_n(),
            profiles: HashMap::new(),
        }
    }
}

/// Context compression (M2 / #425). When enabled, the gateway sends the request
/// messages to an external compression service (headroom's `/v1/compress`)
/// before the upstream provider call and swaps in the compressed result. This
/// is the egress transform that auto-wraps every gateway-routed agent. It fails
/// open: any error leaves the original messages untouched so chat never breaks
/// when the service is absent.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompressionConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Base URL of the compression service. Default: headroom proxy on :8787.
    #[serde(default = "default_compression_url")]
    pub url: String,
    /// Optional bearer token for the compression service.
    pub token: Option<String>,
    /// Per-request timeout in milliseconds. Default: 4000.
    #[serde(default = "default_compression_timeout_ms")]
    pub timeout_ms: u64,
    /// Only compress requests carrying at least this many messages; short
    /// single-turn prompts rarely benefit and add a round-trip. Default: 4.
    #[serde(default = "default_compression_min_messages")]
    pub min_messages: usize,
}

fn default_compression_url() -> String {
    "http://127.0.0.1:8787".to_string()
}
fn default_compression_timeout_ms() -> u64 {
    4000
}
fn default_compression_min_messages() -> usize {
    4
}

impl Default for CompressionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            url: default_compression_url(),
            token: None,
            timeout_ms: default_compression_timeout_ms(),
            min_messages: default_compression_min_messages(),
        }
    }
}

/// Connection to the control plane (M7 / U29). When enabled, the gateway
/// periodically pushes its eval/budget/audit snapshot up to the control plane
/// for aggregation, and reconciles shared budgets through the coordinator.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ControlPlaneConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Base URL of the control-plane API, e.g. `http://127.0.0.1:3000/api`.
    #[serde(default = "default_control_plane_url")]
    pub base_url: String,
    /// Gateway credential issued by the control plane (env: CONTROL_PLANE_KEY).
    /// Sent as the `X-Gateway-Key` header to authenticate and resolve the org.
    pub gateway_key: Option<String>,
    /// How often to push a report, in seconds. Default: 60.
    #[serde(default = "default_report_interval_secs")]
    pub report_interval_secs: u64,
    /// Maximum audit rows to push per report. Default: 200.
    #[serde(default = "default_report_audit_limit")]
    pub audit_limit: u32,
    /// Optional shared-budget id to reconcile through the coordinator. When set,
    /// the gateway reports its consumption and respects the shared cap.
    pub shared_budget_id: Option<String>,
    /// Estimated cost in micro-USD per 1000 tokens (input + output combined),
    /// used to attribute spend. Default: 2000 (= $0.002 / 1k tokens).
    #[serde(default = "default_cost_per_1k_micro_usd")]
    pub cost_per_1k_micro_usd: u64,

    /// Per-model price table (#9). Keyed by model id (exact, then longest-prefix
    /// match, e.g. `"claude-sonnet"`). When a model matches, spend is attributed
    /// with real input/output rates instead of the flat `cost_per_1k_micro_usd`.
    /// Empty (the default) keeps the flat estimate — nothing hardcoded, fully
    /// swappable per deployment.
    #[serde(default)]
    pub model_pricing: HashMap<String, ModelPrice>,
}

/// Real input/output pricing for one model, in micro-USD per 1000 tokens.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelPrice {
    /// micro-USD per 1000 input (prompt) tokens.
    pub input_per_1k_micro_usd: u64,
    /// micro-USD per 1000 output (completion) tokens.
    pub output_per_1k_micro_usd: u64,
}

impl ControlPlaneConfig {
    /// Estimated spend in micro-USD for one call. Uses the per-model price table
    /// when the model matches (exact, then longest-prefix), else the flat
    /// `cost_per_1k_micro_usd` fallback.
    pub fn cost_for(&self, model: &str, input: u64, output: u64) -> u64 {
        if let Some(p) = self.price_for_model(model) {
            let i = input.saturating_mul(p.input_per_1k_micro_usd) / 1000;
            let o = output.saturating_mul(p.output_per_1k_micro_usd) / 1000;
            return i.saturating_add(o);
        }
        (input.saturating_add(output)).saturating_mul(self.cost_per_1k_micro_usd) / 1000
    }

    /// Exact match first, then the longest matching prefix (so `"claude-sonnet"`
    /// covers `"claude-sonnet-4-5-20250929"`).
    fn price_for_model(&self, model: &str) -> Option<&ModelPrice> {
        if let Some(p) = self.model_pricing.get(model) {
            return Some(p);
        }
        let mut best: Option<(&String, &ModelPrice)> = None;
        for (k, v) in &self.model_pricing {
            if model.starts_with(k.as_str()) && best.map_or(true, |(bk, _)| k.len() > bk.len()) {
                best = Some((k, v));
            }
        }
        best.map(|(_, v)| v)
    }
}

fn default_control_plane_url() -> String {
    "http://127.0.0.1:3000/api".to_string()
}
fn default_report_interval_secs() -> u64 {
    60
}
fn default_report_audit_limit() -> u32 {
    200
}
fn default_cost_per_1k_micro_usd() -> u64 {
    2000
}

impl Default for ControlPlaneConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            base_url: default_control_plane_url(),
            gateway_key: None,
            report_interval_secs: default_report_interval_secs(),
            audit_limit: default_report_audit_limit(),
            shared_budget_id: None,
            cost_per_1k_micro_usd: default_cost_per_1k_micro_usd(),
            model_pricing: HashMap::new(),
        }
    }
}

fn default_bind() -> String {
    "0.0.0.0:7981".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ProvidersConfig {
    pub openai: Option<OpenAiProviderConfig>,
    pub anthropic: Option<AnthropicProviderConfig>,
    pub local: Option<LocalProviderConfig>,
    pub openrouter: Option<OpenRouterProviderConfig>,
    pub core: Option<CoreProviderConfig>,
    pub modal: Option<ModalProviderConfig>,
    pub genai: Option<GenAiProviderConfig>,
    /// Replicate (https://replicate.com) — cloud image/video generation via an
    /// async prediction API (create → poll → output URL). Opt-in: constructed
    /// only when an API key is present.
    pub replicate: Option<ReplicateProviderConfig>,
    /// Fal (https://fal.ai) — cloud image/video/audio generation via a queued
    /// request API (submit → poll status → result). Opt-in.
    pub fal: Option<FalProviderConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpenAiProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4, multi-account). When a
    /// key hits an upstream 429 the provider rotates to the next before failing
    /// over to the cost-tier chain. Empty → single-account (uses `api_key`).
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "openai_base_url")]
    pub base_url: String,
}

impl OpenAiProviderConfig {
    /// The full account rotation set: the extra `api_keys` when present, else the
    /// single `api_key`. Empty strings are dropped.
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

fn openai_base_url() -> String {
    "https://api.openai.com/v1".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AnthropicProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "anthropic_base_url")]
    pub base_url: String,
}

impl AnthropicProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

fn anthropic_base_url() -> String {
    "https://api.anthropic.com".to_string()
}

/// Merge a primary key + an optional extra-accounts list into the rotation set,
/// preferring the explicit list and always including the primary. Blank entries
/// are dropped so a stray empty string never becomes a "key". Falls back to a
/// single empty string only if nothing is configured (keeps the provider
/// constructible; the upstream call then fails auth as before).
fn all_provider_keys(primary: &str, extra: &[String]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    if !primary.is_empty() {
        keys.push(primary.to_string());
    }
    for k in extra {
        if !k.is_empty() && !keys.contains(k) {
            keys.push(k.clone());
        }
    }
    if keys.is_empty() {
        keys.push(String::new());
    }
    keys
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LocalProviderConfig {
    #[serde(default = "local_base_url")]
    pub base_url: String,
}

fn local_base_url() -> String {
    "http://127.0.0.1:11434/v1".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpenRouterProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "openrouter_base_url")]
    pub base_url: String,
    #[serde(default = "openrouter_site_url")]
    pub site_url: String,
    #[serde(default = "openrouter_site_name")]
    pub site_name: String,
    /// `provider.data_collection` policy sent on every request: "deny" uses only
    /// providers that do not retain/train on prompts, "allow" permits them.
    /// Empty (the default) omits the field entirely, leaving OpenRouter's own
    /// default and — crucially — NOT overriding a BYOK caller's own routing
    /// intent. Managed Ryu Cloud nodes set this to "deny" for privacy-by-default
    /// (via `OPENROUTER_DATA_COLLECTION`, wired in Core's gateway spawn env).
    #[serde(default = "openrouter_data_collection")]
    pub data_collection: String,
    /// Require zero-data-retention endpoints (`provider.zdr`). Default off.
    #[serde(default)]
    pub zdr: bool,
    /// Provider sort preference: "price" | "throughput" | "latency". Empty → omit.
    #[serde(default)]
    pub sort: String,
    /// Add the `response-healing` plugin (repairs malformed JSON). Default off
    /// until its billing is confirmed.
    #[serde(default)]
    pub response_healing: bool,
    /// Send the legacy `usage: {include: true}` flag. Current OpenRouter always
    /// returns `usage.cost` (read by `response_cost_micro_usd` for at-cost credit
    /// metering), so this only helps older or OpenRouter-compatible endpoints.
    /// Default on for compatibility; harmless no-op on modern OpenRouter.
    #[serde(default = "default_true")]
    pub usage_accounting: bool,
    /// Reserved: per-org OpenRouter sub-keys minted via the management-key API
    /// (`/api/v1/keys`) so per-tenant spend is capped and attributed at
    /// OpenRouter. Empty today (single shared account key); the per-request key
    /// selection through the pipeline is the follow-up to the provisioning loop.
    #[serde(default)]
    pub org_api_keys: std::collections::HashMap<String, String>,
}

impl OpenRouterProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

fn openrouter_base_url() -> String {
    "https://openrouter.ai/api/v1".to_string()
}
fn openrouter_site_url() -> String {
    "https://github.com/ryuhq/ryu".to_string()
}
fn openrouter_site_name() -> String {
    "ryu-gateway".to_string()
}
fn openrouter_data_collection() -> String {
    // Empty → the `provider.data_collection` field is omitted, so out-of-the-box
    // behaviour is unchanged and a BYOK caller's own routing is never overridden.
    // Managed nodes opt in to "deny" via env.
    String::new()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CoreProviderConfig {
    #[serde(default = "core_base_url")]
    pub base_url: String,
    pub token: Option<String>,
}

fn core_base_url() -> String {
    "http://127.0.0.1:2049".to_string()
}

/// Modal (https://modal.com) — serverless GPU compute. A Ryu Cloud GPU node
/// deploys an OpenAI-compatible inference app (e.g. vLLM) on Modal and points
/// the gateway at it, so heavy local-model inference bursts onto Modal's GPUs
/// (pay-per-second, scale-to-zero) while the always-on orchestration node stays
/// on cheap CPU. Wire-compatible with OpenAI, so the provider is a thin bearer
/// client. There is NO universal default URL — every Modal deployment has its
/// own `*.modal.run` endpoint — so `base_url` is required, and the provider is
/// only constructed when both it and the token are configured (opt-in).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModalProviderConfig {
    /// The Modal proxy-auth token (sent as a bearer). Modal apps gate access
    /// with a token; never hardcoded.
    pub api_key: String,
    /// The deployed Modal app's OpenAI-compatible base URL (its `*.modal.run`
    /// `/v1` endpoint). Required — no sensible default exists.
    pub base_url: String,
}

/// `genai` multi-provider backend. Covers the *native-format* providers the
/// gateway does not implement by hand (primarily Gemini), so they can be added
/// by config rather than by writing a bespoke translator per provider. The
/// OpenAI-compatible ecosystem is still served by the byte-passthrough
/// providers (OpenAI, OpenRouter); this is for the native-protocol long tail.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct GenAiProviderConfig {
    /// API keys keyed by the lowercase `genai` adapter kind, e.g. `"gemini"`,
    /// `"groq"`, `"xai"`, `"deepseek"`, `"cohere"`. Looked up per request by the
    /// resolved provider. If a kind has no key here, `genai` falls back to its
    /// own default (env-var) auth for that provider.
    #[serde(default)]
    pub keys: std::collections::HashMap<String, String>,
}

/// Replicate (https://replicate.com) — cloud generative media over an async
/// prediction API. A request creates a prediction (`POST /predictions` with a
/// versioned model or `POST /models/{owner}/{name}/predictions`), then the
/// gateway polls the returned prediction until it reaches a terminal state and
/// exposes the `output` (usually a URL, or list of URLs). Image gen blocks and
/// polls inline (fast enough); video gen submits a job the client polls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReplicateProviderConfig {
    /// Replicate API token (sent as `Authorization: Bearer <token>`).
    pub api_key: String,
    #[serde(default = "replicate_base_url")]
    pub base_url: String,
    /// Poll interval in milliseconds while a prediction is running. Default: 1500.
    #[serde(default = "default_media_poll_interval_ms")]
    pub poll_interval_ms: u64,
    /// Max seconds to block-and-poll an inline (image) prediction before giving
    /// up. Video never blocks this long — it returns a job id. Default: 120.
    #[serde(default = "default_media_poll_timeout_secs")]
    pub poll_timeout_secs: u64,
}

fn replicate_base_url() -> String {
    "https://api.replicate.com/v1".to_string()
}

/// Fal (https://fal.ai) — cloud generative media over a queued request API. A
/// request submits to `https://queue.fal.run/{model}` and receives a
/// `request_id` + status/response URLs; the gateway polls the status URL until
/// `COMPLETED`, then fetches the response. Image gen blocks and polls inline;
/// video gen submits a job the client polls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FalProviderConfig {
    /// Fal API key (sent as `Authorization: Key <key>`).
    pub api_key: String,
    /// Queue base URL (model id is appended per request). Default:
    /// `https://queue.fal.run`.
    #[serde(default = "fal_base_url")]
    pub base_url: String,
    /// Poll interval in milliseconds while a request is queued/in-progress.
    #[serde(default = "default_media_poll_interval_ms")]
    pub poll_interval_ms: u64,
    /// Max seconds to block-and-poll an inline (image) request. Default: 120.
    #[serde(default = "default_media_poll_timeout_secs")]
    pub poll_timeout_secs: u64,
}

fn fal_base_url() -> String {
    "https://queue.fal.run".to_string()
}

fn default_media_poll_interval_ms() -> u64 {
    1500
}
fn default_media_poll_timeout_secs() -> u64 {
    120
}

/// The modality of a request. The router uses this to pick a provider that
/// supports the requested capability, so an agent's chat, image-gen, TTS, and
/// STT calls can each go to different providers.
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    /// Text chat completion (default).
    #[default]
    Chat,
    /// Image generation.
    Image,
    /// Text-to-speech synthesis.
    Tts,
    /// Speech-to-text transcription.
    Stt,
    /// Video generation. Unlike the other modalities this is job-based: a submit
    /// creates a job the client polls, because cloud video runs for minutes.
    Video,
}

impl Modality {
    pub fn as_str(&self) -> &'static str {
        match self {
            Modality::Chat => "chat",
            Modality::Image => "image",
            Modality::Tts => "tts",
            Modality::Stt => "stt",
            Modality::Video => "video",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct RoutingConfig {
    #[serde(default)]
    pub default_provider: ProviderKind,

    /// Static model → provider mappings (e.g. "claude-3-5-sonnet" → anthropic)
    #[serde(default)]
    pub model_map: HashMap<String, ModelMapping>,

    /// Fallback chain when the primary provider is unavailable
    #[serde(default)]
    pub fallback_chain: Vec<ProviderKind>,

    /// Cost-tier ordering for the fallback chain (#2). Lower = preferred:
    /// subscription (0) → cheap (1) → free (2). After the primary provider, the
    /// chain is stably sorted by tier so a rate-limited/failed primary demotes
    /// down the cost ladder instead of round-robining at random. Absent entries
    /// default to tier 0. Empty map (the default) preserves the flat
    /// `fallback_chain` order exactly — nothing hardcoded.
    #[serde(default)]
    pub provider_tiers: HashMap<ProviderKind, u8>,

    /// Eval-driven (A/B) routing. When enabled, requests are split across a set
    /// of candidate providers and the winner is biased toward whichever candidate
    /// has the better rolling eval score (see `apps/gateway/src/evals`).
    #[serde(default)]
    pub eval_routing: EvalRoutingConfig,

    /// Modality-to-provider mappings. When a request carries a modality other
    /// than `chat`, the router looks here first before falling back to the
    /// model_map / default_provider logic. All entries are swappable; there are
    /// no hardcoded defaults so zero configuration works (every modality falls
    /// back to the default_provider).
    #[serde(default)]
    pub modality_map: HashMap<Modality, ModalityMapping>,

    /// Smart (classifier-driven) routing. When enabled, a cheap "router" model
    /// classifies each chat request against a set of natural-language rules and
    /// the request is re-routed to the matching rule's target model BEFORE the
    /// normal model→provider routing runs. Off by default; fully swappable.
    #[serde(default)]
    pub smart_routing: SmartRoutingConfig,
}

/// Classifier-driven model routing ("custom routing instructions").
///
/// The user writes plain-language rules — e.g. *"coding or debugging questions →
/// claude-sonnet-4-5"*, *"simple chit-chat → a local model"* — and picks a cheap
/// `classifier_model` to do the sorting. On each chat request the gateway asks
/// the classifier which rule (if any) matches the user's latest message, then
/// rewrites the request's model to that rule's target. The rewritten model then
/// flows through the ordinary [`crate::router::ModelRouter`] so the target's
/// provider is resolved exactly as a hand-picked model would be — nothing about
/// providers is hardcoded here.
///
/// Everything fails open: an empty `classifier_model`, no rules, a classifier
/// error, or a timeout all leave the originally requested model untouched, so a
/// misconfiguration can never break chat. This is a Gateway concern (it decides
/// *what is allowed / where a call goes*), not Core.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SmartRoutingConfig {
    /// Master switch. Default: false (the classifier call adds a round-trip to
    /// every request, so it is strictly opt-in).
    #[serde(default)]
    pub enabled: bool,

    /// The cheap model used to classify each request. Resolved to a provider via
    /// the normal model router, so it can be a local model (e.g. `"gemma-…"`), a
    /// hosted mini model, or an `openrouter/…` slug. Empty ⇒ smart routing is
    /// inert (fail-open). Nothing hardcoded.
    #[serde(default)]
    pub classifier_model: String,

    /// Ordered natural-language rules. The classifier returns the index of the
    /// first matching rule; the request is then re-routed to that rule's `model`.
    #[serde(default)]
    pub rules: Vec<SmartRule>,

    /// Model to route to when the classifier matches no rule. `None`/empty ⇒
    /// keep the originally requested model (the fail-open default).
    #[serde(default)]
    pub default_model: Option<String>,

    /// Classify once per Core session (`x-ryu-session-id`) and reuse the decision
    /// for that session's later turns. Avoids a per-turn classifier call and
    /// mid-conversation model flapping. Default: true.
    #[serde(default = "default_true")]
    pub cache_by_session: bool,

    /// Per-classification timeout in milliseconds. On timeout the request keeps
    /// its original model. Default: 4000.
    #[serde(default = "default_smart_routing_timeout_ms")]
    pub timeout_ms: u64,
}

fn default_smart_routing_timeout_ms() -> u64 {
    4000
}

impl Default for SmartRoutingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            classifier_model: String::new(),
            rules: Vec::new(),
            default_model: None,
            cache_by_session: true,
            timeout_ms: default_smart_routing_timeout_ms(),
        }
    }
}

impl SmartRoutingConfig {
    /// Whether smart routing should actually run: enabled, with a classifier
    /// model and at least one rule. Anything short of this is a no-op (fail-open).
    pub fn is_active(&self) -> bool {
        self.enabled && !self.classifier_model.trim().is_empty() && !self.rules.is_empty()
    }
}

/// A single smart-routing rule: a natural-language condition plus the model to
/// route matching requests to.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SmartRule {
    /// Plain-language condition, e.g. `"writing or refactoring code"`.
    pub description: String,
    /// Target model id for matching requests, resolved via the model router
    /// (e.g. `"claude-sonnet-4-5"`, `"gpt-4o-mini"`, `"openrouter/google/gemini-2.5-flash"`).
    pub model: String,
}

/// A single modality-to-provider mapping entry. The `provider` field names
/// which backend handles this modality; the optional `model` field lets you
/// pin a specific model id (e.g. `"dall-e-3"` for image-gen) without changing
/// the provider config.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModalityMapping {
    pub provider: ProviderKind,
    /// Model id to send to the provider. When absent the caller's `model`
    /// field is forwarded unchanged.
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EvalRoutingConfig {
    /// When true, eligible requests are routed by eval score across `candidates`.
    #[serde(default)]
    pub enabled: bool,

    /// Candidate providers to split traffic across. The router compares their
    /// rolling eval scores and sends most traffic to the leader, reserving
    /// `explore_ratio` for the others so scores stay fresh.
    #[serde(default)]
    pub candidates: Vec<ProviderKind>,

    /// Fraction of eligible traffic reserved for exploration (non-leader
    /// candidates), in `[0.0, 1.0]`. Default: 0.2.
    #[serde(default = "default_explore_ratio")]
    pub explore_ratio: f32,
}

fn default_explore_ratio() -> f32 {
    0.2
}

impl Default for EvalRoutingConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            candidates: Vec::new(),
            explore_ratio: default_explore_ratio(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModelMapping {
    pub provider: ProviderKind,
    /// If set, rewrite the model name before forwarding (e.g. "gpt-4" → "gpt-4o")
    pub provider_model: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    #[default]
    OpenAi,
    Anthropic,
    Local,
    OpenRouter,
    Core,
    Modal,
    GenAi,
    Replicate,
    Fal,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "openai",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Local => "local",
            ProviderKind::OpenRouter => "openrouter",
            ProviderKind::Core => "core",
            ProviderKind::Modal => "modal",
            ProviderKind::GenAi => "genai",
            ProviderKind::Replicate => "replicate",
            ProviderKind::Fal => "fal",
        }
    }
}

impl std::str::FromStr for ProviderKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "openai" => Ok(ProviderKind::OpenAi),
            "anthropic" => Ok(ProviderKind::Anthropic),
            "local" => Ok(ProviderKind::Local),
            "openrouter" => Ok(ProviderKind::OpenRouter),
            "core" => Ok(ProviderKind::Core),
            "modal" => Ok(ProviderKind::Modal),
            "genai" => Ok(ProviderKind::GenAi),
            "replicate" => Ok(ProviderKind::Replicate),
            "fal" => Ok(ProviderKind::Fal),
            other => Err(format!("unknown provider kind: {other}")),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FirewallConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,

    #[serde(default = "default_true")]
    pub scan_inbound: bool,

    #[serde(default = "default_true")]
    pub scan_outbound: bool,

    /// Action when a violation is detected
    #[serde(default)]
    pub policy: FirewallPolicy,

    #[serde(default = "default_true")]
    pub log_detections: bool,

    /// Whether PII patterns (email, phone, SSN, credit card, etc.) are redacted
    /// when policy = Sanitize. Defaults to true; set to false to suppress PII
    /// redaction while still redacting secrets.
    #[serde(default = "default_true")]
    pub redact_pii: bool,

    /// Whether secret patterns (API keys, tokens, PEM keys, connection strings)
    /// are redacted when policy = Sanitize. Defaults to true.
    #[serde(default = "default_true")]
    pub redact_secrets: bool,

    /// Whether external tool RESULTS re-entering the model on the openai-compat
    /// tool loop are wrapped in untrusted-content boundary markers and stripped
    /// of LLM chat-template control tokens (injection defense). Defaults to true;
    /// it only affects untrusted tool output (never user text), so it is safe to
    /// keep on. Set to false to disable the wrapping.
    #[serde(default = "default_true")]
    pub wrap_untrusted_tool_results: bool,

    /// User-defined firewall patterns, merged on top of the curated built-in
    /// PII/secret/injection sets when the scanner is (re)built. Each entry is a
    /// regex tagged with the category it belongs to; invalid regexes are skipped
    /// with a warning rather than failing the whole config (fail-open on the
    /// *pattern*, never on the firewall). Empty by default so existing configs
    /// keep the built-in-only behaviour.
    #[serde(default)]
    pub custom_patterns: Vec<CustomPattern>,
}

/// The category a [`CustomPattern`] belongs to. Determines which built-in
/// pattern set it is merged into, and therefore which toggles govern it:
/// `Pii`/`Secret` follow `redact_pii`/`redact_secrets` under the Sanitize
/// policy, and `PromptInjection` participates in inbound injection scanning.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CustomPatternKind {
    #[default]
    Pii,
    Secret,
    PromptInjection,
}

/// A single user-defined firewall pattern.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct CustomPattern {
    /// Human-readable label; also used as the placeholder marker on redaction
    /// (e.g. a `name` of `internal_id` redacts to `[REDACTED:INTERNAL_ID]`).
    pub name: String,
    /// The regular expression, in the `regex` crate's syntax. The crate is
    /// backtracking-free, so caller-supplied patterns cannot cause catastrophic
    /// (ReDoS) blow-up.
    pub regex: String,
    /// Which built-in category this pattern is merged into.
    #[serde(default)]
    pub kind: CustomPatternKind,
}

impl Default for FirewallConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            scan_inbound: true,
            scan_outbound: true,
            policy: FirewallPolicy::default(),
            log_detections: true,
            redact_pii: true,
            redact_secrets: true,
            wrap_untrusted_tool_results: true,
            custom_patterns: Vec::new(),
        }
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FirewallPolicy {
    /// Reject the request with a 403
    Block,
    /// Log the detection but allow the request through
    #[default]
    WarnAndContinue,
    /// Replace detected patterns with placeholder text
    Sanitize,
}

impl FirewallPolicy {
    /// Parse a firewall policy from an environment-variable value. Accepts the
    /// snake_case names plus a couple of friendly aliases. Returns `None` for
    /// an unrecognised value so the caller can keep the existing config.
    fn from_env(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "block" => Some(Self::Block),
            "warn_and_continue" | "warn" | "warn-and-continue" => Some(Self::WarnAndContinue),
            "sanitize" | "redact" => Some(Self::Sanitize),
            _ => None,
        }
    }
}

/// Parse a boolean-ish environment-variable value. Returns `None` for an
/// unrecognised value so the caller can keep the existing config.
fn parse_bool_env(raw: &str) -> Option<bool> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// Read a boolean flag from the environment, falling back to `default` when the
/// variable is unset or holds an unrecognised value.
fn env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .and_then(|v| parse_bool_env(&v))
        .unwrap_or(default)
}

/// Parse a comma-separated env var into a list of API keys for multi-account
/// rotation (#4), e.g. `OPENAI_API_KEYS=sk-a,sk-b,sk-c`. Blank entries dropped;
/// unset → empty (single-account, uses the scalar `*_API_KEY`).
fn env_keys(name: &str) -> Vec<String> {
    std::env::var(name)
        .ok()
        .map(|v| {
            v.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RateLimitConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Token-based limit per minute per API key (approximate).
    pub tokens_per_minute: Option<u64>,

    /// Request count limit per minute per API key.
    pub requests_per_minute: Option<u64>,

    /// Maximum requests per second per key before bot-detection triggers (0 = disabled).
    #[serde(default = "default_burst_rps")]
    pub max_burst_per_second: u32,
}

fn default_burst_rps() -> u32 {
    10
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            tokens_per_minute: Some(100_000),
            requests_per_minute: Some(500),
            max_burst_per_second: default_burst_rps(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct AuthConfig {
    /// When false, all requests are accepted regardless of API key
    #[serde(default)]
    pub require_auth: bool,

    /// Statically configured API keys
    #[serde(default)]
    pub api_keys: Vec<ApiKeyConfig>,

    /// A single master key that bypasses all per-key limits
    pub master_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ApiKeyConfig {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Override the global requests_per_minute limit for this key.
    #[serde(default)]
    pub requests_per_minute: Option<u64>,
    /// Override the global tokens_per_minute limit for this key.
    #[serde(default)]
    pub tokens_per_minute: Option<u64>,
    /// Lifetime token cap for this key (input + output combined). 0 = unlimited.
    #[serde(default)]
    pub token_budget_total: Option<u64>,
    /// Model to downgrade to when token_budget_total is exceeded.
    /// If unset, the request is rejected with BudgetExceeded.
    #[serde(default)]
    pub downgrade_to: Option<String>,
    /// When true, this key is a trusted intermediary (e.g. Ryu Core relaying a
    /// real end-user identity) and the client-supplied `x-ryu-user-id` /
    /// `x-ryu-agent-id` headers are honored for per-user/per-agent budgets.
    /// When false (the default), those headers are ignored and budgets are
    /// keyed to this API key, so an untrusted caller cannot spoof or rotate
    /// identity headers to evade its quota.
    #[serde(default)]
    pub trusted_forwarder: bool,
}

/// What the gateway does when a per-user or per-agent budget is exhausted.
///
/// These are the four data-plane actions a budget can trigger (U21). They are
/// enforced inline, on the request path, using local counters — no cross-user
/// or team coordination (that is control-plane, U29).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum BudgetAction {
    /// Allow the request through but flag it (observable via response headers
    /// and metrics) so the client can surface a warning. Never blocks.
    #[default]
    Notify,
    /// Swap the requested model for the rule's `downgrade_to` (a cheaper model)
    /// and continue. Falls back to `Restrict` if no downgrade model is set.
    Downgrade,
    /// Allow the request but clamp it: strip tool definitions and cap
    /// `max_tokens` so an over-budget caller can still get a minimal answer.
    Restrict,
    /// Reject the request with `402 budget_exceeded`. The hard stop.
    Stop,
}

/// A single budget rule: a token cap plus the action taken once it is reached.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BudgetRule {
    /// Lifetime token cap (input + output combined) for this scope. 0 = unlimited.
    pub limit: u64,
    /// Action to take once `limit` is reached. Defaults to `notify`.
    #[serde(default)]
    pub action: BudgetAction,
    /// Model to route to when `action = downgrade`. Required for downgrade to
    /// take effect; otherwise the rule degrades to `restrict`.
    #[serde(default)]
    pub downgrade_to: Option<String>,
    /// Cap applied to `max_tokens` when `action = restrict`. Defaults to 256.
    #[serde(default = "default_restrict_max_tokens")]
    pub restrict_max_tokens: u64,
}

fn default_restrict_max_tokens() -> u64 {
    256
}

/// Per-user and per-agent token budgets (data plane, local counters).
///
/// Keyed by the identity Core forwards on the request: `x-ryu-user-id` and
/// `x-ryu-agent-id`. A request can match both a user budget and an agent
/// budget; both are evaluated and the most restrictive triggered action wins
/// (`stop` > `downgrade`/`restrict` > `notify`).
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct BudgetConfig {
    /// Per-user budgets, keyed by user id.
    #[serde(default)]
    pub users: HashMap<String, BudgetRule>,
    /// Per-agent budgets, keyed by agent id.
    #[serde(default)]
    pub agents: HashMap<String, BudgetRule>,
    /// A single global per-session token cap (#510). Unlike `users`/`agents`,
    /// this is NOT a map: session ids are ephemeral (Core mints a fresh
    /// conversation id per chat), so a per-session-id rule map would be dead
    /// config nobody could populate. Instead one rule applies to every session,
    /// with the running counter keyed by the `x-ryu-session-id` header.
    #[serde(default)]
    pub session: SessionBudgetConfig,
}

/// Global per-session token budget (#510). One rule that applies to every
/// session; the running counter is keyed by session id at request time.
///
/// Mirrors [`BudgetRule`]'s shape (a token cap plus an action) so the existing
/// `decide`/`enforce_budget` machinery enforces it identically — `stop` rejects,
/// `downgrade` swaps the model, `restrict` clamps, `notify` only flags.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SessionBudgetConfig {
    /// Lifetime token cap (input + output combined) for any single session.
    /// 0 = unlimited (the feature is off).
    #[serde(default)]
    pub limit: u64,
    /// Action to take once a session reaches `limit`. Defaults to `notify`.
    #[serde(default)]
    pub action: BudgetAction,
    /// Model to route to when `action = downgrade`. Required for downgrade to
    /// take effect; otherwise the rule degrades to `restrict`.
    #[serde(default)]
    pub downgrade_to: Option<String>,
    /// Cap applied to `max_tokens` when `action = restrict`. Defaults to 256.
    #[serde(default = "default_restrict_max_tokens")]
    pub restrict_max_tokens: u64,
}

impl Default for SessionBudgetConfig {
    fn default() -> Self {
        Self {
            limit: 0,
            action: BudgetAction::default(),
            downgrade_to: None,
            restrict_max_tokens: default_restrict_max_tokens(),
        }
    }
}

/// Exec (sandbox) budget config: count and/or wall-clock per rolling window.
///
/// Unlike the token budget (lifetime, model-call shaped), exec budgets apply
/// to non-model executions: sandbox runs, MCP tool invocations, and any
/// event posted to `POST /v1/exec/audit`. Limits reset at each window boundary.
///
/// Both `max_count` and `max_wall_clock_secs` can be configured independently;
/// when both are set, whichever is exhausted first triggers the deny. 0 = no
/// limit for that dimension.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExecBudgetConfig {
    /// Maximum number of sandbox/tool executions per `window_secs`. 0 = unlimited.
    #[serde(default = "default_exec_max_count")]
    pub max_count: u64,
    /// Maximum total wall-clock seconds of sandbox execution per `window_secs`. 0 = unlimited.
    #[serde(default)]
    pub max_wall_clock_secs: u64,
    /// Rolling window size in seconds. Default: 3600 (one hour).
    #[serde(default = "default_exec_window_secs")]
    pub window_secs: u64,
    /// Action when the exec budget is exhausted. Only `stop` (deny) is meaningful
    /// here — exec events do not support model downgrade or token restriction.
    #[serde(default)]
    pub action: ExecBudgetAction,
}

fn default_exec_max_count() -> u64 {
    0 // unlimited by default
}
fn default_exec_window_secs() -> u64 {
    3600
}

/// What the gateway does when the exec budget is exhausted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ExecBudgetAction {
    /// Allow the execution (log but do not block). Default.
    #[default]
    Notify,
    /// Deny the execution with 429 budget_exceeded.
    Stop,
}

impl Default for ExecBudgetConfig {
    fn default() -> Self {
        Self {
            max_count: default_exec_max_count(),
            max_wall_clock_secs: 0,
            window_secs: default_exec_window_secs(),
            action: ExecBudgetAction::default(),
        }
    }
}

/// Widget (Ryu Apps) governance config (§4.3). Governs the interactive widget
/// tool calls and follow-up messages that a rendered app iframe makes back
/// through the host — the traffic that arrives at the gateway carrying the
/// `widget: { instance_id, origin_server }` exec envelope.
///
/// The gateway owns rate/scan governance for these round-trips (D5: `exec_tool`
/// runs scan → budget → forward → audit for a widget `callTool`). The token
/// buckets are per-`instance_id` so one rendered widget cannot exhaust another's
/// budget. `max_concurrent_widget_instances_per_session` is declared here as the
/// single swappable knob (nothing hardcoded) but is enforced in Core at mint
/// time (D4, `WidgetInstanceStore::mint`), not on this request path.
///
/// Everything is a swappable default; the whole section can be disabled with
/// `enabled = false`, which makes the widget branch a bare governed forward.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WidgetConfig {
    /// Master switch for widget-specific governance. Default: true. When false,
    /// widget calls still forward (governed by the base exec gate) but skip the
    /// per-instance rate/scan layer.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Max widget `callTool`s per rolling minute, per widget instance. 0 =
    /// unlimited. Default: 60.
    #[serde(default = "default_widget_max_calls_per_min")]
    pub max_calls_per_min: u32,
    /// Max `sendFollowUpMessage`s per rolling minute, per widget instance
    /// (stricter than `callTool`). 0 = unlimited. Default: 6.
    #[serde(default = "default_widget_max_followups_per_min")]
    pub max_followups_per_min: u32,
    /// Max concurrently live widget instances per session. Declared here as the
    /// governance knob; enforced by Core at mint time (D4), not on this path.
    /// Default: 8.
    #[serde(default = "default_widget_max_concurrent_instances_per_session")]
    pub max_concurrent_widget_instances_per_session: u32,
    /// Scan widget `callTool` arguments through the firewall (PII/secret/
    /// injection) before forwarding. Default: true.
    #[serde(default = "default_true")]
    pub scan_arguments: bool,
    /// Scan `sendFollowUpMessage` prompts before they enter model context.
    /// Default: true.
    #[serde(default = "default_true")]
    pub scan_followups: bool,
    /// Require the widget manifest to carry the `chat.sendFollowUp` grant before
    /// a follow-up is accepted. Default: true. Surfaced here so the follow-up
    /// gate is a swappable policy, enforced with Core's provenance record.
    #[serde(default = "default_true")]
    pub require_followup_grant: bool,
}

fn default_widget_max_calls_per_min() -> u32 {
    60
}
fn default_widget_max_followups_per_min() -> u32 {
    6
}
fn default_widget_max_concurrent_instances_per_session() -> u32 {
    8
}

impl Default for WidgetConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_calls_per_min: default_widget_max_calls_per_min(),
            max_followups_per_min: default_widget_max_followups_per_min(),
            max_concurrent_widget_instances_per_session:
                default_widget_max_concurrent_instances_per_session(),
            scan_arguments: true,
            scan_followups: true,
            require_followup_grant: true,
        }
    }
}

impl GatewayConfig {
    /// Resolve the gateway.toml path using the same logic as `load()`:
    /// `GATEWAY_CONFIG` env var first, then `$config_dir/ryu/gateway.toml`.
    pub fn config_path() -> Option<std::path::PathBuf> {
        std::env::var("GATEWAY_CONFIG")
            .ok()
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::config_dir().map(|d| d.join("ryu").join("gateway.toml")))
    }

    /// Atomically persist `self` to `gateway.toml`, creating the parent directory
    /// if needed. Writes to a `.tmp` file in the same directory, then renames over
    /// the target so a crash mid-write never leaves a corrupt file.
    pub fn save(&self) -> anyhow::Result<()> {
        let path = Self::config_path()
            .ok_or_else(|| anyhow::anyhow!("Cannot determine gateway config path"))?;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let toml_str = toml::to_string_pretty(self)
            .map_err(|e| anyhow::anyhow!("Failed to serialize config: {e}"))?;

        let tmp_path = path.with_extension("toml.tmp");
        std::fs::write(&tmp_path, &toml_str)?;
        std::fs::rename(&tmp_path, &path)?;

        Ok(())
    }

    pub fn load() -> anyhow::Result<Self> {
        let config_path = Self::config_path();

        let mut config: GatewayConfig = if let Some(path) = config_path {
            if path.exists() {
                let content = std::fs::read_to_string(&path)?;
                toml::from_str(&content)?
            } else {
                GatewayConfig::default()
            }
        } else {
            GatewayConfig::default()
        };

        // Bind address
        if let Ok(bind) = std::env::var("GATEWAY_BIND") {
            config.bind = bind;
        }

        // OpenAI
        if let Ok(key) = std::env::var("OPENAI_API_KEY") {
            let base_url = std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| openai_base_url());
            config.providers.openai = Some(OpenAiProviderConfig {
                api_key: key,
                api_keys: env_keys("OPENAI_API_KEYS"),
                base_url,
            });
        }

        // Anthropic
        if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
            let base_url =
                std::env::var("ANTHROPIC_BASE_URL").unwrap_or_else(|_| anthropic_base_url());
            config.providers.anthropic = Some(AnthropicProviderConfig {
                api_key: key,
                api_keys: env_keys("ANTHROPIC_API_KEYS"),
                base_url,
            });
        }

        // Local LLM
        if let Ok(url) = std::env::var("LOCAL_LLM_URL") {
            config.providers.local = Some(LocalProviderConfig { base_url: url });
        }

        // Auth master key
        if let Ok(key) = std::env::var("GATEWAY_MASTER_KEY") {
            config.auth.master_key = Some(key);
            config.auth.require_auth = true;
        }

        // Composio
        if let Ok(key) = std::env::var("COMPOSIO_API_KEY") {
            config.composio.api_key = Some(key);
            config.composio.enabled = true;
        }
        if let Ok(entity_id) = std::env::var("COMPOSIO_ENTITY_ID") {
            config.composio.entity_id = entity_id;
        }

        // OpenRouter
        if let Ok(key) = std::env::var("OPENROUTER_API_KEY") {
            let base_url =
                std::env::var("OPENROUTER_BASE_URL").unwrap_or_else(|_| openrouter_base_url());
            let site_url =
                std::env::var("OPENROUTER_SITE_URL").unwrap_or_else(|_| openrouter_site_url());
            let site_name =
                std::env::var("OPENROUTER_SITE_NAME").unwrap_or_else(|_| openrouter_site_name());
            let data_collection = std::env::var("OPENROUTER_DATA_COLLECTION")
                .unwrap_or_else(|_| openrouter_data_collection());
            let zdr = env_bool("OPENROUTER_ZDR", false);
            let sort = std::env::var("OPENROUTER_SORT").unwrap_or_default();
            let response_healing = env_bool("OPENROUTER_RESPONSE_HEALING", false);
            let usage_accounting = env_bool("OPENROUTER_USAGE_ACCOUNTING", true);
            config.providers.openrouter = Some(OpenRouterProviderConfig {
                api_key: key,
                api_keys: env_keys("OPENROUTER_API_KEYS"),
                base_url,
                site_url,
                site_name,
                data_collection,
                zdr,
                sort,
                response_healing,
                usage_accounting,
                org_api_keys: std::collections::HashMap::new(),
            });
        }

        // Replicate (cloud image/video). Key presence alone activates the
        // provider — mirrors the OpenRouter block. base_url overridable for
        // proxies / self-host.
        if let Ok(key) = std::env::var("REPLICATE_API_KEY") {
            if !key.trim().is_empty() {
                let base_url = std::env::var("REPLICATE_BASE_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(replicate_base_url);
                config.providers.replicate = Some(ReplicateProviderConfig {
                    api_key: key,
                    base_url,
                    poll_interval_ms: default_media_poll_interval_ms(),
                    poll_timeout_secs: default_media_poll_timeout_secs(),
                });
            }
        }

        // Fal (cloud image/video/audio). Key presence alone activates it.
        if let Ok(key) = std::env::var("FAL_API_KEY") {
            if !key.trim().is_empty() {
                let base_url = std::env::var("FAL_BASE_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(fal_base_url);
                config.providers.fal = Some(FalProviderConfig {
                    api_key: key,
                    base_url,
                    poll_interval_ms: default_media_poll_interval_ms(),
                    poll_timeout_secs: default_media_poll_timeout_secs(),
                });
            }
        }

        // Core sidecar manager
        if let Ok(url) = std::env::var("CORE_URL") {
            let token = std::env::var("CORE_TOKEN").ok();
            config.providers.core = Some(CoreProviderConfig {
                base_url: url,
                token,
            });
        }

        // Modal serverless GPU (opt-in). A Ryu Cloud GPU node sets both vars to
        // its deployed Modal inference app; absent either, the provider stays
        // off (nothing hardcoded, no default URL).
        if let (Ok(base_url), Ok(api_key)) = (
            std::env::var("MODAL_BASE_URL"),
            std::env::var("MODAL_API_KEY"),
        ) {
            if !base_url.trim().is_empty() && !api_key.trim().is_empty() {
                config.providers.modal = Some(ModalProviderConfig { api_key, base_url });
            }
        }

        // Firewall (data-plane, per-machine) — env overrides following the
        // gateway's GATEWAY_* env convention (GATEWAY_BIND, GATEWAY_MASTER_KEY).
        // `gateway.toml [firewall]` is the primary config; these let the local
        // stack toggle/configure the firewall without a config file.
        if let Ok(raw) = std::env::var("GATEWAY_FIREWALL_ENABLED") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.firewall.enabled = enabled;
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_FIREWALL_POLICY") {
            if let Some(policy) = FirewallPolicy::from_env(&raw) {
                config.firewall.policy = policy;
            }
        }

        // Telegram channel — env token registers the bot at startup.
        if let Ok(token) = std::env::var("TELEGRAM_BOT_TOKEN") {
            if !token.trim().is_empty() {
                let existing = config.channels.telegram.take();
                let model = std::env::var("TELEGRAM_MODEL")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.model.clone()))
                    .unwrap_or_else(default_channel_model);
                let system_prompt = std::env::var("TELEGRAM_SYSTEM_PROMPT")
                    .ok()
                    .or_else(|| existing.as_ref().and_then(|c| c.system_prompt.clone()));
                let agent_id = std::env::var("TELEGRAM_AGENT_ID")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing.as_ref().and_then(|c| c.agent_id.clone()));
                let team_id = std::env::var("TELEGRAM_TEAM_ID")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing.as_ref().and_then(|c| c.team_id.clone()));
                let core_url = std::env::var("RYU_CORE_URL")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing.as_ref().map(|c| c.core_url.clone()))
                    .unwrap_or_else(default_core_url);
                config.channels.telegram = Some(TelegramChannelConfig {
                    token,
                    model,
                    system_prompt,
                    agent_id,
                    team_id,
                    group_reply_mode: group_reply_mode_from_env("TELEGRAM"),
                    core_url,
                });
            }
        }

        // Control plane (aggregation up + shared budgets)
        if let Ok(key) = std::env::var("CONTROL_PLANE_KEY") {
            config.control_plane.gateway_key = Some(key);
            config.control_plane.enabled = true;
        }
        if let Ok(url) = std::env::var("CONTROL_PLANE_URL") {
            config.control_plane.base_url = url;
        }
        if let Ok(id) = std::env::var("CONTROL_PLANE_SHARED_BUDGET_ID") {
            config.control_plane.shared_budget_id = Some(id);
        }

        // Slack channel — env tokens register the bot at startup. Both an
        // app-level token (Socket Mode) and a bot token (replies) are required.
        if let Ok(app_token) = std::env::var("SLACK_APP_TOKEN") {
            let bot_token = std::env::var("SLACK_BOT_TOKEN").unwrap_or_default();
            if !app_token.trim().is_empty() && !bot_token.trim().is_empty() {
                let existing = config.channels.slack.take();
                let model = std::env::var("SLACK_MODEL")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.model.clone()))
                    .unwrap_or_else(default_channel_model);
                let system_prompt = std::env::var("SLACK_SYSTEM_PROMPT")
                    .ok()
                    .or_else(|| existing.as_ref().and_then(|c| c.system_prompt.clone()));
                let agent_id = std::env::var("SLACK_AGENT_ID")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| existing.as_ref().and_then(|c| c.agent_id.clone()));
                let team_id = std::env::var("SLACK_TEAM_ID")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| existing.as_ref().and_then(|c| c.team_id.clone()));
                let core_url = std::env::var("RYU_CORE_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| existing.as_ref().map(|c| c.core_url.clone()))
                    .unwrap_or_else(default_core_url);
                config.channels.slack = Some(SlackChannelConfig {
                    app_token,
                    bot_token,
                    model,
                    system_prompt,
                    agent_id,
                    team_id,
                    group_reply_mode: group_reply_mode_from_env("SLACK"),
                    core_url,
                });
            }
        }

        // Discord channel — env token registers the bot at startup.
        if let Ok(token) = std::env::var("DISCORD_BOT_TOKEN") {
            if !token.trim().is_empty() {
                let existing = config.channels.discord.take();
                let channel_ids = std::env::var("DISCORD_CHANNEL_IDS")
                    .ok()
                    .map(|v| {
                        v.split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .or_else(|| existing.as_ref().map(|c| c.channel_ids.clone()))
                    .unwrap_or_default();
                let model = std::env::var("DISCORD_MODEL")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.model.clone()))
                    .unwrap_or_else(default_channel_model);
                let system_prompt = std::env::var("DISCORD_SYSTEM_PROMPT")
                    .ok()
                    .or_else(|| existing.as_ref().and_then(|c| c.system_prompt.clone()));
                let agent_id = std::env::var("DISCORD_AGENT_ID")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing.as_ref().and_then(|c| c.agent_id.clone()));
                let team_id = std::env::var("DISCORD_TEAM_ID")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing.as_ref().and_then(|c| c.team_id.clone()));
                let core_url = std::env::var("RYU_CORE_URL")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing.as_ref().map(|c| c.core_url.clone()))
                    .unwrap_or_else(default_core_url);
                config.channels.discord = Some(DiscordChannelConfig {
                    token,
                    channel_ids,
                    model,
                    system_prompt,
                    agent_id,
                    team_id,
                    group_reply_mode: group_reply_mode_from_env("DISCORD"),
                    core_url,
                });
            }
        }

        // WhatsApp channel — env credentials register the adapter at startup.
        if let Ok(access_token) = std::env::var("WHATSAPP_ACCESS_TOKEN") {
            if !access_token.trim().is_empty() {
                let existing = config.channels.whatsapp.take();
                let phone_number_id = std::env::var("WHATSAPP_PHONE_NUMBER_ID")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.phone_number_id.clone()))
                    .unwrap_or_default();
                let verify_token = std::env::var("WHATSAPP_VERIFY_TOKEN")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.verify_token.clone()))
                    .unwrap_or_default();
                let app_secret = std::env::var("WHATSAPP_APP_SECRET")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.app_secret.clone()))
                    .unwrap_or_default();
                let webhook_bind = std::env::var("WHATSAPP_WEBHOOK_BIND")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.webhook_bind.clone()))
                    .unwrap_or_else(default_whatsapp_bind);
                let webhook_path = std::env::var("WHATSAPP_WEBHOOK_PATH")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.webhook_path.clone()))
                    .unwrap_or_else(default_whatsapp_path);
                let graph_version = std::env::var("WHATSAPP_GRAPH_VERSION")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.graph_version.clone()))
                    .unwrap_or_else(default_whatsapp_graph_version);
                let model = std::env::var("WHATSAPP_MODEL")
                    .ok()
                    .or_else(|| existing.as_ref().map(|c| c.model.clone()))
                    .unwrap_or_else(default_channel_model);
                let system_prompt = std::env::var("WHATSAPP_SYSTEM_PROMPT")
                    .ok()
                    .or_else(|| existing.as_ref().and_then(|c| c.system_prompt.clone()));
                let agent_id = std::env::var("WHATSAPP_AGENT_ID")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing.as_ref().and_then(|c| c.agent_id.clone()));
                let team_id = std::env::var("WHATSAPP_TEAM_ID")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing.as_ref().and_then(|c| c.team_id.clone()));
                let core_url = std::env::var("RYU_CORE_URL")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| existing.as_ref().map(|c| c.core_url.clone()))
                    .unwrap_or_else(default_core_url);
                config.channels.whatsapp = Some(WhatsAppChannelConfig {
                    access_token,
                    phone_number_id,
                    verify_token,
                    app_secret,
                    webhook_bind,
                    webhook_path,
                    graph_version,
                    model,
                    system_prompt,
                    agent_id,
                    team_id,
                    group_reply_mode: group_reply_mode_from_env("WHATSAPP"),
                    core_url,
                });
            }
        }

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

        // Smart (classifier-driven) routing. `gateway.toml [routing.smart_routing]`
        // is the primary config (rules live there); these env knobs only toggle
        // the master switch and the classifier model so the local stack can flip
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

        // Per-session token budget (#510). Config-file (`[budgets.session]`) is
        // primary; these envs override for a quick per-deployment cap with no
        // gateway.toml edit. `GATEWAY_SESSION_BUDGET_LIMIT=0` disables it.
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

        // Platform-credits debit hook (#486). Off by default; Core enables it
        // when the credits wallet is live for the deployment. The debit endpoint
        // shares the control-plane API, so inherit the resolved
        // control_plane.base_url ONLY when `[credits] base_url` was left at its
        // default — an explicit gateway.toml value (or GATEWAY_CREDITS_URL below)
        // wins, preserving the "TOML primary, env overrides" convention.
        if config.credits.base_url == default_control_plane_url() {
            config.credits.base_url = config.control_plane.base_url.clone();
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_ENABLED") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.credits.enabled = enabled;
            }
        }
        if let Ok(url) = std::env::var("GATEWAY_CREDITS_URL") {
            if !url.trim().is_empty() {
                config.credits.base_url = url;
            }
        }
        if let Ok(secret) = std::env::var("RYU_CREDITS_INTERNAL_SECRET") {
            if !secret.trim().is_empty() {
                config.credits.internal_secret = Some(secret);
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_MARKUP_BPS") {
            if let Ok(bps) = raw.trim().parse::<u64>() {
                config.credits.markup_bps = bps;
            }
        }
        if let Ok(raw) = std::env::var("GATEWAY_CREDITS_COST_PER_TOOL_CALL_MICRO_USD") {
            if let Ok(cost) = raw.trim().parse::<u64>() {
                config.credits.cost_per_tool_call_micro_usd = cost;
            }
        }
        // Per-modality flat media rates (managed metering; 0 = free by default).
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
                &mut config.credits.cost_per_sandbox_gpu_rtx_pro_6000_second_nano_usd,
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

        // Fleet mode (managed-cloud WS2). A publicly-exposed multi-tenant replica
        // sets this so the admin gate stops trusting loopback peers (an external
        // caller through the co-located LB looks like 127.0.0.1). Config-file
        // (`fleet = true`) is primary; this env override flips it per deployment.
        if let Ok(raw) = std::env::var("RYU_GATEWAY_FLEET") {
            if let Some(enabled) = parse_bool_env(&raw) {
                config.fleet = enabled;
            }
        }

        Ok(config)
    }
}

// ─── Channels (bots) config ───────────────────────────────────────────────────

/// Configuration for the channel layer: external messaging surfaces (Telegram,
/// Slack, etc.) that register once at the gateway. Inbound messages become
/// gateway pipeline requests; outbound responses route back to the channel.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ChannelsConfig {
    /// Telegram bot adapter. Set `token` (or env `TELEGRAM_BOT_TOKEN`) to enable.
    #[serde(default)]
    pub telegram: Option<TelegramChannelConfig>,
    /// Slack bot adapter (Socket Mode). Set `app_token` + `bot_token` (or env
    /// `SLACK_APP_TOKEN` + `SLACK_BOT_TOKEN`) to enable.
    #[serde(default)]
    pub slack: Option<SlackChannelConfig>,

    /// Discord bot adapter. Set `token` (or env `DISCORD_BOT_TOKEN`) to enable.
    #[serde(default)]
    pub discord: Option<DiscordChannelConfig>,

    /// WhatsApp Business (Meta Cloud API) adapter. Set credentials (or the
    /// `WHATSAPP_*` env vars) to enable.
    #[serde(default)]
    pub whatsapp: Option<WhatsAppChannelConfig>,
}

/// When a bot replies inside a GROUP/multi-user chat. Direct messages are always
/// answered regardless; this only gates the noisy group case. Mirrors the
/// control-plane `GROUP_REPLY_MODES` (`packages/db/src/models/channel.model.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupReplyMode {
    /// Reply only when the bot is @mentioned, replied to, or addressed by a
    /// command. The safe default — a group bot otherwise answers every message.
    #[default]
    Mentions,
    /// Reply to every message in the group.
    All,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TelegramChannelConfig {
    /// Bot token issued by @BotFather.
    pub token: String,
    /// Model to route inbound messages to. Defaults to `gpt-4o`.
    /// Ignored when `core_url` is set (the Core agent binding takes precedence).
    #[serde(default = "default_channel_model")]
    pub model: String,
    /// Optional system prompt prepended to every inbound conversation.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Core agent id to route inbound messages to (M11 / #226).
    ///
    /// When set, inbound Telegram messages are routed through Core's
    /// `POST /api/channels/run` endpoint using this agent binding instead of
    /// going directly through the gateway pipeline. The agent binding is swappable
    /// via config; omit to keep the legacy gateway-pipeline path.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Base URL of the Core sidecar (M11 / #226). Defaults to the standard Core
    /// bind address (`http://127.0.0.1:7980`). Used when `agent_id` is set to
    /// call `POST <core_url>/api/channels/run` for the Core session seam.
    /// Core team id to route inbound messages to. When set, the bot targets a
    /// team (a lead agent orchestrating its members) instead of a single agent
    /// and takes precedence over `agent_id`. Routed through `/api/channels/run`.
    #[serde(default)]
    pub team_id: Option<String>,
    /// When the bot replies inside a group chat (DMs always reply). Mirrors the
    /// control-plane `groupReplyMode`; defaults to mentions-only.
    #[serde(default)]
    pub group_reply_mode: GroupReplyMode,
    #[serde(default = "default_core_url")]
    pub core_url: String,
}

fn default_core_url() -> String {
    "http://127.0.0.1:7980".to_string()
}

/// Slack channel config. Uses Socket Mode so no public webhook URL is required:
/// the gateway opens an outbound WebSocket via the app-level token and receives
/// events over it, replying with the bot token.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SlackChannelConfig {
    /// App-level token (`xapp-...`) with `connections:write`, used to open the
    /// Socket Mode WebSocket via `apps.connections.open`.
    pub app_token: String,
    /// Bot user OAuth token (`xoxb-...`) used to post replies via
    /// `chat.postMessage`.
    pub bot_token: String,
    /// Model to route inbound messages to. Defaults to `gpt-4o`.
    #[serde(default = "default_channel_model")]
    pub model: String,
    /// Optional system prompt prepended to every inbound conversation.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// When set, inbound messages are routed through Core's `/api/channels/run`
    /// endpoint using this agent id so conversation history is persisted in the
    /// Core session store. `None` falls back to the legacy gateway-pipeline path.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Base URL of the Core sidecar. Used when `agent_id` is set to call
    /// `POST <core_url>/api/channels/run` for the Core session seam.
    /// Defaults to the Core bind address (`http://127.0.0.1:7980`).
    /// Core team id to route inbound messages to. When set, the bot targets a
    /// team (a lead agent orchestrating its members) instead of a single agent
    /// and takes precedence over `agent_id`. Routed through `/api/channels/run`.
    #[serde(default)]
    pub team_id: Option<String>,
    /// When the bot replies inside a group chat (DMs always reply). Mirrors the
    /// control-plane `groupReplyMode`; defaults to mentions-only.
    #[serde(default)]
    pub group_reply_mode: GroupReplyMode,
    #[serde(default = "default_core_url")]
    pub core_url: String,
}

fn default_channel_model() -> String {
    "gpt-4o".to_string()
}

/// Read a channel's group-reply mode from `<PLATFORM>_GROUP_REPLY_MODE`
/// (e.g. `TELEGRAM_GROUP_REPLY_MODE=all`). Unset or unrecognised → the default
/// (mentions-only), so env bots keep the safe group behavior unless opted out.
fn group_reply_mode_from_env(platform: &str) -> GroupReplyMode {
    match std::env::var(format!("{platform}_GROUP_REPLY_MODE")) {
        Ok(v) if v.trim().eq_ignore_ascii_case("all") => GroupReplyMode::All,
        _ => GroupReplyMode::Mentions,
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DiscordChannelConfig {
    /// Bot token issued in the Discord developer portal (without the `Bot ` prefix).
    pub token: String,
    /// Channel IDs the bot watches for inbound messages. At least one required.
    #[serde(default)]
    pub channel_ids: Vec<String>,
    /// Model to route inbound messages to. Defaults to `gpt-4o`.
    /// Ignored when `agent_id` is set (the Core agent binding takes precedence).
    #[serde(default = "default_channel_model")]
    pub model: String,
    /// Optional system prompt prepended to every inbound conversation.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Core agent id to route inbound messages to (M11 / #229).
    ///
    /// When set, inbound Discord messages are routed through Core's
    /// `POST /api/channels/run` endpoint using this agent binding instead of
    /// going directly through the gateway pipeline. The agent binding is swappable
    /// via config; omit to keep the legacy gateway-pipeline path.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Base URL of the Core sidecar (M11 / #229). Defaults to the standard Core
    /// bind address (`http://127.0.0.1:7980`). Used when `agent_id` is set to
    /// call `POST <core_url>/api/channels/run` for the Core session seam.
    /// Core team id to route inbound messages to. When set, the bot targets a
    /// team (a lead agent orchestrating its members) instead of a single agent
    /// and takes precedence over `agent_id`. Routed through `/api/channels/run`.
    #[serde(default)]
    pub team_id: Option<String>,
    /// When the bot replies inside a group chat (DMs always reply). Mirrors the
    /// control-plane `groupReplyMode`; defaults to mentions-only.
    #[serde(default)]
    pub group_reply_mode: GroupReplyMode,
    #[serde(default = "default_core_url")]
    pub core_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct WhatsAppChannelConfig {
    /// Permanent or temporary access token for the Meta Graph API.
    pub access_token: String,
    /// Phone-number ID issued by Meta for the WhatsApp Business number.
    pub phone_number_id: String,
    /// Token used to verify Meta's webhook subscription handshake.
    pub verify_token: String,
    /// Meta App Secret, used to verify the `X-Hub-Signature-256` HMAC on every
    /// inbound webhook POST so spoofed messages are rejected. Required: the
    /// channel refuses to start if this is empty.
    #[serde(default)]
    pub app_secret: String,
    /// Local address the webhook receiver binds to. Meta delivers inbound
    /// messages here (front this with a public HTTPS reverse proxy in prod).
    #[serde(default = "default_whatsapp_bind")]
    pub webhook_bind: String,
    /// Path the webhook receiver listens on. Defaults to `/webhooks/whatsapp`.
    #[serde(default = "default_whatsapp_path")]
    pub webhook_path: String,
    /// Graph API version segment, e.g. `v21.0`.
    #[serde(default = "default_whatsapp_graph_version")]
    pub graph_version: String,
    /// Model to route inbound messages to. Defaults to `gpt-4o`.
    #[serde(default = "default_channel_model")]
    pub model: String,
    /// Optional system prompt prepended to every inbound conversation.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Core agent id to route inbound webhook messages to (M11 / #228).
    ///
    /// When set, inbound WhatsApp messages are routed through Core's
    /// `POST /api/channels/run` endpoint using this agent binding so
    /// conversation history is persisted in Core and model calls flow
    /// Core → Gateway (moat stays on path). Omit to keep the legacy
    /// gateway-pipeline path.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Base URL of the Core sidecar (M11 / #228). Defaults to the standard
    /// Core bind address (`http://127.0.0.1:7980`). Used when `agent_id` is
    /// set to call `POST <core_url>/api/channels/run` for the Core session seam.
    /// Core team id to route inbound messages to. When set, the bot targets a
    /// team (a lead agent orchestrating its members) instead of a single agent
    /// and takes precedence over `agent_id`. Routed through `/api/channels/run`.
    #[serde(default)]
    pub team_id: Option<String>,
    /// When the bot replies inside a group chat (DMs always reply). Mirrors the
    /// control-plane `groupReplyMode`; defaults to mentions-only.
    #[serde(default)]
    pub group_reply_mode: GroupReplyMode,
    #[serde(default = "default_core_url")]
    pub core_url: String,
}

fn default_whatsapp_bind() -> String {
    "0.0.0.0:8443".to_string()
}

fn default_whatsapp_path() -> String {
    "/webhooks/whatsapp".to_string()
}

fn default_whatsapp_graph_version() -> String {
    "v21.0".to_string()
}

// ─── Phase-2 config structs ───────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuditConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Path to the SQLite database file. Defaults to
    /// `$XDG_DATA_HOME/ryu/audit.db` (or `~/.local/share/ryu/audit.db`).
    #[serde(default = "default_audit_db_path")]
    pub db_path: String,
}

fn default_audit_db_path() -> String {
    dirs::data_local_dir()
        .map(|d| d.join("ryu").join("audit.db"))
        .and_then(|p| p.to_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "audit.db".to_string())
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            db_path: default_audit_db_path(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EvalsConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Latency (ms) at which the latency score drops to 0. Default: 10 000 ms.
    #[serde(default = "default_max_latency_ms")]
    pub max_latency_ms: u64,
    /// Fraction of completed requests to score, in `[0.0, 1.0]`.
    /// `1.0` scores every request; `0.0` disables scoring entirely.
    /// Sampling keeps eval overhead bounded under load. Default: 1.0.
    #[serde(default = "default_sample_rate")]
    pub sample_rate: f32,
    /// Inject `stream_options.include_usage=true` into streamed requests so
    /// the provider emits a terminal usage frame that the gateway can parse
    /// to record non-zero token counts and run eval scoring at stream end.
    ///
    /// Only conforming providers (OpenAI and OpenAI-compatible) honour this
    /// flag. Non-conforming providers fall back to `estimate_prompt_tokens`.
    /// Default: true (on by default for all OpenAI-compatible providers).
    #[serde(default = "default_true")]
    pub stream_usage: bool,
}

fn default_max_latency_ms() -> u64 {
    10_000
}

fn default_sample_rate() -> f32 {
    1.0
}

impl Default for EvalsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_latency_ms: default_max_latency_ms(),
            sample_rate: default_sample_rate(),
            stream_usage: true,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ComposioConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Composio API key (env: COMPOSIO_API_KEY).
    pub api_key: Option<String>,
    /// Allowlist of Composio action names the gateway may execute.
    #[serde(default)]
    pub actions: Vec<String>,
    /// Maximum agentic loop rounds before returning the last response. Default: 3.
    #[serde(default = "default_composio_max_rounds")]
    pub max_rounds: u8,
    /// Per-user entity ID that scopes connected accounts in Composio.
    ///
    /// Composio's entity model: each call to `/actions/{name}/execute` must
    /// carry an `entityId` that identifies the connected-account owner. The
    /// default value `"default"` is Composio's built-in fallback entity and
    /// works for single-user / test setups. In multi-user deployments, the
    /// gateway receives the caller identity in the `x-ryu-user-id` header
    /// (forwarded by Core) and passes it here so each user's OAuth-connected
    /// account is selected correctly. Override the startup default via the
    /// `COMPOSIO_ENTITY_ID` env var; at runtime the pipeline will prefer
    /// `RequestContext::user_id` when present (see pipeline/mod.rs).
    #[serde(default = "default_composio_entity_id")]
    pub entity_id: String,
}

fn default_composio_max_rounds() -> u8 {
    3
}

fn default_composio_entity_id() -> String {
    "default".to_string()
}

impl Default for ComposioConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key: None,
            actions: Vec::new(),
            max_rounds: default_composio_max_rounds(),
            entity_id: default_composio_entity_id(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SemanticCacheConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Cosine-similarity threshold to count as a cache hit. Default: 0.92.
    #[serde(default = "default_similarity_threshold")]
    pub similarity_threshold: f32,
    /// Embedding model to call via the OpenAI provider.
    #[serde(default = "default_embedding_model")]
    pub embedding_model: String,
}

fn default_similarity_threshold() -> f32 {
    0.92
}
fn default_embedding_model() -> String {
    "text-embedding-3-small".to_string()
}

impl Default for SemanticCacheConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            similarity_threshold: default_similarity_threshold(),
            embedding_model: default_embedding_model(),
        }
    }
}

// ─── Original Phase-1 config structs ─────────────────────────────────────────

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CacheConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// How long a cached entry is valid (seconds). Default: 300 (5 min).
    #[serde(default = "default_cache_ttl")]
    pub ttl_secs: u64,
    /// Maximum number of entries before the oldest are evicted. Default: 1000.
    #[serde(default = "default_cache_max_entries")]
    pub max_entries: usize,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            ttl_secs: default_cache_ttl(),
            max_entries: default_cache_max_entries(),
        }
    }
}

fn default_cache_ttl() -> u64 {
    300
}
fn default_cache_max_entries() -> usize {
    1_000
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CircuitBreakerConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Number of consecutive failures before the circuit opens. Default: 5.
    #[serde(default = "default_failure_threshold")]
    pub failure_threshold: u32,
    /// Seconds to wait in the Open state before trying again. Default: 30.
    #[serde(default = "default_reset_timeout")]
    pub reset_timeout_secs: u64,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            failure_threshold: default_failure_threshold(),
            reset_timeout_secs: default_reset_timeout(),
        }
    }
}

fn default_failure_threshold() -> u32 {
    5
}
fn default_reset_timeout() -> u64 {
    30
}

/// Concurrency admission control for a scarce resident resource — the **local**
/// inference engine (one llama.cpp/ollama/… server, a fixed number of batch
/// slots). Unlike the rate limiter (per-key cost/abuse) and circuit breaker
/// (per-provider failure), this is per-provider *concurrency* with priority:
/// it admits at most `local_max_in_flight` requests to the local provider at
/// once (match the engine's `--parallel` slot count so every slot is busy and
/// llama-server's internal FIFO stays empty), queues the rest up to
/// `local_max_queued`, and serves **interactive** waiters ahead of **background**
/// fan-out (delegate / threads / scheduler / monitors). Remote providers are not
/// gated (they scale elastically). Lives in the Gateway because it governs a
/// *shared* resource (§ Core-vs-Gateway rule). Takes effect on the next restart.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ConcurrencyConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Max concurrent in-flight requests to the local provider. Should match the
    /// engine's slot count (`--parallel`). Default 4 (mirrors Core's mid-tier
    /// `default_parallel_slots`). `0` disables gating (treated as unlimited).
    #[serde(default = "default_local_max_in_flight")]
    pub local_max_in_flight: u32,
    /// Max requests allowed to wait for a slot before new ones are rejected with
    /// `engine_overloaded` (503). Bounds memory/latency under a flood. Default 64.
    #[serde(default = "default_local_max_queued")]
    pub local_max_queued: u32,
}

impl Default for ConcurrencyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            local_max_in_flight: default_local_max_in_flight(),
            local_max_queued: default_local_max_queued(),
        }
    }
}

fn default_local_max_in_flight() -> u32 {
    4
}
fn default_local_max_queued() -> u32 {
    64
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SkillsConfig {
    #[serde(default)]
    pub skills: Vec<crate::skills::Skill>,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            bind: default_bind(),
            providers: ProvidersConfig::default(),
            routing: RoutingConfig::default(),
            firewall: FirewallConfig::default(),
            rate_limit: RateLimitConfig::default(),
            auth: AuthConfig::default(),
            cache: CacheConfig::default(),
            circuit_breaker: CircuitBreakerConfig::default(),
            concurrency: ConcurrencyConfig::default(),
            skills: SkillsConfig::default(),
            audit: AuditConfig::default(),
            evals: EvalsConfig::default(),
            composio: ComposioConfig::default(),
            semantic_cache: SemanticCacheConfig::default(),
            budgets: BudgetConfig::default(),
            channels: ChannelsConfig::default(),
            control_plane: ControlPlaneConfig::default(),
            exec_budget: ExecBudgetConfig::default(),
            compression: CompressionConfig::default(),
            tools: ToolsConfig::default(),
            widget: WidgetConfig::default(),
            credits: CreditsConfig::default(),
            fleet: false,
        }
    }
}

#[cfg(test)]
mod capacity_config_tests {
    use super::{ControlPlaneConfig, ModelPrice, OpenAiProviderConfig};
    use std::collections::HashMap;

    #[test]
    fn all_keys_falls_back_to_single_key() {
        let c = OpenAiProviderConfig {
            api_key: "sk-primary".into(),
            api_keys: vec![],
            base_url: super::openai_base_url(),
        };
        assert_eq!(c.all_keys(), vec!["sk-primary".to_string()]);
    }

    #[test]
    fn all_keys_merges_and_dedupes() {
        let c = OpenAiProviderConfig {
            api_key: "sk-a".into(),
            api_keys: vec!["sk-b".into(), "sk-a".into(), "".into()],
            base_url: super::openai_base_url(),
        };
        // Primary first, extras appended, dupes + blanks dropped.
        assert_eq!(c.all_keys(), vec!["sk-a".to_string(), "sk-b".to_string()]);
    }

    #[test]
    fn cost_for_uses_flat_rate_without_a_price_table() {
        let cp = ControlPlaneConfig::default(); // 2000 micro-USD / 1k combined
                                                // 500 in + 500 out = 1000 tokens ⇒ 2000 micro-USD.
        assert_eq!(cp.cost_for("gpt-4o", 500, 500), 2000);
    }

    #[test]
    fn cost_for_prefers_per_model_prefix_pricing() {
        let mut pricing = HashMap::new();
        pricing.insert(
            "claude-sonnet".to_string(),
            ModelPrice {
                input_per_1k_micro_usd: 3000,
                output_per_1k_micro_usd: 15000,
            },
        );
        let cp = ControlPlaneConfig {
            model_pricing: pricing,
            ..Default::default()
        };
        // Longest-prefix match on the versioned id: 1k in (3000) + 1k out (15000).
        assert_eq!(cp.cost_for("claude-sonnet-4-5-20250929", 1000, 1000), 18000);
        // An unpriced model falls back to the flat 2000/1k rate.
        assert_eq!(cp.cost_for("gpt-4o", 1000, 0), 2000);
    }
}

#[cfg(test)]
mod credits_config_tests {
    use super::{CreditsConfig, WalletEmptyAction};

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
}
