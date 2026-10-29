import path from "node:path";
import { defineConfig } from "@playwright/test";

const desktopRoot = path.resolve(import.meta.dirname, "..");

export default defineConfig({
	fullyParallel: false,
	outputDir: path.join(desktopRoot, "test-results", "web-search-access"),
	preserveOutput: "always",
	testDir: ".",
	testMatch: "web-search-access.proof.spec.ts",
	use: {
		baseURL: "http://127.0.0.1:5222",
		browserName: "chromium",
		viewport: { width: 960, height: 540 },
	},
	webServer: {
		command:
			"bun x vite --config e2e/harness/vite.web-search-access-proof.config.ts",
		cwd: desktopRoot,
		reuseExistingServer: false,
		timeout: 60_000,
		url: "http://127.0.0.1:5222/web-search-access-proof.html",
	},
});
