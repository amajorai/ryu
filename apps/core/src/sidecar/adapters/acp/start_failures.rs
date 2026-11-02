use super::*;
use crate::i18n::{messages as m, Message};

/// Answer the turn(s) waiting on an instance whose agent Ryu refused to start
/// with `failure`, preceded by `warning` (a `workspace_trust` config warning,
/// which the desktop's "Trust folder" action keys on) when there is one.
pub(super) async fn refuse_turns(
    turns_rx: &mut mpsc::UnboundedReceiver<AcpTurn>,
    warning: Option<String>,
    failure: AcpFailure,
) {
    let send = |turn: AcpTurn| {
        if let Some(message) = warning.as_ref() {
            let _ = turn.events.send(AcpEvent::ConfigWarning {
                field: WORKSPACE_TRUST_WARNING_FIELD.to_owned(),
                requested: "sandbox".to_owned(),
                message: message.clone(),
            });
        }
        let _ = turn.events.send(AcpEvent::Error(failure.clone()));
    };
    if let Ok(Some(turn)) =
        tokio::time::timeout(crate::acp_runtime::settings().idle_timeout, turns_rx.recv()).await
    {
        send(turn);
    }
    while let Ok(turn) = turns_rx.try_recv() {
        send(turn);
    }
}

/// The failure an agent that asked for a login (JSON-RPC -32000) ends its turn
/// with. Shared by `session/new` and `session/prompt`: both follow an
/// [`AcpEvent::AuthNeeded`] that carries the recovery.
pub(super) fn auth_required_failure() -> AcpFailure {
    AcpFailure::localized(
        "auth_required",
        m::ACP_LOGIN_EXPIRED_TITLE_MESSAGE,
        vec![Message::new(m::ACP_LOGIN_EXPIRED_MESSAGE)],
    )
}

/// The failure for an instance whose agent could not be started or whose
/// session could not be opened, for an error no earlier step classified.
pub(super) fn agent_start_failure(detail: impl std::fmt::Display) -> AcpFailure {
    AcpFailure::localized(
        "agent_start_failed",
        m::ACP_START_FAILED_TITLE_MESSAGE,
        vec![Message::new(m::ACP_START_FAILED_MESSAGE).text("detail", detail.to_string())],
    )
}

/// Classify an agent's JSON-RPC refusal to start: `auth_required` (-32000)
/// carries the agent's message for [`AcpEvent::AuthNeeded`].
fn acp_start_failure(error: &agent_client_protocol::Error) -> (AcpFailure, Option<String>) {
    if i32::from(error.code) == ACP_AUTH_REQUIRED_CODE {
        (auth_required_failure(), Some(error.to_string()))
    } else {
        (agent_start_failure(error), None)
    }
}

/// Classify the error that ended an instance before it opened its session.
/// Steps that know what failed attach their [`AcpFailure`] as `anyhow` context;
/// a quarantined local Gateway has its own type; an agent's JSON-RPC refusal
/// keeps its code; anything else is a start failure carrying the error chain.
pub(super) fn instance_start_failure(error: &anyhow::Error) -> (AcpFailure, Option<String>) {
    if let Some(failure) = error.downcast_ref::<AcpFailure>() {
        return (failure.clone(), None);
    }
    if error.downcast_ref::<GatewayStartupPending>().is_some() {
        let failure = AcpFailure::localized(
            "gateway_starting",
            m::ACP_GATEWAY_STARTING_TITLE_MESSAGE,
            vec![Message::new(m::ACP_GATEWAY_STARTING_MESSAGE)],
        );
        return (failure, None);
    }
    if let Some(error) = error.downcast_ref::<agent_client_protocol::Error>() {
        return acp_start_failure(error);
    }
    (agent_start_failure(format!("{error:#}")), None)
}

/// Tell one turn the instance cannot serve it. `auth_message` (a -32000 from
/// the agent) first sends [`AcpEvent::AuthNeeded`] so the client can offer the
/// agent's own login, exactly like the `session/prompt` failure branch.
pub(super) fn answer_unserved_turn(
    turn: &AcpTurn,
    failure: &AcpFailure,
    auth_message: Option<&str>,
) {
    if let Some(message) = auth_message {
        let _ = turn.events.send(AcpEvent::AuthNeeded {
            agent_id: turn.agent_id.clone(),
            message: message.to_owned(),
        });
    }
    let _ = turn.events.send(AcpEvent::Error(failure.clone()));
}

/// Answer every turn already queued on an instance that is going away. A turn
/// dropped unanswered closes its stream with no event, which the chat consumer
/// cannot tell apart from an empty reply that completed.
pub(super) fn fail_queued_turns(
    turns_rx: &mut mpsc::UnboundedReceiver<AcpTurn>,
    failure: &AcpFailure,
    auth_message: Option<&str>,
) {
    // Close first: a turn sent after this point fails its send and the pool
    // respawns an instance for it instead of queueing it here unanswered.
    turns_rx.close();
    while let Ok(turn) = turns_rx.try_recv() {
        answer_unserved_turn(&turn, failure, auth_message);
    }
}

/// The turn an instance has taken off its queue but not yet started serving.
/// [`run_acp_instance`] answers it when the instance fails before its session
/// opens, including when the ACP connection ends the setup future early (a
/// failed `session/new` does) and the turn is dropped with it.
pub(super) type UnservedFirstTurn = Option<(mpsc::UnboundedSender<AcpEvent>, String)>;

/// Answer the turn(s) waiting on an instance whose agent Ryu refused to start
/// in an untrusted folder: the `workspace_trust` warning, then the failure.
pub(super) async fn refuse_untrusted_turns(
    turns_rx: &mut mpsc::UnboundedReceiver<AcpTurn>,
    refusal: String,
) {
    let failure = untrusted_launch_failure(&refusal);
    refuse_turns(turns_rx, Some(refusal), failure).await;
}

/// Why Ryu did not start an agent's engine.
#[derive(Debug, Clone)]
pub(super) enum LaunchRefusal {
    /// The untrusted-workspace profile refused the launch.
    Untrusted(String),
    /// The agent's account access needs the OS sandbox, and it could not be
    /// applied.
    AccountAccess(String),
}

/// The failed-turn frame for an agent with limited account access that Ryu
/// could not sandbox. Ryu's own engine runs such an agent without the sandbox
/// only when its model providers are limited
/// ([`AccountConfinement::CoreStateAndProviders`]); for any other confined
/// agent (Both with no limit) the advice names the settings that would let it
/// start instead.
///
/// [`AccountConfinement::CoreStateAndProviders`]: crate::agent_access::AccountConfinement::CoreStateAndProviders
pub(crate) fn account_sandbox_failure(
    reason: &str,
    confinement: crate::agent_access::AccountConfinement,
) -> AcpFailure {
    let advice = if confinement == crate::agent_access::AccountConfinement::CoreStateAndProviders {
        m::ACP_SANDBOX_ADVICE_PROVIDERS_MESSAGE
    } else {
        m::ACP_SANDBOX_ADVICE_OTHER_MESSAGE
    };
    AcpFailure::localized(
        super::super::LAUNCH_REFUSED_SANDBOX,
        m::ACP_SANDBOX_REQUIRED_TITLE_MESSAGE,
        vec![
            Message::new(m::ACP_SANDBOX_REQUIRED_MESSAGE).text("reason", reason),
            Message::new(advice),
        ],
    )
}
