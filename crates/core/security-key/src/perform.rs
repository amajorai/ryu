//! Runs one relayed ceremony: re-validate, parse, call the key, and check the
//! key's answer before it leaves the desktop.

use std::time::{SystemTime, UNIX_EPOCH};

use ryu_webauthn_relay::{
    b64url_decode, validate_relay, CeremonyKind, CredentialResponse, PendingRelayRequest,
    RelayCredential, RelayRequest, MAX_TIMEOUT_MS,
};
use sha2::{Digest, Sha256};

use crate::options::{parse_get_options, parse_make_options, CredentialDescriptor, Requirement};
use crate::{AssertionArgs, Authenticator, KeyError, RegistrationArgs};

/// FIDO2 PINs are at least 4 Unicode code points.
pub const PIN_MIN_CHARS: usize = 4;
/// FIDO2 PINs are at most 63 bytes of UTF-8.
pub const PIN_MAX_BYTES: usize = 63;

/// authenticatorData: 32-byte rpIdHash, 1 flags byte, 4-byte counter.
const AUTH_DATA_MIN_BYTES: usize = 37;
const FLAG_USER_PRESENT: u8 = 0x01;
const FLAG_USER_VERIFIED: u8 = 0x04;

/// Check that `pin` could be a FIDO2 PIN before it is sent to the key, so a
/// typo does not cost one of the key's limited attempts.
pub fn validate_pin(pin: &str) -> Result<(), KeyError> {
    if pin.chars().count() < PIN_MIN_CHARS {
        return Err(KeyError::PinFormat(format!(
            "the PIN must be at least {PIN_MIN_CHARS} characters"
        )));
    }
    if pin.len() > PIN_MAX_BYTES {
        return Err(KeyError::PinFormat("the PIN is too long".to_owned()));
    }
    Ok(())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Run `request` against `authenticator`, with the key's PIN when the user
/// supplied one.
///
/// `request.expires_at_ms` is compared with this machine's clock, so the
/// caller must pass a deadline on that clock. Core stamps the deadline with
/// the clock of the node that runs the browser, often another machine; the
/// desktop UI rebases it onto its own clock when the request arrives, and
/// Core's own deadline check stays the authority.
pub fn perform(
    request: &PendingRelayRequest,
    pin: Option<String>,
    authenticator: &dyn Authenticator,
) -> Result<RelayCredential, KeyError> {
    perform_at(request, pin, authenticator, now_ms())
}

fn as_relay_request(request: &PendingRelayRequest) -> RelayRequest {
    RelayRequest {
        kind: request.kind,
        agent_id: request.agent_id.clone(),
        page_url: request.page_url.clone(),
        origin: request.origin.clone(),
        rp_id: request.rp_id.clone(),
        client_data_json: request.client_data_json.clone(),
        options: request.options.clone(),
        timeout_ms: None,
    }
}

/// [`perform`] with an explicit clock, for tests.
pub fn perform_at(
    request: &PendingRelayRequest,
    pin: Option<String>,
    authenticator: &dyn Authenticator,
    now_ms: u64,
) -> Result<RelayCredential, KeyError> {
    if now_ms >= request.expires_at_ms {
        return Err(KeyError::Expired);
    }
    let validated = validate_relay(&as_relay_request(request))
        .map_err(|error| KeyError::Invalid(error.to_string()))?;
    let pin = pin.filter(|pin| !pin.is_empty());
    if let Some(pin) = &pin {
        validate_pin(pin)?;
    }
    let availability = authenticator.availability();
    if !availability.available {
        return Err(KeyError::Unavailable(availability.reason.unwrap_or_else(
            || "no security key backend on this desktop".to_owned(),
        )));
    }
    let client_data_json = b64url_decode(&request.client_data_json)
        .map_err(|_| KeyError::Invalid("clientDataJSON is not base64url".to_owned()))?;
    let timeout_ms = (request.expires_at_ms - now_ms).min(MAX_TIMEOUT_MS);
    match request.kind {
        CeremonyKind::Get => {
            let args = AssertionArgs {
                rp_id: request.rp_id.clone(),
                origin: request.origin.clone(),
                client_data_json,
                client_data_hash: validated.client_data_hash,
                options: parse_get_options(&request.options)?,
                timeout_ms,
                pin,
            };
            let credential = authenticator.get_assertion(&args)?;
            check_assertion(&credential, &args)?;
            Ok(credential)
        }
        CeremonyKind::Create => {
            let args = RegistrationArgs {
                rp_id: request.rp_id.clone(),
                origin: request.origin.clone(),
                client_data_json,
                client_data_hash: validated.client_data_hash,
                options: parse_make_options(&request.options)?,
                timeout_ms,
                pin,
            };
            let credential = authenticator.make_credential(&args)?;
            check_attestation(&credential, &args.options.exclude_credentials)?;
            Ok(credential)
        }
    }
}

fn device(message: &str) -> KeyError {
    KeyError::Device(message.to_owned())
}

fn decode_non_empty(text: &str, what: &str) -> Result<Vec<u8>, KeyError> {
    b64url_decode(text)
        .ok()
        .filter(|bytes| !bytes.is_empty())
        .ok_or_else(|| device(&format!("the key returned an empty or malformed {what}")))
}

fn listed(list: &[CredentialDescriptor], id: &[u8]) -> bool {
    list.iter().any(|descriptor| descriptor.id == id)
}

/// The key must answer for this rpId, with a credential the site allowed,
/// and with the presence and verification flags the site asked for.
fn check_assertion(credential: &RelayCredential, args: &AssertionArgs) -> Result<(), KeyError> {
    let CredentialResponse::Assertion {
        authenticator_data,
        signature,
        ..
    } = &credential.response
    else {
        return Err(device("the key answered a sign-in with a registration"));
    };
    let id = decode_non_empty(&credential.id, "credential id")?;
    let allowed = &args.options.allow_credentials;
    if !allowed.is_empty() && !listed(allowed, &id) {
        return Err(device(
            "the key signed with a credential the site did not allow",
        ));
    }
    decode_non_empty(signature, "signature")?;
    let auth_data = decode_non_empty(authenticator_data, "authenticator data")?;
    if auth_data.len() < AUTH_DATA_MIN_BYTES {
        return Err(device("the key returned truncated authenticator data"));
    }
    let rp_id_hash: [u8; 32] = Sha256::digest(args.rp_id.as_bytes()).into();
    if auth_data[..32] != rp_id_hash {
        return Err(device("the key signed for a different site"));
    }
    let flags = auth_data[32];
    if flags & FLAG_USER_PRESENT == 0 {
        return Err(device("the key did not confirm a touch"));
    }
    if args.options.user_verification == Requirement::Required && flags & FLAG_USER_VERIFIED == 0 {
        return Err(device("the key did not verify the user"));
    }
    Ok(())
}

fn check_attestation(
    credential: &RelayCredential,
    excluded: &[CredentialDescriptor],
) -> Result<(), KeyError> {
    let CredentialResponse::Attestation {
        attestation_object, ..
    } = &credential.response
    else {
        return Err(device("the key answered a registration with a sign-in"));
    };
    let id = decode_non_empty(&credential.id, "credential id")?;
    if listed(excluded, &id) {
        return Err(KeyError::CredentialExcluded);
    }
    decode_non_empty(attestation_object, "attestation object")?;
    Ok(())
}

#[cfg(test)]
#[path = "perform_tests.rs"]
mod tests;
