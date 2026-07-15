/**
 * __APP_DISPLAY_NAME__ — a turn-hook plugin.
 *
 * A turn hook is server-side logic Core runs after each assistant turn, inside its
 * capability-gated plugin sandbox (`apps/core/src/plugin_host/`). The hook sees a
 * `ctx` (agent, conversation, transcript, flags) and a `host` bridge (logging,
 * `sideModel`, namespaced `storage`), and returns a directive:
 *   - `{ kind: "none" }`            — do nothing
 *   - `{ kind: "note", text }`      — attach an out-of-band note to the turn
 *   - `{ kind: "continue", text }`  — feed text back for another assistant turn
 *
 * This is the SAME shape the built-in double-check / goal / advisor plugins use.
 * The `run` body must be SELF-CONTAINED: it executes in a fresh sandbox with only
 * `ctx` and `host` in scope, so it cannot capture imports, closures, or module
 * variables — reference only `ctx`, `host`, and language built-ins.
 *
 *   bun run src/plugin.ts   # prints the assembled manifest
 *   bunx ryu pack .         # serializes the hook + writes plugin.json
 */

import { definePlugin, defineTurnHook } from "@ryuhq/sdk";

const manifest = definePlugin({
	id: "com.example.__APP_NAME__",
	name: "__APP_DISPLAY_NAME__",
	version: "0.1.0",
	grants: [],
	composerControls: [
		{ id: "hook.toggle", type: "toggle", flag: "com.example.__APP_NAME__" },
	],
	turnHooks: [
		defineTurnHook({
			id: "flag-terse",
			run: (ctx, host) => {
				const last = ctx.transcript.at(-1);
				if (
					last &&
					last.role === "assistant" &&
					last.content.trim().length < 40
				) {
					host.log("terse reply flagged");
					return {
						kind: "note",
						text: "That reply looked brief — want more detail?",
					};
				}
				return { kind: "none" };
			},
		}),
	],
});

export default manifest;

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
