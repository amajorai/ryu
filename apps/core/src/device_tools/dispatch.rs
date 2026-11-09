//! One device call, end to end, shared by the OpenAI plane and the ACP bridge.
//!
//! validate → caps and org globs → (parked-call match) → route (or wait for a
//! device) → gate → (approval card) → park with the frozen input → the target
//! phone claims it → signed result → content-free telemetry, taint, redacted
//! display. The plane renders the [`DeviceUiEvent`]s and feeds the returned
//! envelope to the model through `neutralize_external_result`.

use serde_json::Value;
use tokio::sync::mpsc;

use super::catalog::{catalog, CatalogTool};
use super::claims::RESUMABLE_MS;
use super::codes::DeviceErrorCode;
use super::declaration::AppPermission;
use super::display;
use super::frames::{self, DeviceStatus, DeviceUiEvent};
use super::gate::{self, AdminCap, GateDecision, GateFacts};
use super::offer::DeviceOffer;
use super::pending::{self, ParkedApproval};
use super::prompts::{self, PromptAnswer, PromptCleanup, PROMPT_TIMEOUT_MS};
use super::validate::{self, ValidationContext};
use super::{caps_resolver, dispatch_wait, home, now_ms, redaction, registry, taint};

const HOUR_MS: i64 = 3_600_000;

/// Run one device call and return the result envelope the model receives.
pub(crate) async fn dispatch_call(
    offer: &DeviceOffer,
    tool_call_id: &str,
    name: &str,
    args: Value,
    events: &mpsc::UnboundedSender<DeviceUiEvent>,
) -> Value {
    let Some(tool) = catalog().tool(name) else {
        return DeviceErrorCode::InvalidInput.envelope();
    };
    let started = now_ms();
    let span = crate::sidecar::gen_ai_spans::execute_tool_span(
        &crate::sidecar::gen_ai_spans::ToolCall {
            name: &tool.id,
            call_id: Some(tool_call_id),
            tool_type: crate::sidecar::gen_ai_spans::ToolType::Function,
            description: None,
            mcp_server: None,
        },
        None,
    );
    let _ = events.send(DeviceUiEvent::ToolInput {
        tool_call_id: tool_call_id.to_owned(),
        tool_name: tool.alias.clone(),
        display_input: display::redact_input_for_display(tool, &args),
    });
    let result = run(offer, tool, tool_call_id, &args, events).await;
    redaction::record_call(span, &tool.id, &result, now_ms() - started);
    let ok = result.get("ok").and_then(Value::as_bool) == Some(true);
    if ok && gate::is_read(tool) {
        taint::mark_device_read(offer, &tool.id);
    }
    if ok && tool.id == "device.calendar.search" {
        if let Some(data) = result.get("data") {
            super::event_titles::remember(&offer.conversation_id, data);
        }
    }
    let _ = events.send(DeviceUiEvent::ToolOutput {
        tool_call_id: tool_call_id.to_owned(),
        display_result: display::redact_result_for_display(tool, &result),
        is_error: !ok,
    });
    result
}

pub(super) fn refusal(code: DeviceErrorCode, detail: Option<&str>) -> Value {
    let mut envelope = code.envelope();
    if let Some(detail) = detail {
        envelope["message"] = Value::String(format!("{} ({detail})", code.message()));
    }
    envelope
}

/// Why a tool that is not on this turn's offer was called anyway.
fn unoffered_code(offer: &DeviceOffer, tool: &CatalogTool) -> DeviceErrorCode {
    if offer.caps.cap_for(&tool.app) == AdminCap::Never {
        return DeviceErrorCode::AdminBlocked;
    }
    match offer.origin.app(&tool.app) {
        Some(decl) if decl.user_disabled => DeviceErrorCode::UserDisabled,
        Some(decl) if decl.permission == AppPermission::Restricted => DeviceErrorCode::AdminBlocked,
        _ => DeviceErrorCode::UnsupportedPlatform,
    }
}

/// Hourly quotas per device (design §3.4): past one, the call asks again and
/// Always allow cannot satisfy it.
fn over_hourly_quota(
    store: &registry::DeviceToolStore,
    principal: &str,
    device_id: &str,
    tool: &str,
    now: i64,
) -> bool {
    let (calls, units) = store.usage_since(principal, device_id, tool, now - HOUR_MS);
    match tool {
        "device.contacts.search" => calls >= 5 || units >= 20,
        "device.calendar.search" => calls >= 10,
        "device.location.current" => calls >= 6,
        _ => false,
    }
}

/// A validated call, as routing, the gate and the claim wait see it.
pub(super) struct CallContext<'a> {
    pub(super) offer: &'a DeviceOffer,
    pub(super) tool: &'a CatalogTool,
    pub(super) tool_call_id: &'a str,
    pub(super) input: Value,
    pub(super) input_sha256: String,
    /// When the call was first created (a retried parked call keeps its own).
    pub(super) created_ms: i64,
    /// Never extended, not even by a retry.
    pub(super) resumable_until_ms: i64,
    pub(super) events: &'a mpsc::UnboundedSender<DeviceUiEvent>,
}

impl CallContext<'_> {
    pub(super) fn emit(&self, event: DeviceUiEvent) {
        let _ = self.events.send(event);
    }
}

async fn run(
    offer: &DeviceOffer,
    tool: &CatalogTool,
    tool_call_id: &str,
    args: &Value,
    events: &mpsc::UnboundedSender<DeviceUiEvent>,
) -> Value {
    if !offer.offers(&tool.id) {
        return unoffered_code(offer, tool).envelope();
    }
    let Some(store) = registry::store() else {
        return DeviceErrorCode::DeviceUnavailable.envelope();
    };
    let principal = offer.principal.id();
    if store
        .active_key(&principal, &offer.origin.device_id)
        .is_none()
    {
        return DeviceErrorCode::DeviceNotPaired.envelope();
    }
    if !offer.take_call_slot() {
        return DeviceErrorCode::QuotaExceeded.envelope();
    }
    let now = now_ms();
    // Times without an offset are the user's: the phone they are typing on.
    let ctx = ValidationContext {
        now_ms: now,
        utc_offset_min: offer.origin.utc_offset_min,
    };
    let input = match validate::validate_and_canonicalize(tool, args, ctx) {
        Ok(input) => input,
        Err(error) => return refusal(error.code, Some(&error.detail)),
    };
    let input_sha256 = validate::input_sha256(&input);
    // Per-caller admin caps and org globs, resolved again for every call.
    let cap = caps_resolver::caps_for(&offer.principal)
        .await
        .cap_for(&tool.app);
    let org_denial = caps_resolver::org_denial_for(&offer.principal, &tool.id).await;
    if cap == AdminCap::Never || org_denial.is_some() {
        return DeviceErrorCode::AdminBlocked.envelope();
    }
    let parked = pending::store().and_then(|parked| {
        parked.take_match(
            &offer.conversation_id,
            &principal,
            &tool.id,
            &input_sha256,
            now,
        )
    });
    let call = CallContext {
        offer,
        tool,
        tool_call_id,
        input,
        input_sha256,
        created_ms: parked.as_ref().map_or(now, |row| row.created_ms),
        resumable_until_ms: parked
            .as_ref()
            .map_or(now + RESUMABLE_MS, |row| row.resumable_until_ms),
        events,
    };
    let pinned = parked.as_ref().and_then(|row| row.target_device_id.clone());
    let recorded = parked.map_or(ParkedApproval::None, |row| row.approval);
    let target = match dispatch_wait::route_or_wait(&store, &call, pinned.as_deref()).await {
        Ok(target) => target,
        Err(envelope) => return envelope,
    };
    // `device.home.set`: the security class and the accessory name come from
    // the signed cache of the TARGET phone, never from the model.
    let home = tool.security_class_possible.then(|| {
        let accessory = call
            .input
            .get("accessory_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        home::classify(&store, &principal, &target.device_id, accessory, now)
    });
    let decision = gate::decide(&GateFacts {
        tool,
        cap,
        org_denial,
        approval_mode: offer.approval_mode,
        has_device_grant: store.has_grant(&principal, &target.device_id, &tool.id),
        cross_device: target.cross_device,
        precise_location: call.input.get("accuracy").and_then(Value::as_str) == Some("precise"),
        tainted_input: offer.tainted_input(),
        over_quota: over_hourly_quota(&store, &principal, &target.device_id, &tool.id, now),
        persistence_allowed: true,
        home_security_class: home.as_ref().is_none_or(|home| home.security_class),
    });
    // An update or delete names its event by the title the phone reported
    // earlier in this conversation, never by model text.
    let known_title = match home {
        Some(home) => home.name,
        None => matches!(
            tool.id.as_str(),
            "device.calendar.update" | "device.calendar.delete"
        )
        .then(|| call.input.get("id").and_then(Value::as_str))
        .flatten()
        .and_then(|id| super::event_titles::title_of(&offer.conversation_id, id)),
    };
    let summary =
        display::display_summary_known(tool, &call.input, &target.label, known_title.as_deref());
    let approval = match decision {
        GateDecision::Refuse(code) => return code.envelope(),
        // A Home security action: only the target phone may approve it, with
        // biometrics, every time (a parked approval is never reused).
        GateDecision::Ask {
            on_device: true, ..
        } => {
            if store.confirm_key(&principal, &target.device_id).is_none() {
                return refusal(
                    DeviceErrorCode::ApprovalRequired,
                    Some("this phone cannot confirm security actions; pair it again with confirmations on"),
                );
            }
            return match ask(&call, &target, &summary, AskKind::OnDevice).await {
                Ok(_) => {
                    dispatch_wait::await_device(
                        &call,
                        &target,
                        ParkedApproval::AllowOnce,
                        true,
                        &summary,
                    )
                    .await
                }
                Err(envelope) => envelope,
            };
        }
        // A retried parked call carries the approval the user already gave
        // for this exact input on this exact target, unless this turn has
        // since taken in untrusted content (then it asks again).
        GateDecision::Ask { .. } if recorded != ParkedApproval::None && !offer.tainted_input() => {
            recorded
        }
        GateDecision::Ask { allow_always, .. } => {
            let kind = if allow_always {
                AskKind::AllowAlways
            } else {
                AskKind::AllowOnce
            };
            match ask(&call, &target, &summary, kind).await {
                Ok(approval) => approval,
                Err(envelope) => return envelope,
            }
        }
        GateDecision::Run => ParkedApproval::None,
    };
    dispatch_wait::await_device(&call, &target, approval, false, &summary).await
}

/// Which approval card to show.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AskKind {
    AllowOnce,
    AllowAlways,
    /// Answerable only by the target phone after biometrics.
    OnDevice,
}

/// Show the approval card and wait for the owner's answer.
async fn ask(
    call: &CallContext<'_>,
    target: &dispatch_wait::Target,
    summary: &str,
    kind: AskKind,
) -> Result<ParkedApproval, Value> {
    let principal = call.offer.principal.id();
    let allow_always = kind == AskKind::AllowAlways;
    let on_device = kind == AskKind::OnDevice;
    let (request_id, answer) = if on_device {
        prompts::register_on_device(
            &call.offer.conversation_id,
            &principal,
            prompts::OnDeviceBinding {
                target_device_id: target.device_id.clone(),
                input_sha256: call.input_sha256.clone(),
            },
        )
    } else {
        prompts::register(&call.offer.conversation_id, &principal, allow_always, false)
    };
    let _cleanup = PromptCleanup(request_id.clone());
    call.emit(frames::status_frame(
        call.tool_call_id,
        DeviceStatus::AwaitingApproval,
    ));
    let card = frames::permission_card(&frames::PermissionCard {
        request_id: &request_id,
        tool_call_id: call.tool_call_id,
        title: summary,
        allow_always,
        device_id: &target.device_id,
        device_label: &target.label,
        app: &call.tool.app,
        tool: &call.tool.id,
        on_device,
        input_sha256: on_device.then_some(call.input_sha256.as_str()),
    });
    // Every surface shows the card ("Confirm on <phone>" off the target); an
    // on-device card must also reach a target that is not the origin.
    if on_device && target.cross_device {
        dispatch_wait::to_target(call, target, card.clone());
    }
    call.emit(card);
    let waited =
        tokio::time::timeout(std::time::Duration::from_millis(PROMPT_TIMEOUT_MS), answer).await;
    match waited {
        Ok(Ok(PromptAnswer::AllowOnce)) => Ok(ParkedApproval::AllowOnce),
        Ok(Ok(PromptAnswer::AllowAlways)) if allow_always => {
            let stored = registry::store().is_some_and(|store| {
                store
                    .grant(&principal, &target.device_id, &call.tool.id, now_ms())
                    .is_ok()
            });
            if !stored {
                tracing::warn!(tool = %call.tool.id, "device grant could not be stored");
            }
            Ok(ParkedApproval::AllowAlways)
        }
        Ok(Ok(_)) | Ok(Err(_)) => {
            call.emit(frames::status_frame(
                call.tool_call_id,
                DeviceStatus::Cancelled,
            ));
            Err(DeviceErrorCode::CancelledByUser.envelope())
        }
        Err(_) => {
            call.emit(frames::status_frame(
                call.tool_call_id,
                DeviceStatus::Expired,
            ));
            Err(DeviceErrorCode::ApprovalTimeout.envelope())
        }
    }
}
