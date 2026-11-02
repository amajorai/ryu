//! Windows: the system WebAuthn API in `webauthn.dll`.
//!
//! Since Windows 10 1903 only the system API may talk to FIDO keys, so raw HID
//! is not an option. The API takes the whole `clientDataJSON` (it hashes it
//! itself), which is why the relay carries the JSON and not just its hash.
//! Windows draws its own touch and PIN prompts. The library is loaded at run
//! time from System32 so a build without it reports the key as unavailable
//! instead of failing to start. Every ceremony is limited to roaming
//! (cross-platform) authenticators.

use std::sync::OnceLock;

use ryu_webauthn_relay::{b64url_encode, CredentialResponse, RelayCredential};
use windows::core::{s, w, HRESULT, PCSTR, PCWSTR};
use windows::Win32::Foundation::{BOOL, HWND};
use windows::Win32::Networking::WindowsWebServices::*;
use windows::Win32::System::LibraryLoader::{
    GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

use crate::options::{Attestation, CredentialDescriptor, Requirement};
use crate::{AssertionArgs, Authenticator, Availability, KeyError, RegistrationArgs};

type ApiVersionFn = unsafe extern "system" fn() -> u32;
type GetAssertionFn = unsafe extern "system" fn(
    HWND,
    PCWSTR,
    *const WEBAUTHN_CLIENT_DATA,
    *const WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,
    *mut *mut WEBAUTHN_ASSERTION,
) -> HRESULT;
type MakeCredentialFn = unsafe extern "system" fn(
    HWND,
    *const WEBAUTHN_RP_ENTITY_INFORMATION,
    *const WEBAUTHN_USER_ENTITY_INFORMATION,
    *const WEBAUTHN_COSE_CREDENTIAL_PARAMETERS,
    *const WEBAUTHN_CLIENT_DATA,
    *const WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS,
    *mut *mut WEBAUTHN_CREDENTIAL_ATTESTATION,
) -> HRESULT;
type FreeAssertionFn = unsafe extern "system" fn(*const WEBAUTHN_ASSERTION);
type FreeAttestationFn = unsafe extern "system" fn(*const WEBAUTHN_CREDENTIAL_ATTESTATION);
type ErrorNameFn = unsafe extern "system" fn(HRESULT) -> PCWSTR;

/// Entry points resolved from `webauthn.dll`. The library stays loaded for
/// the life of the process, so the pointers stay valid.
struct Api {
    version: u32,
    get_assertion: GetAssertionFn,
    make_credential: MakeCredentialFn,
    free_assertion: FreeAssertionFn,
    free_attestation: FreeAttestationFn,
    error_name: ErrorNameFn,
}

fn load_api() -> Result<Api, String> {
    // SAFETY: loads a system library by name from System32 only, and casts
    // each export to the signature documented in webauthn.h.
    unsafe {
        let module = LoadLibraryExW(w!("webauthn.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32)
            .map_err(|_| "webauthn.dll is not available (Windows 10 1903 or later is required)")?;
        let symbol = |name: PCSTR| {
            GetProcAddress(module, name).ok_or_else(|| "webauthn.dll is missing an entry point")
        };
        let version: ApiVersionFn = std::mem::transmute(symbol(s!("WebAuthNGetApiVersionNumber"))?);
        Ok(Api {
            version: version(),
            get_assertion: std::mem::transmute(symbol(s!("WebAuthNAuthenticatorGetAssertion"))?),
            make_credential: std::mem::transmute(symbol(s!(
                "WebAuthNAuthenticatorMakeCredential"
            ))?),
            free_assertion: std::mem::transmute(symbol(s!("WebAuthNFreeAssertion"))?),
            free_attestation: std::mem::transmute(symbol(s!("WebAuthNFreeCredentialAttestation"))?),
            error_name: std::mem::transmute(symbol(s!("WebAuthNGetErrorName"))?),
        })
    }
}

fn api() -> Result<&'static Api, KeyError> {
    static API: OnceLock<Result<Api, String>> = OnceLock::new();
    API.get_or_init(load_api)
        .as_ref()
        .map_err(|reason| KeyError::Unavailable(reason.clone()))
}

/// The webauthn.dll backend. `parent` is the HWND its dialog attaches to.
#[derive(Debug, Clone, Copy)]
pub struct WindowsAuthenticator {
    parent: Option<isize>,
}

impl WindowsAuthenticator {
    #[must_use]
    pub const fn new(parent: Option<isize>) -> Self {
        Self { parent }
    }

    fn hwnd(&self) -> HWND {
        match self.parent {
            Some(handle) if handle != 0 => HWND(handle as *mut core::ffi::c_void),
            // SAFETY: GetForegroundWindow has no preconditions.
            _ => unsafe { GetForegroundWindow() },
        }
    }
}

/// A NUL-terminated UTF-16 copy of `text`.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn pcwstr(buffer: &[u16]) -> PCWSTR {
    PCWSTR(buffer.as_ptr())
}

fn len_u32(len: usize) -> Result<u32, KeyError> {
    u32::try_from(len).map_err(|_| KeyError::Invalid("a field is too large".to_owned()))
}

fn requirement(value: Requirement) -> u32 {
    match value {
        Requirement::Required => WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
        Requirement::Preferred => WEBAUTHN_USER_VERIFICATION_REQUIREMENT_PREFERRED,
        Requirement::Discouraged => WEBAUTHN_USER_VERIFICATION_REQUIREMENT_DISCOURAGED,
    }
}

fn conveyance(value: Attestation) -> u32 {
    match value {
        Attestation::None => WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
        Attestation::Indirect => WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_INDIRECT,
        Attestation::Direct | Attestation::Enterprise => {
            WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_DIRECT
        }
    }
}

/// `WEBAUTHN_CREDENTIAL` rows pointing into `list`; keep `list` alive.
fn credentials(list: &[CredentialDescriptor]) -> Result<Vec<WEBAUTHN_CREDENTIAL>, KeyError> {
    list.iter()
        .map(|descriptor| {
            Ok(WEBAUTHN_CREDENTIAL {
                dwVersion: WEBAUTHN_CREDENTIAL_CURRENT_VERSION,
                cbId: len_u32(descriptor.id.len())?,
                pbId: descriptor.id.as_ptr().cast_mut(),
                pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
            })
        })
        .collect()
}

fn credential_set(rows: &mut [WEBAUTHN_CREDENTIAL]) -> Result<WEBAUTHN_CREDENTIALS, KeyError> {
    Ok(WEBAUTHN_CREDENTIALS {
        cCredentials: len_u32(rows.len())?,
        pCredentials: if rows.is_empty() {
            std::ptr::null_mut()
        } else {
            rows.as_mut_ptr()
        },
    })
}

/// # Safety
/// `ptr` must point at `len` readable bytes, or be null.
unsafe fn copy_bytes(ptr: *const u8, len: u32) -> Vec<u8> {
    if ptr.is_null() || len == 0 {
        return Vec::new();
    }
    std::slice::from_raw_parts(ptr, len as usize).to_vec()
}

fn transports(used: u32) -> Vec<String> {
    [
        (WEBAUTHN_CTAP_TRANSPORT_USB, "usb"),
        (WEBAUTHN_CTAP_TRANSPORT_NFC, "nfc"),
        (WEBAUTHN_CTAP_TRANSPORT_BLE, "ble"),
        (WEBAUTHN_CTAP_TRANSPORT_HYBRID, "hybrid"),
    ]
    .into_iter()
    .filter(|(flag, _)| used & flag != 0)
    .map(|(_, name)| name.to_owned())
    .collect()
}

const NTE_USER_CANCELLED: u32 = 0x8009_0036;
const NTE_NOT_FOUND: u32 = 0x8009_0011;
const NTE_EXISTS: u32 = 0x8009_000F;
const NTE_NOT_SUPPORTED: u32 = 0x8009_0029;
const HRESULT_ERROR_TIMEOUT: u32 = 0x8007_05B4;
const HRESULT_ERROR_CANCELLED: u32 = 0x8007_04C7;

fn map_hresult(api: &Api, hr: HRESULT) -> KeyError {
    // The HRESULT bit pattern, compared as unsigned.
    match hr.0 as u32 {
        NTE_USER_CANCELLED | HRESULT_ERROR_CANCELLED => KeyError::Cancelled,
        NTE_NOT_FOUND => KeyError::NoCredentials,
        NTE_EXISTS => KeyError::CredentialExcluded,
        HRESULT_ERROR_TIMEOUT => KeyError::Timeout,
        NTE_NOT_SUPPORTED => KeyError::Unsupported("the key does not support this request".into()),
        _ => {
            // SAFETY: WebAuthNGetErrorName returns a static string or null.
            let name = unsafe { (api.error_name)(hr) };
            let name = if name.is_null() {
                String::new()
            } else {
                unsafe { name.to_string() }.unwrap_or_default()
            };
            KeyError::Device(format!("{name} (0x{:08X})", hr.0 as u32))
        }
    }
}

fn client_data(json: &[u8]) -> Result<WEBAUTHN_CLIENT_DATA, KeyError> {
    Ok(WEBAUTHN_CLIENT_DATA {
        dwVersion: WEBAUTHN_CLIENT_DATA_CURRENT_VERSION,
        cbClientDataJSON: len_u32(json.len())?,
        pbClientDataJSON: json.as_ptr().cast_mut(),
        pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
    })
}

impl Authenticator for WindowsAuthenticator {
    fn availability(&self) -> Availability {
        let reason = api().err().map(|error| error.to_string());
        Availability {
            available: reason.is_none(),
            platform: "windows".to_owned(),
            reason,
        }
    }

    fn get_assertion(&self, args: &AssertionArgs) -> Result<RelayCredential, KeyError> {
        let api = api()?;
        let rp_id = wide(&args.rp_id);
        let data = client_data(&args.client_data_json)?;
        let mut allowed = credentials(&args.options.allow_credentials)?;
        let options = WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
            // Version 4 ships with every webauthn.dll; only its fields are set.
            dwVersion: 4,
            dwTimeoutMilliseconds: len_u32(args.timeout_ms as usize)?,
            CredentialList: credential_set(&mut allowed)?,
            dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM,
            dwUserVerificationRequirement: requirement(args.options.user_verification),
            ..Default::default()
        };
        let mut result: *mut WEBAUTHN_ASSERTION = std::ptr::null_mut();
        // SAFETY: every pointer refers to a local that outlives the call.
        let hr = unsafe {
            (api.get_assertion)(self.hwnd(), pcwstr(&rp_id), &data, &options, &mut result)
        };
        if hr.is_err() || result.is_null() {
            return Err(map_hresult(api, hr));
        }
        // SAFETY: `result` is a valid assertion until it is freed below.
        let credential = unsafe {
            let assertion = &*result;
            let id = copy_bytes(assertion.Credential.pbId, assertion.Credential.cbId);
            let auth_data =
                copy_bytes(assertion.pbAuthenticatorData, assertion.cbAuthenticatorData);
            let signature = copy_bytes(assertion.pbSignature, assertion.cbSignature);
            let user = copy_bytes(assertion.pbUserId, assertion.cbUserId);
            (api.free_assertion)(result);
            RelayCredential {
                id: b64url_encode(&id),
                response: CredentialResponse::Assertion {
                    authenticator_data: b64url_encode(&auth_data),
                    signature: b64url_encode(&signature),
                    user_handle: (!user.is_empty()).then(|| b64url_encode(&user)),
                },
            }
        };
        Ok(credential)
    }

    fn make_credential(&self, args: &RegistrationArgs) -> Result<RelayCredential, KeyError> {
        let api = api()?;
        let options = &args.options;
        let rp_id = wide(&args.rp_id);
        let rp_name = wide(options.rp_name.as_deref().unwrap_or(&args.rp_id));
        let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_RP_ENTITY_INFORMATION_CURRENT_VERSION,
            pwszId: pcwstr(&rp_id),
            pwszName: pcwstr(&rp_name),
            pwszIcon: PCWSTR::null(),
        };
        let user_name = wide(options.user.name.as_deref().unwrap_or_default());
        let display = options.user.display_name.as_deref();
        let user_display = wide(display.or(options.user.name.as_deref()).unwrap_or_default());
        let user = WEBAUTHN_USER_ENTITY_INFORMATION {
            dwVersion: WEBAUTHN_USER_ENTITY_INFORMATION_CURRENT_VERSION,
            cbId: len_u32(options.user.id.len())?,
            pbId: options.user.id.as_ptr().cast_mut(),
            pwszName: pcwstr(&user_name),
            pwszIcon: PCWSTR::null(),
            pwszDisplayName: pcwstr(&user_display),
        };
        let mut params: Vec<WEBAUTHN_COSE_CREDENTIAL_PARAMETER> = options
            .algorithms
            .iter()
            .filter_map(|alg| i32::try_from(*alg).ok())
            .map(|alg| WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
                dwVersion: WEBAUTHN_COSE_CREDENTIAL_PARAMETER_CURRENT_VERSION,
                pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
                lAlg: alg,
            })
            .collect();
        let param_set = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
            cCredentialParameters: len_u32(params.len())?,
            pCredentialParameters: params.as_mut_ptr(),
        };
        let data = client_data(&args.client_data_json)?;
        let mut excluded = credentials(&options.exclude_credentials)?;
        // Version 3 ships with every webauthn.dll; version 5 (API 4) adds
        // `bPreferResidentKey`.
        let prefer_resident = api.version >= WEBAUTHN_API_VERSION_4;
        let make_options = WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
            dwVersion: if prefer_resident { 5 } else { 3 },
            dwTimeoutMilliseconds: len_u32(args.timeout_ms as usize)?,
            CredentialList: credential_set(&mut excluded)?,
            dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_CROSS_PLATFORM,
            bRequireResidentKey: BOOL::from(options.resident_key == Requirement::Required),
            dwUserVerificationRequirement: requirement(options.user_verification),
            dwAttestationConveyancePreference: conveyance(options.attestation),
            bPreferResidentKey: BOOL::from(
                prefer_resident && options.resident_key == Requirement::Preferred,
            ),
            ..Default::default()
        };
        let mut result: *mut WEBAUTHN_CREDENTIAL_ATTESTATION = std::ptr::null_mut();
        // SAFETY: every pointer refers to a local that outlives the call.
        let hr = unsafe {
            (api.make_credential)(
                self.hwnd(),
                &rp,
                &user,
                &param_set,
                &data,
                &make_options,
                &mut result,
            )
        };
        if hr.is_err() || result.is_null() {
            return Err(map_hresult(api, hr));
        }
        // SAFETY: `result` is a valid attestation until it is freed below.
        let credential = unsafe {
            let attestation = &*result;
            let id = copy_bytes(attestation.pbCredentialId, attestation.cbCredentialId);
            let object = copy_bytes(
                attestation.pbAttestationObject,
                attestation.cbAttestationObject,
            );
            let used = if attestation.dwVersion >= 3 {
                attestation.dwUsedTransport
            } else {
                WEBAUTHN_CTAP_TRANSPORT_USB
            };
            (api.free_attestation)(result);
            RelayCredential {
                id: b64url_encode(&id),
                response: CredentialResponse::Attestation {
                    attestation_object: b64url_encode(&object),
                    transports: transports(used),
                },
            }
        };
        Ok(credential)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wide_strings_are_nul_terminated() {
        assert_eq!(wide("ab"), vec![u16::from(b'a'), u16::from(b'b'), 0]);
    }

    #[test]
    fn used_transports_are_named() {
        assert_eq!(
            transports(WEBAUTHN_CTAP_TRANSPORT_USB | WEBAUTHN_CTAP_TRANSPORT_NFC),
            vec!["usb", "nfc"]
        );
    }
}
