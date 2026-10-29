import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessRoot = import.meta.dirname;
const proofMocks = path.resolve(
	harnessRoot,
	"extension-waitlist-scope-proof-mocks.tsx"
);

export default defineConfig({
	plugins: [react()],
	root: harnessRoot,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	optimizeDeps: {
		entries: ["extension-waitlist-scope-proof.html"],
		include: ["lucide-react", "zustand"],
	},
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@extension/lib/auth-client.ts": proofMocks,
			"@extension/lib/browser-bridge.ts": proofMocks,
			"@extension/pages/LoginPage.tsx": proofMocks,
			"@extension/store/useNodeStore.ts": proofMocks,
			"@extension": path.resolve(harnessRoot, "../../../extension"),
		},
	},
	build: {
		rollupOptions: {
			input: path.resolve(harnessRoot, "extension-waitlist-scope-proof.html"),
		},
	},
	server: {
		host: "127.0.0.1",
		port: 5216,
		strictPort: true,
		watch: null,
		hmr: false,
	},
});
