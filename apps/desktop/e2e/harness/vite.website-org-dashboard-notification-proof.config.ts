import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const repoRoot = path.resolve(harnessDir, "../../../../");
const webRoot = path.resolve(repoRoot, "apps/web");
const webSrc = path.resolve(webRoot, "src");

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	resolve: {
		alias: {
			"@": webSrc,
			"@ryu/env/web": path.resolve(harnessDir, "website-env-stub.ts"),
			"next/link": path.resolve(harnessDir, "website-next-link-stub.tsx"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: Number(process.env.RYU_WEB_E2E_PORT ?? "5196"),
		strictPort: true,
	},
	build: {
		outDir: "/private/tmp/ryu-website-org-dashboard-notification-proof",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(
				harnessDir,
				"website-org-dashboard-notification-proof.html"
			),
		},
	},
});
