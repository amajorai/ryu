import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	optimizeDeps: { esbuildOptions: { target: "esnext" } },
	plugins: [react()],
	define: {
		"process.env": {},
		"import.meta.env.VITE_CORE_URL": JSON.stringify("http://127.0.0.1:5359"),
	},
	css: {
		postcss: {
			plugins: [tailwindcss()],
		},
	},
	root: harnessDir,
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
		port: 5359,
		strictPort: true,
		fs: { allow: [path.resolve(desktopRoot, "../..")] },
	},
	build: {
		outDir: path.resolve(harnessDir, "dist-plugin-settings-manifests-proof"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: path.resolve(harnessDir, "plugin-settings-manifests-proof.html"),
		},
	},
});
