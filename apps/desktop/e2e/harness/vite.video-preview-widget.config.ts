import { tmpdir } from "node:os";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({
	root: import.meta.dirname,
	cacheDir: path.join(tmpdir(), "ryu-video-preview-widget-vite-cache"),
	plugins: [react(), viteSingleFile()],
	build: {
		outDir: path.join(tmpdir(), "ryu-video-preview-widget-build"),
		emptyOutDir: true,
		target: "esnext",
		cssCodeSplit: false,
		rollupOptions: {
			input: path.join(import.meta.dirname, "video-preview-widget.html"),
			output: { inlineDynamicImports: true },
		},
	},
});
