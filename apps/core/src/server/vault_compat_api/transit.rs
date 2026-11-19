//! `/v1/transit/*`: the transit operations a machine token may run natively
//! (`/api/vault/agent/transit/{op}/{name}`), in Vault's wire format.
//!
//! Authorization and the store call are [`transit_run`], the same function
//! the native routes use: `use` on `sys/transit/<name>`, or `admin` for
//! `keys/<name>/rotate`. Ciphertexts, signatures, and HMACs carry Vault's
//! `vault:v<N>:` prefix here and Ryu's `ryu:v<N>:` natively; both prefixes are
//! accepted on input, so either surface opens what the other produced.
//! Batches, caller-supplied nonces, and hash choices Ryu cannot honour are
//! refused rather than ignored.

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};

use super::*;
use crate::server::vault_engines_api::{transit_run, TransitFailure, TransitOpBody};
use crate::vault::VaultError;

const VAULT_PREFIX: &str = "vault:v";
const RYU_PREFIX: &str = "ryu:v";

/// One transit call: the native operation, the key, and the Vault-only
/// details (a hash algorithm from the path, `datakey`'s `wrapped` form).
struct Call {
    op: &'static str,
    name: String,
    algorithm: Option<String>,
    wrapped: bool,
}

impl Call {
    fn new(op: &'static str, name: String) -> Self {
        Self {
            op,
            name,
            algorithm: None,
            wrapped: false,
        }
    }

    /// `name` or `name/<algorithm>` from a `sign`, `verify`, or `hmac` path.
    fn with_suffix(op: &'static str, rest: &str) -> Result<Self, Response> {
        let rest = rest.trim_start_matches('/');
        let (name, algorithm) = match rest.split_once('/') {
            Some((name, algorithm)) if !algorithm.contains('/') => {
                (name, Some(algorithm.to_owned()))
            }
            Some(_) => return Err(not_found()),
            None => (rest, None),
        };
        if name.is_empty() {
            return Err(not_found());
        }
        Ok(Self {
            algorithm,
            ..Self::new(op, name.to_owned())
        })
    }
}

/// `vault:v<N>:…` to the native `ryu:v<N>:…`; other strings are unchanged.
fn native_string(value: &str) -> String {
    match value.trim().strip_prefix(VAULT_PREFIX) {
        Some(rest) => format!("{RYU_PREFIX}{rest}"),
        None => value.to_owned(),
    }
}

/// `ryu:v<N>:…` to Vault's `vault:v<N>:…`.
fn vault_string(value: &str) -> String {
    match value.strip_prefix(RYU_PREFIX) {
        Some(rest) => format!("{VAULT_PREFIX}{rest}"),
        None => value.to_owned(),
    }
}

/// The key version a native output string was made with.
fn key_version(value: &str) -> Option<u32> {
    value
        .strip_prefix(RYU_PREFIX)?
        .split_once(':')?
        .0
        .parse()
        .ok()
}

fn text(fields: &Map<String, Value>, name: &str) -> Result<Option<String>, Response> {
    match fields.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        Some(_) => Err(errors(
            StatusCode::BAD_REQUEST,
            &format!("{name} must be a string"),
        )),
    }
}

fn unsupported(message: &str) -> Response {
    errors(StatusCode::BAD_REQUEST, message)
}

/// Refuse the Vault parameters this surface cannot honour, so a client never
/// gets a result computed differently from what it asked for.
fn check_supported(call: &Call, fields: &Map<String, Value>) -> Result<(), Response> {
    if fields.contains_key("batch_input") {
        return Err(unsupported("batch_input is not supported"));
    }
    if fields.contains_key("nonce") {
        return Err(unsupported("nonce is not supported"));
    }
    if fields
        .get("prehashed")
        .is_some_and(|value| value != &json!(false))
    {
        return Err(unsupported("prehashed input is not supported"));
    }
    if let Some(marshaling) = text(fields, "marshaling_algorithm")? {
        if marshaling != "asn1" {
            return Err(unsupported(
                "only the asn1 marshaling algorithm is supported",
            ));
        }
    }
    if fields
        .get("bits")
        .is_some_and(|bits| bits != &json!(256) && bits != &json!("256"))
    {
        return Err(unsupported("data keys are 256 bits"));
    }
    match call.op {
        "hmac" => {
            let algorithm = call.algorithm.clone().or(text(fields, "algorithm")?);
            if algorithm.is_some_and(|algorithm| algorithm != "sha2-256") {
                return Err(unsupported("only sha2-256 HMACs are supported"));
            }
        }
        "sign" | "verify" => {
            // Keys sign with their type's own hash (SHA-384 for ecdsa-p384),
            // so a requested algorithm could silently differ from the one used.
            if call.algorithm.is_some() || text(fields, "hash_algorithm")?.is_some() {
                return Err(unsupported(
                    "hash_algorithm is not supported; keys sign with their type's default hash",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

/// The native operation body from Vault's snake_case fields.
fn op_body(call: &Call, fields: &Map<String, Value>) -> Result<TransitOpBody, Response> {
    check_supported(call, fields)?;
    let key_version = match fields.get("key_version") {
        None | Some(Value::Null) => None,
        Some(value) => match value.as_u64().and_then(|v| u32::try_from(v).ok()) {
            Some(0) => None,
            Some(version) => Some(version),
            None => return Err(unsupported("key_version must be a positive integer")),
        },
    };
    let native = |name: &str| text(fields, name).map(|value| value.map(|v| native_string(&v)));
    Ok(TransitOpBody {
        plaintext: text(fields, "plaintext")?,
        ciphertext: native("ciphertext")?,
        context: text(fields, "context")?,
        input: text(fields, "input")?,
        signature: native("signature")?,
        hmac: native("hmac")?,
        associated_data: text(fields, "associated_data")?,
        key_version,
        signature_algorithm: text(fields, "signature_algorithm")?,
        ..TransitOpBody::default()
    })
}

/// Vault's snake_case view of the native key record (`rotate`'s result).
fn key_data(info: &Value) -> Value {
    const FIELDS: [(&str, &str); 13] = [
        ("name", "name"),
        ("type", "type"),
        ("latestVersion", "latest_version"),
        ("minDecryptionVersion", "min_decryption_version"),
        ("minEncryptionVersion", "min_encryption_version"),
        ("minAvailableVersion", "min_available_version"),
        ("deletionAllowed", "deletion_allowed"),
        ("derived", "derived"),
        ("convergent", "convergent_encryption"),
        ("exportable", "exportable"),
        ("allowPlaintextBackup", "allow_plaintext_backup"),
        ("autoRotatePeriodSecs", "auto_rotate_period"),
        ("imported", "imported_key"),
    ];
    let mut data = Map::new();
    for (native, vault) in FIELDS {
        if let Some(value) = info.get(native) {
            data.insert(vault.to_owned(), value.clone());
        }
    }
    Value::Object(data)
}

/// Vault's `data` for a native result.
fn vault_data(call: &Call, result: &Value) -> Value {
    let versioned = |field: &str| {
        let native = result[field].as_str().unwrap_or_default();
        json!({ field: vault_string(native), "key_version": key_version(native) })
    };
    match call.op {
        "encrypt" | "rewrap" => versioned("ciphertext"),
        "sign" => versioned("signature"),
        "hmac" => versioned("hmac"),
        "datakey" => {
            let mut data = versioned("ciphertext");
            if !call.wrapped {
                data["plaintext"] = result["plaintext"].clone();
            }
            data
        }
        "rotate" => key_data(&result["key"]),
        _ => result.clone(),
    }
}

fn failure_response(failure: TransitFailure) -> Response {
    match failure {
        TransitFailure::Denied(_) => permission_denied(),
        TransitFailure::Missing(field) => {
            errors(StatusCode::BAD_REQUEST, &format!("missing {field}"))
        }
        TransitFailure::UnknownOp => not_found(),
        TransitFailure::Store(error) => match error.downcast_ref::<VaultError>() {
            Some(VaultError::NotFound(_)) => {
                errors(StatusCode::BAD_REQUEST, "encryption key not found")
            }
            _ => store_error(&error),
        },
    }
}

/// Authenticate, then run `call`. A malformed path (`call` is an error) is
/// reported only to an authenticated caller, like every other refusal here.
async fn run(
    state: &CompatState,
    headers: &HeaderMap,
    call: Result<Call, Response>,
    body: &Bytes,
) -> Response {
    let who = tri!(caller(state, headers).await);
    let call = tri!(call);
    let fields: Map<String, Value> = tri!(parse_json(body));
    let request = tri!(op_body(&call, &fields));
    match transit_run(&who, call.op, &call.name, request).await {
        Ok(result) => envelope(Some(vault_data(&call, &result)), None),
        Err(failure) => failure_response(failure),
    }
}

macro_rules! transit_route {
    ($handler:ident, $op:literal, $path:literal, $summary:literal) => {
        #[utoipa::path(post, path = $path, tag = "Vault",
            operation_id = concat!("vault_compat_transit_", $op),
            summary = $summary,
            params(("name" = String, Path, description = "Transit key name")),
            request_body = serde_json::Value,
            responses(
                (status = 200, description = "Vault response envelope", body = serde_json::Value),
                (status = 400, description = "Invalid or unsupported request", body = serde_json::Value),
                (status = 403, description = "permission denied", body = serde_json::Value),
                (status = 503, description = "Vault is sealed", body = serde_json::Value),
            ))]
        pub(crate) async fn $handler(
            State(state): State<CompatState>,
            headers: HeaderMap,
            Path(name): Path<String>,
            body: Bytes,
        ) -> Response {
            run(&state, &headers, Ok(Call::new($op, name)), &body).await
        }
    };
}

macro_rules! transit_suffix_route {
    ($handler:ident, $op:literal, $path:literal, $summary:literal) => {
        #[utoipa::path(post, path = $path, tag = "Vault",
            operation_id = concat!("vault_compat_transit_", $op),
            summary = $summary,
            params(("name" = String, Path,
                description = "Transit key name, optionally followed by `/<algorithm>`")),
            request_body = serde_json::Value,
            responses(
                (status = 200, description = "Vault response envelope", body = serde_json::Value),
                (status = 400, description = "Invalid or unsupported request", body = serde_json::Value),
                (status = 403, description = "permission denied", body = serde_json::Value),
                (status = 503, description = "Vault is sealed", body = serde_json::Value),
            ))]
        pub(crate) async fn $handler(
            State(state): State<CompatState>,
            headers: HeaderMap,
            Path(rest): Path<String>,
            body: Bytes,
        ) -> Response {
            run(&state, &headers, Call::with_suffix($op, &rest), &body).await
        }
    };
}

transit_route!(
    transit_encrypt,
    "encrypt",
    "/v1/transit/encrypt/{name}",
    "Encrypt base64 plaintext with a transit key (use on sys/transit/<name>)"
);
transit_route!(
    transit_decrypt,
    "decrypt",
    "/v1/transit/decrypt/{name}",
    "Decrypt a transit ciphertext to base64 plaintext (use)"
);
transit_route!(
    transit_rewrap,
    "rewrap",
    "/v1/transit/rewrap/{name}",
    "Re-encrypt a ciphertext with the key's latest version (use)"
);
transit_route!(
    transit_rotate,
    "rotate",
    "/v1/transit/keys/{name}/rotate",
    "Add a key version (admin on sys/transit/<name>)"
);
transit_suffix_route!(
    transit_sign,
    "sign",
    "/v1/transit/sign/{name}",
    "Sign base64 input (use)"
);
transit_suffix_route!(
    transit_verify,
    "verify",
    "/v1/transit/verify/{name}",
    "Verify a signature or HMAC (use)"
);
transit_suffix_route!(
    transit_hmac,
    "hmac",
    "/v1/transit/hmac/{name}",
    "HMAC-SHA256 of base64 input (use)"
);

/// POST /v1/transit/datakey/{plaintext|wrapped}/{name}.
#[utoipa::path(post, path = "/v1/transit/datakey/{kind}/{name}", tag = "Vault",
    operation_id = "vault_compat_transit_datakey",
    summary = "Generate a data key, returned wrapped and optionally in plaintext (use)",
    params(
        ("kind" = String, Path, description = "`plaintext` or `wrapped`"),
        ("name" = String, Path, description = "Transit key name"),
    ),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Vault response envelope", body = serde_json::Value),
        (status = 400, description = "Invalid or unsupported request", body = serde_json::Value),
        (status = 403, description = "permission denied", body = serde_json::Value),
        (status = 503, description = "Vault is sealed", body = serde_json::Value),
    ))]
pub(crate) async fn transit_datakey(
    State(state): State<CompatState>,
    headers: HeaderMap,
    Path((kind, name)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let call = match kind.as_str() {
        "plaintext" | "wrapped" => Ok(Call {
            wrapped: kind == "wrapped",
            ..Call::new("datakey", name)
        }),
        _ => Err(errors(StatusCode::BAD_REQUEST, "invalid type")),
    };
    run(&state, &headers, call, &body).await
}
