import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const finalStepBuildDir = path.resolve(
	harnessDir,
	"../../../../tmp/ryu-onboarding-final-step-proof"
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
		outDir: finalStepBuildDir,
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "onboarding-final-step-story.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
