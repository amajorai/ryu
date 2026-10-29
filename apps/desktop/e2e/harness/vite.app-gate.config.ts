import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";
export default mergeConfig(base, {
	plugins: [
		{
			name: "meeting-stream-lifetime",
			configureServer(server) {
				let opened = 0;
				let closed = 0;
				server.middlewares.use("/proof-meeting-stream-state", (_req, res) => {
					res.setHeader("Content-Type", "application/json");
					res.end(JSON.stringify({ opened, closed }));
				});
				server.middlewares.use("/api/meetings/stream", (_req, res) => {
					opened += 1;
					res.once("close", () => {
						closed += 1;
					});
					res.setHeader("Content-Type", "text/event-stream");
					res.write(
						'data: {"type":"status","meeting_id":"fixture","status":"recording"}\n\n'
					);
				});
			},
		},
	],
	cacheDir: "/tmp/ryu-app-gate-cache",
	optimizeDeps: {
		entries: ["app-gate-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	server: { port: 5238, strictPort: true, watch: null, hmr: false },
});
