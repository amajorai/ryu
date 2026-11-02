//! Parses the relayed `publicKey` options (the JSON form, buffers already
//! base64url) into the fields a key backend needs. Unknown enum strings fall
//! back to the WebAuthn defaults, as browsers do.

use ryu_webauthn_relay::b64url_decode;
use serde_json::Value;

use crate::KeyError;

/// COSE ES256 and RS256: what browsers use when `pubKeyCredParams` is empty.
const DEFAULT_ALGORITHMS: [i64; 2] = [-7, -257];
/// WebAuthn caps `user.id` at 64 bytes.
const MAX_USER_ID_BYTES: usize = 64;
/// CTAP2 caps credential ids at 1023 bytes.
const MAX_CREDENTIAL_ID_BYTES: usize = 1023;

/// `required` / `preferred` / `discouraged`, for user verification and
/// resident keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Requirement {
    Required,
    Preferred,
    Discouraged,
}

impl Requirement {
    fn parse(value: Option<&Value>) -> Option<Self> {
        match value?.as_str()? {
            "required" => Some(Self::Required),
            "preferred" => Some(Self::Preferred),
            "discouraged" => Some(Self::Discouraged),
            _ => None,
        }
    }
}

/// The attestation conveyance the site asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Attestation {
    None,
    Indirect,
    Direct,
    Enterprise,
}

/// One entry of `allowCredentials` / `excludeCredentials`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CredentialDescriptor {
    pub id: Vec<u8>,
    /// Transport hints as the site gave them (`usb`, `nfc`, `ble`, ...).
    pub transports: Vec<String>,
}

/// `options.user` of a create call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserEntity {
    pub id: Vec<u8>,
    pub name: Option<String>,
    pub display_name: Option<String>,
}

/// Parsed `navigator.credentials.get` options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GetOptions {
    pub allow_credentials: Vec<CredentialDescriptor>,
    pub user_verification: Requirement,
}

/// Parsed `navigator.credentials.create` options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MakeOptions {
    pub rp_name: Option<String>,
    pub user: UserEntity,
    /// COSE algorithm ids in the site's order of preference.
    pub algorithms: Vec<i64>,
    pub exclude_credentials: Vec<CredentialDescriptor>,
    pub user_verification: Requirement,
    pub resident_key: Requirement,
    pub attestation: Attestation,
}

fn invalid(message: impl Into<String>) -> KeyError {
    KeyError::Invalid(message.into())
}

fn optional_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|text| !text.is_empty())
}

fn descriptors(options: &Value, key: &str) -> Result<Vec<CredentialDescriptor>, KeyError> {
    let Some(raw) = options.get(key) else {
        return Ok(Vec::new());
    };
    let Some(list) = raw.as_array() else {
        return Err(invalid(format!("{key} must be an array")));
    };
    let mut parsed = Vec::with_capacity(list.len());
    for entry in list {
        // Entries of another credential type are skipped, as browsers do.
        if entry
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("public-key")
            != "public-key"
        {
            continue;
        }
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .and_then(|text| b64url_decode(text).ok())
            .filter(|id| !id.is_empty() && id.len() <= MAX_CREDENTIAL_ID_BYTES)
            .ok_or_else(|| invalid(format!("{key} has a credential without a valid id")))?;
        let transports = entry
            .get("transports")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        parsed.push(CredentialDescriptor { id, transports });
    }
    Ok(parsed)
}

fn refuse_platform_attachment(selection: Option<&Value>) -> Result<(), KeyError> {
    let attachment = selection
        .and_then(|value| value.get("authenticatorAttachment"))
        .and_then(Value::as_str);
    if attachment == Some("platform") {
        return Err(KeyError::Unsupported(
            "the site asks for a built-in authenticator; only a plugged-in security key can be used"
                .to_owned(),
        ));
    }
    Ok(())
}

/// Parse the options of a `get` call.
pub fn parse_get_options(options: &Value) -> Result<GetOptions, KeyError> {
    Ok(GetOptions {
        allow_credentials: descriptors(options, "allowCredentials")?,
        user_verification: Requirement::parse(options.get("userVerification"))
            .unwrap_or(Requirement::Preferred),
    })
}

fn parse_user(options: &Value) -> Result<UserEntity, KeyError> {
    let user = options
        .get("user")
        .filter(|value| value.is_object())
        .ok_or_else(|| invalid("options.user is required"))?;
    let id = user
        .get("id")
        .and_then(Value::as_str)
        .and_then(|text| b64url_decode(text).ok())
        .filter(|id| !id.is_empty() && id.len() <= MAX_USER_ID_BYTES)
        .ok_or_else(|| invalid("options.user.id must be 1 to 64 bytes of base64url"))?;
    Ok(UserEntity {
        id,
        name: optional_string(user.get("name")),
        display_name: optional_string(user.get("displayName")),
    })
}

fn parse_algorithms(options: &Value) -> Result<Vec<i64>, KeyError> {
    let list = options
        .get("pubKeyCredParams")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("options.pubKeyCredParams is required"))?;
    if list.is_empty() {
        return Ok(DEFAULT_ALGORITHMS.to_vec());
    }
    let mut algorithms: Vec<i64> = Vec::new();
    for param in list {
        if param.get("type").and_then(Value::as_str) != Some("public-key") {
            continue;
        }
        if let Some(alg) = param.get("alg").and_then(Value::as_i64) {
            if !algorithms.contains(&alg) {
                algorithms.push(alg);
            }
        }
    }
    if algorithms.is_empty() {
        return Err(KeyError::Unsupported(
            "the site lists no public-key algorithm".to_owned(),
        ));
    }
    Ok(algorithms)
}

fn parse_resident_key(selection: Option<&Value>) -> Requirement {
    let explicit = Requirement::parse(selection.and_then(|value| value.get("residentKey")));
    let legacy = selection
        .and_then(|value| value.get("requireResidentKey"))
        .and_then(Value::as_bool)
        == Some(true);
    match explicit {
        Some(requirement) => requirement,
        None if legacy => Requirement::Required,
        None => Requirement::Discouraged,
    }
}

fn parse_attestation(value: Option<&Value>) -> Attestation {
    match value.and_then(Value::as_str) {
        Some("indirect") => Attestation::Indirect,
        Some("direct") => Attestation::Direct,
        Some("enterprise") => Attestation::Enterprise,
        _ => Attestation::None,
    }
}

/// Parse the options of a `create` call.
pub fn parse_make_options(options: &Value) -> Result<MakeOptions, KeyError> {
    let selection = options.get("authenticatorSelection");
    refuse_platform_attachment(selection)?;
    Ok(MakeOptions {
        rp_name: optional_string(options.get("rp").and_then(|rp| rp.get("name"))),
        user: parse_user(options)?,
        algorithms: parse_algorithms(options)?,
        exclude_credentials: descriptors(options, "excludeCredentials")?,
        user_verification: Requirement::parse(
            selection.and_then(|value| value.get("userVerification")),
        )
        .unwrap_or(Requirement::Preferred),
        resident_key: parse_resident_key(selection),
        attestation: parse_attestation(options.get("attestation")),
    })
}

#[cfg(test)]
#[path = "options_tests.rs"]
mod tests;
