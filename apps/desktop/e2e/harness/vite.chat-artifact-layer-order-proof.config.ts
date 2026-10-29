import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");

// Production-mode build of a harness entry that imports the real
// ArtifactRenderer module graph before the real Tailwind entry, mirroring the
// import order of `src/main.tsx`. It is not the full Desktop application bundle.
export default defineConfig({
	base: "./",
	cacheDir: path.join(tmpdir(), "ryu-chat-artifact-layer-order-vite-cache"),
	clearScreen: false,
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	plugins: [react()],
	publicDir: path.resolve(desktopRoot, "public"),
	resolve: {
		alias: { "@": desktopRoot },
		dedupe: ["react", "react-dom"],
	},
	root: harnessDir,
	build: {
		emptyOutDir: true,
		outDir: path.resolve(
			process.env.RYU_CHAT_ARTIFACT_LAYER_DIST ??
				path.join(tmpdir(), "ryu-chat-artifact-layer-order")
		),
		rollupOptions: {
			input: path.resolve(harnessDir, "chat-artifact-layer-order-proof.html"),
		},
		target: "chrome105",
	},
});
