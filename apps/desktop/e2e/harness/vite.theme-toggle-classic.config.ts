import path from "node:path";
import { mergeConfig } from "vite";
import baseConfig from "./vite.harness.config.ts";

export default mergeConfig(baseConfig, {
	cacheDir: path.resolve(
		import.meta.dirname,
		"../../node_modules/.vite-theme-toggle-classic"
	),
	server: {
		host: "127.0.0.1",
		port: 5186,
		strictPort: true,
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
