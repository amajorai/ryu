//! Dream's run watermark: when it last ran and the newest chat message it had
//! read by then. An automatic tick with nothing newer than the watermark
//! returns the pending review without a model call, so an idle node does not
//! re-send the same chats every interval.

use super::sources::DreamSource;
use super::{DREAM_LAST_RUN_PREF, DREAM_LAST_SOURCE_AT_PREF};
use crate::server::ServerState;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct DreamRunState {
    /// `created_at` of the newest source message a completed run had read.
    pub(super) last_source_at: Option<i64>,
    /// When the last completed run finished, in Unix milliseconds.
    pub(super) last_run: Option<i64>,
}

/// Whether an automatic run can be skipped: only when a watermark exists and
/// no loaded source is newer than it. With no watermark Dream has never
/// finished a run, so it must run.
pub(super) fn should_skip(newest_source_at: Option<i64>, watermark: Option<i64>) -> bool {
    match (newest_source_at, watermark) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(newest), Some(watermark)) => newest <= watermark,
    }
}

pub(super) fn newest_source_at(sources: &[DreamSource]) -> Option<i64> {
    sources.iter().map(|source| source.created_at).max()
}

async fn read_i64(state: &ServerState, key: &str) -> Option<i64> {
    match state.preferences.get(key).await {
        Ok(value) => value.and_then(|value| value.trim().parse::<i64>().ok()),
        Err(error) => {
            tracing::warn!("Dream could not read {key}: {error:#}");
            None
        }
    }
}

pub(super) async fn read_run_state(state: &ServerState) -> DreamRunState {
    DreamRunState {
        last_source_at: read_i64(state, DREAM_LAST_SOURCE_AT_PREF).await,
        last_run: read_i64(state, DREAM_LAST_RUN_PREF).await,
    }
}

/// Record a completed run. The source watermark only moves forward, so a run
/// over an older window cannot make a later tick re-read chats it has seen.
pub(super) async fn record_run(
    state: &ServerState,
    previous: DreamRunState,
    newest_source_at: Option<i64>,
    run_at: i64,
) -> anyhow::Result<()> {
    let advanced = match (previous.last_source_at, newest_source_at) {
        (Some(previous), Some(newest)) => Some(previous.max(newest)),
        (previous, newest) => newest.or(previous),
    };
    if let Some(watermark) = advanced.filter(|value| Some(*value) != previous.last_source_at) {
        state
            .preferences
            .set(DREAM_LAST_SOURCE_AT_PREF, &watermark.to_string())
            .await?;
    }
    state
        .preferences
        .set(DREAM_LAST_RUN_PREF, &run_at.to_string())
        .await
}
