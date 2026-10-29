import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-gateway-inline-evaluator-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["gateway-inline-evaluator-editor-proof.html"],
		force: false,

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	root: harnessDir,
	server: {
		hmr: false,
		host: "127.0.0.1",
		port: 5341,
		strictPort: true,
	},
});
