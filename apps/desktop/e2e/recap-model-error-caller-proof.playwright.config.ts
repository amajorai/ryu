import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "recap-model-error-caller-proof.spec.ts",
	outputDir: path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/recap-ui/results"
	),
	workers: 1,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5317",
		viewport: { width: 1280, height: 1000 },
		trace: "off",
	},
	webServer: {
		cwd: path.resolve(import.meta.dirname, ".."),
		command:
			"bunx vite --config e2e/harness/vite.chat-page-control-paths.config.ts --port 5317",
		url: "http://127.0.0.1:5317/share-conversation-toolbar-entry.html",
		timeout: 120_000,
		reuseExistingServer: false,
	},
});
