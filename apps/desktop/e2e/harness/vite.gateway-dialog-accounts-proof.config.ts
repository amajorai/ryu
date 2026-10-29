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
		"node_modules/.vite-gateway-dialog-accounts-proof"
	),
	optimizeDeps: {
		entries: ["gateway-dialog-accounts-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	build: {
		rollupOptions: {
			input: path.resolve(harnessDir, "gateway-dialog-accounts-proof.html"),
		},
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
	// The working tree is shared while proofs run. With a watcher, any edit in
	// GatewayDialog's import graph Fast-Refreshes the dialog mid-test, remounting
	// it and discarding typed drafts the proofs assert on. Serve a fixed build.
	server: {
		host: "127.0.0.1",
		port: 5199,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
