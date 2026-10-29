import { tmpdir } from "node:os";
import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: /app-sidebar-interactions-proof\.spec\.ts$/,
	grep: /Customize sidebar production dialog/,
	workers: 1,
	timeout: 90_000,
	reporter: "list",
	outputDir: `${tmpdir()}/ryu-customize-sidebar-results`,
	use: { baseURL: "http://127.0.0.1:5489", trace: "off" },
	webServer: {
		command:
			"bunx vite --config harness/vite.customize-sidebar-proof.config.ts",
		url: "http://127.0.0.1:5489/app-sidebar-interactions-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
