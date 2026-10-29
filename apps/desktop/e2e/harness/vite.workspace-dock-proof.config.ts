import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { panelProofDependencyAliases } from "./panel-proof-dependency-aliases.ts";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-workspace-dock-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		include: ["react-compiler-runtime"],
		entries: ["workspace-dock-proof.html"],
		esbuildOptions: { target: "esnext" },
		force: true,
	},
	plugins: [
		react({
			exclude: [/\/node_modules\//, /\/ryu-workspace-dock-vite-cache\/deps\//],
		}),
	],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: [
			...panelProofDependencyAliases(import.meta.dirname),
			...Object.entries({ "@": desktopRoot }).map(([find, replacement]) => ({
				find,
				replacement,
			})),
		],
	},
	root: harnessDir,
	server: {
		host: "127.0.0.1",
		port: 5411,
		strictPort: true,
		hmr: false,
		watch: null,
	},
});
