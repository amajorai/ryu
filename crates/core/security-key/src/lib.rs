//! Runs a relayed WebAuthn ceremony against a roaming hardware security key
//! plugged into the user's desktop.
//!
//! A remote browser (VM, cloud node, or hidden Bot lane) relays a page's
//! `navigator.credentials.get/create` call to the user's Core as a
//! [`PendingRelayRequest`]. The desktop shows it to the user and, on approval,
//! calls [`perform`] with the platform [`Authenticator`] from
//! [`platform_authenticator`]. [`perform`] re-runs
//! [`ryu_webauthn_relay::validate_relay`], parses the relayed options, runs
//! the ceremony, and checks the key's answer before it goes back to Core.
//!
//! Backends (feature `native`):
//! - macOS and Linux: CTAP2 over USB HID through Mozilla's `authenticator`
//!   crate with its pure-Rust crypto backend (no NSS or OpenSSL needed).
//! - Windows: `webauthn.dll`, loaded at run time so a system without it
//!   reports the key as unavailable instead of failing to start. Windows
//!   draws its own touch and PIN prompts, so it never returns `pin_required`.
//!
//! Only roaming keys are reachable. Platform authenticators (Touch ID,
//! Windows Hello, synced passkeys) are refused.
//!
//! Errors carry a stable leading code (see [`KeyError`]): `pin_required`
//! means the caller should ask for the key's PIN and retry with it.

mod options;
mod perform;
mod platform;

#[cfg(all(feature = "native", any(target_os = "linux", target_os = "macos")))]
mod hid;
#[cfg(all(feature = "native", windows))]
mod windows_api;

pub use options::{
    parse_get_options, parse_make_options, Attestation, CredentialDescriptor, GetOptions,
    MakeOptions, Requirement, UserEntity,
};
pub use perform::{perform, perform_at, validate_pin, PIN_MAX_BYTES, PIN_MIN_CHARS};
pub use platform::{platform_authenticator, Unavailable};
pub use ryu_webauthn_relay::{PendingRelayRequest, RelayCredential};

use serde::Serialize;

/// Whether this desktop can run a ceremony at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Availability {
    pub available: bool,
    /// `macos`, `linux`, `windows`, or the target OS name.
    pub platform: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Everything `get_assertion` needs, already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssertionArgs {
    pub rp_id: String,
    pub origin: String,
    /// The relayed `clientDataJSON` bytes (Windows signs over these itself).
    pub client_data_json: Vec<u8>,
    /// SHA-256 of `client_data_json` (CTAP2 signs over this).
    pub client_data_hash: [u8; 32],
    pub options: GetOptions,
    /// How long the key may wait for a touch.
    pub timeout_ms: u64,
    pub pin: Option<String>,
}

/// Everything `make_credential` needs, already validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistrationArgs {
    pub rp_id: String,
    pub origin: String,
    pub client_data_json: Vec<u8>,
    pub client_data_hash: [u8; 32],
    pub options: MakeOptions,
    pub timeout_ms: u64,
    pub pin: Option<String>,
}

/// A security key backend. Calls block until the key answers, the user
/// cancels, or `timeout_ms` passes, so run them off the async runtime.
pub trait Authenticator: Send + Sync {
    fn availability(&self) -> Availability;
    /// Sign in (`navigator.credentials.get`).
    fn get_assertion(&self, args: &AssertionArgs) -> Result<RelayCredential, KeyError>;
    /// Register (`navigator.credentials.create`).
    fn make_credential(&self, args: &RegistrationArgs) -> Result<RelayCredential, KeyError>;
}

/// Why a ceremony did not produce a credential. `Display` starts with a
/// stable snake_case code the desktop UI matches on.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
    /// The key needs its PIN; retry with one.
    #[error("pin_required")]
    PinRequired,
    /// The PIN was wrong; retry with another one.
    #[error("pin_required: wrong PIN{}", retries_suffix(*.retries))]
    PinInvalid { retries: Option<u8> },
    /// The supplied PIN cannot be a valid FIDO2 PIN.
    #[error("pin_required: {0}")]
    PinFormat(String),
    #[error("pin_blocked: {0}")]
    PinBlocked(String),
    #[error("pin_not_set: this key has no PIN, but the site requires user verification")]
    PinNotSet,
    #[error("cancelled")]
    Cancelled,
    #[error("timeout: no security key answered in time")]
    Timeout,
    #[error("expired: the request is no longer waiting")]
    Expired,
    #[error("credential_excluded: this key is already registered with the site")]
    CredentialExcluded,
    #[error("no_credentials: this key has no sign-in for the site")]
    NoCredentials,
    #[error("unavailable: {0}")]
    Unavailable(String),
    #[error("unsupported: {0}")]
    Unsupported(String),
    #[error("invalid: {0}")]
    Invalid(String),
    #[error("device: {0}")]
    Device(String),
}

fn retries_suffix(retries: Option<u8>) -> String {
    match retries {
        Some(1) => " (1 attempt left)".to_owned(),
        Some(left) => format!(" ({left} attempts left)"),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests;
