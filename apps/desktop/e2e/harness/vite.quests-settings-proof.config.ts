import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const proofOrigin = "http://127.0.0.1:5286";

export default defineConfig({
	base: "./",
	cacheDir: "/tmp/ryu-quests-settings-proof-vite-cache",
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(proofOrigin),
	},
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["quests-settings-proof.html"],
		force: true,
	},
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: {
			"@": desktopRoot,
			react: path.resolve(desktopRoot, "node_modules/react"),
			"react-dom": path.resolve(desktopRoot, "node_modules/react-dom"),
		},
		dedupe: ["react", "react-dom"],
	},
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5286, strictPort: true },
});
