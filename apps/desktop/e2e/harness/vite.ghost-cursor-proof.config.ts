import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: path.resolve(desktopRoot, "node_modules/.vite/ghost-cursor-proof"),
	plugins: [react()],
	root: harnessDir,
	clearScreen: false,
	define: { "process.env": {} },
	publicDir: false,
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			react: path.resolve(desktopRoot, "node_modules/react"),
			"react-dom": path.resolve(desktopRoot, "node_modules/react-dom"),
		},
	},
	optimizeDeps: {
		entries: [path.resolve(harnessDir, "ghost-cursor-proof.html")],

		esbuildOptions: { target: "esnext" },
	},
	server: {
		host: "127.0.0.1",
		port: 5190,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-ghost-cursor-proof"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "ghost-cursor-proof.html"),
		},
	},
});
