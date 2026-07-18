# ryu-hardware

Ryu Hardware Protocol (RHP v1) node backend — an extracted **Core capability crate**.
It is the node half of the protocol in `apps/hardware/PROTOCOL.md`: Ryu devices
(watch / necklace / desk, all ESP32-S3) talk to a node over a WebSocket, either
directly over WiFi (Mode B) or tunneled through the mobile app over BLE (Mode A,
transparent to the node).

## Role in the decomposition

A primitive lifted out of `apps/core`. It owns the paired-device registry, token
lifecycle, the audio codec edge, the per-connection realtime session state machine,
the display-nudge loop, and the device-registry + TRMNL display HTTP surface. The crate
has **zero dependency on `apps/core`** (it depends only on the `ryu-dashboards` and
`ryu-meetings` app-store backends for the display + ambient-meeting bridges).

## Layout / key modules

- `protocol` — serde structs/enums mirroring PROTOCOL.md §3 (the wire contract shared
  by the firmware and mobile relay).
- `store` — device registry (SQLite): paired devices, per-device revocable Bearer
  tokens, last-seen/battery presence. `DeviceStore`, `DeviceRecord`, `hash_token`.
- `pairing` — pairing-nonce verification and token issuance.
- `codec` — the Opus/WAV codec edge, so the rest of Core sees PCM/WAV.
- `session` — the realtime session state machine (audio buffering + ambient meetings
  bridge), the live device-sender registry, `HardwareSession`, `TurnInput`,
  `SessionOutput`.
- `nudge` — the live display-nudge loop (dashboard change → device re-poll).
- `api` — device-registry CRUD (`/`, `/:device_id`) + TRMNL display
  (`/:device_id`, `/:device_id/image`) axum router.

## What stays Core-side (consumers of this crate's types)

The **public ws/pair ingress route** (a per-device Bearer/nonce that the global
`RYU_TOKEN` `require_auth` cannot gate, plus mesh/SSRF-guarded node-URL resolution) and
the **chat-turn orchestration** (welded to Core's `run_text_turn` / voice ASR / TTS
session loop) stay in `apps/core` and consume this crate's `session`/`protocol` types.

## Placement (Core vs Gateway)

The device registry, token lifecycle, and realtime session decide *what runs* → Core.

## Consumed as

Compiled-into-core crate (non-optional path dependency): the codec is reused by the
voice module and the store backs `ServerState` in every build.
