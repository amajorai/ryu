import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "declarative-view-proof.spec.ts",
	workers: 1,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:58441",
		viewport: { width: 1440, height: 960 },
		trace: "off",
	},
	outputDir: `${tmpdir()}/ryu-declarative-view-proof-results`,
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.declarative-view-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:58441/declarative-view-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
