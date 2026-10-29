use super::*;

impl AcpTurnState {
    /// A tool call opened: trace span, open-call record, and the opening frame.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn on_tool_call(
        &mut self,
        em: &AcpEmitter,
        refs: AcpTurnRefs<'_>,
        id: String,
        title: String,
        kind: String,
        input: Option<Value>,
        locations: Vec<Value>,
    ) {
        let AcpTurnRefs {
            conversation_id,
            agent_id,
            watch,
            traces,
            ..
        } = refs;
        self.tool_pauses
            .tool_started(&id, std::time::Instant::now());
        acp::record_observed_tool(&agent_id, &title, &kind);
        // A tool call has side effects. Retrying the turn on another
        // plan would run it a second time, so this counts as content
        // even though nothing has been written to the transcript yet.
        watch.mark_content();
        self.close_thought(em);
        self.close_text(em);
        let input_value = input.unwrap_or(Value::Null);
        let (tool_name, dynamic, emit_input) =
            acp_tool_frame(&kind, &title, &input_value, &locations);
        let mut emit_input = emit_input;
        if tool_name == "Question" {
            // Keep the stable ACP id in the normalized Question
            // payload as well as on the enclosing AI-SDK frame. TUI
            // and reconnecting clients can therefore answer without
            // depending on a separate, lossy tool-row callback.
            if let Value::Object(ref mut map) = emit_input {
                map.insert("toolCallId".to_owned(), Value::String(id.clone()));
            }
        }
        self.tool_dynamic.insert(id.clone(), dynamic);
        // Remembered so a later update that fills in the call's
        // arguments can correct THIS frame rather than mint a new
        // part. The opening frame is frequently argument-free: an ACP
        // agent may open the call while the model is still streaming
        // them (pi-acp sends `rawInput: {}` and fills it in later),
        // and every rich renderer reads `part.input`.
        self.tool_open.insert(
            id.clone(),
            OpenToolCall {
                kind: kind.clone(),
                title: title.clone(),
                locations: locations.clone(),
                name: tool_name.clone(),
                dynamic,
                input: input_value.clone(),
            },
        );
        // Open a tool-call span in the trace store (no-op when no conv id).
        if let Some(ref conv_id) = conversation_id {
            let ah = hash_args(&input_value);
            match traces
                .open_span(conv_id, "tool-call", &tool_name, Some(&ah), None)
                .await
            {
                Ok(span_id) => {
                    self.open_spans.insert(id.clone(), span_id);
                }
                Err(e) => tracing::warn!("trace open_span failed: {e:#}"),
            }
        }
        let started = self.tool_clock.start(&id);
        em.emit(ui_tool_input(
            &id,
            &tool_name,
            &emit_input,
            dynamic,
            Some(started),
        ));
        self.acc
            .tool_input(&id, &tool_name, &input_value, dynamic, Some(started));
    }

    /// A tool update: late arguments, terminal status, span close, and the output frame.
    pub(crate) async fn on_tool_result(
        &mut self,
        em: &AcpEmitter,
        refs: AcpTurnRefs<'_>,
        id: String,
        status: String,
        output: Option<Value>,
        input: Option<Value>,
    ) {
        let traces = refs.traces;
        self.tool_pauses
            .tool_updated(&id, &status, std::time::Instant::now());
        self.close_thought(em);
        self.close_text(em);
        // Arguments that arrived AFTER the call opened. Re-emitting
        // the opening frame is the supported correction mechanism —
        // the AI SDK's `tool-input-available` updates the part with
        // the same `toolCallId` in place, and so does
        // `PartsAccumulator::tool_input` — and it is the only way the
        // desktop's `PlanTool` (`input.plan`), `TodoTool`
        // (`input.todos`) and `SubagentTool` (`input.description`)
        // ever see arguments an agent streamed in late.
        if let Some(open) = self.tool_open.get_mut(&id) {
            let fresh = input.filter(|v| !is_blank_tool_input(v));
            if let Some(raw) = fresh.filter(|v| *v != open.input) {
                let (name, dynamic, emit_input) =
                    acp_tool_frame(&open.kind, &open.title, &raw, &open.locations);
                // The part type and `dynamic` flag are PINNED to the
                // opening frame: a frame that resolves differently
                // would create a SECOND part instead of correcting
                // the first, which is strictly worse than keeping the
                // arguments the opening frame already had. Only the
                // kind-and-input heuristics in `acp_tool_ui_name` can
                // move this way, and only for an agent that opens a
                // call with no arguments at all.
                if name == open.name && dynamic == open.dynamic {
                    // `start` re-uses the opening stamp, so correcting
                    // the arguments never restarts the call's clock.
                    let started = self.tool_clock.start(&id);
                    em.emit(ui_tool_input(
                        &id,
                        &name,
                        &emit_input,
                        dynamic,
                        Some(started),
                    ));
                    self.acc
                        .tool_input(&id, &name, &raw, dynamic, Some(started));
                    open.input = raw;
                } else {
                    tracing::debug!(
                        tool_call_id = %id,
                        was = %open.name,
                        now = %name,
                        "acp: late tool input would change the part type; keeping the opening frame"
                    );
                }
            }
        }
        // Terminal states can carry no further arguments, so the
        // record is dropped rather than held for the whole turn.
        if status == "completed" || status == "failed" || status == "error" {
            self.tool_open.remove(&id);
        }
        // Close the matching tool-call span.
        if let Some(span_id) = self.open_spans.remove(&id) {
            let err = if status == "error" {
                Some(status.as_str())
            } else {
                None
            };
            if let Err(e) = traces.close_span(&span_id, err).await {
                tracing::warn!("trace close_span failed: {e:#}");
            }
        }
        let dynamic = self.tool_dynamic.remove(&id).unwrap_or(true);
        // Capture the terminal state before `status` is moved into the
        // payload, so the persisted part records success vs error.
        let is_err = status == "error" || status == "failed";
        let payload = serde_json::json!({
            "status": status,
            "output": output.unwrap_or(Value::Null),
        });
        let timing = self.tool_clock.finish(&id);
        em.emit(ui_tool_output(&id, &payload, dynamic, timing));
        self.acc.tool_output(&id, &payload, is_err, timing);
    }

    /// Nested sub-steps of a tool result, fanned out as `<parent>:<n>` child parts.
    pub(crate) fn on_tool_steps(
        &mut self,
        em: &AcpEmitter,
        refs: AcpTurnRefs<'_>,
        parent_id: String,
        steps: Vec<Value>,
        final_answer: Option<String>,
    ) {
        let watch = refs.watch;
        // A tool result declared the nested steps it ran internally.
        // Mint each one as a synthetic child tool part: the desktop
        // groups nested rows by splitting the child `toolCallId` at the
        // FIRST ':' and matching that prefix against a `tool-Task` /
        // `tool-Agent` parent (message-list.tsx, CoworkContextPanel.tsx).
        //
        // A parent id that already contains ':' can therefore never be a
        // valid prefix, so skip the fan-out entirely rather than emit
        // mis-parented children that vanish silently from BOTH consumers.
        // Provider tool_use ids are colon-free today (`toolu_…`,
        // `call_…`), but a gateway-routed provider is not audited.
        //
        // The guard also closes the reverse direction: because no real
        // provider mints a colon id, no incoming ACP `tool_call_update`
        // can ever collide with a `<parent>:<n>` child and reopen it
        // through the `ToolResult` arm's `tool_dynamic` lookup (children
        // are deliberately absent from that map — their `dynamic` flag is
        // carried inline here instead).
        //
        // Cross-unit invariant worth stating: this fan-out is INERT
        // unless the parent row's type is `tool-Task` or `tool-Agent` —
        // those are the only two the desktop collects parent ids from.
        // Rename the producing tool and the children orphan, with no
        // error anywhere.
        if parent_id.contains(':') {
            return;
        }
        // Nested calls have side effects, exactly like the parent's own
        // `ToolCall`: replaying the turn on another plan would run them
        // again, so this counts as content.
        watch.mark_content();
        self.close_thought(em);
        self.close_text(em);
        for (n, raw_step) in steps.iter().enumerate() {
            // Producers may give a row a stable suffix. This is
            // essential for parallel subagent lifecycle rows: one
            // child can append tool steps before another child, so
            // an array index is not a stable transaction identity.
            // A colon would escape the one-level parent namespace;
            // `out` is reserved for the final-answer part below.
            let suffix = nested_step_suffix(raw_step, n);
            let child = format!("{parent_id}:{suffix}");
            let step = nested_step(raw_step);
            // Re-emit while the step's name/arguments are still changing;
            // see `steps_opened` above for why one-shot would be wrong.
            let frame = (step.name, step.input);
            if self.steps_opened.get(&child) != Some(&frame) {
                let started = self.tool_clock.start(&child);
                em.emit(ui_tool_input(
                    &child,
                    &frame.0,
                    &frame.1,
                    step.dynamic,
                    Some(started),
                ));
                self.acc
                    .tool_input(&child, &frame.0, &frame.1, step.dynamic, Some(started));
                self.steps_opened.insert(child.clone(), frame);
            }
            // Only a terminal step closes its row; a child pinned to a
            // terminal state mid-run would stop updating on screen.
            if !step.terminal || !self.steps_closed.insert(child.clone()) {
                continue;
            }
            let payload = serde_json::json!({
                "status": step.status,
                "output": raw_step.get("output").cloned().unwrap_or(Value::Null),
            });
            // `dynamic` must match the opening frame (see `ui_tool_output`).
            let timing = self.tool_clock.finish(&child);
            em.emit(ui_tool_output(&child, &payload, step.dynamic, timing));
            self.acc
                .tool_output(&child, &payload, step.status != "completed", timing);
        }
        // The subagent's final answer, as a `<parent>:out` `TaskOutput`
        // part. CORE mints this id, which is the only reason the
        // `<parent>:<suffix>` contract is satisfiable at all — an
        // agent-side extension cannot emit sibling tool-call frames.
        // The desktop suppresses `tool-TaskOutput` from the message list
        // and reads it as the answer in the Cowork subagent transcript,
        // replacing the `partText(task.output)` fallback.
        if let Some(answer) = final_answer {
            let child = format!("{parent_id}:out");
            // `:out` shares `steps_closed` with the numeric children; the
            // suffixes cannot collide, and a repeated terminal update
            // must not append the answer twice.
            if self.steps_closed.insert(child.clone()) {
                // The opening frame carries NO answer text: neither
                // consumer reads a `tool-TaskOutput` part's `input`
                // (Cowork prefers `output`, the message list suppresses
                // the part), and duplicating a long final answer into the
                // persisted `parts` blob would double the row for nothing.
                let input = Value::Object(serde_json::Map::new());
                // Deliberately UNSTAMPED. This part is opened and closed
                // in the same breath, so any duration it carried would be
                // ~0ms — a measurement of Core's own serialization, not of
                // work the subagent did. It also represents an answer
                // rather than a call, and the message list suppresses it.
                em.emit(ui_tool_input(&child, "TaskOutput", &input, false, None));
                self.acc
                    .tool_input(&child, "TaskOutput", &input, false, None);
                let payload = serde_json::json!({
                    "status": "completed",
                    "output": answer,
                });
                em.emit(ui_tool_output(&child, &payload, false, None));
                self.acc.tool_output(&child, &payload, false, None);
            }
        }
    }
}
