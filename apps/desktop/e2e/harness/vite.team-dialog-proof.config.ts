import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	clearScreen: false,
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: { alias: { "@": desktopRoot } },
	server: { host: "127.0.0.1", port: 5383, strictPort: true },
	preview: { host: "127.0.0.1", port: 5383, strictPort: true },
	build: {
		outDir: path.resolve(desktopRoot, "test-results/team-dialog-harness"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "team-dialog-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
