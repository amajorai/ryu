//! Wire contract for relaying a WebAuthn ceremony from a remote browser (a VM,
//! cloud node, or hidden Bot lane) to a hardware security key plugged into the
//! user's own desktop.
//!
//! Three parties share these types:
//!
//! 1. The browser host (the `@ryu/browser` sidecar) intercepts
//!    `navigator.credentials.get/create` and builds `clientDataJSON` itself
//!    from the tab's real top-level origin. It sends a [`RelayRequest`] to the
//!    Core it runs under.
//! 2. That Core holds the request as a [`PendingRelayRequest`] until the
//!    owning user's desktop answers with a [`RelayDecision`], and returns a
//!    [`RelayOutcome`] to the browser host.
//! 3. The desktop shows the site to the user and runs a native CTAP2 or
//!    platform request against the key, using the rpId and the hash of the
//!    relayed `clientDataJSON`.
//!
//! Every party re-runs [`validate_relay`] so no hop trusts the one before it.

mod validate;

pub use validate::{
    b64url_decode, b64url_encode, client_data_hash, validate_client_data, validate_relay,
    validate_rp_id, ClientData, ValidatedRelay,
};

use serde::{Deserialize, Serialize};

/// Host API capability the browser sidecar calls on its Core.
pub const HOST_CAPABILITY: &str = "securityKey.request";
/// Manifest grant that allows a plugin to call [`HOST_CAPABILITY`].
pub const GRANT: &str = "security-key:relay";
/// Longest a request may wait for the user before it is refused.
pub const MAX_TIMEOUT_MS: u64 = 120_000;
/// Default wait when the page does not ask for one.
pub const DEFAULT_TIMEOUT_MS: u64 = 60_000;
/// Smallest wait Core honours, so a page cannot ask for a zero-length prompt.
pub const MIN_TIMEOUT_MS: u64 = 10_000;
/// Upper bound on the serialized `options` object.
pub const MAX_OPTIONS_BYTES: usize = 16 * 1024;
/// Upper bound on the decoded `clientDataJSON`.
pub const MAX_CLIENT_DATA_BYTES: usize = 4 * 1024;

/// Which WebAuthn call the page made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CeremonyKind {
    /// `navigator.credentials.get` (sign in).
    Get,
    /// `navigator.credentials.create` (register a key).
    Create,
}

impl CeremonyKind {
    /// The `type` member that `clientDataJSON` must carry.
    #[must_use]
    pub const fn client_data_type(self) -> &'static str {
        match self {
            Self::Get => "webauthn.get",
            Self::Create => "webauthn.create",
        }
    }
}

/// Browser host to Core: a page in a tab asked for a security-key ceremony.
///
/// Binary fields are base64url without padding. `options` is the page's
/// `publicKey` options with every buffer already base64url-encoded (the same
/// shape `PublicKeyCredential.parseRequestOptionsFromJSON` accepts).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RelayRequest {
    pub kind: CeremonyKind,
    /// The Bot lane the tab belongs to; `None` is the user's visible lane.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Full URL of the tab's top-level document when the call was made.
    pub page_url: String,
    /// Serialized origin of `page_url` (`https://example.com`).
    pub origin: String,
    /// Effective relying party id (the page's explicit `rpId`, or its host).
    pub rp_id: String,
    /// `clientDataJSON` exactly as the browser host built it, base64url.
    pub client_data_json: String,
    pub options: serde_json::Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

/// Core to desktop: a request waiting for the user.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingRelayRequest {
    pub id: String,
    pub kind: CeremonyKind,
    pub agent_id: Option<String>,
    pub page_url: String,
    pub origin: String,
    pub rp_id: String,
    pub client_data_json: String,
    pub options: serde_json::Value,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
}

/// The authenticator's answer, base64url throughout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CredentialResponse {
    /// Result of `get`.
    Assertion {
        authenticator_data: String,
        signature: String,
        #[serde(default)]
        user_handle: Option<String>,
    },
    /// Result of `create`.
    Attestation {
        attestation_object: String,
        #[serde(default)]
        transports: Vec<String>,
    },
}

/// A credential returned by the user's key. `client_data_json` is not
/// repeated: the browser host already holds the bytes it built.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelayCredential {
    /// Credential id, base64url.
    pub id: String,
    pub response: CredentialResponse,
}

impl RelayCredential {
    /// Whether this credential answers a ceremony of `kind`.
    #[must_use]
    pub fn matches(&self, kind: CeremonyKind) -> bool {
        matches!(
            (&self.response, kind),
            (CredentialResponse::Assertion { .. }, CeremonyKind::Get)
                | (CredentialResponse::Attestation { .. }, CeremonyKind::Create)
        )
    }
}

/// Desktop to Core: the user's answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case")]
pub enum RelayDecision {
    Approve {
        credential: RelayCredential,
    },
    Deny {
        #[serde(default)]
        reason: Option<String>,
    },
}

/// Core to browser host: how the ceremony ended. Anything but `Ok` makes the
/// page's promise reject with `NotAllowedError`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RelayOutcome {
    Ok {
        credential: RelayCredential,
    },
    /// The user denied it, or the key reported an error.
    Denied {
        #[serde(default)]
        reason: Option<String>,
    },
    /// "Allow hardware security key" is off on this node.
    Disabled,
    /// No answer before the deadline.
    Timeout,
    /// The request failed validation.
    Invalid {
        message: String,
    },
}

/// Why a relay was refused during validation.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RelayError {
    #[error("origin is not a secure https origin: {0}")]
    InsecureOrigin(String),
    #[error("rpId {rp_id:?} is not valid for origin {origin:?}")]
    RpIdMismatch { rp_id: String, origin: String },
    #[error("rpId {0:?} is a public suffix")]
    PublicSuffix(String),
    #[error("page_url does not belong to origin {0:?}")]
    PageOriginMismatch(String),
    #[error("clientDataJSON is invalid: {0}")]
    ClientData(String),
    #[error("options are invalid: {0}")]
    Options(String),
}
