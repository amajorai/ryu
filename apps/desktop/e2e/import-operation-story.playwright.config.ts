import { defineConfig, devices } from "@playwright/test";

const portValue = process.env.RYU_IMPORT_OPERATION_STORY_PORT ?? "5196";
const port = Number(portValue);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
	throw new Error(
		"RYU_IMPORT_OPERATION_STORY_PORT must be an integer from 1 to 65535"
	);
}

const PROOF_URL = `http://127.0.0.1:${port}/`;

export default defineConfig({
	testDir: ".",
	testMatch: /import-operation-story\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	// The fake node finishes one item per read and the dialog reads every
	// 1.5 s, so one import of twelve items takes about twenty seconds.
	timeout: 90_000,
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1200, height: 900 },
			},
		},
	],
	webServer: {
		command: `bunx vite build --config harness/vite.import-operation-story.config.ts && bunx vite preview --config harness/vite.import-operation-story.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
		url: `${PROOF_URL}import-operation-story.html`,
		reuseExistingServer: false,
		timeout: 300_000,
	},
});
