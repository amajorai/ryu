//! Semantic element actions and their outcome types.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{AXTreeNode, ElementState, RendererA11y};
use crate::contract::{Delivery, GhostError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "action", content = "value", rename_all = "snake_case")]
pub enum ElementAction {
    Press,
    Focus,
    SetValue(String),
    Toggle,
    Check,
    Uncheck,
    Expand,
    Collapse,
    Select,
    ScrollIntoView,
    ShowMenu,
}

impl ElementAction {
    /// Parses an action name; `set_value` requires a value. Anything else is INVALID_ARGS.
    pub fn parse(name: &str, value: Option<&str>) -> Result<Self, GhostError> {
        let action = match name {
            "press" => Self::Press,
            "focus" => Self::Focus,
            "set_value" => match value {
                Some(v) => Self::SetValue(v.to_string()),
                None => {
                    return Err(GhostError::invalid_args(
                        "action 'set_value' requires a value",
                    ))
                }
            },
            "toggle" => Self::Toggle,
            "check" => Self::Check,
            "uncheck" => Self::Uncheck,
            "expand" => Self::Expand,
            "collapse" => Self::Collapse,
            "select" => Self::Select,
            "scroll_into_view" => Self::ScrollIntoView,
            "show_menu" => Self::ShowMenu,
            other => {
                return Err(GhostError::invalid_args(format!(
                    "unknown element action '{other}'; expected one of press, focus, set_value, \
                     toggle, check, uncheck, expand, collapse, select, scroll_into_view, show_menu"
                )))
            }
        };
        Ok(action)
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Press => "press",
            Self::Focus => "focus",
            Self::SetValue(_) => "set_value",
            Self::Toggle => "toggle",
            Self::Check => "check",
            Self::Uncheck => "uncheck",
            Self::Expand => "expand",
            Self::Collapse => "collapse",
            Self::Select => "select",
            Self::ScrollIntoView => "scroll_into_view",
            Self::ShowMenu => "show_menu",
        }
    }

    /// Actions whose effect can be read back from element state.
    pub fn is_stateful(&self) -> bool {
        matches!(
            self,
            Self::SetValue(_)
                | Self::Toggle
                | Self::Check
                | Self::Uncheck
                | Self::Expand
                | Self::Collapse
                | Self::Select
                | Self::Focus
        )
    }
}

#[derive(Debug, Clone)]
pub struct ActionOptions {
    pub deadline: Duration,
    pub verify: bool,
    /// macOS only.
    pub activate_renderer: bool,
    /// false => Focus on Windows/Linux returns POLICY_DENIED.
    pub allow_focus_steal: bool,
}

impl Default for ActionOptions {
    fn default() -> Self {
        Self {
            deadline: Duration::from_secs(5),
            verify: true,
            activate_renderer: false,
            allow_focus_steal: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepOutcome {
    NotDelivered,
    Satisfied,
    DeliveredWithoutEffect,
    DeliveredUnverified,
    DeliveredVerified,
}

impl StepOutcome {
    /// False only for `NotDelivered` and `DeliveredWithoutEffect`.
    pub const fn terminates(self) -> bool {
        !matches!(self, Self::NotDelivered | Self::DeliveredWithoutEffect)
    }

    pub const fn delivery(self) -> Delivery {
        match self {
            Self::NotDelivered | Self::Satisfied => Delivery::NotDelivered,
            Self::DeliveredWithoutEffect | Self::DeliveredUnverified => {
                Delivery::DeliveredUnverified
            }
            Self::DeliveredVerified => Delivery::DeliveredVerified,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionStep {
    pub method: &'static str,
    pub outcome: StepOutcome,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationScope {
    ElementState,
    ElementValue,
    AlreadyInState,
    Unavailable,
    Skipped,
}

/// Reasons: "secure_field", "insufficient_evidence", "not_requested", "not_stateful".
#[derive(Debug, Clone, Serialize)]
pub struct Verification {
    pub scope: VerificationScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchBy {
    Path,
    NativeId,
    Identifier,
    RoleName,
    Bounds,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedElement {
    /// Depth 0 (children empty), redacted.
    pub node: AXTreeNode,
    pub path: Vec<u32>,
    pub matched_by: MatchBy,
    pub pid: i32,
    /// Read-back primitives; value `None` if secure.
    pub state: ElementState,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActionOutcome {
    pub action: &'static str,
    /// e.g. "AXPress", "UIA.Invoke", "atspi.action:click", "AXValue".
    pub method: &'static str,
    pub delivery: Delivery,
    pub verification: Verification,
    pub attempts: Vec<ActionStep>,
    /// As resolved before acting.
    pub element: ResolvedElement,
    pub before: Option<ElementState>,
    pub after: Option<ElementState>,
    pub renderer: RendererA11y,
}
