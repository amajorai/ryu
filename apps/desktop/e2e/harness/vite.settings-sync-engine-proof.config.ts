import { createRequire } from "node:module";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "../..");
const require = createRequire(path.join(desktop, "package.json"));
const { defineConfig } = require("vite");
const react = require("@vitejs/plugin-react").default;
const tailwindcss = require("@tailwindcss/postcss");
const control = process.env.SYNC_PROOF_CONTROL_ROOT;
if (!control) {
	throw new Error("Owned control directory is required");
}
export default defineConfig({
	root: import.meta.dirname,
	optimizeDeps: { entries: ["settings-sync-engine-proof.html"] },
	plugins: [react()],
	cacheDir: path.join(control, "vite-cache"),
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(
			"http://127.0.0.1:5607"
		),
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@": desktop,
			"@ryu/ui/globals.css": path.resolve(
				desktop,
				"../../packages/ui/src/styles/globals.css"
			),
			"@ryu/ui": path.resolve(desktop, "../../packages/ui/src"),
			react: path.resolve(desktop, "node_modules/react"),
			"react-dom": path.resolve(desktop, "node_modules/react-dom"),
		},
	},
	css: { postcss: { plugins: [tailwindcss()] } },
	server: {
		host: "127.0.0.1",
		port: 5606,
		strictPort: true,
		watch: null,
		fs: { allow: [path.resolve(desktop, "../.."), import.meta.dirname] },
	},
	build: { target: "esnext", outDir: path.join(control, "build") },
});
