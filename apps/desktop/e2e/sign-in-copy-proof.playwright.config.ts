import path from "node:path";
import { defineConfig } from "@playwright/test";

const proofDirectory = path.resolve(
	import.meta.dirname,
	"../../../.audit/sign-in-copy-proof"
);

export default defineConfig({
	testDir: ".",
	testMatch: /sign-in-copy-proof\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: path.join(proofDirectory, "test-results"),
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5234",
		viewport: { width: 1300, height: 900 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"node ../node_modules/vite/bin/vite.js --config harness/vite.sign-in-copy-proof.config.ts --host 127.0.0.1 --strictPort --port 5234",
		url: "http://127.0.0.1:5234/sign-in-copy-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
