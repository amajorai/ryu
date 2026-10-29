import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	root: import.meta.dirname,
	cacheDir: path.resolve(
		import.meta.dirname,
		"../../../../.audit/sign-in-copy-proof/vite-cache"
	),
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["sign-in-copy-proof.html"],
		exclude: ["@hugeicons/core-free-icons"],
		include: ["lucide-react"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@": path.resolve(import.meta.dirname, "../.."),
		},
	},
	build: {
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "sign-in-copy-proof.html"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5234,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
