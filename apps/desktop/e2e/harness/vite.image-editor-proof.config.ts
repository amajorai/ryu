import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const harnessDir = path.resolve(import.meta.dirname);
const desktopRoot = path.resolve(harnessDir, "../..");
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);

function resolveLocalImageEngineTarget(
	value: string | undefined
): string | undefined {
	if (!value) {
		return undefined;
	}
	let imageEngineUrl: URL;
	try {
		imageEngineUrl = new URL(value);
	} catch {
		throw new Error(
			"The image-editor live-model proxy URL must be a valid loopback HTTP URL."
		);
	}
	const imageEngineHost = imageEngineUrl.hostname.replace(/^\[|\]$/g, "");
	if (
		imageEngineUrl.protocol !== "http:" ||
		imageEngineUrl.username ||
		imageEngineUrl.password ||
		imageEngineUrl.pathname !== "/" ||
		imageEngineUrl.search ||
		imageEngineUrl.hash ||
		!loopbackHosts.has(imageEngineHost)
	) {
		throw new Error(
			"The image-editor live-model proxy must target a loopback HTTP URL."
		);
	}
	return imageEngineUrl.origin;
}

const localImageEngineTarget = resolveLocalImageEngineTarget(
	process.env.RYU_IMAGE_EDITOR_LOCAL_ENGINE_URL
);

export default defineConfig({
	base: "/",
	build: {
		emptyOutDir: true,
		outDir: path.resolve(harnessDir, "image-editor-proof-dist"),
		rollupOptions: {
			input: path.resolve(harnessDir, "image-editor-proof.html"),
		},
		target: "chrome105",
	},
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
	cacheDir: path.resolve(desktopRoot, "node_modules/.vite-image-editor-proof"),
	server: {
		hmr: false,
		host: "127.0.0.1",
		port: Number(process.env.RYU_IMAGE_EDITOR_E2E_PORT ?? "5196"),
		strictPort: true,
		watch: null,
		...(localImageEngineTarget
			? {
					proxy: {
						"/__local-sdcpp": {
							target: localImageEngineTarget,
							rewrite: (requestPath: string) =>
								requestPath.replace(/^\/__local-sdcpp/, ""),
						},
					},
				}
			: undefined),
	},

	optimizeDeps: { esbuildOptions: { target: "esnext" } },
});
