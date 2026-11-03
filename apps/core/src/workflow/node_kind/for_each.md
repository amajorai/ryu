Maps a body workflow over a JSON array (Mastra `foreach` / LangGraph
`Send` parity). `items` is a template resolved against the run context
(default `{{input}}`, e.g. `{{state.urls}}`) that must produce a JSON
array. Every element runs the body workflow as its own durable child run
with the run input `input` (string elements verbatim, other JSON as text)
and `index`. Up to `max_concurrency` items run at once (default
[`executor::DEFAULT_FANOUT_CONCURRENCY`], capped at
[`executor::MAX_FANOUT_CONCURRENCY`]).

The node output is a JSON array of the item results **in input order**
regardless of completion order. A result that is itself a JSON object or
array is embedded as JSON; anything else is embedded as a string. Each
finished item is checkpointed into the run state, so a resumed run (after
a restart, an approval gate inside an item, or a provider limit) skips
finished items and re-enters only the unfinished ones. A failed item
fails the node once the items already in flight have settled.
