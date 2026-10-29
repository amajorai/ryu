//! Span and scope lifecycle: start, end, scopes, and the v1 API.

use super::guard::GuardTarget;
use super::*;
use crate::{new_span_id, new_trace_id, SpanEnd, SpanStart};

impl TraceStore {
    /// The innermost active scope for a run, if any.
    pub fn active_scope(&self, run_id: &str) -> Option<SpanContext> {
        let active = self.inner.active.lock().ok()?;
        active
            .get(run_id)
            .and_then(|stack| stack.last())
            .map(|scope| scope.context.clone())
    }

    /// Start a span. Without an explicit parent it nests under the run's
    /// innermost active scope, or starts a new trace when there is none.
    pub async fn start_span(&self, start: SpanStart) -> Result<SpanContext> {
        let kind = start.kind.as_str().to_owned();
        self.insert_span(start, kind).await
    }

    async fn insert_span(&self, start: SpanStart, stored_kind: String) -> Result<SpanContext> {
        let parent = start
            .parent
            .clone()
            .or_else(|| self.active_scope(&start.run_id));
        let context = SpanContext {
            id: uuid::Uuid::new_v4().to_string(),
            run_id: start.run_id.clone(),
            trace_id: parent
                .as_ref()
                .map_or_else(new_trace_id, |parent| parent.trace_id.clone()),
            span_id: new_span_id(),
            agent_id: start
                .agent_id
                .clone()
                .or_else(|| parent.as_ref().and_then(|parent| parent.agent_id.clone())),
        };
        let policy = self.content_policy();
        let input = policy.apply(start.input);
        let sealed_input = self.seal_payload(INPUT_PURPOSE, &context.id, input.as_ref());
        let attributes = Value::Object(start.attributes);
        let conn = self.inner.conn.lock().await;
        self.clear_payloads_if_capture_off(&conn, policy.capture);
        conn.execute(
            "INSERT INTO spans (id, conversation_id, kind, name, args_hash, started_at,
                                session_id, trace_id, span_id, parent_span_id, status,
                                agent_id, attributes, input)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'running', ?11, ?12, ?13)",
            params![
                context.id,
                context.run_id,
                stored_kind,
                start.name,
                start.args_hash,
                now_millis(),
                start.session_id,
                context.trace_id,
                context.span_id,
                parent.as_ref().map(|parent| parent.span_id.clone()),
                context.agent_id,
                to_json_text(Some(&attributes)),
                sealed_input,
            ],
        )
        .context("inserting span")?;
        Ok(context)
    }

    /// End a span by row id. Ending an already-ended span is a no-op.
    pub async fn end_span(&self, span_row_id: &str, end: SpanEnd) -> Result<()> {
        let policy = self.content_policy();
        let output = policy.apply(end.output);
        let sealed_output = self.seal_payload(OUTPUT_PURPOSE, span_row_id, output.as_ref());
        let attributes = Value::Object(end.attributes);
        let changed = {
            let conn = self.inner.conn.lock().await;
            self.clear_payloads_if_capture_off(&conn, policy.capture);
            conn.execute(
                "UPDATE spans
                    SET ended_at = ?1, status = ?2, error = ?3,
                        attributes = json_patch(COALESCE(attributes, '{}'), ?4),
                        output = COALESCE(?5, output)
                  WHERE id = ?6 AND ended_at IS NULL",
                params![
                    now_millis(),
                    end.status.as_str(),
                    end.error,
                    to_json_text(Some(&attributes)),
                    sealed_output,
                    span_row_id,
                ],
            )
            .context("ending span")?
        };
        if changed > 0 {
            if let Some(sink) = self.sink() {
                if let Some(span) = self.get_span(span_row_id).await? {
                    sink.on_span_end(&span);
                }
            }
        }
        Ok(())
    }

    /// Start a span and make it the run's innermost active scope, so later
    /// spans for the run nest under it. A new `agent_run` scope supersedes a
    /// leftover `agent_run` for the same run (ending it `cancelled`).
    pub async fn begin_scope(&self, start: SpanStart) -> Result<SpanContext> {
        if start.parent.is_none() && start.kind.is_root_kind() {
            let stale = self.take_scopes_from(&start.run_id, |scope| scope.kind == start.kind);
            for scope in stale.into_iter().rev() {
                self.end_span(
                    &scope.context.id,
                    SpanEnd::cancelled("superseded by a new run"),
                )
                .await?;
            }
        }
        let kind = start.kind;
        let context = self.start_span(start).await?;
        if let Ok(mut active) = self.inner.active.lock() {
            active
                .entry(context.run_id.clone())
                .or_default()
                .push(ActiveScope {
                    context: context.clone(),
                    kind,
                });
        }
        Ok(context)
    }

    /// Remove the first scope matching `matches` and everything above it.
    fn take_scopes_from(
        &self,
        run_id: &str,
        matches: impl Fn(&ActiveScope) -> bool,
    ) -> Vec<ActiveScope> {
        let Ok(mut active) = self.inner.active.lock() else {
            return Vec::new();
        };
        let Some(stack) = active.get_mut(run_id) else {
            return Vec::new();
        };
        let taken = match stack.iter().position(matches) {
            Some(index) => stack.split_off(index),
            None => Vec::new(),
        };
        if stack.is_empty() {
            active.remove(run_id);
        }
        taken
    }

    /// End a scope (and any scopes still open inside it).
    pub async fn end_scope(&self, context: &SpanContext, end: SpanEnd) -> Result<()> {
        let taken = self.take_scopes_from(&context.run_id, |scope| scope.context.id == context.id);
        for inner in taken.iter().skip(1).rev() {
            self.end_span(&inner.context.id, SpanEnd::cancelled("parent scope ended"))
                .await?;
        }
        self.end_span(&context.id, end).await
    }

    /// End the run's outermost active scope (and everything inside it).
    /// Returns whether a scope was active.
    pub async fn finish_active_run(&self, run_id: &str, end: SpanEnd) -> Result<bool> {
        let taken = self.take_scopes_from(run_id, |_| true);
        let Some((outer, inner)) = taken.split_first() else {
            return Ok(false);
        };
        for scope in inner.iter().rev() {
            self.end_span(&scope.context.id, SpanEnd::cancelled("parent scope ended"))
                .await?;
        }
        self.end_span(&outer.context.id, end).await?;
        Ok(true)
    }

    /// [`Self::begin_scope`] plus a guard that ends the scope when dropped.
    pub async fn scope_guard(&self, start: SpanStart) -> Result<ScopeGuard> {
        let context = self.begin_scope(start).await?;
        Ok(ScopeGuard::new(self.clone(), GuardTarget::Scope(context)))
    }

    /// A guard that, when dropped or finished, ends whatever run scope is
    /// active for `run_id` (no-op when none is). Lets a detached task finish
    /// a run that a different function began.
    pub fn run_finisher(&self, run_id: impl Into<String>) -> ScopeGuard {
        ScopeGuard::new(self.clone(), GuardTarget::ActiveRun(run_id.into()))
    }

    // ── v1 API (kept for existing call sites) ──────────────────────────────

    /// Open a span (tool-call or model-call).  Returns the new span row id.
    ///
    /// `args_hash` should be `Some(hash_args(&input))` for tool-call spans and
    /// `None` for model-call spans. The span nests under the run's active
    /// scope when one exists; the stored kind keeps the caller's spelling.
    pub async fn open_span(
        &self,
        conversation_id: &str,
        kind: &str,
        name: &str,
        args_hash: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<String> {
        let mut start = SpanStart::new(
            conversation_id,
            SpanKind::parse(kind).unwrap_or(SpanKind::ToolCall),
            name,
        )
        .session(session_id);
        start.args_hash = args_hash.map(str::to_owned);
        Ok(self.insert_span(start, kind.to_owned()).await?.id)
    }

    /// Close a span — set `ended_at` and optionally record an error.
    pub async fn close_span(&self, span_id: &str, error: Option<&str>) -> Result<()> {
        self.end_span(span_id, SpanEnd::from_error(error)).await
    }
}
