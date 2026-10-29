import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: import.meta.dirname,
	testMatch: "companion-page-proof.spec.ts",
	workers: 1,
	timeout: 90_000,
	expect: { timeout: 20_000 },
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:58443",
		viewport: { width: 400, height: 820 },
		trace: "off",
	},
	outputDir: `${tmpdir()}/ryu-companion-page-proof-results`,
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.companion-page-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:58443/companion-page-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
