//! The shared Ghost error and delivery contract.
//!
//! One vocabulary is used by `ghost-eyes`, the Ghost MCP server and Shadow:
//! an [`ErrorCode`], a [`Delivery`] state describing whether input may have reached
//! the target, and a [`Retry`] hint that is always *derived* from delivery and never
//! stored. Messages never carry typed text or element values.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Machine-readable error code. Serialized as `SCREAMING_SNAKE_CASE`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    StaleRef,
    AmbiguousTarget,
    ElementNotFound,
    ActionNotSupported,
    ActionFailed,
    PolicyDenied,
    PermDenied,
    Timeout,
    InvalidArgs,
    AppNotFound,
    AppUnresponsive,
    PlatformNotSupported,
    UnknownTool,
    Internal,
}

impl ErrorCode {
    /// The wire spelling, e.g. `"STALE_REF"`.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::StaleRef => "STALE_REF",
            Self::AmbiguousTarget => "AMBIGUOUS_TARGET",
            Self::ElementNotFound => "ELEMENT_NOT_FOUND",
            Self::ActionNotSupported => "ACTION_NOT_SUPPORTED",
            Self::ActionFailed => "ACTION_FAILED",
            Self::PolicyDenied => "POLICY_DENIED",
            Self::PermDenied => "PERM_DENIED",
            Self::Timeout => "TIMEOUT",
            Self::InvalidArgs => "INVALID_ARGS",
            Self::AppNotFound => "APP_NOT_FOUND",
            Self::AppUnresponsive => "APP_UNRESPONSIVE",
            Self::PlatformNotSupported => "PLATFORM_NOT_SUPPORTED",
            Self::UnknownTool => "UNKNOWN_TOOL",
            Self::Internal => "INTERNAL",
        }
    }

    /// `NotDelivered` for errors raised before any input was sent; `Unknown` for
    /// `ActionFailed`, `Timeout`, `AppUnresponsive` and `Internal`.
    pub const fn default_delivery(self) -> Delivery {
        match self {
            Self::ActionFailed | Self::Timeout | Self::AppUnresponsive | Self::Internal => {
                Delivery::Unknown
            }
            _ => Delivery::NotDelivered,
        }
    }
}

/// Whether the requested input may have reached the target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Delivery {
    Unknown,
    NotDelivered,
    DeliveryUncertain,
    DeliveredUnverified,
    DeliveredVerified,
}

/// Whether repeating the same call is safe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Retry {
    Safe,
    Unsafe,
    Unknown,
}

impl Delivery {
    /// `NotDelivered` => `Safe`; `Unknown` => `Unknown`; everything else => `Unsafe`.
    pub const fn retry(self) -> Retry {
        match self {
            Self::NotDelivered => Retry::Safe,
            Self::Unknown => Retry::Unknown,
            _ => Retry::Unsafe,
        }
    }

    /// True when input may have reached the target.
    pub const fn maybe_delivered(self) -> bool {
        matches!(
            self,
            Self::DeliveryUncertain | Self::DeliveredUnverified | Self::DeliveredVerified
        )
    }
}

/// Delivery plus the retry hint derived from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Disposition {
    pub delivery: Delivery,
    pub retry: Retry,
}

impl From<Delivery> for Disposition {
    fn from(delivery: Delivery) -> Self {
        Self {
            delivery,
            retry: delivery.retry(),
        }
    }
}

/// A structured Ghost error.
#[derive(Debug, Clone, PartialEq)]
pub struct GhostError {
    pub code: ErrorCode,
    /// Never contains typed text or element values; never starts with a code prefix.
    pub message: String,
    pub delivery: Delivery,
    pub suggestion: Option<String>,
    pub details: Option<Value>,
}

impl GhostError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            delivery: code.default_delivery(),
            suggestion: None,
            details: None,
        }
    }

    #[must_use]
    pub fn with_delivery(mut self, delivery: Delivery) -> Self {
        self.delivery = delivery;
        self
    }

    #[must_use]
    pub fn with_suggestion(mut self, suggestion: impl Into<String>) -> Self {
        self.suggestion = Some(suggestion.into());
        self
    }

    #[must_use]
    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    /// An error raised after earlier input may have been delivered must not claim
    /// `NotDelivered`: upgrade it to `DeliveredUnverified`.
    #[must_use]
    pub fn after_delivery(mut self, prior: Delivery) -> Self {
        if prior.maybe_delivered() && self.delivery == Delivery::NotDelivered {
            self.delivery = Delivery::DeliveredUnverified;
        }
        self
    }

    pub fn disposition(&self) -> Disposition {
        Disposition::from(self.delivery)
    }

    /// `{"code","message","disposition":{"delivery","retry"},"suggestion"?,"details"?}`
    pub fn to_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("code".into(), Value::from(self.code.as_str()));
        obj.insert("message".into(), Value::from(self.message.clone()));
        obj.insert(
            "disposition".into(),
            serde_json::to_value(self.disposition()).unwrap_or(Value::Null),
        );
        if let Some(s) = &self.suggestion {
            obj.insert("suggestion".into(), Value::from(s.clone()));
        }
        if let Some(d) = &self.details {
            obj.insert("details".into(), d.clone());
        }
        Value::Object(obj)
    }

    /// Recovers a `GhostError` carried inside an `anyhow::Error`; any other error
    /// becomes `Internal` with its display text.
    pub fn from_anyhow(e: &anyhow::Error) -> Self {
        match e.downcast_ref::<GhostError>() {
            Some(g) => g.clone(),
            None => Self::internal(e.to_string()),
        }
    }

    pub fn stale_ref(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::StaleRef, msg)
    }

    /// `details = {candidate_count, candidates}`; `candidates` is expected to be an array.
    pub fn ambiguous(msg: impl Into<String>, candidates: Value) -> Self {
        let count = candidates.as_array().map_or(0, Vec::len);
        Self::new(ErrorCode::AmbiguousTarget, msg).with_details(serde_json::json!({
            "candidate_count": count,
            "candidates": candidates,
        }))
    }

    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::ElementNotFound, msg)
    }

    pub fn not_supported(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::ActionNotSupported, msg)
    }

    pub fn policy_denied(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::PolicyDenied, msg)
    }

    pub fn perm_denied(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::PermDenied, msg)
    }

    pub fn invalid_args(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidArgs, msg)
    }

    pub fn timeout(msg: impl Into<String>, delivery: Delivery) -> Self {
        Self::new(ErrorCode::Timeout, msg).with_delivery(delivery)
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, msg)
    }
}

impl std::fmt::Display for GhostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for GhostError {}

impl Serialize for GhostError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}
