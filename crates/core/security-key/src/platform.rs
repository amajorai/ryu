//! Picks the key backend for the running platform.

use crate::{AssertionArgs, Authenticator, Availability, KeyError, RegistrationArgs};
use ryu_webauthn_relay::RelayCredential;

/// A backend that refuses every ceremony with a reason, used when this build
/// or platform has no way to reach a security key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unavailable {
    pub reason: String,
}

impl Authenticator for Unavailable {
    fn availability(&self) -> Availability {
        Availability {
            available: false,
            platform: std::env::consts::OS.to_owned(),
            reason: Some(self.reason.clone()),
        }
    }

    fn get_assertion(&self, _args: &AssertionArgs) -> Result<RelayCredential, KeyError> {
        Err(KeyError::Unavailable(self.reason.clone()))
    }

    fn make_credential(&self, _args: &RegistrationArgs) -> Result<RelayCredential, KeyError> {
        Err(KeyError::Unavailable(self.reason.clone()))
    }
}

/// The backend for this platform. `parent_window` is the native window
/// handle (an `HWND` on Windows) that the system prompt should attach to;
/// other platforms ignore it.
#[must_use]
pub fn platform_authenticator(parent_window: Option<isize>) -> Box<dyn Authenticator> {
    #[cfg(all(feature = "native", any(target_os = "linux", target_os = "macos")))]
    {
        let _ = parent_window;
        Box::new(crate::hid::HidAuthenticator)
    }
    #[cfg(all(feature = "native", windows))]
    {
        Box::new(crate::windows_api::WindowsAuthenticator::new(parent_window))
    }
    #[cfg(not(all(
        feature = "native",
        any(target_os = "linux", target_os = "macos", windows)
    )))]
    {
        let _ = parent_window;
        Box::new(Unavailable {
            reason: if cfg!(feature = "native") {
                "security keys are not supported on this platform".to_owned()
            } else {
                "this build has no security key support".to_owned()
            },
        })
    }
}

#[cfg(test)]
#[path = "platform_tests.rs"]
mod tests;
