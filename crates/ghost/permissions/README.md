# ghost-permissions

The single source of truth for the OS capabilities the Ghost automation stack needs:
**Accessibility** (UI automation — accessibility-tree reads + synthetic input),
**Screen Recording** (visual grounding), and **Input Monitoring** (global keyboard/
mouse observation for Shadow capture + Ghost learn mode).

## Role in the decomposition

A tiny, shared **cross-platform primitive crate**. Every entry point that touches these
capabilities — the desktop app, the `ghost` CLI, Core, and the ghost/shadow sidecars —
depends on this crate, so there is exactly one implementation per platform and no
per-surface drift. It has no crate dependencies (macOS links AppKit/CoreGraphics/IOKit
frameworks directly via `#[link]`; Windows/Linux capabilities are ungated or
compositor-mediated).

## Key API

- `Capability` — `Accessibility` | `ScreenRecording` | `InputMonitoring`; `ALL` iterates
  them in a stable order for setup/doctor flows; `.label()` gives the System Settings name.
- `required(cap)` — whether this OS gates the capability behind a user grant at all.
- `granted(cap)` — current grant state; never prompts, safe to poll on a settings screen.
- `request(cap)` — surfaces the OS prompt and registers the process in the settings pane;
  a fresh grant only applies after a process restart.
- Ergonomic wrappers kept stable for existing callers: `accessibility_granted` /
  `request_accessibility`, `screen_recording_granted` / `request_screen_recording`,
  `input_monitoring_granted` / `request_input_monitoring`.

## Platform honesty

- **macOS** — gated behind TCC. `granted` maps to `AXIsProcessTrusted` /
  `CGPreflightScreenCaptureAccess` / `IOHIDCheckAccess`; `request` surfaces the system
  prompt. `required` is always true.
- **Windows** — no per-app grant for DXGI/GDI capture or UI Automation: `granted` true,
  `required` false.
- **Linux/X11** — no grant needed: `granted` true, `required` false. Under **Wayland**,
  capture/input go through compositor portals the X11 backend cannot drive, so `granted`
  false, `required` true (the user approves via their compositor's UI — no deep-link).

## Consumed as

Compiled-into-caller crate — a shared library dependency of ghost/shadow/core/desktop,
not a sidecar or service.
