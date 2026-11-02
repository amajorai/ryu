import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig } from "@playwright/test";
import { proofBuildHeapEnv } from "./proof-build-heap.ts";

const previewDir = JSON.stringify(
	path.join(tmpdir(), "ryu-space-scope-menu-proof-preview-5517")
);

export default defineConfig({
	testDir: ".",
	testMatch: /space-scope-menu-proof\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	outputDir: path.join(tmpdir(), "ryu-space-scope-menu-proof-results"),
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5517",
		viewport: { width: 940, height: 760 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: `bunx vite build --emptyOutDir --config harness/vite.space-scope-menu-proof.config.ts --outDir ${previewDir} && bunx vite preview --config harness/vite.space-scope-menu-proof.config.ts --outDir ${previewDir} --host 127.0.0.1 --strictPort --port 5517`,
		env: proofBuildHeapEnv(6144),
		url: "http://127.0.0.1:5517/space-scope-menu-proof.html",
		reuseExistingServer: false,
		// The production build of the Space graph alone can take two minutes on
		// a loaded host; the preview only starts after it.
		timeout: 300_000,
	},
});
