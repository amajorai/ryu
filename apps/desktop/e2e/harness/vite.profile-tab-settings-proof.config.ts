import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const repositoryRoot = path.resolve(desktopRoot, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	cacheDir: `${tmpdir()}/ryu-profile-tab-settings-vite-cache`,
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["profile-tab-settings-proof.html"],
		force: true,
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: "@/lib/auth-client.ts",
				replacement: path.resolve(
					harnessDir,
					"profile-tab-settings-proof-auth-client.tsx"
				),
			},
			{
				find: "@/src/hooks/useActiveNode.ts",
				replacement: path.resolve(
					harnessDir,
					"profile-tab-settings-proof-node.ts"
				),
			},
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
		fs: { allow: [repositoryRoot] },
		host: "127.0.0.1",
		port: 55_813,
		strictPort: true,
	},
});
