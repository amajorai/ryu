//! Raw RFC822 → normalized message, via the pure-Rust `mail-parser` crate.
//! Tracer copy of `apps/core/src/mail/mime.rs` (verbatim).
//!
//! Deliberately conservative: extract the headers/bodies the inbox UI needs and
//! best-effort attachments. Anything we cannot parse degrades to an empty/default
//! value rather than failing the whole receive.

use mail_parser::MessageParser;

use super::store::RawAttachment;

/// A parsed inbound message ready to store.
pub struct ParsedInbound {
    pub message_id: String,
    pub in_reply_to: Option<String>,
    pub from_addr: String,
    pub to_addrs: Vec<String>,
    pub cc_addrs: Vec<String>,
    pub subject: String,
    pub text: Option<String>,
    pub html: Option<String>,
    pub attachments: Vec<RawAttachment>,
}

/// Best-effort attachment filename. mail-parser's per-part filename accessor is
/// unstable across minor versions, so v1 uses a positional fallback at the call
/// site (`attachment-N`) when this returns None.
fn attachment_filename(_part: &mail_parser::MessagePart<'_>) -> Option<String> {
    None
}

fn addresses(addr: Option<&mail_parser::Address<'_>>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(a) = addr {
        for item in a.iter() {
            if let Some(email) = item.address() {
                out.push(email.to_string());
            }
        }
    }
    out
}

/// Parse a raw RFC822 body. Returns `None` only when the bytes are not a parseable
/// message at all.
pub fn parse_raw(raw: &[u8]) -> Option<ParsedInbound> {
    let msg = MessageParser::default().parse(raw)?;

    let from_addr = addresses(msg.from()).into_iter().next().unwrap_or_default();
    let to_addrs = addresses(msg.to());
    let cc_addrs = addresses(msg.cc());
    let subject = msg.subject().unwrap_or_default().to_string();
    let message_id = msg
        .message_id()
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("<{}@ryu.local>", uuid::Uuid::new_v4()));
    let in_reply_to = msg.in_reply_to().as_text().map(|s| s.to_string());
    let text = msg.body_text(0).map(|c| c.to_string());
    let html = msg.body_html(0).map(|c| c.to_string());

    let mut attachments = Vec::new();
    for (idx, part) in msg.attachments().enumerate() {
        let filename = attachment_filename(part).unwrap_or_else(|| format!("attachment-{idx}"));
        attachments.push(RawAttachment {
            filename,
            content_type: "application/octet-stream".to_string(),
            bytes: part.contents().to_vec(),
        });
    }

    Some(ParsedInbound {
        message_id,
        in_reply_to,
        from_addr,
        to_addrs,
        cc_addrs,
        subject,
        text,
        html,
        attachments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_message() {
        let raw = b"From: alice@example.com\r\nTo: bob@node.example\r\nSubject: Hi\r\nMessage-ID: <abc@example.com>\r\n\r\nHello world\r\n";
        let p = parse_raw(raw).expect("parse");
        assert_eq!(p.from_addr, "alice@example.com");
        assert_eq!(p.to_addrs, vec!["bob@node.example".to_string()]);
        assert_eq!(p.subject, "Hi");
        assert_eq!(p.message_id, "abc@example.com");
        assert!(p.text.unwrap_or_default().contains("Hello world"));
    }
}
