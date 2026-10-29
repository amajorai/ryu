import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import base from "./vite.desktop-general-settings-proof.config.ts";

const output = process.env.RYU_GENERAL_SETTINGS_DIST;
if (!(output && path.isAbsolute(output))) {
	throw new Error("Explicit absolute RYU_GENERAL_SETTINGS_DIST required");
}
export default defineConfig(
	mergeConfig(base, {
		build: {
			outDir: output,
			emptyOutDir: true,
			minify: false,
			sourcemap: false,
			target: "esnext",
			rollupOptions: {
				input: path.resolve(
					import.meta.dirname,
					"desktop-general-settings-proof.html"
				),
			},
		},
	})
);
