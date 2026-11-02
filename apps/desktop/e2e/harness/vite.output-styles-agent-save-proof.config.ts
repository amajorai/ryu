import { tmpdir } from "node:os";
import { defineConfig } from "vite";
import base from "./vite.rules-agent-edit-panel-proof.config.ts";
export default defineConfig({
	...base,
	cacheDir: `${tmpdir()}/ryu-output-styles-agent-save-vite-cache`,
	server: { host: "127.0.0.1", port: 5459, strictPort: true },
	// Keep the base config's scan entry: without it Vite scans every harness page,
	// that scan fails on unrelated stories, and late dependency discovery reloads
	// the page mid-navigation.
});
