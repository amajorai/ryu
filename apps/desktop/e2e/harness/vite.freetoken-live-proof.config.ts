import { readFileSync } from "node:fs";
import { defineConfig, mergeConfig } from "vite";
import desktopConfig from "../../vite.config.ts";
import {
	proofClientCapability,
	proofProxyAuthorization,
} from "./proof-proxy-authorization.ts";

// Test-only loopback proxy keeps the isolated Core token out of the browser bundle.
const proofDir = process.env.RYU_FREETOKEN_PROOF_DIR ?? "/tmp/ryu-freetoken";
const proofCapability = proofClientCapability();
export default mergeConfig(
	desktopConfig,
	defineConfig({
		plugins: [proofProxyAuthorization(proofCapability, 5240)],
		cacheDir: `${proofDir}/vite-cache`,
		server: {
			host: "127.0.0.1",
			port: 5240,
			proxy: {
				"/api": {
					target: "http://127.0.0.1:47993",
					configure(proxy) {
						proxy.on("proxyReq", (request) => {
							request.setHeader(
								"authorization",
								`Bearer ${readFileSync(`${proofDir}/live-core/node-auth.token`, "utf8").trim()}`
							);
						});
					},
				},
			},
		},
	})
);
