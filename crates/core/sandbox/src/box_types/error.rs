//! Box service failures, typed by what Core does about them, and the parser
//! that classifies a non-success Box service response.

use std::fmt;

use reqwest::header::HeaderMap;
use serde_json::Value;

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

#[cfg(test)]
mod tests;
