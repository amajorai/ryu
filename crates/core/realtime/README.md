# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ryu-realtime

> Room-keyed realtime fan-out primitive for Ryu. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ryu-realtime` is the transport-agnostic fan-out core (Phase 1 of the multi-user collaboration epic) that chat fan-out, CRDT doc-sync, and presence/awareness all consume. It knows nothing about WebSockets, JWTs, or access control — those live in the Core WS handler that drives this registry.

## Shape

- **`RoomRegistry`** maps `room_id` → a `RoomHandle`. Each live room runs as **one tokio actor task** (`run_room`) that owns the room's ephemeral state (presence map + idle clock) behind a command channel, plus a bounded `tokio::sync::broadcast` sender for fan-out.
- **Membership** is reference-counted; `RoomHandle::join` returns a `RoomMembership` RAII guard whose `Drop` decrements the count, evicts the member's presence, and broadcasts a `presence_leave` delta — so a dropped socket is still reaped.
- **Hibernation** — a room idle beyond `RoomConfig::idle_window` exits its actor and leaves the registry, rehydrating on next join (the main scaling lever).
- **Race safety** — join's get-or-create + `fetch_add` and the actor's eviction recheck take the same registry `Mutex`, so no caller ever holds a handle to a dropped room.
- **Typed event contract** — the `Frame` enum over `Event` / `Presence` / `DocSync` channels; `publish_event` broadcasts, `subscribe` returns a droppable receiver (= unsubscribe handle).

## Role in the decomposition

An extracted Core capability crate consumed as a **non-optional in-process path dependency** — the chat fan-out path drives it directly, never over IPC. **ZERO dependency on `apps/core`**; it is a sibling to Core's `identity_verify`. The WS transport and any access control are the swap-seam boundary and stay Core-side.

Placement (CLAUDE.md §1): fan-out of live session state is *what runs*, so Core.

## Build

```bash
cargo build -p ryu-realtime
cargo test  -p ryu-realtime
```

## License

Apache-2.0; see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
