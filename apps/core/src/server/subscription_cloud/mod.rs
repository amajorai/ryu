//! Cloud tasks on the node owner's own Claude or ChatGPT plan.
//!
//! The design and its compliance record are in `docs/subscription-cloud-sessions.md`.
//! This module never holds a subscription token. It drives the provider's own,
//! unmodified CLI, signed in by the owner on their node:
//! - `claude --cloud` / `codex cloud exec` start a run in the provider's cloud;
//! - `claude -p` (Claude Code's headless runtime, which the Agent SDK drives) and
//!   `codex exec` (Codex's headless runtime, which the Codex SDK drives) run the task on
//!   the owner's node, in a worktree of their checkout ([`local_run`]).
//!
//! It falls back to the Ryu Box (with a notice) when the plan is out of quota or the CLI
//! is not ready.
//!
//! Billing: nothing here admits, meters, or announces a Ryu Box. A conversation that ran
//! on a plan is fenced off from both Box paths (`cloud_tasks::prepare_task`,
//! `session_box::desktop_target`).

pub(crate) mod accounts;
mod accounts_api;
pub(crate) mod api;
pub(crate) mod cli;
pub(crate) mod local_run;
mod redact;
pub(crate) mod routing;
pub(crate) mod store;
#[cfg(test)]
mod tests;

use crate::server::ResolvedAuthorization;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, LazyLock, RwLock};

/// Stable key of the rollout flag. Must equal `CLOUD_TASKS_SUBSCRIPTION_BACKENDS_FLAG` in
/// `packages/auth/src/lib/feature-flags.ts`.
pub(crate) const SUBSCRIPTION_BACKENDS_FLAG: &str = "cloud_tasks.subscription_backends";

/// The ChatGPT plan on a Ryu-hosted (managed) node. OpenAI lets open-source and
/// locally hosted apps use Sign in with ChatGPT plan usage today; a hosted or paid app
/// must be approved through OpenAI's interest form first. This stays off until OpenAI
/// approves Ryu. Must equal `CLOUD_TASKS_SUBSCRIPTION_BACKENDS_HOSTED_OPENAI_FLAG` in
/// `packages/auth/src/lib/feature-flags.ts`.
pub(crate) const HOSTED_OPENAI_FLAG: &str = "cloud_tasks.subscription_backends_hosted_openai";

/// A backend a cloud task can run on.
#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    utoipa::ToSchema,
)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum CloudTaskBackend {
    /// The Ryu Box, billed in Ryu credits.
    RyuBox,
    /// `claude --cloud`, run by the owner's signed-in Claude Code CLI. Uses their Claude plan.
    AnthropicSubscriptionCli,
    /// `codex cloud exec`, run by the owner's signed-in Codex CLI. Uses their ChatGPT plan.
    OpenaiSubscriptionCli,
    /// `claude -p` (the runtime the Claude Agent SDK drives), run on the owner's node by
    /// their signed-in Claude Code. Uses their Claude plan.
    AnthropicSubscriptionSdk,
    /// `codex exec` (the runtime the Codex SDK drives), run on the owner's node by their
    /// signed-in Codex CLI. Uses their ChatGPT plan.
    OpenaiSubscriptionSdk,
}

/// The provider behind a subscription backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Provider {
    Anthropic,
    Openai,
}

impl Provider {
    pub(crate) fn program(self) -> &'static str {
        match self {
            Self::Anthropic => "claude",
            Self::Openai => "codex",
        }
    }

    /// The agent's name in messages ("Claude Code is still working …").
    pub(crate) fn agent_name(self) -> &'static str {
        match self {
            Self::Anthropic => "Claude Code",
            Self::Openai => "Codex",
        }
    }
}

impl CloudTaskBackend {
    pub(crate) const ALL: [Self; 5] = [
        Self::RyuBox,
        Self::AnthropicSubscriptionCli,
        Self::AnthropicSubscriptionSdk,
        Self::OpenaiSubscriptionCli,
        Self::OpenaiSubscriptionSdk,
    ];

    /// Every backend that runs on the user's own plan.
    pub(crate) const PLANS: [Self; 4] = [
        Self::AnthropicSubscriptionCli,
        Self::AnthropicSubscriptionSdk,
        Self::OpenaiSubscriptionCli,
        Self::OpenaiSubscriptionSdk,
    ];

    pub(crate) fn wire(self) -> &'static str {
        match self {
            Self::RyuBox => "ryu-box",
            Self::AnthropicSubscriptionCli => "anthropic-subscription-cli",
            Self::OpenaiSubscriptionCli => "openai-subscription-cli",
            Self::AnthropicSubscriptionSdk => "anthropic-subscription-sdk",
            Self::OpenaiSubscriptionSdk => "openai-subscription-sdk",
        }
    }

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|backend| backend.wire() == raw)
    }

    pub(crate) fn provider(self) -> Option<Provider> {
        match self {
            Self::RyuBox => None,
            Self::AnthropicSubscriptionCli | Self::AnthropicSubscriptionSdk => {
                Some(Provider::Anthropic)
            }
            Self::OpenaiSubscriptionCli | Self::OpenaiSubscriptionSdk => Some(Provider::Openai),
        }
    }

    /// The task runs on this node, in a worktree of the owner's checkout ([`local_run`]),
    /// not in the provider's cloud.
    pub(crate) fn runs_on_node(self) -> bool {
        matches!(
            self,
            Self::AnthropicSubscriptionSdk | Self::OpenaiSubscriptionSdk
        )
    }

    /// A subscription backend runs only its own provider's agent.
    pub(crate) fn serves(self, executor: &str) -> bool {
        match self {
            Self::RyuBox => true,
            Self::AnthropicSubscriptionCli | Self::AnthropicSubscriptionSdk => {
                executor == "claude-code"
            }
            Self::OpenaiSubscriptionCli | Self::OpenaiSubscriptionSdk => executor == "codex",
        }
    }

    pub(crate) fn cli_name(self) -> &'static str {
        match self {
            Self::RyuBox => "Ryu Box",
            Self::AnthropicSubscriptionCli => "Claude Code",
            Self::AnthropicSubscriptionSdk => "Claude Code on this node",
            Self::OpenaiSubscriptionCli => "Codex CLI",
            Self::OpenaiSubscriptionSdk => "Codex on this node",
        }
    }

    pub(crate) fn plan_name(self) -> &'static str {
        match self {
            Self::RyuBox => "Ryu",
            Self::AnthropicSubscriptionCli | Self::AnthropicSubscriptionSdk => "Claude",
            Self::OpenaiSubscriptionCli | Self::OpenaiSubscriptionSdk => "ChatGPT",
        }
    }

    pub(crate) fn setting_name(self) -> &'static str {
        match self {
            Self::RyuBox => "Box",
            Self::AnthropicSubscriptionCli
            | Self::AnthropicSubscriptionSdk
            | Self::OpenaiSubscriptionSdk => "local checkout",
            Self::OpenaiSubscriptionCli => "Codex environment ID",
        }
    }
}

// ── The CLI runner (swappable in tests) ──────────────────────────────────────

static RUNNER: LazyLock<RwLock<Arc<dyn cli::CliRunner>>> =
    LazyLock::new(|| RwLock::new(Arc::new(cli::RealCli)));

pub(crate) fn runner() -> Arc<dyn cli::CliRunner> {
    RUNNER
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

#[cfg(test)]
pub(crate) fn set_runner_for_test(runner: Arc<dyn cli::CliRunner>) {
    *RUNNER
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = runner;
}

// ── Who may use a subscription backend ───────────────────────────────────────

/// Only the node owner on the node credential itself (the desktop on its own node). The
/// CLIs on this node are signed in to the owner's personal plan. A request relayed for
/// another verified caller (the web app, a team or org node) could be another person, and
/// running their task on the owner's plan would be account sharing, which both providers'
/// consumer terms forbid.
///
/// The desktop sends the signed-in user's JWT with every request to its own node, so a
/// node-token request may carry a verified caller. It still counts as the owner when that
/// caller is the node's owner: the registered owner on a personal managed node, or any
/// holder of the node token on a node that is not registered (the token alone proves
/// ownership there). A team or org node, a managed node that is not registered yet, and an
/// identity the node only asserted for a self call (no verified JWT) are never the owner.
pub(crate) fn caller_is_node_owner(auth: &ResolvedAuthorization) -> bool {
    if !auth.context.is_owner() {
        return false;
    }
    let Some(caller) = auth.caller.as_ref() else {
        return true;
    };
    if auth.verified_user_jwt.is_none() {
        return false;
    }
    match crate::sidecar::control_plane::registered_node() {
        Some(node) => node.owner_user_id.as_deref() == Some(caller.user_id.as_str()),
        None => !crate::sidecar::control_plane::is_managed_node(),
    }
}

/// The key the plan store (settings, linked accounts, runs) uses for this caller. Every
/// node-owner request shares one stable key, so signing in or out never orphans the
/// owner's runs or settings; any other caller keeps its own environment owner key.
pub(crate) fn plan_owner(auth: &ResolvedAuthorization, environment_owner: &str) -> String {
    if caller_is_node_owner(auth) {
        NODE_OWNER.to_owned()
    } else {
        environment_owner.to_owned()
    }
}

/// The plan-store key of the node owner.
const NODE_OWNER: &str = "node-owner";

/// The rollout gate, with the same shape as `cloud_tasks.box_backend`. A local owner
/// with no cloud identity is not gated, because there is no per-user flag to read; the
/// desktop hides the surface while the flag is off. A verified cloud caller needs the
/// key in the signed `ryu_flags` claim.
pub(crate) async fn rollout_allows(auth: &ResolvedAuthorization) -> bool {
    if auth.caller.is_none() {
        return true;
    }
    let Some(token) = auth.verified_user_jwt.as_deref() else {
        return false;
    };
    crate::identity_verify::verified_feature_flags(token)
        .await
        .is_some_and(|flags| flags.keys.contains(SUBSCRIPTION_BACKENDS_FLAG))
}

/// Whether this caller may use a ChatGPT plan on this node. A self-hosted node (the
/// owner's own computer or VM) is a locally hosted app in OpenAI's terms and is
/// allowed. A Ryu-managed node is a hosted app, which needs OpenAI's approval, so it
/// needs [`HOSTED_OPENAI_FLAG`] in the caller's signed flags.
pub(crate) async fn openai_plan_allowed(auth: &ResolvedAuthorization) -> bool {
    if !crate::sidecar::control_plane::is_managed_node() {
        return true;
    }
    let Some(token) = auth.verified_user_jwt.as_deref() else {
        return false;
    };
    crate::identity_verify::verified_feature_flags(token)
        .await
        .is_some_and(|flags| flags.keys.contains(HOSTED_OPENAI_FLAG))
}

/// Whether this caller may use a ChatGPT plan in Ryu's own cloud (a Ryu Box), which is
/// always hosted: only with [`HOSTED_OPENAI_FLAG`] in the caller's signed flags.
pub(crate) async fn hosted_openai_allowed(auth: &ResolvedAuthorization) -> bool {
    let Some(token) = auth.verified_user_jwt.as_deref() else {
        return false;
    };
    crate::identity_verify::verified_feature_flags(token)
        .await
        .is_some_and(|flags| flags.keys.contains(HOSTED_OPENAI_FLAG))
}

/// Whether this conversation ran on a user's plan, which fences it off from every Box path
/// so it can never pick up a Box charge or the first-Box cost notice.
pub(crate) fn fences_box(conversation_id: &str) -> bool {
    store::is_subscription_conversation(conversation_id)
}

/// Serializes routing and binding for one conversation, so two prompts sent at once can
/// never start two provider runs, or a provider run and a Ryu Box. The cloud-task prompt
/// route holds it from routing until the Box binding is recorded.
pub(crate) async fn lock_conversation(conversation_id: &str) -> tokio::sync::OwnedMutexGuard<()> {
    type Locks = std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>;
    static LOCKS: LazyLock<std::sync::Mutex<Locks>> = LazyLock::new(Default::default);
    let lock = {
        let mut locks = LOCKS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Forget locks nobody holds or waits for.
        locks.retain(|_, lock| Arc::strong_count(lock) > 1);
        locks.entry(conversation_id.to_owned()).or_default().clone()
    };
    lock.lock_owned().await
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub(crate) use api::{routes, start_or_fall_back, RouteOutcome, RouteRequest};
