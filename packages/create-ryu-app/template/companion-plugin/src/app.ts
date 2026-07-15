/**
 * __APP_DISPLAY_NAME__ — a companion Ryu App (widget + a callable companion tool).
 *
 * This template goes one step past the plain Ryu App: besides the "render" tool
 * that mounts the widget, it declares a `save` tool marked `accessible: true` — a
 * COMPANION the mounted widget may invoke over the capability-gated bridge:
 *
 *     await window.openai.callTool("__APP_NAME____save", { state })
 *
 * The host routes that call through the Gateway (allowlist + audit) before it
 * reaches Core; the frame never holds a token. It also declares a full-page
 * `companion` surface (an in-desktop panel) whose label is a fixed literal so it
 * can never impersonate first-party Ryu/system chrome.
 *
 *   bun run src/app.ts     # prints the assembled manifest
 *   bunx ryu pack .        # bundles src/widget.tsx into ui_code + writes plugin.json
 *
 * v1 boundary: DECLARATIVE PASS-THROUGH only — there is no `run` handler for the
 * tools. The render widget draws from `window.openai.toolInput` / `toolOutput`;
 * the `save` companion is a call target (its handler is the serialized apps/core
 * tool-exec slice, not shipped here). Keep the widget self-contained: no network.
 */

import { defineApp, type PluginManifest } from "@ryuhq/sdk";

const app = defineApp({
	id: "com.example.__APP_NAME__",
	title: "__APP_DISPLAY_NAME__",
	version: "0.1.0",
	slug: "__APP_NAME__",
	uiEntry: "src/widget.tsx",
	tools: [
		{
			name: "render",
			description: "Render the interactive panel inline in the chat reply.",
			invoking: "Rendering…",
			invoked: "Ready",
		},
		{
			name: "save",
			description:
				"Persist the panel's current state. Callable by the mounted widget via callTool.",
			accessible: true,
			inputSchema: {
				type: "object",
				properties: { state: { type: "object" } },
				required: ["state"],
			},
		},
	],
});

// `defineApp` models the render/companion tool split but not the full-page
// companion SURFACE, so add it here. The label is a fixed literal that passes the
// anti-impersonation refine (must not contain "ryu" or "system").
const manifest: PluginManifest = {
	...app,
	companion: { label: "App Panel", icon: "sidebar", shortcut: "ctrl+shift+p" },
};

export default manifest;

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
