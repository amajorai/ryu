# ryu-tracing

The per-run observability trace primitive (#178 / M4): a hierarchical span store
keyed by run id, the run trace tree and trace search behind the desktop trace
viewer, and the OTLP exporter presets shared by Core and Gateway.

## Role in the decomposition

An extracted Core capability crate (L0), **compiled into Core by default** and
consumed as a NON-optional path dependency — the store opens at boot and backs a
`ServerState` field. ZERO dependency on `apps/core`. The Gateway links it only for
`export_presets` (pure endpoint/header mapping).

## Key API

- `Span` — the span row: v1 fields (`id`, `conversation_id` = run id, `kind`,
  `name`, `args_hash`, `started_at` / `ended_at` in Unix ms, `error`,
  `session_id`, `seq`) plus v2 hierarchy: `trace_id` (32 hex), `span_id`
  (16 hex), `parent_span_id`, `status`, `agent_id`, `attributes`, and optional
  `input` / `output`.
- `SpanKind` — `agent_run`, `workflow_run`, `workflow_step`, `model_call`,
  `tool_call`, `retrieval`, `memory`, `guardrail`. The v1 spellings
  `tool-call` / `model-call` still parse. `SpanStatus` — `running`, `ok`,
  `error`, `cancelled`.
- `TraceStore` (SQLite-backed):
  - `start_span(SpanStart)` / `end_span(id, SpanEnd)` — explicit spans;
  - `begin_scope` / `end_scope` / `scope_guard` — a per-run scope stack: any span
    started for the run without an explicit parent nests under the innermost
    scope, including v1 `open_span` callers;
  - `run_finisher(run_id)` — a drop guard that ends whatever run scope is active,
    for detached tasks that finish a run another function began;
  - `get_spans`, `get_tree` (`RunTraceTree` with waterfall offsets),
    `list_traces(TraceQuery)` (filter by run ids, agent, status, kind, time,
    search), `delete_spans`, `prune`;
  - `set_content_policy` / `set_content_policy_source` — `ContentPolicy`
    decides whether inputs/outputs are persisted (default: never) and caps them;
  - `set_sink(SpanSink)` — called once per ended span (Core's OTLP bridge).
- `hash_args(value)` — SHA-256 hex of the raw tool-input JSON.
- `export_presets` — `ExporterPreset` (`otlp`, `langfuse`, `langsmith`,
  `braintrust`, `phoenix`, `helicone`, `datadog`), `PresetSettings` →
  `ResolvedExport` (traces URL, headers, resource attributes), and
  `SecretReference` (`env:`, `file:`, `secret:`; literal credentials are
  rejected). No network I/O; live round-trips to the vendors are not exercised
  by the tests.

Persistent stores run a bounded retention pass when opened: 90 days and 1,000,000
spans by default. Set `RYU_TRACE_RETENTION_DAYS=0` or `RYU_TRACE_MAX_ROWS=0` to
disable one bound, or set a positive value to change it. `TraceStore::prune`
applies the same policy on demand. Opening a v1 database adds the hierarchical
columns in place; v1 rows stay readable with a derived status.

## Placement (why Core, not Gateway)

Span ordering and tool-call sequencing are *what ran* (orchestration) → Core.
Token counts and cost are *what is measured/paid* → Gateway audit. This store
deliberately holds **no** tokens/cost fields; `session_id` is the seam that links a
model-call span to the Gateway audit rows a viewer joins.
