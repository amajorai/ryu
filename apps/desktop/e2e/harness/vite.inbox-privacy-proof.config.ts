import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: import.meta.dirname,
	plugins: [react()],
	css: { postcss: { plugins: [] } },
	optimizeDeps: { noDiscovery: true, include: ["react", "react-dom/client"] },
	server: {
		host: "127.0.0.1",
		port: 5363,
		strictPort: true,
		fs: { allow: [path.resolve(import.meta.dirname, "../../../..")] },
	},
});
