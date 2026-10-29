import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type ViteDevServer } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const seams = path.join(harnessDir, "gateway-runtime-live-seams.ts");
const profileDir = process.env.RYU_LIVE_QA_DIR;
if (!profileDir) {
	throw new Error("Set the isolated verification profile directory");
}
const token = readFileSync(
	path.join(profileDir, "node-auth.token"),
	"utf8"
).trim();
const previewPort = Number(process.env.RYU_LIVE_QA_PORT ?? "5188");
const corePort = Number(process.env.RYU_LIVE_QA_CORE_PORT ?? "52386");
const origin = `http://127.0.0.1:${previewPort}`;
const proxy = {
	"/api/gateway": {
		target: `http://127.0.0.1:${corePort}`,
		headers: { Authorization: `Bearer ${token}` },
	},
};
// The privileged test proxy is limited to Gateway APIs and same-origin browser requests.
const restrictProxy = (server: Pick<ViteDevServer, "middlewares">) => {
	server.middlewares.use((request, response, next) => {
		if (request.url?.startsWith("/api/")) {
			const pathname = new URL(request.url, origin).pathname;
			const allowed =
				(pathname === "/api/gateway" || pathname.startsWith("/api/gateway/")) &&
				!pathname.includes("%") &&
				(!request.headers.origin || request.headers.origin === origin) &&
				request.headers["sec-fetch-site"] !== "cross-site";
			if (!allowed) {
				response.statusCode = 403;
				response.end("Verification proxy request denied");
				return;
			}
		}
		next();
	});
};

export default defineConfig({
	plugins: [
		react(),
		{
			name: "isolated-gateway-proxy",
			configureServer: restrictProxy,
			configurePreviewServer: restrictProxy,
		},
	],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	publicDir: path.join(desktopRoot, "public"),
	build: {
		outDir: path.resolve(
			process.env.RYU_LIVE_QA_OUTPUT ??
				path.join(desktopRoot, "../../.tmp/gateway-runtime-live-ui")
		),
		rollupOptions: {
			input: path.join(harnessDir, "gateway-runtime-live.html"),
		},
	},
	preview: { host: "127.0.0.1", port: previewPort, strictPort: true, proxy },
	server: { host: "127.0.0.1", port: previewPort, strictPort: true, proxy },
	resolve: {
		alias: [
			{ find: "@/src/hooks/useActiveNode.ts", replacement: seams },
			{ find: "./useActiveNode.ts", replacement: seams },
			{ find: "@/src/hooks/useGatewayConfigurable.ts", replacement: seams },
			{ find: "@", replacement: desktopRoot },
		],
	},
});
