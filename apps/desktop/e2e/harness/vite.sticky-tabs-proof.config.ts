import path from "node:path";
import { defineConfig } from "vite";
import baseConfig from "./vite.tabs-layout-proof.config.ts";

export default defineConfig({
	...baseConfig,
	cacheDir: "node_modules/.vite-sticky-tabs",
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["sticky-tabs-proof.html", "sticky-settings-proof.html"],
	},
	server: {
		host: "127.0.0.1",
		port: 5197,
		strictPort: true,
		// A live source reload discards the open drawer and selected tab during
		// interaction proofs. Each run loads fresh source at its initial navigation.
		hmr: false,
	},
	build: {
		outDir: path.resolve(import.meta.dirname, "dist-sticky-tabs-proof"),
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "sticky-settings-proof.html"),
		},
	},
});
