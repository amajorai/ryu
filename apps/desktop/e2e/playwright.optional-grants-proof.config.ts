import path from "node:path";
import { defineConfig } from "@playwright/test";

const harness = path.resolve(process.cwd(), "e2e/harness");
export default defineConfig({
	testDir: ".",
	testMatch: /optional-grants-proof\.spec\.ts$/,
	workers: 1,
	timeout: 180_000,
	use: {
		baseURL: "http://127.0.0.1:5299",
		viewport: { width: 1200, height: 800 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: `node ${path.resolve(process.cwd(), "node_modules/vite/bin/vite.js")} --config ${path.join(harness, "vite.optional-grants-proof.config.ts")}`,
		url: "http://127.0.0.1:5299/optional-grants-proof.html",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
