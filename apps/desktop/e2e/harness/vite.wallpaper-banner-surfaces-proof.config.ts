import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	plugins: [react()],
	base: "./",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: { "@": desktopRoot },
	},
	server: {
		host: "127.0.0.1",
		port: 5189,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-wallpaper-banner-proof"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: {
				wallpaperBannerSurfaces: path.resolve(
					harnessDir,
					"wallpaper-banner-surfaces-proof.html"
				),
			},
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
