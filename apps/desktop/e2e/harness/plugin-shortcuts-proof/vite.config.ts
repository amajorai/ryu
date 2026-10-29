import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { installedIndividualIcons } from "../installed-individual-icons.ts";
import { immutableTabBaseline } from "./immutable-tab-baseline.ts";

const desktop = path.resolve(import.meta.dirname, "../../..");
export default defineConfig({
	root: import.meta.dirname,
	// Optional owned dependency cache so concurrent harness servers never share
	// (and re-optimize) the package-wide default cache.
	cacheDir: process.env.RYU_PLUGIN_SHORTCUTS_VITE_CACHE,
	optimizeDeps: {
		noDiscovery: true,
		include: [
			// With discovery off, each entry must match the exact specifier that
			// @ryu/ui imports (`lodash/<name>.js`); an unmatched one is served as
			// raw CommonJS and the browser rejects its missing default export.
			"@ryu/ui > lodash/isObjectLike.js",
			"@ryu/ui > lodash/isObject.js",
			"@ryu/ui > lodash/cloneDeep.js",
			"@ryu/ui > lodash/debounce.js",
			"@ryu/ui > lodash/get.js",
			"react",
			"react-dom",
			"react-dom/client",
			"react/jsx-runtime",
			"react/jsx-dev-runtime",
			"react-dom > scheduler",
			"@base-ui/react > use-sync-external-store/shim",
			"zustand > use-sync-external-store/shim/with-selector",
			"zustand > use-sync-external-store/shim/with-selector.js",
			"react-router-dom > react-router > cookie",
			"react-router-dom > react-router > set-cookie-parser",
			"@ryu/settings > next/navigation",
			"@ryu/ui > qrcode",
			"cron-parser",
			"@ai-sdk/react",
			"@pierre/diffs",
			// Subpaths imported by source; served raw they load CommonJS lru_map.
			"@pierre/diffs/edit",
			"@pierre/diffs/react",
			"@ryu/ui > @platejs/callout/react",
			"@ryu/ui > @platejs/caption/react",
			"@ryu/ui > @platejs/combobox/react",
			"@ryu/ui > @platejs/dnd",
			"@ryu/ui > @platejs/emoji/react",
			"@ryu/ui > @platejs/floating",
			"@ryu/ui > @platejs/indent/react",
			"@ryu/ui > @platejs/layout/react",
			"@ryu/ui > @platejs/link/react",
			"@ryu/ui > @platejs/list/react",
			"@ryu/ui > @platejs/markdown",
			"@ryu/ui > @platejs/media/react",
			"@ryu/ui > @platejs/resizable",
			"@ryu/ui > @platejs/selection/react",
			"@ryu/ui > @platejs/table/react",
			"@ryu/ui > @platejs/toc/react",
			"@ryu/ui > @platejs/toggle/react",
			"@ryu/ui > @udecode/cn",
			"@xyflow/react",
			"mermaid",
			"platejs",
			"platejs/react",
			"react-grid-layout",
			"react-router-dom",
			"@ryu/ui > react-textarea-autosize",
			"recharts",
			"@ryu/ui > remark-emoji",
			"streamdown > hast-util-to-jsx-runtime",
			"streamdown",
		],
		exclude: [
			"@hugeicons/core-free-icons",
			"@tabler/icons-react",
			"lucide-react",
		],
		entries: ["index.html"],
		esbuildOptions: { target: "esnext" },
	},
	publicDir: path.join(desktop, "public"),
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	plugins: [
		...immutableTabBaseline(desktop),
		installedIndividualIcons(),
		react(),
	],
	resolve: { dedupe: ["react", "react-dom"], alias: { "@": desktop } },
	server: { host: "127.0.0.1", port: 33_368, strictPort: true },
});
