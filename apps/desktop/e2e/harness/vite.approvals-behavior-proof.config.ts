import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const approvalsFixture = path.join(
	tmpdir(),
	"ryu-approvals-behavior-app-dist/index.html"
);

const serveCompiledFixture: Plugin = {
	name: "serve-compiled-approvals-companion",
	configureServer(server) {
		server.middlewares.use((request, response, next) => {
			if (request.url?.split("?", 1)[0] !== "/__approvals_fixture") {
				next();
				return;
			}
			response.statusCode = 200;
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(readFileSync(approvalsFixture));
		});
	},
};

export default defineConfig({
	plugins: [react(), serveCompiledFixture],
	base: "./",
	cacheDir: `${tmpdir()}/ryu-approvals-behavior-vite-cache`,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["approvals-behavior-proof.html"],
		force: true,
	},
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	clearScreen: false,
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{ find: "@", replacement: desktopRoot },
			{
				find: "react",
				replacement: path.resolve(desktopRoot, "node_modules/react"),
			},
			{
				find: "react-dom",
				replacement: path.resolve(desktopRoot, "node_modules/react-dom"),
			},
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5268,
		strictPort: true,
	},
});
