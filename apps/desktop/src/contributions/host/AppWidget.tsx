// Re-export shim. The widget renderer now lives in
// @ryu/blocks/desktop/agent-elements/app-widget so the island mini-chat mounts the
// SAME component the desktop chat does — a widget part must not render one way
// here and another way there.
//
// The two shell-specific facts it used to import from this app (Tauri's
// `openExternal`, the active node's origin) now arrive as `env` on the
// `WidgetHostContext` value ChatPage provides.

export { AppWidget } from "@ryu/blocks/desktop/agent-elements/app-widget.tsx";
