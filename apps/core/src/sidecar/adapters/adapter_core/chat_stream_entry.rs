use super::*;

/// `x-ryu-feature` value for a chat-completions turn. A programmatic turn
/// (`background`: scheduled run, run-text turn, delegate, team member, channel
/// reply) with no verified human author is reported as `agent`, so the Gateway
/// rolls it into `byFeature.agent`; everything else stays `chat`.
pub(crate) fn chat_feature_tag(background: bool, user_id: Option<&str>) -> &'static str {
    if background && user_id.is_none_or(str::is_empty) {
        "agent"
    } else {
        "chat"
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn route_chat_stream(
    req: ChatStreamRequest,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
    recall: Option<AutoRecallConfig>,
    ctx_window: Option<context_window::ContextWindowConfig>,
    watch: crate::routing_policy::reactive::TurnWatch,
    subscription_costs: Option<crate::server::subscription_costs::SubscriptionCostStore>,
) -> Response {
    let mut admission = match crate::execution_control::admit() {
        Ok(admission) => admission,
        Err(message) => return error_stream(message.to_owned()),
    };
    // Every admitted turn (interactive, scheduled, team member, channel, voice,
    // A2A) marks today as active for the profile streak. In-memory only; Patrol
    // and unverified outside callers are excluded, and a verified author counts
    // only for their own signed-in account. A sub-turn started during another
    // turn (delegate, coordinator worker, workflow step) has no author of its
    // own, so it inherits the parent's attribution, scoped over this turn's
    // execution and remembered for its conversation so tool calls carry it on.
    // Team-member fan-out turns are not credited again: the parent turn already
    // recorded the activity under its author.
    let attribution = crate::profile_activity::turn_attribution(
        req.agent_id.as_deref(),
        req.untrusted_caller,
        req.author_user_id.as_deref(),
        crate::profile_activity::current_attribution().as_ref(),
    );
    crate::profile_activity::note_turn(
        &attribution,
        req.conversation_id.as_deref(),
        !(req.background && req.target_agent_id.is_some()),
    );
    tokio::select! {
        biased;
        _ = admission.cancelled() => error_stream(crate::execution_control::PAUSED_MESSAGE.to_owned()),
        response = crate::profile_activity::with_attribution(
            Some(attribution),
            route_chat_stream_inner(
                req,
                registry,
                conversations,
                agent_store,
                manager,
                memory,
                worktree_diffs,
                mcp,
                skills,
                traces,
                recall,
                ctx_window,
                watch,
                subscription_costs,
            ),
        ) => response,
    }
}

/// Ends a durable turn that is turned away after it was marked `running` but
/// before a route took ownership of its terminal status. Without this the
/// conversation stays `running`, and boot reconciliation would later
/// auto-resume a turn the user already saw fail.
pub(crate) struct TurnRejection {
    pub(crate) conversations: ConversationStore,
    /// The durable conversation and the `updated_at` its `running` claim wrote.
    pub(crate) claim: Option<(String, i64)>,
}

impl TurnRejection {
    pub(crate) async fn reject(&self, message: String) -> Response {
        if let Some((conversation_id, claimed_at)) = &self.claim {
            // Compare-and-set on this turn's own claim, so a newer turn in the
            // same conversation keeps its `running`.
            if let Err(error) = self
                .conversations
                .fail_unstarted_auto_resume(conversation_id, *claimed_at)
                .await
            {
                tracing::warn!("failed to mark a rejected turn as failed: {error:#}");
            }
        }
        error_stream(message)
    }

    /// [`Self::reject`] for an ACP turn, which also releases the worktree the
    /// turn resolved before `route_acp_stream` could take it over.
    pub(crate) async fn reject_acp(
        &self,
        message: String,
        worktree_diffs: &crate::server::WorktreeDiffStore,
        conversation_id: Option<&str>,
        worktree_guard: Option<WorktreeGuard>,
        reused: bool,
    ) -> Response {
        release_unstarted_worktree(worktree_diffs, conversation_id, worktree_guard, reused).await;
        self.reject(message).await
    }
}

/// Begin a turn's `agent_run` trace scope. The returned guard is pre-marked
/// failed: a turn that returns before a plane takes it over ended in an error
/// response. `None` without a conversation id (nothing to key the run by) or
/// when the trace store write fails (tracing never blocks a turn).
pub(crate) async fn begin_run_trace(
    traces: &TraceStore,
    conversation_id: Option<&str>,
    agent_id: Option<&str>,
) -> Option<ryu_tracing::ScopeGuard> {
    let conversation_id = conversation_id.filter(|id| !id.is_empty())?;
    let start = SpanStart::new(
        conversation_id,
        SpanKind::AgentRun,
        agent_id.unwrap_or("default"),
    )
    .agent(agent_id);
    match traces.scope_guard(start).await {
        Ok(mut guard) => {
            guard.fail("the turn ended before reaching a model");
            Some(guard)
        }
        Err(cause) => {
            tracing::warn!("trace run scope open failed: {cause:#}");
            None
        }
    }
}

/// Leave the run scope open for the plane, which ends it via `run_finisher`.
pub(crate) fn handoff_run_trace(run_trace: &mut Option<ryu_tracing::ScopeGuard>) {
    if let Some(guard) = run_trace.take() {
        let _ = guard.handoff();
    }
}

/// Start a child span for the conversation's active run (best effort).
pub(crate) async fn start_trace_span(
    traces: &TraceStore,
    conversation_id: Option<&str>,
    mut start: SpanStart,
) -> Option<ryu_tracing::SpanContext> {
    start.run_id = conversation_id.filter(|id| !id.is_empty())?.to_owned();
    match traces.start_span(start).await {
        Ok(context) => Some(context),
        Err(cause) => {
            tracing::warn!("trace span open failed: {cause:#}");
            None
        }
    }
}

/// End a span opened with [`start_trace_span`] (best effort).
pub(crate) async fn end_trace_span(
    traces: &TraceStore,
    context: Option<&ryu_tracing::SpanContext>,
    end: SpanEnd,
) {
    if let Some(context) = context {
        if let Err(cause) = traces.end_span(&context.id, end).await {
            tracing::warn!("trace span close failed: {cause:#}");
        }
    }
}
