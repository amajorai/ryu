import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	cacheDir: `${tmpdir()}/ryu-gateway-smart-routing-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["gateway-smart-routing-settings-proof.html"],
		include: ["lucide-react"],
		force: true,
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: {
			"@": desktopRoot,
			"@ryu/settings": path.resolve(
				harnessDir,
				"stubs/gateway-smart-routing-settings-api.ts"
			),
		},
	},
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5267, strictPort: true },
});
