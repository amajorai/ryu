//! Wire types shared by Core and the Ryu Box service for session Boxes.
//!
//! These mirror the TypeScript contracts in `apps/box/src/contracts.ts` and
//! `apps/box/src/response-contract.ts` (design `docs/box-per-session-desktop.md`
//! §2.3, §6 and §7). The HTTP client that uses them is
//! [`crate::box_session::BoxSessionClient`].

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::spec::{GpuKind, OsKind, SandboxSpec};

mod error;

pub use error::{
    parse_box_error, BoxApiError, DEFAULT_CAPACITY_RETRY_SECS, MAX_CAPACITY_RETRY_SECS,
};

/// A Box size. Serialized as `small`, `default` or `large`, exactly as the Box
/// service's `BoxSize`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoxSize {
    Small,
    Default,
    Large,
}

impl Default for BoxSize {
    /// Session Boxes start small (2 vCPU / 4 GiB); heavier sizes are chosen
    /// explicitly.
    fn default() -> Self {
        Self::Small
    }
}

impl BoxSize {
    pub const ALL: [BoxSize; 3] = [BoxSize::Small, BoxSize::Default, BoxSize::Large];

    /// The wire name: `small`, `default` or `large`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::Default => "default",
            Self::Large => "large",
        }
    }

    /// Resource units the size holds against admission limits; matches
    /// `BOX_RESOURCE_UNITS` in the Box service.
    pub fn resource_units(self) -> u32 {
        match self {
            Self::Small => 1,
            Self::Default => 2,
            Self::Large => 4,
        }
    }
}

impl fmt::Display for BoxSize {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for BoxSize {
    type Err = anyhow::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "small" => Ok(Self::Small),
            "default" => Ok(Self::Default),
            "large" => Ok(Self::Large),
            other => Err(anyhow::anyhow!(
                "unknown Box size {other:?}; expected small, default or large"
            )),
        }
    }
}

/// The resource shape metered for a Box of `size`. Must stay equal to the Box
/// service's `SIZE_LIMITS` (`apps/box/src/drivers/docker.ts`) and
/// `BOX_STORAGE_ALLOWANCE_GIB` (`apps/box/src/contracts.ts`).
pub fn spec_for(size: BoxSize) -> SandboxSpec {
    let (vcpu, mem_gib, storage_gib) = match size {
        BoxSize::Small => (2, 4, 40),
        BoxSize::Default => (4, 8, 80),
        BoxSize::Large => (8, 16, 100),
    };
    SandboxSpec {
        vcpu,
        mem_gib,
        storage_gib,
        gpu: GpuKind::None,
        gpu_count: 0,
        os: OsKind::Linux,
    }
}

/// A Box status, as `PublicBox.status` reports it. Unknown future values
/// deserialize as [`BoxStatus::Unknown`] instead of failing the whole response.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BoxStatus {
    Provisioning,
    Ready,
    Running,
    Stopping,
    Stopped,
    Error,
    Deleted,
    #[serde(other)]
    Unknown,
}

impl BoxStatus {
    /// Running compute: `ready` or `running`.
    pub fn is_live(self) -> bool {
        matches!(self, Self::Ready | Self::Running)
    }

    /// No further transition will happen without a request: `stopped`,
    /// `error` or `deleted`.
    pub fn is_settled(self) -> bool {
        matches!(self, Self::Stopped | Self::Error | Self::Deleted)
    }
}

/// Why a Box was parked. Matches the Box service's `ParkReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ParkReason {
    User,
    Idle,
    Balance,
    Budget,
    Liveness,
    Suspended,
    Ttl,
}

impl ParkReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Idle => "idle",
            Self::Balance => "balance",
            Self::Budget => "budget",
            Self::Liveness => "liveness",
            Self::Suspended => "suspended",
            Self::Ttl => "ttl",
        }
    }
}

impl fmt::Display for ParkReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// A secret string whose `Debug` and `Display` never print the value. It
/// serializes as the plain value, because it has to reach its one recipient.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The secret value. Callers must not log it.
    pub fn expose_secret(&self) -> &str {
        &self.0
    }
}

impl From<String> for SecretString {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString(<redacted>)")
    }
}

impl fmt::Display for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

/// How a viewer reaches a Box screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamMode {
    /// The client dials the Box service's public ingress directly.
    Direct,
    /// Core bridges the stream (self-hosted only).
    Relay,
}

/// What Core's `POST /api/session-boxes/:conversationId/screen` returns.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopGrant {
    pub mode: StreamMode,
    /// Absolute `wss://` URL (direct mode only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// WebSocket subprotocols to dial with; the token travels here.
    #[serde(default)]
    pub protocols: Vec<String>,
    /// Core relay path (relay mode only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub expires_at: String,
}

/// `POST /v1/boxes/:id/access-tokens` for the `desktop` scope. Serializes with
/// `scope: "desktop"`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTokenRequest {
    pub origin: String,
    pub sub: String,
    #[serde(default)]
    pub view_only: bool,
}

impl Serialize for DesktopTokenRequest {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            scope: &'static str,
            origin: &'a str,
            sub: &'a str,
            view_only: bool,
        }
        Wire {
            scope: "desktop",
            origin: &self.origin,
            sub: &self.sub,
            view_only: self.view_only,
        }
        .serialize(serializer)
    }
}

/// The Box service's answer to a desktop token request.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTokenResponse {
    pub token: SecretString,
    pub expires_at: String,
    /// Absolute, and present only when the service knows its public URL.
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub protocols: Vec<String>,
}

/// `PUT /v1/boxes/:id/session-credential`: the Box's short-lived `gwb1` key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCredential {
    pub gateway_url: String,
    pub key: SecretString,
    pub expires_at: String,
}

/// `POST /v1/boxes/:id/keepalive`: Core's tick-liveness lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepaliveRequest {
    pub tick_index: u64,
    pub accrued_micro_usd: u64,
}

/// `PublicBox.desktop`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub ready: bool,
    pub viewers: u32,
    pub width: u32,
    pub height: u32,
}

/// The fields of `PublicBox` Core reads.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxView {
    pub id: String,
    pub status: BoxStatus,
    pub size: BoxSize,
    /// `PublicBox.placement`, kept as JSON for display.
    #[serde(default)]
    pub placement: Option<Value>,
    #[serde(default)]
    pub desktop: Option<DesktopState>,
    #[serde(default)]
    pub running_since: Option<String>,
    /// `PublicBox.billing`: how the current running interval is billed;
    /// absent while not running, and from an older Box service.
    #[serde(default)]
    pub billing: Option<BoxStartBilling>,
}

impl BoxView {
    /// Whether the Box service waived the per-start minimum of the current
    /// start (a resume onto the Box's own parked VM inside the provider hour
    /// already paid for). False when it did not say so.
    pub fn minimum_waived(&self) -> bool {
        self.billing
            .as_ref()
            .is_some_and(|billing| billing.minimum_waived)
    }

    /// The Box service's signed waiver of the current start's per-start
    /// minimum, which Core forwards on the run's ticks so the Gateway can
    /// verify it. `None` unless the start was waived and the waiver signed (a
    /// Box service without `RYU_BOX_MINIMUM_WAIVER_KEY` never waives a Core
    /// tenant's start).
    pub fn minimum_waiver(&self) -> Option<String> {
        self.billing
            .as_ref()
            .filter(|billing| billing.minimum_waived)
            .and_then(|billing| billing.waiver.clone())
    }
}

/// `PublicBox.billing`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxStartBilling {
    /// True when this start owes no per-start minimum (whole minutes only).
    pub minimum_waived: bool,
    /// End of the provider hour the waiver holds within; null when none.
    #[serde(default)]
    pub paid_hour_ends_at: Option<String>,
    /// The waiver signed for the Gateway (`bw1.…`), on a Core-tenant Box.
    #[serde(default)]
    pub waiver: Option<String>,
}

/// `GET /v1/limits`, as far as Core reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoxLimits {
    pub running: u32,
    pub max_running: u32,
    pub stored: u32,
    pub max_stored: u32,
}

#[cfg(test)]
mod tests;
