import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	base: "/",
	clearScreen: false,
	define: {
		"process.env": {},
		process: JSON.stringify({ env: {} }),
	},
	publicDir: path.resolve(harnessDir, "../../public"),
	resolve: {
		alias: {
			"@": path.resolve(harnessDir, "../.."),
		},
	},
	optimizeDeps: {
		entries: ["ryu-personalization-proof.html"],

		esbuildOptions: { target: "esnext" },
	},
});
