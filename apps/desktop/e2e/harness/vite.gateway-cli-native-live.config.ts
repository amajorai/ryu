import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const seams = path.join(harnessDir, "gateway-cli-native-seams.ts");
const proxy = {
	"/__cli": { target: "http://127.0.0.1:54600" },
	"/api/gateway/traffic": { target: "http://127.0.0.1:54600" },
};
export default defineConfig({
	plugins: [react()],
	define: { "process.env": {} },
	css: { postcss: { plugins: [tailwindcss()] } },
	root: harnessDir,
	publicDir: path.join(desktopRoot, "public"),
	build: {
		outDir: path.join(desktopRoot, "../../.tmp/gateway-cli-native-live-ui"),
		rollupOptions: {
			input: path.join(harnessDir, "gateway-cli-native-live.html"),
		},
	},
	resolve: {
		alias: [
			{ find: "@/src/lib/api/gateway.ts", replacement: seams },
			{ find: "@/src/lib/api/cli-setup.ts", replacement: seams },
			{ find: "@", replacement: desktopRoot },
		],
	},
	preview: { host: "127.0.0.1", port: 5297, strictPort: true, proxy },
	server: { host: "127.0.0.1", port: 5297, strictPort: true, proxy },
});
