import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-island-settings-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["island-settings-proof.html"],
		force: true,
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		// Ordered: the release-gate override must match before the "@" prefix.
		alias: [
			{
				find: /^.*\/lib\/island-availability\.ts$/,
				replacement: path.resolve(harnessDir, "island-availability-enabled.ts"),
			},
			{ find: "@", replacement: desktopRoot },
			{
				find: "@tauri-apps/plugin-store",
				replacement: path.resolve(harnessDir, "tauri-store-fixture.ts"),
			},
		],
	},
	root: harnessDir,
	server: {
		// Keep the launched proof snapshot stable through debounced writes.
		watch: null,
		host: "127.0.0.1",
		port: 5342,
		strictPort: true,
	},
});
