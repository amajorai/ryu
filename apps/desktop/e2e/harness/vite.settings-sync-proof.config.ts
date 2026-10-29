import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const proofOrigin = "http://127.0.0.1:5207";

export default defineConfig({
	optimizeDeps: { esbuildOptions: { target: "esnext" } },
	plugins: [react()],
	base: "./",
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(proofOrigin),
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@": desktopRoot,
			react: path.resolve(desktopRoot, "node_modules/react"),
			"react-dom": path.resolve(desktopRoot, "node_modules/react-dom"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5207,
		strictPort: true,
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-settings-sync-proof"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "settings-sync-proof.html"),
		},
	},
});
