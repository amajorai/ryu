import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harness = import.meta.dirname;
const desktop = path.resolve(harness, "../..");
const repository = path.resolve(desktop, "../..");
const cssPath = (relative: string) =>
	path.resolve(repository, relative).replaceAll("\\", "/");
const shared = cssPath("packages/ui/src/styles/globals.css");
// Generated under the Desktop package so the stylesheet's bare package imports
// ("tailwindcss") resolve from the Desktop dependencies; a repository-root
// folder cannot see them when packages install into their own node_modules.
const generated = cssPath(
	"apps/desktop/.tmp/provider-routing-regressions/scoped-globals.css"
);
export default defineConfig({
	root: harness,
	cacheDir: path.resolve(
		repository,
		".tmp/provider-routing-regressions/vite-cache"
	),
	plugins: [
		react(),
		{
			name: "routing-proof-css-scope",
			enforce: "pre",
			async transform(source, id) {
				if (
					id.split("?")[0].replaceAll("\\", "/") !==
					cssPath("apps/desktop/src/index.css")
				) {
					return null;
				}
				const sources = [
					"apps/desktop/e2e/harness/provider-routing-regressions-proof.tsx",
					"apps/desktop/src/components/agents/RyuPiConfig.tsx",
					"apps/desktop/src/components/gateway/GatewayProviderKeyRow.tsx",
					"apps/desktop/src/components/gateway/provider-key-row",
					"apps/desktop/src/components/settings/OAuthAccountPoolControls.tsx",
					"packages/blocks/src/desktop/agent-edit.tsx",
					"packages/blocks/src/desktop/agent-edit-pi-config.tsx",
					"packages/blocks/src/desktop/agent-edit-pi-model-picker.tsx",
					"packages/ui/src",
				];
				const css = (await readFile(shared, "utf8"))
					.replace(/^@source\s+[^;]+;\s*$/gm, "")
					.replace(
						'@import "tailwindcss";',
						'@import "tailwindcss" source(none);'
					)
					.replace(
						/@import\s+"(\.\/[^"\n]+)"/g,
						(_match, relative: string) =>
							`@import "${path.resolve(path.dirname(shared), relative).replaceAll("\\", "/")}"`
					);
				await mkdir(path.dirname(generated), { recursive: true });
				const previous = await readFile(generated, "utf8").catch(() => null);
				if (previous !== css) {
					await writeFile(generated, css, "utf8");
				}
				return {
					code:
						source
							.replace(/^@source\s+[^;]+;\s*$/gm, "")
							.replace(
								'@import "@ryu/ui/globals.css";',
								`@import "${generated}";`
							) +
						"\n" +
						sources.map((item) => `@source "${cssPath(item)}";`).join("\n"),
					map: null,
				};
			},
		},
	],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: { entries: ["provider-routing-regressions-proof.html"] },
	resolve: {
		alias: [
			{
				find: "@/src/hooks/useActiveNode.ts",
				replacement: path.join(harness, "provider-connections-live-seams.tsx"),
			},
			{
				find: "./useActiveNode.ts",
				replacement: path.join(harness, "provider-connections-live-seams.tsx"),
			},
			{ find: "@", replacement: desktop },
		],
	},
	server: { host: "127.0.0.1", port: 5317, strictPort: true },
});
