import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	cacheDir: path.resolve(desktopRoot, "node_modules/.vite-oauth-reauth-proof"),
	publicDir: path.resolve(desktopRoot, "public"),
	optimizeDeps: { entries: ["oauth-reauth-proof.html"] },
	resolve: {
		alias: [
			{
				find: "@/components/agent-elements/input/provider-command-dialog.tsx",
				replacement: path.resolve(harnessDir, "oauth-reauth-seams.ts"),
			},
			{ find: "@", replacement: desktopRoot },
		],
	},
	server: { host: "127.0.0.1", port: 5237, strictPort: true },
	build: {
		rollupOptions: {
			input: path.resolve(harnessDir, "oauth-reauth-proof.html"),
		},
		outDir: path.resolve(harnessDir, "../../../../.tmp/oauth-reauth-ui"),
	},
	preview: { host: "127.0.0.1", port: 5237, strictPort: true },
});
