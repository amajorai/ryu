# <img src="https://raw.githubusercontent.com/amajorai/ryu/main/.github/logo.png" width="50" align="middle" alt="" />&nbsp; ghost-eyes

> Cross-platform screen-perception (vision) crate for desktop automation. Part of [Ryu](../../README.md).

[![License](https://shieldcn.dev/badge/License-Apache--2.0-73DC8C.svg?logo=apache&logoColor=white)](./LICENSE)
[![Stack](https://shieldcn.dev/badge/Rust-Crate-dea584.svg?logo=rust&logoColor=white)](../../README.md)

`ghost-eyes` is the perception half of Ryu's desktop automation: screen capture, window enumeration, accessibility-tree reads, and input monitoring. It gives an agent everything it needs to see what is on screen. It is cross-platform (Windows via Win32, macOS via Core Graphics + objc2, Linux via x11rb/evdev/AT-SPI2) with the backend selected at compile time, and is shared by both the Ghost and Shadow apps.

**Tier:** OSS, Apache-2.0 (MIT-derived from Ghost OS; see [NOTICE](./NOTICE))

## Install / Build

```bash
cargo build -p ghost-eyes
```

## What it provides

- **Screen capture** (`screen.rs`): `ScreenCapture`, `Frame`, `DisplayInfo`, `quick_screenshot`, `get_primary_display_size`.
- **Window tracking** (`window.rs`): `WindowTracker`, `WindowInfo`, `AppInfo`.
- **Accessibility** (`accessibility.rs`): `AXTree`, `AXTreeNode`, `Bounds` for UI-tree perception.
- **Input monitoring** (`input.rs`): `InputMonitor`, `InputEvent` observation.
- Per-platform backends (Win32 / Core Graphics / X11 + AT-SPI2) behind one trait surface.

## License

Apache-2.0; see [LICENSE](./LICENSE). Incorporates MIT-licensed portions of [Ghost OS](https://github.com/ghostwright/ghost-os); see [NOTICE](./NOTICE). © 2026 A Major Pte. Ltd.
