//! `/v1/sys/tools/{random,hash}`: Vault's utility endpoints, for any valid
//! token (Vault's default policy grants both).
//!
//! - `random[/<source>][/<bytes>]` returns `bytes` (default 32, at most
//!   [`MAX_RANDOM_BYTES`]) from the operating system's CSPRNG as `base64`
//!   (default) or `hex`. Every `source` (`platform`, `seal`, `all`) reads the
//!   same CSPRNG: a Ryu node has no separate seal entropy.
//! - `hash[/<algorithm>]` hashes base64 `input` with SHA-2 (`sha2-256` by
//!   default; `sha2-224`, `sha2-384`, `sha2-512`, `sha2-512/224`,
//!   `sha2-512/256`) and returns `sum` as `hex` (default) or `base64`. SHA-3
//!   is refused: no SHA-3 implementation is in Core's dependencies.
//!
//! Neither touches stored values, so neither writes an audit row. Like every
//! other non-status route here, both answer Vault's sealed 503 while sealed.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use base64::Engine as _;
use rand::RngCore as _;
use serde_json::{json, Map, Value};
use sha2::Digest as _;

use super::*;

/// Largest `random` request, as in Vault.
pub const MAX_RANDOM_BYTES: usize = 128 * 1024;
const DEFAULT_RANDOM_BYTES: usize = 32;
const RANDOM_SOURCES: [&str; 3] = ["platform", "seal", "all"];

fn bad_request(message: &str) -> Response {
    errors(StatusCode::BAD_REQUEST, message)
}

/// An optional string field; anything but a string is a 400.
fn text_field<'a>(fields: &'a Map<String, Value>, name: &str) -> Result<Option<&'a str>, Response> {
    match fields.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(bad_request(&format!("{name} must be a string"))),
    }
}

/// `bytes` as a JSON number or numeric string.
fn byte_count(value: &Value) -> Option<usize> {
    match value {
        Value::Number(number) => number.as_u64().and_then(|n| usize::try_from(n).ok()),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

fn encode(bytes: &[u8], format: Option<&str>, default: &str) -> Result<String, Response> {
    match format.unwrap_or(default) {
        "base64" => Ok(base64::engine::general_purpose::STANDARD.encode(bytes)),
        "hex" => Ok(hex::encode(bytes)),
        other => Err(bad_request(&format!("unsupported encoding format {other}"))),
    }
}

/// The `source` and `bytes` a `random/...` path names, either one optional:
/// `random/32`, `random/seal`, `random/all/64`.
pub(super) fn random_path(rest: &str) -> Result<(Option<String>, Option<usize>), Response> {
    let parts: Vec<&str> = rest
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect();
    let bytes = |part: &str| {
        part.parse::<usize>()
            .map_err(|_| bad_request(&format!("invalid number of bytes {part}")))
    };
    match parts.as_slice() {
        [] => Ok((None, None)),
        [only] if only.chars().all(|c| c.is_ascii_digit()) => Ok((None, Some(bytes(only)?))),
        [source] => Ok((Some((*source).to_owned()), None)),
        [source, count] => Ok((Some((*source).to_owned()), Some(bytes(count)?))),
        _ => Err(not_found()),
    }
}

/// The `random` response data for a parsed request.
pub(super) fn random_data(
    path: (Option<String>, Option<usize>),
    fields: &Map<String, Value>,
) -> Result<Value, Response> {
    let (path_source, path_bytes) = path;
    let source = match path_source {
        Some(source) => source,
        None => text_field(fields, "source")?
            .unwrap_or("platform")
            .to_owned(),
    };
    if !RANDOM_SOURCES.contains(&source.as_str()) {
        return Err(bad_request(&format!("unsupported entropy source {source}")));
    }
    let count = match (path_bytes, fields.get("bytes")) {
        (Some(count), _) => count,
        (None, None | Some(Value::Null)) => DEFAULT_RANDOM_BYTES,
        (None, Some(value)) => {
            byte_count(value).ok_or_else(|| bad_request("bytes must be a positive integer"))?
        }
    };
    if count == 0 {
        return Err(bad_request("bytes must be a positive integer"));
    }
    if count > MAX_RANDOM_BYTES {
        return Err(bad_request(&format!(
            "bytes must be at most {MAX_RANDOM_BYTES}"
        )));
    }
    let format = text_field(fields, "format")?;
    let mut buffer = vec![0_u8; count];
    rand::rngs::OsRng.fill_bytes(&mut buffer);
    Ok(json!({ "random_bytes": encode(&buffer, format, "base64")? }))
}

/// The digest of `input` under a Vault algorithm name.
pub(super) fn digest(algorithm: &str, input: &[u8]) -> Result<Vec<u8>, Response> {
    Ok(match algorithm {
        "sha2-224" => sha2::Sha224::digest(input).to_vec(),
        "sha2-256" => sha2::Sha256::digest(input).to_vec(),
        "sha2-384" => sha2::Sha384::digest(input).to_vec(),
        "sha2-512" => sha2::Sha512::digest(input).to_vec(),
        "sha2-512/224" => sha2::Sha512_224::digest(input).to_vec(),
        "sha2-512/256" => sha2::Sha512_256::digest(input).to_vec(),
        "sha3-224" | "sha3-256" | "sha3-384" | "sha3-512" => {
            return Err(bad_request(&format!(
                "unsupported hash algorithm {algorithm}"
            )))
        }
        other => return Err(bad_request(&format!("unsupported algorithm {other}"))),
    })
}

/// The `hash` response data for a parsed request.
pub(super) fn hash_data(
    path_algorithm: Option<&str>,
    fields: &Map<String, Value>,
) -> Result<Value, Response> {
    let algorithm = match path_algorithm.map(|value| value.trim_matches('/')) {
        Some(algorithm) if !algorithm.is_empty() => algorithm.to_owned(),
        _ => text_field(fields, "algorithm")?
            .unwrap_or("sha2-256")
            .to_owned(),
    };
    let Some(input) = text_field(fields, "input")? else {
        return Err(bad_request("missing input to process"));
    };
    let input = base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .map_err(|_| bad_request("unable to decode input as base64"))?;
    let sum = digest(&algorithm, &input)?;
    Ok(json!({ "sum": encode(&sum, text_field(fields, "format")?, "hex")? }))
}

async fn answer(
    state: &CompatState,
    headers: &HeaderMap,
    body: &Bytes,
    data: impl FnOnce(&Map<String, Value>) -> Result<Value, Response>,
) -> Response {
    let _who = tri!(caller(state, headers).await);
    let fields: Map<String, Value> = tri!(parse_json(body));
    envelope(Some(tri!(data(&fields))), None)
}

#[utoipa::path(post, path = "/v1/sys/tools/random", tag = "Vault",
    operation_id = "vault_compat_sys_tools_random",
    summary = "Random bytes from the CSPRNG (`bytes`, `format`, `source` in the body)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 400, description = "Invalid or unsupported request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn tools_random(
    State(state): State<CompatState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(&state, &headers, &body, |fields| {
        random_data((None, None), fields)
    })
    .await
}

#[utoipa::path(post, path = "/v1/sys/tools/random/{params}", tag = "Vault",
    operation_id = "vault_compat_sys_tools_random_params",
    summary = "Random bytes, with the source and/or byte count in the path",
    params(("params" = String, Path,
        description = "`<bytes>`, `<source>`, or `<source>/<bytes>` (`platform`, `seal`, `all`)")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 400, description = "Invalid or unsupported request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn tools_random_params(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(rest): Path<String>,
    body: Bytes,
) -> Response {
    let _who = tri!(caller(&state, &headers).await);
    let path = tri!(random_path(&rest));
    let fields: Map<String, Value> = tri!(parse_json(&body));
    envelope(Some(tri!(random_data(path, &fields))), None)
}

#[utoipa::path(post, path = "/v1/sys/tools/hash", tag = "Vault",
    operation_id = "vault_compat_sys_tools_hash",
    summary = "SHA-2 digest of base64 `input` (`algorithm`, `format` in the body)",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 400, description = "Invalid or unsupported request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn tools_hash(
    State(state): State<CompatState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    answer(&state, &headers, &body, |fields| hash_data(None, fields)).await
}

#[utoipa::path(post, path = "/v1/sys/tools/hash/{algorithm}", tag = "Vault",
    operation_id = "vault_compat_sys_tools_hash_algorithm",
    summary = "SHA-2 digest of base64 `input` with the algorithm in the path",
    params(("algorithm" = String, Path,
        description = "`sha2-224`, `sha2-256`, `sha2-384`, `sha2-512`, `sha2-512/224` or `sha2-512/256`")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 400, description = "Invalid or unsupported request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn tools_hash_algorithm(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path(algorithm): Path<String>,
    body: Bytes,
) -> Response {
    answer(&state, &headers, &body, |fields| {
        hash_data(Some(&algorithm), fields)
    })
    .await
}
