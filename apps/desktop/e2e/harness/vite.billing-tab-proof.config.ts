import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-billing-tab-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["billing-tab-proof.html"],
		force: true,
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: {
			"@": desktopRoot,
			"@tauri-apps/plugin-store": path.resolve(
				harnessDir,
				"billing-tauri-store-fixture.ts"
			),
		},
	},
	root: harnessDir,
	server: {
		host: "127.0.0.1",
		port: 5343,
		strictPort: true,
	},
});
