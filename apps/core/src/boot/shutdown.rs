/// Wait for a user interrupt or an OS termination request so Core can stop the
/// child processes it owns before exiting. `std::process::Child` does not kill a
/// child on drop, so relying on Rust destructors leaves llama.cpp (and other
/// sidecars) listening after a Core restart.
pub(super) async fn wait_for_shutdown_signal() {
    let reason = wait_for_shutdown_request().await;
    // ACP agents run in their own process groups (agent-client-protocol 3.x), so
    // the desktop's group kill of Core (about 1 s after SIGTERM) no longer reaches
    // them; on an external terminate/Ctrl-C, stop them now, before the graceful
    // drain. A restart-for-update keeps its 20 s drain so in-flight turns can
    // finish; `core_main` aborts the instance tasks after `serve` returns.
    if reason == ShutdownReason::Signal {
        crate::sidecar::adapters::acp_instance_tasks::abort_all();
    }
}

/// What ended [`wait_for_shutdown_request`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShutdownReason {
    /// Ctrl-C or SIGTERM from outside Core.
    Signal,
    /// Core's own restart-for-update request.
    Restart,
}

async fn wait_for_shutdown_request() -> ShutdownReason {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => ShutdownReason::Signal,
                    _ = terminate.recv() => ShutdownReason::Signal,
                    () = crate::update::restart_requested() => ShutdownReason::Restart,
                }
            }
            Err(error) => {
                tracing::warn!(error = %error, "could not install SIGTERM handler; waiting for Ctrl-C");
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => ShutdownReason::Signal,
                    () = crate::update::restart_requested() => ShutdownReason::Restart,
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => ShutdownReason::Signal,
            () = crate::update::restart_requested() => ShutdownReason::Restart,
        }
    }
}
