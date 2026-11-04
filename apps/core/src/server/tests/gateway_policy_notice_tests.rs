use crate::server::{attach_gateway_policy_notice, PolicyApplyOutcome};
use serde_json::json;

/// A remote/externally-managed gateway: the policy flag flipped but the running
/// gateway was NOT reconfigured, so the response must carry `externally_managed:
/// true` AND the manual-restart notice — the whole point of the item-2 fix
/// (Core must stop reporting a security control as ON when it is a no-op).
#[test]
fn externally_managed_response_carries_the_flag_and_notice() {
    let mut body = json!({ "success": true });
    attach_gateway_policy_notice(
        &mut body,
        PolicyApplyOutcome {
            gateway_touched: true,
            gateway_externally_managed: true,
        },
    );
    assert_eq!(body["externally_managed"], json!(true));
    assert!(
        body["notice"]
            .as_str()
            .is_some_and(|s| s.to_ascii_lowercase().contains("restart")),
        "must tell the caller a manual gateway restart is required, got {:?}",
        body["notice"]
    );
}

/// A Core-managed gateway that WAS reconfigured: the flag is present and `false`
/// (honest positive confirmation), and there is no restart notice.
#[test]
fn managed_and_reconfigured_response_says_false_with_no_notice() {
    let mut body = json!({ "success": true });
    attach_gateway_policy_notice(
        &mut body,
        PolicyApplyOutcome {
            gateway_touched: true,
            gateway_externally_managed: false,
        },
    );
    assert_eq!(body["externally_managed"], json!(false));
    assert!(
        body.get("notice").is_none(),
        "no restart notice when reconfigured"
    );
}

/// An enable/disable that touched NO gateway policy must not add the fields at
/// all — they would be meaningless noise on an ordinary plugin toggle.
#[test]
fn untouched_gateway_adds_no_fields() {
    let mut body = json!({ "success": true });
    attach_gateway_policy_notice(&mut body, PolicyApplyOutcome::default());
    assert!(body.get("externally_managed").is_none());
    assert!(body.get("notice").is_none());
}
