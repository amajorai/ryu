A durable pause/human-in-the-loop gate — the **Temporal Signal /
Restate Durable Promise** analogue (an external trigger resumes a
suspended run). When the executor reaches this node it suspends the run
(setting status to `AwaitingInput`) and persists to disk. The run resumes
when an external actor calls the resume endpoint
(`POST /workflows/runs/:run_id/resume`) with a payload; the payload
becomes the node's output and execution continues downstream. A suspend
is never treated as a retryable error, so a `retry` policy on this node
does not re-fire the gate.

# Core-vs-Gateway

This node decides *what runs* (suspend vs continue) — it lives in Core.
Whether the resumed action is *allowed* is a Gateway concern and is
evaluated when the resumed step makes its model/tool call.

# Restate mapping

In a Restate-backed deployment this node maps to a Restate Awakeable: the
executor registers an Awakeable ID, suspends until the ID is completed by
the resume endpoint calling the Restate `awakeable/resolve` API. In the
`FallbackEngine` (default, no Restate) the same semantics are achieved via
the file-backed run store: the run is persisted with `status =
awaiting_input` and resumed by re-invoking `run_workflow` after the gate's
persisted state is flipped to `Completed`.
