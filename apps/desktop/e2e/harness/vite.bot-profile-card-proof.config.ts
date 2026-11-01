import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { browserContentKeyHost } from "./browser-content-key-host.ts";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

export default defineConfig({
	base: "./",
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	// Feed engagement is sealed; answer the content key the way a host without
	// a keychain key does so a reload opens what the page sealed.
	plugins: [browserContentKeyHost(), react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: { alias: { "@": desktopRoot } },
	root: harnessDir,
	server: { host: "127.0.0.1", port: 5191, strictPort: true },
	build: {
		outDir: path.resolve(harnessDir, "dist-bot-profile-card"),
		target: "chrome105",
		emptyOutDir: true,
		rollupOptions: {
			input: {
				botProfileCardProof: path.resolve(
					harnessDir,
					"bot-profile-card-proof.html"
				),
			},
		},
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
