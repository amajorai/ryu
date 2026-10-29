import { tmpdir } from "node:os";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /desktop-startup-bootstrap-proof\.spec\.ts$/,
	workers: 1,
	timeout: 90_000,
	reporter: "list",
	outputDir: `${tmpdir()}/ryu-startup-bootstrap-results`,
	use: {
		baseURL: "http://127.0.0.1:5490",
		viewport: { width: 1440, height: 1000 },
		trace: "off",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite --config harness/vite.desktop-startup-bootstrap-proof.config.ts",
		url: "http://127.0.0.1:5490/desktop-startup-bootstrap-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
