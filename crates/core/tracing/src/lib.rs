//! Per-run observability trace store (spec unit #178 / M4, hierarchical v2).
//!
//! Persists spans keyed by `conversation_id` (the run id) in a local SQLite
//! database (`<data dir>/db/traces.db`, chosen by Core). v1 recorded a flat,
//! ordered list of `"tool-call"` / `"model-call"` spans; v2 adds Mastra AI
//! tracing / LangSmith-style hierarchy on the same rows:
//!
//!   - `trace_id` / `span_id` / `parent_span_id` — W3C-shaped ids (32 / 16 hex)
//!     so spans nest into a tree and map 1:1 onto OTLP spans;
//!   - `kind` — one of [`SpanKind`] (`agent_run`, `workflow_run`,
//!     `workflow_step`, `model_call`, `tool_call`, `retrieval`, `memory`,
//!     `guardrail`); v1 spellings stay readable;
//!   - `status` — [`SpanStatus`] (`running` / `ok` / `error` / `cancelled`);
//!   - `attributes` — a small JSON object of metadata;
//!   - `input` / `output` — payloads, persisted ONLY when the host opted the
//!     store into capture through [`ContentPolicy`] (privacy by default).
//!
//! Hierarchy is ambient: [`TraceStore::begin_scope`] pushes a span onto a
//! per-run scope stack, and any span started for that run without an explicit
//! parent — including every v1 [`TraceStore::open_span`] caller — becomes its
//! child. Existing call sites therefore nest under an agent run without change.
//!
//! Placement rationale (Core vs Gateway): span ordering and tool-call
//! sequencing are *what ran* (orchestration) — Core. Token counts, cost, and
//! provider latency are *what is measured/paid* — Gateway audit only. This
//! store holds NO token or cost columns; `session_id` is the join key a viewer
//! uses to attach Gateway audit rows to model-call spans.

pub mod content;
pub mod export_presets;
pub mod kind;
mod span;
mod store;
pub mod tree;

#[cfg(test)]
mod tests;

pub use content::{ContentPolicy, ContentSealer};
pub use kind::{SpanKind, SpanStatus};
pub use span::{
    hash_args, new_span_id, new_trace_id, Span, SpanContext, SpanEnd, SpanSink, SpanStart,
    TraceQuery, TraceSummary,
};
pub use store::{ScopeGuard, TracePruneSummary, TraceStore};
pub use tree::{build_tree, RunTraceTree, SpanNode};
