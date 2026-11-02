//! macOS and Linux: CTAP2 over USB HID with Mozilla's `authenticator` crate
//! (the library Firefox uses), built with its pure-Rust crypto backend.
//!
//! The crate asks for a PIN through a status channel. A PIN the user already
//! gave is passed in the request; when the key asks for one (or rejects it),
//! the status watcher records that and drops the reply channel, which aborts
//! the ceremony so the desktop can prompt and retry with
//! `security_key_perform_with_pin`.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use authenticator::authenticatorservice::{AuthenticatorService, RegisterArgs, SignArgs};
use authenticator::crypto::COSEAlgorithm;
use authenticator::ctap2::commands::{CommandError, StatusCode};
use authenticator::ctap2::server::{
    AuthenticationExtensionsClientInputs, PublicKeyCredentialDescriptor,
    PublicKeyCredentialParameters, PublicKeyCredentialUserEntity, RelyingParty,
    ResidentKeyRequirement, Transport, UserVerificationRequirement,
};
use authenticator::errors::{AuthenticatorError, HIDError, PinError, U2FTokenError};
use authenticator::statecallback::StateCallback;
use authenticator::{Pin, StatusPinUv, StatusUpdate};
use ryu_webauthn_relay::{b64url_encode, CredentialResponse, RelayCredential};

use crate::options::{Attestation, CredentialDescriptor, Requirement};
use crate::{AssertionArgs, Authenticator, Availability, KeyError, RegistrationArgs};

/// Extra wait past the key's own timeout before the call is abandoned.
const CALLBACK_GRACE: Duration = Duration::from_secs(3);

/// The USB HID backend.
#[derive(Debug, Clone, Copy, Default)]
pub struct HidAuthenticator;

type PinSignal = Arc<Mutex<Option<KeyError>>>;

fn record(signal: &PinSignal, error: KeyError) {
    *signal.lock().unwrap_or_else(PoisonError::into_inner) = Some(error);
}

/// Map the crate's interactive prompts onto [`KeyError`]s. Dropping a PIN
/// sender makes the ceremony fail with `CancelledByUser`.
fn watch_status(updates: Receiver<StatusUpdate>, signal: PinSignal) {
    thread::spawn(move || {
        while let Ok(update) = updates.recv() {
            match update {
                StatusUpdate::PinUvError(StatusPinUv::PinRequired(sender)) => {
                    record(&signal, KeyError::PinRequired);
                    drop(sender);
                }
                StatusUpdate::PinUvError(StatusPinUv::InvalidPin(sender, retries)) => {
                    record(&signal, KeyError::PinInvalid { retries });
                    drop(sender);
                }
                StatusUpdate::PinUvError(StatusPinUv::PinAuthBlocked) => {
                    record(&signal, pin_auth_blocked());
                }
                StatusUpdate::PinUvError(StatusPinUv::PinBlocked) => {
                    record(&signal, pin_blocked());
                }
                StatusUpdate::PinUvError(StatusPinUv::PinNotSet) => {
                    record(&signal, KeyError::PinNotSet);
                }
                // A discoverable sign-in with several accounts on the key:
                // the relay has no account chooser yet, so take the first.
                StatusUpdate::SelectResultNotice(sender, _users) => {
                    let _ = sender.send(Some(0));
                }
                _ => {}
            }
        }
    });
}

fn pin_auth_blocked() -> KeyError {
    KeyError::PinBlocked(
        "too many wrong PINs in a row; unplug the key and plug it in again".to_owned(),
    )
}

fn pin_blocked() -> KeyError {
    KeyError::PinBlocked("the key's PIN is blocked; the key must be reset".to_owned())
}

fn map_status_code(code: &StatusCode) -> Option<KeyError> {
    Some(match code {
        StatusCode::NoCredentials => KeyError::NoCredentials,
        StatusCode::OperationDenied | StatusCode::KeepaliveCancel => KeyError::Cancelled,
        StatusCode::UserActionTimeout | StatusCode::Timeout => KeyError::Timeout,
        StatusCode::UnsupportedAlgorithm => {
            KeyError::Unsupported("the key supports none of the site's algorithms".to_owned())
        }
        StatusCode::CredentialExcluded => KeyError::CredentialExcluded,
        _ => return None,
    })
}

/// Map the crate's final error, preferring what the status watcher saw.
fn map_error(error: AuthenticatorError, signal: &PinSignal) -> KeyError {
    if let Some(seen) = signal.lock().unwrap_or_else(PoisonError::into_inner).take() {
        return seen;
    }
    match error {
        AuthenticatorError::PinError(pin) => match pin {
            PinError::PinRequired => KeyError::PinRequired,
            PinError::InvalidPin(retries) => KeyError::PinInvalid { retries },
            PinError::PinIsTooShort | PinError::PinIsTooLong(_) => {
                KeyError::PinFormat("the key does not accept a PIN of this length".to_owned())
            }
            PinError::PinAuthBlocked => pin_auth_blocked(),
            PinError::PinBlocked => pin_blocked(),
            PinError::PinNotSet => KeyError::PinNotSet,
            other => KeyError::Device(other.to_string()),
        },
        AuthenticatorError::CancelledByUser => KeyError::Cancelled,
        AuthenticatorError::CredentialExcluded => KeyError::CredentialExcluded,
        AuthenticatorError::U2FToken(U2FTokenError::NotAllowed) => KeyError::Timeout,
        AuthenticatorError::HIDError(HIDError::Command(CommandError::StatusCode(code, _))) => {
            map_status_code(&code).unwrap_or_else(|| KeyError::Device(format!("{code:?}")))
        }
        AuthenticatorError::UnsupportedOption(option) => {
            KeyError::Unsupported(format!("the key does not support {option:?}"))
        }
        AuthenticatorError::NoConfiguredTransports | AuthenticatorError::Platform => {
            KeyError::Unavailable(
                "cannot watch for USB security keys (on Linux, check hidraw access)".to_owned(),
            )
        }
        other => KeyError::Device(other.to_string()),
    }
}

fn transport(hint: &str) -> Option<Transport> {
    match hint {
        "usb" => Some(Transport::USB),
        "nfc" => Some(Transport::NFC),
        "ble" => Some(Transport::BLE),
        "internal" => Some(Transport::Internal),
        _ => None,
    }
}

fn descriptors(list: &[CredentialDescriptor]) -> Vec<PublicKeyCredentialDescriptor> {
    list.iter()
        .map(|descriptor| PublicKeyCredentialDescriptor {
            id: descriptor.id.clone(),
            transports: descriptor
                .transports
                .iter()
                .filter_map(|hint| transport(hint))
                .collect(),
        })
        .collect()
}

fn user_verification(requirement: Requirement) -> UserVerificationRequirement {
    match requirement {
        Requirement::Required => UserVerificationRequirement::Required,
        Requirement::Preferred => UserVerificationRequirement::Preferred,
        Requirement::Discouraged => UserVerificationRequirement::Discouraged,
    }
}

fn resident_key(requirement: Requirement) -> ResidentKeyRequirement {
    match requirement {
        Requirement::Required => ResidentKeyRequirement::Required,
        Requirement::Preferred => ResidentKeyRequirement::Preferred,
        Requirement::Discouraged => ResidentKeyRequirement::Discouraged,
    }
}

fn algorithms(ids: &[i64]) -> Vec<PublicKeyCredentialParameters> {
    ids.iter()
        .filter_map(|id| COSEAlgorithm::try_from(*id).ok())
        .map(|alg| PublicKeyCredentialParameters { alg })
        .collect()
}

/// Start a ceremony with `start`, then wait for its callback or the deadline.
fn run<T: Send + 'static>(
    timeout_ms: u64,
    start: impl FnOnce(
        &mut AuthenticatorService,
        std::sync::mpsc::Sender<StatusUpdate>,
        StateCallback<authenticator::Result<T>>,
    ) -> authenticator::Result<()>,
) -> Result<T, KeyError> {
    let mut service = AuthenticatorService::new().map_err(|error| {
        KeyError::Unavailable(format!("cannot start the security key service: {error}"))
    })?;
    service.add_u2f_usb_hid_platform_transports();
    let signal = PinSignal::default();
    let (status_tx, status_rx) = channel();
    watch_status(status_rx, Arc::clone(&signal));
    let (result_tx, result_rx) = channel();
    let callback = StateCallback::new(Box::new(move |result| {
        let _ = result_tx.send(result);
    }));
    start(&mut service, status_tx, callback).map_err(|error| map_error(error, &signal))?;
    let wait = Duration::from_millis(timeout_ms) + CALLBACK_GRACE;
    match result_rx.recv_timeout(wait) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(map_error(error, &signal)),
        Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => {
            let _ = service.cancel();
            Err(KeyError::Timeout)
        }
    }
}

impl Authenticator for HidAuthenticator {
    fn availability(&self) -> Availability {
        Availability {
            available: true,
            platform: std::env::consts::OS.to_owned(),
            reason: None,
        }
    }

    fn get_assertion(&self, args: &AssertionArgs) -> Result<RelayCredential, KeyError> {
        let sign_args = SignArgs {
            client_data_hash: args.client_data_hash,
            origin: args.origin.clone(),
            relying_party_id: args.rp_id.clone(),
            allow_list: descriptors(&args.options.allow_credentials),
            user_verification_req: user_verification(args.options.user_verification),
            user_presence_req: true,
            extensions: AuthenticationExtensionsClientInputs::default(),
            pin: args.pin.as_deref().map(Pin::new),
            use_ctap1_fallback: false,
        };
        let result = run(args.timeout_ms, |service, status, callback| {
            service.sign(args.timeout_ms, sign_args, status, callback)
        })?;
        let assertion = result.assertion;
        // CTAP2.0 keys may omit the credential when exactly one was allowed.
        let id = match (
            assertion.credentials,
            args.options.allow_credentials.as_slice(),
        ) {
            (Some(credential), _) => credential.id,
            (None, [only]) => only.id.clone(),
            (None, _) => {
                return Err(KeyError::Device(
                    "the key did not name its credential".into(),
                ))
            }
        };
        Ok(RelayCredential {
            id: b64url_encode(&id),
            response: CredentialResponse::Assertion {
                authenticator_data: b64url_encode(&assertion.auth_data.to_vec()),
                signature: b64url_encode(&assertion.signature),
                user_handle: assertion
                    .user
                    .map(|user| user.id)
                    .filter(|id| !id.is_empty())
                    .map(|id| b64url_encode(&id)),
            },
        })
    }

    fn make_credential(&self, args: &RegistrationArgs) -> Result<RelayCredential, KeyError> {
        let options = &args.options;
        let pub_cred_params = algorithms(&options.algorithms);
        if pub_cred_params.is_empty() {
            return Err(KeyError::Unsupported(
                "none of the site's algorithms is supported".to_owned(),
            ));
        }
        let register_args = RegisterArgs {
            client_data_hash: args.client_data_hash,
            relying_party: RelyingParty {
                id: args.rp_id.clone(),
                name: options.rp_name.clone(),
            },
            origin: args.origin.clone(),
            user: PublicKeyCredentialUserEntity {
                id: options.user.id.clone(),
                name: options.user.name.clone(),
                display_name: options.user.display_name.clone(),
            },
            pub_cred_params,
            exclude_list: descriptors(&options.exclude_credentials),
            user_verification_req: user_verification(options.user_verification),
            resident_key_req: resident_key(options.resident_key),
            extensions: AuthenticationExtensionsClientInputs::default(),
            pin: args.pin.as_deref().map(Pin::new),
            use_ctap1_fallback: false,
        };
        let mut result = run(args.timeout_ms, |service, status, callback| {
            service.register(args.timeout_ms, register_args, status, callback)
        })?;
        let id = result
            .att_obj
            .auth_data
            .credential_data
            .as_ref()
            .map(|data| data.credential_id.clone())
            .ok_or_else(|| KeyError::Device("the key returned no credential".to_owned()))?;
        // As browsers do: with `attestation: "none"` strip the statement and
        // AAGUID so the site cannot fingerprint the key model.
        if options.attestation == Attestation::None {
            result.att_obj.anonymize();
        }
        let attestation_object = serde_cbor::to_vec(&result.att_obj)
            .map_err(|error| KeyError::Device(format!("cannot encode the attestation: {error}")))?;
        Ok(RelayCredential {
            id: b64url_encode(&id),
            response: CredentialResponse::Attestation {
                attestation_object: b64url_encode(&attestation_object),
                transports: vec!["usb".to_owned()],
            },
        })
    }
}

#[cfg(test)]
#[path = "hid_tests.rs"]
mod tests;
