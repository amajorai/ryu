import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	// Keep the dependency cache out of the checkout's node_modules.
	cacheDir:
		process.env.RYU_SETTINGS_DIALOG_SHELL_VITE_CACHE ??
		path.join(tmpdir(), "ryu-settings-dialog-shell-proof-vite"),
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["settings-dialog-shell-proof.html"],
	},
	resolve: {
		alias: { "@": desktopRoot },
	},
	server: {
		host: "127.0.0.1",
		port: 5237,
		strictPort: true,
		watch: null,
	},
});
