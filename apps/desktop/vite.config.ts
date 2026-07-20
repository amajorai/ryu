import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	clearScreen: false,
	// The Lanyard component (@ryu/ui) imports a binary .glb model as a URL asset.
	assetsInclude: ["**/*.glb"],
	server: {
		port: 5173,
		strictPort: true,
	},
	// SECURITY: never expose the bare `TAURI_` prefix here. Vite inlines every
	// matching env var into the frontend bundle, and the release build sets
	// TAURI_SIGNING_PRIVATE_KEY / _PASSWORD (release.yml) — so the updater's
	// minisign PRIVATE KEY gets shipped to users. This is CVE-2023-46115 /
	// GHSA-2rcp-jvr4-r259, and it was confirmed present in a local build here.
	// Only the non-sensitive platform vars are safe, so allow-list them.
	// Nothing in the desktop tree reads `import.meta.env.TAURI_*`, so the prefix
	// bought nothing and cost everything. `VITE_` only, same as apps/webapp.
	envPrefix: ["VITE_"],
	build: {
		outDir: "dist",
		target: "chrome105",
		sourcemap: true,
	},
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "."),
		},
	},
});
