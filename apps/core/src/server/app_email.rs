//! Generic app → Ryu email transport capability.
//!
//! App-owned mailboxes keep their messages, inbox ids, and sender semantics. The
//! node-owned SMTP transport stays here so every app uses the same preferences,
//! secret custody, timeout, and relay implementation.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::json;

use super::ServerState;
use crate::sidecar::ext_proxy::authenticate_sidecar;

const MAX_ADDRESSES: usize = 100;
const MAX_ADDRESS_BYTES: usize = 320;
const MAX_SUBJECT_BYTES: usize = 998;
const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct SendAttachment {
    #[serde(alias = "content_base64", rename = "content")]
    pub content: String,
    pub content_type: String,
    pub filename: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct SendBody {
    #[serde(default)]
    pub attachments: Vec<SendAttachment>,
    #[serde(default)]
    pub bcc: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub html: Option<String>,
    #[serde(default)]
    pub headers: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub reply_to: Vec<String>,
    #[serde(default)]
    pub references: Option<String>,
    pub subject: String,
    pub text: Option<String>,
    pub to: Vec<String>,
}

fn validate_address_list(name: &str, values: &[String]) -> Result<(), String> {
    if values.is_empty() && name == "to" {
        return Err("at least one recipient is required".to_owned());
    }
    if values.len() > MAX_ADDRESSES {
        return Err(format!("{name} has too many addresses"));
    }
    if values.iter().any(|value| {
        value.trim().is_empty() || value.len() > MAX_ADDRESS_BYTES || value.contains(['\r', '\n'])
    }) {
        return Err(format!("{name} contains an invalid address"));
    }
    Ok(())
}

fn validate_send_body(body: &SendBody) -> Result<(), String> {
    validate_address_list("to", &body.to)?;
    validate_address_list("cc", &body.cc)?;
    validate_address_list("bcc", &body.bcc)?;
    validate_address_list("reply_to", &body.reply_to)?;
    if body
        .from
        .as_deref()
        .is_some_and(|value| value.trim().is_empty() || value.len() > MAX_ADDRESS_BYTES)
    {
        return Err("from contains an invalid address".to_owned());
    }
    if body.subject.len() > MAX_SUBJECT_BYTES || body.subject.contains(['\r', '\n']) {
        return Err("subject is too long or contains a newline".to_owned());
    }
    if body.headers.iter().any(|(name, value)| {
        name.trim().is_empty()
            || name.len() > 128
            || name.contains(['\r', '\n', ':', ' '])
            || matches!(
                name.to_ascii_lowercase().as_str(),
                "bcc"
                    | "cc"
                    | "content-disposition"
                    | "content-length"
                    | "content-transfer-encoding"
                    | "content-type"
                    | "date"
                    | "from"
                    | "host"
                    | "in-reply-to"
                    | "message-id"
                    | "mime-version"
                    | "received"
                    | "references"
                    | "reply-to"
                    | "subject"
                    | "to"
            )
            || value.len() > 4096
            || value.contains(['\r', '\n'])
    }) {
        return Err("message header is invalid".to_owned());
    }
    if body.headers.len() > 64 {
        return Err("too many message headers".to_owned());
    }
    let body_bytes = body
        .text
        .as_deref()
        .unwrap_or("")
        .len()
        .saturating_add(body.html.as_deref().unwrap_or("").len())
        .saturating_add(body.in_reply_to.as_deref().unwrap_or("").len())
        .saturating_add(body.references.as_deref().unwrap_or("").len());
    if body_bytes > MAX_BODY_BYTES {
        return Err("message body is too large".to_owned());
    }
    let mut attachment_bytes = 0usize;
    for attachment in &body.attachments {
        if attachment.filename.trim().is_empty()
            || attachment.filename.len() > 255
            || attachment.filename.contains(['\r', '\n'])
            || attachment.content_type.trim().is_empty()
            || attachment.content_type.len() > 255
        {
            return Err("attachment metadata is invalid".to_owned());
        }
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&attachment.content)
            .map_err(|_| "attachment content is not valid base64".to_owned())?;
        attachment_bytes = attachment_bytes.saturating_add(decoded.len());
        if attachment_bytes > MAX_ATTACHMENT_BYTES {
            return Err("attachments are too large".to_owned());
        }
    }
    Ok(())
}

/// `POST /api/host/capability/email.send` — send through the node's configured
/// Ryu SMTP transport. The sidecar supplies message facts; Core owns the relay
/// config and password resolver.
pub(crate) async fn host_email_send(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<SendBody>,
) -> Response {
    let (plugin_id, _) = match authenticate_sidecar(&state, &headers).await {
        Ok(value) => value,
        Err((status, message)) => {
            return (status, Json(json!({ "error": message }))).into_response();
        }
    };
    if plugin_id != "@ryu/mail" {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "email.send is not enabled for this app" })),
        )
            .into_response();
    }
    if let Err(message) = validate_send_body(&body) {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response();
    }
    let Some(config) = ryu_email_send::resolve_transport() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "error": "email transport is not configured" })),
        )
            .into_response();
    };

    let attachments = body
        .attachments
        .into_iter()
        .map(|attachment| {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(attachment.content)
                .map_err(|error| error.to_string())?;
            Ok(ryu_email_send::Attachment {
                bytes,
                content_type: attachment.content_type,
                filename: attachment.filename,
            })
        })
        .collect::<Result<Vec<_>, String>>();
    let attachments = match attachments {
        Ok(value) => value,
        Err(error) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": error }))).into_response();
        }
    };
    let message = ryu_email_send::OutboundEmail {
        from: body.from,
        to: body.to,
        cc: body.cc,
        bcc: body.bcc,
        reply_to: body.reply_to.first().cloned(),
        subject: body.subject,
        text: body.text,
        html: body.html,
        headers: body.headers,
        in_reply_to: body.in_reply_to,
        references: body.references,
        attachments,
    };
    match ryu_email_send::send_email(&config, &message).await {
        Ok(message_id) => {
            (StatusCode::OK, Json(json!({ "messageId": message_id }))).into_response()
        }
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": error.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/host/capability/email.status` — return only whether Ryu has a
/// usable SMTP transport. The password never crosses the callback.
pub(crate) async fn host_email_status(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    let (plugin_id, _) = match authenticate_sidecar(&state, &headers).await {
        Ok(value) => value,
        Err((status, message)) => {
            return (status, Json(json!({ "error": message }))).into_response();
        }
    };
    if plugin_id != "@ryu/mail" {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "email.status is not enabled for this app" })),
        )
            .into_response();
    }
    Json(json!({
        "configured": ryu_email_send::resolve_transport().is_some(),
    }))
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::{validate_send_body, SendBody};

    fn body() -> SendBody {
        SendBody {
            attachments: Vec::new(),
            bcc: Vec::new(),
            cc: Vec::new(),
            from: None,
            html: None,
            headers: std::collections::BTreeMap::new(),
            in_reply_to: None,
            reply_to: Vec::new(),
            references: None,
            subject: "Subject".to_owned(),
            text: Some("Body".to_owned()),
            to: vec!["user@example.com".to_owned()],
        }
    }

    #[test]
    fn rejects_empty_recipients() {
        let mut input = body();
        input.to.clear();
        assert_eq!(
            validate_send_body(&input).unwrap_err(),
            "at least one recipient is required"
        );
    }

    #[test]
    fn rejects_header_injection() {
        let mut input = body();
        input.subject = "hello\nBcc: attacker@example.com".to_owned();
        assert!(validate_send_body(&input).is_err());
    }

    #[test]
    fn threading_headers_share_the_message_body_limit() {
        let mut input = body();
        input.references = Some("x".repeat(super::MAX_BODY_BYTES));
        assert_eq!(
            validate_send_body(&input).unwrap_err(),
            "message body is too large"
        );
    }
}
