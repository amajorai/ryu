import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "desktop-shell-window-tray.spec.ts",
	workers: 1,
	retries: 0,
	reporter: "list",
	outputDir: path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-shell-flows/window-tray/results"
	),
	use: {
		baseURL: "http://127.0.0.1:5531",
		viewport: { width: 1280, height: 900 },
	},
	webServer: {
		cwd: path.resolve(import.meta.dirname, ".."),
		command:
			"bunx vite --config e2e/harness/vite.chat-page-control-paths.config.ts --port 5531",
		url: "http://127.0.0.1:5531/share-conversation-toolbar-entry.html",
		timeout: 120_000,
		reuseExistingServer: true,
	},
});
