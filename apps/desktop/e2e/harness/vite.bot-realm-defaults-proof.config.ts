import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const port = Number(process.env.RYU_BOT_REALM_E2E_PORT ?? "5178");

export default defineConfig({
	plugins: [react()],
	base: "/",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		host: "127.0.0.1",
		port,
		strictPort: true,
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
