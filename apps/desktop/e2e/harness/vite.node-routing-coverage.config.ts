import { mergeConfig } from "vite";
import managedOpenRouterRoutingProof from "./vite.managed-openrouter-routing-proof.config.ts";

// The managed OpenRouter routing harness on its own port with a /tmp cache, so
// verification runs never write Vite's dependency cache into the checkout.
export default mergeConfig(managedOpenRouterRoutingProof, {
	cacheDir:
		process.env.RYU_NODE_ROUTING_COVERAGE_VITE_CACHE ??
		"/tmp/node-routing-coverage/vite-cache",
	server: { host: "127.0.0.1", port: 5487, strictPort: true },
});
