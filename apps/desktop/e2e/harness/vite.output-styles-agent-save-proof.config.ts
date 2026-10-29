import { tmpdir } from "node:os";
import { defineConfig } from "vite";
import base from "./vite.rules-agent-edit-panel-proof.config.ts";
export default defineConfig({
	...base,
	cacheDir: `${tmpdir()}/ryu-output-styles-agent-save-vite-cache`,
	server: { host: "127.0.0.1", port: 5459, strictPort: true },

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
