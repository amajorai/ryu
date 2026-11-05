//! Response, header, and TLS helpers shared by the broker listener.

use super::*;

pub(super) fn full(body: impl Into<Bytes>) -> ProxyBody {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

pub(super) fn empty() -> ProxyBody {
    Empty::new().map_err(|never| match never {}).boxed_unsync()
}

pub(super) fn json_response(
    status: StatusCode,
    code: &str,
    body: serde_json::Value,
) -> Response<ProxyBody> {
    let mut response = Response::new(full(body.to_string()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        hyper::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if let Ok(value) = HeaderValue::from_str(code) {
        headers.insert(ERROR_HEADER, value);
    }
    response
}

pub(super) fn error_response(status: StatusCode, code: &str, message: &str) -> Response<ProxyBody> {
    json_response(status, code, json!({ "error": code, "message": message }))
}

pub(super) fn proxy_auth_required() -> Response<ProxyBody> {
    let mut response = error_response(
        StatusCode::PROXY_AUTHENTICATION_REQUIRED,
        "proxy_auth_required",
        "a live rvb_ broker session is required in Proxy-Authorization",
    );
    response.headers_mut().insert(
        hyper::header::PROXY_AUTHENTICATE,
        HeaderValue::from_static("Basic realm=\"ryu-vault-broker\""),
    );
    response
}

pub(super) fn rate_limited(wait: Duration) -> Refusal {
    let mut response = error_response(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "the broker session exceeded its request rate",
    );
    let secs = wait.as_secs().max(1).to_string();
    if let Ok(value) = HeaderValue::from_str(&secs) {
        response
            .headers_mut()
            .insert(hyper::header::RETRY_AFTER, value);
    }
    Refusal {
        response,
        outcome: "rate_limited",
    }
}

pub(super) fn forbidden_unmatched(host: &str) -> Refusal {
    Refusal {
        response: json_response(
            StatusCode::FORBIDDEN,
            "forbidden",
            json!({
                "error": "forbidden",
                "message": format!(
                    "no broker service covers `{host}` and this environment denies unmatched hosts"
                ),
                "host": host,
                "proposalHint": {
                    "method": "POST",
                    "endpoint": PROPOSALS_ENDPOINT,
                    "discover": DISCOVER_ENDPOINT,
                },
            }),
        ),
        outcome: "forbidden",
    }
}

pub(super) fn is_hop_by_hop(name: &HeaderName, connection_tokens: &[String]) -> bool {
    let name = name.as_str();
    HOP_BY_HOP.contains(&name) || connection_tokens.iter().any(|token| token == name)
}

/// Copy end-to-end headers, dropping hop-by-hop ones, those the `Connection`
/// header names, and (for requests) `Host` and `Content-Length`, which the
/// upstream client sets.
pub(super) fn end_to_end(headers: &HeaderMap, request: bool) -> HeaderMap {
    let connection_tokens: Vec<String> = headers
        .get_all(hyper::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .collect();
    let mut out = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        if is_hop_by_hop(name, &connection_tokens)
            || (request && (name == hyper::header::HOST || name == hyper::header::CONTENT_LENGTH))
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out
}

/// Serves one fixed certificate (the leaf for the CONNECT target).
#[derive(Debug)]
pub(super) struct FixedCert(pub(super) Arc<CertifiedKey>);

impl ResolvesServerCert for FixedCert {
    fn resolve(&self, _client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }
}

pub(super) fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

pub(super) fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// A header value marked sensitive; a credential containing CR, LF, or NUL
/// fails closed instead of splitting the request.
pub(super) fn sensitive_value(value: &str) -> Result<HeaderValue, Refusal> {
    if !substitute::is_safe_header_value(value) {
        return Err(Refusal::new(
            StatusCode::BAD_GATEWAY,
            "credential_invalid",
            "a credential is not a valid header value",
        ));
    }
    let mut header = HeaderValue::from_bytes(value.as_bytes()).map_err(|_| {
        Refusal::new(
            StatusCode::BAD_GATEWAY,
            "credential_invalid",
            "a credential is not a valid header value",
        )
    })?;
    header.set_sensitive(true);
    Ok(header)
}

pub(super) fn substitute_headers(
    headers: &mut HeaderMap,
    pairs: &[(String, String)],
) -> Result<(), Refusal> {
    let mut rewritten = Vec::new();
    for (name, value) in headers.iter() {
        let Ok(text) = value.to_str() else {
            continue;
        };
        if let Some(replaced) = substitute::replace_all(text, pairs, str::to_owned) {
            rewritten.push((name.clone(), sensitive_value(&replaced)?));
        }
    }
    for (name, value) in rewritten {
        headers.insert(name, value);
    }
    Ok(())
}
