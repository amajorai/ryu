//! Tauri commands for the security-key relay.
//!
//! A browser on a remote node, VM or hidden Bot lane asks its Core to use the
//! hardware security key plugged into this desktop. The desktop UI lists the
//! pending request from Core, asks the user, and calls these commands to run
//! the ceremony against the key (`ryu-security-key`). Errors are strings that
//! start with a stable snake_case code; `pin_required…` means "ask for the
//! key's PIN and call `security_key_perform_with_pin`".
//!
//! Key calls block until the key is touched or times out, so they run on the
//! blocking pool. One ceremony runs at a time: a second request while the key
//! is busy is refused with a retryable `device:` error instead of racing the
//! first one over the same USB device.

use std::sync::{Mutex, TryLockError};

use ryu_security_key::{
    platform_authenticator, Availability, PendingRelayRequest, RelayCredential,
};

/// Held for the whole ceremony so two prompts never talk to the key at once.
static CEREMONY: Mutex<()> = Mutex::new(());

const BUSY: &str = "device: another security key request is already in progress";

/// The native window handle the system prompt should attach to (Windows
/// draws its own touch and PIN dialogs). Other platforms need none.
fn parent_window(window: &tauri::WebviewWindow) -> Option<isize> {
    #[cfg(windows)]
    {
        window.hwnd().ok().map(|hwnd| hwnd.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

/// Run one ceremony, refusing it while another is in flight.
fn run_ceremony(
    request: &PendingRelayRequest,
    pin: Option<String>,
    parent: Option<isize>,
) -> Result<RelayCredential, String> {
    let _guard = match CEREMONY.try_lock() {
        Ok(guard) => guard,
        // A panicked earlier ceremony leaves no key state behind; carry on.
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => return Err(BUSY.to_owned()),
    };
    let authenticator = platform_authenticator(parent);
    ryu_security_key::perform(request, pin, authenticator.as_ref()).map_err(|e| e.to_string())
}

async fn perform_blocking(
    window: &tauri::WebviewWindow,
    request: PendingRelayRequest,
    pin: Option<String>,
) -> Result<RelayCredential, String> {
    let parent = parent_window(window);
    tauri::async_runtime::spawn_blocking(move || run_ceremony(&request, pin, parent))
        .await
        .map_err(|error| format!("device: the security key task failed: {error}"))?
}

/// Whether this desktop can reach a roaming security key at all.
#[tauri::command]
pub fn security_key_available() -> Availability {
    platform_authenticator(None).availability()
}

/// Run a relayed sign-in or registration against the plugged-in key.
#[tauri::command]
pub async fn security_key_perform(
    window: tauri::WebviewWindow,
    request: PendingRelayRequest,
) -> Result<RelayCredential, String> {
    perform_blocking(&window, request, None).await
}

/// [`security_key_perform`] with the key's PIN, after a `pin_required` error.
#[tauri::command]
pub async fn security_key_perform_with_pin(
    window: tauri::WebviewWindow,
    request: PendingRelayRequest,
    pin: String,
) -> Result<RelayCredential, String> {
    perform_blocking(&window, request, Some(pin)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;
    use serde_json::json;

    /// Tests that touch [`CEREMONY`] run one at a time.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    const CHALLENGE: &str = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

    fn request(expires_at_ms: u64) -> PendingRelayRequest {
        let client_data = format!(
            r#"{{"type":"webauthn.get","challenge":"{CHALLENGE}","origin":"https://example.com","crossOrigin":false}}"#
        );
        serde_json::from_value(json!({
            "id": "req-1",
            "kind": "get",
            "agent_id": null,
            "page_url": "https://example.com/login",
            "origin": "https://example.com",
            "rp_id": "example.com",
            "client_data_json": URL_SAFE_NO_PAD.encode(client_data),
            "options": { "challenge": CHALLENGE, "rpId": "example.com" },
            "created_at_ms": 0,
            "expires_at_ms": expires_at_ms,
        }))
        .expect("the desktop wire shape deserializes")
    }

    #[test]
    fn an_expired_request_is_refused_before_the_key_is_touched() {
        let _serial = serial();
        let error = run_ceremony(&request(1), None, None).unwrap_err();
        assert!(error.starts_with("expired"), "{error}");
    }

    #[test]
    fn a_second_ceremony_is_refused_while_one_holds_the_key() {
        let _serial = serial();
        let held = CEREMONY
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let error = run_ceremony(&request(u64::MAX), None, None).unwrap_err();
        drop(held);
        assert_eq!(error, BUSY);
        assert!(error.starts_with("device:"));
    }

    #[test]
    fn availability_serializes_in_the_shape_the_ui_parses() {
        let value = serde_json::to_value(security_key_available()).unwrap();
        assert!(value["available"].is_boolean());
        assert_eq!(value["platform"], std::env::consts::OS);
        if value["available"] == false {
            assert!(value["reason"].is_string());
        }
    }

    #[test]
    fn a_malformed_pin_comes_back_as_pin_required_without_using_a_key_attempt() {
        let _serial = serial();
        let error = run_ceremony(&request(u64::MAX), Some("12".to_owned()), None).unwrap_err();
        assert!(error.starts_with("pin_required"), "{error}");
    }

    #[test]
    fn a_tampered_request_is_refused_as_invalid() {
        let _serial = serial();
        let mut tampered = request(u64::MAX);
        tampered.rp_id = "evil.com".to_owned();
        let error = run_ceremony(&tampered, None, None).unwrap_err();
        assert!(error.starts_with("invalid"), "{error}");
    }
}
