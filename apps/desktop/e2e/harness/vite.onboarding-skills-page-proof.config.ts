import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	base: "./",
	build: {
		emptyOutDir: true,
		outDir: path.resolve(
			harnessDir,
			"../../../../tmp/ryu-onboarding-skills-page-proof"
		),
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "onboarding-skills-page-proof.html"),
		},
	},
	clearScreen: false,
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
	},
	plugins: [react()],
	publicDir: false,
	resolve: {
		alias: {
			"@": path.resolve(harnessDir, "../.."),
		},
	},
	root: harnessDir,

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
