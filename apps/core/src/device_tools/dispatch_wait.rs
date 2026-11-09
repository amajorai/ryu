//! The waiting halves of a device call: routing with `waiting-device` (P3),
//! the claim wait, and parking a call whose wait window ended (P4 Retry
//! fallback, see `pending`). A call routed to a phone that is not the origin
//! sends its request and needs-permission frames only on that phone's device
//! stream; the turn stream gets status frames.

use serde_json::Value;

use super::catalog::catalog;
use super::claims::{self, CallEvent, ClaimPhase, DeviceCallSpec};
use super::codes::DeviceErrorCode;
use super::dispatch::CallContext;
use super::frames::{self, DeviceStatus, DeviceUiEvent};
use super::pending::{self, ParkedApproval, ParkedCall};
use super::routing::{self, Route};
use super::{device_stream, now_ms, presence, registry};

/// Longest single sleep while waiting for a device; a lease refresh or a
/// device-stream connect wakes the wait sooner.
const WAIT_POLL_MS: i64 = 2_000;

/// The pinned target of one call.
pub(super) struct Target {
    pub(super) device_id: String,
    pub(super) label: String,
    pub(super) cross_device: bool,
    pub(super) needs_permission: bool,
    pub(super) permission_denied: bool,
}

fn status(call: &CallContext<'_>, state: DeviceStatus) {
    call.emit(frames::status_frame(call.tool_call_id, state));
}

/// Send a frame to the target: the turn stream for the origin, the device
/// stream (only) for another phone.
pub(super) fn to_target(call: &CallContext<'_>, target: &Target, event: DeviceUiEvent) {
    if target.cross_device {
        let delivered = device_stream::send(&call.offer.principal.id(), &target.device_id, event);
        if !delivered {
            tracing::debug!("device stream closed before a routed frame was sent");
        }
    } else {
        call.emit(event);
    }
}

fn app_name(call: &CallContext<'_>) -> String {
    catalog()
        .app(&call.tool.app)
        .map_or_else(|| call.tool.app.clone(), |app| app.name.clone())
}

/// Park the call for Retry and return the `pending_on_device` envelope. Falls
/// back to `fallback` when parking is unavailable or the hour is over.
fn park(
    call: &CallContext<'_>,
    target: Option<&Target>,
    approval: ParkedApproval,
    fallback: DeviceErrorCode,
) -> Value {
    let now = now_ms();
    let parked = now < call.resumable_until_ms
        && pending::store().is_some_and(|store| {
            store
                .park(
                    &ParkedCall {
                        conversation_id: call.offer.conversation_id.clone(),
                        tool_call_id: call.tool_call_id.to_owned(),
                        owner_principal_id: call.offer.principal.id(),
                        target_device_id: target.map(|target| target.device_id.clone()),
                        tool: call.tool.id.clone(),
                        approval,
                        created_ms: call.created_ms,
                        resumable_until_ms: call.resumable_until_ms,
                    },
                    &call.input_sha256,
                    now,
                )
                .is_ok()
        });
    if !parked {
        status(call, DeviceStatus::Expired);
        return fallback.envelope();
    }
    let app_name = app_name(call);
    // The frame carries structured fields only; each client localizes it. The
    // English sentence below is for the model-facing envelope alone.
    call.emit(frames::parked_frame(
        call.tool_call_id,
        &frames::StatusAbout {
            app: &call.tool.app,
            app_name: &app_name,
            device_label: target.map(|target| target.label.as_str()),
        },
        call.resumable_until_ms,
    ));
    let place = target.map_or_else(
        || "the phone".to_owned(),
        |target| format!("\u{201c}{}\u{201d}", target.label),
    );
    let message = format!(
        "Waiting for {app_name} on {place}. Tap Retry on the phone within the hour to continue."
    );
    let mut envelope = DeviceErrorCode::PendingOnDevice.envelope();
    envelope["message"] = Value::String(message);
    envelope
}

/// Wait for a phone that may take the call; `Err` is the envelope to return.
pub(super) async fn route_or_wait(
    store: &registry::DeviceToolStore,
    call: &CallContext<'_>,
    pinned: Option<&str>,
) -> Result<Target, Value> {
    let deadline = (now_ms() + call.offer.wait_window_ms).min(call.resumable_until_ms);
    let mut announced = false;
    loop {
        // Arm the wake-up before looking, so a refresh in between is not lost.
        let notified = presence::changed().notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        let now = now_ms();
        let Some((origin, others)) = routing::candidates(store, call.offer, &call.tool.app, now)
        else {
            return Err(DeviceErrorCode::DeviceNotPaired.envelope());
        };
        let route = match pinned {
            Some(device_id) => {
                let Some(candidate) = std::iter::once(&origin)
                    .chain(&others)
                    .find(|candidate| candidate.device_id == device_id)
                else {
                    return Err(DeviceErrorCode::DeviceNotPaired.envelope());
                };
                routing::choose_pinned(
                    candidate,
                    &origin.device_id,
                    &call.tool.app,
                    call.created_ms,
                )
            }
            None => routing::choose(&origin, &others, &call.tool.app, call.created_ms),
        };
        match route {
            Route::Target {
                device_id,
                label,
                cross_device,
                needs_permission,
                permission_denied,
            } => {
                return Ok(Target {
                    device_id,
                    label,
                    cross_device,
                    needs_permission,
                    permission_denied,
                })
            }
            Route::UnsupportedPlatform => {
                return Err(DeviceErrorCode::UnsupportedPlatform.envelope())
            }
            Route::Wait => {}
        }
        if !announced {
            announced = true;
            // A content-free "Ryu needs your phone" push, once per call.
            super::waiting_push::notify_waiting(&call.offer.principal, call.tool_call_id);
            let app_name = app_name(call);
            call.emit(frames::status_frame_about(
                call.tool_call_id,
                DeviceStatus::WaitingDevice,
                &frames::StatusAbout {
                    app: &call.tool.app,
                    app_name: &app_name,
                    device_label: None,
                },
            ));
        }
        if now >= deadline {
            return Err(park(
                call,
                None,
                ParkedApproval::None,
                DeviceErrorCode::DeviceUnavailable,
            ));
        }
        let sleep = (deadline - now).clamp(1, WAIT_POLL_MS) as u64;
        let _ = tokio::time::timeout(std::time::Duration::from_millis(sleep), notified).await;
    }
}

/// Park the approved call with its frozen input for the target to claim, and
/// wait for the signed result.
///
/// `security_confirmed` marks a Home security action the user confirmed on
/// the target phone; such an approval is never parked for reuse, because a
/// retry must be confirmed with biometrics again.
pub(super) async fn await_device(
    call: &CallContext<'_>,
    target: &Target,
    approval: ParkedApproval,
    security_confirmed: bool,
    summary: &str,
) -> Value {
    let approval = if security_confirmed {
        ParkedApproval::None
    } else {
        approval
    };
    let principal = call.offer.principal.id();
    let registered_at = now_ms();
    let (mut receiver, _cleanup) = match claims::register(
        DeviceCallSpec {
            conversation_id: call.offer.conversation_id.clone(),
            tool_call_id: call.tool_call_id.to_owned(),
            owner_principal_id: principal.clone(),
            target_device_id: target.device_id.clone(),
            tool: call.tool.id.clone(),
            input: call.input.clone(),
            input_sha256: call.input_sha256.clone(),
            awaiting_permission: target.needs_permission,
            security_confirmed,
        },
        registered_at,
    ) {
        Ok(registered) => registered,
        Err(code) => return code.envelope(),
    };
    let mut deadline = (registered_at + call.offer.wait_window_ms).min(call.resumable_until_ms);
    to_target(
        call,
        target,
        frames::request_frame(&frames::RequestFrame {
            conversation_id: &call.offer.conversation_id,
            tool_call_id: call.tool_call_id,
            tool: &call.tool.id,
            app: &call.tool.app,
            summary,
            target_device_id: &target.device_id,
            device_label: &target.label,
            expires_at_ms: deadline,
            resumable_until_ms: call.resumable_until_ms,
        }),
    );
    if target.needs_permission {
        let app_name = app_name(call);
        to_target(
            call,
            target,
            frames::needs_permission_frame(&frames::NeedsPermission {
                conversation_id: &call.offer.conversation_id,
                tool_call_id: call.tool_call_id,
                tool: &call.tool.id,
                target_device_id: &target.device_id,
                device_label: &target.label,
                app: &call.tool.app,
                app_name: &app_name,
                denied: target.permission_denied,
                expires_at_ms: deadline,
                resumable_until_ms: call.resumable_until_ms,
            }),
        );
        status(call, DeviceStatus::AwaitingPermission);
    } else {
        status(call, DeviceStatus::WaitingDevice);
    }
    let mut claimed = false;
    loop {
        let remaining = (deadline - now_ms()).max(1) as u64;
        match tokio::time::timeout(std::time::Duration::from_millis(remaining), receiver.recv())
            .await
        {
            Ok(Some(CallEvent::Claimed { phase, deadline_ms })) => {
                deadline = deadline_ms;
                let state = match phase {
                    ClaimPhase::Execute => {
                        claimed = true;
                        DeviceStatus::Claimed
                    }
                    ClaimPhase::Permission => DeviceStatus::AwaitingPermission,
                };
                status(call, state);
            }
            Ok(Some(CallEvent::Result(raw))) => {
                let result = sanitize_result(&raw);
                let units = result["data"]["contacts"]
                    .as_array()
                    .map_or(1, |c| c.len().max(1) as i64);
                if let Some(store) = registry::store() {
                    store.record_use(
                        &principal,
                        &target.device_id,
                        &call.offer.conversation_id,
                        &call.tool.id,
                        units,
                        now_ms(),
                    );
                }
                status(call, DeviceStatus::Done);
                return result;
            }
            Ok(None) => {
                status(call, DeviceStatus::Cancelled);
                return DeviceErrorCode::CancelledByUser.envelope();
            }
            Err(_) if claimed => {
                // The claim is used up; the call is never retried.
                status(call, DeviceStatus::Expired);
                return DeviceErrorCode::DeviceTimeout.envelope();
            }
            Err(_) => {
                drop(_cleanup);
                let fallback = if target.needs_permission {
                    DeviceErrorCode::PermissionPending
                } else {
                    DeviceErrorCode::DeviceUnavailable
                };
                return park(call, Some(target), approval, fallback);
            }
        }
    }
}

/// Keep only the envelope's contract: `data` on success, a known code with
/// Core's own message on failure. Phone-authored messages never reach the
/// model.
pub(crate) fn sanitize_result(raw: &Value) -> Value {
    if raw.get("ok").and_then(Value::as_bool) == Some(true) {
        return serde_json::json!({ "ok": true, "data": raw.get("data").cloned().unwrap_or(Value::Null) });
    }
    raw.get("code")
        .and_then(Value::as_str)
        .and_then(DeviceErrorCode::parse)
        .unwrap_or(DeviceErrorCode::OsError)
        .envelope()
}
