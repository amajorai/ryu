import { tmpdir } from "node:os";
import { defineConfig } from "@playwright/test";

// The production build of the harness graph takes about two minutes on a cold cache; keep its
// output (about 120 MB) under the run's temp dir rather than a fixed /tmp path.
const previewDir = `${tmpdir()}/ryu-app-sidebar-entity-rows-proof-preview-5238`;

export default defineConfig({
	testDir: ".",
	testMatch: /app-sidebar-entity-rows-proof\.spec\.ts$/,
	workers: 1,
	timeout: 90_000,
	outputDir: `${tmpdir()}/ryu-app-sidebar-entity-rows-proof-results`,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5238",
		viewport: { width: 1100, height: 850 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: `bunx vite build --emptyOutDir --config harness/vite.app-sidebar-entity-rows-proof.config.ts --outDir ${previewDir} && bunx vite preview --config harness/vite.app-sidebar-entity-rows-proof.config.ts --outDir ${previewDir} --host 127.0.0.1 --strictPort --port 5238`,
		url: "http://127.0.0.1:5238/app-sidebar-entity-rows-proof.html",
		reuseExistingServer: false,
		timeout: 300_000,
	},
});
