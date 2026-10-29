import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-drafts-page-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["drafts-page-proof.html"],
		force: true,
		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: [
			{
				find: "@/src/contexts/entitlement-context.tsx",
				replacement: path.resolve(
					harnessDir,
					"app-sidebar-entitlement.mock.tsx"
				),
			},
			{ find: "@", replacement: desktopRoot },
		],
		dedupe: ["react", "react-dom"],
	},
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5405, strictPort: true },
});
