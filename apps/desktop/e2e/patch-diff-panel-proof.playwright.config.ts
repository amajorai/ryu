import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: /patch-diff-panel-proof\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: "/tmp/ryu-patch-diff-panel-proof-results",
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5238",
		viewport: { width: 1180, height: 820 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command:
			"bunx vite build --config harness/vite.patch-diff-panel-proof.config.ts && bunx vite preview --config harness/vite.patch-diff-panel-proof.config.ts --host 127.0.0.1 --strictPort --port 5238",
		// The production build of the diff panel graph needs more than Node's
		// default heap on smaller hosts (as in reply-message-proof.global-setup.ts).
		env: {
			NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=6144"]
				.filter(Boolean)
				.join(" "),
		},
		url: "http://127.0.0.1:5238/patch-diff-panel-proof.html",
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
