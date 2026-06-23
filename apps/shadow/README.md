# Shadow

> A device-bound capture and context engine with semantic memory. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Axum-dea584.svg?logo=rust&logoColor=white)](../../README.md)

Shadow is a Rust HTTP service (~23k LOC) that captures screen, audio, and input, runs OCR, drives a proactive suggestion engine, and indexes everything into a semantic memory you can search. It records keyframes as JPEGs through a pure-Rust path (no ffmpeg needed) and pulls in passive context from the clipboard, filesystem, git, terminal, notifications, and calendar. Capture is always consent-gated.

**Tier:** OSS, self-hostable — Apache-2.0

## Stack

- Rust + Axum (with WebSocket)
- `shadow-core` plus the `ghost-core` / `ghost-eyes` / `ghost-hands` workspace crates
- `cpal` (audio), `image` (capture/keyframes), `rusqlite` (bundled SQLite storage)
- Optional: `ort` (ONNX Runtime) + `whisper-rs` via the `full` feature; `ffmpeg-next` via the `video` feature

## Run standalone

```bash
# From this directory
cargo build --release           # produces the `shadow` binary in target/release

# Optional: vision + Whisper transcription
cargo build --release --features full
# Optional: H.265 MP4 video on top of the default JPEG keyframes
cargo build --release --features video

./target/release/shadow         # binds :3030 by default
```

Capture data is stored under `~/.ryu/shadow/`. The default build records JPEG keyframes with no system dependencies; the optional `video` feature adds full H.265 MP4.

## What it does

- **Capture** — screen, microphone/system audio, input events, window focus, and accessibility data
- **Keyframes** — pure-Rust JPEG keyframes written on change (no ffmpeg)
- **Passive sources** — clipboard, filesystem, git, terminal, notifications, calendar
- **Intelligence** — OCR, embeddings, context grounding, meeting detection, proactive suggestions
- **Memory** — semantic memory with consolidation and query planning, searchable end-to-end
- **Consent gates** — per-app allowlist and a global pause; nothing is captured unless allowed

## Dual-use disclosure

Continuous screen and audio capture is inherently sensitive. Shadow is designed as a device-bound sensor: it always runs locally, never routes capture off-device, and gates every source behind explicit consent and a pause control. It is open-source so this behaviour is fully auditable. If you self-host it, keep the capture device-local and consent-gated.

## Credits

Shadow is derived from [Shadow](https://github.com/ghostwright/shadow) by Ghostwright, which is MIT-licensed. The original copyright and license notice are retained in [NOTICE](./NOTICE).

## License

Apache-2.0 — see [LICENSE](./LICENSE), with MIT-licensed portions from Shadow per [NOTICE](./NOTICE). © 2026 A Major Pte. Ltd.
