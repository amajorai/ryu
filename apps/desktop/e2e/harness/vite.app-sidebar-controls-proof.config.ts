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
		// Match the desktop webview target (vite.config.ts): the sidebar section
		// graph reaches @tauri-apps/plugin-store through useNodeStore, whose
		// `const [value, exists] = await …` esbuild cannot lower to Vite's
		// default es2020 browser targets, so the preview build failed.
		target: "chrome105",
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
