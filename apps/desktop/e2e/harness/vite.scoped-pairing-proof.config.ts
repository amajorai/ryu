import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mockModule = path.resolve(harnessDir, "scoped-pairing-proof.mock.ts");

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	resolve: {
		alias: [
			{ find: "@/src/hooks/useActiveNode.ts", replacement: mockModule },
			{ find: "@/src/lib/api/client.ts", replacement: mockModule },
			{ find: "@tauri-apps/api/core", replacement: mockModule },
			{ find: "@", replacement: desktopRoot },
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5231,
		strictPort: true,
	},
	preview: {
		host: "127.0.0.1",
		port: 5231,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(desktopRoot, "test-results/scoped-pairing-harness"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "scoped-pairing-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
