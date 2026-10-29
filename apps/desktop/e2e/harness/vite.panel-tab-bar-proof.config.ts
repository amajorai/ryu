import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-panel-tab-bar-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["panel-tab-bar-proof.html"],
		force: true,
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: { "@": desktopRoot },
		dedupe: ["react", "react-dom"],
	},
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5395, strictPort: true },
	build: { target: "esnext" },
});
