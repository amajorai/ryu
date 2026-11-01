use crate::contract::{Delivery, Disposition, ErrorCode, GhostError, Retry};

#[test]
fn retry_derivation_table() {
    let cases = [
        (Delivery::NotDelivered, Retry::Safe, false),
        (Delivery::Unknown, Retry::Unknown, false),
        (Delivery::DeliveryUncertain, Retry::Unsafe, true),
        (Delivery::DeliveredUnverified, Retry::Unsafe, true),
        (Delivery::DeliveredVerified, Retry::Unsafe, true),
    ];
    for (d, r, maybe) in cases {
        assert_eq!(d.retry(), r, "{d:?}");
        assert_eq!(d.maybe_delivered(), maybe, "{d:?}");
        assert_eq!(
            Disposition::from(d),
            Disposition {
                delivery: d,
                retry: r
            }
        );
    }
}

#[test]
fn default_delivery_per_code() {
    assert_eq!(
        ErrorCode::StaleRef.default_delivery(),
        Delivery::NotDelivered
    );
    assert_eq!(
        ErrorCode::PolicyDenied.default_delivery(),
        Delivery::NotDelivered
    );
    for c in [
        ErrorCode::ActionFailed,
        ErrorCode::Timeout,
        ErrorCode::AppUnresponsive,
        ErrorCode::Internal,
    ] {
        assert_eq!(c.default_delivery(), Delivery::Unknown);
    }
    assert_eq!(
        serde_json::to_value(ErrorCode::PlatformNotSupported).unwrap(),
        "PLATFORM_NOT_SUPPORTED"
    );
    assert_eq!(ErrorCode::UnknownTool.as_str(), "UNKNOWN_TOOL");
}

#[test]
fn to_json_shape() {
    let e = GhostError::stale_ref("gone");
    let v = e.to_json();
    assert_eq!(
        v,
        serde_json::json!({
            "code": "STALE_REF",
            "message": "gone",
            "disposition": {"delivery": "not_delivered", "retry": "safe"}
        })
    );
    let e = GhostError::ambiguous("two", serde_json::json!([{"a": 1}, {"a": 2}]))
        .with_suggestion("snapshot again");
    let v = serde_json::to_value(&e).unwrap();
    assert_eq!(v["code"], "AMBIGUOUS_TARGET");
    assert_eq!(v["suggestion"], "snapshot again");
    assert_eq!(v["details"]["candidate_count"], 2);
    assert_eq!(v["details"]["candidates"][1]["a"], 2);
}

#[test]
fn display_is_code_colon_message() {
    let e = GhostError::invalid_args("bad ref");
    assert_eq!(e.to_string(), "INVALID_ARGS: bad ref");
}

#[test]
fn downcast_through_anyhow_round_trips() {
    let e = GhostError::timeout("slow", Delivery::DeliveredUnverified)
        .with_details(serde_json::json!({"k": 1}));
    let any = anyhow::Error::from(e.clone());
    assert_eq!(any.downcast_ref::<GhostError>(), Some(&e));
    assert_eq!(GhostError::from_anyhow(&any), e);
}

#[test]
fn from_anyhow_plain_error_is_internal() {
    let any = anyhow::anyhow!("boom");
    let e = GhostError::from_anyhow(&any);
    assert_eq!(e.code, ErrorCode::Internal);
    assert_eq!(e.message, "boom");
    assert_eq!(e.delivery, Delivery::Unknown);
}

#[test]
fn after_delivery_upgrades_only_not_delivered() {
    let e = GhostError::not_found("x").after_delivery(Delivery::DeliveredVerified);
    assert_eq!(e.delivery, Delivery::DeliveredUnverified);
    let e = GhostError::not_found("x").after_delivery(Delivery::NotDelivered);
    assert_eq!(e.delivery, Delivery::NotDelivered);
    let e = GhostError::internal("x").after_delivery(Delivery::DeliveredVerified);
    assert_eq!(e.delivery, Delivery::Unknown);
    assert_eq!(e.disposition().retry, Retry::Unknown);
}
