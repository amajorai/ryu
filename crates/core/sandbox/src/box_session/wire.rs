//! Wire helpers shared by the Box session verbs: request bodies, response
//! parsing, and local validation.

use super::*;

/// The `POST /boxes` body for a disposable Box. `type` and `size` carry the
/// same value: the Ryu Box service reads either, and upstream providers read
/// `type`.
pub(super) fn create_body(spec: &DisposableBoxSpec) -> Value {
    let mut body = Map::new();
    body.insert("name".into(), json!(spec.name));
    body.insert("type".into(), json!(spec.size.as_str()));
    body.insert("size".into(), json!(spec.size.as_str()));
    body.insert("noEnv".into(), json!(true));
    body.insert("desktop".into(), json!(spec.desktop));
    if !spec.labels.is_empty() {
        body.insert("labels".into(), json!(spec.labels));
    }
    body.insert("network".into(), json!(spec.network.wire_mode()));
    if let BoxNetwork::Allowlist(hosts) = &spec.network {
        body.insert("allowedHosts".into(), json!(hosts));
    }
    body.insert("setup".into(), json!(spec.setup));
    body.insert("ttlSeconds".into(), json!(spec.ttl_seconds));
    if let Some(image) = &spec.image {
        body.insert("image".into(), json!(image));
    }
    Value::Object(body)
}

/// A request Core refused to send.
pub(super) fn invalid_request(message: impl Into<String>) -> BoxApiError {
    BoxApiError::Http {
        status: 400,
        code: "invalid_request".to_owned(),
        message: message.into(),
    }
}

/// A success response Core could not use.
pub(super) fn invalid_response(message: impl Into<String>) -> BoxApiError {
    BoxApiError::Http {
        status: 502,
        code: "invalid_response".to_owned(),
        message: message.into(),
    }
}

/// Labels as the Box service accepts them (`parseLabels`).
pub(super) fn validate_labels(labels: &BTreeMap<String, String>) -> Result<(), BoxApiError> {
    if labels.len() > MAX_BOX_LABELS {
        return Err(invalid_request(format!(
            "a Box may carry at most {MAX_BOX_LABELS} labels"
        )));
    }
    for (key, value) in labels {
        let key_valid = !key.is_empty()
            && key.len() <= MAX_BOX_LABEL_KEY_CHARS
            && key
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        if !key_valid {
            return Err(invalid_request(format!(
                "Box label keys must match ^[a-z0-9-]{{1,{MAX_BOX_LABEL_KEY_CHARS}}}$"
            )));
        }
        if value.chars().count() > MAX_BOX_LABEL_VALUE_CHARS || value.chars().any(char::is_control)
        {
            return Err(invalid_request(format!(
                "Box label {key} must be at most {MAX_BOX_LABEL_VALUE_CHARS} printable characters"
            )));
        }
    }
    Ok(())
}

/// A `PublicBox` as [`BoxView`]. A missing `size` (an older Box build) reads
/// as `default`, the Box service's own fallback.
pub(super) fn parse_box_view(box_value: &Value) -> Result<BoxView, BoxApiError> {
    let mut object = box_value
        .as_object()
        .cloned()
        .ok_or_else(|| invalid_response("Box response did not contain an object"))?;
    if !object.contains_key("status") {
        if let Some(state) = object.get("state").cloned() {
            object.insert("status".into(), state);
        }
    }
    object
        .entry("size")
        .or_insert_with(|| json!(BoxSize::Default.as_str()));
    let view: BoxView = serde_json::from_value(Value::Object(object))
        .map_err(|error| invalid_response(format!("Box response was invalid: {error}")))?;
    check_box_id(&view.id)?;
    Ok(view)
}

/// The access-token answer for the `desktop` scope, with any URL Core must
/// not hand on removed.
pub(super) fn parse_desktop_token(value: Value) -> Result<DesktopToken, BoxApiError> {
    let token_value = value
        .get("accessToken")
        .filter(|nested| nested.is_object())
        .cloned()
        .unwrap_or(value);
    let mut token: DesktopToken = serde_json::from_value(token_value)
        .map_err(|_| invalid_response("Box desktop token response was invalid"))?;
    if token.token.expose_secret().trim().is_empty() || token.expires_at.trim().is_empty() {
        return Err(invalid_response(
            "Box desktop token response was incomplete",
        ));
    }
    if token.protocols.is_empty() {
        return Err(invalid_response(
            "Box desktop token response named no WebSocket protocols",
        ));
    }
    token.url = token.url.filter(|url| is_dialable_stream_url(url));
    Ok(token)
}

/// An absolute `ws(s)`/`http(s)` URL that does not carry a token.
pub(super) fn is_dialable_stream_url(raw: &str) -> bool {
    let Ok(url) = Url::parse(raw) else {
        return false;
    };
    matches!(url.scheme(), "ws" | "wss" | "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && !raw.contains("access_token")
}

pub(super) fn check_browser_verb(verb: &str) -> Result<(), BoxApiError> {
    let mut bytes = verb.bytes();
    let valid = verb.len() <= MAX_BROWSER_VERB_CHARS
        && bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && bytes.all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || byte == b'_'
                || byte == b'.'
                || byte == b'-'
        });
    if valid {
        Ok(())
    } else {
        Err(invalid_request("invalid browser verb"))
    }
}

/// Box ids match Box's `assertBoxId`: `^bx_[a-f0-9]{32}$`.
pub(super) fn is_box_id(id: &str) -> bool {
    id.strip_prefix("bx_").is_some_and(|hex| {
        hex.len() == 32
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub(super) fn validate_box_id(id: &str) -> Result<()> {
    if is_box_id(id) {
        Ok(())
    } else {
        bail!("invalid Box id")
    }
}

pub(super) fn check_box_id(id: &str) -> Result<(), BoxApiError> {
    if is_box_id(id) {
        Ok(())
    } else {
        Err(invalid_request("invalid Box id"))
    }
}
