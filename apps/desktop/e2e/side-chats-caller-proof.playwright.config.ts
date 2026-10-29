import path from "node:path";
import { defineConfig } from "@playwright/test";

const baseURL = process.env.RYU_SIDE_CHATS_BASE_URL ?? "http://127.0.0.1:5345";
export default defineConfig({
	testDir: ".",
	testMatch: "side-chats-caller-proof.spec.ts",
	workers: 1,
	retries: 0,
	reporter: "list",
	outputDir: path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/side-chats/results"
	),
	use: { baseURL, viewport: { width: 1440, height: 1100 }, trace: "off" },
	webServer: process.env.RYU_SIDE_CHATS_BASE_URL
		? undefined
		: {
				cwd: path.resolve(import.meta.dirname, ".."),
				command:
					"bunx vite --config e2e/harness/vite.chat-page-control-paths.config.ts --port 5345",
				url: `${baseURL}/share-conversation-toolbar-entry.html`,
				timeout: 120_000,
				reuseExistingServer: false,
			},
});
