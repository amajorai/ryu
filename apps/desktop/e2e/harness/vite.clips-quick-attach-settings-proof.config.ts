import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["clips-quick-attach-settings-proof.html"],
	},
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
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
		hmr: false,
		host: "127.0.0.1",
		port: 5238,
		strictPort: true,
	},
});
