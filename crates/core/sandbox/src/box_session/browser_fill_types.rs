//! The value types of Box browser fills ([`super::browser_fill`]): what a
//! prepare asks for and answers, the commit value (whose `Debug` never shows
//! it), a fill's status, and a refusal with its echo details.

use super::browser_fill::{BROWSER_FILL_ECHOED, BROWSER_FILL_UNSUPPORTED};
use super::*;

/// The account field a fill types.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserFillField {
    Username,
    Email,
    Password,
    Totp,
}

impl BrowserFillField {
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Username => "username",
            Self::Email => "email",
            Self::Password => "password",
            Self::Totp => "totp",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "username" => Some(Self::Username),
            "email" => Some(Self::Email),
            "password" => Some(Self::Password),
            "totp" => Some(Self::Totp),
            _ => None,
        }
    }
}

/// What a prepare asks the Box to resolve. Hosts are exact DNS names; the
/// daemon compares `page_hosts` exactly, so Core sends `www.` variants itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserFillTarget {
    /// The element reference from `browser.snapshot` (`@e3`).
    pub element_ref: String,
    pub tab_id: Option<String>,
    pub field: BrowserFillField,
    pub page_hosts: Vec<String>,
    pub bind_hosts: Vec<String>,
    /// Login URLs, checked at prepare; the commit must repeat the same set.
    pub submit_urls: Vec<String>,
}

/// A prepared fill: the service's own `fillId` and the page the daemon saw.
#[derive(Clone, Debug, PartialEq)]
pub struct BrowserFillPrepared {
    pub fill_id: String,
    pub page_url: String,
    pub tab: Value,
}

/// The value of a commit, and how the Box types it.
pub enum BrowserFillValue {
    /// A one-time placeholder the sidecar replaces only in a `POST` to one of
    /// `submit_urls` (any path of a bound host when `unbound`).
    Placeholder {
        value: SecretString,
        submit_urls: Vec<String>,
        unbound: bool,
        ttl_seconds: u32,
        submit: bool,
    },
    /// The value typed as plain text (never into a password field).
    Text { value: SecretString, submit: bool },
}

impl fmt::Debug for BrowserFillValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Placeholder {
                submit_urls,
                unbound,
                ttl_seconds,
                submit,
                ..
            } => formatter
                .debug_struct("Placeholder")
                .field("submit_urls", submit_urls)
                .field("unbound", unbound)
                .field("ttl_seconds", ttl_seconds)
                .field("submit", submit)
                .finish_non_exhaustive(),
            Self::Text { submit, .. } => formatter
                .debug_struct("Text")
                .field("submit", submit)
                .finish_non_exhaustive(),
        }
    }
}

/// A committed fill.
#[derive(Clone, Debug, PartialEq)]
pub struct BrowserFillCommitted {
    pub filled: bool,
    /// True for a placeholder fill: the page holds no value.
    pub protected: bool,
    pub tab: Value,
}

/// Where a fill is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserFillState {
    Pending,
    Live,
    Filled,
    Consumed,
    Echoed,
    Expired,
    Revoked,
    Failed,
}

impl BrowserFillState {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "pending" => Self::Pending,
            "live" => Self::Live,
            "filled" => Self::Filled,
            "consumed" => Self::Consumed,
            "echoed" => Self::Echoed,
            "expired" => Self::Expired,
            "revoked" => Self::Revoked,
            "failed" => Self::Failed,
            _ => return None,
        })
    }
}

/// A fill's state, with the request that consumed it or the response that
/// echoed it (method or host and a path without query; never a value).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserFillStatus {
    pub state: BrowserFillState,
    pub consumed: Option<(String, String)>,
    pub echoed: Option<(String, String)>,
}

/// The hosts and fills a `409 browser_fill_echoed` names.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BrowserFillEchoed {
    pub hosts: Vec<String>,
    pub fill_ids: Vec<String>,
}

/// A failed prepare or commit: the Box error, plus the echo details when the
/// service refused with `browser_fill_echoed`.
#[derive(Debug)]
pub struct BrowserFillError {
    pub error: BoxApiError,
    pub echoed: Option<BrowserFillEchoed>,
}

impl BrowserFillError {
    /// The error's code when it is a plain HTTP refusal.
    pub fn code(&self) -> Option<&str> {
        match &self.error {
            BoxApiError::Http { code, .. } => Some(code),
            _ => None,
        }
    }

    /// `browser_fill_unsupported` or `browser_fill_echoed`: this Box cannot
    /// fill safely, as opposed to a conflict or a busy Box.
    pub fn box_cannot_fill(&self) -> bool {
        matches!(
            self.code(),
            Some(BROWSER_FILL_UNSUPPORTED | BROWSER_FILL_ECHOED)
        )
    }
}

impl From<BoxApiError> for BrowserFillError {
    fn from(error: BoxApiError) -> Self {
        Self {
            error,
            echoed: None,
        }
    }
}

impl fmt::Display for BrowserFillError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.error, formatter)
    }
}

impl std::error::Error for BrowserFillError {}
