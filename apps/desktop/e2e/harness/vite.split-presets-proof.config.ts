import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: {
		alias: {
			"@": desktopRoot,
			react: path.resolve(desktopRoot, "node_modules/react"),
			"react-dom": path.resolve(desktopRoot, "node_modules/react-dom"),
		},
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5208,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-split-presets-proof"),
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "split-presets-proof.html"),
		},
	},

	optimizeDeps: {
		entries: [path.resolve(harnessDir, "split-presets-proof.html")],
		esbuildOptions: { target: "esnext" },
	},
});
