use super::*;

impl AcpTurnState {
    /// The `AcpEvent::Error` exit: report, persist what exists, close out, end the turn.
    pub(crate) async fn on_error_exit(
        &mut self,
        em: &mut AcpEmitter,
        refs: AcpTurnRefs<'_>,
        watch_model: &Option<String>,
        run_finisher: &mut Option<ryu_tracing::ScopeGuard>,
        guard: &mut Option<WorktreeGuard>,
        failure: acp::AcpFailure,
    ) {
        let AcpTurnRefs {
            persist_store,
            persist_conversation_id,
            persist_agent_id,
            agent_id,
            watch,
            traces,
            ..
        } = refs;
        let msg = failure.message.as_str();
        // Report the failure to the reactive failover wrapper FIRST.
        // A vendor cap reaches this plane as an ordinary error with
        // no typed signal, so the kind is `Other` and the wrapper
        // confirms it against the agent's own usage windows rather
        // than against this string.
        watch.record_failure(
            &agent_id,
            watch_model.as_deref(),
            crate::routing_policy::reactive::FailureKind::Other,
            &msg,
        );
        // When the turn is going to be retried on another plan,
        // none of the failed-turn bookkeeping below may run: a
        // `failed` run status and a failed assistant row would
        // outlive the retry and a reload would show a failure that
        // never happened.
        let will_retry = watch.retryable().is_some();
        if !will_retry {
            self.acc
                .error(&failure.code, &failure.title, &failure.message);
        }
        // Close any still-open spans with an error on agent failure.
        for (_tool_id, span_id) in self.open_spans.drain() {
            let _ = traces.close_span(&span_id, Some("agent error")).await;
        }
        if let Some(finisher) = run_finisher.as_mut() {
            finisher.fail(msg.to_owned());
        }
        // Final persistence on error: update the existing row or
        // create one if we never received text (a tool-only turn that
        // errored still persists its parts).
        if let Some(ref conv_id) = persist_conversation_id.clone().filter(|_| !will_retry) {
            if let Some(ref mid) = self.persisted_msg_id {
                let _ = persist_store.update_message_content(mid, &self.reply).await;
            } else if !self.reply.is_empty() || !self.acc.is_empty() {
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
                    Ok(mid) => self.persisted_msg_id = Some(mid),
                    Err(e) => tracing::warn!("failed to persist assistant message on error: {e:#}"),
                }
            }
            let _ = persist_store.set_run_status(conv_id, "failed").await;
        }
        self.close_thought(em);
        if self.plan_open {
            let plan_done = serde_json::json!({ "done": true });
            let plan_timing = self.tool_clock.finish(PLAN_TOOL_ID);
            em.emit(ui_tool_output(PLAN_TOOL_ID, &plan_done, false, plan_timing));
            self.acc
                .tool_output(PLAN_TOOL_ID, &plan_done, false, plan_timing);
        }
        if self.text_open {
            let tid = format!("{TEXT_ID}-{}", self.text_seq);
            em.emit(ui_text_end(&tid));
        }
        // Persist structured parts after the close-outs (terminal tool
        // states captured), so even a failed turn's tool rows + cowork
        // context survive a reload. Best-effort.
        if let Some(ref mid) = self.persisted_msg_id {
            if !self.acc.is_empty() {
                if let Err(e) = persist_store
                    .update_message_parts(mid, &self.acc.to_json())
                    .await
                {
                    tracing::warn!("failed to persist message parts on error: {e:#}");
                }
            }
        }
        for line in error_ui_lines(msg) {
            em.emit(line);
        }
        // End the live turn on error exit.
        em.live_stream.take();
        refresh_managed_worktree_cleanup(guard).await;
    }

    /// Normal completion: `message_end` hooks, final persistence, close-outs, worktree diff.
    pub(crate) async fn finish_turn(
        &mut self,
        em: &mut AcpEmitter,
        refs: AcpTurnRefs<'_>,
        plugin_flags: &std::collections::HashMap<String, bool>,
        worktree_diffs: &crate::server::WorktreeDiffStore,
        guard: &mut Option<WorktreeGuard>,
    ) {
        let AcpTurnRefs {
            persist_store,
            persist_conversation_id,
            persist_agent_id,
            conversation_id,
            ..
        } = refs;
        // The `message_end` phase, at the ACP finalize point: the event loop has
        // drained, so `reply` is the whole answer, and nothing has been written yet
        // — both the update path and the create-a-row fallback below see the
        // rewrite. Deliberately NOT fired on the `AcpEvent::Error` exit above: that
        // turn produced no finalized message, and handing a hook a truncated reply
        // as "the answer" would let it rewrite a failure into a success.
        let rewritten_reply = run_message_end_hooks(
            &self.reply,
            persist_conversation_id.as_deref(),
            persist_agent_id.as_deref(),
            &plugin_flags,
        )
        .await;
        let rewrote_reply = rewritten_reply.is_some();
        if let Some(replacement) = rewritten_reply {
            self.reply = replacement;
        }

        // Normal completion: final flush of the reply text and mark completed.
        if let Some(ref conv_id) = persist_conversation_id {
            if let Some(ref mid) = self.persisted_msg_id {
                // Update the existing row with the final full reply.
                let _ = persist_store.update_message_content(mid, &self.reply).await;
            } else if !self.reply.is_empty() || !self.acc.is_empty() {
                // No row yet — create one now. A turn that only ran tools (no text)
                // still needs a row so its structured parts (and thus the cowork
                // context) survive a reload.
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
                    Ok(mid) => self.persisted_msg_id = Some(mid),
                    Err(e) => {
                        tracing::warn!("failed to persist final assistant message: {e:#}")
                    }
                }
            }
            let _ = persist_store.set_run_status(conv_id, "completed").await;
        }
        self.close_thought(em);
        if self.plan_open {
            let plan_done = serde_json::json!({ "done": true });
            let plan_timing = self.tool_clock.finish(PLAN_TOOL_ID);
            em.emit(ui_tool_output(PLAN_TOOL_ID, &plan_done, false, plan_timing));
            self.acc
                .tool_output(PLAN_TOOL_ID, &plan_done, false, plan_timing);
        }
        if self.text_open {
            let tid = format!("{TEXT_ID}-{}", self.text_seq);
            em.emit(ui_text_end(&tid));
        }

        // Persist the structured render parts now that the close-out frames have
        // recorded terminal tool states (TodoWrite / Thinking "done"). Independent
        // of and after the text flush above; best-effort — a failure just falls the
        // reload back to text-only. This is what restores the transcript's tool
        // rows + the cowork context (Progress / Sources / Subagents) on reload.
        if let Some(ref mid) = self.persisted_msg_id {
            // A `message_end` rewrite has to land in the sealed parts too — the
            // desktop renders `parts` whenever they exist, so rewriting only the
            // row's content would make a reloaded conversation disagree with the
            // message the user is looking at. Applied here, last, once every
            // close-out frame has been folded into `acc`, so nothing can reopen the
            // stale text afterwards.
            if rewrote_reply {
                self.acc.replace_text(&self.reply);
            }
            if !self.acc.is_empty() {
                if let Err(e) = persist_store
                    .update_message_parts(mid, &self.acc.to_json())
                    .await
                {
                    tracing::warn!("failed to persist message parts: {e:#}");
                }
            }
        }

        // Capture the worktree diff and store it together with the live guard.
        // The guard is transferred into WorktreeRun so the worktree and branch
        // survive until the user calls POST /api/worktree/:run_id/apply, at
        // which point apply_worktree consumes the guard and git-removes it.
        if let Some((conv_id, live_guard)) = conversation_id
            .as_ref()
            .and_then(|id| guard.take().map(|guard| (id, guard)))
        {
            let base = if live_guard.base_hash.is_empty() {
                "HEAD".to_string()
            } else {
                live_guard.base_hash.clone()
            };
            let diff = ryu_workspace::worktree::worktree_diff(&live_guard.path, &base);
            let replaced = worktree_diffs.lock().await.insert(
                conv_id.clone(),
                crate::server::WorktreeRun {
                    diff,
                    guard: Some(live_guard),
                    computed_at: std::time::Instant::now(),
                },
            );
            if let Some(mut previous) = replaced {
                refresh_managed_worktree_cleanup(&mut previous.guard).await;
            }
        }

        refresh_managed_worktree_cleanup(guard).await;

        if let Some(message_id) = self.persisted_msg_id.as_deref() {
            em.emit(ui_assistant_message_id(message_id));
        }
        em.emit(ui_finish());
        em.emit(DONE_SSE_LINE.as_bytes().to_vec());
        // End the live turn on normal completion.
        em.live_stream.take();
    }
}
