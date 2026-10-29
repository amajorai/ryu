import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "egress-pools-proof.spec.ts",
	use: {
		baseURL: "http://127.0.0.1:5192",
		viewport: { width: 1280, height: 900 },
	},
	webServer: {
		command: "bunx vite --config e2e/harness/vite.egress-pools-proof.config.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5192/egress-pools-proof.html",
		reuseExistingServer: true,
		timeout: 120_000,
	},
});
