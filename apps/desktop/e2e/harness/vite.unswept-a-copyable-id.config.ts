import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

// Mutation runs only: serve a scratch body (under /tmp) at one shipping module
// path, so a mutant is exercised without editing the shipping file.
function scratchOverride(): Plugin | null {
	const target = process.env.RYU_UNSWEPT_A_OVERRIDE_TARGET;
	const file = process.env.RYU_UNSWEPT_A_OVERRIDE_FILE;
	if (!(target && file)) {
		return null;
	}
	return {
		enforce: "pre",
		load(id) {
			return id.split("?")[0] === target ? readFileSync(file, "utf8") : null;
		},
		name: "unswept-a-scratch-override",
	};
}

export default defineConfig({
	plugins: [scratchOverride(), react()],
	base: "./",
	cacheDir: process.env.RYU_UNSWEPT_A_VITE_CACHE ?? "/tmp/unswept-a-pw/vite",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
		"import.meta.env.DEV": "false",
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["unswept-a-copyable-id.html"],
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{ find: "@", replacement: desktopRoot },
			{
				find: "react",
				replacement: path.resolve(desktopRoot, "node_modules/react"),
			},
			{
				find: "react-dom",
				replacement: path.resolve(desktopRoot, "node_modules/react-dom"),
			},
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5871,
		strictPort: true,
	},
});
