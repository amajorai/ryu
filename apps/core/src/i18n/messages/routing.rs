//! English sources for the reactive-failover notes Core streams into a chat
//! turn when a plan hits its usage cap (`routing_policy::reactive`).
//!
//! Same shape as the templates in [`super`]. A note is one or two of these
//! sentences: Core renders them in the node's language for the visible text
//! part (native, Island, TUI), and sends the sources with their values in the
//! `data-ryu-failover` part so the desktop renders them in the reader's
//! language. `{agent}` is a product name, `{window}` the vendor's own window
//! label (lowercased, not translated) and `{plan}` the vendor's plan name.
//! `{headroom}` is a number of percent; `{time}` is the local `HH:MM` and
//! `{date}` the weekday, month and day of the reset.
#![allow(clippy::useless_format)]

use super::Template;

// ---- the plan that ran out ----------------------------------------------------

pub const FAILOVER_OUT_OF_WINDOW_PLAN_MESSAGE: Template = |arg| {
    format!(
        "{agent} has reached its {window} limit on your {plan} plan.",
        agent = arg("agent"),
        window = arg("window"),
        plan = arg("plan")
    )
};
pub const FAILOVER_OUT_OF_WINDOW_MESSAGE: Template = |arg| {
    format!(
        "{agent} has reached its {window} limit.",
        agent = arg("agent"),
        window = arg("window")
    )
};
pub const FAILOVER_OUT_OF_USAGE_PLAN_MESSAGE: Template = |arg| {
    format!(
        "{agent} has reached its usage limit on your {plan} plan.",
        agent = arg("agent"),
        plan = arg("plan")
    )
};
pub const FAILOVER_OUT_OF_USAGE_MESSAGE: Template =
    |arg| format!("{agent} has reached its usage limit.", agent = arg("agent"));

// ---- what happened next -------------------------------------------------------

pub const FAILOVER_RETRYING_MESSAGE: Template = |arg| {
    format!(
        "Retrying on {agent}, which has {headroom}% left.",
        agent = arg("agent"),
        headroom = arg("headroom")
    )
};
pub const FAILOVER_HELD_MESSAGE: Template = |arg| {
    format!(
        "{agent} still has {headroom}% left. Reactive failover is set to notify only, so nothing was rerouted.",
        agent = arg("agent"),
        headroom = arg("headroom")
    )
};
pub const FAILOVER_WAIT_MESSAGE: Template = |arg| {
    format!(
        "Every plan is out of room. The first to reopen is the {window} limit for {agent}, at {time} on {date}.",
        window = arg("window"),
        agent = arg("agent"),
        time = arg("time"),
        date = arg("date")
    )
};
pub const FAILOVER_NO_CANDIDATE_MESSAGE: Template =
    |_| format!("No other plan with room was found.");

/// Every template in this module, for the catalog round-trip test.
#[cfg(test)]
pub(super) const ALL: &[Template] = &[
    FAILOVER_OUT_OF_WINDOW_PLAN_MESSAGE,
    FAILOVER_OUT_OF_WINDOW_MESSAGE,
    FAILOVER_OUT_OF_USAGE_PLAN_MESSAGE,
    FAILOVER_OUT_OF_USAGE_MESSAGE,
    FAILOVER_RETRYING_MESSAGE,
    FAILOVER_HELD_MESSAGE,
    FAILOVER_WAIT_MESSAGE,
    FAILOVER_NO_CANDIDATE_MESSAGE,
];
