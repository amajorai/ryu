---
description: Ask the user's Ryu node a one-shot question (routed to its side-question model).
argument-hint: <question for Ryu>
---

Ask the connected Ryu node a single question and relay its answer. Question: `$ARGUMENTS`

1. If `$ARGUMENTS` is empty, ask the user what they want to ask Ryu, then stop.
2. Call `ryu_ask` with `question` set to the user's text. This routes to Ryu's side-question model with no tool access, so it is a fast, self-contained answer, not an agent run.
3. Relay Ryu's answer verbatim in a short quote block, then add your own one-line take only if it adds value.

This is a read-only question against Ryu's own model. It does not run a workflow or an agent. For those, use `/ryu:workflow` or the `ryu_list_agents` tool.
