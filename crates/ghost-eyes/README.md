# ghost-eyes

> Screen-perception (vision) crate for desktop automation. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ghost-eyes` is the perception half of Ryu's desktop automation: screen capture, window enumeration, and accessibility-tree reads that let an agent see what is on screen. It is cross-platform (Windows via the Win32 APIs, macOS via Core Graphics, Linux via x11rb) and is shared by both the Ghost and Shadow apps.

**Tier:** OSS — Apache-2.0

## Install / Build

```bash
cargo build -p ghost-eyes
```

## What it provides

- **Screen capture** (`screen.rs`) and **window** enumeration (`window.rs`).
- **Accessibility** reads (`accessibility.rs`) for UI-tree perception.
- **Input** observation helpers (`input.rs`).
- Per-platform backends (Win32 / Core Graphics / X11) selected at compile time.

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
