use serde_json::json;

use super::claims::{
    cancel_conversation, claim, is_device_call, register, submit_result, CallEvent, ClaimPhase,
    ClaimRequest, DeviceCallSpec, ResultSubmission, EXECUTION_WINDOW_MS, RESUMABLE_MS,
};
use super::codes::DeviceErrorCode;

fn spec(conversation: &str, awaiting_permission: bool) -> DeviceCallSpec {
    DeviceCallSpec {
        conversation_id: conversation.to_owned(),
        tool_call_id: "call-1".to_owned(),
        owner_principal_id: "user:u1".to_owned(),
        target_device_id: "phone-a".to_owned(),
        tool: "device.calendar.create".to_owned(),
        input: json!({ "title": "Dentist" }),
        input_sha256: "abc".to_owned(),
        awaiting_permission,
        security_confirmed: false,
    }
}

fn claim_req<'a>(
    conversation: &'a str,
    device: &'a str,
    phase: ClaimPhase,
    now: i64,
) -> ClaimRequest<'a> {
    ClaimRequest {
        conversation_id: conversation,
        tool_call_id: "call-1",
        principal_id: "user:u1",
        device_id: device,
        phase,
        foreground: true,
        now_ms: now,
    }
}

fn result<'a>(
    conversation: &'a str,
    claim_id: &'a str,
    sha: &'a str,
    now: i64,
) -> ResultSubmission<'a> {
    ResultSubmission {
        conversation_id: conversation,
        tool_call_id: "call-1",
        claim_id,
        principal_id: "user:u1",
        device_id: "phone-a",
        input_sha256: sha,
        result: json!({ "ok": true, "data": { "id": "evt" } }),
        now_ms: now,
    }
}

#[tokio::test]
async fn a_call_is_claimed_once_by_its_target_and_returns_the_frozen_input() {
    let (mut events, _cleanup) = register(spec("claims-c1", false), 1_000).unwrap();
    assert!(is_device_call("claims-c1", "call-1"));
    assert_eq!(
        register(spec("claims-c1", false), 1_000).err(),
        Some(DeviceErrorCode::AlreadyClaimed)
    );
    assert_eq!(
        claim(&claim_req(
            "claims-c1",
            "phone-b",
            ClaimPhase::Execute,
            1_001
        )),
        Err(DeviceErrorCode::NotFound)
    );
    let background = ClaimRequest {
        foreground: false,
        ..claim_req("claims-c1", "phone-a", ClaimPhase::Execute, 1_001)
    };
    assert_eq!(claim(&background), Err(DeviceErrorCode::ForegroundRequired));
    let grant = claim(&claim_req(
        "claims-c1",
        "phone-a",
        ClaimPhase::Execute,
        1_002,
    ))
    .unwrap();
    assert_eq!(grant.input, Some(json!({ "title": "Dentist" })));
    assert_eq!(grant.input_sha256, "abc");
    assert_eq!(grant.deadline_ms, 1_002 + EXECUTION_WINDOW_MS);
    assert_eq!(
        claim(&claim_req(
            "claims-c1",
            "phone-a",
            ClaimPhase::Execute,
            1_003
        )),
        Err(DeviceErrorCode::AlreadyClaimed)
    );
    assert!(matches!(
        events.recv().await,
        Some(CallEvent::Claimed {
            phase: ClaimPhase::Execute,
            ..
        })
    ));

    assert_eq!(
        submit_result(result("claims-c1", "wrong-claim", "abc", 1_004)),
        Err(DeviceErrorCode::NotFound)
    );
    assert_eq!(
        submit_result(result("claims-c1", &grant.claim_id, "changed", 1_004)),
        Err(DeviceErrorCode::InputMismatch)
    );
    submit_result(result("claims-c1", &grant.claim_id, "abc", 1_005)).unwrap();
    assert!(matches!(events.recv().await, Some(CallEvent::Result(_))));
    assert_eq!(
        submit_result(result("claims-c1", &grant.claim_id, "abc", 1_006)),
        Err(DeviceErrorCode::NotFound),
        "single use"
    );
}

#[tokio::test]
async fn a_result_after_the_execution_window_is_refused() {
    let (_events, _cleanup) = register(spec("claims-c2", false), 0).unwrap();
    let grant = claim(&claim_req("claims-c2", "phone-a", ClaimPhase::Execute, 10)).unwrap();
    let late = result(
        "claims-c2",
        &grant.claim_id,
        "abc",
        10 + EXECUTION_WINDOW_MS + 1,
    );
    assert_eq!(submit_result(late), Err(DeviceErrorCode::DeviceTimeout));
}

#[test]
fn the_permission_rearm_happens_once_and_never_extends_resumability() {
    let (_events, _cleanup) = register(spec("claims-c3", true), 0).unwrap();
    let near_end = RESUMABLE_MS - 1_000;
    // The wait window (5 min) has passed long before; a late permission claim times out.
    assert_eq!(
        claim(&claim_req(
            "claims-c3",
            "phone-a",
            ClaimPhase::Permission,
            near_end
        )),
        Err(DeviceErrorCode::DeviceTimeout)
    );
    let first = claim(&claim_req(
        "claims-c3",
        "phone-a",
        ClaimPhase::Permission,
        100,
    ))
    .unwrap();
    assert_eq!(first.input, None);
    assert_eq!(
        claim(&claim_req(
            "claims-c3",
            "phone-a",
            ClaimPhase::Permission,
            200
        )),
        Err(DeviceErrorCode::AlreadyClaimed)
    );
    let execute = claim(&claim_req("claims-c3", "phone-a", ClaimPhase::Execute, 300)).unwrap();
    assert!(execute.deadline_ms <= RESUMABLE_MS);
    assert!(execute.input.is_some());
}

#[tokio::test]
async fn cancelling_the_conversation_drops_pending_calls() {
    let (mut events, _cleanup) = register(spec("claims-c4", false), 0).unwrap();
    assert_eq!(cancel_conversation("claims-c4"), 1);
    assert!(events.recv().await.is_none());
    assert_eq!(
        claim(&claim_req("claims-c4", "phone-a", ClaimPhase::Execute, 1)),
        Err(DeviceErrorCode::NotFound)
    );
}

#[test]
fn the_claim_says_whether_the_user_confirmed_a_security_action_on_the_phone() {
    let conversation = format!("conv-sec-{}", uuid::Uuid::new_v4().simple());
    let now = 1_000;
    let (_plain_rx, _plain) = register(spec(&conversation, false), now).unwrap();
    let grant = claim(&claim_req(
        &conversation,
        "phone-a",
        ClaimPhase::Execute,
        now,
    ))
    .unwrap();
    assert!(!grant.security_confirmed);
    let confirmed = format!("conv-sec-{}", uuid::Uuid::new_v4().simple());
    let (_rx, _cleanup) = register(
        DeviceCallSpec {
            security_confirmed: true,
            ..spec(&confirmed, false)
        },
        now,
    )
    .unwrap();
    let grant = claim(&claim_req(&confirmed, "phone-a", ClaimPhase::Execute, now)).unwrap();
    assert!(grant.security_confirmed);
}
