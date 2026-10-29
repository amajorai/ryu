import path from "node:path";
import { defineConfig } from "vite";
import base from "./vite.voice-mode-call-proof.config.ts";

export default defineConfig({
	...base,
	cacheDir: path.resolve(
		import.meta.dirname,
		"../../node_modules/.vite-icon-updates-proof"
	),
	optimizeDeps: { esbuildOptions: { target: "esnext" } },
	build: {
		...base.build,
		target: "esnext",
		outDir: path.resolve(import.meta.dirname, "dist-icon-updates-proof"),
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "icon-updates-proof.html"),
		},
	},
});
