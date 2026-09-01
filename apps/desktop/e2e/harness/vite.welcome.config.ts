import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
// Runtime proof tests build from the source entrypoint into the ignored
// repository tmp directory so Vite never writes hashed build output into the
// checked-in harness source tree.
const welcomeBuildDir = path.resolve(
	harnessDir,
	"../../../../tmp/ryu-welcome-proof"
);

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	base: "./",
	clearScreen: false,
	publicDir: path.resolve(harnessDir, "../../public"),
	resolve: {
		alias: {
			"@": path.resolve(harnessDir, "../.."),
		},
	},
	build: {
		outDir: welcomeBuildDir,
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "welcome-step-story.html"),
		},
	},
});
