//! HTTP tool request plumbing: capped response reads, the SSRF guard, REST
//! request building, result shaping and secret redaction.
//!
//! Split out of `tool_exec/mod.rs`; items are re-exported there, so
//! `crate::tool_exec::*` paths are unchanged.

use super::*;

pub(super) async fn read_http_response_text_capped(
    mut response: reqwest::Response,
) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_HTTP_RESPONSE_BYTES as u64)
    {
        return Err(format!(
            "http tool response exceeds {MAX_HTTP_RESPONSE_BYTES} bytes"
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("http tool response read failed: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_HTTP_RESPONSE_BYTES {
            return Err(format!(
                "http tool response exceeds {MAX_HTTP_RESPONSE_BYTES} bytes"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Extract the egress domain (host) from an `http` tool's URL, for the
/// `tool:http-egress:<domain>` grant check. `None` for a URL with no host.
pub fn http_egress_domain(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
}

/// True for a loopback / link-local / private / CGNAT / 0.0.0.0-8 IPv4 — the SSRF
/// sinks (cloud metadata `169.254.169.254`, `127.0.0.1`, internal LAN) a plugin
/// granted a *public* domain must never reach.
pub(super) fn is_internal_v4(v4: &std::net::Ipv4Addr) -> bool {
    ryu_egress::is_blocked_ip(std::net::IpAddr::V4(*v4))
}

pub(super) fn is_internal_ip(ip: &std::net::IpAddr) -> bool {
    ryu_egress::is_blocked_ip(*ip)
}

/// SSRF guard for the `http` plugin tool: reject a `url` whose host is — or
/// resolves to — an internal address, so a grant for a *public* domain can't be
/// turned into a request to an internal service via DNS. Skipped only when the
/// granted host literal is itself internal (an explicit, install-validated intent
/// to reach `localhost`/a private host). Rebinding-resistant: rejects if ANY
/// resolved address is internal.
/// Screen a URL against SSRF before egress. On success returns the exact
/// addresses the request MUST be pinned to (`Some((host, addrs))`), or `None`
/// when no pinning is needed (a deliberate internal/localhost grant, or a
/// literal-IP URL host — neither involves a DNS lookup the attacker can race).
///
/// The `Some` case is load-bearing: the caller MUST build the reqwest client
/// with `.resolve_to_addrs(&host, &addrs)`. Otherwise reqwest re-resolves DNS
/// independently at `send()`, and an attacker who controls the granted domain's
/// DNS can answer THIS guard's lookup with a public IP (passes screening) and
/// reqwest's lookup, milliseconds later with TTL 0, with an internal one
/// (169.254.169.254 metadata, 127.0.0.1, RFC1918) — a TOCTOU/DNS-rebinding
/// bypass that leaks the response body to the caller. Pinning makes the check
/// and the connect use one shared resolution, closing the window.
pub(super) async fn http_ssrf_guard(
    url: &str,
    granted_host: &str,
) -> Result<Option<(String, Vec<std::net::SocketAddr>)>, String> {
    // Explicit grant for a literal internal host / localhost ⇒ deliberate, allow.
    if granted_host.eq_ignore_ascii_case("localhost") {
        return Ok(None);
    }
    if let Ok(lit) = granted_host.parse::<std::net::IpAddr>() {
        if is_internal_ip(&lit) {
            return Ok(None);
        }
    }
    let parsed =
        reqwest::Url::parse(url).map_err(|e| format!("http tool: could not parse url: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "http tool: url has no host".to_string())?
        .to_owned();
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return if is_internal_ip(&ip) {
            Err(format!("http egress to internal address '{ip}' is blocked"))
        } else {
            // Literal public IP in the URL: no DNS lookup happens, so there is no
            // rebinding window to pin against.
            Ok(None)
        };
    }
    let port = parsed.port_or_known_default().unwrap_or(443);
    let resolved: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("http tool: dns resolve failed for '{host}': {e}"))?
        .collect();
    if resolved.is_empty() {
        return Err(format!("http tool: host '{host}' did not resolve"));
    }
    for a in &resolved {
        if is_internal_ip(&a.ip()) {
            return Err(format!(
                "http egress: host '{host}' resolves to internal address {} — blocked (SSRF guard)",
                a.ip()
            ));
        }
    }
    Ok(Some((host, resolved)))
}

/// Deep-merge `overlay` ONTO `base` in place: two objects merge key-by-key
/// recursively; for any other type pairing (scalar, array, or a type mismatch)
/// `overlay` REPLACES `base`. Absent keys in `overlay` keep `base`'s value.
///
/// This is the `body_defaults` seam: seeding `base` with the manifest defaults and
/// overlaying the model's body makes the MODEL win on every collision while nested
/// default sub-objects (exa's `contents:{text:true}`) survive when the model omits
/// them. Pure + network-free so it is unit-testable in isolation.
pub(super) fn deep_merge_json(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (Value::Object(b), Value::Object(o)) => {
            for (k, ov) in o {
                deep_merge_json(b.entry(k.clone()).or_insert(Value::Null), ov);
            }
        }
        (b, o) => *b = o.clone(),
    }
}

/// A scalar tool-arg rendered for a URL (path segment or query value). Objects
/// and arrays have no unambiguous URL rendering, so they stay in the JSON body.
pub(super) fn scalar_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The `{name}` path-parameter placeholders in a URL template, in order. A plain
/// scan (no regex dep); names containing `/` are ignored so a stray brace in a
/// path can't swallow a segment.
pub(super) fn url_placeholders(url: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = url;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        if let Some(close) = after.find('}') {
            let name = &after[..close];
            if !name.is_empty() && !name.contains('/') {
                out.push(name.to_string());
            }
            rest = &after[close + 1..];
        } else {
            break;
        }
    }
    out
}

/// Lower REST-shaped tool args onto a request: fill every `{name}` placeholder in
/// the URL from (and consume) a matching arg, then send the rest as query params
/// for body-less methods (GET/HEAD) or as the JSON body otherwise. Non-object
/// args keep the legacy behavior (the whole value is the body). Returns an error
/// if a required path placeholder has no matching arg. This is what lets a single
/// `http` tool express a real REST operation (`GET /repos/{owner}/{repo}/issues`)
/// instead of only a fixed-URL POST.
pub(super) type RestRequest = (String, Vec<(String, String)>, Value, Vec<(String, String)>);

pub(super) fn build_rest_request(
    url: &str,
    args: &Value,
    bodyless: bool,
    header_params: &[String],
    resolved_secret_headers: &[(String, String)],
) -> Result<RestRequest, String> {
    let Some(obj) = args.as_object() else {
        // Scalar/array args: no partitioning. Legacy fixed-URL behavior, but a
        // resolved secret header still rides (it never came from `args`).
        return Ok((
            url.to_string(),
            Vec::new(),
            args.clone(),
            resolved_secret_headers.to_vec(),
        ));
    };
    let mut remaining = obj.clone();
    // 0. Headers first: pull the declared header args out before path/query/body
    //    partitioning (auth token + OpenAPI `in: header` params).
    let mut headers: Vec<(String, String)> = Vec::new();
    for name in header_params {
        if let Some(rendered) = remaining.remove(name).as_ref().and_then(scalar_to_string) {
            headers.push((name.clone(), rendered));
        }
    }
    // 0b. Pre-resolved SECRET headers (server-side sourced from env/vault). These
    //     never touch `remaining` (the model-visible args map), so they never
    //     appear in the path/query/body and never in the input schema — the whole
    //     point of the secret-header seam. Pushed onto the same header vec.
    for (name, value) in resolved_secret_headers {
        headers.push((name.clone(), value.clone()));
    }
    let mut final_url = url.to_string();
    let mut missing: Vec<String> = Vec::new();
    for name in url_placeholders(url) {
        match remaining.remove(&name).as_ref().and_then(scalar_to_string) {
            Some(value) => {
                let encoded = urlencoding::encode(&value);
                final_url = final_url.replace(&format!("{{{name}}}"), &encoded);
            }
            None => missing.push(name),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "http tool: missing path parameter(s): {}",
            missing.join(", ")
        ));
    }
    if bodyless {
        let mut pairs = Vec::new();
        for (key, value) in &remaining {
            if let Some(rendered) = scalar_to_string(value) {
                pairs.push((key.clone(), rendered));
            }
        }
        // Sort by name: the args map keeps insertion order when a dependency
        // enables serde_json's `preserve_order`, and the query must not depend
        // on how the model happened to order its arguments.
        pairs.sort_by(|left, right| left.0.cmp(&right.0));
        Ok((final_url, pairs, Value::Null, headers))
    } else {
        Ok((final_url, Vec::new(), Value::Object(remaining), headers))
    }
}

/// The soft-unavailable envelope a `fail_open` http tool returns instead of an
/// `Err`, mirroring the deleted exa provider's `unavailable()` shape so a downstream
/// consumer's `{available:false,…}` handling (quest evidence gathering / usage_api) is reused.
pub(super) fn http_unavailable(reason: impl Into<String>) -> Value {
    serde_json::json!({
        "available": false,
        "reason": reason.into(),
        "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry.",
    })
}

/// Pure branching of an http send outcome into the caller-visible result plus the
/// AUDIT tuple, decoupled so `fail_open` never blinds the audit. Network-free and
/// unit-testable. Returns `(result, audit_exit_code, audit_err)`.
///
/// - `fail_open=false` (DEFAULT, byte-identical to today): transport err → `Err`;
///   any response → `Ok({status,body})`.
/// - `fail_open=true`: transport err → `Ok(available:false)` (audit exit 1);
///   status 401|403 → `Ok(available:false)` (audit exit 1); every other status
///   still → `Ok({status,body})` so meaningful data reaches the agent.
/// - `unwrap_body=true`: a 2xx response returns `body_or_text` VERBATIM (no
///   `{status,body}` envelope) so a tool can surface the raw upstream JSON. A
///   non-2xx response, and a `fail_open` 401/403, keep their envelopes — only a
///   success is unwrapped. `false` = today's behavior (every response wraps).
///
/// The audit exit is INDEPENDENT of the caller-visible `Result`: a converted
/// transport/401 outcome still audits exit 1 + the real error so outages and auth
/// failures never vanish from metrics.
pub(super) fn finalize_http_result(
    fail_open: bool,
    unwrap_body: bool,
    status: Option<u16>,
    body_or_text: Value,
    transport_err: Option<String>,
) -> (Result<Value, String>, i32, Option<String>) {
    finalize_http_result_with_secrets(
        fail_open,
        unwrap_body,
        status,
        body_or_text,
        transport_err,
        &[],
    )
}

pub(super) fn finalize_http_result_with_secrets(
    fail_open: bool,
    unwrap_body: bool,
    status: Option<u16>,
    body_or_text: Value,
    transport_err: Option<String>,
    secret_values: &[String],
) -> (Result<Value, String>, i32, Option<String>) {
    let body_or_text = redact_secret_values(body_or_text, secret_values);
    match (status, transport_err) {
        // A response arrived.
        (Some(status), _) => {
            let audit_exit = i32::from(status >= 400);
            if fail_open && (status == 401 || status == 403) {
                (
                    Ok(http_unavailable(format!("endpoint returned HTTP {status}"))),
                    audit_exit,
                    Some(format!("http {status}")),
                )
            } else if unwrap_body && (200..300).contains(&status) {
                // Success + unwrap: the parsed upstream body VERBATIM, no envelope.
                (Ok(body_or_text), audit_exit, None)
            } else {
                (
                    Ok(serde_json::json!({ "status": status, "body": body_or_text })),
                    audit_exit,
                    None,
                )
            }
        }
        // A transport failure (no response).
        (None, Some(err)) => {
            if fail_open {
                (
                    Ok(http_unavailable(format!("endpoint not reachable: {err}"))),
                    1,
                    Some(err),
                )
            } else {
                (
                    Err(format!("http tool request failed: {err}")),
                    1,
                    Some(err),
                )
            }
        }
        // Neither a status nor an error should not happen; treat as a transport
        // failure defensively.
        (None, None) => (
            Err("http tool request failed: no response".to_owned()),
            1,
            Some("no response".to_owned()),
        ),
    }
}

pub(super) fn redact_secret_values(mut value: Value, secret_values: &[String]) -> Value {
    fn visit(value: &mut Value, secret_values: &[String]) {
        match value {
            Value::String(text) => {
                for secret in secret_values {
                    if !secret.is_empty() {
                        *text = text.replace(secret, "[REDACTED]");
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, secret_values);
                }
            }
            Value::Object(fields) => {
                for item in fields.values_mut() {
                    visit(item, secret_values);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }
    visit(&mut value, secret_values);
    value
}

#[cfg(test)]
mod query_order_tests {
    use super::build_rest_request;

    #[test]
    fn query_params_are_sorted_by_name_whatever_the_argument_order() {
        let args = serde_json::json!({ "q": "alpha", "limit": 3 });
        let (_, query, _, _) =
            build_rest_request("https://example.test/search", &args, true, &[], &[]).unwrap();
        assert_eq!(
            query,
            vec![
                ("limit".to_string(), "3".to_string()),
                ("q".to_string(), "alpha".to_string()),
            ]
        );
    }
}
