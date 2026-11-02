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
		alias: [
			{ find: "@", replacement: desktopRoot },
			// One three.js for the logo scene and @react-three/*. `three` is a
			// @ryu/ui dependency, so `resolve.dedupe` (which resolves from the
			// harness root) cannot find it; point every bare import at that copy.
			{
				find: /^three$/,
				replacement: path.resolve(
					desktopRoot,
					"../../packages/ui/node_modules/three"
				),
			},
		],
		dedupe: ["react", "react-dom"],
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
