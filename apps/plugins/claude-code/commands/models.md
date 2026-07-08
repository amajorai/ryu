---
description: Search Ryu's model catalog and optionally activate a local model.
argument-hint: [search query, e.g. "qwen3 coder"]
---

Help the user find and serve a local model on their Ryu node. Query: `$ARGUMENTS`

1. If a query was given, call `ryu_search_models` with it (limit 10). If not, call `ryu_get_active_model` first and show what is already serving, then ask what they want to search for.
2. Present the top matches as a short list: repo id, rough size, and device-fit if reported. Do not paste raw JSON.
3. If the user picks one to run, call `ryu_set_active_model` with its `modelId`. The model must already be installed on the node; if activation reports it is not installed, tell the user to install it from the Ryu desktop model store or via the models REST surface, and offer the `ryu-local-model` skill.
4. After activating, call `ryu_get_active_model` to confirm the switch took effect.

Never invent model ids. Only activate ids that came back from `ryu_search_models` or that the user typed explicitly.
