//! On-device confirmation of a Home security action (design §2.4 step 8).
//!
//! The target phone shows the action, runs LocalAuthentication /
//! `BiometricPrompt` (device credential allowed), and signs
//! [`confirm_message`] with its user-presence key, the second key it
//! registered at pairing (`confirm_public_key_spki`). The answer reaches Core
//! on the signed `POST /api/device-tools/confirm`, so it carries two
//! signatures: the device-lane envelope (which device) and this one (a person
//! was present and saw this exact request and input).

use super::identity::{timestamp_fresh, verify_signature};

/// First line of the confirmation string; bump to version the scheme.
pub(crate) const CONFIRM_SCHEME: &str = "ryu-device-confirm-v1";

/// `ryu-device-confirm-v1\n<request_id>\n<input_sha256>\n<option_id>\n<confirmed_at_ms>`.
pub(crate) fn confirm_message(
    request_id: &str,
    input_sha256: &str,
    option_id: &str,
    confirmed_at_ms: i64,
) -> String {
    format!("{CONFIRM_SCHEME}\n{request_id}\n{input_sha256}\n{option_id}\n{confirmed_at_ms}")
}

/// Why a confirmation was refused.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ConfirmError {
    /// The device registered no user-presence key.
    NoConfirmKey,
    /// Missing, stale or forged user-presence signature.
    BadSignature,
}

/// The pieces of one confirmation the phone sent.
pub(crate) struct Confirmation<'a> {
    pub(crate) request_id: &'a str,
    pub(crate) input_sha256: &'a str,
    pub(crate) option_id: &'a str,
    pub(crate) confirmed_at_ms: i64,
    pub(crate) signature: Option<&'a str>,
}

/// Verify the user-presence signature of an approval against the device's
/// confirmation key. A deny needs no biometrics and is always accepted here.
pub(crate) fn verify_confirmation(
    confirmation: &Confirmation<'_>,
    confirm_key: Option<&[u8]>,
    now_ms: i64,
) -> Result<(), ConfirmError> {
    if confirmation.option_id == super::prompts::DENY {
        return Ok(());
    }
    let key = confirm_key.ok_or(ConfirmError::NoConfirmKey)?;
    let signature = confirmation
        .signature
        .filter(|sig| !sig.trim().is_empty())
        .ok_or(ConfirmError::BadSignature)?;
    if !timestamp_fresh(confirmation.confirmed_at_ms, now_ms) {
        return Err(ConfirmError::BadSignature);
    }
    let message = confirm_message(
        confirmation.request_id,
        confirmation.input_sha256,
        confirmation.option_id,
        confirmation.confirmed_at_ms,
    );
    if verify_signature(key, message.as_bytes(), signature) {
        Ok(())
    } else {
        Err(ConfirmError::BadSignature)
    }
}
