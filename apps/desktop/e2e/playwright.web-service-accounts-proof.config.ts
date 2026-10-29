import path from "node:path";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	outputDir: path.resolve(
		import.meta.dirname,
		"../../../target/web-service-accounts-proof"
	),
	testDir: ".",
	testMatch: "web-service-accounts-proof.spec.ts",
	timeout: 90_000,
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL: "http://127.0.0.1:5211",
		viewport: { width: 1280, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config e2e/harness/vite.web-service-accounts-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5211/web-service-accounts-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
