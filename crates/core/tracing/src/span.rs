//! Span records and the start/end descriptions the store writes.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{SpanKind, SpanStatus};

/// A single span within a run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Span {
    /// Stable row id (UUID).
    pub id: String,
    /// The run this span belongs to (`conversation_id` from the chat request).
    pub conversation_id: String,
    /// The stored kind: a [`SpanKind`] value, or a v1 `"tool-call"` /
    /// `"model-call"` spelling for rows written through [`TraceStore::open_span`](crate::TraceStore::open_span).
    pub kind: String,
    /// Tool name (tool-call), model id (model-call), agent/workflow/step name.
    pub name: String,
    /// SHA-256 hex of the raw tool-input JSON (tool-call only).  Never the raw
    /// payload — protects sensitive args from being stored in Core.
    pub args_hash: Option<String>,
    /// Unix milliseconds — when the span was opened.
    pub started_at: i64,
    /// Unix milliseconds — when the span was closed.  `None` while in-flight.
    pub ended_at: Option<i64>,
    /// Error message if the span ended with a failure.
    pub error: Option<String>,
    /// Nullable link to the Gateway audit session. Model-call spans carry the
    /// Core conversation id; tool spans may omit the link.
    pub session_id: Option<String>,
    /// Autoincrement ordering key (monotonically increasing within the DB).
    pub seq: i64,
    /// 32-hex trace id shared by every span of one agent/workflow run. `None`
    /// only for rows written before v2.
    #[serde(default)]
    pub trace_id: Option<String>,
    /// 16-hex span id (the OTLP span id). `None` only for pre-v2 rows.
    #[serde(default)]
    pub span_id: Option<String>,
    /// The parent's `span_id`; `None` for a root.
    #[serde(default)]
    pub parent_span_id: Option<String>,
    /// Lifecycle state (derived from `ended_at`/`error` for pre-v2 rows).
    #[serde(default)]
    pub status: SpanStatus,
    /// The agent the span ran under, when known (inherited from the parent).
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Small metadata object (counts, ids, model parameters).
    #[serde(default)]
    pub attributes: Map<String, Value>,
    /// Captured input, present only under a capturing [`ContentPolicy`](crate::ContentPolicy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    /// Captured output, present only under a capturing [`ContentPolicy`](crate::ContentPolicy).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
}

impl Span {
    /// The canonical kind, when the stored kind is recognized.
    pub fn normalized_kind(&self) -> Option<SpanKind> {
        SpanKind::parse(&self.kind)
    }
}

/// The identity of a started span, passed to children as their parent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SpanContext {
    /// Row id (UUID) — the handle for [`TraceStore::end_span`](crate::TraceStore::end_span).
    pub id: String,
    /// The run (conversation) id.
    pub run_id: String,
    /// 32-hex trace id.
    pub trace_id: String,
    /// 16-hex span id.
    pub span_id: String,
    /// Agent the span ran under, inherited by children.
    pub agent_id: Option<String>,
}

/// Everything needed to start a span.
#[derive(Debug, Clone)]
pub struct SpanStart {
    pub run_id: String,
    pub kind: SpanKind,
    pub name: String,
    /// Explicit parent; `None` uses the run's innermost active scope.
    pub parent: Option<SpanContext>,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
    pub args_hash: Option<String>,
    pub attributes: Map<String, Value>,
    /// Dropped unless the store's [`ContentPolicy`](crate::ContentPolicy) captures content.
    pub input: Option<Value>,
}

impl SpanStart {
    /// Start description for `kind` named `name` in run `run_id`.
    pub fn new(run_id: impl Into<String>, kind: SpanKind, name: impl Into<String>) -> Self {
        Self {
            run_id: run_id.into(),
            kind,
            name: name.into(),
            parent: None,
            agent_id: None,
            session_id: None,
            args_hash: None,
            attributes: Map::new(),
            input: None,
        }
    }

    /// Nest under an explicit parent instead of the ambient scope.
    pub fn parent(mut self, parent: &SpanContext) -> Self {
        self.parent = Some(parent.clone());
        self
    }

    /// Record the agent this span runs under.
    pub fn agent(mut self, agent_id: Option<impl Into<String>>) -> Self {
        self.agent_id = agent_id.map(Into::into);
        self
    }

    /// Link the span to a Gateway audit session.
    pub fn session(mut self, session_id: Option<impl Into<String>>) -> Self {
        self.session_id = session_id.map(Into::into);
        self
    }

    /// Fingerprint tool input with [`hash_args`] (never stores the input).
    pub fn args(mut self, input: &Value) -> Self {
        self.args_hash = Some(hash_args(input));
        self
    }

    /// Add one metadata attribute.
    pub fn attr(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.attributes.insert(key.into(), value.into());
        self
    }

    /// Offer an input payload (kept only under a capturing content policy).
    pub fn input(mut self, input: Value) -> Self {
        self.input = Some(input);
        self
    }
}

/// How a span ended.
#[derive(Debug, Clone, Default)]
pub struct SpanEnd {
    pub status: SpanStatus,
    pub error: Option<String>,
    pub attributes: Map<String, Value>,
    /// Dropped unless the store's [`ContentPolicy`](crate::ContentPolicy) captures content.
    pub output: Option<Value>,
}

impl SpanEnd {
    /// Successful end.
    pub fn ok() -> Self {
        Self {
            status: SpanStatus::Ok,
            ..Self::default()
        }
    }

    /// Failed end with a message.
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            status: SpanStatus::Error,
            error: Some(message.into()),
            ..Self::default()
        }
    }

    /// Abandoned / superseded end.
    pub fn cancelled(reason: impl Into<String>) -> Self {
        Self {
            status: SpanStatus::Cancelled,
            error: Some(reason.into()),
            ..Self::default()
        }
    }

    /// `ok()` or `error(message)` from a result-like option.
    pub fn from_error(error: Option<&str>) -> Self {
        match error {
            Some(message) => Self::error(message),
            None => Self::ok(),
        }
    }

    /// Add one metadata attribute (merged into the start attributes).
    pub fn attr(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.attributes.insert(key.into(), value.into());
        self
    }

    /// Offer an output payload (kept only under a capturing content policy).
    pub fn output(mut self, output: Value) -> Self {
        self.output = Some(output);
        self
    }
}

/// Receives every span when it ends (Core's OTLP bridge implements this).
pub trait SpanSink: Send + Sync + 'static {
    /// Called once per ended span with the persisted row.
    fn on_span_end(&self, span: &Span);
}

/// Filters for [`TraceStore::list_traces`](crate::TraceStore::list_traces).
#[derive(Debug, Clone, Default)]
pub struct TraceQuery {
    /// Restrict to these runs (the caller's readable conversations). `None`
    /// means unrestricted — only for trusted callers.
    pub run_ids: Option<Vec<String>>,
    pub agent_id: Option<String>,
    pub status: Option<SpanStatus>,
    pub kind: Option<SpanKind>,
    /// Root start time lower bound (Unix ms, inclusive).
    pub since: Option<i64>,
    /// Root start time upper bound (Unix ms, inclusive).
    pub until: Option<i64>,
    /// Substring of the root name, or an exact run id / trace id.
    pub search: Option<String>,
    /// Page size (clamped to 1..=500; 0 means 50).
    pub limit: usize,
    pub offset: usize,
}

/// One trace (a root span and its descendants) in a listing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TraceSummary {
    pub trace_id: String,
    pub run_id: String,
    /// Row id of the root span.
    pub root_id: String,
    pub span_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub agent_id: Option<String>,
    pub status: SpanStatus,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub span_count: i64,
    pub error_count: i64,
}

/// A fresh 32-hex (128-bit) trace id.
pub fn new_trace_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// A fresh 16-hex (64-bit) span id.
pub fn new_span_id() -> String {
    let mut id = uuid::Uuid::new_v4().simple().to_string();
    id.truncate(16);
    id
}

/// SHA-256 hex of a JSON value's canonical representation.
pub fn hash_args(value: &serde_json::Value) -> String {
    use std::fmt::Write;
    // Canonical form: serialize the value (serde_json is deterministic for
    // the same in-memory Value; sufficient for a privacy-safe fingerprint).
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let digest = sha2_digest(&bytes);
    let mut out = String::with_capacity(64);
    for b in digest {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Minimal SHA-256 implementation using the `sha2` crate (already in the
/// dependency tree via rustls/ring).  Isolated here so the rest of the module
/// has no sha2 import noise.
fn sha2_digest(data: &[u8]) -> [u8; 32] {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(data);
    h.finalize().into()
}
