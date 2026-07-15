/**
 * __APP_DISPLAY_NAME__ — a Ryu App (interactive in-chat widget).
 *
 * A Ryu App bundles a "render" tool whose result mounts a self-contained widget
 * inline in the chat reply. This module is the AUTHORING source of truth: it uses
 * `defineApp` to assemble the `plugin.json` manifest that ships alongside it.
 *
 *   bun run src/app.ts     # prints the assembled manifest
 *   bunx ryu pack .        # bundles src/widget.tsx into ui_code + writes plugin.json
 *
 * v1 boundary: this is DECLARATIVE PASS-THROUGH only. There is no `run` handler —
 * the widget renders from `window.openai.toolInput` / `toolOutput` (the arguments
 * the model passed and the structured content Core echoes back). Third-party tool
 * CODE execution needs the plugin runtime, which is a later tier. Keep the widget
 * self-contained: no network fetches (the CSP blocks egress), assets inline.
 */

import { defineApp } from "@ryuhq/sdk";

const manifest = defineApp({
	id: "com.example.__APP_NAME__",
	title: "__APP_DISPLAY_NAME__",
	version: "0.1.0",
	slug: "__APP_NAME__",
	uiEntry: "src/widget.tsx",
	tools: [
		{
			name: "render",
			description:
				"Render the __APP_DISPLAY_NAME__ widget inline in the chat reply.",
			invoking: "Rendering…",
			invoked: "Ready",
			inputSchema: {
				type: "object",
				properties: {
					title: { type: "string", description: "Heading shown in the widget" },
					items: {
						type: "array",
						items: { type: "string" },
						description: "Rows to render",
					},
				},
				required: ["title"],
			},
		},
	],
});

export default manifest;

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
