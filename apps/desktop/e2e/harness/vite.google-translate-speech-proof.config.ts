import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.gateway-dialog-accounts-proof.config.ts";

export default mergeConfig(
	base,
	defineConfig({
		cacheDir: path.resolve(
			import.meta.dirname,
			"../../node_modules/.vite-google-translate-speech-proof"
		),
		optimizeDeps: { esbuildOptions: { target: "esnext" } },
		server: { host: "127.0.0.1", port: 5209, strictPort: true, hmr: false },
	})
);
