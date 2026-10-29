import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tailwindcss from "@tailwindcss/postcss";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { PluginManifestSchema } from "../../../../packages/sdk/src/manifest.ts";

const harnessDir = import.meta.dirname;
const desktopRoot = path.resolve(harnessDir, "../..");
const repoRoot = path.resolve(desktopRoot, "../..");

export default defineConfig({
	root: harnessDir,
	cacheDir: path.join(tmpdir(), "ryu-packed-menu-vite"),
	plugins: [
		react(),
		{
			name: "packed-contributions-proof",
			configureServer(server) {
				const directory = mkdtempSync(
					path.join(tmpdir(), "ryu-packed-menu-proof-")
				);
				cpSync(
					path.join(repoRoot, "plugins-store/plugins/chat-title"),
					directory,
					{ recursive: true }
				);
				const result = spawnSync(
					"bun",
					[path.join(repoRoot, "packages/sdk/src/cli.ts"), "pack", directory],
					{ encoding: "utf8" }
				);
				if (result.status !== 0) {
					throw new Error(result.stderr || "SDK pack failed");
				}
				const bundle = PluginManifestSchema.parse(
					JSON.parse(
						readFileSync(
							path.join(directory, "dist/plugin.bundle.json"),
							"utf8"
						)
					)
				);
				const payload = JSON.stringify({
					context_menu_items: (
						bundle.contributes?.context_menu_items ?? []
					).map((item) => ({ ...item, plugin: bundle.id })),
				});
				server.middlewares.use("/__packed-chat-title", (_req, res) => {
					res.setHeader("Content-Type", "application/json");
					res.end(payload);
				});
				server.httpServer?.once("close", () =>
					rmSync(directory, { recursive: true, force: true })
				);
			},
		},
	],
	css: { postcss: { plugins: [tailwindcss()] } },
	define: { "process.env": {} },
	resolve: { alias: { "@": desktopRoot }, dedupe: ["react", "react-dom"] },
	publicDir: path.join(desktopRoot, "public"),
	optimizeDeps: { entries: ["tab-entity-menu-story.html"] },
	server: { host: "127.0.0.1", port: 5287, strictPort: true },
});
