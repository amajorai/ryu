use super::*;

/// Ends a turn: surfaces a swallowed prompt failure, else sends the final usage
/// frame, then clears the permission sink.
#[allow(clippy::too_many_arguments, clippy::ptr_arg)]
pub(super) fn finish_turn(
    turn_error: &Mutex<Option<(i32, String)>>,
    cancelled: bool,
    tx: &mpsc::UnboundedSender<AcpEvent>,
    widget_agent_id: &String,
    sink: &Mutex<Option<mpsc::UnboundedSender<AcpEvent>>>,
    is_managed_pi: bool,
    turn_usage: &Mutex<Option<serde_json::Value>>,
    session_total_tokens: &mut Option<u64>,
) {
    // Surface a swallowed provider failure. When the `session/prompt`
    // request errored (no model configured / provider unreachable —
    // seen as a transport error or ~timeout), the turn produced no real
    // completion. Emit a real error frame instead of the normal
    // usage-done/`finish` so the client gets an actionable failure
    // rather than a silent close that passes off a pre-failure agent
    // banner as a successful reply. `AcpEvent::Error` (mod.rs) tears the
    // turn down (error/finish/[DONE] frames + `set_run_status("failed")`),
    // so we skip the usage-done frame and loop back for the next turn.
    // A turn the user stopped is not a failure, even when the
    // agent answers `session/cancel` with an error.
    if let Some((code, detail)) = turn_error
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .filter(|_| !cancelled)
    {
        tracing::warn!(code, detail = %detail, "ACP turn failed; surfacing error frame");
        // An expired OAuth token is NOT a missing model. Telling the
        // user to "configure a model" when their subscription login
        // lapsed sends them to a settings page that cannot fix it,
        // which is what this branch exists to stop. `AuthNeeded`
        // carries the agent id so the client can offer the agent's own
        // advertised login methods and re-run the turn afterwards.
        if code == ACP_AUTH_REQUIRED_CODE {
            let _ = tx.send(AcpEvent::AuthNeeded {
                // Instance-scoped: the ACP session is pinned to one
                // agent, so this is the agent whose login lapsed.
                agent_id: widget_agent_id.clone(),
                message: detail.clone(),
            });
            // The data part above carries the RECOVERY (the toast and
            // its login button); it does not end the stream. The turn
            // still has to be torn down, because it genuinely failed —
            // only `AcpEvent::Error` emits error/finish/[DONE] and
            // moves the run off "running". Without this the composer
            // would sit in streaming state with a Stop button and no
            // way to send: a hang, which is precisely the confusion
            // this branch exists to remove.
            let _ = tx.send(AcpEvent::Error(auth_required_failure()));
            if let Ok(mut g) = sink.lock() {
                *g = None;
            }
            return;
        }
        let active_provider = if is_managed_pi {
            Some(crate::pi_config::current().provider)
        } else {
            None
        };
        let failure = classify_prompt_failure(active_provider.as_deref(), &detail);
        let _ = tx.send(AcpEvent::Error(failure));
        if let Ok(mut g) = sink.lock() {
            *g = None;
        }
        return;
    }

    // Final usage frame for the turn (`done: true`). Carries the
    // turn's token totals when the agent reported them
    // (`PromptResponse.usage`, camelCase: input/output/total/
    // thought/cachedRead/cachedWrite); the frame is emitted even when
    // it did not, so the desktop's duration/speed UI (computed from
    // mod.rs's own timer) still works.
    //
    // The counters are this turn's (see `AcpUsageSnapshot`); the
    // running sum ships as `sessionTotalTokens`. `promptTokens` is
    // total input with cache tokens included.
    let mut usage_payload = serde_json::Map::new();
    usage_payload.insert("done".to_owned(), serde_json::Value::Bool(true));
    if let Some(u) = turn_usage.lock().ok().and_then(|g| g.clone()) {
        let turn = AcpUsageSnapshot::from_value(&u);
        let turn_total = turn
            .total_tokens
            .or_else(|| total_usage_tokens(turn.prompt_tokens_with_cache()?, turn.output_tokens?));
        if let Some(total) = turn_total {
            *session_total_tokens = Some(session_total_tokens.unwrap_or(0).saturating_add(total));
        }
        let mut put = |key: &str, value: Option<u64>| {
            if let Some(v) = value {
                usage_payload.insert(key.to_owned(), v.into());
            }
        };
        put("promptTokens", turn.prompt_tokens_with_cache());
        put("completionTokens", turn.output_tokens);
        put("totalTokens", turn_total);
        put("thoughtTokens", turn.thought_tokens);
        put("cachedReadTokens", turn.cached_read_tokens);
        put("cachedWriteTokens", turn.cached_write_tokens);
        put("sessionTotalTokens", *session_total_tokens);
        for key in [
            "context_window",
            "contextWindow",
            "current_usage",
            "currentUsage",
            "cost",
            "costAmount",
            "costCurrency",
            "currency",
        ] {
            if let Some(value) = u.get(key) {
                usage_payload.insert(key.to_owned(), value.clone());
            }
        }
        // Context occupancy fallback for agents that send no live
        // `UsageUpdate` (gemini-cli): the turn's input plus its reply
        // is the best proxy the turn-end response offers. mod.rs
        // keeps a live reading over it when one arrived.
        if let Some(total) = turn_total {
            usage_payload.insert("used".to_owned(), total.into());
        }
    }
    let _ = tx.send(AcpEvent::Usage(serde_json::Value::Object(usage_payload)));

    // Turn done: clear the permission sink (drop the held clone) and
    // let `tx` drop, closing the caller's event stream; loop back for
    // this chat's next turn on the same reused session.
    if let Ok(mut g) = sink.lock() {
        *g = None;
    }
}
