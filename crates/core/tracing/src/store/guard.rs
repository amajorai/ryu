//! [`ScopeGuard`] - ends a scope when dropped.

use super::*;
use crate::SpanEnd;

#[derive(Debug, Clone)]
pub(super) enum GuardTarget {
    Scope(SpanContext),
    ActiveRun(String),
}

/// Ends a scope when dropped (on the current Tokio runtime), so every early
/// return, error path, or client disconnect still closes the span.
pub struct ScopeGuard {
    store: TraceStore,
    target: Option<GuardTarget>,
    error: Option<String>,
    attributes: Map<String, Value>,
    output: Option<Value>,
}

impl std::fmt::Debug for ScopeGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ScopeGuard")
            .field("target", &self.target)
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

impl ScopeGuard {
    pub(super) fn new(store: TraceStore, target: GuardTarget) -> Self {
        Self {
            store,
            target: Some(target),
            error: None,
            attributes: Map::new(),
            output: None,
        }
    }

    /// The guarded scope, when this guard owns a specific one.
    pub fn context(&self) -> Option<&SpanContext> {
        match &self.target {
            Some(GuardTarget::Scope(context)) => Some(context),
            _ => None,
        }
    }

    /// Mark the scope failed; it ends with `error` status.
    pub fn fail(&mut self, message: impl Into<String>) {
        self.error = Some(message.into());
    }

    /// Add an attribute recorded at end.
    pub fn set_attribute(&mut self, key: impl Into<String>, value: impl Into<Value>) {
        self.attributes.insert(key.into(), value.into());
    }

    /// Offer an output payload (kept only under a capturing content policy).
    pub fn set_output(&mut self, output: Value) {
        self.output = Some(output);
    }

    /// Hand the still-open scope to another owner (who must end it, e.g. via
    /// [`TraceStore::run_finisher`]). The guard will not end it on drop.
    pub fn handoff(mut self) -> Option<SpanContext> {
        match self.target.take() {
            Some(GuardTarget::Scope(context)) => Some(context),
            _ => None,
        }
    }

    fn take_end(&mut self) -> Option<(GuardTarget, SpanEnd)> {
        let target = self.target.take()?;
        let mut end = SpanEnd::from_error(self.error.as_deref());
        end.attributes = std::mem::take(&mut self.attributes);
        end.output = self.output.take();
        Some((target, end))
    }

    async fn end_target(store: TraceStore, target: GuardTarget, end: SpanEnd) -> Result<()> {
        match target {
            GuardTarget::Scope(context) => store.end_scope(&context, end).await,
            GuardTarget::ActiveRun(run_id) => store.finish_active_run(&run_id, end).await.map(drop),
        }
    }

    /// End the scope now.
    pub async fn finish(mut self) -> Result<()> {
        match self.take_end() {
            Some((target, end)) => Self::end_target(self.store.clone(), target, end).await,
            None => Ok(()),
        }
    }
}

impl Drop for ScopeGuard {
    fn drop(&mut self) {
        let Some((target, end)) = self.take_end() else {
            return;
        };
        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            tracing::debug!("trace scope dropped outside a Tokio runtime; left open");
            return;
        };
        let store = self.store.clone();
        handle.spawn(async move {
            if let Err(error) = Self::end_target(store, target, end).await {
                tracing::warn!("trace scope end failed: {error:#}");
            }
        });
    }
}
