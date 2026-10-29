import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
export default defineConfig({
	define: { "process.env": {} },
	plugins: [
		react(),
		{
			name: "mount-proof-bundle",
			configureServer(server) {
				let hostStreams = 0;
				let closedHostStreams = 0;
				server.middlewares.use("/proof-host-stream-state", (_req, res) => {
					res.setHeader("Content-Type", "application/json");
					res.end(
						JSON.stringify({ started: hostStreams, closed: closedHostStreams })
					);
				});
				server.middlewares.use((req, res, next) => {
					if (
						decodeURIComponent((req.url ?? "").split("?")[0]) !==
						"/api/plugins/@ryu/warmup/host/stream"
					) {
						return next();
					}
					req.resume();
					hostStreams++;
					res.on("close", () => {
						closedHostStreams++;
					});
					res.setHeader("Content-Type", "text/event-stream");
					res.write(
						'data: {"type":"text-delta","delta":"fixture reply"}\n\ndata: [DONE]\n\n'
					);
				});
				let started = 0;
				let closed = 0;
				server.middlewares.use("/proof-read-state", (_req, res) => {
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ started, closed }));
				});
				server.middlewares.use("/proof-pending-read", (_req, res) => {
					started++;
					res.on("close", () => {
						closed++;
					});
				});
				server.middlewares.use("/proof-warmup.html", (_req, res) => {
					res.setHeader("content-type", "text/html");
					res.end(readFileSync("/tmp/ryu-warmup-performance-build/index.html"));
				});
			},
		},
	],
	root: import.meta.dirname,
	cacheDir: "/tmp/ryu-mount-stream-proof-cache",
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: {
		entries: ["mount-performance-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: { "@": path.resolve(import.meta.dirname, "../..") },
	},
	server: {
		host: "127.0.0.1",
		port: 5210,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
