import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { REPLY_MESSAGE_PROOF_DIST } from "./harness/reply-message-proof.global-setup.ts";

// The page is built (when missing) by the global setup, so the suite runs from a
// clean checkout without a separate build step.
const proofDist = REPLY_MESSAGE_PROOF_DIST;

export default defineConfig({
	testDir: ".",
	testMatch: /reply-message-proof\.spec\.ts/,
	fullyParallel: false,
	reporter: "list",
	globalSetup: "./harness/reply-message-proof.global-setup.ts",
	use: {
		baseURL: pathToFileURL(`${proofDist}${path.sep}`).href,
		trace: "on-first-retry",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
});
