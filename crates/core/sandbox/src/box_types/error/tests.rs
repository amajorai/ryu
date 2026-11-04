use super::*;
use reqwest::header::{HeaderValue, RETRY_AFTER};
use serde_json::json;

fn headers(retry_after: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(value) = retry_after {
        headers.insert(RETRY_AFTER, HeaderValue::from_str(value).unwrap());
    }
    headers
}

fn body(code: &str, message: &str) -> String {
    json!({
        "code": code,
        "error": { "code": code, "message": message, "status": 0 },
        "message": message,
        "ok": false,
        "type": "box.error",
    })
    .to_string()
}

#[test]
fn box_types_parse_box_error_maps_capacity_with_retry_after() {
    assert_eq!(
        parse_box_error(
            503,
            &headers(Some("30")),
            &body("capacity_unavailable", "full")
        ),
        BoxApiError::Capacity { retry_after: 30 }
    );
    // Any 503 with Retry-After is capacity, even without the code.
    assert_eq!(
        parse_box_error(503, &headers(Some("12")), "Service Unavailable"),
        BoxApiError::Capacity { retry_after: 12 }
    );
    // The code alone is enough; the delay then defaults, and huge delays clamp.
    assert_eq!(
        parse_box_error(503, &headers(None), &body("capacity_unavailable", "full")),
        BoxApiError::Capacity {
            retry_after: DEFAULT_CAPACITY_RETRY_SECS
        }
    );
    assert_eq!(
        parse_box_error(
            503,
            &headers(Some("999999")),
            &body("capacity_unavailable", "x")
        ),
        BoxApiError::Capacity {
            retry_after: MAX_CAPACITY_RETRY_SECS
        }
    );
    // An HTTP-date Retry-After is not seconds; the default applies.
    assert_eq!(
        parse_box_error(
            503,
            &headers(Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            &body("capacity_unavailable", "x")
        ),
        BoxApiError::Capacity {
            retry_after: DEFAULT_CAPACITY_RETRY_SECS
        }
    );
}

#[test]
fn box_types_parse_box_error_maps_typed_refusals() {
    let none = headers(None);
    assert_eq!(
        parse_box_error(429, &none, &body("quota_exceeded", "limit")),
        BoxApiError::Quota
    );
    assert_eq!(
        parse_box_error(402, &none, &body("insufficient_credits", "top up")),
        BoxApiError::InsufficientCredits
    );
    assert_eq!(
        parse_box_error(402, &none, ""),
        BoxApiError::InsufficientCredits
    );
    assert_eq!(
        parse_box_error(404, &none, &body("not_found", "Box not found.")),
        BoxApiError::NotFound
    );
    assert_eq!(
        parse_box_error(403, &none, &body("billing_owner_mismatch", "core tenant")),
        BoxApiError::BillingOwnerMismatch
    );
    // A plain 503 without Retry-After or the code is not capacity.
    let other = parse_box_error(503, &none, &body("driver_unavailable", "docker down"));
    assert_eq!(
        other,
        BoxApiError::Http {
            status: 503,
            code: "driver_unavailable".to_owned(),
            message: "docker down".to_owned(),
        }
    );
    assert_eq!(other.status(), 503);
    assert_eq!(other.code(), "driver_unavailable");
    let unstructured = parse_box_error(500, &none, &"x".repeat(2000));
    match unstructured {
        BoxApiError::Http { code, message, .. } => {
            assert_eq!(code, "http_500");
            assert!(message.chars().count() <= MAX_ERROR_MESSAGE_CHARS + 1);
        }
        other => panic!("unexpected {other:?}"),
    }
}
