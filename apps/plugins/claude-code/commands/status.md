---
description: Show the health and status of the connected Ryu Core node.
---

Report the current state of the user's Ryu node. Do this in order and keep it tight:

1. Call `ryu_health`. If it errors, tell the user Ryu Core is not reachable, show the target URL, and point them at `/ryu:setup`. Stop here on failure.
2. Call `ryu_system_status` for the active engine, whether it is running, sidecars, gateway reachability, and mesh.
3. Call `ryu_get_active_model` for the model the local chat stack is serving.
4. Call `ryu_system_info` for a one-line hardware summary (CPU, RAM, GPU/VRAM).

Summarize as a short status block: node reachable (yes/no), active model, active engine + running state, gateway reachable, and the hardware headline. Do not dump raw JSON unless the user asks.
