import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	cacheDir: `${tmpdir()}/ryu-desktop-general-settings-vite-cache`,
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["desktop-general-settings-proof.html"],
		force: true,
	},
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
		host: "127.0.0.1",
		port: 5201,
		strictPort: true,
	},
});
