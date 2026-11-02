use super::*;

fn no_signal() -> PinSignal {
    PinSignal::default()
}

#[test]
fn pin_prompts_seen_by_the_watcher_win_over_the_cancel_they_cause() {
    let signal = no_signal();
    record(&signal, KeyError::PinInvalid { retries: Some(2) });
    let mapped = map_error(AuthenticatorError::CancelledByUser, &signal);
    assert_eq!(mapped, KeyError::PinInvalid { retries: Some(2) });
    assert!(mapped.to_string().starts_with("pin_required"));
    // The signal is consumed, so a later error maps on its own.
    assert_eq!(
        map_error(AuthenticatorError::CancelledByUser, &signal),
        KeyError::Cancelled
    );
}

#[test]
fn crate_errors_map_to_stable_codes() {
    let signal = no_signal();
    let cases = [
        (
            AuthenticatorError::PinError(PinError::PinRequired),
            "pin_required",
        ),
        (
            AuthenticatorError::PinError(PinError::PinBlocked),
            "pin_blocked",
        ),
        (
            AuthenticatorError::PinError(PinError::PinNotSet),
            "pin_not_set",
        ),
        (
            AuthenticatorError::CredentialExcluded,
            "credential_excluded",
        ),
        (
            AuthenticatorError::U2FToken(U2FTokenError::NotAllowed),
            "timeout",
        ),
        (AuthenticatorError::Platform, "unavailable"),
        (
            AuthenticatorError::HIDError(HIDError::Command(CommandError::StatusCode(
                StatusCode::NoCredentials,
                None,
            ))),
            "no_credentials",
        ),
        (
            AuthenticatorError::HIDError(HIDError::Command(CommandError::StatusCode(
                StatusCode::OperationDenied,
                None,
            ))),
            "cancelled",
        ),
        (AuthenticatorError::CryptoError, "device"),
    ];
    for (error, code) in cases {
        let text = map_error(error, &signal).to_string();
        assert!(text.starts_with(code), "{text:?} should start with {code}");
    }
}

#[test]
fn descriptors_keep_ids_and_known_transports() {
    let mapped = descriptors(&[CredentialDescriptor {
        id: vec![1, 2, 3],
        transports: vec!["usb".into(), "hybrid".into(), "nfc".into()],
    }]);
    assert_eq!(mapped.len(), 1);
    assert_eq!(mapped[0].id, vec![1, 2, 3]);
    assert_eq!(mapped[0].transports, vec![Transport::USB, Transport::NFC]);
}

#[test]
fn unknown_algorithms_are_dropped() {
    let mapped = algorithms(&[-7, 12345, -257]);
    let ids: Vec<COSEAlgorithm> = mapped.into_iter().map(|param| param.alg).collect();
    assert_eq!(ids, vec![COSEAlgorithm::ES256, COSEAlgorithm::RS256]);
}
