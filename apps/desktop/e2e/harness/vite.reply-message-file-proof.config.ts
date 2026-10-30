import path from "node:path";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import base from "./vite.harness.config.ts";

// The file:// suite needs one self-contained page, with the same aliases and
// CSS pipeline as the shared harness. Build only its actual production graph.
export default defineConfig({
	...base,
	plugins: [...(base.plugins ?? []), viteSingleFile()],
	build: {
		// The shared harness's target: the transcript graph ships top-level await
		// and destructuring the default browser target cannot lower.
		target: base.build?.target,
		outDir: path.resolve(import.meta.dirname, "dist"),
		emptyOutDir: false,
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "reply-message-proof.html"),
		},
	},
});
