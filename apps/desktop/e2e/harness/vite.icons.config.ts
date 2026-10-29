import path from "node:path";
import { defineConfig, mergeConfig } from "vite";
import harness from "./vite.harness.config.ts";
export default mergeConfig(
	harness,
	defineConfig({
		build: {
			outDir: path.resolve(import.meta.dirname, "dist-icons"),
			rollupOptions: {
				input: path.resolve(import.meta.dirname, "app-icon-story.html"),
			},
		},
	})
);
