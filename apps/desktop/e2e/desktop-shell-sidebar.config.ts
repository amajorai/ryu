import { defineConfig } from "@playwright/test";
export default defineConfig({
	testDir: ".",
	testMatch: "desktop-shell-sidebar.spec.ts",
	workers: 1,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5493",
		viewport: { width: 1100, height: 760 },
	},
	webServer: {
		command: "bun x vite --config harness/vite.desktop-shell-sidebar.config.ts",
		url: "http://127.0.0.1:5493/desktop-shell-sidebar.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
