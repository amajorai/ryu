//! Live ACP instance tasks, so Core's shutdown can stop their agents.
//!
//! `agent-client-protocol` 3.x spawns each agent as the leader of its own
//! process group and SIGKILLs that group when the connection is dropped. 0.11
//! left the agent in Core's group, so the desktop stopping Core (SIGTERM, then
//! SIGKILL, to Core's group) or a terminal Ctrl-C reached the agents directly.
//! They no longer do: an agent outlives a Core that is killed before its
//! instance tasks are dropped. Aborting the tracked tasks when the shutdown
//! signal arrives drops each connection, which kills each agent's group, so a
//! stopped Core still leaves no agent behind.

use std::sync::{Mutex, OnceLock};

use tokio::task::AbortHandle;

fn tasks() -> &'static Mutex<Vec<AbortHandle>> {
    static TASKS: OnceLock<Mutex<Vec<AbortHandle>>> = OnceLock::new();
    TASKS.get_or_init(|| Mutex::new(Vec::new()))
}

/// Track one instance task until it finishes or Core shuts down.
pub(crate) fn track(task: AbortHandle) {
    let mut tasks = tasks()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    tasks.retain(|task| !task.is_finished());
    tasks.push(task);
}

/// Abort every live instance task. Dropping a task's ACP connection kills the
/// agent's process group.
pub(crate) fn abort_all() {
    let tasks = std::mem::take(
        &mut *tasks()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    );
    for task in tasks {
        task.abort();
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn abort_all_stops_tracked_tasks() {
        let task = tokio::spawn(std::future::pending::<()>());
        super::track(task.abort_handle());
        super::abort_all();
        assert!(task.await.unwrap_err().is_cancelled());
    }
}
