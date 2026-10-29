import { tmpdir } from "node:os";
import path from "node:path";
import { mergeConfig } from "vite";
import base from "./vite.harness.config.ts";
export default mergeConfig(base, {
	define: {
		"import.meta.env.VITE_APP_BACKEND_URL": JSON.stringify(
			"http://127.0.0.1:5497"
		),
		"import.meta.env.VITE_APP_FRONTEND_URL": JSON.stringify(
			"http://127.0.0.1:5497"
		),
		"import.meta.env.VITE_CORE_URL": JSON.stringify("http://127.0.0.1:5497"),
		"import.meta.env.VITE_AUTH_CORE_URL": JSON.stringify(
			"http://127.0.0.1:5497"
		),
	},
	// Only the optional development annotation toolbar is omitted. App, Layout,
	// account/node providers and access checks still use their production modules.
	plugins: [
		{
			name: "console-proof-omit-dev-annotations",
			enforce: "pre",
			transform(_source: string, id: string) {
				if (
					id.split("?")[0].endsWith("/src/components/AgentationToolbar.tsx")
				) {
					return {
						code: "export function AgentationToolbar() { return null; }",
						map: null,
					};
				}
				return null;
			},
		},
	],
	cacheDir: `${tmpdir()}/ryu-console-access-app-proof-cache`,
	optimizeDeps: {
		esbuildOptions: { target: "esnext" },
		entries: ["console-access-app-proof.html"],
	},
	server: { port: 5497, strictPort: true, watch: null, hmr: false },
	build: {
		outDir: "/private/tmp/ryu-console-access-app-proof-built",
		rollupOptions: {
			input: path.resolve(import.meta.dirname, "console-access-app-proof.html"),
		},
	},
});
