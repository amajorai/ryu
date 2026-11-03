Ping one or more org/workspace members (and teams) across their devices —
the app inbox, the desktop OS toast, and mobile push. `target` resolves to
a set of member user ids via the control plane (the node's bound org).

`ack_mode` decides the node's shape:
- `None` (default) → **fire-and-forget**: deliver, emit a JSON receipt as
  the node output, and continue downstream.
- `First | All | Quorum | Percentage` → **HITL gate**: deliver, then suspend the run
  (`AwaitingInput`) until the ack policy is met; each acking member's inbox
  Ack resumes the run once the threshold is reached.

`title`/`body` are templates (`{{input}}`, `{{nodes.<id>}}`,
`{{state.<key>}}`, `{{trigger.*}}`) resolved before delivery. Core decides
*what runs* (who to ping, whether to wait) → Core; the control plane owns
*who is a member* → resolved over the gateway key.
