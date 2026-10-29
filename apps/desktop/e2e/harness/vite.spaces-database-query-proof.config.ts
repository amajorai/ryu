import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	root: import.meta.dirname,
	cacheDir: path.resolve(
		import.meta.dirname,
		"../../../../target/spaces-database-query-proof-cache"
	),
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["spaces-database-query-proof.html"],
		include: ["lucide-react"],
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: { "@": path.resolve(import.meta.dirname, "../..") },
	},
	build: {
		rollupOptions: {
			input: path.resolve(
				import.meta.dirname,
				"spaces-database-query-proof.html"
			),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5226,
		strictPort: true,
		watch: null,
	},
});
