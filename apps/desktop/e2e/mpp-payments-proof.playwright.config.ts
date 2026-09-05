import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5198/";
const mppUiDirectory = path.resolve(
	import.meta.dirname,
	"../../../apps-store/mpp/ui"
);

export default defineConfig({
	fullyParallel: false,
	outputDir: "test-results/mpp-payments-proof",
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	reporter: "list",
	retries: 0,
	testDir: ".",
	testMatch: /mpp-payments-proof\.spec\.ts$/,
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
	},
	webServer: {
		command: "bun run dev -- --host 127.0.0.1 --port 5198 --strictPort",
		cwd: mppUiDirectory,
		// Port 5198 is also used by the rich listing proof; reusing that server
		// makes this suite silently load the wrong app and report missing controls.
		reuseExistingServer: false,
		timeout: 120_000,
		url: PROOF_URL,
	},
});
