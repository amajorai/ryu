//! Device tools: Core's side of "let Ryu use apps on this phone".
//!
//! The phone runs the tool; Core owns everything else. The closed catalog is
//! compiled in from `packages/protocol/fixtures/device-tools-v1.json`, so a
//! phone only declares which app groups it has (`declaration`). A device is a
//! P-256 key registered against `(principal, device_id)` (`identity`,
//! `registry`); every device-lane action is signed with it. A call is gated
//! (`gate`) and, when asked, approved through the existing `data-ryu-permission`
//! channel with a server-validated option set (`prompts`). The phone then claims
//! the call once and receives the frozen input (`claims`) before it runs, and
//! posts a signed result bound to that claim.
//!
//! Everything ships dark behind `mobile.device_tools` (`flag`). Device tools
//! exist only on the user's own interactive chat stream (`offer`). Device data
//! never reaches traces, OTLP or push bodies (`redaction`), and a successful
//! device read marks the turn so later egress is held (`taint`).
//!
//! P3 routes a call to another paired phone when the origin cannot take it
//! (`routing`, `device_stream`; always asks). P4 parks a call whose wait
//! window ended for a Retry within the hour (`pending`). P5 enforces the
//! caller's admin caps and org globs from the control plane (`caps`,
//! `caps_resolver`); caps only restrict. P6 adds Home: the signed accessory
//! cache decides the security class (`home`), and a security action is
//! approved only on the target phone with biometrics (`confirm`).
//!
//! Internal design: `docs/device-tools.md`.

pub(crate) mod agent_events;
pub(crate) mod bridge_calls;
pub(crate) mod caps;
pub(crate) mod caps_resolver;
pub(crate) mod catalog;
pub(crate) mod claims;
pub(crate) mod codes;
pub(crate) mod confirm;
pub(crate) mod declaration;
pub(crate) mod device_stream;
pub(crate) mod dispatch;
mod dispatch_wait;
pub(crate) mod display;
pub(crate) mod event_titles;
pub(crate) mod flag;
pub(crate) mod frames;
pub(crate) mod gate;
pub(crate) mod home;
pub(crate) mod identity;
pub(crate) mod offer;
pub(crate) mod pending;
pub(crate) mod presence;
pub(crate) mod prompts;
pub(crate) mod redaction;
pub(crate) mod registry;
pub(crate) mod routing;
pub(crate) mod taint;
pub(crate) mod turn_context;
pub(crate) mod validate;
pub(crate) mod waiting_push;

#[cfg(test)]
mod agent_events_tests;
#[cfg(test)]
mod bridge_calls_tests;
#[cfg(test)]
mod caps_tests;
#[cfg(test)]
mod catalog_tests;
#[cfg(test)]
mod claims_tests;
#[cfg(test)]
mod dispatch_tests;
#[cfg(test)]
mod gate_tests;
#[cfg(test)]
mod home_tests;
#[cfg(test)]
pub(crate) mod identity_tests;
#[cfg(test)]
mod pending_tests;
#[cfg(test)]
mod prompts_tests;
#[cfg(test)]
mod registry_tests;
#[cfg(test)]
mod routing_tests;
#[cfg(test)]
mod turn_context_tests;

pub(crate) use codes::DeviceErrorCode;
pub(crate) use offer::DeviceOffer;

/// Milliseconds since the Unix epoch.
pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
