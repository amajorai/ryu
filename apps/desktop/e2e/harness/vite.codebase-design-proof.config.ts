import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: import.meta.dirname,
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	resolve: { alias: { "@": path.resolve(import.meta.dirname, "../..") } },
	optimizeDeps: {
		entries: ["codebase-design-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { host: "127.0.0.1", port: 5198, strictPort: true, watch: null },
});
