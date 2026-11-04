use crate::server::identity_from_headers;
use axum::http::{HeaderMap, HeaderName, HeaderValue};

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in pairs {
        h.insert(
            k.parse::<HeaderName>().unwrap(),
            HeaderValue::from_str(v).unwrap(),
        );
    }
    h
}

#[test]
fn parses_all_fields_and_url_decodes_user() {
    let id = identity_from_headers(&headers(&[
        ("x-ryu-client-id", "c1"),
        ("x-ryu-client-label", "Desktop"),
        ("x-ryu-surface", "desktop"),
        ("x-ryu-user-id", "a%40x.com"),
        ("x-ryu-user-name", "Jia%20Wei"),
    ]));
    assert_eq!(id.client_id, "c1");
    assert_eq!(id.client_label.as_deref(), Some("Desktop"));
    assert_eq!(id.surface.as_deref(), Some("desktop"));
    // user_id/user_name are percent-decoded (clients URL-encode them).
    assert_eq!(id.user_id.as_deref(), Some("a@x.com"));
    assert_eq!(id.user_name.as_deref(), Some("Jia Wei"));
    assert!(id.is_trackable());
}

#[test]
fn decodes_non_ascii_display_name() {
    // "山田太郎" — a non-Latin1 name would be an invalid raw header value, so
    // clients send it URL-encoded and Core decodes it back here.
    let id = identity_from_headers(&headers(&[
        ("x-ryu-client-id", "c1"),
        ("x-ryu-user-name", "%E5%B1%B1%E7%94%B0%E5%A4%AA%E9%83%8E"),
    ]));
    assert_eq!(id.user_name.as_deref(), Some("山田太郎"));
}

#[test]
fn missing_client_id_is_untrackable() {
    let id = identity_from_headers(&headers(&[("x-ryu-user-id", "a%40x.com")]));
    assert!(!id.is_trackable());
    assert_eq!(id.client_id, "");
    // The user is still parsed even when the request can't be tracked.
    assert_eq!(id.user_id.as_deref(), Some("a@x.com"));
}

#[test]
fn empty_headers_yield_empty_identity() {
    let id = identity_from_headers(&HeaderMap::new());
    assert!(!id.is_trackable());
    assert!(id.user_id.is_none());
    assert!(id.user_name.is_none());
}

#[test]
fn blank_header_values_are_ignored() {
    let id = identity_from_headers(&headers(&[
        ("x-ryu-client-id", "   "),
        ("x-ryu-user-name", ""),
    ]));
    assert!(!id.is_trackable());
    assert!(id.user_name.is_none());
}
