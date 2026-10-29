import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const mocks = path.resolve(harnessDir, "gateway-cli-setup-mocks.ts");

export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	publicDir: path.resolve(desktopRoot, "public"),
	optimizeDeps: {
		entries: ["gateway-cli-setup-proof.html"],
		esbuildOptions: { target: "esnext" },
	},
	resolve: {
		alias: [
			{ find: "@/src/lib/api/gateway.ts", replacement: mocks },
			{ find: "@/src/lib/api/cli-setup.ts", replacement: mocks },
			{ find: "@", replacement: desktopRoot },
		],
	},
	server: { host: "127.0.0.1", port: 5298, strictPort: true },
});
