import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(harnessRoot, "../..");

export default defineConfig({
	root: harnessRoot,
	plugins: [react()],
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: {
		entries: ["web-search-access-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			{
				find: "@/src/lib/api/preferences.ts",
				replacement: path.join(harnessRoot, "web-search-preferences.mock.ts"),
			},
			{ find: "@", replacement: desktopRoot },
		],
	},
	cacheDir: path.join(tmpdir(), "ryu-web-search-access-vite-cache"),
	server: { host: "127.0.0.1", port: 5222, strictPort: true },
});
