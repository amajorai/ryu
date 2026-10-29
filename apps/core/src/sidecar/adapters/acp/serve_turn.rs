use super::*;

/// The next turn to serve: the peeked first turn, else the queue's next one.
/// `None` when the pool closed the queue or the idle TTL passed (the loop ends).
pub(super) async fn next_turn(
    pending_first: &mut Option<AcpTurn>,
    activity: &Option<Arc<AcpInstanceActivity>>,
    turns_rx: &mut mpsc::UnboundedReceiver<AcpTurn>,
) -> Option<AcpTurn> {
    Some(match pending_first.take() {
        Some(t) => t,
        None => match {
            if let Some(activity) = activity.as_deref() {
                activity.mark_idle();
            }
            tokio::time::timeout(crate::acp_runtime::settings().idle_timeout, turns_rx.recv()).await
        } {
            Ok(Some(t)) => {
                if let Some(activity) = activity.as_deref() {
                    activity.mark_busy();
                }
                t
            }
            Ok(None) => {
                tracing::info!(
                                    "ACP instance closed by the pool (evicted, superseded or conversation closed); subprocess will be reaped"
                                );
                return None;
            }
            Err(_) => {
                tracing::info!(
                    idle_timeout_minutes = crate::acp_runtime::settings().idle_timeout_minutes,
                    "ACP session idle timeout reached; subprocess will be reaped"
                );
                return None;
            }
        },
    })
}

/// Admits a turn, points the permission sink at it and refreshes managed-Pi logins.
/// `None` when the turn was answered with an error and is skipped.
pub(super) async fn admit_turn(
    admission: Result<crate::execution_control::Admission, &'static str>,
    tx: &mpsc::UnboundedSender<AcpEvent>,
    sink: &Mutex<Option<mpsc::UnboundedSender<AcpEvent>>>,
    is_managed_pi: bool,
    captured_pi_account: &Option<crate::pi_config::session_accounts::SessionAccount>,
) -> Option<crate::execution_control::Admission> {
    let admission = match admission {
        Ok(admission) => admission,
        Err(message) => {
            let _ = tx.send(AcpEvent::Error(AcpFailure {
                code: "execution_paused".to_owned(),
                title: "Execution paused".to_owned(),
                message: message.to_owned(),
            }));
            return None;
        }
    };
    if admission.is_cancelled() {
        let _ = tx.send(AcpEvent::Error(AcpFailure {
            code: "execution_paused".to_owned(),
            title: "Execution paused".to_owned(),
            message: crate::execution_control::PAUSED_MESSAGE.to_owned(),
        }));
        return None;
    }
    // Point the bridge's permission sink at THIS turn's stream so a
    // Ryu-tool permission prompt reaches the live turn's consumer.
    if let Ok(mut g) = sink.lock() {
        *g = Some(tx.clone());
    }

    // Proactively refresh the managed Pi's subscription OAuth
    // logins (Claude Pro/Max, ChatGPT) before the turn, so a
    // long-running / long-idle chat doesn't die when an access token
    // expired since the last turn. Scoped to the managed Pi's own
    // isolated auth.json (never the user's CLI creds) and strictly
    // best-effort — failures are logged inside and never block the
    // turn. Cheap when nothing is near expiry (a plain file read).
    if is_managed_pi {
        if let Some(captured) = captured_pi_account.as_ref() {
            if let Err(error) = captured.prepare_turn().await {
                let _ = tx.send(AcpEvent::Error(AcpFailure {
                    code: "pi_account_required".into(),
                    title: "Pi account unavailable".into(),
                    message: error.to_string(),
                }));
                return None;
            }
        } else {
            if let Err(error) = crate::pi_config::refresh_pi_oauth_logins().await {
                let _ = tx.send(AcpEvent::Error(AcpFailure {
                    code: "pi_account_required".into(),
                    title: "Pi account unavailable".into(),
                    message: error.to_string(),
                }));
                return None;
            }
        }
    }
    Some(admission)
}
