import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import { defineConfig } from "vite";

export default defineConfig({
	root: import.meta.dirname,
	cacheDir: path.resolve(import.meta.dirname, ".vite-optional-grants-proof"),
	css: { postcss: { plugins: [tailwindcss()] } },
	optimizeDeps: {
		entries: ["optional-grants-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			{
				find: "@/lib/auth-client.ts",
				replacement: path.resolve(
					import.meta.dirname,
					"optional-grants-seams.ts"
				),
			},
			{
				find: "@/src/lib/realtime/jwt.ts",
				replacement: path.resolve(
					import.meta.dirname,
					"optional-grants-seams.ts"
				),
			},
			{
				find: "@/src/lib/dev-metrics.ts",
				replacement: path.resolve(
					import.meta.dirname,
					"optional-grants-seams.ts"
				),
			},
			{
				find: "@/src",
				replacement: path.resolve(import.meta.dirname, "../../src"),
			},
		],
	},
	server: { host: "127.0.0.1", port: 5299, strictPort: true },
});
