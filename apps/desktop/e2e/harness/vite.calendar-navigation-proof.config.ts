import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
	root: import.meta.dirname,
	cacheDir: `${tmpdir()}/ryu-calendar-navigation-vite`,
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	resolve: {
		alias: { "@": path.resolve(import.meta.dirname, "../..") },
		dedupe: ["react", "react-dom"],
	},
	optimizeDeps: {
		entries: ["calendar-navigation-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { hmr: false, host: "127.0.0.1", port: 5391, strictPort: true },
});
