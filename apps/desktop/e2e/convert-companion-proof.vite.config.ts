import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const e2eDirectory = import.meta.dirname;
const hostDirectory = resolve(e2eDirectory, "convert-companion-proof-host");

export default defineConfig({
	root: hostDirectory,
	resolve: { dedupe: ["react", "react-dom"] },
	plugins: [
		react(),
		{
			name: "convert-proof-readiness",
			configureServer(server) {
				server.middlewares.use("/__ready", (_request, response) => {
					response.statusCode = 200;
					response.setHeader("content-type", "application/json");
					response.end(JSON.stringify({ extensionHost: true, ok: true }));
				});
			},
		},
	],
	server: {
		host: "127.0.0.1",
		port: 5591,
		strictPort: true,
		fs: { allow: [resolve(e2eDirectory, "../../..")] },
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
