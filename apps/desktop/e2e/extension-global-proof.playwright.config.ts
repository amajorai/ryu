import { defineConfig, devices } from "@playwright/test";
import { proofEvidencePath } from "./proof-evidence-path.ts";
export default defineConfig({
	testDir: ".",
	testMatch: /extension-global-proof\.spec\.ts$/,
	timeout: 180_000,
	expect: { timeout: 45_000 },
	reporter: "line",
	outputDir: proofEvidencePath("extension-parity/global-browser"),
	use: {
		...devices["Desktop Chrome"],
		baseURL: "http://127.0.0.1:5234",
		trace: "retain-on-failure",
	},
	webServer: {
		// `vite preview` only serves an existing build, so build first: a clean
		// checkout has no target/extension-global-proof-build and the server never came up.
		command:
			"NODE_OPTIONS=--max-old-space-size=8192 bunx vite build --emptyOutDir --config harness/vite.extension-global-proof.config.ts && bunx vite preview --config harness/vite.extension-global-proof.config.ts",
		url: "http://127.0.0.1:5234/extension-global-proof.html",
		reuseExistingServer: true,
		timeout: 180_000,
	},
});
