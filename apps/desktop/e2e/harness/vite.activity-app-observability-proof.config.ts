import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);

export default defineConfig({
	base: "./",
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	plugins: [react()],
	optimizeDeps: {
		entries: ["activity-app-observability-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: { alias: { "@": path.resolve(harnessDir, "../..") } },
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5190, strictPort: true },
});
