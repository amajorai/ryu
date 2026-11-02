import { defineConfig, devices } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";
export default defineConfig({
	testDir: ".",
	testMatch: "app-icon-story.spec.ts",
	outputDir: proofEvidencePath("app-icons-v2/test-results"),
	workers: 1,
	use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:5198" },
	webServer: {
		// `vite preview` only serves an existing build; a clean checkout has no
		// harness/dist-icons, so build it first.
		command:
			"bun x vite build --config harness/vite.icons.config.ts && bun x vite preview --config harness/vite.icons.config.ts --host 127.0.0.1 --port 5198 --strictPort",
		url: "http://127.0.0.1:5198/app-icon-story.html",
		reuseExistingServer: false,
	},
});
