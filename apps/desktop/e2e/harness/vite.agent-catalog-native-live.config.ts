import { readFileSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const repoRoot = path.resolve(desktopRoot, "../..");
const seams = path.join(harnessDir, "agent-catalog-native-seams.ts");
const nodeToken = readFileSync(
	path.join(repoRoot, ".tmp/expanded-provider-live/node-auth.token"),
	"utf8"
).trim();

export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	publicDir: path.join(desktopRoot, "public"),
	optimizeDeps: { entries: ["agent-catalog-native-live.html"] },
	resolve: {
		alias: [
			{ find: /^.*\/useActiveNode\.ts$/, replacement: seams },
			{ find: /^.*\/useCommunityAgents\.ts$/, replacement: seams },
			{ find: /^.*\/usePluginSettingsOpener\.ts$/, replacement: seams },
			{ find: /^.*\/useMarketplacePurchase\.ts$/, replacement: seams },
			{ find: /^.*\/realtime\/jwt\.ts$/, replacement: seams },
			{ find: "@", replacement: desktopRoot },
		],
	},
	server: {
		host: "127.0.0.1",
		port: 5197,
		strictPort: true,
		proxy: {
			"^/core/api/agents/(?:catalog(?:\\?|$|/(?:install|uninstall)(?:\\?|$))|(?:acp:kiro|acp%3Akiro)/(?:native-accounts(?:/[a-z0-9_-]+/(?:login|logout|disconnect)|/operations/[a-z0-9_-]+)?|accounts/(?:switch|remove))(?:\\?|$))":
				{
					target: "http://127.0.0.1:54180",
					rewrite: (url) => url.replace(/^\/core/, ""),
					configure: (proxy) =>
						proxy.on("proxyReq", (request) => {
							request.setHeader("Authorization", `Bearer ${nodeToken}`);
						}),
				},
		},
	},
});
