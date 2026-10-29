import path from "node:path";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { quotaProofApi } from "./sdk-account-quota-server.ts";
import { quotaSourceGraph } from "./sdk-account-quota-source.ts";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const sourceRoot = path.resolve(
	process.env.RYU_SDK_QUOTA_SOURCE_ROOT ?? path.resolve(desktopRoot, "../..")
);
const sourceDesktop = path.join(sourceRoot, "apps/desktop");
const sourceGraph = quotaSourceGraph(sourceRoot, harnessDir);
const seam = path.resolve(harnessDir, "sdk-account-quota-seams.ts");
export default defineConfig({
	plugins: [sourceGraph.plugin, react(), quotaProofApi()],
	define: { "process.env": {} },
	css: {
		postcss: {
			plugins: [
				tailwindcss({ base: sourceRoot }),
				{
					postcssPlugin: "sdk-quota-css-source-graph",
					OnceExit(_root, { result }) {
						for (const message of result.messages) {
							if (
								message.type === "dependency" &&
								"file" in message &&
								isNativeText(message.file)
							) {
								sourceGraph.record(message.file);
							}
						}
					},
				},
			],
		},
	},
	root: harnessDir,
	cacheDir: path.resolve(
		desktopRoot,
		"node_modules/.vite-sdk-account-quota-proof"
	),
	publicDir: path.resolve(sourceDesktop, "public"),
	optimizeDeps: {
		noDiscovery: true,
		include: [
			"react",
			"react-dom/client",
			"@tanstack/react-query",
			"sileo",
			"motion/react",
			"@base-ui/react/select",
			"@base-ui/react/switch",
			"@base-ui/react/button",
			"@base-ui/react/input",
			"@hugeicons/core-free-icons",
			"@hugeicons/react",
			"cn",
			"use-sync-external-store/shim",
			"use-sync-external-store/shim/with-selector",
		],
	},
	resolve: {
		alias: [
			...[
				"@/src/hooks/useActiveNode.ts",
				"@/lib/auth-client.ts",
				"@/src/lib/dev-metrics.ts",
				"@/src/lib/realtime/jwt.ts",
			].map((find) => ({ find, replacement: seam })),
			{ find: "@", replacement: sourceDesktop },
			{
				find: "@ryu/ui/globals.css",
				replacement: path.join(
					sourceRoot,
					"packages/ui/src/styles/globals.css"
				),
			},
			{
				find: /^@ryu\/ui\/(.*)$/,
				replacement: path.join(sourceRoot, "packages/ui/src/$1"),
			},
			{
				find: /^@ryu\/i18n$/,
				replacement: path.join(sourceRoot, "packages/i18n/src/index.ts"),
			},
			{
				find: /^@ryu\/i18n\/(.*)$/,
				replacement: path.join(sourceRoot, "packages/i18n/src/$1"),
			},
			{
				find: "@ryuhq/protocol/sse",
				replacement: path.join(
					sourceRoot,
					"packages/protocol/src/sse-client.ts"
				),
			},
		],
	},
	server: { host: "127.0.0.1", strictPort: true, watch: null },
});
