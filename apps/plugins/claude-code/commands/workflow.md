---
description: List Ryu workflows and run one by id.
argument-hint: [workflow id to run]
---

Run a workflow defined on the user's Ryu node. Target: `$ARGUMENTS`

1. Call `ryu_list_workflows`. Show the defined workflows as a short list: id, name, and a one-line purpose if present.
2. If `$ARGUMENTS` names a workflow id (or the user picks one), call `ryu_run_workflow` with that `id`. If the workflow needs inputs, gather them from the user first and pass them in the `input` map (string to string).
3. Report the returned run state. If it comes back `awaiting_input`, tell the user exactly what input the run is waiting on and how to resume it. Otherwise summarize the outcome.

Do not fabricate workflow ids. Only run ids returned by `ryu_list_workflows` or supplied by the user.
