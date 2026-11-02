//! Checks every hop re-runs on a relayed ceremony: the origin is secure, the
//! rpId belongs to it and is not a public suffix, and `clientDataJSON` names
//! the same origin, ceremony type and challenge as the options.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use url::{Host, Url};

use crate::{
    CeremonyKind, RelayError, RelayRequest, DEFAULT_TIMEOUT_MS, MAX_CLIENT_DATA_BYTES,
    MAX_OPTIONS_BYTES, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS,
};

/// Most credentials a page may list in `allowCredentials`/`excludeCredentials`.
const MAX_CREDENTIAL_DESCRIPTORS: usize = 64;

/// Encode bytes as base64url without padding.
#[must_use]
pub fn b64url_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decode base64url, accepting input with or without padding.
pub fn b64url_decode(text: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('='))
}

/// The members of `clientDataJSON` the relay checks.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ClientData {
    #[serde(rename = "type")]
    pub kind: String,
    pub challenge: String,
    pub origin: String,
    #[serde(rename = "crossOrigin", default)]
    pub cross_origin: Option<bool>,
}

/// A request that passed [`validate_relay`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedRelay {
    pub client_data: ClientData,
    /// SHA-256 of the decoded `clientDataJSON`, which the key signs over.
    pub client_data_hash: [u8; 32],
    /// The wait Core should apply, clamped to the relay's bounds.
    pub timeout_ms: u64,
}

fn is_localhost(host: &str) -> bool {
    host == "localhost" || host.ends_with(".localhost")
}

/// Check that `rp_id` is a valid relying party id for `origin`.
///
/// The origin must be `https` (or `http` on `localhost`, as browsers allow).
/// The rpId must be the origin's host or a registrable parent of it, must be
/// a domain (never an IP address), and must not be a public suffix such as
/// `com` or `github.io`.
pub fn validate_rp_id(origin: &str, rp_id: &str) -> Result<(), RelayError> {
    let parsed = Url::parse(origin).map_err(|_| RelayError::InsecureOrigin(origin.to_owned()))?;
    let host = match parsed.host() {
        Some(Host::Domain(domain)) => domain.to_ascii_lowercase(),
        _ => return Err(RelayError::InsecureOrigin(origin.to_owned())),
    };
    let secure = match parsed.scheme() {
        "https" => true,
        "http" => is_localhost(&host),
        _ => false,
    };
    if !secure {
        return Err(RelayError::InsecureOrigin(origin.to_owned()));
    }
    let mismatch = || RelayError::RpIdMismatch {
        rp_id: rp_id.to_owned(),
        origin: origin.to_owned(),
    };
    if rp_id.is_empty() || rp_id != rp_id.to_ascii_lowercase() || rp_id.starts_with('.') {
        return Err(mismatch());
    }
    if host != rp_id && !host.ends_with(&format!(".{rp_id}")) {
        return Err(mismatch());
    }
    if is_localhost(rp_id) {
        return Ok(());
    }
    if !rp_id.contains('.') {
        return Err(RelayError::PublicSuffix(rp_id.to_owned()));
    }
    let suffix = psl::suffix(rp_id.as_bytes()).map(|s| s.as_bytes().to_vec());
    if suffix.as_deref() == Some(rp_id.as_bytes()) {
        return Err(RelayError::PublicSuffix(rp_id.to_owned()));
    }
    Ok(())
}

/// Decode and check `clientDataJSON` for a ceremony of `kind` on `origin`.
pub fn validate_client_data(
    client_data_json: &str,
    kind: CeremonyKind,
    origin: &str,
) -> Result<ClientData, RelayError> {
    let bytes = b64url_decode(client_data_json)
        .map_err(|_| RelayError::ClientData("not base64url".to_owned()))?;
    if bytes.len() > MAX_CLIENT_DATA_BYTES {
        return Err(RelayError::ClientData("too large".to_owned()));
    }
    let data: ClientData = serde_json::from_slice(&bytes)
        .map_err(|error| RelayError::ClientData(error.to_string()))?;
    if data.kind != kind.client_data_type() {
        return Err(RelayError::ClientData(format!(
            "type {:?} does not match the ceremony",
            data.kind
        )));
    }
    if data.origin != origin {
        return Err(RelayError::ClientData(format!(
            "origin {:?} does not match {origin:?}",
            data.origin
        )));
    }
    if data.cross_origin == Some(true) {
        return Err(RelayError::ClientData(
            "cross-origin ceremonies are not relayed".to_owned(),
        ));
    }
    match b64url_decode(&data.challenge) {
        Ok(challenge) if !challenge.is_empty() => Ok(data),
        _ => Err(RelayError::ClientData("challenge is empty or not base64url".to_owned())),
    }
}

/// SHA-256 of the decoded `clientDataJSON`.
pub fn client_data_hash(client_data_json: &str) -> Result<[u8; 32], RelayError> {
    let bytes = b64url_decode(client_data_json)
        .map_err(|_| RelayError::ClientData("not base64url".to_owned()))?;
    Ok(Sha256::digest(&bytes).into())
}

fn options_str<'a>(options: &'a serde_json::Value, path: &[&str]) -> Option<&'a str> {
    let mut value = options;
    for key in path {
        value = value.get(key)?;
    }
    value.as_str()
}

fn check_options(request: &RelayRequest, challenge: &str) -> Result<(), RelayError> {
    let options = &request.options;
    if !options.is_object() {
        return Err(RelayError::Options("options must be an object".to_owned()));
    }
    let size = serde_json::to_vec(options).map_or(usize::MAX, |bytes| bytes.len());
    if size > MAX_OPTIONS_BYTES {
        return Err(RelayError::Options("options are too large".to_owned()));
    }
    if options_str(options, &["challenge"]) != Some(challenge) {
        return Err(RelayError::Options(
            "options.challenge does not match clientDataJSON".to_owned(),
        ));
    }
    let (rp_path, list_key): (&[&str], &str) = match request.kind {
        CeremonyKind::Get => (&["rpId"], "allowCredentials"),
        CeremonyKind::Create => (&["rp", "id"], "excludeCredentials"),
    };
    if let Some(declared) = options_str(options, rp_path) {
        if declared != request.rp_id {
            return Err(RelayError::Options("options rpId differs from rp_id".to_owned()));
        }
    }
    let listed = options.get(list_key).and_then(serde_json::Value::as_array);
    if listed.is_some_and(|list| list.len() > MAX_CREDENTIAL_DESCRIPTORS) {
        return Err(RelayError::Options(format!("{list_key} lists too many credentials")));
    }
    if request.kind == CeremonyKind::Create {
        if options_str(options, &["user", "id"]).is_none() {
            return Err(RelayError::Options("options.user.id is required".to_owned()));
        }
        if !options.get("pubKeyCredParams").is_some_and(serde_json::Value::is_array) {
            return Err(RelayError::Options("options.pubKeyCredParams is required".to_owned()));
        }
    }
    Ok(())
}

/// Run every check on a [`RelayRequest`].
pub fn validate_relay(request: &RelayRequest) -> Result<ValidatedRelay, RelayError> {
    let page = Url::parse(&request.page_url)
        .map_err(|_| RelayError::PageOriginMismatch(request.origin.clone()))?;
    if page.origin().ascii_serialization() != request.origin {
        return Err(RelayError::PageOriginMismatch(request.origin.clone()));
    }
    validate_rp_id(&request.origin, &request.rp_id)?;
    let client_data =
        validate_client_data(&request.client_data_json, request.kind, &request.origin)?;
    check_options(request, &client_data.challenge)?;
    let client_data_hash = client_data_hash(&request.client_data_json)?;
    let timeout_ms = request
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    Ok(ValidatedRelay {
        client_data,
        client_data_hash,
        timeout_ms,
    })
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
