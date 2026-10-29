import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-add-channel-dialog-vite-cache`,
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"import.meta.env.VITE_RYU_PRODUCT": JSON.stringify("build"),
		"process.env": {},
	},
	optimizeDeps: {
		entries: ["add-channel-dialog-proof.html"],
		force: true,
		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{
				find: "@/src/contexts/entitlement-context.tsx",
				replacement: path.resolve(
					harnessDir,
					"app-sidebar-entitlement.mock.tsx"
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
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5454, strictPort: true },
});
