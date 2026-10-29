import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5185/";
const HARNESS_CONFIG = path.resolve(
	import.meta.dirname,
	"harness/vite.identities-page-proof.config.ts"
);

export default defineConfig({
	testDir: ".",
	testMatch: /identities-page-proof\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		...devices["Desktop Chrome"],
		baseURL: PROOF_URL,
		viewport: { width: 1440, height: 1000 },
		trace: "retain-on-failure",
	},
	webServer: {
		command: `bunx vite build --config ${HARNESS_CONFIG} && bunx vite preview --config ${HARNESS_CONFIG} --host 127.0.0.1 --port 5185 --strictPort`,
		url: `${PROOF_URL}identities-page-proof.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
