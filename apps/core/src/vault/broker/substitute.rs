//! Placeholder grammar and substitution.
//!
//! An agent writes a placeholder such as `__OPENAI_KEY__` where a credential
//! belongs; the broker swaps it for the resolved value on the surfaces the
//! service allows. Grammar: two underscores, 1-64 characters of
//! `[A-Za-z0-9_-]`, two underscores (only RFC 3986 unreserved characters, so a
//! placeholder survives URL encoding unchanged).
//!
//! Surfaces: `header` (the default; raw, and a value with CR, LF, or NUL fails
//! closed), `path` and `query` (explicit opt-in; value percent-encoded), and
//! `body` (explicit opt-in; JSON bodies
//! get JSON-string escaping, form bodies percent-encoding, `text/*` and XML the
//! raw value; compressed, multipart, binary, non-UTF-8, and bodies over
//! [`MAX_BODY_SUBSTITUTION_BYTES`] are left untouched).
//!
//! Path, query, and body are opt-in because upstreams reflect them: a 404 page
//! that echoes the path, a search endpoint that echoes the query, or a
//! redirect whose `Location` carries the URL would hand the substituted
//! credential back to the agent, which chooses the request. Enable them only
//! for upstreams known not to echo those parts.
//!
//! Header templates in `custom` auth use `{{secret:REF}}` tokens.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

/// Largest body the broker rewrites.
pub const MAX_BODY_SUBSTITUTION_BYTES: usize = 1024 * 1024;
const MAX_PLACEHOLDER_INNER: usize = 64;

/// Where a placeholder may be substituted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    Header,
    Query,
    Path,
    Body,
}

/// Default surfaces when a substitution names none: headers only. Path,
/// query, and body are reflected by many upstreams and must be named
/// explicitly.
pub fn default_surfaces() -> Vec<Surface> {
    vec![Surface::Header]
}

/// Whether `value` is a valid `__NAME__` placeholder.
pub fn is_valid_placeholder(value: &str) -> bool {
    let Some(inner) = value
        .strip_prefix("__")
        .and_then(|rest| rest.strip_suffix("__"))
    else {
        return false;
    };
    !inner.is_empty()
        && inner.len() <= MAX_PLACEHOLDER_INNER
        && inner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Replace every placeholder in `input` with its encoded value. Returns `None`
/// when nothing matched, so callers can skip rebuilding untouched parts.
pub fn replace_all(
    input: &str,
    pairs: &[(String, String)],
    encode: impl Fn(&str) -> String,
) -> Option<String> {
    if !pairs
        .iter()
        .any(|(placeholder, _)| input.contains(placeholder))
    {
        return None;
    }
    let mut out = input.to_owned();
    for (placeholder, value) in pairs {
        if out.contains(placeholder) {
            out = out.replace(placeholder, &encode(value));
        }
    }
    Some(out)
}

/// Percent-encode for a path segment or query component.
pub fn encode_url(value: &str) -> String {
    urlencoding::encode(value).into_owned()
}

/// A header value must not smuggle CR, LF, or NUL.
pub fn is_safe_header_value(value: &str) -> bool {
    !value.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0)
}

/// How a request body can be rewritten.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyKind {
    Json,
    Form,
    Text,
    /// Not rewritten (binary, multipart, compressed, or unknown).
    Opaque,
}

/// Classify a body from its `Content-Type` and `Content-Encoding`.
pub fn body_kind(content_type: Option<&str>, content_encoding: Option<&str>) -> BodyKind {
    if content_encoding.is_some_and(|enc| !enc.trim().eq_ignore_ascii_case("identity")) {
        return BodyKind::Opaque;
    }
    let Some(content_type) = content_type else {
        return BodyKind::Opaque;
    };
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if mime == "application/json" || mime.ends_with("+json") {
        BodyKind::Json
    } else if mime == "application/x-www-form-urlencoded" {
        BodyKind::Form
    } else if mime.starts_with("text/") || mime == "application/xml" || mime.ends_with("+xml") {
        BodyKind::Text
    } else {
        BodyKind::Opaque
    }
}

/// Escape a value for the inside of a JSON string literal.
pub fn encode_json_string(value: &str) -> String {
    let quoted = serde_json::to_string(value).unwrap_or_default();
    quoted
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or_default()
        .to_owned()
}

/// Rewrite a body, or `None` when it is opaque, too large, not UTF-8, or has
/// no placeholder.
pub fn substitute_body(body: &[u8], kind: BodyKind, pairs: &[(String, String)]) -> Option<Vec<u8>> {
    if kind == BodyKind::Opaque || body.len() > MAX_BODY_SUBSTITUTION_BYTES {
        return None;
    }
    let text = std::str::from_utf8(body).ok()?;
    let rewritten = match kind {
        BodyKind::Json => replace_all(text, pairs, encode_json_string),
        BodyKind::Form => replace_all(text, pairs, encode_url),
        BodyKind::Text => replace_all(text, pairs, str::to_owned),
        BodyKind::Opaque => None,
    }?;
    Some(rewritten.into_bytes())
}

/// One piece of a `{{secret:REF}}` header template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Literal(String),
    /// A full `secret:` reference.
    Ref(String),
}

/// Parse a header template. Every `{{ ... }}` must hold a valid reference.
pub fn parse_template(template: &str) -> Result<Vec<Segment>> {
    let mut segments = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        if start > 0 {
            segments.push(Segment::Literal(rest[..start].to_owned()));
        }
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            bail!("unterminated `{{{{` in header template");
        };
        let reference = after[..end].trim();
        validate_ref(reference)?;
        segments.push(Segment::Ref(reference.to_owned()));
        rest = &after[end + 2..];
    }
    if !rest.is_empty() {
        segments.push(Segment::Literal(rest.to_owned()));
    }
    Ok(segments)
}

/// The password-manager reference a credential reference names: a bare
/// `op://…` / `bws://…`, or the same behind `secret:`.
pub fn pm_ref_text(reference: &str) -> Option<&str> {
    let body = reference.strip_prefix("secret:").unwrap_or(reference);
    crate::vault::password_managers::has_pm_scheme(body).then_some(body)
}

/// Whether `value` is a credential reference rather than a literal.
pub fn is_credential_ref(value: &str) -> bool {
    value.starts_with("secret:") || pm_ref_text(value).is_some()
}

/// Validate a full credential reference: `secret:NAME`, `secret:ENV:/f/NAME`,
/// or a password-manager reference (`op://…`, `bws://…`, optionally behind
/// `secret:`).
pub fn validate_ref(reference: &str) -> Result<()> {
    if let Some(text) = pm_ref_text(reference) {
        if crate::vault::password_managers::PmRef::parse(text).is_none() {
            bail!("invalid password-manager reference `{reference}`");
        }
        return Ok(());
    }
    let Some(body) = reference.strip_prefix("secret:") else {
        bail!("credential references must start with `secret:`");
    };
    if crate::vault::SecretRef::parse(body).is_none() {
        bail!("invalid credential reference `{reference}`");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs() -> Vec<(String, String)> {
        vec![("__KEY__".to_owned(), "a b\"c&d".to_owned())]
    }

    #[test]
    fn placeholders_follow_the_grammar() {
        for ok in ["__KEY__", "__OPENAI_API_KEY__", "__a-b__", "__x__"] {
            assert!(is_valid_placeholder(ok), "{ok}");
        }
        let long = format!("__{}__", "A".repeat(65));
        for bad in [
            "KEY",
            "__KEY",
            "____",
            "__a b__",
            "__ké__",
            "__a.b__",
            long.as_str(),
        ] {
            assert!(!is_valid_placeholder(bad), "{bad}");
        }
    }

    #[test]
    fn each_surface_uses_its_encoding() {
        assert_eq!(
            replace_all("/v1/__KEY__/x", &pairs(), encode_url).unwrap(),
            "/v1/a%20b%22c%26d/x"
        );
        assert_eq!(replace_all("/v1/none", &pairs(), encode_url), None);
        let json = substitute_body(br#"{"k":"__KEY__"}"#, BodyKind::Json, &pairs()).unwrap();
        assert_eq!(json, br#"{"k":"a b\"c&d"}"#);
        let form = substitute_body(b"k=__KEY__", BodyKind::Form, &pairs()).unwrap();
        assert_eq!(form, b"k=a%20b%22c%26d");
        let text = substitute_body(b"k=__KEY__", BodyKind::Text, &pairs()).unwrap();
        assert_eq!(text, b"k=a b\"c&d");
    }

    #[test]
    fn opaque_large_and_binary_bodies_are_untouched() {
        assert_eq!(
            substitute_body(b"__KEY__", BodyKind::Opaque, &pairs()),
            None
        );
        let big = vec![b'a'; MAX_BODY_SUBSTITUTION_BYTES + 1];
        assert_eq!(substitute_body(&big, BodyKind::Text, &pairs()), None);
        assert_eq!(
            substitute_body(&[0xff, 0xfe], BodyKind::Text, &pairs()),
            None
        );
    }

    #[test]
    fn body_kinds_come_from_headers() {
        assert_eq!(
            body_kind(Some("application/json; charset=utf-8"), None),
            BodyKind::Json
        );
        assert_eq!(
            body_kind(Some("application/vnd.api+json"), None),
            BodyKind::Json
        );
        assert_eq!(
            body_kind(Some("application/x-www-form-urlencoded"), None),
            BodyKind::Form
        );
        assert_eq!(body_kind(Some("text/plain"), None), BodyKind::Text);
        assert_eq!(
            body_kind(Some("application/json"), Some("gzip")),
            BodyKind::Opaque
        );
        assert_eq!(
            body_kind(Some("multipart/form-data; boundary=x"), None),
            BodyKind::Opaque
        );
        assert_eq!(body_kind(None, None), BodyKind::Opaque);
    }

    #[test]
    fn templates_parse_references_and_reject_bad_ones() {
        assert_eq!(
            parse_template("token {{ secret:GH_TOKEN }}!").unwrap(),
            vec![
                Segment::Literal("token ".into()),
                Segment::Ref("secret:GH_TOKEN".into()),
                Segment::Literal("!".into()),
            ]
        );
        assert!(parse_template("{{secret:prod:/db/PASS}}").is_ok());
        assert!(parse_template("{{ GH_TOKEN }}").is_err());
        assert!(parse_template("{{secret:GH").is_err());
        assert!(parse_template("{{secret:bad name}}").is_err());
        assert!(parse_template("Bearer {{op://dev/GitHub/token}}").is_ok());
    }

    #[test]
    fn password_manager_references_are_credential_refs() {
        for ok in [
            "op://dev/GitHub/token",
            "op://work@dev/GitHub/api/token",
            "secret:op://dev/GitHub/token",
            "bws://2b7f2c5e-1a3d-4c4e-9b8a-0123456789ab",
        ] {
            assert!(validate_ref(ok).is_ok(), "{ok}");
            assert!(is_credential_ref(ok), "{ok}");
        }
        for bad in ["op://dev/GitHub", "bws://not-a-uuid", "op://a/b/c?x=1"] {
            assert!(validate_ref(bad).is_err(), "{bad}");
        }
        assert!(!is_credential_ref("alice"));
    }

    #[test]
    fn substitutions_default_to_headers_only() {
        assert_eq!(default_surfaces(), vec![Surface::Header]);
        let parsed: crate::vault::broker::services::Substitution =
            serde_json::from_value(serde_json::json!({
                "placeholder": "__KEY__", "ref": "secret:KEY",
            }))
            .unwrap();
        assert_eq!(parsed.surfaces, vec![Surface::Header]);
    }

    #[test]
    fn header_values_reject_injection() {
        assert!(is_safe_header_value("Bearer abc"));
        assert!(!is_safe_header_value("abc\r\nX-Evil: 1"));
    }
}
