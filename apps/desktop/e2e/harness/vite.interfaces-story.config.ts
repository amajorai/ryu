import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	clearScreen: false,
	// `?chrome=1` mounts the desktop's host frame, whose modules read
	// `process.env` as the desktop build defines it.
	define: {
		"process.env": {},
	},
	resolve: {
		alias: {
			"@": desktopRoot,
		},
		dedupe: ["react", "react-dom", "three"],
	},
	server: {
		host: "127.0.0.1",
		port: 5747,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-interfaces-story"),
		emptyOutDir: true,
		target: "chrome105",
		rollupOptions: {
			input: path.resolve(harnessDir, "interfaces-story.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
