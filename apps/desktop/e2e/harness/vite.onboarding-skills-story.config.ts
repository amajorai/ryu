import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const buildDir = path.resolve(
	harnessDir,
	"../../../../tmp/ryu-onboarding-skills-proof"
);

export default defineConfig({
	base: "./",
	build: {
		emptyOutDir: true,
		outDir: buildDir,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "onboarding-skills-story.html"),
		},
	},
	clearScreen: false,
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	plugins: [react()],
	publicDir: path.resolve(harnessDir, "../../public"),
	resolve: {
		alias: {
			"@": path.resolve(harnessDir, "../.."),
		},
	},
	root: harnessDir,

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
