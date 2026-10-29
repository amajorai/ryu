import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
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
		entries: ["developer-account-sessions-settings-proof.html"],
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: "@/lib/step-up.ts",
				replacement: path.resolve(harnessDir, "proof-step-up.ts"),
			},
			{
				find: "@/lib/auth-client.ts",
				replacement: path.resolve(harnessDir, "proof-auth-client.ts"),
			},
			{
				find: "@/src/hooks/useActiveNode.ts",
				replacement: path.resolve(harnessDir, "proof-active-node.ts"),
			},
			{
				find: "@",
				replacement: desktopRoot,
			},
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
		port: 5224,
		strictPort: true,
	},
});
