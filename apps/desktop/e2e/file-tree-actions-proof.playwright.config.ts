import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
const baseURL = `http://127.0.0.1:${Number(process.env.RYU_FILE_TREE_ACTIONS_PORT ?? 5781)}/`;
export default defineConfig({
	testDir: ".",
	testMatch: /file-tree-actions-proof\.spec\.ts$/,
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 60_000,
	outputDir: path.join(tmpdir(), "ryu-file-tree-actions-proof-results"),
	use: { ...devices["Desktop Chrome"], baseURL, actionTimeout: 12_000 },
	webServer: {
		command: "bun e2e/file-tree-actions-proof.host.ts",
		cwd: path.resolve(import.meta.dirname, ".."),
		url: `${baseURL}__ready`,
		reuseExistingServer: false,
		timeout: 240_000,
	},
});
