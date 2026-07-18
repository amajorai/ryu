# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ghost-hands

> Cross-platform synthetic input-control crate for desktop automation. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ghost-hands` is the action half of Ryu's desktop automation: synthesized keyboard, mouse click, scroll, and window control. It is cross-platform (Windows via Win32 SendInput, macOS via Core Graphics CGEvent, Linux via X11 XTEST/evdev) with the backend selected at compile time, and is shared by both the Ghost and Shadow apps.

> **Dual-use caution:** this crate drives real keyboard/mouse input; callers are responsible for consent-gating its use.

**Tier:** OSS, Apache-2.0 (MIT-derived from Ghost OS; see [NOTICE](./NOTICE))

## Install / Build

```bash
cargo build -p ghost-hands
```

## What it provides

- **Click** (`click.rs`): `mouse_click`, `hover`, `drag`, `long_press`, `MouseButton`.
- **Keyboard** (`keyboard.rs`): `type_text`, `press_key`, `send_hotkey`.
- **Scroll** (`scroll.rs`): `scroll`.
- **Window control** (`window.rs`): `focus_app`, `window_action`, `WindowAction`.
- Per-platform backends (Win32 / Core Graphics / X11 XTEST + evdev) behind one API. Functions are synchronous; callers wrap in `spawn_blocking` for async contexts.

## License

Apache-2.0; see [LICENSE](./LICENSE). Incorporates MIT-licensed portions of [Ghost OS](https://github.com/ghostwright/ghost-os); see [NOTICE](./NOTICE). © 2026 A Major Pte. Ltd.
