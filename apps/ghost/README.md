# Ghost

> A desktop-automation MCP server: screen perception and input control. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-MCP-dea584.svg?logo=rust&logoColor=white)](../../README.md)

Ghost is a Rust MCP server that gives an agent eyes and hands on the desktop — 30 tools for screen capture/OCR, UI element detection, mouse/keyboard control, and token-efficient `@eN` element refs (`ghost_snapshot` captures a skeleton once; `ghost_click`/`ghost_type` act on a ref). It is Windows-first and speaks the Model Context Protocol over stdio. Within Ryu it is callable via Core's MCP registry (`POST /api/mcp/tools/call`) and is not surfaced in the desktop UI.

**Tier:** OSS, self-hostable — Apache-2.0

## Stack

- Rust, MCP over stdio (no port)
- `ghost-core`, `ghost-eyes`, `ghost-hands` workspace crates
- `image` / `imageproc` for capture and processing; optional `ort` (ONNX Runtime) for vision models
- Windows API bindings (`windows`) for window management

## Run standalone

```bash
# From this directory
cargo build --release           # produces the `ghost` binary in target/release

# Optional: enable ONNX-backed vision models
cargo build --release --features ort

./target/release/ghost          # a stdio MCP server — speaks JSON-RPC on stdin/stdout
```

Ghost is a stdio MCP server, so it has no network port. Launch it from any MCP-capable client (or let Ryu Core spawn it as a sidecar). Configuration and cache live under `~/.ghost/`.

## What it does

- **Screen perception** — capture, OCR text location, and UI element detection
- **Input control** — click, type, scroll, drag, and wait-for-condition
- **Annotation + recipes** — visual markers and replayable action sequences
- **Multi-monitor** capture with region selection

## Dual-use disclosure

Screen perception plus synthetic input control are exactly the capabilities malware wants. Ghost is published open-source precisely so the behaviour is auditable, not opaque. Inside Ryu it runs only behind explicit user consent; if you embed it elsewhere, gate it behind clear consent and treat it as a sensitive capability.

## Credits

Ghost is derived from [Ghost OS](https://github.com/ghostwright/ghost-os) by Ghostwright, which is MIT-licensed. The original copyright and license notice are retained in [NOTICE](./NOTICE).

## License

Apache-2.0 — see [LICENSE](./LICENSE), with MIT-licensed portions from Ghost OS per [NOTICE](./NOTICE). © 2026 A Major Pte. Ltd.
