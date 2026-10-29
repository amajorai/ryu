import { tmpdir } from "node:os";
import { mergeConfig } from "vite";
import harness from "./vite.harness.config.ts";

export default mergeConfig(harness, {
	cacheDir: `${tmpdir()}/ryu-marketplace-version-install-vite-cache`,
	optimizeDeps: {
		entries: ["marketplace-version-install-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	define: {
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(
			"http://127.0.0.1:5436"
		),
		"import.meta.env.VITE_AUTH_CORE_URL": JSON.stringify(
			"http://127.0.0.1:5436"
		),
		"import.meta.env.VITE_CORE_URL": JSON.stringify("http://127.0.0.1:5436"),
	},
	server: { hmr: false, host: "127.0.0.1", port: 5436, strictPort: true },
});
