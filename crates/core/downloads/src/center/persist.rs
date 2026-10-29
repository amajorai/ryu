//! Free helpers operating on [`Inner`](super::Inner), so the driver task can
//! call them without a `DownloadCenter` handle.

use super::*;

pub(super) async fn put_task_inner(inner: &Inner, task: DownloadTask) {
    #[cfg(test)]
    let committed = DownloadEvent::Update { task: task.clone() };
    {
        let mut tasks = inner.tasks.write().await;
        tasks.insert(task.id.clone(), task.clone());
        // Publish while this commit still holds the registry, so the stream's
        // order is the commit order: a later commit's event can never overtake
        // this one, and a GET can never see a state whose event is unsent.
        let _ = inner.events.send(DownloadEvent::Update { task });
    }
    #[cfg(test)]
    after_commit(inner, &committed).await;
}

/// Mutate one task, bump `updated_at`, broadcast the delta, and (optionally)
/// persist. Per-chunk progress passes `persist = false`. Returns the task as
/// this commit left it.
pub(super) async fn patch(
    inner: &Inner,
    id: &str,
    persist: bool,
    f: impl FnOnce(&mut DownloadTask),
) -> Option<DownloadTask> {
    let updated = {
        let mut tasks = inner.tasks.write().await;
        let task = tasks.get_mut(id)?;
        f(task);
        task.updated_at = now_ms();
        let updated = task.clone();
        // Published under the registry lock; see `put_task_inner`.
        let _ = inner.events.send(DownloadEvent::Update {
            task: updated.clone(),
        });
        updated
    };
    #[cfg(test)]
    after_commit(
        inner,
        &DownloadEvent::Update {
            task: updated.clone(),
        },
    )
    .await;
    if persist {
        persist_inner(inner).await;
    }
    Some(updated)
}

pub(super) async fn persist_inner(inner: &Inner) {
    // Held across snapshot AND write so the file always reflects the newest
    // snapshot taken (last writer == last snapshot).
    let _persisting = inner.persist_lock.lock().await;
    let to_save: Vec<DownloadTask> = {
        let tasks = inner.tasks.read().await;
        tasks
            .values()
            .filter(|t| t.state.is_persistable())
            .cloned()
            .collect()
    };
    let path = downloads_path();
    // Tiny file; a blocking write off the async path keeps it simple.
    let _ = tokio::task::spawn_blocking(move || {
        let json = serde_json::to_vec_pretty(&to_save)?;
        write_file_atomically(&path, &json)
    })
    .await;
}

/// Append a finished download to the durable history log (newest first),
/// de-duping by id so a re-download replaces its prior entry, then persist the
/// capped list. Called when a task reaches a terminal state (Completed /
/// Cancelled) — the only ones that leave the active registry.
pub(super) async fn record_history(inner: &Inner, task: &DownloadTask) {
    let _persisting = inner.persist_lock.lock().await;
    let to_save = {
        let mut hist = inner.history.lock().await;
        hist.retain(|t| t.id != task.id);
        hist.insert(0, task.clone());
        hist.truncate(HISTORY_CAP);
        hist.clone()
    };
    let path = history_path();
    let _ = tokio::task::spawn_blocking(move || {
        let json = serde_json::to_vec_pretty(&to_save)?;
        write_file_atomically(&path, &json)
    })
    .await;
}
