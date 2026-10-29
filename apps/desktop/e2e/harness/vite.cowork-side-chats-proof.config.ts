import { tmpdir } from "node:os";
// Focused proof of the production PinnedSummaryPanel and its shared Context rail.
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { panelProofDependencyAliases } from "./panel-proof-dependency-aliases.ts";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [
		react({
			exclude: [/\/node_modules\//, /\/ryu-cowork-pinned-vite\/deps\//],
		}),
	],
	cacheDir: `${tmpdir()}/ryu-cowork-pinned-vite`,
	base: "./",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			...panelProofDependencyAliases(import.meta.dirname),
			...Object.entries({
				"@": desktopRoot,
			}).map(([find, replacement]) => ({ find, replacement })),
		],
	},
	optimizeDeps: {
		include: ["react-compiler-runtime"],
		entries: [
			"cowork-side-chats-proof.html",
			"plan-pinned-summary-proof.html",
			"cowork-sources-story.html",
			"subagents-workspace-proof.html",
		].map((entry) => path.resolve(harnessDir, entry)),

		esbuildOptions: { target: "esnext" },
	},
	server: {
		host: "127.0.0.1",
		port: 5414,
		strictPort: true,
		hmr: false,
		watch: null,
	},
});
