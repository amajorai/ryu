import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const sourceRoot = process.env.PROVIDER_POOL_SOURCE_ROOT;
if (!sourceRoot) {
	throw new Error(
		"PROVIDER_POOL_SOURCE_ROOT must identify the exact exported UI source."
	);
}
const selectedDesktopRoot = path.join(path.resolve(sourceRoot), "apps/desktop");

export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	publicDir: path.resolve(selectedDesktopRoot, "public"),
	cacheDir: path.resolve(
		desktopRoot,
		`node_modules/.vite-provider-pools-proof-${path.basename(sourceRoot)}`
	),
	optimizeDeps: {
		entries: ["provider-pools-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			{
				find: "@ryu/ui/globals.css",
				replacement: path.join(
					path.resolve(sourceRoot),
					"packages/ui/src/styles/globals.css"
				),
			},
			{ find: "@", replacement: selectedDesktopRoot },
			{
				find: "@ryu/ui",
				replacement: path.join(path.resolve(sourceRoot), "packages/ui/src"),
			},
		],
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.PROVIDER_POOL_PROOF_PORT ?? 5190),
		strictPort: true,
		hmr: false,
	},
});
