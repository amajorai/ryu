import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const liveCoreUrl = process.env.RYU_VOICE_PROOF_CORE_URL;

export default defineConfig({
	cacheDir: path.resolve(desktopRoot, "node_modules/.vite-voice-call-proof"),
	plugins: [react()],
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
	base: "./",
	clearScreen: false,
	resolve: {
		alias: {
			"@": desktopRoot,
		},
	},
	server: {
		proxy: liveCoreUrl
			? {
					"/api": {
						target: liveCoreUrl,
						ws: true,
						changeOrigin: true,
						headers: {
							Authorization: `Bearer ${process.env.RYU_VOICE_PROOF_TOKEN}`,
						},
					},
				}
			: undefined,
		host: "127.0.0.1",
		port: 5698,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-voice-mode-call-proof"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "voice-mode-call-proof.html"),
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
