import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-memory-settings-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["memory-settings-proof.html"],
		force: true,
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: { alias: { "@": desktopRoot } },
	root: harnessDir,
	// Search/persistence proofs exercise one launched snapshot, not hot reload.
	server: { watch: null, host: "127.0.0.1", port: 5395, strictPort: true },
});
