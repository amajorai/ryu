import path from "node:path";
import { defineConfig } from "@playwright/test";

const buildDirectory = path.resolve(
	import.meta.dirname,
	"../../../target/spaces-database-query-proof-build"
);
const buildDirectoryArgument = `'${buildDirectory.replaceAll("'", "'\\''")}'`;

export default defineConfig({
	testDir: ".",
	testMatch: /spaces-database-query-proof\.spec\.ts$/,
	workers: 1,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	outputDir: path.resolve(
		import.meta.dirname,
		"../../../target/spaces-database-query-proof-results"
	),
	reporter: "list",
	use: {
		baseURL: "http://127.0.0.1:5226",
		viewport: { width: 1440, height: 960 },
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
	webServer: {
		command: `bunx vite build --emptyOutDir --config e2e/harness/vite.spaces-database-query-proof.config.ts --outDir ${buildDirectoryArgument} && bunx vite preview --config e2e/harness/vite.spaces-database-query-proof.config.ts --outDir ${buildDirectoryArgument} --host 127.0.0.1 --strictPort --port 5226`,
		cwd: path.resolve(import.meta.dirname, ".."),
		url: "http://127.0.0.1:5226/spaces-database-query-proof.html",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
