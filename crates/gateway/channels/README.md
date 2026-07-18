# ryu-gw-channels

Ryu **Gateway** channel-layer engine — the external messaging-surface adapters, extracted into a
self-contained crate.

## What it is

The transport adapters that let a bot register once at the Gateway and converse over a chat surface:

- **Telegram** (`telegram`) — long-poll `getUpdates`.
- **Slack** (`slack`) — Socket Mode.
- **Discord** (`discord`) — gateway poll.
- **WhatsApp** (`whatsapp`) — inbound webhook.
- **`status`** — per-channel health/status reporting.

Every adapter shares one inbound path: `handle_message` runs the allowlist gate, builds the request
body (`build_request_body`), invokes the pipeline through the host seam, and extracts the reply
(`extract_reply`) for delivery back to the originating chat. `GroupReplyMode` (`Mentions` / `All`)
gates whether the bot answers in multi-user groups.

## Role in the decomposition

An **extracted gateway stage/engine crate** with a narrow **backend/host seam**: adapters implement
`Channel`; the Gateway implements `ChannelHost` (the pipeline call). Everything that needs the
Gateway's `SharedState` — the actual pipeline invocation, `RequestContext` construction,
control-plane store fetch, and channel registration/spawn wiring — **stays in `apps/gateway`**
("engine moves, wiring stays"). `spawn_channel` starts an adapter's inbound loop.

## Key API

- `Channel`, `ChannelHost` — the two traits.
- `InboundMessage`, `handle_message`, `build_request_body`, `extract_reply`, `spawn_channel`.
- `TelegramChannelConfig`, `SlackChannelConfig`, `DiscordChannelConfig`, `WhatsAppChannelConfig`
  (spawn-time adapter shapes; the config-file serde shapes stay in Gateway `config.rs`, which maps
  into these and re-exports `GroupReplyMode`).

## How it is consumed

Compiled **into the Gateway** binary (`apps/gateway`), which owns registration and spawns the
adapters. Not a sidecar.
