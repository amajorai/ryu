import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	cacheDir: `${tmpdir()}/ryu-adjacent-agent-egress-vite-cache`,
	optimizeDeps: {
		entries: ["agent-egress-proof.html"],
		force: false,
		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	define: { "process.env": {} },
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	resolve: {
		alias: [{ find: "@", replacement: desktopRoot }],
	},
	server: {
		hmr: false,
		host: "127.0.0.1",
		port: 5384,
		strictPort: true,
	},
	preview: {
		host: "127.0.0.1",
		port: 5384,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(desktopRoot, "test-results/agent-egress-harness"),
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "agent-egress-proof.html"),
		},
	},
});
