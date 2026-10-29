use super::*;

// Debounce: only flush to DB every N bytes of new text to avoid
// excessive writes on fast token streams. Each flush re-seals and rewrites
// the WHOLE reply so far under the store mutex, so the total cost is
// quadratic in reply length: at 512 bytes a 100 KB answer took ~200
// full rewrites. The 2 s interval below already bounds crash loss by
// time, so this threshold only caps unflushed text on a very fast stream.
pub(crate) const INCREMENTAL_FLUSH_BYTES: usize = 16 * 1024;
// Wall-clock companion to the byte threshold. The byte counter only ever
// advances on `AcpEvent::Text`, so a turn whose tail is tool calls — or one
// that streams slowly — could sit unflushed indefinitely, and the sealed
// `parts` column was written at the two TERMINAL points only. A process
// killed before either (crash / force-quit / OOM) therefore left the row at
// the last byte-threshold boundary with `parts` NULL, which is why tool rows and
// reasoning vanished entirely from those turns. This timer bounds both
// losses to one interval; `parts` is a whole-array overwrite, so writing it
// repeatedly is idempotent.
pub(crate) const INCREMENTAL_FLUSH_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(2);
pub(crate) const TEXT_ID: &str = "0";
pub(crate) const THOUGHT_ID: &str = "acp-thought";
pub(crate) const PLAN_TOOL_ID: &str = "acp-plan";
pub(crate) const THOUGHT_EMIT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

/// Mutable per-turn state of the ACP completion task (render parts, open rows, usage).
pub(crate) struct AcpTurnState {
    pub(crate) reply: String,
    pub(crate) acc: PartsAccumulator,
    pub(crate) persisted_msg_id: Option<String>,
    pub(crate) bytes_since_flush: usize,
    pub(crate) last_flush: std::time::Instant,
    pub(crate) text_open: bool,
    pub(crate) text_seq: u32,
    pub(crate) thought_acc: String,
    pub(crate) thought_seq: u32,
    pub(crate) thought_open: bool,
    pub(crate) thought_emitted_len: usize,
    pub(crate) thought_emitted_at: Option<std::time::Instant>,
    pub(crate) plan_open: bool,
    pub(crate) tool_dynamic: std::collections::HashMap<String, bool>,
    pub(crate) tool_clock: ToolClock,
    pub(crate) tool_open: std::collections::HashMap<String, OpenToolCall>,
    pub(crate) steps_opened: std::collections::HashMap<String, (String, Value)>,
    pub(crate) steps_closed: std::collections::HashSet<String>,
    pub(crate) open_spans: std::collections::HashMap<String, String>,
    pub(crate) turn_start: std::time::Instant,
    pub(crate) first_response_at: Option<std::time::Instant>,
    pub(crate) tool_pauses: ToolPauseClock,
    pub(crate) usage_used: Option<u64>,
    pub(crate) usage_model: Option<String>,
    pub(crate) usage_total: Option<u64>,
    pub(crate) usage_prompt: Option<u64>,
    pub(crate) usage_completion: Option<u64>,
    pub(crate) usage_total_tokens: Option<u64>,
    pub(crate) usage_thought: Option<u64>,
    pub(crate) usage_cached_read: Option<u64>,
    pub(crate) usage_cached_write: Option<u64>,
    pub(crate) usage_session_total: Option<u64>,
    pub(crate) usage_cost: Option<(f64, String)>,
}

impl AcpTurnState {
    /// Fresh turn state; also discards a usage report left over from an unfinished turn.
    pub(crate) fn new(conversation_id: &Option<String>, agent_id: &str) -> Self {
        let reply = String::new();
        // Structured render parts, built in lockstep with the emitted UI frames so
        // the exact tool/text/file parts survive a reload (cowork context + tool
        // rows), not just the flat `reply` text. Persisted once at turn end.
        let acc = PartsAccumulator::default();
        // Incremental persistence: instead of a FnOnce that fires at the end,
        // we create the assistant message row on the first text chunk and
        // periodically update it as more text arrives. This way the reply
        // survives in the DB even if the user navigates away mid-stream.
        let persisted_msg_id: Option<String> = None;
        let bytes_since_flush: usize = 0;
        let last_flush = std::time::Instant::now();
        let text_open = false;
        let text_seq = 0u32;
        // Reasoning (thinking) state: accumulated content of the open Thinking
        // part. Each chunk re-emits `tool-input-available` under the same id —
        // the AI SDK updates the existing part in place, so the desktop's
        // Thinking card grows live and closes when the agent moves on.
        //
        // Each snapshot carries the WHOLE thought so far, so emitting one per
        // provider delta made a long thought quadratic everywhere downstream:
        // serialization here, the SSE wire, the live-turn replay log, and the
        // client's parse + per-chunk message snapshot. Snapshots are therefore
        // coalesced to at most one per `THOUGHT_EMIT_INTERVAL` (the first delta
        // still shows immediately), and `close_thought` flushes the final text
        // before the part closes, so nothing is lost — only intermediate frames.
        let thought_acc = String::new();
        let thought_seq = 0u32;
        let thought_open = false;
        // Length of `thought_acc` already emitted, and when it was.
        let thought_emitted_len = 0usize;
        let thought_emitted_at: Option<std::time::Instant> = None;
        // True once a plan snapshot opened the TodoWrite part (closed at turn end).
        let plan_open = false;
        // toolCallId -> `dynamic` flag of the opening frame, so the closing
        // tool-output frame matches its part type.
        let tool_dynamic: std::collections::HashMap<String, bool> =
            std::collections::HashMap::new();
        // toolCallId -> when the call opened, so its closing frame can carry a
        // real duration. Covers every tool row this turn emits, nested sub-steps
        // and the synthetic Thinking/plan parts included.
        let tool_clock = ToolClock::default();
        // toolCallId -> the opening `tool-input-available` frame, so an update
        // that carries arguments the opening frame did not have can correct it
        // in place. Kept until the call reaches a terminal status; separate from
        // `tool_dynamic` because that one is consumed by the FIRST update.
        let tool_open: std::collections::HashMap<String, OpenToolCall> =
            std::collections::HashMap::new();
        // Nested sub-step fan-out (`AcpEvent::ToolSteps`), keyed by synthetic child
        // part id (`<parent>:<n>`). The producer re-sends the WHOLE `ryuSteps` array
        // on every tool update, so both of these exist to make the fan-out idempotent
        // — but they are NOT the same kind of guard:
        //
        // - `steps_opened` remembers the `(tool_name, input)` last emitted for a
        //   child, and the opening frame is re-emitted whenever that pair CHANGES. A
        //   one-shot "seen this id" set would be wrong: a step can first appear with
        //   an empty or partial `input` (the ACP wire does exactly this — the first
        //   `tool_call` carries `rawInput: {}` and later updates fill it) and the row
        //   would then be pinned to empty arguments forever. Re-emitting on change is
        //   safe at both layers: the SSE part reconciles by `toolCallId` and
        //   `PartsAccumulator::tool_input` updates a known id in place.
        // - `steps_closed` is a CORRECTNESS gate, not noise control: a child's output
        //   frame CLOSES its row, so it may go out only once, and only once that step
        //   reached a terminal status.
        let steps_opened: std::collections::HashMap<String, (String, Value)> =
            std::collections::HashMap::new();
        let steps_closed: std::collections::HashSet<String> = std::collections::HashSet::new();
        // Maps ACP tool call id -> trace span id so we can close the span on ToolResult.
        let open_spans: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        // Turn stopwatch + running usage accumulator for the `data-acp-usage` stats
        // frame. `turn_start` measures wall-clock so the desktop's duration/speed UI
        // works even when the ACP agent reports no token usage. The `usage_*` fields
        // hold the latest values Core has seen (from streamed `UsageUpdate` frames
        // and/or the turn-end `PromptResponse.usage`), re-emitted under the stable
        // `acp-usage` id so the AI SDK reconciles repeated frames into one live meter.
        let turn_start = std::time::Instant::now();
        // A report left over from a turn that never reached its usage frame
        // (cancelled, errored) must not be counted into this one.
        if let Some(conversation) = conversation_id.as_deref() {
            let _ = acp::take_reported_usage(conversation, &agent_id);
        }
        // First-response clock: stamped by the first non-empty agent chunk of the
        // turn, whether that is reply text or a reasoning chunk. ONE clock, not two:
        // for a reasoning agent the thought IS the first thing the user sees, so
        // measuring only to the first reply text would report several seconds of
        // "nothing" that were visibly not nothing. Note this is not comparable to
        // the local engine's `ttftMs` — on a session's first turn it includes
        // process spawn and `session/new`, which is why the UI labels it
        // "First response", not "First token".
        let first_response_at: Option<std::time::Instant> = None;
        let tool_pauses = ToolPauseClock::default();
        let usage_used: Option<u64> = None;
        let usage_model: Option<String> = None;
        let usage_total: Option<u64> = None;
        let usage_prompt: Option<u64> = None;
        let usage_completion: Option<u64> = None;
        let usage_total_tokens: Option<u64> = None;
        let usage_thought: Option<u64> = None;
        let usage_cached_read: Option<u64> = None;
        let usage_cached_write: Option<u64> = None;
        let usage_session_total: Option<u64> = None;
        let usage_cost: Option<(f64, String)> = None;
        Self {
            reply,
            acc,
            persisted_msg_id,
            bytes_since_flush,
            last_flush,
            text_open,
            text_seq,
            thought_acc,
            thought_seq,
            thought_open,
            thought_emitted_len,
            thought_emitted_at,
            plan_open,
            tool_dynamic,
            tool_clock,
            tool_open,
            steps_opened,
            steps_closed,
            open_spans,
            turn_start,
            first_response_at,
            tool_pauses,
            usage_used,
            usage_model,
            usage_total,
            usage_prompt,
            usage_completion,
            usage_total_tokens,
            usage_thought,
            usage_cached_read,
            usage_cached_write,
            usage_session_total,
            usage_cost,
        }
    }

    /// The opening frames: start, memory citations, applied agent control, compaction.
    pub(crate) fn prologue(
        &mut self,
        em: &AcpEmitter,
        memory_citations: &[MemoryCitation],
        agent_control_applied: &Option<crate::agent_control::AgentControlApplied>,
        compaction_summary: Option<String>,
    ) {
        em.emit(ui_start());
        if !memory_citations.is_empty() {
            em.emit(ui_memory_citations(&memory_citations));
            self.acc.data(
                "ryu-memory-citations",
                &memory_citations_payload(&memory_citations),
            );
        }
        if let Some(control) = agent_control_applied.as_ref() {
            let data = serde_json::to_value(control).unwrap_or(Value::Null);
            em.emit(ui_data("ryu-agent-control", &data));
            self.acc.data("ryu-agent-control", &data);
        }

        // ACP context replay may compact older turns into an explicit summary.
        // Make that boundary visible in the transcript as well as the Context
        // panel; the summary itself remains private prompt material.
        if let Some(summary) = compaction_summary {
            em.emit(ui_data(
                "ryu-acp-compaction",
                &serde_json::json!({ "summary": summary.trim(), "trigger": "auto" }),
            ));
        }
    }

    // Close-out frames for the open Thinking part (methods so the loop arms
    // and both exit paths share it without fighting the borrow checker).
    // Emit the pending Thinking snapshot, if the thought grew since the last.
    pub(crate) fn flush_thought(&mut self, em: &AcpEmitter) {
        if self.thought_open && self.thought_acc.len() != self.thought_emitted_len {
            let tid = format!("{THOUGHT_ID}-{}", self.thought_seq);
            let thought_input = serde_json::json!({ "thought": self.thought_acc });
            let started = self.tool_clock.start(&tid);
            em.emit(ui_tool_input(
                &tid,
                "Thinking",
                &thought_input,
                false,
                Some(started),
            ));
            self.acc
                .tool_input(&tid, "Thinking", &thought_input, false, Some(started));
            self.thought_emitted_len = self.thought_acc.len();
            self.thought_emitted_at = Some(std::time::Instant::now());
        }
    }

    /// Flush, then close the open Thinking part.
    pub(crate) fn close_thought(&mut self, em: &AcpEmitter) {
        self.flush_thought(em);
        if self.thought_open {
            let tid = format!("{THOUGHT_ID}-{}", self.thought_seq);
            let done = serde_json::json!({ "done": true });
            let timing = self.tool_clock.finish(&tid);
            em.emit(ui_tool_output(&tid, &done, false, timing));
            self.acc.tool_output(&tid, &done, false, timing);
            self.thought_open = false;
            self.thought_acc.clear();
            self.thought_emitted_len = 0;
            self.thought_emitted_at = None;
            self.thought_seq += 1;
        }
    }

    /// Close the open text part.
    pub(crate) fn close_text(&mut self, em: &AcpEmitter) {
        if self.text_open {
            let tid = format!("{TEXT_ID}-{}", self.text_seq);
            em.emit(ui_text_end(&tid));
            self.text_open = false;
            self.text_seq += 1;
        }
    }

    // Periodic durability checkpoint: re-seal the reply text AND the structured
    // parts built so far, at most once per `INCREMENTAL_FLUSH_INTERVAL`. This is
    // what a crashed turn is recovered from — the terminal writes below only run
    // when the loop reaches an exit, and a killed process never does.
    //
    // Invoked at the TOP of the loop body rather than at the bottom because
    // several arms `continue`; running one event late is harmless (it persists
    // whatever has accumulated), running never is not.
    pub(crate) async fn checkpoint_persist(&mut self, em: &AcpEmitter, refs: AcpTurnRefs<'_>) {
        let AcpTurnRefs {
            persist_store,
            persist_conversation_id,
            persist_agent_id,
            ..
        } = refs;
        if self.last_flush.elapsed() >= INCREMENTAL_FLUSH_INTERVAL {
            self.last_flush = std::time::Instant::now();
            // Checkpoint the newest thought, not the last coalesced one.
            self.flush_thought(em);
            if let Some(ref conv_id) = persist_conversation_id {
                if self.persisted_msg_id.is_none() {
                    // Create the row so the parts below have somewhere to
                    // go. Gated on TEXT, not on `acc`: a turn that has only
                    // run tools so far can still be retried on another plan
                    // (`watch.retryable()`), and a row created here would
                    // outlive that retry as a phantom assistant turn. Once
                    // any text has been emitted `watch.mark_content()` has
                    // already taken retry off the table, which is the same
                    // line the first-chunk path below draws.
                    if !self.reply.is_empty() {
                        match persist_store
                            .append_message_as(
                                conv_id,
                                "assistant",
                                &self.reply,
                                persist_agent_id.as_deref(),
                                None,
                                None,
                                Tenancy::Unattributed, // row exists (stamped by chat_stream)
                            )
                            .await
                        {
                            Ok(mid) => {
                                self.persisted_msg_id = Some(mid);
                                self.bytes_since_flush = 0;
                            }
                            Err(e) => tracing::warn!(
                                "failed to create checkpoint assistant message: {e:#}"
                            ),
                        }
                    }
                } else if self.bytes_since_flush > 0 {
                    if let Some(ref mid) = self.persisted_msg_id {
                        if let Err(e) = persist_store.update_message_content(mid, &self.reply).await
                        {
                            tracing::warn!("failed to checkpoint reply text: {e:#}");
                        }
                        self.bytes_since_flush = 0;
                    }
                }
                if let Some(ref mid) = self.persisted_msg_id {
                    if !self.acc.is_empty() {
                        if let Err(e) = persist_store
                            .update_message_parts(mid, &self.acc.to_json())
                            .await
                        {
                            tracing::warn!("failed to checkpoint message parts: {e:#}");
                        }
                    }
                }
            }
        }
    }
}
