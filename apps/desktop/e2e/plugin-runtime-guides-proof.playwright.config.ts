import path from "node:path";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "plugin-runtime-guides-proof.spec.ts",
	outputDir: path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/parallel/plugins-runtime/full/browser-results"
	),
	workers: 1,
	retries: 0,
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:4017",
		viewport: { width: 1280, height: 1000 },
		trace: "off",
	},
	webServer: {
		stdout: "pipe",
		stderr: "pipe",
		cwd: path.resolve(import.meta.dirname, "../../fumadocs"),
		command: "bunx next dev --webpack --port 4017",
		url: "http://127.0.0.1:4017/docs/plugins/writing-style",
		reuseExistingServer: false,
		timeout: 360_000,
	},
});
