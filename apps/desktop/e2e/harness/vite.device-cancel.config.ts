import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
	plugins: [react()],
	root: import.meta.dirname,
	cacheDir: "/tmp/ryu-device-cancel-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(
			"http://127.0.0.1:5222"
		),
	},
	optimizeDeps: {
		entries: ["device-cancel-proof.html"],
		include: ["lucide-react"],

		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@extension/lib/auth-client.ts": path.resolve(
				import.meta.dirname,
				"device-cancel-auth.ts"
			),
			"wxt/browser": path.resolve(
				import.meta.dirname,
				"device-cancel-browser.ts"
			),
			"@extension/lib/content-i18n.ts": path.resolve(
				import.meta.dirname,
				"extension-content-i18n.ts"
			),
			"@extension/store/useNodeStore.ts": path.resolve(
				import.meta.dirname,
				"extension-health-node.ts"
			),
			"@extension": path.resolve(import.meta.dirname, "../../../extension"),
			"@": path.resolve(import.meta.dirname, "../.."),
		},
	},
	build: {
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "device-cancel-proof.html"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5222,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
