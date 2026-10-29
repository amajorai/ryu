import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: import.meta.dirname,
	plugins: [react()],
	optimizeDeps: {
		entries: ["dev-reload-recovery-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: { "@": path.resolve(import.meta.dirname, "../..") },
	},
	server: { host: "127.0.0.1", port: 5198, strictPort: true },
});
