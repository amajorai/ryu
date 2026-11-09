//! Claim-before-execute (design §1.4).
//!
//! An approved device call parks here with its frozen canonical input. Frames
//! never carry that input or any nonce; the target phone receives it only in
//! the response to a signed, single-use claim. The result must then echo the
//! claim id and the frozen hash. The lane is chosen by this record, never by a
//! prefix the client supplies.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;
use tokio::sync::mpsc;

use super::codes::DeviceErrorCode;

/// Waiting for a device or for the OS permission prompt (design §1.6).
pub(crate) const WAIT_WINDOW_MS: i64 = 5 * 60 * 1000;
/// Execution after a claim.
pub(crate) const EXECUTION_WINDOW_MS: i64 = 60 * 1000;
/// Never extended by a re-arm.
pub(crate) const RESUMABLE_MS: i64 = 60 * 60 * 1000;
/// Same cap as the browser lane.
pub(crate) const MAX_RESULT_BYTES: usize = 1_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ClaimPhase {
    Execute,
    Permission,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CallEvent {
    Claimed { phase: ClaimPhase, deadline_ms: i64 },
    Result(Value),
}

/// A call ready to park, built by `dispatch` after the gate approved it.
pub(crate) struct DeviceCallSpec {
    pub(crate) conversation_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) owner_principal_id: String,
    pub(crate) target_device_id: String,
    pub(crate) tool: String,
    pub(crate) input: Value,
    pub(crate) input_sha256: String,
    /// The phone must first show the OS permission prompt.
    pub(crate) awaiting_permission: bool,
    /// A Home security action the user confirmed on the target phone with
    /// biometrics; the phone refuses such a write unless the claim says so.
    pub(crate) security_confirmed: bool,
}

#[derive(Debug)]
enum CallState {
    Ready,
    AwaitingPermission { permission_claimed: bool },
    Claimed { claim_id: String },
}

struct DeviceCall {
    spec: DeviceCallSpec,
    state: CallState,
    deadline_ms: i64,
    resumable_until_ms: i64,
    events: mpsc::UnboundedSender<CallEvent>,
}

type CallKey = (String, String);

fn calls() -> &'static Mutex<HashMap<CallKey, DeviceCall>> {
    static CALLS: OnceLock<Mutex<HashMap<CallKey, DeviceCall>>> = OnceLock::new();
    CALLS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Removes the call when the dispatching turn stops waiting for any reason.
pub(crate) struct CallCleanup(CallKey);

impl Drop for CallCleanup {
    fn drop(&mut self) {
        if let Ok(mut map) = calls().lock() {
            map.remove(&self.0);
        }
    }
}

/// Park an approved call. Refuses a second call with the same id.
pub(crate) fn register(
    spec: DeviceCallSpec,
    now_ms: i64,
) -> Result<(mpsc::UnboundedReceiver<CallEvent>, CallCleanup), DeviceErrorCode> {
    let key = (spec.conversation_id.clone(), spec.tool_call_id.clone());
    let (events, receiver) = mpsc::unbounded_channel();
    let mut map = calls()
        .lock()
        .map_err(|_| DeviceErrorCode::DeviceUnavailable)?;
    map.retain(|_, call| call.resumable_until_ms > now_ms);
    if map.contains_key(&key) {
        return Err(DeviceErrorCode::AlreadyClaimed);
    }
    let state = if spec.awaiting_permission {
        CallState::AwaitingPermission {
            permission_claimed: false,
        }
    } else {
        CallState::Ready
    };
    map.insert(
        key.clone(),
        DeviceCall {
            spec,
            state,
            deadline_ms: now_ms + WAIT_WINDOW_MS,
            resumable_until_ms: now_ms + RESUMABLE_MS,
            events,
        },
    );
    Ok((receiver, CallCleanup(key)))
}

/// Whether a pending device call exists for this pair (selects the lane of
/// `POST /api/chat/client-tool-result`).
pub(crate) fn is_device_call(conversation_id: &str, tool_call_id: &str) -> bool {
    calls()
        .lock()
        .is_ok_and(|map| map.contains_key(&(conversation_id.to_owned(), tool_call_id.to_owned())))
}

pub(crate) struct ClaimRequest<'a> {
    pub(crate) conversation_id: &'a str,
    pub(crate) tool_call_id: &'a str,
    pub(crate) principal_id: &'a str,
    pub(crate) device_id: &'a str,
    pub(crate) phase: ClaimPhase,
    pub(crate) foreground: bool,
    pub(crate) now_ms: i64,
}

#[derive(Debug, PartialEq)]
pub(crate) struct ClaimGrant {
    pub(crate) claim_id: String,
    pub(crate) tool: String,
    /// The frozen input; `None` for a permission-phase claim.
    pub(crate) input: Option<Value>,
    pub(crate) input_sha256: String,
    pub(crate) deadline_ms: i64,
    /// See [`DeviceCallSpec::security_confirmed`].
    pub(crate) security_confirmed: bool,
}

/// Atomically claim a call for its target device.
pub(crate) fn claim(request: &ClaimRequest<'_>) -> Result<ClaimGrant, DeviceErrorCode> {
    let mut map = calls()
        .lock()
        .map_err(|_| DeviceErrorCode::DeviceUnavailable)?;
    let key = (
        request.conversation_id.to_owned(),
        request.tool_call_id.to_owned(),
    );
    let call = map.get_mut(&key).ok_or(DeviceErrorCode::NotFound)?;
    // Another principal or a non-target device learns nothing more than
    // "no such call".
    if call.spec.owner_principal_id != request.principal_id
        || call.spec.target_device_id != request.device_id
    {
        return Err(DeviceErrorCode::NotFound);
    }
    if request.now_ms > call.deadline_ms || request.now_ms > call.resumable_until_ms {
        return Err(DeviceErrorCode::DeviceTimeout);
    }
    if !request.foreground {
        return Err(DeviceErrorCode::ForegroundRequired);
    }
    let deadline_ms = (request.now_ms + EXECUTION_WINDOW_MS).min(call.resumable_until_ms);
    let claim_id = uuid::Uuid::new_v4().to_string();
    let grant_input = match (&call.state, request.phase) {
        (CallState::Claimed { .. }, _) => return Err(DeviceErrorCode::AlreadyClaimed),
        (
            CallState::AwaitingPermission {
                permission_claimed: false,
            },
            ClaimPhase::Permission,
        ) => {
            call.state = CallState::AwaitingPermission {
                permission_claimed: true,
            };
            None
        }
        (_, ClaimPhase::Permission) => return Err(DeviceErrorCode::AlreadyClaimed),
        (_, ClaimPhase::Execute) => {
            call.state = CallState::Claimed {
                claim_id: claim_id.clone(),
            };
            Some(call.spec.input.clone())
        }
    };
    call.deadline_ms = deadline_ms;
    let _ = call.events.send(CallEvent::Claimed {
        phase: request.phase,
        deadline_ms,
    });
    Ok(ClaimGrant {
        claim_id,
        tool: call.spec.tool.clone(),
        input: grant_input,
        input_sha256: call.spec.input_sha256.clone(),
        deadline_ms,
        security_confirmed: call.spec.security_confirmed,
    })
}

pub(crate) struct ResultSubmission<'a> {
    pub(crate) conversation_id: &'a str,
    pub(crate) tool_call_id: &'a str,
    pub(crate) claim_id: &'a str,
    pub(crate) principal_id: &'a str,
    pub(crate) device_id: &'a str,
    pub(crate) input_sha256: &'a str,
    pub(crate) result: Value,
    pub(crate) now_ms: i64,
}

/// Deliver a device result. Single use: the call leaves the registry on the
/// first submission that passes the binding checks.
pub(crate) fn submit_result(submission: ResultSubmission<'_>) -> Result<(), DeviceErrorCode> {
    if submission.result.to_string().len() > MAX_RESULT_BYTES {
        return Err(DeviceErrorCode::InvalidInput);
    }
    if submission
        .result
        .get("ok")
        .and_then(Value::as_bool)
        .is_none()
    {
        return Err(DeviceErrorCode::InvalidInput);
    }
    let mut map = calls()
        .lock()
        .map_err(|_| DeviceErrorCode::DeviceUnavailable)?;
    let key = (
        submission.conversation_id.to_owned(),
        submission.tool_call_id.to_owned(),
    );
    let call = map.get(&key).ok_or(DeviceErrorCode::NotFound)?;
    if call.spec.owner_principal_id != submission.principal_id
        || call.spec.target_device_id != submission.device_id
    {
        return Err(DeviceErrorCode::NotFound);
    }
    match &call.state {
        CallState::Claimed { claim_id } if claim_id == submission.claim_id => {}
        _ => return Err(DeviceErrorCode::NotFound),
    }
    if submission.now_ms > call.deadline_ms {
        return Err(DeviceErrorCode::DeviceTimeout);
    }
    if call.spec.input_sha256 != submission.input_sha256 {
        return Err(DeviceErrorCode::InputMismatch);
    }
    let call = map.remove(&key).ok_or(DeviceErrorCode::NotFound)?;
    call.events
        .send(CallEvent::Result(submission.result))
        .map_err(|_| DeviceErrorCode::DeviceUnavailable)
}

/// Drop every pending call of a conversation (turn cancel or delete).
pub(crate) fn cancel_conversation(conversation_id: &str) -> usize {
    let Ok(mut map) = calls().lock() else {
        return 0;
    };
    let before = map.len();
    map.retain(|(conversation, _), _| conversation != conversation_id);
    before - map.len()
}
