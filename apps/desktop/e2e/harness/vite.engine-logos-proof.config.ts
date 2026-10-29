import { defineConfig, mergeConfig } from "vite";
import desktopConfig from "../../vite.config.ts";
import catalog from "./engine-logos-catalog.json" with { type: "json" };

export default mergeConfig(
	desktopConfig,
	defineConfig({
		server: { host: "127.0.0.1", port: 5198 },
		build: { rollupOptions: { input: "e2e/harness/engine-logos-proof.html" } },
		plugins: [
			{
				name: "engine-logo-fixtures",
				configureServer(server) {
					server.middlewares.use((req, res, next) => {
						if (!req.url?.startsWith("/api/")) {
							return next();
						}
						res.setHeader("Content-Type", "application/json");
						const responses = new Map(
							Object.entries({
								"/api/catalog": catalog,
								"/api/engine/active": {
									active: "lemonade",
									running: true,
									available: catalog.sidecars.map((e) => e.name),
								},
								"/api/sidecar/status": {},
								"/api/sandbox/backend": {
									active: "wasmtime",
									available: catalog.sidecars
										.filter((e) => e.category === "sandbox")
										.map((e) => ({
											...e,
											available: true,
											display_name: e.display_name,
										})),
								},
								"/api/apps": { apps: [] },
								"/api/plugins": { plugins: [] },
							})
						);
						res.end(JSON.stringify(responses.get(req.url.split("?")[0]) ?? {}));
					});
				},
			},
		],
	})
);
