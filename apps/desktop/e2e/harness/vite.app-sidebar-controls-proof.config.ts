import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	root: import.meta.dirname,
	cacheDir: "/tmp/ryu-app-sidebar-controls-proof-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["app-sidebar-controls-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: { "@": path.resolve(import.meta.dirname, "../..") },
	},
	build: {
		rollupOptions: {
			input: path.resolve(
				import.meta.dirname,
				"app-sidebar-controls-proof.html"
			),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5236,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
