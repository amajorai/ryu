import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = import.meta.dirname;
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	optimizeDeps: { esbuildOptions: { target: "esnext" } },
	base: "./",
	build: {
		emptyOutDir: true,
		outDir: path.resolve(harnessDir, "dist-advanced-inference-proof"),
		rollupOptions: {
			input: path.resolve(harnessDir, "advanced-inference-settings-proof.html"),
		},
		target: "chrome105",
	},
	clearScreen: false,
	css: {
		postcss: { plugins: [tailwindcss()] },
	},
	define: {
		"process.env": {},
	},
	plugins: [react()],
	resolve: {
		alias: { "@": desktopRoot },
	},
	root: harnessDir,
	server: {
		host: "127.0.0.1",
		port: 5197,
		strictPort: true,
	},
});
