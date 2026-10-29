import { tmpdir } from "node:os";
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
	cacheDir: `${tmpdir()}/ryu-desktop-shell-canvas-vite-cache`,
	optimizeDeps: {
		entries: ["desktop-shell-canvas-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
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
		port: 5418,
		strictPort: true,
	},
	build: {
		outDir: "/tmp/ryu-desktop-shell-canvas-proof-build",
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "desktop-shell-canvas-proof.html"),
		},
	},
});
