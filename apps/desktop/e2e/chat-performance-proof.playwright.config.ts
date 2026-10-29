import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PROOF_URL = "http://127.0.0.1:5205/";

export default defineConfig({
	testDir: ".",
	outputDir: path.resolve(
		import.meta.dirname,
		"../test-results/chat-performance"
	),
	testMatch:
		/\/(?:chat-scroll-story|chat-grouping-story|chat-search-story|chat-performance-proof)\.spec\.ts$/,
	fullyParallel: false,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: PROOF_URL,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: {
				...devices["Desktop Chrome"],
				viewport: { height: 900, width: 1440 },
			},
		},
	],
	webServer: {
		command: process.env.RYU_CHAT_PERF_STATIC
			? "bunx vite preview --config harness/vite.chat-performance-proof.config.ts --host 127.0.0.1 --port 5205"
			: "bunx vite --config harness/vite.chat-performance-proof.config.ts",
		url: `${PROOF_URL}chat-scroll-story.html`,
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
