import { tmpdir } from "node:os";
import { mergeConfig } from "vite";
import harness from "./vite.harness.config.ts";

// Actual DesktopCatalogHost, auth, node and Apps section imports remain intact.
export default mergeConfig(harness, {
	cacheDir: `${tmpdir()}/ryu-marketplace-store-version-vite-cache`,
	optimizeDeps: {
		entries: ["marketplace-store-version-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	define: {
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(
			"http://127.0.0.1:58199"
		),
		"import.meta.env.VITE_AUTH_CORE_URL": JSON.stringify(
			"http://127.0.0.1:58199"
		),
		"import.meta.env.VITE_CORE_URL": JSON.stringify("http://127.0.0.1:58199"),
	},
	server: { hmr: false, host: "127.0.0.1", port: 58_199, strictPort: true },
});
