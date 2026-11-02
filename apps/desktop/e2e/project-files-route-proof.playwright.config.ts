import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { proofBuildHeapEnv } from "./proof-build-heap.ts";

const reuseBuiltFixture =
	process.env.RYU_PROJECT_FILES_PROOF_REUSE_BUILD === "1";

export default defineConfig({
	testDir: ".",
	testMatch: /project-files-route-proof\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: path.join(tmpdir(), "ryu-project-files-route-proof-results"),
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5364",
		viewport: { width: 1180, height: 820 },
		trace: "off",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: `${reuseBuiltFixture ? "" : "bunx vite build --config harness/vite.project-files-route-proof.config.ts && "}bunx vite preview --config harness/vite.project-files-route-proof.config.ts --host 127.0.0.1 --strictPort --port 5364`,
		env: proofBuildHeapEnv(6144),
		url: "http://127.0.0.1:5364/project-files-route-proof.html",
		reuseExistingServer: false,
		timeout: 300_000,
	},
});
