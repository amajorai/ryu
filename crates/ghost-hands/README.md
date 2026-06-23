# ghost-hands

> Synthetic input-control crate for desktop automation. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ghost-hands` is the action half of Ryu's desktop automation: synthesized keyboard, mouse click, scroll, and window control. It is cross-platform (Windows via the Win32 APIs, macOS via Core Graphics, Linux via x11rb/evdev) and is shared by both the Ghost and Shadow apps.

> **Dual-use caution:** this crate drives real keyboard/mouse input; callers are responsible for consent-gating its use.

**Tier:** OSS — Apache-2.0

## Install / Build

```bash
cargo build -p ghost-hands
```

## What it provides

- **Click** (`click.rs`), **keyboard** (`keyboard.rs`), and **scroll** (`scroll.rs`) input synthesis.
- **Window** control (`window.rs`).
- Per-platform backends (Win32 / Core Graphics / X11 / evdev) selected at compile time.

## License

Apache-2.0 — see [LICENSE](./LICENSE). © 2026 A Major Pte. Ltd.
