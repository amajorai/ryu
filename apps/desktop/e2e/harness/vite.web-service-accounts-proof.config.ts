import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const seams = path.resolve(harnessDir, "gateway-dialog-accounts-seams.ts");
export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite-web-service-accounts-proof"
	),
	optimizeDeps: {
		entries: [
			"web-service-accounts-proof.html",
			"gateway-dialog-accounts-proof.html",
		],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			{ find: "@/src/hooks/useActiveNode.ts", replacement: seams },
			{ find: "./useActiveNode.ts", replacement: seams },
			{ find: "@/src/hooks/useGatewayConfigurable.ts", replacement: seams },
			{ find: "@/src/hooks/useGatewayStatus.ts", replacement: seams },
			{ find: "@", replacement: desktopRoot },
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5211,
		strictPort: true,
		// A test run must retain its mounted state while parallel coverage work
		// edits this shared checkout: any write under this harness root reloads
		// the page mid-test. Exercise one loaded version until shutdown.
		watch: null,
	},
});
