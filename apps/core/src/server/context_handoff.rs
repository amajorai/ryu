//! Resolve the context handoff for a chat turn.
//!
//! Reads the conversation's model-change history, applies the
//! `context.handoff-on-model-change` policy to the latest change, and produces
//! (once) the briefing that replaces the history from before that change. The
//! decision is stored per model change, so later turns replay the same summary
//! and the transcript can show a marker. The policy itself and how the briefing
//! is applied to each plane live in `sidecar::adapters::context_handoff`.

use super::conversations::{
    ContextHandoffOutcome, ConversationContextHandoff, ConversationModelChange,
    ConversationModelChangeKind,
};
use super::ServerState;
use crate::sidecar::adapters::context_handoff::{
    self, ContextHandoff, HandoffPolicy, HandoffSide, HANDOFF_PREF,
};
use crate::sidecar::adapters::context_window::ContextWindowConfig;
use crate::sidecar::adapters::ChatStreamRequest;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

/// Reply reserve assumed when sizing whether the earlier history still fits the
/// new model. Mirrors the context window's default `context.max-output-tokens`.
const HANDOFF_REPLY_RESERVE: usize = 1024;
/// Excerpt cap for the summarizer when neither model's window is known.
const HANDOFF_FALLBACK_WINDOW: usize = 32_000;
/// How long a handoff whose summarizers all failed is left alone before a
/// later turn tries again. Each attempt walks up to three summarizers with a
/// long timeout each, so retrying on every turn would stall every send.
const HANDOFF_FAILURE_BACKOFF: Duration = Duration::from_secs(300);

/// A handoff, keyed by (model change id, covered head id).
type HandoffKey = (String, String);

/// Process-local record of handoffs whose summarizers all failed recently.
/// Never held across an await.
fn handoff_failures() -> &'static Mutex<HashMap<HandoffKey, Instant>> {
    static FAILURES: OnceLock<Mutex<HashMap<HandoffKey, Instant>>> = OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether summarizing this handoff failed within the backoff window.
fn recently_failed(map: &HashMap<HandoffKey, Instant>, key: &HandoffKey, now: Instant) -> bool {
    map.get(key)
        .is_some_and(|at| now.saturating_duration_since(*at) < HANDOFF_FAILURE_BACKOFF)
}

/// Note a failed summary for this handoff, dropping expired entries first so
/// the map stays bounded.
fn note_failure(map: &mut HashMap<HandoffKey, Instant>, key: HandoffKey, now: Instant) {
    map.retain(|_, at| now.saturating_duration_since(*at) < HANDOFF_FAILURE_BACKOFF);
    map.insert(key, now);
}

/// Forget a failure once this handoff has been summarized.
fn clear_failure(map: &mut HashMap<HandoffKey, Instant>, key: &HandoffKey) {
    map.remove(key);
}

/// The handoff recorded for this turn's active thread, if it carried a summary.
/// Fail-open: any error, or a summary that could not be produced, sends the
/// turn exactly as before.
///
/// Handoffs are keyed by the model change AND the last message before it on the
/// active thread. Editing or branching from a message before the switch changes
/// that head, so the new branch is evaluated (and summarized) on its own instead
/// of replaying a summary of the thread the user left; switching back to the old
/// branch replays its original summary.
pub(crate) async fn resolve(
    state: &ServerState,
    req: &ChatStreamRequest,
) -> Option<ConversationContextHandoff> {
    let conversation_id = req.conversation_id.as_deref()?;
    let policy = HandoffPolicy::parse(
        state
            .preferences
            .get(HANDOFF_PREF)
            .await
            .ok()
            .flatten()
            .as_deref(),
    );
    if policy == HandoffPolicy::Off {
        return None;
    }
    let changes = match state
        .conversations
        .list_model_changes(conversation_id)
        .await
    {
        Ok(changes) => changes,
        Err(error) => {
            tracing::warn!(%error, "context handoff: could not read model history");
            return None;
        }
    };
    let (previous, current) = match changes.as_slice() {
        [.., previous, current] if current.kind == ConversationModelChangeKind::Change => {
            (previous, current)
        }
        _ => return None,
    };

    let previous_side = side(state, previous).await;
    let next_side = side(state, current).await;
    let reason = context_handoff::decide(policy, &previous_side, &next_side)?;

    // The active thread as the turn will see it: an edit has already created its
    // sibling and moved the leaf, and a normal turn's user row is written later.
    let history = match state
        .conversations
        .get_active_messages(conversation_id)
        .await
    {
        Ok(messages) => messages
            .into_iter()
            .filter(|message| message.created_at < current.created_at && message.role != "system")
            .collect::<Vec<_>>(),
        Err(error) => {
            tracing::warn!(%error, "context handoff: could not read the earlier history");
            return None;
        }
    };
    let covered_head_id = history
        .last()
        .map(|message| message.id.clone())
        .unwrap_or_default();

    match state
        .conversations
        .get_context_handoff(&current.id, &covered_head_id)
        .await
    {
        Ok(Some(recorded)) => return carried(recorded),
        Ok(None) => {}
        Err(error) => {
            tracing::warn!(%error, "context handoff: could not read the recorded handoff");
            return None;
        }
    }

    let fits = history.is_empty()
        || (reason.requires_overflow()
            && next_side.context_window.is_some_and(|window| {
                let budget = ContextWindowConfig {
                    max_tokens: window,
                    reserve_output: HANDOFF_REPLY_RESERVE,
                    auto_compact: false,
                    compact_model: String::new(),
                    compact_effort: String::new(),
                    compact_on_cache_expire: false,
                }
                .input_budget(0);
                context_handoff::estimate_stored_tokens(&history) <= budget
            }));

    let failure_key: HandoffKey = (current.id.clone(), covered_head_id.clone());
    let summary = if fits {
        None
    } else {
        if recently_failed(
            &handoff_failures()
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            &failure_key,
            Instant::now(),
        ) {
            // Summarizing this handoff just failed: send the full history
            // without walking the summarizers again until the backoff ends.
            return None;
        }
        let convo: Vec<(String, String)> = history
            .iter()
            .map(|message| (message.role.clone(), message.content.clone()))
            .collect();
        let summary = summarize(
            state,
            conversation_id,
            &convo,
            previous,
            current,
            &previous_side,
            &next_side,
        )
        .await;
        // No summary, no marker: a later turn tries again (after the backoff)
        // rather than locking in a handoff that carried nothing.
        {
            let mut failures = handoff_failures()
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            match &summary {
                Some(_) => clear_failure(&mut failures, &failure_key),
                None => note_failure(&mut failures, failure_key, Instant::now()),
            }
        }
        Some(summary?)
    };

    let record = ConversationContextHandoff {
        id: uuid::Uuid::new_v4().to_string(),
        model_change_id: current.id.clone(),
        covered_head_id,
        outcome: if summary.is_some() {
            ContextHandoffOutcome::Applied
        } else {
            ContextHandoffOutcome::NotNeeded
        },
        reason: reason.as_str().to_owned(),
        from_model: display_model(previous),
        to_model: display_model(current),
        from_context: previous_side.context_window.map(to_i64),
        to_context: next_side.context_window.map(to_i64),
        summarized_count: if summary.is_some() {
            to_i64(history.len())
        } else {
            0
        },
        boundary_at: current.created_at,
        summary,
        created_at: now_millis(),
    };
    match state
        .conversations
        .record_context_handoff(conversation_id, record)
        .await
    {
        Ok(recorded) => carried(recorded),
        Err(error) => {
            tracing::warn!(%error, "context handoff: could not record the handoff");
            None
        }
    }
}

/// The recorded row, when it carried a summary.
fn carried(recorded: ConversationContextHandoff) -> Option<ConversationContextHandoff> {
    (recorded.outcome == ContextHandoffOutcome::Applied && recorded.summary.is_some())
        .then_some(recorded)
}

/// The turn-ready handoff for a recorded row, or `None` when it carried nothing.
pub(crate) fn applied(recorded: &ConversationContextHandoff) -> Option<ContextHandoff> {
    if recorded.outcome != ContextHandoffOutcome::Applied {
        return None;
    }
    Some(ContextHandoff {
        summary: recorded.summary.clone()?,
        summarized_count: usize::try_from(recorded.summarized_count).unwrap_or(0),
        boundary_at: recorded.boundary_at,
    })
}

/// Whether some model change was handed off on more than one branch, so the
/// markers have to be matched against the active thread.
pub(crate) fn has_branched_handoffs(handoffs: &[ConversationContextHandoff]) -> bool {
    let mut seen = std::collections::HashSet::new();
    handoffs
        .iter()
        .filter(|handoff| handoff.outcome == ContextHandoffOutcome::Applied)
        .any(|handoff| !seen.insert(handoff.model_change_id.as_str()))
}

/// The handoff markers to show: those that carried a summary and, when
/// `active_ids` is given, belong to the branch the thread is on now.
pub(crate) fn markers_for_thread(
    handoffs: Vec<ConversationContextHandoff>,
    active_ids: Option<&std::collections::HashSet<String>>,
) -> Vec<ConversationContextHandoff> {
    handoffs
        .into_iter()
        .filter(|handoff| handoff.outcome == ContextHandoffOutcome::Applied)
        .filter(|handoff| {
            active_ids.is_none_or(|active| {
                handoff.covered_head_id.is_empty() || active.contains(&handoff.covered_head_id)
            })
        })
        .collect()
}

/// Announce the handoff this turn runs on as a transient `data-ryu-context-handoff`
/// part, so the transcript marker appears as the turn starts on every client that
/// reads the stream, with or without a realtime connection. Transient: never
/// part of the message, persisted, or replayed to the model. It rides right
/// behind the opening frame, like the failover note.
pub(crate) fn with_marker(
    response: axum::response::Response,
    handoff: &ConversationContextHandoff,
) -> axum::response::Response {
    if !response.status().is_success() {
        return response;
    }
    let frame =
        axum::body::Bytes::from(crate::sidecar::adapters::ui_context_handoff_marker(handoff));
    let (parts, body) = response.into_parts();
    let mut inner = body.into_data_stream();
    let stream = async_stream::stream! {
        use futures_util::StreamExt as _;
        let mut frame = Some(frame);
        while let Some(chunk) = inner.next().await {
            let Ok(bytes) = chunk else { break };
            yield Ok::<_, std::convert::Infallible>(bytes);
            if let Some(frame) = frame.take() {
                yield Ok::<_, std::convert::Infallible>(frame);
            }
        }
    };
    axum::response::Response::from_parts(parts, axum::body::Body::from_stream(stream))
}

/// One side of the change with its context window resolved: a local model's
/// launch `ctx_size` first, else the models.dev catalog (cached in Core).
async fn side(state: &ServerState, change: &ConversationModelChange) -> HandoffSide {
    let context_window = match change.model_id.as_deref() {
        Some(model) => model_context_window(state, model).await,
        None => None,
    };
    HandoffSide {
        provider_id: change.provider_id.clone(),
        model_id: change.model_id.clone(),
        context_window,
    }
}

async fn model_context_window(state: &ServerState, model: &str) -> Option<usize> {
    if let Some(size) = state
        .preferences
        .get_launch_config(model)
        .await
        .ctx_size
        .filter(|size| *size > 0)
    {
        return usize::try_from(size).ok();
    }
    crate::model_catalog::models_dev::context_window(model)
        .await
        .filter(|size| *size > 0)
        .and_then(|size| usize::try_from(size).ok())
}

/// Summarize the earlier history. The summarizer is, in order: the configured
/// `context.compact-model` / node default, the PREVIOUS model (it already held
/// this history, so it can read all of it), then the new model.
async fn summarize(
    state: &ServerState,
    conversation_id: &str,
    convo: &[(String, String)],
    previous: &ConversationModelChange,
    current: &ConversationModelChange,
    previous_side: &HandoffSide,
    next_side: &HandoffSide,
) -> Option<String> {
    let configured = crate::agent_selection::resolve_side_model(
        &state.preferences,
        super::CONTEXT_COMPACT_MODEL_PREF,
        Some(super::CONTEXT_COMPACT_EFFORT_PREF),
    )
    .await;
    let mut candidates: Vec<(String, String, Option<usize>)> = Vec::new();
    if let Some(resolved) = configured {
        let window = model_context_window(state, &resolved.model).await;
        candidates.push((resolved.model, resolved.effort, window));
    }
    for (change, window) in [
        (previous, previous_side.context_window),
        (current, next_side.context_window),
    ] {
        if let Some(model) = change.model_id.clone() {
            if !candidates.iter().any(|(existing, _, _)| *existing == model) {
                candidates.push((model, String::new(), window));
            }
        }
    }
    for (model, effort, window) in candidates {
        let cfg = ContextWindowConfig {
            max_tokens: window.unwrap_or(HANDOFF_FALLBACK_WINDOW),
            reserve_output: HANDOFF_REPLY_RESERVE,
            auto_compact: true,
            compact_model: model,
            compact_effort: effort,
            compact_on_cache_expire: false,
        };
        if let Some(summary) = crate::sidecar::adapters::context_window::summarize_handoff(
            conversation_id,
            convo,
            &cfg,
        )
        .await
        {
            return Some(summary);
        }
    }
    tracing::warn!("context handoff: no summarizer produced a briefing; sending full history and backing off retries for 5 minutes");
    None
}

fn display_model(change: &ConversationModelChange) -> Option<String> {
    change
        .model_label
        .clone()
        .or_else(|| change.model_id.clone())
}

fn to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| to_i64(elapsed.as_millis() as usize))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::adapters::context_handoff::HandoffReason;

    fn recorded(
        outcome: ContextHandoffOutcome,
        summary: Option<&str>,
    ) -> ConversationContextHandoff {
        ConversationContextHandoff {
            id: "h".to_owned(),
            model_change_id: "c".to_owned(),
            covered_head_id: "m3".to_owned(),
            outcome,
            reason: HandoffReason::SmallerContext.as_str().to_owned(),
            from_model: None,
            to_model: None,
            from_context: None,
            to_context: None,
            summarized_count: 3,
            boundary_at: 42,
            summary: summary.map(str::to_owned),
            created_at: 0,
        }
    }

    fn key(change: &str, head: &str) -> HandoffKey {
        (change.to_owned(), head.to_owned())
    }

    #[test]
    fn a_failed_summary_is_backed_off_for_that_handoff_only() {
        let mut map = HashMap::new();
        let now = Instant::now();
        let failed = key("c1", "m3");
        assert!(!recently_failed(&map, &failed, now));

        note_failure(&mut map, failed.clone(), now);
        assert!(recently_failed(&map, &failed, now + Duration::from_secs(1)));
        assert!(!recently_failed(
            &map,
            &failed,
            now + HANDOFF_FAILURE_BACKOFF + Duration::from_secs(1)
        ));
        assert!(!recently_failed(&map, &key("c1", "m4"), now));
        assert!(!recently_failed(&map, &key("c2", "m3"), now));

        clear_failure(&mut map, &failed);
        assert!(!recently_failed(
            &map,
            &failed,
            now + Duration::from_secs(1)
        ));
    }

    #[test]
    fn noting_a_failure_prunes_expired_entries() {
        let mut map = HashMap::new();
        let then = Instant::now();
        note_failure(&mut map, key("old", "m1"), then);
        let later = then + HANDOFF_FAILURE_BACKOFF + Duration::from_secs(1);
        note_failure(&mut map, key("new", "m1"), later);
        assert_eq!(map.len(), 1);
        assert!(map.contains_key(&key("new", "m1")));
    }

    #[test]
    fn only_applied_rows_with_a_summary_reach_the_turn() {
        assert_eq!(
            carried(recorded(ContextHandoffOutcome::NotNeeded, None)),
            None
        );
        assert_eq!(
            carried(recorded(ContextHandoffOutcome::Applied, None)),
            None
        );
        assert_eq!(
            applied(&recorded(ContextHandoffOutcome::Applied, Some("brief"))),
            Some(ContextHandoff {
                summary: "brief".to_owned(),
                summarized_count: 3,
                boundary_at: 42,
            })
        );
    }

    #[test]
    fn markers_follow_the_active_branch() {
        let on = |id: &str, change: &str, head: &str| ConversationContextHandoff {
            id: id.to_owned(),
            model_change_id: change.to_owned(),
            covered_head_id: head.to_owned(),
            ..recorded(ContextHandoffOutcome::Applied, Some("brief"))
        };
        let skipped = ConversationContextHandoff {
            id: "skipped".to_owned(),
            ..recorded(ContextHandoffOutcome::NotNeeded, None)
        };
        let single = vec![on("a", "c1", "m1"), skipped.clone()];
        assert!(!has_branched_handoffs(&single));
        assert_eq!(markers_for_thread(single, None).len(), 1);

        let both = vec![on("old", "c1", "m3"), on("new", "c1", "m3-edit"), skipped];
        assert!(has_branched_handoffs(&both));
        let active = ["m1", "m3-edit"].map(str::to_owned).into_iter().collect();
        let markers = markers_for_thread(both, Some(&active));
        let ids: Vec<&str> = markers.iter().map(|marker| marker.id.as_str()).collect();
        assert_eq!(ids, ["new"]);
    }

    #[tokio::test]
    async fn resolve_keys_handoffs_by_branch_and_replays_on_switch_back() {
        use crate::server::conversations::{ConversationModelSelectionInput, Tenancy};

        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        state
            .preferences
            .set(HANDOFF_PREF, "smaller-context")
            .await
            .unwrap();
        // Local launch windows, so `side()` never reaches the models.dev catalog.
        for (model, ctx_size) in [("big", 200_000), ("small", 100_000)] {
            state
                .preferences
                .set_launch_config(
                    model,
                    &crate::inference::LaunchConfig {
                        ctx_size: Some(ctx_size),
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
        }

        // The original branch, written strictly before the model changes. The
        // trailing system row must never be chosen as the covered head.
        let conversations = &state.conversations;
        let past = now_millis() - 60_000;
        let mut ids = Vec::new();
        for (offset, (role, content)) in [
            ("user", "first question"),
            ("assistant", "first answer"),
            ("user", "second question"),
            ("system", "a system note"),
        ]
        .into_iter()
        .enumerate()
        {
            let id = conversations
                .append_message_at(
                    "c",
                    role,
                    content,
                    None,
                    None,
                    None,
                    Tenancy::Unattributed,
                    Some(past + i64::try_from(offset).unwrap()),
                )
                .await
                .unwrap();
            ids.push(id);
        }
        let (m2, m3) = (ids[1].clone(), ids[2].clone());

        for (id, kind, model) in [
            ("change-1", ConversationModelChangeKind::Initial, "big"),
            ("change-2", ConversationModelChangeKind::Change, "small"),
        ] {
            conversations
                .record_model_selection(
                    "c",
                    ConversationModelSelectionInput {
                        id: id.to_owned(),
                        kind,
                        provider_id: Some("local".to_owned()),
                        provider_label: None,
                        model_id: Some(model.to_owned()),
                        model_label: None,
                        changed_by: None,
                    },
                )
                .await
                .unwrap();
        }
        let current = conversations
            .list_model_changes("c")
            .await
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(current.kind, ConversationModelChangeKind::Change);

        // A briefing already recorded for the original branch (head m3).
        let original_summary = "original briefing\n";
        let seeded = conversations
            .record_context_handoff(
                "c",
                ConversationContextHandoff {
                    id: "seeded".to_owned(),
                    model_change_id: current.id.clone(),
                    covered_head_id: m3.clone(),
                    summary: Some(original_summary.to_owned()),
                    boundary_at: current.created_at,
                    ..recorded(ContextHandoffOutcome::Applied, None)
                },
            )
            .await
            .unwrap();

        let req = ChatStreamRequest {
            conversation_id: Some("c".to_owned()),
            ..Default::default()
        };
        let replayed = resolve(&state, &req)
            .await
            .expect("original branch replays");
        assert_eq!(replayed.id, seeded.id);
        assert_eq!(replayed.summary.as_deref(), Some(original_summary));

        // Edit m3: its sibling is written after the switch, so the new branch's
        // head before the change is m2. The short history fits the small model,
        // so nothing is carried, but the decision is recorded for that head.
        let edited = conversations
            .edit_user_message("c", &m3, "edited question")
            .await
            .unwrap()
            .expect("m3 is an editable user turn");
        assert_eq!(resolve(&state, &req).await, None);
        let not_needed = conversations
            .get_context_handoff(&current.id, &m2)
            .await
            .unwrap()
            .expect("the edited branch gets its own handoff");
        assert_eq!(not_needed.outcome, ContextHandoffOutcome::NotNeeded);
        assert_eq!(not_needed.summary, None);
        assert_eq!(
            conversations
                .get_context_handoff(&current.id, &edited)
                .await
                .unwrap(),
            None
        );
        let rows = conversations.list_context_handoffs("c").await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_ne!(rows[0].covered_head_id, rows[1].covered_head_id);

        // Switching back replays the original summary byte-for-byte and records
        // nothing new.
        conversations
            .select_version("c", &m3)
            .await
            .unwrap()
            .expect("m3 is a version");
        let switched_back = resolve(&state, &req).await.expect("switch back replays");
        assert_eq!(switched_back.id, seeded.id);
        assert_eq!(
            switched_back.summary.as_deref().map(str::as_bytes),
            Some(original_summary.as_bytes())
        );
        assert_eq!(
            conversations
                .list_context_handoffs("c")
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn marker_rides_behind_the_opening_frame() {
        use futures_util::StreamExt as _;
        let chunks = futures_util::stream::iter(["start", "text"].map(|chunk| {
            Ok::<_, std::convert::Infallible>(axum::body::Bytes::from_static(chunk.as_bytes()))
        }));
        let response = axum::response::Response::new(axum::body::Body::from_stream(chunks));
        let handoff = recorded(ContextHandoffOutcome::Applied, Some("brief"));
        let body = with_marker(response, &handoff)
            .into_body()
            .into_data_stream();
        let frames: Vec<String> = body
            .map(|chunk| String::from_utf8(chunk.unwrap().to_vec()).unwrap())
            .collect()
            .await;
        assert_eq!(frames.len(), 3);
        assert_eq!(frames[0], "start");
        assert!(frames[1].contains("\"type\":\"data-ryu-context-handoff\""));
        assert!(frames[1].contains("\"transient\":true"));
        assert_eq!(frames[2], "text");
    }
}
