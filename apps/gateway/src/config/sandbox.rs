//! Sandbox (Box) sizes, per-resource rates and their env/default parsing.

use super::*;

/// A Box size as Core's sandbox tick names it (`small` | `default` | `large`,
/// the Box service's `BoxSize`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum SandboxSize {
    #[serde(rename = "small")]
    Small,
    #[serde(rename = "default")]
    Default,
    #[serde(rename = "large")]
    Large,
}

impl SandboxSize {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Default => "default",
            Self::Large => "large",
        }
    }
}

/// Customer price per Box size, in micro-USD per hour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub struct SizeRates {
    pub small: u64,
    pub default: u64,
    pub large: u64,
}

impl SizeRates {
    /// The hourly rate for `size`, in micro-USD.
    pub fn micro_usd_per_hour(&self, size: SandboxSize) -> u64 {
        match size {
            SandboxSize::Small => self.small,
            SandboxSize::Default => self.default,
            SandboxSize::Large => self.large,
        }
    }

    /// Parse `GATEWAY_CREDITS_SANDBOX_SIZE_RATES`: either
    /// `small=25000,default=40000,large=70000` or the same as a JSON object.
    /// Every size must be present, positive, and named once.
    pub fn parse(raw: &str) -> Result<Self, String> {
        let raw = raw.trim();
        if raw.starts_with('{') {
            let rates: Self = serde_json::from_str(raw)
                .map_err(|_| "expected {\"small\":N,\"default\":N,\"large\":N}".to_owned())?;
            return rates.validated();
        }
        let (mut small, mut default, mut large) = (None, None, None);
        for pair in raw
            .split(',')
            .map(str::trim)
            .filter(|pair| !pair.is_empty())
        {
            let (name, value) = pair
                .split_once('=')
                .ok_or_else(|| format!("{pair:?} is not size=micro_usd_per_hour"))?;
            let value: u64 = value
                .trim()
                .parse()
                .map_err(|_| format!("{pair:?} does not carry a whole micro-USD rate"))?;
            let slot = match name.trim().to_ascii_lowercase().as_str() {
                "small" => &mut small,
                "default" => &mut default,
                "large" => &mut large,
                other => return Err(format!("unknown Box size {other:?}")),
            };
            if slot.replace(value).is_some() {
                return Err(format!("Box size {} is named twice", name.trim()));
            }
        }
        Self {
            small: small.ok_or("missing the small rate")?,
            default: default.ok_or("missing the default rate")?,
            large: large.ok_or("missing the large rate")?,
        }
        .validated()
    }

    /// Whether `raw` switches size pricing off (`off` or `none`).
    pub fn is_off(raw: &str) -> bool {
        matches!(raw.trim().to_ascii_lowercase().as_str(), "off" | "none")
    }

    pub(super) fn validated(self) -> Result<Self, String> {
        if self.small == 0 || self.default == 0 || self.large == 0 {
            return Err("every Box size rate must be positive".to_owned());
        }
        Ok(self)
    }
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

pub(super) fn default_credits_timeout_ms() -> u64 {
    3000
}

/// The hosted billing page, the same link the control plane's credit alerts use.
pub(super) fn default_credits_top_up_url() -> String {
    "https://ryuhq.com/organizations/billing".to_owned()
}

/// $0.01. See [`CreditsConfig::min_reserve_micro_usd`] for why the floor rather
/// than the estimate is the number that bounds a burst.
pub(super) fn default_min_reserve_micro_usd() -> u64 {
    10_000
}

pub(super) fn default_sandbox_markup_bps() -> u64 {
    3000
}

pub(super) fn default_sandbox_free_storage_gib() -> u64 {
    5
}

/// The customer price of each Box size, micro-USD per hour (founder sign-off
/// 2026-10-20). It must equal `crates/gateway/contracts/fixtures/box-rates.json`,
/// which `SERVICE_RATES.box`, the control plane's settlement and
/// reconciliation, Core and the Box service also read (each side's tests fail
/// on drift).
pub(super) fn default_sandbox_size_rates() -> Option<SizeRates> {
    Some(SizeRates {
        small: 25_000,
        default: 40_000,
        large: 70_000,
    })
}

/// Every Box start is billed for at least this many seconds.
pub const BOX_MINIMUM_SECONDS_PER_START: u64 = 300;
/// A Box run is billed in whole minutes, rounded up.
pub const BOX_BILLING_ROUNDING_SECONDS: u64 = 60;

/// Billable seconds of a Box run that has been metered for `elapsed` seconds:
/// rounded up to whole minutes and, when the run's first tick was seen
/// (`minimum`), never less than the per-start minimum. A run first seen
/// mid-way (a Gateway restart) already paid its minimum before the restart.
pub fn box_billable_seconds(elapsed: u64, minimum: bool) -> u64 {
    let rounded = elapsed
        .div_ceil(BOX_BILLING_ROUNDING_SECONDS)
        .saturating_mul(BOX_BILLING_ROUNDING_SECONDS);
    if minimum {
        rounded.max(BOX_MINIMUM_SECONDS_PER_START)
    } else {
        rounded
    }
}

/// `sandbox_size_rates` from TOML: a `{small, default, large}` table, or the
/// string `"off"` (or `"none"`) for per-resource pricing.
pub(super) fn deserialize_sandbox_size_rates<'de, D>(
    deserializer: D,
) -> Result<Option<SizeRates>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Raw {
        Table(SizeRates),
        Text(String),
    }
    match Raw::deserialize(deserializer)? {
        Raw::Table(rates) => rates
            .validated()
            .map(Some)
            .map_err(serde::de::Error::custom),
        Raw::Text(text) if SizeRates::is_off(&text) => Ok(None),
        Raw::Text(text) => SizeRates::parse(&text)
            .map(Some)
            .map_err(serde::de::Error::custom),
    }
}

// ─── Sandbox rate defaults (nano-USD per unit-second) ────────────────────────
// These nine fns are the ONLY place the published sandbox rates are written.
// Both the serde `default = "…"` attribute on each `CreditsConfig` field and
// `impl Default for CreditsConfig` call them, so "the default when the key is
// absent from a present `[credits]` table" and "the default when the whole table
// is absent" are the same number by construction rather than by review.

pub(super) fn default_sandbox_vcpu_rate() -> u64 {
    14_000
}

pub(super) fn default_sandbox_mem_rate() -> u64 {
    4_500
}

pub(super) fn default_sandbox_storage_rate() -> u64 {
    30
}

pub(super) fn default_sandbox_gpu_h200_rate() -> u64 {
    1_261_000
}

pub(super) fn default_sandbox_gpu_h100_rate() -> u64 {
    1_097_000
}

pub(super) fn default_sandbox_gpu_rtx_pro_6000_rate() -> u64 {
    842_000
}

pub(super) fn default_sandbox_gpu_rtx_5090_rate() -> u64 {
    358_000
}

pub(super) fn default_sandbox_gpu_rtx_4090_rate() -> u64 {
    275_000
}

pub(super) fn default_sandbox_windows_vcpu_rate() -> u64 {
    23_800
}

/// `GATEWAY_CREDITS_SANDBOX_SIZE_RATES` over the configured table: blank keeps
/// it, `off`/`none` switches size pricing off, and a table replaces it. A
/// malformed table keeps the configured one (it never turns billing off).
pub(super) fn sandbox_size_rates_from_env(
    raw: &str,
    configured: Option<SizeRates>,
) -> Option<SizeRates> {
    if raw.trim().is_empty() {
        return configured;
    }
    if SizeRates::is_off(raw) {
        return None;
    }
    match SizeRates::parse(raw) {
        Ok(rates) => Some(rates),
        Err(error) => {
            tracing::error!(
                error = %error,
                "GATEWAY_CREDITS_SANDBOX_SIZE_RATES is invalid; keeping the configured Box size rates"
            );
            configured
        }
    }
}
