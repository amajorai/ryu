//! Shared value-types exchanged between Ryu Gateway stages.
//!
//! This crate is the neutral home for vocabulary that crosses stage boundaries
//! so that peer stage crates (`ryu-gw-budget`, and later `ryu-gw-firewall`, …)
//! can share a type without depending on each other. It has no logic — only the
//! serde-shaped enums/structs that the pipeline threads between stages.

use serde::{Deserialize, Serialize};

/// Alert tier: the notification fan-out a policy match triggers, ORTHOGONAL to
/// the enforcement action (`BudgetAction`/`FirewallPolicy`). Enforcement decides
/// what happens to the request; the tier decides who gets told. Core takes the
/// `max` tier across all matched rules, so the derive order (Silent < Warn <
/// Fanout < Email) is load-bearing — keep the variants in ascending severity.
///
/// Named `Fanout` (never `Notify`) so it never collides with
/// `BudgetAction::Notify`, which is an enforcement action, not a tier.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum AlertTier {
    /// No alert. The default, so every pre-existing config parses to Silent.
    #[default]
    Silent,
    /// Log/SSE only: surface a live warning to the desktop, no fan-out sinks.
    Warn,
    /// Fan out to Webhook/Telegram/ExpoPush (Core `notify_all`).
    Fanout,
    /// Fan out AND send email (Core SMTP sink / managed control-plane email).
    Email,
}
