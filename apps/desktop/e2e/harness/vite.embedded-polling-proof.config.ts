import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
	plugins: [react()],
	root: import.meta.dirname,
	cacheDir: "/tmp/ryu-embedded-polling-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: {
		entries: ["embedded-polling-proof.html", "embedded-polling-child.html"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: { "@": path.resolve(import.meta.dirname, "../..") },
	},
	server: {
		host: "127.0.0.1",
		port: 5209,
		strictPort: true,
		cors: true,
		watch: null,
		hmr: false,
	},
});
