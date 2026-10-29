//! Which backend a cloud task runs on. Pure: availability comes in, a decision comes out.

use super::CloudTaskBackend;
use serde::Serialize;

/// The default order when neither the session nor the agent names one: the user's own
/// plans first, then the Ryu Box.
/// A Claude Code or Codex task tries the provider's cloud first, then a run on this node.
pub(crate) const DEFAULT_ORDER: [CloudTaskBackend; 5] = [
    CloudTaskBackend::AnthropicSubscriptionCli,
    CloudTaskBackend::AnthropicSubscriptionSdk,
    CloudTaskBackend::OpenaiSubscriptionCli,
    CloudTaskBackend::OpenaiSubscriptionSdk,
    CloudTaskBackend::RyuBox,
];

/// Why a preferred backend was skipped, shown to the user.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Notice {
    /// `subscription_quota_fallback`, `subscription_signed_out`,
    /// `subscription_unavailable`, `subscription_not_configured` or
    /// `subscription_cooling_down`.
    pub(crate) code: String,
    pub(crate) backend: CloudTaskBackend,
    pub(crate) message: String,
    /// The linked account it is about, when it is about one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) account_id: Option<String>,
}

impl Notice {
    pub(crate) fn new(code: &str, backend: CloudTaskBackend, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            backend,
            message: message.into(),
            account_id: None,
        }
    }

    pub(crate) fn for_account(mut self, account_id: &str) -> Self {
        self.account_id = Some(account_id.to_owned());
        self
    }
}

/// What routing knows about one subscription backend right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Availability {
    Ready,
    NotInstalled,
    SignedOut,
    /// Signed in, but with an API key or a third-party provider.
    WrongSignIn,
    /// This environment has no checkout (Claude) or Codex environment id (Codex) set.
    NotConfigured,
    CoolingDown,
    /// The node owner did not enable subscription backends, the caller is not the node
    /// owner, or the rollout flag is off.
    Disabled,
}

/// Where a session asked to run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SessionPin {
    pub(crate) backend: Option<CloudTaskBackend>,
    /// `false` makes the pin strict: no other backend is tried.
    pub(crate) fallback: bool,
}

/// The outcome of [`resolve`]: the backends to try in order, and why each skipped
/// preferred backend was skipped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Plan {
    pub(crate) candidates: Vec<CloudTaskBackend>,
    pub(crate) notices: Vec<Notice>,
}

/// Resolve the backends a task for `executor` may try, in order.
///
/// Precedence: the session pin, then `agent_order`, then `default_order`. Backends that
/// cannot serve the executor are dropped silently; unavailable ones are dropped with a
/// notice. The Ryu Box is appended last unless the session pinned a backend strictly.
pub(crate) fn resolve(
    executor: &str,
    pin: SessionPin,
    agent_order: Option<&[CloudTaskBackend]>,
    default_order: &[CloudTaskBackend],
    availability: impl Fn(CloudTaskBackend) -> Availability,
) -> Plan {
    let strict = pin.backend.is_some() && !pin.fallback;
    let mut order: Vec<CloudTaskBackend> = match pin.backend {
        Some(backend) => vec![backend],
        None => agent_order.unwrap_or(default_order).to_vec(),
    };
    if pin.backend.is_some() && !strict {
        order.extend(agent_order.unwrap_or(default_order).iter().copied());
    }
    if !strict && !order.contains(&CloudTaskBackend::RyuBox) {
        order.push(CloudTaskBackend::RyuBox);
    }
    let mut plan = Plan {
        candidates: Vec::new(),
        notices: Vec::new(),
    };
    for backend in order {
        if plan.candidates.contains(&backend) || !backend.serves(executor) {
            continue;
        }
        if backend == CloudTaskBackend::RyuBox {
            plan.candidates.push(backend);
            continue;
        }
        let skipped = match availability(backend) {
            Availability::Ready => {
                plan.candidates.push(backend);
                continue;
            }
            // Turned off is not news: no notice.
            Availability::Disabled => continue,
            Availability::NotInstalled => Notice::new(
                "subscription_unavailable",
                backend,
                format!("{} is not installed on this node.", backend.cli_name()),
            ),
            Availability::SignedOut => Notice::new(
                "subscription_signed_out",
                backend,
                format!(
                    "{} is not signed in on this node. Sign in from Settings to use your {} plan.",
                    backend.cli_name(),
                    backend.plan_name()
                ),
            ),
            Availability::WrongSignIn => Notice::new(
                "subscription_signed_out",
                backend,
                format!(
                    "{} is signed in with an API key, not your {} plan.",
                    backend.cli_name(),
                    backend.plan_name()
                ),
            ),
            Availability::NotConfigured => Notice::new(
                "subscription_not_configured",
                backend,
                format!(
                    "This environment has no {} set for your {} plan.",
                    backend.setting_name(),
                    backend.plan_name()
                ),
            ),
            Availability::CoolingDown => Notice::new(
                "subscription_cooling_down",
                backend,
                format!(
                    "Your {} plan hit its usage limit recently, so this task did not use it.",
                    backend.plan_name()
                ),
            ),
        };
        // A provider's backends share one plan: say a plan-wide reason once.
        // A missing setting is per backend (each names its own `setting_name`),
        // so it is never folded into another backend's notice.
        let repeated = skipped.code != "subscription_not_configured"
            && plan.notices.iter().any(|notice| {
                notice.code == skipped.code
                    && notice.backend.provider() == skipped.backend.provider()
            });
        if !repeated {
            plan.notices.push(skipped);
        }
    }
    plan
}
