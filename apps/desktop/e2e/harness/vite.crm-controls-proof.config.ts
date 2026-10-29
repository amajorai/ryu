import { tmpdir } from "node:os";
import { defineConfig } from "vite";
import config from "./vite.crm-record-table-proof.config.ts";
export default defineConfig({
	...config,
	cacheDir: `${tmpdir()}/ryu-crm-controls-vite-cache`,
	server: { host: "127.0.0.1", port: 5347, strictPort: true },

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
