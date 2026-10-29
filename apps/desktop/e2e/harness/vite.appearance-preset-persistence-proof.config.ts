import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { installedIndividualIcons } from "./installed-individual-icons.ts";
import { themePublisherHttp } from "./appearance-theme-publisher-http.ts";
const desktop =
	process.env.RYU_APPEARANCE_DESKTOP ??
	path.resolve(import.meta.dirname, "../..");
const ownedCache = process.env.RYU_APPEARANCE_VITE_CACHE;
if (!ownedCache || !path.isAbsolute(ownedCache))
	throw new Error("Fresh owned Vite cache path required");
export default defineConfig({
	root: import.meta.dirname,
	cacheDir: ownedCache,
	publicDir: path.join(desktop, "public"),
	css: { postcss: { plugins: [tailwindcss()] } },
	define: {
		"import.meta.env.VITE_RYU_PRODUCT": JSON.stringify("build"),
		"process.env": {},
	},
	plugins: [themePublisherHttp(), installedIndividualIcons(), react()],
	optimizeDeps: {
		exclude: [
			"@hugeicons/core-free-icons",
			"@tabler/icons-react",
			"lucide-react",
		],
		entries: ["appearance-preset-persistence-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: [
			{ find: "@", replacement: desktop },
			{ find: "react", replacement: path.join(desktop, "node_modules/react") },
			{
				find: "react-dom",
				replacement: path.join(desktop, "node_modules/react-dom"),
			},
		],
	},
	server: {
		host: "127.0.0.1",
		port: 33364,
		strictPort: true,
		fs: { allow: [path.resolve(desktop, "../.."), import.meta.dirname] },
	},
});
