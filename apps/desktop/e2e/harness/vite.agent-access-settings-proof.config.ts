import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const repositoryRoot = path.resolve(desktopRoot, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-agent-access-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["agent-access-settings-proof.html"],
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: {
			"@": desktopRoot,
			react: path.resolve(desktopRoot, "node_modules/react"),
			"react-dom": path.resolve(desktopRoot, "node_modules/react-dom"),
		},
		dedupe: ["react", "react-dom"],
	},
	root: harnessDir,
	server: {
		fs: { allow: [repositoryRoot] },
		host: "127.0.0.1",
		port: 5388,
		strictPort: true,
	},
});
