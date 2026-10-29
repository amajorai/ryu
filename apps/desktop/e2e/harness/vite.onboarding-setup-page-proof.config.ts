import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-onboarding-setup-page-vite-cache`,
	optimizeDeps: {
		entries: [
			"onboarding-setup-page-proof.html",
			"node-onboarding-settings-story.html",
		],
		force: false,

		esbuildOptions: { target: "esnext" },
	},
	server: { hmr: false },
	build: {
		emptyOutDir: true,
		outDir: path.resolve(
			harnessDir,
			"../../../../tmp/ryu-onboarding-setup-page-proof"
		),
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "onboarding-setup-page-proof.html"),
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
	publicDir: path.resolve(harnessDir, "../../public"),
	resolve: {
		alias: {
			"@": path.resolve(harnessDir, "../.."),
		},
	},
	root: harnessDir,
});
