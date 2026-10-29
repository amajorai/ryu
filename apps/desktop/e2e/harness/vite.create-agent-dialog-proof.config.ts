import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@": desktopRoot,
			react: path.resolve(desktopRoot, "node_modules/react"),
			"react-dom": path.resolve(desktopRoot, "node_modules/react-dom"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5187,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-create-agent-dialog-proof"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "create-agent-dialog-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
