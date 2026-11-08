//! Browser credential fills on a session Box (`/v1/boxes/:id/browser-fills`,
//! design `docs/vault-env-session-parity/box-fill-verb/` 1.2 and 1.3).
//!
//! A fill has two steps so Core can check the page before it reads a value:
//! [`BoxSessionClient::browser_fill_prepare`] resolves the element and reports
//! the page (no secret), then [`BoxSessionClient::browser_fill_commit`] sends
//! the value. In placeholder mode the Box service types a one-time placeholder
//! and its egress sidecar swaps in the value only on a login URL of a bound
//! host; in text mode (username, email, TOTP) the value is typed as is.
//!
//! The value is a [`SecretString`]: [`BrowserFillValue`]'s `Debug` redacts it,
//! and no error built here quotes it. A `404` from prepare means the service
//! has no browser-fills API (or no such Box), so it reads as `409
//! browser_fill_unsupported`: Core never falls back to typing the value.

use super::*;

/// The `/health` feature of a Box service that serves this API.
pub const BROWSER_FILL_FEATURE: &str = "browser-fill-v2";
/// The Box cannot fill credentials safely (no fill CA, no desktop, raw
/// egress, an older service or daemon).
pub const BROWSER_FILL_UNSUPPORTED: &str = "browser_fill_unsupported";
/// A bound host echoed a filled value in this Box; fills for it are blocked.
pub const BROWSER_FILL_ECHOED: &str = "browser_fill_echoed";
/// The placeholder TTL Core asks for, and the service's ceiling.
pub const DEFAULT_FILL_TTL_SECONDS: u32 = 45;
pub const MAX_FILL_TTL_SECONDS: u32 = 60;

const MAX_REF_CHARS: usize = 32;
const MAX_TAB_ID_CHARS: usize = 256;
const MAX_PAGE_HOSTS: usize = 2;
const MAX_BIND_HOSTS: usize = 6;
const MAX_SUBMIT_URLS: usize = 4;
const MAX_FILL_ID_CHARS: usize = 80;
const MAX_PLACEHOLDER_VALUE_BYTES: usize = 1024;
const MAX_TEXT_VALUE_CHARS: usize = 4096;

/// The service's fill ids (`^[A-Za-z0-9_-]{1,80}$`, as its routes accept them).
pub fn is_browser_fill_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_FILL_ID_CHARS
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn check_fill_id(id: &str) -> Result<(), BoxApiError> {
    if is_browser_fill_id(id) {
        Ok(())
    } else {
        Err(invalid_request("invalid browser fill id"))
    }
}

fn check_target(target: &BrowserFillTarget) -> Result<(), BoxApiError> {
    let element_ref = target.element_ref.chars().count();
    if element_ref == 0 || element_ref > MAX_REF_CHARS {
        return Err(invalid_request(
            "ref must be an element reference such as @e3",
        ));
    }
    if target
        .tab_id
        .as_ref()
        .is_some_and(|tab| tab.chars().count() > MAX_TAB_ID_CHARS)
    {
        return Err(invalid_request("tab_id is too long"));
    }
    let hosts_ok = |hosts: &[String], max: usize| {
        !hosts.is_empty() && hosts.len() <= max && hosts.iter().all(|host| !host.is_empty())
    };
    if !hosts_ok(&target.page_hosts, MAX_PAGE_HOSTS) {
        return Err(invalid_request("a fill needs 1 to 2 page hosts"));
    }
    if !hosts_ok(&target.bind_hosts, MAX_BIND_HOSTS) {
        return Err(invalid_request("a fill needs 1 to 6 bind hosts"));
    }
    if target.submit_urls.len() > MAX_SUBMIT_URLS {
        return Err(invalid_request("a fill takes at most 4 login URLs"));
    }
    Ok(())
}

/// The commit body. Errors name the rule, never the value.
fn commit_body(value: &BrowserFillValue) -> Result<Value, BoxApiError> {
    match value {
        BrowserFillValue::Placeholder {
            value,
            submit_urls,
            unbound,
            ttl_seconds,
            submit,
        } => {
            let secret = value.expose_secret();
            if secret.is_empty()
                || secret.len() > MAX_PLACEHOLDER_VALUE_BYTES
                || secret.contains(['\r', '\n', '\0'])
                || secret.contains("__RYU_SECRET_")
            {
                return Err(invalid_request(
                    "the value cannot be filled: it is empty, too long, or holds a line break or a placeholder",
                ));
            }
            if !(1..=MAX_FILL_TTL_SECONDS).contains(ttl_seconds) {
                return Err(invalid_request("ttl_seconds must be 1 to 60"));
            }
            if submit_urls.len() > MAX_SUBMIT_URLS || (!unbound && submit_urls.is_empty()) {
                return Err(invalid_request(
                    "a bound fill needs 1 to 4 login URLs, an unbound one at most 4",
                ));
            }
            Ok(json!({
                "mode": "placeholder",
                "value": secret,
                "submitUrls": submit_urls,
                "unbound": unbound,
                "ttlSeconds": ttl_seconds,
                "submit": submit,
            }))
        }
        BrowserFillValue::Text { value, submit } => {
            let secret = value.expose_secret();
            if secret.is_empty()
                || secret.chars().count() > MAX_TEXT_VALUE_CHARS
                || secret.chars().any(|c| c.is_ascii_control())
            {
                return Err(invalid_request(
                    "the value cannot be typed: it is empty, too long, or not one line",
                ));
            }
            Ok(json!({ "mode": "text", "value": secret, "submit": submit }))
        }
    }
}

/// The echo details of a `browser_fill_echoed` error body, if any.
fn echoed_details(status: u16, body: &str) -> Option<BrowserFillEchoed> {
    let value: Value = serde_json::from_str(body).ok()?;
    let error = value.get("error")?;
    if status != 409 || error.get("code")?.as_str()? != BROWSER_FILL_ECHOED {
        return None;
    }
    let strings = |name: &str| -> Vec<String> {
        error["details"][name]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    };
    Some(BrowserFillEchoed {
        hosts: strings("hosts"),
        fill_ids: strings("fillIds")
            .into_iter()
            .filter(|id| is_browser_fill_id(id))
            .collect(),
    })
}

fn object_field(value: &Value, name: &str) -> Value {
    match value.get(name) {
        Some(object @ Value::Object(_)) => object.clone(),
        _ => Value::Object(Map::new()),
    }
}

impl BoxSessionClient {
    /// One browser-fills call. Unlike `request`, a refusal keeps its
    /// `browser_fill_echoed` details. The request body is never logged.
    async fn fill_request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, BrowserFillError> {
        let mut request = self
            .http
            .request(method, format!("{}{path}", self.base))
            .header(reqwest::header::AUTHORIZATION, self.authorization()?)
            .timeout(self.timeout.max(DESKTOP_CALL_TIMEOUT));
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|error| {
            BoxApiError::transport(format!(
                "Box browser fill request failed: {}",
                error.without_url()
            ))
        })?;
        let status = response.status();
        let headers = response.headers().clone();
        let text = crate::capture::response_text(response)
            .await
            .map_err(|error| {
                BoxApiError::transport(format!("Box browser fill response failed: {error}"))
            })?;
        if !status.is_success() {
            return Err(BrowserFillError {
                error: parse_box_error(status.as_u16(), &headers, &text),
                echoed: echoed_details(status.as_u16(), &text),
            });
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|error| {
            BrowserFillError::from(invalid_response(format!(
                "Box browser fill returned invalid JSON: {error}"
            )))
        })
    }

    /// Resolve the fill's element and report its page. Sends no secret. A
    /// `404` reads as `409 browser_fill_unsupported`.
    pub async fn browser_fill_prepare(
        &self,
        id: &WorkspaceId,
        target: &BrowserFillTarget,
    ) -> Result<BrowserFillPrepared, BrowserFillError> {
        check_box_id(&id.0)?;
        check_target(target)?;
        let mut body = json!({
            "ref": target.element_ref,
            "field": target.field.wire_name(),
            "pageHosts": target.page_hosts,
            "bindHosts": target.bind_hosts,
            "submitUrls": target.submit_urls,
        });
        if let Some(tab_id) = &target.tab_id {
            body["tabId"] = json!(tab_id);
        }
        let path = format!("/boxes/{}/browser-fills", id.0);
        let value = match self
            .fill_request(reqwest::Method::POST, &path, Some(body))
            .await
        {
            Err(BrowserFillError {
                error: BoxApiError::NotFound,
                ..
            }) => {
                return Err(BrowserFillError::from(BoxApiError::Http {
                    status: 409,
                    code: BROWSER_FILL_UNSUPPORTED.to_owned(),
                    message: "This Box service cannot fill credentials.".to_owned(),
                }))
            }
            other => other?,
        };
        let fill_id = value["fillId"].as_str().unwrap_or_default();
        let page_url = value["pageUrl"].as_str().unwrap_or_default();
        if !is_browser_fill_id(fill_id) || page_url.is_empty() || !value["tab"].is_object() {
            return Err(BrowserFillError::from(invalid_response(
                "the Box answered a browser fill prepare with something malformed",
            )));
        }
        Ok(BrowserFillPrepared {
            fill_id: fill_id.to_owned(),
            page_url: page_url.to_owned(),
            tab: object_field(&value, "tab"),
        })
    }

    /// Send a prepared fill's value. A placeholder commit must repeat the
    /// prepare's login URLs.
    pub async fn browser_fill_commit(
        &self,
        id: &WorkspaceId,
        fill_id: &str,
        value: &BrowserFillValue,
    ) -> Result<BrowserFillCommitted, BrowserFillError> {
        check_box_id(&id.0)?;
        check_fill_id(fill_id)?;
        let body = commit_body(value)?;
        let path = format!("/boxes/{}/browser-fills/{fill_id}", id.0);
        let answer = self
            .fill_request(reqwest::Method::POST, &path, Some(body))
            .await?;
        Ok(BrowserFillCommitted {
            filled: answer["filled"].as_bool() == Some(true),
            protected: answer["protected"].as_bool() == Some(true),
            tab: object_field(&answer, "tab"),
        })
    }

    /// A fill's state. Ended fills stay readable for 10 minutes.
    pub async fn browser_fill_status(
        &self,
        id: &WorkspaceId,
        fill_id: &str,
    ) -> Result<BrowserFillStatus, BoxApiError> {
        check_box_id(&id.0)?;
        check_fill_id(fill_id)?;
        let path = format!("/boxes/{}/browser-fills/{fill_id}", id.0);
        let value = self
            .fill_request(reqwest::Method::GET, &path, None)
            .await
            .map_err(|failure| failure.error)?;
        let state = value["state"]
            .as_str()
            .and_then(BrowserFillState::parse)
            .ok_or_else(|| invalid_response("the Box answered a fill status without a state"))?;
        let pair = |name: &str, first: &str| -> Option<(String, String)> {
            let entry = value.get(name)?;
            Some((
                entry.get(first)?.as_str()?.to_owned(),
                entry.get("path")?.as_str()?.to_owned(),
            ))
        };
        Ok(BrowserFillStatus {
            state,
            consumed: pair("consumed", "method"),
            echoed: pair("echoed", "host"),
        })
    }

    /// Cancel a fill: idempotent, and revoked at the sidecar within about two
    /// seconds. An unknown fill (`404`) has nothing left to cancel.
    pub async fn browser_fill_cancel(
        &self,
        id: &WorkspaceId,
        fill_id: &str,
    ) -> Result<(), BoxApiError> {
        check_box_id(&id.0)?;
        check_fill_id(fill_id)?;
        let path = format!("/boxes/{}/browser-fills/{fill_id}", id.0);
        match self
            .fill_request(reqwest::Method::DELETE, &path, None)
            .await
        {
            Ok(_)
            | Err(BrowserFillError {
                error: BoxApiError::NotFound,
                ..
            }) => Ok(()),
            Err(failure) => Err(failure.error),
        }
    }
}
