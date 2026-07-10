//! Built-in authenticated web-fetch tool (`web_fetch__get`) — the Identity
//! Vault's first real **credential consumer** (epic #517 follow-up).
//!
//! The Identity Vault (`crate::identity`) captures and seals a user's per-domain
//! login, and the tool-call-time consult (`identity::consult_for_tool_call`)
//! reads it under the Gateway `identity.read` grant. Until now there was no tool
//! that knew how to *use* that credential — the seam read + audited it then
//! dropped it (`identity/consult.rs`). This tool closes that loop: it fetches a
//! page over HTTPS and, when the calling agent has an `AUTHENTICATED` Identity
//! Vault connection for the URL's host, the request is made **as the user** by
//! splicing the sealed session into the request headers.
//!
//! ## The credential never reaches the model (the 3-layer invariant)
//!
//! Core makes the HTTP request itself, so the decrypted [`SecretState`] is
//! consumed entirely server-side: it is passed to [`dispatch`] out-of-band (never
//! through the tool `arguments` the model authored), converted to request headers
//! here, and dropped. Only the *fetched page* is returned to the model — never the
//! cookie/token. The header values are never logged.
//!
//! ## Architecture note (Core-vs-Gateway)
//!
//! Deciding *what tools run* is Core, so this provider lives here, registered as a
//! reserved server name (`web_fetch`) like spider/exa — the `<server>__<tool>` id
//! scheme, per-agent allowlist, catalog search, and the single dispatch entry all
//! work for free. *Whether the credential may be read* stays a Gateway concern,
//! enforced upstream in `identity::read_credential` before the secret ever reaches
//! this module.
//!
//! ## v1 boundaries (honest)
//!
//! - **HTTPS only**, reusing the SSRF guard (`crate::server::guarded_fetch_text_with_headers`):
//!   resolve + screen IPs, pin the client to them (no DNS rebinding), redirects
//!   off, private/loopback hosts refused. A logged-in dashboard is https anyway.
//! - **Redirects are not followed** (the SSRF guard disables them). A 302 to a
//!   login page is therefore surfaced as the status, which is a useful "the cookie
//!   expired" signal rather than a silent failure.
//! - The credential format is whatever the user imported (see
//!   [`credential_to_headers`]): a raw cookie string, or a JSON
//!   `{ "headers": {…}, "cookies": {…} }` envelope.

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;
use crate::identity::SecretState;

/// Reserved registry server name for the built-in web-fetch provider.
pub const SERVER_NAME: &str = "web_fetch";

/// The fully-qualified id of the one tool this provider exposes. Re-exported so
/// the Identity Vault consult can recognize it as a credential-consuming tool
/// without re-deriving the `<server>__<tool>` string.
pub const GET_TOOL_ID: &str = "web_fetch__get";

/// Cap on returned page text (characters) so a large page can't blow the model's
/// context. The full body is still bounded server-side (`MAX_WEB_FETCH_BODY_BYTES`).
const CONTENT_MAX_CHARS: usize = 20_000;

fn get_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "url": {
                "type": "string",
                "description": "The https URL to fetch. If you have a logged-in connection \
                                for this site, the request is made as you automatically."
            }
        },
        "required": ["url"]
    })
}

/// The web-fetch tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: GET_TOOL_ID.to_owned(),
        server: SERVER_NAME.to_owned(),
        name: "get".to_owned(),
        description: Some(
            "Fetch a web page over HTTPS and return its text content. If the calling agent \
             has a logged-in Identity Vault connection for the URL's domain, the request is \
             made AS the user — the session cookie is injected server-side and is never shown \
             to the model. Returns { status, authenticated, content }."
                .to_owned(),
        ),
        input_schema: Some(get_schema()),
        ..Default::default()
    }]
}

/// Dispatch a `web_fetch` tool call.
///
/// `credential` is the decrypted Identity Vault state for the URL's domain when
/// the agent is bound + `AUTHENTICATED` (resolved by `identity::consult_for_tool_call`
/// at the dispatch chokepoint); `None` for an anonymous fetch. It is consumed here
/// and never returned. `Err` only for a malformed call (unknown tool / missing
/// url); a network/non-2xx outcome is a structured result so the agent's turn
/// continues.
pub async fn dispatch(
    tool: &str,
    arguments: Value,
    credential: Option<SecretState>,
) -> Result<Value> {
    match tool {
        "get" => do_get(arguments, credential).await,
        other => Err(anyhow::anyhow!("unknown web_fetch tool '{other}'")),
    }
}

async fn do_get(arguments: Value, credential: Option<SecretState>) -> Result<Value> {
    let url = arguments
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("missing required string argument 'url'"))?;

    let authenticated = credential.is_some();
    // Convert (and immediately drop) the secret into request headers. The secret
    // does not outlive this call and is never logged.
    let headers = credential
        .map(|c| credential_to_headers(&c))
        .unwrap_or_default();

    match crate::server::guarded_fetch_text_with_headers(&url, &headers).await {
        Ok((status, body)) => {
            let truncated = body.chars().count() > CONTENT_MAX_CHARS;
            let content: String = if truncated {
                body.chars().take(CONTENT_MAX_CHARS).collect()
            } else {
                body
            };
            Ok(json!({
                "ok": (200..400).contains(&status),
                "url": url,
                "status": status,
                "authenticated": authenticated,
                "truncated": truncated,
                "content": content,
            }))
        }
        // The guard's error strings carry the url + reqwest error, never a header
        // value, so this cannot leak the credential.
        Err(e) => Ok(json!({
            "ok": false,
            "url": url,
            "authenticated": authenticated,
            "error": e.to_string(),
        })),
    }
}

/// Convert decrypted credential state into request headers. Two accepted formats:
///
/// 1. A JSON object `{ "headers": { name: value, … }, "cookies": { name: value, … } | "raw cookie string" }`.
/// 2. Any other string → used verbatim as the `Cookie` header value (the common
///    case: a cookie string copied from browser dev-tools).
///
/// The plaintext is consumed here and never logged. Invalid header names/values
/// are not rejected here (the SSRF helper validates and skips them at send time).
fn credential_to_headers(secret: &SecretState) -> Vec<(String, String)> {
    let raw = secret.expose().trim();
    if raw.is_empty() {
        return Vec::new();
    }

    // Try the structured JSON envelope first.
    if let Ok(Value::Object(map)) = serde_json::from_str::<Value>(raw) {
        let mut out: Vec<(String, String)> = Vec::new();
        if let Some(Value::Object(h)) = map.get("headers") {
            for (k, v) in h {
                if let Some(s) = v.as_str() {
                    out.push((k.clone(), s.to_owned()));
                }
            }
        }
        match map.get("cookies") {
            Some(Value::Object(c)) => {
                let cookie = c
                    .iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| format!("{k}={s}")))
                    .collect::<Vec<_>>()
                    .join("; ");
                if !cookie.is_empty() {
                    out.push(("Cookie".to_owned(), cookie));
                }
            }
            Some(Value::String(s)) if !s.is_empty() => {
                out.push(("Cookie".to_owned(), s.clone()));
            }
            _ => {}
        }
        // A JSON blob with neither headers nor cookies falls back to raw-as-cookie
        // (e.g. someone pasted a JSON-looking cookie string).
        if out.is_empty() {
            out.push(("Cookie".to_owned(), raw.to_owned()));
        }
        return out;
    }

    // Plain string → a Cookie header.
    vec![("Cookie".to_owned(), raw.to_owned())]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_get_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        let t = &tools[0];
        assert_eq!(t.id, GET_TOOL_ID);
        assert_eq!(t.server, SERVER_NAME);
        assert_eq!(t.name, "get");
        assert!(t.input_schema.is_some());
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        assert!(dispatch("nope", json!({}), None).await.is_err());
    }

    #[tokio::test]
    async fn missing_url_is_an_error() {
        assert!(dispatch("get", json!({}), None).await.is_err());
    }

    #[test]
    fn raw_cookie_string_becomes_cookie_header() {
        let secret = SecretState::new("session=abc; theme=dark".to_owned());
        let headers = credential_to_headers(&secret);
        assert_eq!(
            headers,
            vec![("Cookie".to_owned(), "session=abc; theme=dark".to_owned())]
        );
    }

    #[test]
    fn json_cookies_object_joins_into_cookie_header() {
        let secret = SecretState::new(r#"{"cookies":{"session":"abc","csrf":"xyz"}}"#.to_owned());
        let headers = credential_to_headers(&secret);
        let cookie = headers
            .iter()
            .find(|(k, _)| k == "Cookie")
            .map(|(_, v)| v.clone())
            .expect("a Cookie header");
        // Order within a JSON object is preserved by serde_json (preserve_order),
        // but assert on membership to stay robust regardless.
        assert!(cookie.contains("session=abc"));
        assert!(cookie.contains("csrf=xyz"));
    }

    #[test]
    fn json_headers_object_passes_through() {
        let secret = SecretState::new(r#"{"headers":{"Authorization":"Bearer tkn"}}"#.to_owned());
        let headers = credential_to_headers(&secret);
        assert_eq!(
            headers,
            vec![("Authorization".to_owned(), "Bearer tkn".to_owned())]
        );
    }

    #[test]
    fn json_cookie_string_becomes_cookie_header() {
        let secret = SecretState::new(r#"{"cookies":"session=abc"}"#.to_owned());
        let headers = credential_to_headers(&secret);
        assert_eq!(
            headers,
            vec![("Cookie".to_owned(), "session=abc".to_owned())]
        );
    }

    #[test]
    fn empty_credential_yields_no_headers() {
        let secret = SecretState::new("   ".to_owned());
        assert!(credential_to_headers(&secret).is_empty());
    }

    #[test]
    fn json_without_headers_or_cookies_falls_back_to_raw_cookie() {
        let raw = r#"{"unrelated":"value"}"#;
        let secret = SecretState::new(raw.to_owned());
        let headers = credential_to_headers(&secret);
        assert_eq!(headers, vec![("Cookie".to_owned(), raw.to_owned())]);
    }
}
