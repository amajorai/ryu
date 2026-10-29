import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "/",
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["inbox-center-interactions-proof.html"],
		force: true,

		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	root: harnessDir,
	resolve: {
		alias: [
			{
				find: "@/lib/tauri-bridge.ts",
				replacement: path.join(harnessDir, "inbox-center-tauri-bridge.ts"),
			},
			{
				find: "@/src/hooks/useSystemAnnouncements.ts",
				replacement: path.join(
					harnessDir,
					"inbox-center-no-system-announcements.ts"
				),
			},
			{ find: "@", replacement: desktopRoot },
			{
				find: "react",
				replacement: path.join(desktopRoot, "node_modules/react"),
			},
			{
				find: "react-dom",
				replacement: path.join(desktopRoot, "node_modules/react-dom"),
			},
		],
		dedupe: ["react", "react-dom"],
	},
	server: {
		host: "127.0.0.1",
		port: 5468,
		strictPort: true,
	},
});
