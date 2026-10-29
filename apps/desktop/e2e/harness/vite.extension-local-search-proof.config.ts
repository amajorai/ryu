import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const repoRoot = path.resolve(import.meta.dirname, "../../../../");

export default defineConfig({
	root: import.meta.dirname,
	build: {
		emptyOutDir: true,
		outDir: "/tmp/ryu-extension-local-search-proof",
		target: "esnext",
		rollupOptions: {
			input: path.resolve(
				import.meta.dirname,
				"extension-local-search-proof.html"
			),
		},
	},
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	plugins: [react()],
	resolve: {
		alias: {
			"@extension": path.resolve(repoRoot, "apps/extension"),
			"@ryu/blocks": path.resolve(repoRoot, "packages/blocks/src"),
			"@ryu/ui/globals.css": path.resolve(
				repoRoot,
				"packages/ui/src/styles/globals.css"
			),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5211,
		strictPort: true,
		watch: { ignored: ["**/dist/**", "**/.next/**"] },
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
