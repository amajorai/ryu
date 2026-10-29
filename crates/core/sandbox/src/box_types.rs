//! Wire types shared by Core and the Ryu Box service for session Boxes.
//!
//! These mirror the TypeScript contracts in `apps/box/src/contracts.ts` and
//! `apps/box/src/response-contract.ts` (design `docs/box-per-session-desktop.md`
//! §2.3, §6 and §7). The HTTP client that uses them is
//! [`crate::box_session::BoxSessionClient`].

use std::fmt;
use std::str::FromStr;

use reqwest::header::HeaderMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::spec::{GpuKind, OsKind, SandboxSpec};

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

/// A Box API failure, typed by what Core does about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BoxApiError {
    /// Every placement tier failed (`503 capacity_unavailable`). Retry after
    /// `retry_after` seconds; the Box's stored state is untouched.
    Capacity { retry_after: u64 },
    /// An admission limit refused the request (`429 quota_exceeded`).
    Quota,
    /// The tenant has no credit (`402 insufficient_credits`).
    InsufficientCredits,
    /// The Box does not exist for this tenant (`404`).
    NotFound,
    /// The route is not for this tenant's billing owner
    /// (`403 billing_owner_mismatch`).
    BillingOwnerMismatch,
    /// Any other failure.
    Http {
        status: u16,
        code: String,
        message: String,
    },
}

impl BoxApiError {
    /// The HTTP status the error came with.
    pub fn status(&self) -> u16 {
        match self {
            Self::Capacity { .. } => 503,
            Self::Quota => 429,
            Self::InsufficientCredits => 402,
            Self::NotFound => 404,
            Self::BillingOwnerMismatch => 403,
            Self::Http { status, .. } => *status,
        }
    }

    /// The Box service error code.
    pub fn code(&self) -> &str {
        match self {
            Self::Capacity { .. } => "capacity_unavailable",
            Self::Quota => "quota_exceeded",
            Self::InsufficientCredits => "insufficient_credits",
            Self::NotFound => "not_found",
            Self::BillingOwnerMismatch => "billing_owner_mismatch",
            Self::Http { code, .. } => code,
        }
    }

    /// A transport failure, before any HTTP status arrived.
    pub fn transport(message: impl Into<String>) -> Self {
        Self::Http {
            status: 0,
            code: "transport".to_owned(),
            message: truncate(&message.into(), MAX_ERROR_MESSAGE_CHARS),
        }
    }
}

impl fmt::Display for BoxApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Capacity { retry_after } => write!(
                formatter,
                "no Box capacity is available right now; retry in {retry_after} s"
            ),
            Self::Quota => formatter.write_str("the Box admission limit was reached"),
            Self::InsufficientCredits => {
                formatter.write_str("there are not enough credits to run a Box")
            }
            Self::NotFound => formatter.write_str("the Box was not found"),
            Self::BillingOwnerMismatch => formatter
                .write_str("this Box route is not available for the tenant's billing owner"),
            Self::Http {
                status,
                code,
                message,
            } => write!(formatter, "Box API failed ({status} {code}): {message}"),
        }
    }
}

impl std::error::Error for BoxApiError {}

/// Retry delay used when a capacity refusal carries no usable `Retry-After`.
pub const DEFAULT_CAPACITY_RETRY_SECS: u64 = 30;
/// Longest retry delay Core honours from a `Retry-After` header.
pub const MAX_CAPACITY_RETRY_SECS: u64 = 3600;
const MAX_ERROR_MESSAGE_CHARS: usize = 512;

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let mut out: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

fn retry_after_secs(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

/// The `{code, message}` a Box service error body carries, in either its
/// top-level or nested `error` form.
fn error_fields(body: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(body) else {
        return (None, None);
    };
    let field = |name: &str| -> Option<String> {
        value
            .get(name)
            .and_then(Value::as_str)
            .or_else(|| {
                value
                    .get("error")
                    .and_then(|error| error.get(name))
                    .and_then(Value::as_str)
            })
            .map(str::to_owned)
    };
    (field("code"), field("message"))
}

/// Classify a non-success Box service response.
///
/// A `503` that names `capacity_unavailable` or carries `Retry-After` is
/// [`BoxApiError::Capacity`]; the delay is read from `Retry-After` (seconds),
/// clamped to an hour, and defaults to 30 s.
pub fn parse_box_error(status: u16, headers: &HeaderMap, body: &str) -> BoxApiError {
    let (code, message) = error_fields(body);
    let retry_after = retry_after_secs(headers);
    let code_is = |expected: &str| code.as_deref() == Some(expected);
    if code_is("capacity_unavailable") || (status == 503 && retry_after.is_some()) {
        return BoxApiError::Capacity {
            retry_after: retry_after
                .unwrap_or(DEFAULT_CAPACITY_RETRY_SECS)
                .clamp(1, MAX_CAPACITY_RETRY_SECS),
        };
    }
    if code_is("billing_owner_mismatch") {
        return BoxApiError::BillingOwnerMismatch;
    }
    if status == 402 || code_is("insufficient_credits") {
        return BoxApiError::InsufficientCredits;
    }
    if status == 404 || code_is("not_found") {
        return BoxApiError::NotFound;
    }
    if code_is("quota_exceeded") {
        return BoxApiError::Quota;
    }
    let message = message.unwrap_or_else(|| body.trim().to_owned());
    BoxApiError::Http {
        status,
        code: code.unwrap_or_else(|| format!("http_{status}")),
        message: truncate(&message, MAX_ERROR_MESSAGE_CHARS),
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
mod tests {
    use super::*;
    use reqwest::header::{HeaderValue, RETRY_AFTER};
    use serde_json::json;

    #[test]
    fn box_types_size_serde_is_the_wire_name() {
        for (size, name) in [
            (BoxSize::Small, "small"),
            (BoxSize::Default, "default"),
            (BoxSize::Large, "large"),
        ] {
            assert_eq!(serde_json::to_value(size).unwrap(), json!(name));
            assert_eq!(
                serde_json::from_value::<BoxSize>(json!(name)).unwrap(),
                size
            );
            assert_eq!(name.parse::<BoxSize>().unwrap(), size);
            assert_eq!(size.to_string(), name);
        }
        assert!(serde_json::from_value::<BoxSize>(json!("huge")).is_err());
        assert!("cpx22".parse::<BoxSize>().is_err());
        assert_eq!(BoxSize::default(), BoxSize::Small);
    }

    #[test]
    fn box_types_spec_for_matches_the_box_service_size_limits() {
        let shapes: Vec<_> = BoxSize::ALL
            .iter()
            .map(|size| {
                let spec = spec_for(*size);
                assert_eq!(spec.gpu, GpuKind::None);
                assert_eq!(spec.gpu_count, 0);
                assert_eq!(spec.os, OsKind::Linux);
                (spec.vcpu, spec.mem_gib, spec.storage_gib)
            })
            .collect();
        assert_eq!(shapes, vec![(2, 4, 40), (4, 8, 80), (8, 16, 100)]);
        let units: Vec<_> = BoxSize::ALL
            .iter()
            .map(|size| size.resource_units())
            .collect();
        assert_eq!(units, vec![1, 2, 4]);
    }

    #[test]
    fn box_types_spec_for_agrees_with_the_box_service_source() {
        // The Box service's SIZE_LIMITS and storage allowance are the other half
        // of this contract; read them so the two cannot drift silently.
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let docker = std::fs::read_to_string(root.join("apps/box/src/drivers/docker.ts"))
            .expect("read docker.ts");
        let contracts = std::fs::read_to_string(root.join("apps/box/src/contracts.ts"))
            .expect("read contracts.ts");
        for size in BoxSize::ALL {
            let spec = spec_for(size);
            let block_start = docker
                .find("export const SIZE_LIMITS")
                .expect("SIZE_LIMITS is defined");
            let block = &docker[block_start..];
            let entry = &block[block.find(&format!("{}: {{", size.as_str())).unwrap()..];
            let entry = &entry[..entry.find('}').unwrap()];
            assert!(
                entry.contains(&format!("cpus: \"{}\"", spec.vcpu)),
                "{size} vCPU drifted: {entry}"
            );
            assert!(
                entry.contains(&format!("memory: \"{}g\"", spec.mem_gib)),
                "{size} memory drifted: {entry}"
            );
            let allowance_start = contracts
                .find("export const BOX_STORAGE_ALLOWANCE_GIB")
                .expect("storage allowance is defined");
            let allowance = &contracts[allowance_start..];
            let allowance = &allowance[..allowance.find("};").unwrap()];
            assert!(
                allowance.contains(&format!("{}: {},", size.as_str(), spec.storage_gib)),
                "{size} storage drifted: {allowance}"
            );
        }
    }

    #[test]
    fn box_types_park_reason_and_status_serde() {
        for (reason, name) in [
            (ParkReason::User, "user"),
            (ParkReason::Idle, "idle"),
            (ParkReason::Balance, "balance"),
            (ParkReason::Budget, "budget"),
            (ParkReason::Liveness, "liveness"),
            (ParkReason::Suspended, "suspended"),
            (ParkReason::Ttl, "ttl"),
        ] {
            assert_eq!(serde_json::to_value(reason).unwrap(), json!(name));
            assert_eq!(reason.as_str(), name);
        }
        assert_eq!(
            serde_json::from_value::<BoxStatus>(json!("stopping")).unwrap(),
            BoxStatus::Stopping
        );
        assert_eq!(
            serde_json::from_value::<BoxStatus>(json!("hibernating")).unwrap(),
            BoxStatus::Unknown
        );
        assert!(BoxStatus::Ready.is_live() && !BoxStatus::Stopping.is_live());
        assert!(BoxStatus::Stopped.is_settled() && !BoxStatus::Stopping.is_settled());
    }

    fn headers(retry_after: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(value) = retry_after {
            headers.insert(RETRY_AFTER, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    fn body(code: &str, message: &str) -> String {
        json!({
            "code": code,
            "error": { "code": code, "message": message, "status": 0 },
            "message": message,
            "ok": false,
            "type": "box.error",
        })
        .to_string()
    }

    #[test]
    fn box_types_parse_box_error_maps_capacity_with_retry_after() {
        assert_eq!(
            parse_box_error(
                503,
                &headers(Some("30")),
                &body("capacity_unavailable", "full")
            ),
            BoxApiError::Capacity { retry_after: 30 }
        );
        // Any 503 with Retry-After is capacity, even without the code.
        assert_eq!(
            parse_box_error(503, &headers(Some("12")), "Service Unavailable"),
            BoxApiError::Capacity { retry_after: 12 }
        );
        // The code alone is enough; the delay then defaults, and huge delays clamp.
        assert_eq!(
            parse_box_error(503, &headers(None), &body("capacity_unavailable", "full")),
            BoxApiError::Capacity {
                retry_after: DEFAULT_CAPACITY_RETRY_SECS
            }
        );
        assert_eq!(
            parse_box_error(
                503,
                &headers(Some("999999")),
                &body("capacity_unavailable", "x")
            ),
            BoxApiError::Capacity {
                retry_after: MAX_CAPACITY_RETRY_SECS
            }
        );
        // An HTTP-date Retry-After is not seconds; the default applies.
        assert_eq!(
            parse_box_error(
                503,
                &headers(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
                &body("capacity_unavailable", "x")
            ),
            BoxApiError::Capacity {
                retry_after: DEFAULT_CAPACITY_RETRY_SECS
            }
        );
    }

    #[test]
    fn box_types_parse_box_error_maps_typed_refusals() {
        let none = headers(None);
        assert_eq!(
            parse_box_error(429, &none, &body("quota_exceeded", "limit")),
            BoxApiError::Quota
        );
        assert_eq!(
            parse_box_error(402, &none, &body("insufficient_credits", "top up")),
            BoxApiError::InsufficientCredits
        );
        assert_eq!(
            parse_box_error(402, &none, ""),
            BoxApiError::InsufficientCredits
        );
        assert_eq!(
            parse_box_error(404, &none, &body("not_found", "Box not found.")),
            BoxApiError::NotFound
        );
        assert_eq!(
            parse_box_error(403, &none, &body("billing_owner_mismatch", "core tenant")),
            BoxApiError::BillingOwnerMismatch
        );
        // A plain 503 without Retry-After or the code is not capacity.
        let other = parse_box_error(503, &none, &body("driver_unavailable", "docker down"));
        assert_eq!(
            other,
            BoxApiError::Http {
                status: 503,
                code: "driver_unavailable".to_owned(),
                message: "docker down".to_owned(),
            }
        );
        assert_eq!(other.status(), 503);
        assert_eq!(other.code(), "driver_unavailable");
        let unstructured = parse_box_error(500, &none, &"x".repeat(2000));
        match unstructured {
            BoxApiError::Http { code, message, .. } => {
                assert_eq!(code, "http_500");
                assert!(message.chars().count() <= MAX_ERROR_MESSAGE_CHARS + 1);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn box_types_wire_shapes_are_camel_case_and_redact_secrets() {
        let request = DesktopTokenRequest {
            origin: "https://app.ryu.dev".to_owned(),
            sub: "user_1".to_owned(),
            view_only: true,
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            json!({ "scope": "desktop", "origin": "https://app.ryu.dev", "sub": "user_1", "viewOnly": true })
        );
        let credential = SessionCredential {
            gateway_url: "https://gw.ryu.dev".to_owned(),
            key: SecretString::new("gwb1.abc.def"),
            expires_at: "2026-10-19T00:20:00Z".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(&credential).unwrap(),
            json!({ "gatewayUrl": "https://gw.ryu.dev", "key": "gwb1.abc.def", "expiresAt": "2026-10-19T00:20:00Z" })
        );
        let debug = format!("{credential:?}");
        assert!(!debug.contains("gwb1.abc.def"), "{debug}");
        assert_eq!(credential.key.to_string(), "<redacted>");
        assert_eq!(
            serde_json::to_value(KeepaliveRequest {
                tick_index: 3,
                accrued_micro_usd: 1200
            })
            .unwrap(),
            json!({ "tickIndex": 3, "accruedMicroUsd": 1200 })
        );

        let grant: DesktopGrant = serde_json::from_value(json!({
            "mode": "direct",
            "url": "wss://box.ryu.dev/v1/boxes/bx_1/desktop/ws",
            "protocols": ["ryu.box.v1", "ryu.token.t"],
            "expiresAt": "2026-10-19T00:00:30Z",
        }))
        .unwrap();
        assert_eq!(grant.mode, StreamMode::Direct);
        assert_eq!(grant.path, None);
        let relay = DesktopGrant {
            mode: StreamMode::Relay,
            url: None,
            protocols: vec![],
            path: Some("/api/session-boxes/c1/screen/ws".to_owned()),
            expires_at: "2026-10-19T00:00:30Z".to_owned(),
        };
        assert_eq!(
            serde_json::to_value(&relay).unwrap(),
            json!({ "mode": "relay", "protocols": [], "path": "/api/session-boxes/c1/screen/ws", "expiresAt": "2026-10-19T00:00:30Z" })
        );

        let token: DesktopTokenResponse = serde_json::from_value(json!({
            "token": "t", "expiresAt": "2026-10-19T00:00:30Z", "protocols": ["ryu.box.v1", "ryu.token.t"]
        }))
        .unwrap();
        assert_eq!(token.url, None);
        assert!(!format!("{token:?}").contains("\"t\""));
    }

    #[test]
    fn box_types_box_view_reads_public_box_with_and_without_new_fields() {
        let old = json!({
            "allowedHosts": [], "createdAt": "x", "driver": "docker", "envNames": [],
            "id": "bx_1", "image": "ubuntu:24.04", "lastError": null, "name": "box",
            "network": "none", "repo": null, "secrets": [], "size": "default",
            "snapshotId": null, "status": "ready", "stoppedAt": null, "ttlSeconds": 60,
            "updatedAt": "x"
        });
        let view: BoxView = serde_json::from_value(old).unwrap();
        assert_eq!(view.status, BoxStatus::Ready);
        assert_eq!(view.size, BoxSize::Default);
        assert!(view.placement.is_none() && view.desktop.is_none() && view.running_since.is_none());
        assert!(view.billing.is_none() && !view.minimum_waived());

        let new = json!({
            "id": "bx_2", "status": "stopping", "size": "large",
            "placement": { "provider": "hetzner", "location": "hel1", "tier": "hetzner", "serverType": "cx43", "isolation": "vm" },
            "desktop": { "ready": true, "viewers": 2, "width": 1280, "height": 800 },
            "runningSince": "2026-10-19T00:00:00Z"
        });
        let view: BoxView = serde_json::from_value(new).unwrap();
        assert_eq!(view.status, BoxStatus::Stopping);
        assert_eq!(view.desktop.unwrap().viewers, 2);
        assert_eq!(view.placement.unwrap()["serverType"], "cx43");

        let waived: BoxView = serde_json::from_value(json!({
            "id": "bx_3", "status": "ready", "size": "small",
            "billing": { "minimumWaived": true, "paidHourEndsAt": "2026-10-20T11:00:00.000Z" }
        }))
        .unwrap();
        assert!(waived.minimum_waived());
        // Waived but unsigned: nothing the Gateway would honour.
        assert_eq!(waived.minimum_waiver(), None);
        assert_eq!(
            waived.billing.unwrap().paid_hour_ends_at.as_deref(),
            Some("2026-10-20T11:00:00.000Z")
        );
        let signed: BoxView = serde_json::from_value(json!({
            "id": "bx_5", "status": "ready", "size": "small",
            "billing": {
                "minimumWaived": true,
                "paidHourEndsAt": "2026-10-20T11:00:00.000Z",
                "waiver": "bw1.payload.signature"
            }
        }))
        .unwrap();
        assert_eq!(
            signed.minimum_waiver().as_deref(),
            Some("bw1.payload.signature")
        );
        // A waiver on a start that was not waived is never forwarded.
        let stray: BoxView = serde_json::from_value(json!({
            "id": "bx_6", "status": "ready", "size": "small",
            "billing": { "minimumWaived": false, "paidHourEndsAt": null, "waiver": "bw1.a.b" }
        }))
        .unwrap();
        assert_eq!(stray.minimum_waiver(), None);
        let charged: BoxView = serde_json::from_value(json!({
            "id": "bx_4", "status": "ready", "size": "small",
            "billing": { "minimumWaived": false, "paidHourEndsAt": null }
        }))
        .unwrap();
        assert!(!charged.minimum_waived());

        let limits: BoxLimits = serde_json::from_value(json!({
            "running": 1, "maxRunning": 3, "stored": 2, "maxStored": 20,
            "resourceUnits": 2, "maxResourceUnits": 6
        }))
        .unwrap();
        assert_eq!(limits.max_running, 3);
        assert_eq!(limits.max_stored, 20);
    }
}
