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
	publicDir: path.resolve(desktopRoot, "public"),
	cacheDir: path.resolve(desktopRoot, "node_modules/.vite-sdk-accounts-proof"),
	optimizeDeps: {
		entries: ["sdk-accounts-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: { alias: [{ find: "@", replacement: desktopRoot }] },
	server: { host: "127.0.0.1", port: 5198, strictPort: true },
});
