//! The per-download driver: retry loop, fast path and checksum policy.

use super::*;

pub(super) enum AttemptOutcome {
    Done(PathBuf),
    Paused,
    Cancelled,
    Failed { error: String, retryable: bool },
}

pub(super) enum StreamResult {
    Done,
    Paused,
    Cancelled,
}

pub(super) enum StreamErr {
    /// Transient (network) — keep the `.part` and retry with Range.
    Network(String),
    /// Fatal (disk full, bad path) — not resumable.
    Io(String),
}

pub(super) async fn drive(
    inner: Arc<Inner>,
    id: String,
    seq: u64,
    shared_spec: Arc<std::sync::Mutex<DownloadSpec>>,
    control_tx: watch::Sender<Control>,
    mut control_rx: watch::Receiver<Control>,
    done_tx: watch::Sender<Term>,
) {
    let current_spec = || {
        shared_spec
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    };
    loop {
        // PARK: wait until Run; exit on Cancel. Copy the value out so the
        // (non-Send) watch guard never lives across the awaits below.
        loop {
            let ctl = *control_rx.borrow_and_update();
            match ctl {
                Control::Run => break,
                Control::Cancel => {
                    cleanup_cancelled(&inner, &id, seq, &current_spec(), &done_tx).await;
                    return;
                }
                Control::Pause => {}
            }
            if control_rx.changed().await.is_err() {
                return; // center dropped — process shutting down
            }
        }

        // A failed pass publishes an error to blocking callers but keeps the
        // driver parked so the UI can retry the same task. Clear that result
        // only when a retry actually wakes the driver; otherwise a new
        // `download_blocking` call would immediately replay the old failure
        // instead of awaiting the retry's terminal state.
        // `send_replace`, not `send`: with no receiver subscribed (the failing
        // caller already returned) `send` drops the value, and the old failure
        // would survive into this retry for the next caller to read.
        done_tx.send_replace(None);
        // Each pass runs with the newest spec a deduping caller supplied — read
        // AFTER waking, since that caller updates it right before sending Run.
        let spec = current_spec();

        // FAST PATH: already installed with a matching checksum → Completed.
        if let Some(path) = fast_path(&spec).await {
            finish_completed(&inner, &id, seq, &done_tx, path).await;
            return;
        }

        // Take a concurrency slot BEFORE flipping to Active. The order matters: a
        // task that is waiting on the gate is `Queued`, and only one that is
        // actually streaming is `Active`. Marking it Active first (as this did)
        // meant every queued download rendered as "Downloading" the instant it was
        // registered — so the queue existed in Core but was invisible everywhere,
        // and a sequential-looking onboarding was indistinguishable from a
        // parallel one that happened to be waiting.
        //
        // Wait for the slot while still honouring the control channel: a queued
        // task behind a multi-GB model must cancel or pause NOW, not once a slot
        // frees and an HTTP request has already gone out.
        let _permit = {
            let acquire = inner.limiter.acquire();
            tokio::pin!(acquire);
            let mut parked = false;
            let permit = loop {
                tokio::select! {
                    permit = &mut acquire => break Some(permit),
                    changed = control_rx.changed() => {
                        if changed.is_err() {
                            return;
                        }
                        let ctl = *control_rx.borrow_and_update();
                        match ctl {
                            Control::Run => {}
                            Control::Cancel => {
                                cleanup_cancelled(&inner, &id, seq, &spec, &done_tx).await;
                                return;
                            }
                            Control::Pause => {
                                parked = true;
                                break None;
                            }
                        }
                    }
                }
            };
            if parked {
                patch(&inner, &id, true, |t| {
                    t.state = DownloadState::Paused;
                    t.speed_bps = None;
                })
                .await;
                continue;
            }
            permit.expect("permit acquired when not parked")
        };
        patch(&inner, &id, true, |t| {
            t.state = DownloadState::Active;
            t.error = None;
        })
        .await;

        match attempt(&inner, &id, &spec, &mut control_rx).await {
            AttemptOutcome::Done(path) => {
                drop(_permit);
                finish_completed(&inner, &id, seq, &done_tx, path).await;
                return;
            }
            AttemptOutcome::Cancelled => {
                drop(_permit);
                cleanup_cancelled(&inner, &id, seq, &spec, &done_tx).await;
                return;
            }
            AttemptOutcome::Paused => {
                drop(_permit);
                patch(&inner, &id, true, |t| {
                    t.state = DownloadState::Paused;
                    t.speed_bps = None;
                })
                .await;
                // control is already Pause (the user set it) → PARK re-parks.
                continue;
            }
            AttemptOutcome::Failed { error, retryable } => {
                drop(_permit);
                // ORDER IS LOAD-BEARING. Re-arm to parked (so we don't hot-loop)
                // and publish the result BEFORE the task reads as `Failed`:
                // `spawn` restarts a `Failed` task by clearing the result and
                // sending Run, and either step landing after that would park the
                // restart forever or hand its caller this stale error. A Cancel
                // that arrived meanwhile is kept, not overwritten.
                control_tx.send_if_modified(|ctl| {
                    let rearm = *ctl == Control::Run;
                    if rearm {
                        *ctl = Control::Pause;
                    }
                    rearm
                });
                // Failed transfers remain parked and retryable when allowed,
                // but the synchronous `download_blocking` contract still needs
                // a result so installers cannot hang forever on a checksum,
                // redirect, or network error.
                let _ = done_tx.send(Some(Err(error.clone())));
                patch(&inner, &id, true, |t| {
                    t.state = DownloadState::Failed;
                    t.error = Some(error);
                    t.retryable = retryable;
                    t.speed_bps = None;
                })
                .await;
                continue;
            }
        }
    }
}

/// If `dest` exists and matches the expected checksum (or a recorded one), skip
/// the download entirely. Mirrors the downloaders' existing fast-path.
pub(super) async fn fast_path(spec: &DownloadSpec) -> Option<PathBuf> {
    if !spec.dest.exists() {
        return None;
    }
    let expected = spec.sha256.clone().filter(|s| !s.is_empty()).or_else(|| {
        spec.version_record
            .as_ref()
            .and_then(|v| host().installed_checksum(&v.store_key))
    })?;
    let actual = sha256_file(&spec.dest).await.ok()?;
    (actual == expected).then(|| spec.dest.clone())
}

/// Stream with bounded retry. Network errors keep the `.part` and retry with a
/// Range request; fatal IO errors and checksum mismatches fail terminally.
pub(super) async fn attempt(
    inner: &Inner,
    id: &str,
    spec: &DownloadSpec,
    control_rx: &mut watch::Receiver<Control>,
) -> AttemptOutcome {
    if requires_checksum(spec.role) && expected_checksum(spec).is_none() {
        return AttemptOutcome::Failed {
            error: format!(
                "download '{}' requires a SHA-256 checksum before execution",
                spec.label
            ),
            retryable: false,
        };
    }
    let mut attempts = 0u32;
    loop {
        attempts += 1;
        match stream_once(inner, id, spec, control_rx).await {
            Ok(StreamResult::Done) => match finalize(inner, id, spec).await {
                Ok(path) => return AttemptOutcome::Done(path),
                Err(e) => {
                    // Bad checksum or rename failure — delete the corrupt .part.
                    let _ = tokio::fs::remove_file(part_path(&spec.dest)).await;
                    return AttemptOutcome::Failed {
                        error: e,
                        retryable: false,
                    };
                }
            },
            Ok(StreamResult::Paused) => return AttemptOutcome::Paused,
            Ok(StreamResult::Cancelled) => return AttemptOutcome::Cancelled,
            Err(StreamErr::Network(e)) => {
                if attempts >= MAX_ATTEMPTS {
                    return AttemptOutcome::Failed {
                        error: e,
                        retryable: true,
                    };
                }
                let backoff = Duration::from_secs(1u64 << (attempts - 1));
                tracing::warn!(
                    "download {id}: attempt {attempts} failed ({e}); retry in {backoff:?}"
                );
                // Honour cancel/pause during the backoff wait.
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    changed = control_rx.changed() => {
                        if changed.is_err() { return AttemptOutcome::Cancelled; }
                        let ctl = *control_rx.borrow();
                        match ctl {
                            Control::Cancel => return AttemptOutcome::Cancelled,
                            Control::Pause => return AttemptOutcome::Paused,
                            Control::Run => {}
                        }
                    }
                }
            }
            Err(StreamErr::Io(e)) => {
                return AttemptOutcome::Failed {
                    error: e,
                    retryable: false,
                }
            }
        }
    }
}

pub(super) fn requires_checksum(role: DownloadRole) -> bool {
    matches!(
        role,
        DownloadRole::Engine
            | DownloadRole::Agent
            | DownloadRole::Tool
            | DownloadRole::Plugin
            | DownloadRole::McpServer
    )
}

/// The digest a transfer's bytes must match: the caller's pinned checksum only.
///
/// The checksum recorded in `versions.json` is NOT a fallback here. It belongs to
/// the INSTALLED bytes, so verifying a fresh download against it made every
/// changed artifact a permanent "checksum mismatch": a bumped tool version, a
/// re-uploaded `resolve/main` model, an updated GGUF. It still feeds
/// [`fast_path`], where "the file on disk is the one we recorded" is exactly the
/// question.
pub(super) fn expected_checksum(spec: &DownloadSpec) -> Option<String> {
    spec.sha256.clone().filter(|value| !value.is_empty())
}
