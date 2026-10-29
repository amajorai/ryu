import path from "node:path";
import { defineConfig } from "vite";
import providerConnections from "./vite.provider-connections-live.config.ts";

export default defineConfig({
	...providerConnections,
	cacheDir: path.resolve(
		import.meta.dirname,
		"../../node_modules/.vite-sdk-account-routing-live"
	),
	build: {
		...providerConnections.build,
		outDir: path.resolve(
			import.meta.dirname,
			"../../../../.tmp/sdk-account-routing-live-ui"
		),
	},
	preview: { ...providerConnections.preview, port: 5214, strictPort: true },
	server: { ...providerConnections.server, port: 5214, strictPort: true },
});
