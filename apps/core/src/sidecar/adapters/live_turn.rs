//! Live, resumable chat turns.
//!
//! A persisted chat turn must not depend on the HTTP client that started it: the
//! user may reload the window, switch tabs, or navigate away mid-reply. Two
//! pieces make that hold for every chat route (ACP, OpenAI-compatible, local
//! engines, SDK apps, A2A, teams, workflows):
//!
//! * [`durable_turn`] drives a turn's UI message stream on a detached task, so a
//!   dropped client no longer cancels generation or skips persistence. Only an
//!   explicit `POST /api/chat/cancel` ([`request_cancel`]) stops it — or a newer
//!   durable turn for the same conversation, which supersedes it (see
//!   [`register`]). Every client Stop control must therefore call the cancel
//!   endpoint; aborting its own request only stops reading.
//! * Every frame is published to a per-conversation [`LiveTurn`], which keeps a
//!   compacted replay log of the turn so far. [`subscribe`] (behind
//!   `GET /api/chat/stream/resume/:conversation_id`) replays that log and then
//!   forwards live frames, so a reconnecting client rebuilds the whole assistant
//!   message — text, reasoning, tool rows and data parts — not just the text
//!   produced after it reattached.
//!
//! The replay snapshot and the broadcast subscription are taken under the same
//! lock that [`LiveTurn::publish`] holds while it logs and broadcasts a frame, so
//! a subscriber sees every frame exactly once: either in the replay or live.
//!
//! A replay that outgrows [`MAX_REPLAY_BYTES`] degrades to the turn's open parts
//! ([`OpenParts`]); the resume endpoint reports which kind it sent in the
//! [`RESUME_REPLAY_HEADER`] response header so the client never has to guess.

use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};

use axum::body::{Body, Bytes};
use axum::response::Response;
use futures_util::StreamExt;
use serde_json::Value;

/// Live frames buffered per subscriber. A subscriber that falls further behind
/// is disconnected (see [`subscribe`]) and re-attaches with a fresh replay.
const BROADCAST_CAPACITY: usize = 1024;

/// Upper bound on a turn's compacted replay log. Compaction keeps the log close
/// to the size of the rendered message, so this is only reached by pathological
/// tool output; past it, late subscribers get only the parts that are still open
/// (see [`OpenParts`]) and then live frames.
const MAX_REPLAY_BYTES: usize = 16 * 1024 * 1024;

/// Response header on `GET /api/chat/stream/resume/:conversation_id` stating what
/// the replay holds: [`RESUME_REPLAY_FULL`] (the whole turn from its first frame,
/// so the rebuilt message supersedes the persisted one) or [`RESUME_REPLAY_LIVE`]
/// (only the still-open parts of an oversized turn, so the rebuilt message covers
/// what streams after reattaching).
pub const RESUME_REPLAY_HEADER: &str = "x-ryu-resume-replay";
/// [`RESUME_REPLAY_HEADER`] value for a complete replay.
pub const RESUME_REPLAY_FULL: &str = "full";
/// [`RESUME_REPLAY_HEADER`] value for an open-parts-only replay.
pub const RESUME_REPLAY_LIVE: &str = "live";

const SSE_EVENT_SEPARATOR: &[u8] = b"\n\n";
const SSE_DATA_PREFIX: &[u8] = b"data: ";

tokio::task_local! {
    /// The conversation whose turn is being driven by [`durable_turn`] on this
    /// task. Adapters that publish their own live frames (ACP) skip that when the
    /// outer driver already publishes the same frames.
    static DURABLE_SCOPE: String;
}

/// One logged UI message stream event.
enum ReplayEntry {
    /// A parsed `data: {json}` chunk, re-rendered on replay so coalesced deltas
    /// and replaced snapshots serialize as one event. `len` approximates its
    /// rendered size so the log's budget tracks what it actually holds.
    Chunk { chunk: Value, len: usize },
    /// Anything else (`data: [DONE]`, comments), replayed byte-for-byte.
    Raw(Vec<u8>),
}

/// The turn so far, compacted so its size tracks the message rather than the
/// number of frames: consecutive deltas for one part are merged, and a re-emitted
/// snapshot (a Thinking trace re-sent with its whole accumulated text, a data part
/// re-sent under the same id) replaces the earlier one in place.
#[derive(Default)]
struct ReplayLog {
    entries: Vec<ReplayEntry>,
    /// `(chunk type, part id)` → index in `entries` of the entry later frames for
    /// the same part merge into.
    merge_index: HashMap<(String, String), usize>,
    /// Bytes of an event whose terminating blank line has not arrived yet.
    pending: Vec<u8>,
    /// Approximate rendered size of `entries` (excluding `pending`).
    bytes: usize,
    /// Set once the log outgrew [`MAX_REPLAY_BYTES`]: `entries` is dropped and
    /// only `open_parts` is maintained from then on.
    truncated: bool,
    /// The still-open parts, maintained only while `truncated`.
    open_parts: OpenParts,
    /// Dropping the rest of a single event that alone outgrew the budget.
    discarding: bool,
}

/// A part whose later frames a subscriber's reducer can only apply after seeing
/// it open.
#[derive(Clone, PartialEq, Eq)]
enum OpenPart {
    Text(String),
    Reasoning(String),
    Tool(String),
}

/// The skeleton of a turn whose full replay outgrew [`MAX_REPLAY_BYTES`]: the
/// opening chunk of every part that is still open (and the latest input of every
/// tool call still waiting for output), without closed parts or accumulated
/// deltas.
///
/// An empty replay is not a usable fallback: the AI SDK reducer rejects a
/// `text-delta` (or a tool output) for a part it never saw open, so a client
/// attaching mid-part would stop at the first live frame. Replaying the open
/// parts lets every later frame land; only the text produced before reattaching
/// is missing, which is what [`RESUME_REPLAY_LIVE`] tells the client.
#[derive(Default)]
struct OpenParts {
    parts: Vec<(OpenPart, Value)>,
}

impl OpenParts {
    fn push(&mut self, chunk: Value) {
        let field = |name: &str| chunk.get(name).and_then(Value::as_str).map(str::to_owned);
        let kind = field("type").unwrap_or_default();
        let part_id = field("id");
        let tool_call_id = field("toolCallId");
        let preliminary = chunk.get("preliminary").and_then(Value::as_bool) == Some(true);
        match kind.as_str() {
            // Each inner turn of a hook Continue loop opens with its own `start`;
            // the previous inner turn's parts are finished by then.
            "start" => self.parts.clear(),
            "text-start" => {
                if let Some(id) = part_id {
                    self.open(OpenPart::Text(id), chunk);
                }
            }
            "reasoning-start" => {
                if let Some(id) = part_id {
                    self.open(OpenPart::Reasoning(id), chunk);
                }
            }
            // The latest input snapshot replaces the tool's earlier opening chunk.
            "tool-input-start" | "tool-input-available" => {
                if let Some(id) = tool_call_id {
                    self.open(OpenPart::Tool(id), chunk);
                }
            }
            "tool-approval-request" => {
                if let Some(id) = tool_call_id.map(OpenPart::Tool) {
                    if self.parts.iter().any(|(open, _)| *open == id) {
                        self.parts.push((id, chunk));
                    }
                }
            }
            "text-end" => {
                if let Some(id) = part_id {
                    self.close(&OpenPart::Text(id));
                }
            }
            "reasoning-end" => {
                if let Some(id) = part_id {
                    self.close(&OpenPart::Reasoning(id));
                }
            }
            // A preliminary output is followed by more output for the same call.
            "tool-output-available" if preliminary => {}
            "tool-output-available"
            | "tool-output-error"
            | "tool-input-error"
            | "tool-output-denied" => {
                if let Some(id) = tool_call_id {
                    self.close(&OpenPart::Tool(id));
                }
            }
            _ => {}
        }
    }

    fn open(&mut self, part: OpenPart, chunk: Value) {
        self.close(&part);
        self.parts.push((part, chunk));
    }

    fn close(&mut self, part: &OpenPart) {
        self.parts.retain(|(open, _)| open != part);
    }
}

/// How a chunk type folds into an earlier chunk for the same part.
enum Merge {
    /// Append the string field to the earlier chunk's field.
    Append(&'static str),
    /// Replace the earlier chunk, keeping its position.
    Replace,
}

fn merge_rule(chunk: &Value) -> Option<(Merge, String, String)> {
    let kind = chunk.get("type")?.as_str()?;
    let id_of = |field: &str| chunk.get(field).and_then(Value::as_str).map(str::to_owned);
    let (merge, id) = match kind {
        "text-delta" | "reasoning-delta" => (Merge::Append("delta"), id_of("id")?),
        "tool-input-delta" => (Merge::Append("inputTextDelta"), id_of("toolCallId")?),
        "tool-input-available" => (Merge::Replace, id_of("toolCallId")?),
        // A non-transient data part with an id is reconciled by id on the client,
        // so only its latest value matters.
        data if data.starts_with("data-")
            && chunk.get("transient").and_then(Value::as_bool) != Some(true) =>
        {
            (Merge::Replace, id_of("id")?)
        }
        _ => return None,
    };
    Some((merge, kind.to_owned(), id))
}

impl ReplayLog {
    fn push_bytes(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        if self.discarding {
            // The tail of an event too large to keep: skip it through its
            // terminating blank line.
            let Some(end) = find_separator(rest) else {
                return;
            };
            rest = &rest[end + SSE_EVENT_SEPARATOR.len()..];
            self.discarding = false;
        }
        // Fast path — the frame is whole events, as every Core producer emits
        // them: log straight from the borrowed slice, no buffering copy.
        if !self.pending.is_empty() {
            self.pending.extend_from_slice(rest);
            rest = &[];
            let pending = std::mem::take(&mut self.pending);
            let mut cursor = pending.as_slice();
            while let Some(end) = find_separator(cursor) {
                let (event, tail) = cursor.split_at(end + SSE_EVENT_SEPARATOR.len());
                self.push_event(event);
                cursor = tail;
            }
            self.pending = cursor.to_vec();
        }
        while let Some(end) = find_separator(rest) {
            let (event, tail) = rest.split_at(end + SSE_EVENT_SEPARATOR.len());
            self.push_event(event);
            rest = tail;
        }
        self.pending.extend_from_slice(rest);
        if !self.truncated && self.bytes + self.pending.len() > MAX_REPLAY_BYTES {
            self.truncate();
        }
        if self.pending.len() > MAX_REPLAY_BYTES {
            self.pending = Vec::new();
            self.discarding = true;
        }
    }

    /// Drop the full log and keep only the parts that are still open.
    fn truncate(&mut self) {
        self.truncated = true;
        let mut open_parts = OpenParts::default();
        for entry in std::mem::take(&mut self.entries) {
            if let ReplayEntry::Chunk { chunk, .. } = entry {
                open_parts.push(chunk);
            }
        }
        self.open_parts = open_parts;
        self.merge_index = HashMap::new();
        self.bytes = 0;
    }

    /// Log one complete event (including its trailing blank line).
    fn push_event(&mut self, event: &[u8]) {
        let body = &event[..event.len() - SSE_EVENT_SEPARATOR.len()];
        let chunk = body
            .strip_prefix(SSE_DATA_PREFIX)
            .and_then(|json| serde_json::from_slice::<Value>(json).ok())
            .filter(Value::is_object);
        if self.truncated {
            if let Some(chunk) = chunk {
                self.open_parts.push(chunk);
            }
            return;
        }
        let Some(chunk) = chunk else {
            self.bytes += event.len();
            self.entries.push(ReplayEntry::Raw(event.to_vec()));
            return;
        };
        if chunk.get("type").and_then(Value::as_str) == Some("start") {
            // A hook Continue loop streams several inner turns in one response,
            // and each restarts its part ids (ACP `0-0`, OpenAI `0`). Merging
            // across that boundary would fold the next turn's text into the
            // previous turn's part and replay its own `text-start` empty.
            self.merge_index.clear();
        }
        let len = event.len();
        if let Some((merge, kind, id)) = merge_rule(&chunk) {
            let key = (kind, id);
            if let Some(&index) = self.merge_index.get(&key) {
                if let Some(ReplayEntry::Chunk {
                    chunk: existing,
                    len: existing_len,
                }) = self.entries.get_mut(index)
                {
                    match merge {
                        Merge::Append(field) => {
                            let delta = chunk.get(field).and_then(Value::as_str).unwrap_or("");
                            if let Some(Value::String(text)) = existing.get_mut(field) {
                                text.push_str(delta);
                                *existing_len += delta.len();
                                self.bytes += delta.len();
                            }
                        }
                        Merge::Replace => {
                            self.bytes = self.bytes - *existing_len + len;
                            *existing = chunk;
                            *existing_len = len;
                        }
                    }
                    return;
                }
            }
            self.merge_index.insert(key, self.entries.len());
        }
        self.bytes += len;
        self.entries.push(ReplayEntry::Chunk { chunk, len });
    }

    /// The SSE bytes a late subscriber needs to reach the current state: every
    /// logged event (or, once truncated, the open parts), then any partial event
    /// the next live frame completes.
    fn render(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.bytes + self.pending.len());
        if self.truncated {
            for (_, chunk) in &self.open_parts.parts {
                write_chunk(&mut out, chunk);
            }
        } else {
            for entry in &self.entries {
                match entry {
                    ReplayEntry::Chunk { chunk, .. } => write_chunk(&mut out, chunk),
                    ReplayEntry::Raw(raw) => out.extend_from_slice(raw),
                }
            }
        }
        out.extend_from_slice(&self.pending);
        out
    }
}

fn write_chunk(out: &mut Vec<u8>, chunk: &Value) {
    out.extend_from_slice(SSE_DATA_PREFIX);
    // Writing into a Vec cannot fail; the Value is already valid.
    let _ = serde_json::to_writer(&mut *out, chunk);
    out.extend_from_slice(SSE_EVENT_SEPARATOR);
}

fn find_separator(bytes: &[u8]) -> Option<usize> {
    bytes
        .windows(SSE_EVENT_SEPARATOR.len())
        .position(|window| window == SSE_EVENT_SEPARATOR)
}

struct LiveTurnState {
    log: ReplayLog,
    tx: tokio::sync::broadcast::Sender<Bytes>,
}

/// One in-flight turn's live frames.
pub(crate) struct LiveTurn {
    state: Mutex<LiveTurnState>,
    /// Set by [`request_cancel`]. Only turns driven by [`durable_turn`] watch it;
    /// adapters registered directly own their own cancellation.
    cancel: tokio::sync::watch::Sender<bool>,
    cancellable: bool,
}

impl LiveTurn {
    fn new(cancellable: bool) -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(BROADCAST_CAPACITY);
        let (cancel, _) = tokio::sync::watch::channel(false);
        Self {
            state: Mutex::new(LiveTurnState {
                log: ReplayLog::default(),
                tx,
            }),
            cancel,
            cancellable,
        }
    }

    /// Log a frame and forward it to live subscribers, atomically with respect to
    /// [`LiveTurn::attach`].
    ///
    /// Almost every turn has no reattached subscriber, so the frame is copied for
    /// the broadcast only when one exists (and shared between all of them).
    pub(crate) fn publish(&self, frame: &[u8]) {
        if let Ok(mut state) = self.state.lock() {
            state.log.push_bytes(frame);
            if state.tx.receiver_count() > 0 {
                let _ = state.tx.send(Bytes::copy_from_slice(frame));
            }
        }
    }

    /// The replay so far, whether it is complete (`false` once the log was
    /// truncated to its open parts), and a receiver for every frame after it.
    fn attach(&self) -> Option<(Vec<u8>, bool, tokio::sync::broadcast::Receiver<Bytes>)> {
        let state = self.state.lock().ok()?;
        Some((
            state.log.render(),
            !state.log.truncated,
            state.tx.subscribe(),
        ))
    }
}

fn registry() -> &'static Mutex<HashMap<String, Arc<LiveTurn>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<LiveTurn>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Ownership of a conversation's registry slot. Dropping it unregisters the turn
/// — unless a newer turn for the same conversation has replaced it since.
pub(crate) struct LiveTurnHandle {
    conversation_id: String,
    turn: Arc<LiveTurn>,
}

impl std::ops::Deref for LiveTurnHandle {
    type Target = LiveTurn;

    fn deref(&self) -> &LiveTurn {
        &self.turn
    }
}

impl Drop for LiveTurnHandle {
    fn drop(&mut self) {
        if let Ok(mut turns) = registry().lock() {
            if turns
                .get(&self.conversation_id)
                .is_some_and(|current| Arc::ptr_eq(current, &self.turn))
            {
                turns.remove(&self.conversation_id);
            }
        }
    }
}

/// Register the live turn for a conversation, replacing any earlier one.
///
/// A new durable turn supersedes an earlier durable turn for the same
/// conversation (a re-send right after Stop, a second window): the earlier
/// driver is stopped. Left running, it would keep generating and persisting into
/// the same conversation with no registry entry left for [`request_cancel`] to
/// reach.
pub(crate) fn register(conversation_id: &str, cancellable: bool) -> LiveTurnHandle {
    let turn = Arc::new(LiveTurn::new(cancellable));
    let superseded = registry()
        .lock()
        .ok()
        .and_then(|mut turns| turns.insert(conversation_id.to_owned(), Arc::clone(&turn)));
    if let Some(previous) = superseded.filter(|previous| cancellable && previous.cancellable) {
        previous.cancel.send_replace(true);
    }
    LiveTurnHandle {
        conversation_id: conversation_id.to_owned(),
        turn,
    }
}

fn get(conversation_id: &str) -> Option<Arc<LiveTurn>> {
    registry()
        .lock()
        .ok()
        .and_then(|turns| turns.get(conversation_id).cloned())
}

/// How many conversations have a turn running right now. A dev Core restart
/// waits for this to reach zero before replacing the execution host.
pub(crate) fn running_turns() -> usize {
    registry().lock().map(|turns| turns.len()).unwrap_or(0)
}

/// Whether the current task is inside [`durable_turn`] for this conversation.
pub(crate) fn in_durable_scope(conversation_id: &str) -> bool {
    DURABLE_SCOPE
        .try_with(|scoped| scoped == conversation_id)
        .unwrap_or(false)
}

/// A late subscriber's view of a running turn.
pub struct LiveSubscription<S> {
    /// `true` when the replay starts at the turn's first frame, so the message it
    /// rebuilds supersedes the persisted one; `false` when the turn outgrew the
    /// replay budget and the replay holds only its still-open parts. Sent to the
    /// client as [`RESUME_REPLAY_HEADER`].
    pub replay_complete: bool,
    /// The replay, then every live frame until the turn ends.
    pub frames: S,
}

/// Replay a running turn and then follow it live. `None` when no turn is
/// running for the conversation.
///
/// A subscriber that lags past [`BROADCAST_CAPACITY`] is ended rather than fed a
/// stream with a hole in it; the client reattaches and gets a fresh replay.
pub fn subscribe(
    conversation_id: &str,
) -> Option<LiveSubscription<impl futures_util::Stream<Item = Result<Bytes, Infallible>>>> {
    let (replay, replay_complete, mut rx) = get(conversation_id)?.attach()?;
    Some(LiveSubscription {
        replay_complete,
        frames: async_stream::stream! {
            if !replay.is_empty() {
                yield Ok(Bytes::from(replay));
            }
            while let Ok(frame) = rx.recv().await {
                yield Ok(frame);
            }
        },
    })
}

/// Stop a turn driven by [`durable_turn`]. `false` when the conversation has no
/// such turn running.
pub(crate) fn request_cancel(conversation_id: &str) -> bool {
    match get(conversation_id) {
        Some(turn) if turn.cancellable => {
            turn.cancel.send_replace(true);
            true
        }
        _ => false,
    }
}

/// Whether the conversation has a turn driven by [`durable_turn`] running, i.e.
/// one [`request_cancel`] would stop.
pub(crate) fn is_cancellable(conversation_id: &str) -> bool {
    get(conversation_id).is_some_and(|turn| turn.cancellable)
}

/// Whether Stop was requested for the conversation's durable turn. Multi-turn
/// producers (the plugin hook Continue loop) check it before starting another
/// inner turn.
pub(crate) fn cancel_requested(conversation_id: &str) -> bool {
    get(conversation_id).is_some_and(|turn| turn.cancellable && *turn.cancel.borrow())
}

async fn cancelled(rx: &mut tokio::sync::watch::Receiver<bool>) {
    while !*rx.borrow_and_update() {
        if rx.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

fn is_event_stream(response: &Response) -> bool {
    response
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"))
}

/// Run a persisted chat turn independently of the client that requested it.
///
/// `conversation_id` is `None` for turns that are not persisted; those keep the
/// connection-bound behaviour (nothing could be resumed or recovered anyway).
/// Nested calls for the same conversation pass straight through, so wrapping at
/// several entry points never double-drives a turn.
pub async fn durable_turn<F>(conversation_id: Option<String>, turn: F) -> Response
where
    F: Future<Output = Response>,
{
    let Some(conversation_id) = conversation_id.filter(|id| !id.trim().is_empty()) else {
        return turn.await;
    };
    if in_durable_scope(&conversation_id) {
        return turn.await;
    }
    let handle = register(&conversation_id, true);
    let response = DURABLE_SCOPE.scope(conversation_id.clone(), turn).await;
    if !is_event_stream(&response) {
        // An admission/ACL error answered before any stream existed.
        return response;
    }
    let (parts, body) = response.into_parts();
    let (client_tx, mut client_rx) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    let mut cancel = handle.cancel.subscribe();
    tokio::spawn(DURABLE_SCOPE.scope(conversation_id, async move {
        let mut source = body.into_data_stream();
        loop {
            tokio::select! {
                biased;
                () = cancelled(&mut cancel) => {
                    // Dropping `source` (below) cancels the upstream request.
                    for frame in [super::ui_finish(), super::done_sse_frame()] {
                        handle.publish(&frame);
                        let _ = client_tx.send(Bytes::from(frame));
                    }
                    break;
                }
                next = source.next() => match next {
                    Some(Ok(bytes)) => {
                        handle.publish(&bytes);
                        // A disconnected client is fine: the turn keeps running.
                        // `Bytes` is refcounted, so forwarding copies nothing.
                        let _ = client_tx.send(bytes);
                    }
                    Some(Err(error)) => {
                        tracing::warn!("durable chat turn stream failed: {error}");
                        break;
                    }
                    None => break,
                }
            }
        }
        drop(source);
        drop(handle);
    }));
    let forwarded = async_stream::stream! {
        while let Some(frame) = client_rx.recv().await {
            yield Ok::<_, Infallible>(frame);
        }
    };
    Response::from_parts(parts, Body::from_stream(forwarded))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(chunk: &Value) -> Vec<u8> {
        format!("data: {chunk}\n\n").into_bytes()
    }

    fn replay_chunks(log: &ReplayLog) -> Vec<Value> {
        String::from_utf8(log.render())
            .unwrap()
            .split("\n\n")
            .filter_map(|event| event.strip_prefix("data: "))
            .filter_map(|json| serde_json::from_str(json).ok())
            .collect()
    }

    #[test]
    fn text_deltas_coalesce_per_part() {
        let mut log = ReplayLog::default();
        log.push_bytes(&frame(&json!({ "type": "start" })));
        log.push_bytes(&frame(&json!({ "type": "text-start", "id": "0-0" })));
        log.push_bytes(&frame(
            &json!({ "type": "text-delta", "id": "0-0", "delta": "Hel" }),
        ));
        log.push_bytes(&frame(
            &json!({ "type": "text-delta", "id": "0-0", "delta": "lo" }),
        ));
        assert_eq!(
            replay_chunks(&log),
            vec![
                json!({ "type": "start" }),
                json!({ "type": "text-start", "id": "0-0" }),
                json!({ "type": "text-delta", "id": "0-0", "delta": "Hello" }),
            ]
        );
    }

    #[test]
    fn tool_input_snapshots_replace_in_place() {
        let mut log = ReplayLog::default();
        let thought = |text: &str| {
            json!({
                "type": "tool-input-available",
                "toolCallId": "acp-thought-0",
                "toolName": "Thinking",
                "input": { "thought": text },
            })
        };
        log.push_bytes(&frame(&thought("a")));
        log.push_bytes(&frame(&json!({ "type": "text-start", "id": "0-0" })));
        log.push_bytes(&frame(&thought("ab")));
        assert_eq!(
            replay_chunks(&log),
            vec![thought("ab"), json!({ "type": "text-start", "id": "0-0" })]
        );
    }

    #[test]
    fn replaced_snapshots_do_not_inflate_the_budget() {
        // A long Thinking trace re-sends its whole text under one id. Counting
        // every snapshot (not just the live one) would trip the replay cap and
        // drop the replay for exactly the turns that need it most.
        let mut log = ReplayLog::default();
        let mut thought = String::new();
        for _ in 0..1000 {
            thought.push_str("twenty bytes of text");
            log.push_bytes(&frame(&json!({
                "type": "tool-input-available",
                "toolCallId": "acp-thought-0",
                "toolName": "Thinking",
                "input": { "thought": thought },
            })));
        }
        assert!(!log.truncated);
        assert!(
            log.bytes < 2 * thought.len(),
            "budget {} tracks one snapshot",
            log.bytes
        );
        assert_eq!(replay_chunks(&log).len(), 1);
    }

    #[test]
    fn split_and_batched_frames_parse_and_partial_event_is_replayed_raw() {
        let mut log = ReplayLog::default();
        let mut batch = frame(&json!({ "type": "start" }));
        batch.extend(frame(&json!({ "type": "text-start", "id": "t" })));
        let tail = frame(&json!({ "type": "text-delta", "id": "t", "delta": "x" }));
        batch.extend_from_slice(&tail[..10]);
        log.push_bytes(&batch);
        let rendered = log.render();
        assert!(rendered.ends_with(&tail[..10]));
        log.push_bytes(&tail[10..]);
        assert_eq!(replay_chunks(&log).len(), 3);
    }

    #[test]
    fn done_line_and_transient_data_are_kept_verbatim() {
        let mut log = ReplayLog::default();
        let transient = json!({ "type": "data-note", "id": "n", "data": 1, "transient": true });
        log.push_bytes(&frame(&transient));
        log.push_bytes(&frame(&transient));
        log.push_bytes(b"data: [DONE]\n\n");
        let rendered = String::from_utf8(log.render()).unwrap();
        assert_eq!(rendered.matches("data-note").count(), 2);
        assert!(rendered.ends_with("data: [DONE]\n\n"));
    }

    #[tokio::test]
    async fn subscriber_gets_replay_then_live_frames_exactly_once() {
        let conversation_id = format!("live-turn-test-{}", uuid::Uuid::new_v4());
        let handle = register(&conversation_id, false);
        handle.publish(&frame(&json!({ "type": "text-start", "id": "t" })));
        handle.publish(&frame(
            &json!({ "type": "text-delta", "id": "t", "delta": "a" }),
        ));
        let subscription = subscribe(&conversation_id).expect("turn is live");
        assert!(subscription.replay_complete);
        handle.publish(&frame(
            &json!({ "type": "text-delta", "id": "t", "delta": "b" }),
        ));
        drop(handle);
        let received: Vec<u8> = subscription
            .frames
            .map(|frame| frame.unwrap().to_vec())
            .collect::<Vec<_>>()
            .await
            .concat();
        let text = String::from_utf8(received).unwrap();
        assert_eq!(text.matches("\"delta\":\"a\"").count(), 1);
        assert_eq!(text.matches("\"delta\":\"b\"").count(), 1);
        assert!(subscribe(&conversation_id).is_none());
    }

    #[tokio::test]
    async fn stale_handle_does_not_unregister_newer_turn() {
        let conversation_id = format!("live-turn-test-{}", uuid::Uuid::new_v4());
        let first = register(&conversation_id, false);
        let second = register(&conversation_id, true);
        drop(first);
        assert!(!cancel_requested(&conversation_id));
        assert!(request_cancel(&conversation_id));
        assert!(cancel_requested(&conversation_id));
        drop(second);
        assert!(!request_cancel(&conversation_id));
    }

    #[tokio::test]
    async fn newer_durable_turn_stops_the_turn_it_supersedes() {
        // Stop followed by an immediate re-send: the first driver must not keep
        // generating into the conversation once the second one owns the slot.
        let conversation_id = format!("live-turn-test-{}", uuid::Uuid::new_v4());
        let first = register(&conversation_id, true);
        let second = register(&conversation_id, true);
        assert!(*first.cancel.borrow(), "superseded durable turn is stopped");
        assert!(!*second.cancel.borrow());
        assert!(is_cancellable(&conversation_id));
        drop(first);
        assert!(
            request_cancel(&conversation_id),
            "newer turn stays reachable"
        );
        assert!(*second.cancel.borrow());
        drop(second);
        assert!(!is_cancellable(&conversation_id));
    }

    #[test]
    fn each_inner_turn_replays_its_own_parts_when_ids_repeat() {
        // A hook Continue loop streams two inner turns in one response; both
        // number their first text part `0-0`.
        let mut log = ReplayLog::default();
        for text in ["first", "second"] {
            log.push_bytes(&frame(&json!({ "type": "start" })));
            log.push_bytes(&frame(&json!({ "type": "text-start", "id": "0-0" })));
            log.push_bytes(&frame(
                &json!({ "type": "text-delta", "id": "0-0", "delta": text }),
            ));
            log.push_bytes(&frame(&json!({ "type": "text-end", "id": "0-0" })));
            log.push_bytes(&frame(&json!({ "type": "finish" })));
        }
        let deltas: Vec<Value> = replay_chunks(&log)
            .into_iter()
            .filter(|chunk| chunk["type"] == "text-delta")
            .map(|chunk| chunk["delta"].clone())
            .collect();
        assert_eq!(deltas, vec![json!("first"), json!("second")]);
        assert_eq!(replay_chunks(&log).len(), 10);
    }

    #[test]
    fn oversized_replay_keeps_the_open_parts_live_frames_need() {
        let mut log = ReplayLog::default();
        log.push_bytes(&frame(&json!({ "type": "start" })));
        log.push_bytes(&frame(&json!({ "type": "text-start", "id": "done" })));
        log.push_bytes(&frame(&json!({ "type": "text-end", "id": "done" })));
        log.push_bytes(&frame(&json!({ "type": "text-start", "id": "open" })));
        log.push_bytes(&frame(
            &json!({ "type": "text-delta", "id": "open", "delta": "before" }),
        ));
        log.push_bytes(&frame(&json!({
            "type": "tool-input-available",
            "toolCallId": "pending",
            "toolName": "Bash",
            "input": { "command": "ls" },
        })));
        // A finished tool whose output alone outgrows the replay budget.
        log.push_bytes(&frame(&json!({
            "type": "tool-input-available",
            "toolCallId": "huge",
            "toolName": "Read",
            "input": {},
        })));
        log.push_bytes(&frame(&json!({
            "type": "tool-output-available",
            "toolCallId": "huge",
            "output": "x".repeat(MAX_REPLAY_BYTES),
        })));
        assert!(log.truncated);
        assert_eq!(
            replay_chunks(&log),
            vec![
                json!({ "type": "text-start", "id": "open" }),
                json!({
                    "type": "tool-input-available",
                    "toolCallId": "pending",
                    "toolName": "Bash",
                    "input": { "command": "ls" },
                }),
            ],
            "only parts later frames can still reference are replayed"
        );
        // Parts keep opening and closing after truncation.
        log.push_bytes(&frame(
            &json!({ "type": "text-delta", "id": "open", "delta": "after" }),
        ));
        log.push_bytes(&frame(&json!({ "type": "text-end", "id": "open" })));
        log.push_bytes(&frame(&json!({
            "type": "tool-output-available",
            "toolCallId": "pending",
            "output": "ok",
        })));
        log.push_bytes(&frame(&json!({ "type": "reasoning-start", "id": "r" })));
        assert_eq!(
            replay_chunks(&log),
            vec![json!({ "type": "reasoning-start", "id": "r" })]
        );
        assert!(log.bytes < 1024, "budget no longer holds the closed parts");
    }

    #[test]
    fn an_unterminated_oversized_event_is_skipped_not_buffered() {
        let mut log = ReplayLog::default();
        let mut giant = b"data: ".to_vec();
        giant.resize(MAX_REPLAY_BYTES + 16, b'x');
        log.push_bytes(&giant);
        assert!(log.truncated);
        assert!(log.pending.is_empty());
        let mut tail = b"xxxx\n\n".to_vec();
        tail.extend(frame(&json!({ "type": "text-start", "id": "next" })));
        log.push_bytes(&tail);
        assert_eq!(
            replay_chunks(&log),
            vec![json!({ "type": "text-start", "id": "next" })]
        );
    }

    #[tokio::test]
    async fn durable_turn_survives_client_disconnect() {
        let conversation_id = format!("live-turn-test-{}", uuid::Uuid::new_v4());
        let (source_tx, mut source_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let source = async_stream::stream! {
            while let Some(frame) = source_rx.recv().await {
                yield Ok::<_, Infallible>(frame);
            }
        };
        let response = durable_turn(Some(conversation_id.clone()), async move {
            super::super::sse_response(Body::from_stream(source))
        })
        .await;
        drop(response);
        source_tx
            .send(frame(&json!({ "type": "text-start", "id": "t" })))
            .unwrap();
        source_tx
            .send(frame(
                &json!({ "type": "text-delta", "id": "t", "delta": "kept" }),
            ))
            .unwrap();
        // The driver task publishes asynchronously; wait until the frames landed.
        let logged = |id: &str| {
            get(id)
                .and_then(|turn| turn.attach())
                .map(|(replay, _, _)| String::from_utf8(replay).unwrap())
                .unwrap_or_default()
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !logged(&conversation_id).contains("kept") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("frames published after the client disconnected");
        let late = subscribe(&conversation_id).expect("turn still live");
        assert!(request_cancel(&conversation_id));
        drop(source_tx);
        let tail: Vec<u8> = late
            .frames
            .map(|frame| frame.unwrap().to_vec())
            .collect::<Vec<_>>()
            .await
            .concat();
        assert!(String::from_utf8(tail).unwrap().contains("[DONE]"));
    }
}
