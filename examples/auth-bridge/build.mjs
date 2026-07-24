// Build the installable plugin bundle: inline `backend.js` as the manifest's
// `backend_code` and stamp its sha256 as `backend_sha256`.
//
// Core integrity-checks the bundle against that hash at spawn, and the install door
// refuses a mismatch (422), so the two must be generated together. Never hand-edit
// manifest.json.
//
//   bun examples/auth-bridge/build.mjs
//   node examples/auth-bridge/build.mjs

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const PLUGIN_ID = "com.example.chatgpt-bridge";
const ENTRY = "./backend.js";
/** Loopback port the sidecar listens on. Must not collide with another sidecar. */
const PORT = 7997;

const code = await readFile(join(here, "backend.js"), "utf8");
const sha256 = createHash("sha256").update(code, "utf8").digest("hex");

const manifest = {
	id: PLUGIN_ID,
	name: "ChatGPT subscription bridge (example)",
	version: "1.0.0",
	description:
		"Reference auth bridge: serves a ChatGPT (Codex) subscription as an OpenAI-compatible endpoint.",
	runnables: [],
	// storage:kv is not used by this reference, but a bridge that stores its own
	// credential instead of riding auth.json needs it. sidecar:process is required for
	// any Community-tier plugin to spawn a managed process at all.
	permission_grants: ["sidecar:process"],
	backend_code: code,
	backend_sha256: sha256,
	sidecars: [
		{
			name: "bridge",
			process: { kind: "node", entry: ENTRY },
			port: PORT,
			health_path: "/health",
			http: {
				routes: [
					{ path: "/v1/models" },
					{ path: "/v1/chat/completions" },
					{ path: "/status" },
				],
			},
			// No host_api grants: this reference never calls ctx.host.call(). A bridge that
			// persists its credential through Core storage would declare ["storage:kv"].
			host_api: { grants: [] },
			// Declares this sidecar as a model provider. Core registers it once the
			// process reports healthy and removes it again on stop, so no manual
			// registration step is needed. The id may not collide with a built-in.
			provides_provider: {
				id: "chatgpt-bridge",
				label: "ChatGPT (subscription bridge)",
				api: "openai-completions",
				base_path: "/v1",
				models: ["gpt-5", "gpt-5-codex"],
			},
		},
	],
};

const out = join(here, "manifest.json");
await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

process.stdout.write(
	`wrote ${out}\n  id     ${PLUGIN_ID}\n  port   ${PORT}\n  sha256 ${sha256}\n`
);
