import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
	root,
	cacheDir: path.join(tmpdir(), "ryu-chat-page-native-http-vite-cache"),
	optimizeDeps: {
		entries: ["chat-page-native-http.html"],
		include: ["@tauri-apps/api/window"],
		esbuildOptions: { target: "esnext" },
	},
	plugins: [react()],
	// Mirrors the shipping Desktop build target: the Layout graph's noVNC decoder
	// uses top-level await, which Vite's default browser target rejects.
	build: { target: "chrome105" },
	// Mirrors the shipping Desktop config: the Lanyard component (@ryu/ui) in the
	// actual Layout graph imports a binary .glb model as a URL asset, which the
	// production build cannot parse as JavaScript without this.
	assetsInclude: ["**/*.glb"],
	css: { postcss: { plugins: [tailwindcss()] } },
	resolve: {
		alias: [
			{ find: "@", replacement: path.resolve(root, "../..") },
			{
				find: /^@hugeicons\/core-free-icons$/,
				replacement: path.join(
					path.dirname(
						fileURLToPath(
							import.meta.resolve("@hugeicons/core-free-icons/package.json")
						)
					),
					"dist/esm/index.js"
				),
			},
		],
		dedupe: ["react", "react-dom"],
	},
	define: {
		"process.env": {},
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(
			"http://127.0.0.1:5592"
		),
		"import.meta.env.VITE_CHAT_PAGE_CORE_URL": JSON.stringify(
			"http://127.0.0.1:5591"
		),
	},
	server: {
		host: "127.0.0.1",
		port: 5590,
		strictPort: true,
		hmr: false,
		watch: { ignored: ["**/*"] },
	},
});
