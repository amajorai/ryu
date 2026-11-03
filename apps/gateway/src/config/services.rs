//! Circuit breaker, concurrency, ACP, skills and marketplace config.

use super::*;

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

pub(super) fn default_failure_threshold() -> u32 {
    5
}
pub(super) fn default_reset_timeout() -> u64 {
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
    /// Max requests one org may have in flight plus queued for the local
    /// provider, so one org on a shared node cannot take every slot and queue
    /// position. Unset = `local_max_in_flight + local_max_queued / 4`; `0`
    /// disables the cap. Requests without an org are never capped by it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_max_pending_per_org: Option<u32>,
}

impl ConcurrencyConfig {
    /// The per-org cap after applying the unset default.
    pub fn effective_local_max_pending_per_org(&self) -> u32 {
        self.local_max_pending_per_org.unwrap_or_else(|| {
            self.local_max_in_flight
                .saturating_add(self.local_max_queued / 4)
        })
    }
}

impl Default for ConcurrencyConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            local_max_in_flight: default_local_max_in_flight(),
            local_max_queued: default_local_max_queued(),
            local_max_pending_per_org: None,
        }
    }
}

pub(super) fn default_local_max_in_flight() -> u32 {
    4
}
pub(super) fn default_local_max_queued() -> u32 {
    64
}

/// Node-level lifecycle and resource controls for ACP subprocess sessions.
///
/// `max_parallel_agents = None` is the safe default: Core derives a conservative
/// limit from the node's CPU and RAM instead of making every machine use the same
/// arbitrary number. The setting is intentionally Gateway-owned so it applies to
/// every ACP agent on the node, including agents that do not expose plugins.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AcpConfig {
    /// Tear down a pooled ACP subprocess after this many inactive minutes. The
    /// next message lazily starts a fresh subprocess and may take longer.
    #[serde(default = "default_acp_idle_timeout_minutes")]
    pub idle_timeout_minutes: u32,
    /// Maximum number of ACP subprocesses that may be running at once. `None`
    /// delegates to Core's conservative hardware-based calculation.
    #[serde(default)]
    pub max_parallel_agents: Option<u32>,
    /// Keep the local computer awake while at least one ACP agent is active.
    #[serde(default = "default_true")]
    pub keep_computer_awake: bool,
}

impl Default for AcpConfig {
    fn default() -> Self {
        Self {
            idle_timeout_minutes: default_acp_idle_timeout_minutes(),
            max_parallel_agents: None,
            keep_computer_awake: true,
        }
    }
}

impl AcpConfig {
    /// Validate values at the write boundary so a malformed persisted setting can
    /// never become an unbounded or effectively-disabled process policy.
    pub fn validate(&self) -> Result<(), String> {
        if !(ACP_IDLE_TIMEOUT_MIN_MINUTES..=ACP_IDLE_TIMEOUT_MAX_MINUTES)
            .contains(&self.idle_timeout_minutes)
        {
            return Err(format!(
                "acp.idle_timeout_minutes must be between {ACP_IDLE_TIMEOUT_MIN_MINUTES} and {ACP_IDLE_TIMEOUT_MAX_MINUTES}"
            ));
        }
        if let Some(max) = self.max_parallel_agents {
            if !(ACP_MAX_PARALLEL_MIN..=ACP_MAX_PARALLEL_MAX).contains(&max) {
                return Err(format!(
                    "acp.max_parallel_agents must be between {ACP_MAX_PARALLEL_MIN} and {ACP_MAX_PARALLEL_MAX}, or null for Auto"
                ));
            }
        }
        Ok(())
    }
}

pub const ACP_IDLE_TIMEOUT_MIN_MINUTES: u32 = 1;
pub const ACP_IDLE_TIMEOUT_MAX_MINUTES: u32 = 24 * 60;
pub const ACP_MAX_PARALLEL_MIN: u32 = 1;
pub const ACP_MAX_PARALLEL_MAX: u32 = 32;

pub(super) fn default_acp_idle_timeout_minutes() -> u32 {
    5
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct SkillsConfig {
    #[serde(default)]
    pub skills: Vec<crate::skills::Skill>,
}

/// Node-level policy for the personalized Marketplace "For you" feed.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct MarketplaceRecommendationsConfig {
    /// Whether Core may fetch catalog references or invoke the model adapter.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// How often an automatically refreshed recommendation cache may regenerate.
    #[serde(default)]
    pub cadence: MarketplaceRecommendationsCadence,
}

/// Permission policy for computer-use providers attached to this node.
///
/// `locked_use` is deliberately opt-in. A true value grants the node's
/// computer-use provider permission to request a locked-session execution path;
/// it does not itself unlock the operating system or bypass its safety prompts.
///
/// `security_key` is also opt-in: it lets a browser on this node (a VM, cloud
/// node or hidden Bot lane) relay a site's WebAuthn sign-in or registration to
/// the hardware security key on the user's desktop, and lets that desktop
/// answer such requests with its key. Core reads it live on every relayed
/// request and refuses when it is off or unreadable; both the node running the
/// browser and the desktop holding the key must allow it. Each request is
/// shown to the user, and the key still requires its own touch or PIN. Agents
/// cannot change it through the self-API.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct ComputerUseConfig {
    #[serde(default)]
    pub locked_use: bool,
    #[serde(default)]
    pub security_key: bool,
}

impl Default for ComputerUseConfig {
    fn default() -> Self {
        Self {
            locked_use: false,
            security_key: false,
        }
    }
}

impl Default for MarketplaceRecommendationsConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            cadence: MarketplaceRecommendationsCadence::default(),
        }
    }
}

/// The intentionally closed refresh cadence accepted by Gateway config.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum MarketplaceRecommendationsCadence {
    Daily,
    Weekly,
    Monthly,
}

impl Default for MarketplaceRecommendationsCadence {
    fn default() -> Self {
        Self::Weekly
    }
}
