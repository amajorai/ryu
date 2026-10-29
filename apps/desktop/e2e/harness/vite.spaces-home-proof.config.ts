import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	root: import.meta.dirname,
	cacheDir: "/tmp/ryu-spaces-home-proof-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["spaces-home-proof.html"],
		include: ["lucide-react"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: { "@": path.resolve(import.meta.dirname, "../..") },
	},
	build: {
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "spaces-home-proof.html"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5222,
		strictPort: true,
		watch: null,
	},
});
