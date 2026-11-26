//! The opt-in background sync loop and its token-rejection throttle.

use super::*;

// ── Background sync loop (opt-in, off by default) ─────────────────────────────

/// Preferences-KV key for the opt-in sync toggle. Mirrors the
/// `claude_config::CLAUDE_GATEWAY_ROUTING_PREF_KEY` pattern: a value of
/// `"true"` enables the background sync loop. Absent / any other value keeps it
/// off (local-first rule: Core never phones home by default).
pub const SYNC_ENABLED_PREF_KEY: &str = "cloud-sync-enabled";

/// Environment variable that also enables the sync loop (truthy = `1`/`true`).
/// Either the env var OR the persisted pref turns sync on; default is OFF.
pub const SYNC_ENABLED_ENV: &str = "RYU_SYNC_ENABLED";

/// How often the loop pushes local conversations + pulls remote changes.
pub(super) const SYNC_INTERVAL: Duration = Duration::from_secs(60);

/// True when the `RYU_SYNC_ENABLED` env var is set to a truthy value.
pub(super) fn env_sync_enabled() -> bool {
    matches!(
        std::env::var(SYNC_ENABLED_ENV).ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes")
    )
}

/// Resolve whether sync is currently enabled. The env var is a static gate; the
/// pref is re-read each tick so a desktop toggle takes effect without a restart.
pub(super) async fn sync_enabled(
    preferences: &crate::server::preferences::PreferencesStore,
) -> bool {
    if env_sync_enabled() {
        return true;
    }
    matches!(
        preferences
            .get(SYNC_ENABLED_PREF_KEY)
            .await
            .ok()
            .flatten()
            .as_deref(),
        Some("true")
    )
}

/// Spawn the opt-in cross-device sync loop. Returns immediately. The loop is a
/// no-op every tick until the user opts in (env `RYU_SYNC_ENABLED` or the
/// `cloud-sync-enabled` pref), so this is safe to call unconditionally at
/// startup and never alters default (local-first) behaviour.
///
/// Each enabled tick: push every local conversation to the server store, then
/// receive remote changes since the last watermark (last-writer-wins +
/// union-merge, applied by [`apply_sync_payload`]). The read path prefers the
/// live SSE change feed ([`SyncClient::stream_changes`]) — held open for up to
/// one interval so deltas apply with near-zero latency while local pushes still
/// recur — and falls back to the [`SyncClient::pull_since`] long-poll whenever
/// streaming is unavailable. All errors are best-effort: logged and swallowed so
/// a flaky network or a signed-out user never panics or stalls Core.
pub fn spawn_sync_loop(
    conversations: ConversationStore,
    spaces: crate::server::spaces::SpaceStore,
    preferences: crate::server::preferences::PreferencesStore,
) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SYNC_INTERVAL);
        // A tick that overruns (a slow push or pull) must not be followed by a
        // burst of catch-up ticks.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Loop-local watermark: 0 = full sync on the first enabled pull, then
        // advanced to "now" after each success. Kept in memory only: no new
        // persistence path, so a restart simply does one extra full pull.
        let mut pull_since_ms: i64 = 0;
        let mut document_pull_since_ms: i64 = 0;
        // Throttle the "no token" warning so a signed-out user with sync on does
        // not spam the log every tick.
        let mut warned_unauthenticated = false;
        // Same for a missing or refused backend: the reason is logged once and
        // the loop sends nothing until a sign-in (or `RYU_SERVER_URL`) fixes it.
        let mut warned_backend = false;
        // Throttle the "token rejected" warning the same way: a revoked or
        // expired token is reported once, not on every tick.
        let mut warned_rejected = false;
        // Sync revision of each conversation as last pushed successfully, for the
        // push destination in `pushed_scope`. A conversation whose revision is
        // unchanged is skipped instead of being rebuilt and re-uploaded every
        // tick. Memory only: a restart pushes everything once, as before.
        let mut pushed_revs: std::collections::HashMap<String, i64> =
            std::collections::HashMap::new();
        let mut pushed_scope: Option<(String, u64, Tenancy)> = None;
        // `updated_at` of each Spaces document as last pushed successfully, for
        // the same destination. The server ignores a push whose `updated_at` is
        // not newer, so an unchanged document is skipped instead of re-uploading
        // its full body every tick. Memory only, like `pushed_revs`.
        let mut pushed_doc_stamps: std::collections::HashMap<String, i64> =
            std::collections::HashMap::new();

        loop {
            interval.tick().await;

            if !sync_enabled(&preferences).await {
                continue;
            }

            let client = match SyncClient::from_env() {
                Ok(client) => {
                    warned_unauthenticated = false;
                    warned_backend = false;
                    client
                }
                Err(SyncError::Unauthenticated) => {
                    if !warned_unauthenticated {
                        tracing::info!(
                            "cloud sync enabled but no auth token found; complete device login to sync"
                        );
                        warned_unauthenticated = true;
                    }
                    continue;
                }
                Err(SyncError::Backend(e)) => {
                    backend::note_backend_refused(&mut warned_backend, &e);
                    continue;
                }
                Err(e) => {
                    tracing::warn!("cloud sync: failed to build client: {e}");
                    continue;
                }
            };

            let Some(replay_ctx) = resolve_replay_context() else {
                tracing::debug!(
                    "cloud sync: skipping this tick on an org-bound node — no signed-in \
                     account to authorise attribution (fail closed); complete device login"
                );
                continue;
            };

            // Push only conversations visible to the active account on a bound node.
            // An unfiltered export here would leak another member's private chat into
            // the signed-in user's cloud mirror.
            let local_conversations = match &replay_ctx {
                Tenancy::Unattributed => conversations.list_conversations().await,
                Tenancy::Owned { user_id, org_id } => {
                    conversations
                        .list_conversations_visible(Some(user_id), org_id.as_deref(), true)
                        .await
                }
                Tenancy::SharedOrg { org_id } => {
                    conversations
                        .list_conversations_visible(None, Some(org_id), true)
                        .await
                }
            };
            // A different server, account or tenancy is a different mirror, so
            // what was pushed before says nothing about it.
            let scope = (
                client.server_url.clone(),
                token_fingerprint(&client.token),
                replay_ctx.clone(),
            );
            if pushed_scope.as_ref() != Some(&scope) {
                pushed_revs.clear();
                pushed_doc_stamps.clear();
                pushed_scope = Some(scope);
            }
            // Read before building any payload: a change that lands mid-push bumps
            // the revision past the recorded one, so the next tick pushes again.
            let revisions = match conversations.sync_revisions().await {
                Ok(revisions) => revisions,
                Err(e) => {
                    tracing::warn!("cloud sync: reading sync revisions failed: {e}");
                    std::collections::HashMap::new()
                }
            };
            // Set when the server rejects the stored token (401/403). Every
            // other request this tick would fail the same way, so the tick stops
            // there: a revoked token costs one request a minute, not one per
            // conversation and document.
            let mut rejected = false;
            match local_conversations {
                Ok(summaries) => {
                    for summary in &summaries {
                        let revision = revisions.get(&summary.id).copied();
                        if revision.is_some() && pushed_revs.get(&summary.id).copied() == revision {
                            continue;
                        }
                        match client.push(&conversations, &summary.id).await {
                            Ok(()) => {
                                warned_rejected = false;
                                if let Some(revision) = revision {
                                    pushed_revs.insert(summary.id.clone(), revision);
                                }
                            }
                            Err(e) if is_auth_rejection(&e) => {
                                warn_token_rejected(&mut warned_rejected, &e);
                                rejected = true;
                                break;
                            }
                            Err(e) => {
                                tracing::warn!(
                                    "cloud sync: push of conversation {} failed: {e}",
                                    summary.id
                                );
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("cloud sync: listing local conversations failed: {e}");
                }
            }
            if rejected {
                continue;
            }

            // Receive remote changes since the last server-owned watermark.
            // Prefer the live SSE change feed; hold it open for at most one
            // interval so local pushes still recur, then reconnect on the next
            // tick. Every pull drains its bounded cursor pages before this
            // watermark advances, so a large backlog cannot be skipped.
            match build_document_sync_payloads(&spaces).await {
                Ok(payloads) => {
                    for payload in payloads {
                        let visible_to_account = match &replay_ctx {
                            Tenancy::Unattributed => true,
                            Tenancy::Owned { user_id, .. } => {
                                payload.owner_user_id.as_deref() == Some(user_id.as_str())
                            }
                            Tenancy::SharedOrg { .. } => true,
                        };
                        if !visible_to_account {
                            continue;
                        }
                        if !document_needs_push(&pushed_doc_stamps, &payload) {
                            continue;
                        }
                        match client.push_document(&payload).await {
                            Ok(()) => {
                                warned_rejected = false;
                                pushed_doc_stamps
                                    .insert(payload.document_id.clone(), payload.updated_at);
                            }
                            Err(error) if is_auth_rejection(&error) => {
                                warn_token_rejected(&mut warned_rejected, &error);
                                rejected = true;
                                break;
                            }
                            Err(error) => {
                                tracing::warn!(
                                    "cloud sync: push of document {} failed: {error}",
                                    payload.document_id
                                );
                            }
                        }
                    }
                }
                Err(error) => {
                    tracing::warn!("cloud sync: listing local documents failed: {error:#}")
                }
            }
            if rejected {
                continue;
            }

            // The captured wall time is only a compatibility fallback for an
            // older server that does not return the server-owned watermark.
            let document_now_ms = chrono::Utc::now().timestamp_millis();
            match client
                .pull_documents_since_with_snapshot(
                    &spaces,
                    document_pull_since_ms,
                    replay_ctx.clone(),
                )
                .await
            {
                Ok(outcome) => {
                    warned_rejected = false;
                    if outcome.applied > 0 {
                        tracing::info!("cloud sync: pulled {} document(s)", outcome.applied);
                    }
                    document_pull_since_ms = outcome.snapshot_at.unwrap_or(document_now_ms);
                }
                Err(error) if is_auth_rejection(&error) => {
                    // Typically reached when every conversation and document
                    // was already current, so no push hit the rejection first.
                    // The stream and conversation pull would be refused too.
                    warn_token_rejected(&mut warned_rejected, &error);
                    continue;
                }
                Err(error) => tracing::warn!("cloud sync: document pull failed: {error}"),
            }
            let stream_fallback_now_ms = chrono::Utc::now().timestamp_millis();
            match tokio::time::timeout(
                SYNC_INTERVAL,
                client.stream_changes_with_snapshot(
                    &conversations,
                    pull_since_ms,
                    replay_ctx.clone(),
                ),
            )
            .await
            {
                // A stream header or clean EOF only describes the server's
                // intended boundary. It does not prove that the entire bounded
                // snapshot was received, that the final frame was complete, or
                // that every delta was applied. Always drain the paginated pull
                // from the old watermark before advancing it; apply failures
                // keep the watermark unchanged so the next tick retries them.
                Ok(Ok(_)) => {
                    tracing::debug!("cloud sync: sse window ended; reconciling with paginated pull")
                }
                Err(_) => tracing::debug!(
                    "cloud sync: sse window elapsed; reconciling with paginated pull"
                ),
                Ok(Err(stream_err)) => tracing::debug!(
                    "cloud sync: sse unavailable; falling back to paginated pull: {stream_err}"
                ),
            }
            match client
                .pull_since_with_snapshot(&conversations, pull_since_ms, replay_ctx.clone())
                .await
            {
                Ok(outcome) => {
                    warned_rejected = false;
                    if outcome.applied > 0 {
                        tracing::info!("cloud sync: pulled {} conversation(s)", outcome.applied);
                    }
                    pull_since_ms = outcome.snapshot_at.unwrap_or(stream_fallback_now_ms);
                }
                Err(error) => {
                    tracing::warn!("cloud sync: paginated pull failed: {error}");
                }
            }
        }
    });
}

// ── Pure helpers (no HTTP — tested independently) ────────────────────────────

/// True when the server refused the stored token itself. Every request in the
/// tick would fail the same way, so the loop stops the tick instead of retrying
/// each conversation and document. Other 4xx codes (an oversized conversation's
/// 413, say) stay per-item failures so one bad item cannot block the rest.
pub(super) fn is_auth_rejection(error: &SyncError) -> bool {
    matches!(error, SyncError::ServerError(401 | 403, _))
}

/// Log a token rejection once until a later request succeeds again.
pub(super) fn warn_token_rejected(warned: &mut bool, error: &SyncError) {
    if !*warned {
        tracing::warn!(
            "cloud sync: server rejected the stored token ({error}); pausing sync until device login is refreshed"
        );
        *warned = true;
    }
}
